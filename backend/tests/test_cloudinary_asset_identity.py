"""BE-FIX.4A: định danh asset Cloudinary bằng public_id (không bằng chuỗi URL) và chặn đăng ký trùng.

ĐÂY LÀ defense-in-depth, KHÔNG phải bằng chứng quyền sở hữu: unsigned upload không cho biết ai đã upload. Các test dưới đây
chỉ kiểm tra rằng MỘT public_id không thể thuộc hai imageId/hai chủ, kể cả khi URL được viết lại (biến đổi, version, đuôi file).
Dữ liệu giả, kho RAM hoặc Firestore giả; không gọi mạng.
"""
import threading

import pytest
from fakes import SERVER_TS, FakeFirestore
from fastapi import HTTPException
from helpers import IMAGE_ID, IMAGE_ID_2, bearer, full_payload, minimal_payload

from app.repositories.image_repository import FirestoreImageStore, MemoryImageStore, image_repo
from app.services.cloudinary_confirm import asset_key, parse_cloudinary_url
from app.services.image_service import image_service

CLOUD = "test-cloud"
BASE = f"https://res.cloudinary.com/{CLOUD}/image/upload"
URL = "/images/cloudinary/confirm"


def post(client, payload, uid="user_A"):
    return client.post(URL, headers=bearer(uid), json=payload)


def urls(thumb="AAthumb", medium="AAmedium", webp="AAfull", prefix=f"{BASE}/v1700000000"):
    return {"thumbnail": f"{prefix}/{thumb}.webp", "medium": f"{prefix}/{medium}.webp", "webp": f"{prefix}/{webp}.webp"}


def payload(image_id=IMAGE_ID, **overrides):
    p = minimal_payload(image_id)
    p.update(urls())
    p.update(overrides)
    return p


# ------------------------------------------------------------------ phân tích URL
@pytest.mark.parametrize(
    "url,public_id,ext",
    [
        (f"{BASE}/v1700000000/abc123.webp", "abc123", "webp"),
        (f"{BASE}/v1/abc123.webp", "abc123", "webp"),
        (f"{BASE}/w_200,f_webp/v1/abc123.webp", "abc123", "webp"),  # biến đổi
        (f"{BASE}/c_fill,w_200,h_200/f_webp/q_auto:good/v1/abc123.webp", "abc123", "webp"),  # nhiều đoạn biến đổi
        (f"{BASE}/f_webp/v1/abc/thumb.webp", "abc/thumb", "webp"),  # dạng ví dụ trong CONTRACT (có thư mục)
        (f"{BASE}/v1/a_b-C/d_e/Name-9.PNG", "a_b-C/d_e/Name-9", "png"),  # phân biệt hoa/thường, đuôi hoa => chuẩn hóa
        (f"{BASE}/v99/abc123.jpeg", "abc123", "jpeg"),
        (f"{BASE}/v1/abc123.jpg", "abc123", "jpg"),
    ],
)
def test_valid_urls_resolve_to_a_stable_public_id(url, public_id, ext):
    asset = parse_cloudinary_url(url, CLOUD)
    assert asset.public_id == public_id and asset.extension == ext


def test_same_asset_written_differently_has_the_same_identity():
    forms = [
        f"{BASE}/v1700000000/Shared9.webp",
        f"{BASE}/v1800000000/Shared9.webp",  # version khác
        f"{BASE}/w_200,f_webp/v1700000000/Shared9.webp",  # biến đổi
        f"{BASE}/c_fill,w_10/e_blur:5/v1/Shared9.png",  # biến đổi khác + đuôi khác
        f"{BASE}/v1/Shared9.JPG",  # đuôi hoa
    ]
    ids = {parse_cloudinary_url(u, CLOUD).public_id for u in forms}
    assert ids == {"Shared9"}
    assert len({asset_key(i) for i in ids}) == 1


def test_asset_key_is_stable_case_sensitive_and_firestore_safe():
    assert asset_key("a/b") == asset_key("a/b")
    assert asset_key("a/b") != asset_key("a/B")  # Cloudinary phân biệt hoa/thường: không gộp
    assert "/" not in asset_key("a/b/c") and len(asset_key("x")) == 64


