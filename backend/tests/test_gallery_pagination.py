"""INT-2: phân trang GET /images đúng CONTRACT mục 5 (`limit`, `cursor`, `items`, `nextCursor`, `hasMore`).

Chạy trên HAI kho: RAM (`MemoryImageStore`) và `FirestoreImageStore` THẬT của Backend với client là `FakeFirestore`
(stub của nhóm, tests/fakes.py). Xác thực bằng verifier giả của conftest. KHÔNG gọi Firebase/Firestore/Cloudinary/Drive thật.

GIỚI HẠN: stub chỉ chứng minh cách Backend DÙNG API truy vấn (order_by, start_after, limit) và logic cursor; nó KHÔNG chứng minh
hành vi/index/độ trễ của Firestore thật.
"""
import base64
import json
from datetime import datetime, timedelta, timezone

import pytest
from fakes import SERVER_TS, FakeFirestore, ServiceUnavailable
from helpers import bearer, full_payload

from app.repositories.image_repository import FirestoreImageStore, MemoryImageStore, image_repo
from app.services.cloudinary_service import cloudinary_service
from app.services.google_drive import google_drive_service
from app.services.image_service import decode_cursor, encode_cursor

BASE = datetime(2026, 11, 1, 8, 0, 0, tzinfo=timezone.utc)


# ------------------------------------------------------------------ hạ tầng test
@pytest.fixture(params=["memory", "firestore"])
def store(request):
    """Cùng một bộ test chạy trên cả hai kho."""
    if request.param == "memory":
        kind = MemoryImageStore()
        kind.fake_db = None
    else:
        db = FakeFirestore()
        kind = FirestoreImageStore(client_factory=lambda: db, server_timestamp=SERVER_TS)
        kind.fake_db = db
    image_repo.configure(kind)
    return kind


@pytest.fixture
def fs():
    """Chỉ Firestore (stub): để kiểm tra truy vấn và lỗi 503."""
    db = FakeFirestore()
    kind = FirestoreImageStore(client_factory=lambda: db, server_timestamp=SERVER_TS)
    kind.fake_db = db
    image_repo.configure(kind)
    return kind


@pytest.fixture
def externals(monkeypatch):
    """Drive giả (không có file, đếm số lần được gọi) và Cloudinary giả (phải KHÔNG bao giờ bị gọi)."""
    state = {"drive_calls": 0, "cloud_calls": []}

    def list_all(uid, root_folder_id=None):
        state["drive_calls"] += 1
        return []

    monkeypatch.setattr(google_drive_service, "list_all_pipeline_images", list_all)
    monkeypatch.setattr(cloudinary_service, "list_images", lambda prefix="": state["cloud_calls"].append(prefix) or [])
    return state


def doc(owner, n, created=None, prefix="img"):
    """Bản ghi ảnh tối thiểu. `created` mặc định tăng dần theo n (n lớn hơn = mới hơn)."""
    return {
        "imageId": f"{prefix}-{owner}-{n:04d}",
        "ownerId": owner,
        "status": "DONE",
        "createdAt": BASE + timedelta(seconds=n) if created is None else created,
    }


def seed(store, docs):
    for d in docs:
        store.save(d)
    return [d["imageId"] for d in docs]


def get(client, uid, **params):
    return client.get("/images", headers=bearer(uid), params={k: v for k, v in params.items() if v is not None})


def ids(res):
    return [i["imageId"] for i in res.json()["items"]]


def walk(client, uid, limit=None, max_pages=60):
    """Đi hết các trang bằng nextCursor; trả về danh sách các trang (mỗi trang là list imageId)."""
    pages, cursor = [], None
    for _ in range(max_pages):
        res = get(client, uid, limit=limit, cursor=cursor)
        assert res.status_code == 200, res.text
        body = res.json()
        pages.append(ids(res))
        if not body["hasMore"]:
            assert body["nextCursor"] is None
            return pages
        assert isinstance(body["nextCursor"], str) and body["nextCursor"]
        cursor = body["nextCursor"]
    raise AssertionError("phân trang không kết thúc (cursor lặp?)")


def flatten(pages):
    return [i for page in pages for i in page]


def forge(payload: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")


def valid_payload(uid="user_A", image_id="img-user_A-0001"):
    cursor = encode_cursor(uid, {"imageId": image_id, "createdAt": BASE})
    return json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))