AMBIGUOUS = {
    "không-version": f"{BASE}/abc123.webp",
    "biến-đổi-không-version": f"{BASE}/w_200,f_webp/abc123.webp",
    "thư-mục-không-version": f"{BASE}/abc/thumb.webp",
    "không-đuôi-file": f"{BASE}/v1/abc123",
    "đuôi-không-hỗ-trợ-gif": f"{BASE}/v1/abc123.gif",
    "đuôi-svg": f"{BASE}/v1/abc123.svg",
    "dấu-chấm-trong-public_id": f"{BASE}/v1/a.b.webp",
    "thư-mục-có-dấu-chấm": f"{BASE}/v1/a.b/c.webp",
    "thư-mục-giống-version": f"{BASE}/v1/v2/abc123.webp",
    "đoạn-trước-version-lạ": f"{BASE}/foo/v1/abc123.webp",
    "URL-ký-s--": f"{BASE}/s--AbCdEf12--/v1/abc123.webp",
    "V-viết-hoa": f"{BASE}/V1700000000/abc123.webp",
    "version-quá-dài": f"{BASE}/v{'1' * 13}/abc123.webp",
    "version-rỗng": f"{BASE}/v/abc123.webp",
    "biến-đổi-có-khoảng-trắng": f"{BASE}/w_200 f_webp/v1/abc123.webp",
    "biến-đổi-ký-tự-lạ": f"{BASE}/w_200;f_webp/v1/abc123.webp",
    "mã-hóa-%2e%2e": f"{BASE}/v1/%2e%2e/abc123.webp",
    "mã-hóa-%61": f"{BASE}/v1/%61bc123.webp",
    "mã-hóa-%2F": f"{BASE}/v1/abc%2Fthumb.webp",
    "dấu-gạch-ngược": f"{BASE}/v1/abc\\thumb.webp",
    "hai-gạch-chéo": f"{BASE}/v1//abc123.webp",
    "gạch-chéo-cuối": f"{BASE}/v1/abc123.webp/",
    "dấu-chấm-đơn-đoạn": f"{BASE}/v1/./abc123.webp",
    "dấu-chấm-đôi-đoạn": f"{BASE}/v1/../abc123.webp",
    "quá-nhiều-biến-đổi": f"{BASE}/" + "/".join(["w_1"] * 6) + "/v1/abc123.webp",
    "quá-sâu": f"{BASE}/v1/" + "/".join(["d"] * 7) + "/abc123.webp",
    "public_id-quá-dài": f"{BASE}/v1/" + "/".join(["a" * 60] * 5) + "/abc123.webp",
    "tên-rỗng": f"{BASE}/v1/.webp",
    "chỉ-version": f"{BASE}/v1",
    "chỉ-version-và-gạch": f"{BASE}/v1/",
}


@pytest.mark.parametrize("label", list(AMBIGUOUS))
def test_ambiguous_or_unsafe_urls_are_rejected_with_400(client, fresh_store, label):
    res = post(client, payload(thumbnail=AMBIGUOUS[label]))
    assert res.status_code == 400, label
    assert res.json() == {"detail": "Invalid cloudinary url"}
    assert fresh_store.get(IMAGE_ID) is None and fresh_store._assets == {}


# ------------------------------------------------------------------ chặn đăng ký trùng
def test_registration_creates_one_claim_per_distinct_asset(client, fresh_store):
    assert post(client, payload()).status_code == 200
    claims = fresh_store._assets
    assert len(claims) == 3
    assert {c["ownerId"] for c in claims.values()} == {"user_A"}
    assert {c["imageId"] for c in claims.values()} == {IMAGE_ID}
    assert {c["publicId"] for c in claims.values()} == {"AAthumb", "AAmedium", "AAfull"}
    assert set(claims) == {asset_key(p) for p in ("AAthumb", "AAmedium", "AAfull")}
    assert fresh_store.get(IMAGE_ID)["assetIds"] == {"thumbnail": "AAthumb", "medium": "AAmedium", "webp": "AAfull"}


SAME_ASSET_REWRITTEN = {
    "đúng-URL": lambda p: f"{BASE}/v1700000000/{p}.webp",
    "biến-đổi": lambda p: f"{BASE}/w_200,f_webp/v1700000000/{p}.webp",
    "nhiều-biến-đổi": lambda p: f"{BASE}/c_fill,w_200/f_webp/v1700000000/{p}.webp",
    "version-khác": lambda p: f"{BASE}/v1800000000/{p}.webp",
    "đuôi-khác": lambda p: f"{BASE}/v1700000000/{p}.png",
    "biến-đổi-và-version-và-đuôi-khác": lambda p: f"{BASE}/e_sharpen/v1/{p}.jpg",
}


@pytest.mark.parametrize("variant", ["thumbnail", "medium", "webp"])
@pytest.mark.parametrize("how", list(SAME_ASSET_REWRITTEN))
def test_user_b_cannot_register_an_asset_of_user_a_however_the_url_is_written(client, fresh_store, how, variant):
    assert post(client, payload()).status_code == 200
    a_ids = {"thumbnail": "AAthumb", "medium": "AAmedium", "webp": "AAfull"}
    # B dùng asset MỚI cho 2 biến thể và chỉ 1 biến thể là asset của A (viết lại theo nhiều cách)
    b = payload(IMAGE_ID_2, **urls(thumb="BBthumb", medium="BBmedium", webp="BBfull"))
    b[variant] = SAME_ASSET_REWRITTEN[how](a_ids[variant])

    res = post(client, b, uid="user_B")

    assert res.status_code == 403 and res.json() == {"detail": "Forbidden"}
    assert fresh_store.get(IMAGE_ID_2) is None  # không tạo bản ghi
    assert {c["publicId"] for c in fresh_store._assets.values()} == {"AAthumb", "AAmedium", "AAfull"}  # B không chiếm gì (nguyên tử)
    assert {c["ownerId"] for c in fresh_store._assets.values()} == {"user_A"}


def test_same_user_cannot_reuse_a_public_id_for_a_different_image(client, fresh_store):
    assert post(client, payload()).status_code == 200
    again = payload(IMAGE_ID_2, thumbnail=f"{BASE}/w_100/v5/AAthumb.png")  # cùng asset, viết khác
    res = post(client, again, uid="user_A")
    assert res.status_code == 400 and res.json() == {"detail": "Invalid cloudinary url"}
    assert fresh_store.get(IMAGE_ID_2) is None


def test_a_public_id_can_never_belong_to_two_owners(client, fresh_store):
    for uid, image_id, suffix in (("user_A", IMAGE_ID, "A"), ("user_B", IMAGE_ID_2, "B")):
        post(client, payload(image_id, **urls(thumb="Shared1", medium=f"med{suffix}", webp=f"full{suffix}")), uid=uid)
    owners = {}
    for claim in fresh_store._assets.values():
        owners.setdefault(claim["publicId"], set()).add(claim["ownerId"])
    assert all(len(o) == 1 for o in owners.values())
    assert owners["Shared1"] == {"user_A"}  # A đến trước giữ asset


def test_claims_never_change_owner_after_failed_attempts(client, fresh_store):
    assert post(client, payload()).status_code == 200
    before = {k: dict(v) for k, v in fresh_store._assets.items()}
    for how in SAME_ASSET_REWRITTEN.values():
        post(client, payload(IMAGE_ID_2, thumbnail=how("AAthumb")), uid="user_B")
    assert fresh_store._assets == before


# ------------------------------------------------------------------ *Id do client khai
def test_client_ids_that_are_only_a_suffix_of_the_real_public_id_are_rejected(client):
    p = payload(thumbnail=f"{BASE}/v1/abc/thumb.webp", thumbnailId="thumb")  # trước đây "kết thúc bằng" chấp nhận
    res = post(client, p)
    assert res.status_code == 400 and res.json() == {"detail": "Invalid cloudinary url"}


def test_client_ids_that_contradict_the_url_are_rejected_for_every_variant(client):
    for key in ("thumbnailId", "mediumId", "webpId"):
        p = full_payload()
        p[key] = "someOtherAsset"
        res = post(client, p)
        assert res.status_code == 400 and res.json() == {"detail": "Invalid cloudinary url"}, key