# ------------------------------------------------------------------ limit
def test_default_limit_is_20_and_response_shape(client, store, externals):
    expected = list(reversed(seed(store, [doc("user_A", n) for n in range(25)])))  # mới nhất trước
    res = get(client, "user_A")
    assert res.status_code == 200
    body = res.json()
    assert set(body) == {"items", "nextCursor", "hasMore"}
    assert ids(res) == expected[:20] and body["hasMore"] is True and isinstance(body["nextCursor"], str)
    res2 = get(client, "user_A", cursor=body["nextCursor"])
    assert ids(res2) == expected[20:] and res2.json()["hasMore"] is False and res2.json()["nextCursor"] is None


@pytest.mark.parametrize("limit", ["21", "50", "1000", "999999999999999999"])
def test_limit_above_20_is_clamped_to_20(client, store, externals, limit):
    seed(store, [doc("user_A", n) for n in range(30)])
    res = get(client, "user_A", limit=limit)
    assert res.status_code == 200 and len(res.json()["items"]) == 20 and res.json()["hasMore"] is True


@pytest.mark.parametrize("limit", ["5", "1"])
def test_limit_below_20_is_honoured(client, store, externals, limit):
    seed(store, [doc("user_A", n) for n in range(30)])
    assert len(get(client, "user_A", limit=limit).json()["items"]) == int(limit)


@pytest.mark.parametrize(
    "limit", ["0", "-1", "-20", "abc", "1.5", "1e3", " 5", "5 ", "", "+5", "0x10", "٣", "1" * 19, "NaN", "null"]
)
def test_invalid_limit_is_rejected_with_400(client, store, externals, limit):
    seed(store, [doc("user_A", 1)])
    res = client.get("/images", headers=bearer("user_A"), params={"limit": limit})
    assert res.status_code == 400
    assert res.json() == {"detail": "Invalid limit"}
    assert externals["drive_calls"] == 0  # bị chặn trước mọi thao tác khác


def test_first_page_needs_no_cursor_and_empty_cursor_means_first_page(client, store, externals):
    expected = list(reversed(seed(store, [doc("user_A", n) for n in range(5)])))
    assert ids(get(client, "user_A", limit="2")) == expected[:2]
    assert ids(client.get("/images?limit=2&cursor=", headers=bearer("user_A"))) == expected[:2]