def test_contract_example_shape_is_accepted_and_ids_are_stored(client, fresh_store):
    p = payload(
        thumbnail=f"{BASE}/w_200,f_webp/v1/abc/thumb.webp",
        medium=f"{BASE}/w_800,f_webp/v1/abc/medium.webp",
        webp=f"{BASE}/f_webp/v1/abc/full.webp",
        thumbnailId="abc/thumb", mediumId="abc/medium", webpId="abc/full",
    )
    res = post(client, p)
    assert res.status_code == 200
    assert res.json()["variants"]["thumbnailId"] == "abc/thumb"
    doc = fresh_store.get(IMAGE_ID)
    assert doc["assetIds"] == {"thumbnail": "abc/thumb", "medium": "abc/medium", "webp": "abc/full"}
    assert doc["variants"]["thumbnail"] == p["thumbnail"]  # URL gốc được lưu nguyên


def test_asset_ids_are_derived_from_urls_even_when_the_client_sends_no_ids(client, fresh_store):
    assert post(client, payload()).status_code == 200
    doc = fresh_store.get(IMAGE_ID)
    assert doc["assetIds"]["thumbnail"] == "AAthumb"
    assert doc["publicIds"] == {}  # *Id do client gửi vẫn chỉ lưu khi có gửi
    assert "thumbnailId" not in post(client, payload()).json()["variants"]  # response CONTRACT không đổi


def test_three_variants_may_share_one_public_id_and_make_one_claim(client, fresh_store):
    same = payload(thumbnail=f"{BASE}/w_200,f_webp/v1/One1.webp", medium=f"{BASE}/w_800,f_webp/v1/One1.webp", webp=f"{BASE}/f_webp/v1/One1.webp")
    assert post(client, same).status_code == 200
    assert len(fresh_store._assets) == 1
    assert post(client, same).status_code == 200  # confirm lại vẫn idempotent
    assert len(fresh_store._assets) == 1


# ------------------------------------------------------------------ idempotent / không ghi đè
def test_retry_same_image_id_is_idempotent_and_keeps_stored_urls_and_claims(client, fresh_store):
    first = post(client, payload())
    stored = fresh_store.get(IMAGE_ID)
    claims = {k: dict(v) for k, v in fresh_store._assets.items()}

    other_form = payload(**{"thumbnail": f"{BASE}/w_9/v77/AAthumb.png", "medium": f"{BASE}/v88/AAmedium.jpg"})
    second = post(client, other_form)

    assert second.status_code == 200 and second.json() == first.json()
    assert fresh_store.get(IMAGE_ID) == stored  # URL đã lưu không đổi
    assert fresh_store._assets == claims  # không thêm/đổi đăng ký


def test_new_valid_asset_still_confirms(client, fresh_store):
    assert post(client, payload()).status_code == 200
    assert post(client, payload(IMAGE_ID_2, **urls(thumb="Zthumb", medium="Zmedium", webp="Zfull")), uid="user_B").status_code == 200
    assert len(fresh_store._assets) == 6


def test_pending_record_completion_registers_assets_atomically(client, fresh_store):
    created = client.post("/images/upload-url", headers=bearer("user_A"), json={"filename": "a.png", "contentType": "image/png", "sizeBytes": 10})
    image_id = created.json()["imageId"]
    res = post(client, payload(image_id))
    assert res.status_code == 200 and fresh_store.get(image_id)["status"] == "DONE"
    assert {c["imageId"] for c in fresh_store._assets.values()} == {image_id}

    # asset đã bị người khác chiếm => hoàn tất bị từ chối và bản ghi PENDING giữ nguyên
    created_b = client.post("/images/upload-url", headers=bearer("user_B"), json={"filename": "b.png", "contentType": "image/png", "sizeBytes": 10})
    b_id = created_b.json()["imageId"]
    blocked = post(client, payload(b_id, thumbnail=f"{BASE}/e_blur/v2/AAthumb.webp"), uid="user_B")
    assert blocked.status_code == 403
    assert fresh_store.get(b_id)["status"] == "PENDING"
    assert all(c["imageId"] == image_id for c in fresh_store._assets.values())


def test_owner_can_reconfirm_the_same_assets_after_a_reset_to_pending(client, fresh_store):
    assert post(client, payload()).status_code == 200
    fresh_store.update(IMAGE_ID, {"status": "PENDING"})  # mô phỏng retry đặt lại PENDING (endpoint chưa có)
    claims = {k: dict(v) for k, v in fresh_store._assets.items()}

    res = post(client, payload())

    assert res.status_code == 200 and fresh_store.get(IMAGE_ID)["status"] == "DONE"
    assert fresh_store._assets == claims  # asset vẫn của chính imageId này, không đăng ký trùng


def test_known_limitation_first_come_wins_it_is_not_proof_of_the_uploader(client, fresh_store):
    """GHI NHẬN GIỚI HẠN, không phải tính năng mong muốn: unsigned upload không cho biết ai đã upload.
    Ai đăng ký TRƯỚC thì giữ asset; chủ thật đến sau bị từ chối. Chỉ signed upload mới giải quyết được."""
    assert post(client, payload(IMAGE_ID_2), uid="user_B").status_code == 200  # B đăng ký trước asset mà A đã upload
    res = post(client, payload(IMAGE_ID), uid="user_A")
    assert res.status_code == 403


# ------------------------------------------------------------------ tính nguyên tử và đua đồng thời
def _race(make_store, rounds=25, workers=8):
    wins_per_round = []
    for round_no in range(rounds):
        store = make_store()
        image_repo.configure(store)
        barrier = threading.Barrier(workers)
        outcomes = []
        lock = threading.Lock()

        def worker(n):
            uid = f"user_{n}"
            image_id = f"{n:08d}-1111-4222-8333-{round_no:012d}"
            body = payload(image_id, **urls(thumb="Race1", medium=f"Own{n}m{round_no}", webp=f"Own{n}f{round_no}"))
            barrier.wait()
            try:
                image_service.confirmCloudinaryUpload(uid, body)
                result = ("ok", uid)
            except HTTPException as exc:
                result = (exc.status_code, uid)
            with lock:
                outcomes.append(result)

        threads = [threading.Thread(target=worker, args=(n,)) for n in range(workers)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        assert len(outcomes) == workers  # mọi luồng đều có kết quả (không luồng nào chết vì lỗi lạ)
        winners = [uid for status, uid in outcomes if status == "ok"]
        assert len(winners) == 1, outcomes  # đúng MỘT người thắng asset dùng chung
        assert all(status in (403, 400) for status, _ in outcomes if status != "ok"), outcomes
        wins_per_round.append(winners[0])
        yield store, winners[0]


def test_concurrent_confirms_of_one_asset_have_exactly_one_winner_in_memory_store():
    for store, winner in _race(MemoryImageStore):
        claims = store._assets
        shared = [c for c in claims.values() if c["publicId"] == "Race1"]
        assert len(shared) == 1 and shared[0]["ownerId"] == winner  # asset thuộc người thắng
        assert {d["ownerId"] for d in store._docs.values()} == {winner}  # người thua không để lại bản ghi hay asset phụ
        assert {c["ownerId"] for c in claims.values()} == {winner}


def test_concurrent_confirms_of_one_asset_have_exactly_one_winner_on_firestore_stub():
    def make():
        return FirestoreImageStore(lambda db=FakeFirestore(): db, server_timestamp=SERVER_TS)

    for store, winner in _race(make):
        db = store._client
        assert len(db.docs) == 1 and next(iter(db.docs.values()))["ownerId"] == winner
        assert {c["ownerId"] for c in db.assets.values()} == {winner}
        assert len([c for c in db.assets.values() if c["publicId"] == "Race1"]) == 1


def test_concurrent_confirms_of_the_same_image_id_by_the_same_owner_are_idempotent():
    store = MemoryImageStore()
    image_repo.configure(store)
    barrier = threading.Barrier(6)
    results = []

    def worker():
        barrier.wait()
        results.append(image_service.confirmCloudinaryUpload("user_A", payload()))

    threads = [threading.Thread(target=worker) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(results) == 6 and all(r == results[0] for r in results)
    assert len(store._docs) == 1 and len(store._assets) == 3


def test_store_batch_is_all_or_nothing_for_both_stores():
    claim = lambda pid, image_id, owner: {asset_key(pid): {"publicId": pid, "imageId": image_id, "ownerId": owner, "createdAt": None}}  # noqa: E731

    def doc(image_id, owner):
        return {"imageId": image_id, "ownerId": owner, "status": "DONE"}

    db = FakeFirestore()
    for store in (MemoryImageStore(), FirestoreImageStore(lambda: db, server_timestamp=SERVER_TS)):
        assert store.create_with_assets(doc("img-AAAAAAAA", "user_A"), claim("p1", "img-AAAAAAAA", "user_A")) is True
        # B có asset mới p2 và asset đã bị chiếm p1: KHÔNG được ghi gì (kể cả p2 và bản ghi ảnh)
        mixed = {**claim("p2", "img-BBBBBBBB", "user_B"), **claim("p1", "img-BBBBBBBB", "user_B")}
        assert store.create_with_assets(doc("img-BBBBBBBB", "user_B"), mixed) is False
        assert store.get("img-BBBBBBBB") is None
        assert set(store.get_asset_claims([asset_key("p1"), asset_key("p2")])) == {asset_key("p1")}
        assert store.get_asset_claims([asset_key("p1")])[asset_key("p1")]["ownerId"] == "user_A"
        # imageId đã tồn tại => không đăng ký asset mới nào
        assert store.create_with_assets(doc("img-AAAAAAAA", "user_X"), claim("p3", "img-AAAAAAAA", "user_X")) is False
        assert store.get_asset_claims([asset_key("p3")]) == {}
        assert store.get("img-AAAAAAAA")["ownerId"] == "user_A"
        # cập nhật nguyên tử: asset bị chiếm => bản ghi không đổi
        store.save(doc("img-CCCCCCCC", "user_C"))
        assert store.update_with_assets("img-CCCCCCCC", {"status": "X"}, claim("p1", "img-CCCCCCCC", "user_C")) is False
        assert store.get("img-CCCCCCCC")["status"] == "DONE"
        assert store.update_with_assets("khong-co-doc", {"status": "X"}, claim("p9", "khong-co-doc", "user_C")) is False
        assert store.get_asset_claims([asset_key("p9")]) == {}


def test_a_stale_pre_read_cannot_defeat_the_atomic_guard(client, fresh_store, monkeypatch):
    """Giả lập đua: bước đọc sổ đăng ký trả kết quả CŨ (rỗng) trong lúc A đã chiếm asset. Thao tác ghi nguyên tử
    phải thất bại và service phải đọc lại để trả 403 đúng, không ghi gì và không báo thành công giả."""
    assert post(client, payload()).status_code == 200
    real = image_repo.get_asset_claims
    state = {"calls": 0}

    def stale_once(keys):
        state["calls"] += 1
        return {} if state["calls"] == 1 else real(keys)

    monkeypatch.setattr(image_repo, "get_asset_claims", stale_once)
    res = post(client, payload(IMAGE_ID_2, thumbnail=f"{BASE}/w_1/v3/AAthumb.webp"), uid="user_B")

    assert res.status_code == 403 and res.json() == {"detail": "Forbidden"}
    assert fresh_store.get(IMAGE_ID_2) is None
    assert {c["ownerId"] for c in fresh_store._assets.values()} == {"user_A"}
    assert state["calls"] == 2  # lần 1 cũ, lần 2 đọc lại sau khi ghi nguyên tử thất bại


def test_atomic_failure_with_no_visible_cause_is_503_not_a_fake_success(client, fresh_store, monkeypatch):
    assert post(client, payload()).status_code == 200
    monkeypatch.setattr(image_repo, "get_asset_claims", lambda keys: {})  # đọc luôn "không thấy gì"
    res = post(client, payload(IMAGE_ID_2, thumbnail=f"{BASE}/v3/AAthumb.webp"), uid="user_B")
    assert res.status_code == 503 and res.json() == {"detail": "Storage unavailable"}
    assert fresh_store.get(IMAGE_ID_2) is None