# ------------------------------------------------------------------ đi qua các trang
@pytest.mark.parametrize("limit", ["1", "3", "7", "20", None])
def test_walking_all_pages_yields_every_image_once_newest_first(client, store, externals, limit):
    expected = list(reversed(seed(store, [doc("user_A", n) for n in range(25)])))
    pages = walk(client, "user_A", limit=limit)
    assert flatten(pages) == expected  # đủ, không lặp, đúng thứ tự
    assert len(pages) == -(-25 // int(limit or 20))


def test_last_page_has_more_false_and_null_cursor_at_exact_boundary(client, store, externals):
    seed(store, [doc("user_A", n) for n in range(20)])
    body = get(client, "user_A", limit="20").json()
    assert len(body["items"]) == 20 and body["hasMore"] is False and body["nextCursor"] is None  # đúng 20, không có trang rỗng thừa
    seed(store, [doc("user_A", 99)])
    body = get(client, "user_A", limit="20").json()
    assert body["hasMore"] is True
    last = get(client, "user_A", limit="20", cursor=body["nextCursor"]).json()
    assert len(last["items"]) == 1 and last["hasMore"] is False and last["nextCursor"] is None


def test_images_with_identical_created_at_are_neither_repeated_nor_skipped(client, store, externals):
    same = BASE
    seeded = seed(store, [doc("user_A", n, created=same) for n in range(13)])
    for limit in ("1", "2", "4", "5", "13"):
        pages = walk(client, "user_A", limit=limit)
        assert sorted(flatten(pages)) == sorted(seeded), f"limit={limit}"
        assert len(set(flatten(pages))) == 13
        assert flatten(pages) == sorted(seeded, reverse=True)  # khóa phụ imageId giảm dần => thứ tự cố định


def test_ties_that_span_a_page_boundary_with_other_timestamps(client, store, externals):
    docs = [doc("user_A", n, created=BASE + timedelta(seconds=n // 3)) for n in range(10)]  # nhóm 3 ảnh cùng thời điểm
    seeded = seed(store, docs)
    pages = walk(client, "user_A", limit="2")
    assert sorted(flatten(pages)) == sorted(seeded) and len(set(flatten(pages))) == 10
    created = {d["imageId"]: d["createdAt"] for d in docs}
    keys = [(created[i], i) for i in flatten(pages)]
    assert keys == sorted(keys, reverse=True)


def test_mixed_created_at_types_paginate_without_loss_or_repeat(client, store, externals):
    """createdAt là datetime (confirm) hoặc chuỗi ISO (Drive/upload-url cũ). Firestore xếp chuỗi SAU timestamp (giảm dần: chuỗi trước)."""
    docs = [doc("user_A", n) for n in range(6)] + [
        doc("user_A", 10 + n, created=f"2026-01-0{n + 1}T00:00:00Z", prefix="drive") for n in range(5)
    ]
    seeded = seed(store, docs)
    flat = flatten(walk(client, "user_A", limit="3"))
    assert sorted(flat) == sorted(seeded) and len(set(flat)) == 11
    kinds = ["s" if i.startswith("drive") else "d" for i in flat]
    assert kinds == ["s"] * 5 + ["d"] * 6  # nhóm chuỗi liền nhau, không xen kẽ


def test_cursor_survives_deletion_of_the_last_seen_image(client, store, externals):
    """Cursor mang khóa sắp xếp (không phải tham chiếu tài liệu) nên vẫn dùng được nếu ảnh cuối trang trước đã bị xóa."""
    seed(store, [doc("user_A", n) for n in range(6)])
    first = get(client, "user_A", limit="3").json()
    gone = first["items"][-1]["imageId"]
    if store.fake_db is None:
        store._docs.pop(gone)
    else:
        store.fake_db.docs.pop(gone)
    second = get(client, "user_A", limit="3", cursor=first["nextCursor"])
    assert second.status_code == 200
    assert ids(second) == ["img-user_A-0002", "img-user_A-0001", "img-user_A-0000"]


def test_empty_gallery_returns_empty_items(client, store, externals):
    res = get(client, "user_A")
    assert res.status_code == 200 and res.json() == {"items": [], "nextCursor": None, "hasMore": False}


def test_confirmed_images_are_listed_across_pages(client, store, externals):
    posted = []
    for n in range(3):
        payload = full_payload(image_id=f"c2a5d3f1-8b42-4d9f-a023-4e6b7f8c9d{n:02d}", suffix=str(n))
        assert client.post("/images/cloudinary/confirm", headers=bearer("user_A"), json=payload).status_code == 200
        posted.append(payload["imageId"])
    pages = walk(client, "user_A", limit="2")
    assert [len(p) for p in pages] == [2, 1] and sorted(flatten(pages)) == sorted(posted)
    first = get(client, "user_A", limit="2").json()["items"][0]
    assert first["status"] == "DONE" and set(first["variants"]) >= {"thumbnail", "medium", "webp"}


# ------------------------------------------------------------------ cách ly người dùng
def test_user_never_sees_another_users_images_on_any_page(client, store, externals):
    a = seed(store, [doc("user_A", n * 2) for n in range(12)])
    b = seed(store, [doc("user_B", n * 2 + 1) for n in range(9)])  # xen kẽ về thời gian
    for limit in ("1", "4", None):
        assert sorted(flatten(walk(client, "user_A", limit=limit))) == sorted(a)
        assert sorted(flatten(walk(client, "user_B", limit=limit))) == sorted(b)
    assert externals["cloud_calls"] == []


def test_cursor_of_user_a_is_rejected_for_user_b_and_leaks_nothing(client, store, externals):
    seed(store, [doc("user_A", n) for n in range(6)] + [doc("user_B", n + 100) for n in range(6)])
    cursor = get(client, "user_A", limit="2").json()["nextCursor"]
    before = len(store.fake_db.queries) if store.fake_db else 0
    res = get(client, "user_B", cursor=cursor)
    assert res.status_code == 400 and res.json() == {"detail": "Invalid cursor"}
    assert "img-user" not in res.text  # không có dữ liệu nào trong phản hồi
    if store.fake_db:
        assert len(store.fake_db.queries) == before  # bị từ chối TRƯỚC khi chạm kho


def test_forged_cursor_aimed_at_user_a_position_returns_only_user_bs_images(client, store, externals):
    """Kẻ tấn công tự dựng cursor hợp lệ về cú pháp (đúng nhãn của B) nhưng trỏ vào ảnh của A: chỉ dịch vị trí trong ảnh của B."""
    a = seed(store, [doc("user_A", n) for n in range(6)])
    b = seed(store, [doc("user_B", n) for n in range(6)])
    forged = encode_cursor("user_B", {"imageId": a[-1], "createdAt": BASE + timedelta(seconds=3)})
    res = get(client, "user_B", cursor=forged)
    assert res.status_code == 200
    assert set(ids(res)) <= set(b) and not (set(ids(res)) & set(a))


def test_query_parameters_cannot_override_the_owner(client, store, externals):
    seed(store, [doc("user_A", n) for n in range(3)])
    res = client.get("/images", headers=bearer("user_B"), params={"uid": "user_A", "ownerId": "user_A", "userId": "user_A"})
    assert res.status_code == 200 and res.json()["items"] == []
    res = client.get("/images", headers={"X-User-Id": "user_A", **bearer("user_B")})
    assert res.json()["items"] == []


def test_foreign_docs_returned_by_a_leaky_store_are_filtered(client, externals):
    class LeakyStore(MemoryImageStore):
        def list_page_by_owner(self, owner_id, limit, after=None):
            return sorted(self._docs.values(), key=lambda d: d["createdAt"], reverse=True)  # cố ý trả cả ảnh của người khác

    leaky = LeakyStore()
    image_repo.configure(leaky)
    seed(leaky, [doc("user_A", 1), doc("user_B", 2), doc("user_B", 3)])
    res = get(client, "user_B")
    assert ids(res) == ["img-user_B-0003", "img-user_B-0002"]


# ------------------------------------------------------------------ cursor hỏng / bị sửa
BAD_CURSORS = {
    "ký tự cấm": "!!!not-base64!!!",
    "toàn dấu cách/ký tự lạ": "a b",
    "base64 hợp lệ nhưng không phải JSON": base64.urlsafe_b64encode(b"hello world").decode().rstrip("="),
    "JSON không phải đối tượng": forge([1, 2, 3]).replace("=", ""),
    "thiếu khóa": forge({"v": 1}),
    "thừa khóa": forge({**valid_payload(), "x": 1}),
    "sai phiên bản": forge({**valid_payload(), "v": 2}),
    "phiên bản là bool": forge({**valid_payload(), "v": True}),
    "nhãn chủ sở hữu sai": forge({**valid_payload(), "o": "0" * 16}),
    "nhãn không phải chuỗi": forge({**valid_payload(), "o": 5}),
    "kiểu createdAt lạ": forge({**valid_payload(), "t": "x"}),
    "giá trị datetime không phải chuỗi": forge({**valid_payload(), "c": 123}),
    "datetime sai định dạng": forge({**valid_payload(), "c": "hôm qua"}),
    "datetime không có múi giờ": forge({**valid_payload(), "c": "2026-11-01T08:00:00"}),
    "kiểu n nhưng có giá trị": forge({**valid_payload(), "t": "n", "c": "x"}),
    "imageId có dấu /": forge({**valid_payload(), "i": "a/b"}),
    "imageId rỗng": forge({**valid_payload(), "i": ""}),
    "imageId không phải chuỗi": forge({**valid_payload(), "i": ["a"]}),
    "quá dài": "A" * 1025,
    "lồng sâu": base64.urlsafe_b64encode(b"[" * 370 + b"]" * 370).decode().rstrip("="),
}


@pytest.mark.parametrize("name", list(BAD_CURSORS))
def test_bad_or_tampered_cursor_is_rejected_safely(client, store, externals, name):
    seed(store, [doc("user_A", n) for n in range(5)])
    res = get(client, "user_A", cursor=BAD_CURSORS[name])
    assert res.status_code == 400, name
    assert res.json() == {"detail": "Invalid cursor"}
    assert "img-user" not in res.text
    assert externals["drive_calls"] == 0 and externals["cloud_calls"] == []  # bị chặn trước khi làm bất cứ việc gì
    if store.fake_db:
        assert store.fake_db.queries == []


def test_tampered_position_inside_own_data_never_exposes_other_users(client, store, externals):
    """Sửa createdAt trong cursor (vẫn đúng cú pháp/nhãn): chỉ đổi vị trí; kết quả vẫn thuộc về chính người gọi."""
    a = seed(store, [doc("user_A", n) for n in range(6)])
    b = seed(store, [doc("user_B", n) for n in range(6)])
    cursor = get(client, "user_A", limit="2").json()["nextCursor"]
    payload = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    payload["c"] = "2000-01-01T00:00:00.000000+00:00"
    res = get(client, "user_A", cursor=forge(payload))
    assert res.status_code == 200 and set(ids(res)) <= set(a) and not (set(ids(res)) & set(b))


# ------------------------------------------------------------------ xác thực
@pytest.mark.parametrize("params", [{}, {"limit": "5"}, {"limit": "abc"}, {"cursor": "xyz"}])
@pytest.mark.parametrize("headers", [{}, {"X-User-Id": "user_A"}, {"Authorization": "Bearer khong-hop-le"}, {"Authorization": "Basic abc"}])
def test_missing_or_wrong_credentials_return_401_before_anything_else(client, store, externals, params, headers):
    seed(store, [doc("user_A", 1)])
    res = client.get("/images", headers=headers, params=params)
    assert res.status_code == 401 and res.json() == {"detail": "Missing token"}
    assert externals["drive_calls"] == 0 and externals["cloud_calls"] == []


# ------------------------------------------------------------------ lỗi kho => 503, không bao giờ là danh sách rỗng
@pytest.mark.parametrize("failure", [ServiceUnavailable("firestore down: SECRET-DETAIL"), RuntimeError("boom: SECRET-DETAIL")])
def test_firestore_error_returns_503_not_an_empty_gallery(client, fs, externals, failure):
    seed(fs, [doc("user_A", n) for n in range(5)])
    cursor = get(client, "user_A", limit="2").json()["nextCursor"]
    fs.fake_db.fail_with = failure
    for params in ({}, {"limit": "2", "cursor": cursor}):
        res = get(client, "user_A", **params)
        assert res.status_code == 503, res.text
        assert res.json() == {"detail": "Storage unavailable"}
        assert "SECRET-DETAIL" not in res.text and "items" not in res.json()


def test_firestore_client_that_cannot_start_returns_503(client, externals):
    def broken():
        raise RuntimeError("không có credential")

    image_repo.configure(FirestoreImageStore(client_factory=broken, server_timestamp=SERVER_TS))
    res = get(client, "user_A")
    assert res.status_code == 503 and res.json() == {"detail": "Storage unavailable"}


# ------------------------------------------------------------------ không tải cả collection / không quét Cloudinary
def test_pagination_is_pushed_down_to_the_store_query(client, fs, externals):
    seed(fs, [doc("user_A", n) for n in range(100)] + [doc("user_B", n + 1000) for n in range(100)])
    db = fs.fake_db
    first = get(client, "user_A", limit="20")
    assert len(first.json()["items"]) == 20
    assert db.streamed == 21  # limit + 1 (để biết còn trang sau), KHÔNG phải 200 tài liệu của collection
    q = db.queries[-1]
    assert q["filters"] == (("ownerId", "user_A"),)
    assert q["orders"] == (("createdAt", "DESCENDING"), ("__name__", "DESCENDING"))
    assert q["limit"] == 21 and q["cursor"] is None

    second = get(client, "user_A", limit="20", cursor=first.json()["nextCursor"])
    q2 = db.queries[-1]
    assert db.streamed == 21 + 21 and q2["limit"] == 21
    assert q2["cursor"]["__name__"] == first.json()["items"][-1]["imageId"]  # cursor = khóa sắp xếp của ảnh cuối trang trước
    assert q2["filters"] == (("ownerId", "user_A"),)
    assert not (set(ids(first)) & set(ids(second)))


def test_cloudinary_is_never_scanned_and_drive_sync_runs_only_on_the_first_page(client, store, externals):
    seed(store, [doc("user_A", n) for n in range(9)])
    walk(client, "user_A", limit="2")  # 5 trang
    assert externals["cloud_calls"] == []
    assert externals["drive_calls"] == 1


# ------------------------------------------------------------------ cursor: đơn vị
def test_cursor_roundtrip_keeps_microsecond_precision_and_kind():
    moment = datetime(2026, 11, 23, 4, 5, 6, 123456, tzinfo=timezone(timedelta(hours=7)))
    created, image_id = decode_cursor(encode_cursor("u1", {"imageId": "abc-123", "createdAt": moment}), "u1")
    assert created == moment and created.utcoffset() == timedelta(0) and image_id == "abc-123"
    assert decode_cursor(encode_cursor("u1", {"imageId": "d_1", "createdAt": "2026-01-01T00:00:00Z"}), "u1") == ("2026-01-01T00:00:00Z", "d_1")
    assert decode_cursor(encode_cursor("u1", {"imageId": "d_1", "createdAt": None}), "u1") == (None, "d_1")


def test_cursor_is_url_safe_and_short():
    cursor = encode_cursor("some-long-firebase-uid-0123456789", {"imageId": "x" * 128, "createdAt": BASE})
    assert cursor.isascii() and "=" not in cursor and "+" not in cursor and "/" not in cursor and len(cursor) < 1024
