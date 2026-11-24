"""Test POST /images/cloudinary/authorize (H4B-2). Không Cloudinary thật, không mạng; secret/api key trong file là GIẢ.

Kho: RAM (MemoryImageStore) và FirestoreImageStore + client giả (tests/fakes.py, mở rộng thêm hai collection ngay trong file này).
KHÔNG thay thế việc thử với Firestore Emulator (nguyên tử/đồng thời thật) — xem báo cáo H4B-2.
"""
import socket
import threading
from datetime import datetime, timedelta, timezone

import pytest
from fakes import SERVER_TS, FakeFirestore, ServiceUnavailable
from fastapi import HTTPException
from helpers import IMAGE_ID, IMAGE_ID_2, bearer, full_payload

from app.config import Settings, settings
from app.repositories.image_repository import FirestoreImageStore, ImageRepository, MemoryImageStore, image_repo
from app.services.upload_authorization import SLOT_WINDOW_SECONDS, UploadAuthorizationService, upload_authorization_service

URL = "/images/cloudinary/authorize"
CONFIRM_URL = "/images/cloudinary/confirm"
SECRET = "test-secret-not-real-0123456789"
API_KEY = "123456789012345"
TS = 1763900000
T0 = datetime.fromtimestamp(TS, tz=timezone.utc)

VECTORS_SHA256 = {  # tính độc lập bằng hashlib (xem test_cloudinary_signing.py)
    "thumbnail": "3065bc68cc0ce51e4336155d22951c779823b592bdd5660c19353e02302b6b5c",
    "medium": "bc6a7ec24122af60992b81a3c6259576f9ccf95d2a81f21c6900d3855e23755d",
    "webp": "4ff307e868b9c248e4e51964d571b0d0e48ac4de8a4592529921ec9bfd855307",
}
UUIDS = [f"{i:08x}-1111-4111-8111-{i:012x}" for i in range(1, 80)]


def payload(image_id: str = IMAGE_ID, **over):
    body = {
        "imageId": image_id,
        "fileName": "anh-bien.jpg",
        "originalSize": 2457600,
        "width": 4000,
        "height": 3000,
        "variants": {
            "thumbnail": {"bytes": 8000, "width": 200, "height": 150},
            "medium": {"bytes": 90000, "width": 800, "height": 600},
            "webp": {"bytes": 412000, "width": 4000, "height": 3000},
        },
    }
    body.update(over)
    return body


class Clock:
    def __init__(self) -> None:
        self.now = T0

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now = self.now + timedelta(seconds=seconds)


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(upload_authorization_service, "_clock", c)
    return c


@pytest.fixture
def signed_on(monkeypatch, clock):
    """Bật tính năng với cấu hình GIẢ (test-cloud khớp conftest)."""
    for name, value in {
        "CLOUDINARY_SIGNED_UPLOAD_ENABLED": True,
        "CLOUDINARY_CONFIRM_MODE": "signed",  # H4B-3: authorize chỉ chạy khi confirm cũng ở chế độ signed (không có cấu hình authorize bật + confirm legacy)
        "CLOUDINARY_API_KEY": API_KEY,
        "CLOUDINARY_API_SECRET": SECRET,
        "CLOUDINARY_SIGNATURE_ALGORITHM": "sha256",
        "UPLOAD_ENVIRONMENT": "test",
        "UPLOAD_GRANT_TTL_SECONDS": 900,
        "UPLOAD_GRANTS_PER_HOUR": 20,
    }.items():
        monkeypatch.setattr(settings, name, value)
    return settings


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Mọi test trong file này: cấm tên miền/kết nối ra ngoài (Cloudinary thật sẽ làm test lỗi)."""
    calls: list[str] = []

    def boom(*a, **k):
        calls.append("network")
        raise AssertionError("test không được gọi mạng")

    monkeypatch.setattr(socket, "getaddrinfo", boom)
    monkeypatch.setattr(socket, "create_connection", boom)
    import urllib3.connectionpool as cp

    monkeypatch.setattr(cp.HTTPConnectionPool, "urlopen", boom)
    yield calls
    assert calls == []


def post(client, body, uid="user_A"):
    return client.post(URL, headers=bearer(uid), json=body)


def legacy_confirm(client, monkeypatch, uid="user_A", body=None):
    """Confirm theo chế độ LEGACY (cờ authorize tắt + mode legacy) trong một khoảng ngắn, rồi trả lại cấu hình signed của fixture `signed_on`."""
    with monkeypatch.context() as m:
        m.setattr(settings, "CLOUDINARY_SIGNED_UPLOAD_ENABLED", False)
        m.setattr(settings, "CLOUDINARY_CONFIRM_MODE", "legacy")
        return client.post(CONFIRM_URL, headers=bearer(uid), json=body if body is not None else full_payload())


# ------------------------------------------------------------------ cờ tính năng + cấu hình (fail closed)
def test_feature_flag_defaults_to_off():
    assert Settings.model_fields["CLOUDINARY_SIGNED_UPLOAD_ENABLED"].default is False
    assert settings.CLOUDINARY_SIGNED_UPLOAD_ENABLED is False  # test không bật => đúng mặc định của môi trường test


def test_disabled_returns_503_creates_no_grant_and_no_signature(client, fresh_store):
    res = post(client, payload())
    assert res.status_code == 503 and res.json() == {"detail": "Signed upload unavailable"}
    assert fresh_store._grants == {} and fresh_store._grant_slots == {}


@pytest.mark.parametrize(
    "name,value",
    [
        ("CLOUDINARY_API_KEY", ""),
        ("CLOUDINARY_API_SECRET", ""),
        ("CLOUDINARY_API_SECRET", "short"),
        ("CLOUDINARY_CLOUD_NAME", ""),
        ("UPLOAD_ENVIRONMENT", "Bad/Env"),
        ("CLOUDINARY_SIGNATURE_ALGORITHM", "md5"),
        ("UPLOAD_GRANT_TTL_SECONDS", 0),
        ("UPLOAD_GRANT_TTL_SECONDS", 7200),
        ("UPLOAD_GRANTS_PER_HOUR", 0),
        ("UPLOAD_GRANTS_PER_HOUR", 1000),
        ("UPLOAD_GRANTS_PER_HOUR", True),
    ],
)
def test_missing_or_bad_config_fails_closed_without_leaking(client, fresh_store, signed_on, monkeypatch, caplog, name, value):
    monkeypatch.setattr(settings, name, value)
    with caplog.at_level("DEBUG"):
        res = post(client, payload())
    assert res.status_code == 503 and res.json() == {"detail": "Signed upload unavailable"}
    text = res.text + caplog.text
    for secret in (SECRET, API_KEY, name):
        assert secret not in res.text
    assert SECRET not in text and API_KEY not in text
    assert fresh_store._grants == {} and fresh_store._grant_slots == {}


def test_flag_must_be_exactly_true(client, fresh_store, signed_on, monkeypatch):
    for value in ("true", 1, "yes", None):
        monkeypatch.setattr(settings, "CLOUDINARY_SIGNED_UPLOAD_ENABLED", value)
        assert post(client, payload()).status_code == 503
    assert fresh_store._grants == {}


# ------------------------------------------------------------------ xác thực: uid CHỈ từ token
def test_missing_or_bad_token_returns_401_even_when_disabled(client, fresh_store):
    assert client.post(URL, json=payload()).status_code == 401
    assert client.post(URL, headers={"Authorization": "Bearer nope"}, json=payload()).status_code == 401
    assert client.post(URL, headers={"Authorization": "Basic abc"}, json=payload()).status_code == 401
    assert fresh_store._grants == {}


def test_missing_token_returns_401_when_enabled(client, fresh_store, signed_on):
    assert client.post(URL, json=payload()).status_code == 401
    assert fresh_store._grants == {}


def test_owner_comes_from_token_never_from_body(client, fresh_store, signed_on):
    for field in ("uid", "ownerId", "userId"):
        res = post(client, {**payload(), field: "user_B"})
        assert res.status_code == 400 and res.json()["detail"] == "Unknown field"
    assert post(client, payload(), uid="user_A").status_code == 200
    assert fresh_store._grants[IMAGE_ID]["ownerId"] == "user_A"


# ------------------------------------------------------------------ kiểm tra payload
def _mut(path, value):
    body = payload()
    cur = body
    for key in path[:-1]:
        cur = cur[key]
    if value is DELETE:
        del cur[path[-1]]
    else:
        cur[path[-1]] = value
    return body


DELETE = object()
BAD_BODIES = {
    "not-object-list": [payload()],
    "not-object-str": "x",
    "imageId-missing": _mut(["imageId"], DELETE),
    "imageId-null": _mut(["imageId"], None),
    "imageId-not-uuid": _mut(["imageId"], "abc"),
    "imageId-uuid-v1": _mut(["imageId"], "b1f4c2e0-7a31-1c8e-9f12-3d5a6e7b8c90"),
    "imageId-upper": _mut(["imageId"], IMAGE_ID.upper()),
    "imageId-traversal": _mut(["imageId"], "../../etc/passwd"),
    "imageId-int": _mut(["imageId"], 5),
    "variants-missing": _mut(["variants"], DELETE),
    "variants-null": _mut(["variants"], None),
    "variants-list": _mut(["variants"], []),
    "variant-missing-webp": _mut(["variants", "webp"], DELETE),
    "variant-missing-thumbnail": _mut(["variants", "thumbnail"], DELETE),
    "variant-extra-original": _mut(["variants", "original"], {"bytes": 1, "width": 1, "height": 1}),
    "variant-extra-field": _mut(["variants", "medium", "url"], "https://evil.example/x.webp"),
    "variant-missing-field": _mut(["variants", "medium", "bytes"], DELETE),
    "variant-not-object": _mut(["variants", "medium"], 5),
    "variant-bytes-zero": _mut(["variants", "medium", "bytes"], 0),
    "variant-bytes-bool": _mut(["variants", "medium", "bytes"], True),
    "variant-bytes-float": _mut(["variants", "medium", "bytes"], 1.5),
    "variant-bytes-str": _mut(["variants", "medium", "bytes"], "100"),
    "variant-bytes-over-10mb": _mut(["variants", "webp", "bytes"], 10 * 1024 * 1024 + 1),
    "thumbnail-over-200": _mut(["variants", "thumbnail", "width"], 201),
    "thumbnail-height-over-200": _mut(["variants", "thumbnail", "height"], 201),
    "medium-over-800": _mut(["variants", "medium", "height"], 801),
    "variant-dim-zero": _mut(["variants", "webp", "width"], 0),
    "variant-dim-huge": _mut(["variants", "webp", "width"], 65536),
    "originalSize-missing": _mut(["originalSize"], DELETE),
    "originalSize-zero": _mut(["originalSize"], 0),
    "originalSize-negative": _mut(["originalSize"], -1),
    "originalSize-over-10mb": _mut(["originalSize"], 10 * 1024 * 1024 + 1),
    "originalSize-bool": _mut(["originalSize"], True),
    "originalSize-float": _mut(["originalSize"], 100.5),
    "originalSize-str": _mut(["originalSize"], "100"),
    "width-zero": _mut(["width"], 0),
    "height-str": _mut(["height"], "3000"),
    "fileName-int": _mut(["fileName"], 5),
    "fileName-empty": _mut(["fileName"], "   "),
    "fileName-too-long": _mut(["fileName"], "a" * 256),
    "fileName-slash": _mut(["fileName"], "a/b.jpg"),
    "fileName-backslash": _mut(["fileName"], "a\\b.jpg"),
    "fileName-nul": _mut(["fileName"], "a\x00b.jpg"),
    "fileName-newline": _mut(["fileName"], "a\nb.jpg"),
    "fileName-rtl-override": _mut(["fileName"], "photo‮gpj.exe"),
    "extra-publicId": {**payload(), "publicId": "hybrid/x"},
    "extra-public_id": {**payload(), "public_id": "evil"},
    "extra-folder": {**payload(), "folder": "../x"},
    "extra-overwrite": {**payload(), "overwrite": True},
    "extra-timestamp": {**payload(), "timestamp": 1},
    "extra-signature": {**payload(), "signature": "abc"},
    "extra-upload-url": {**payload(), "uploadUrl": "https://evil.example"},
    "extra-callback": {**payload(), "notification_url": "https://evil.example"},
}


@pytest.mark.parametrize("name", sorted(BAD_BODIES))
def test_invalid_payload_returns_400_and_creates_nothing(client, fresh_store, signed_on, name):
    res = post(client, BAD_BODIES[name])
    assert res.status_code == 400, res.text
    assert fresh_store._grants == {} and fresh_store._grant_slots == {}
    assert "signature" not in res.text and SECRET not in res.text


def test_invalid_json_body_returns_400(client, fresh_store, signed_on):
    res = client.post(URL, headers={**bearer("user_A"), "Content-Type": "application/json"}, content=b"{not json")
    assert res.status_code == 400 and fresh_store._grants == {}


def test_optional_fields_may_be_omitted(client, fresh_store, signed_on):
    body = payload()
    for key in ("fileName", "width", "height"):
        del body[key]
    assert post(client, body).status_code == 200


def test_original_size_exactly_10mb_is_accepted(client, signed_on):
    assert post(client, payload(originalSize=10 * 1024 * 1024)).status_code == 200


def test_file_name_is_trimmed_and_unicode_allowed(client, fresh_store, signed_on):
    assert post(client, payload(fileName="  ảnh biển 1.jpg  ")).status_code == 200
    assert fresh_store._grants[IMAGE_ID]["declared"]["fileName"] == "ảnh biển 1.jpg"


# ------------------------------------------------------------------ cấp mới
def test_new_grant_response_shape_signatures_and_headers(client, fresh_store, signed_on):
    res = post(client, payload())
    assert res.status_code == 200
    assert res.headers["cache-control"] == "no-store"
    data = res.json()
    assert set(data) == {"imageId", "expiresAt", "uploadUrl", "apiKey", "uploads"}
    assert data["imageId"] == IMAGE_ID
    assert data["uploadUrl"] == "https://api.cloudinary.com/v1_1/test-cloud/image/upload"
    assert data["apiKey"] == API_KEY
    assert data["expiresAt"] == (T0 + timedelta(seconds=900)).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert set(data["uploads"]) == {"thumbnail", "medium", "webp"}
    for variant, path in (("thumbnail", "thumb"), ("medium", "medium"), ("webp", "full")):
        fields = data["uploads"][variant]["fields"]
        assert set(fields) == {"public_id", "timestamp", "overwrite", "allowed_formats", "context", "tags", "api_key", "signature"}
        assert fields["public_id"] == f"hybrid/test/{IMAGE_ID}/{path}"
        assert fields["timestamp"] == str(TS) and fields["overwrite"] == "false" and fields["allowed_formats"] == "webp"
        assert fields["api_key"] == API_KEY
        assert fields["signature"] == VECTORS_SHA256[variant]  # vector độc lập (hashlib)
    assert SECRET not in res.text


def test_public_ids_do_not_contain_uid_or_file_name(client, signed_on):
    data = post(client, payload(), uid="user_A").json()
    blob = str(data)
    assert "user_A" not in blob and "anh-bien" not in blob


def test_grant_document_schema(client, fresh_store, signed_on):
    post(client, payload())
    grant = fresh_store._grants[IMAGE_ID]
    assert set(grant) == {"imageId", "ownerId", "status", "schemaVersion", "environment", "publicIds", "declared", "issuedAt", "expiresAt"}
    assert grant["ownerId"] == "user_A" and grant["status"] == "ISSUED" and grant["schemaVersion"] == 1 and grant["environment"] == "test"
    assert grant["publicIds"] == {
        "thumbnail": f"hybrid/test/{IMAGE_ID}/thumb",
        "medium": f"hybrid/test/{IMAGE_ID}/medium",
        "webp": f"hybrid/test/{IMAGE_ID}/full",
    }
    assert grant["issuedAt"] == T0 and grant["expiresAt"] == T0 + timedelta(seconds=900)
    assert grant["declared"]["originalSize"] == 2457600 and grant["declared"]["variants"]["medium"] == {"bytes": 90000, "width": 800, "height": 600}
    blob = repr(grant)
    assert SECRET not in blob and "signature" not in blob and API_KEY not in blob
    assert len(fresh_store._grant_slots) == 1


def test_authorize_never_creates_an_image_record(client, fresh_store, signed_on):
    post(client, payload())
    assert fresh_store._docs == {} and fresh_store._assets == {}


def test_secrets_and_signatures_never_logged(client, signed_on, caplog):
    with caplog.at_level("DEBUG"):
        res = post(client, payload())
        post(client, payload(), uid="user_B")  # 403
        post(client, payload(variants={}))  # 400
    assert res.status_code == 200
    for sig in VECTORS_SHA256.values():
        assert sig not in caplog.text
    assert SECRET not in caplog.text and API_KEY not in caplog.text and "token-user_A" not in caplog.text


# ------------------------------------------------------------------ gọi lại (idempotent)
def test_same_owner_retry_returns_same_public_ids_fresh_signature_and_no_second_grant(client, fresh_store, signed_on, clock):
    first = post(client, payload()).json()
    grant_before = dict(fresh_store._grants[IMAGE_ID])
    clock.advance(30)
    second = post(client, payload())
    assert second.status_code == 200
    second = second.json()
    for variant in ("thumbnail", "medium", "webp"):
        assert second["uploads"][variant]["fields"]["public_id"] == first["uploads"][variant]["fields"]["public_id"]
        assert second["uploads"][variant]["fields"]["timestamp"] == str(TS + 30)  # timestamp mới
        assert second["uploads"][variant]["fields"]["signature"] != first["uploads"][variant]["fields"]["signature"]
    assert second["expiresAt"] == first["expiresAt"]  # hạn của grant KHÔNG gia hạn khi gọi lại
    assert fresh_store._grants[IMAGE_ID] == grant_before and len(fresh_store._grants) == 1
    assert len(fresh_store._grant_slots) == 1  # gọi lại không tốn slot


def test_retry_with_different_file_name_or_sizes_is_conflict_and_grant_unchanged(client, fresh_store, signed_on):
    post(client, payload())
    before = dict(fresh_store._grants[IMAGE_ID])
    for changed in (
        payload(fileName="khac.jpg"),
        payload(originalSize=1),
        payload(width=1),
        _mut(["variants", "medium", "bytes"], 1),
        _mut(["variants", "webp", "height"], 1),
    ):
        res = post(client, changed)
        assert res.status_code == 409 and res.json() == {"detail": "Upload parameters differ from the existing grant"}
    assert fresh_store._grants[IMAGE_ID] == before and len(fresh_store._grant_slots) == 1


# ------------------------------------------------------------------ khác chủ
def test_other_owner_gets_403_without_leaking_the_owner(client, fresh_store, signed_on):
    post(client, payload(), uid="user_A")
    res = post(client, payload(), uid="user_B")
    assert res.status_code == 403 and res.json() == {"detail": "Forbidden"}
    assert "user_A" not in res.text and "signature" not in res.text
    assert fresh_store._grants[IMAGE_ID]["ownerId"] == "user_A" and len(fresh_store._grant_slots) == 1


def test_other_owner_403_even_with_different_metadata(client, signed_on):
    post(client, payload(), uid="user_A")
    assert post(client, payload(originalSize=5), uid="user_B").status_code == 403  # không lộ "metadata khác" (409) cho người lạ


# ------------------------------------------------------------------ hết hạn
def test_expired_grant_returns_409_without_new_signature_and_new_image_id_works(client, fresh_store, signed_on, clock):
    post(client, payload())
    clock.advance(900)  # đúng hạn: hết hạn (>=)
    res = post(client, payload())
    assert res.status_code == 409 and res.json() == {"detail": "Upload grant expired"}
    assert "signature" not in res.text
    assert len(fresh_store._grants) == 1 and fresh_store._grants[IMAGE_ID]["issuedAt"] == T0  # không sửa/gia hạn
    assert post(client, payload(IMAGE_ID_2)).status_code == 200


def test_grant_is_valid_until_the_last_second(client, signed_on, clock):
    post(client, payload())
    clock.advance(899)
    assert post(client, payload()).status_code == 200


def test_expired_grant_of_other_owner_is_still_403(client, signed_on, clock):
    post(client, payload(), uid="user_A")
    clock.advance(10_000)
    assert post(client, payload(), uid="user_B").status_code == 403


def test_non_issued_status_is_not_reissued(client, fresh_store, signed_on):
    post(client, payload())
    fresh_store._grants[IMAGE_ID]["status"] = "CONFIRMED"  # H4B-3 sẽ đặt; H4B-2 không được cấp chữ ký lại
    res = post(client, payload())
    assert res.status_code == 409 and "signature" not in res.text


def test_grant_with_other_environment_is_not_signed(client, fresh_store, signed_on, monkeypatch):
    post(client, payload())
    monkeypatch.setattr(settings, "UPLOAD_ENVIRONMENT", "prod")
    res = post(client, payload())
    assert res.status_code == 409 and res.json() == {"detail": "Upload grant environment mismatch"}


# ------------------------------------------------------------------ imageId đã là ảnh
def test_image_id_already_in_images_creates_no_grant(client, fresh_store, signed_on, monkeypatch):
    assert legacy_confirm(client, monkeypatch).status_code == 200  # ảnh có sẵn (tạo từ thời legacy)
    own = post(client, payload(), uid="user_A")
    assert own.status_code == 409 and own.json() == {"detail": "Image already exists"}
    other = post(client, payload(), uid="user_B")
    assert other.status_code == 403 and other.json() == {"detail": "Forbidden"} and "user_A" not in other.text
    assert fresh_store._grants == {} and fresh_store._grant_slots == {}


def test_retry_after_image_got_confirmed_is_conflict_not_resigned(client, fresh_store, signed_on, monkeypatch):
    post(client, payload())
    assert legacy_confirm(client, monkeypatch).status_code == 200
    res = post(client, payload())
    assert res.status_code == 409 and "signature" not in res.text


# ------------------------------------------------------------------ giới hạn tốc độ (slot nguyên tử)
def test_rate_limit_blocks_new_grants_beyond_per_hour_and_sets_retry_after(client, fresh_store, signed_on, monkeypatch, clock):
    monkeypatch.setattr(settings, "UPLOAD_GRANTS_PER_HOUR", 3)
    for i in range(3):
        assert post(client, payload(UUIDS[i])).status_code == 200
    res = post(client, payload(UUIDS[3]))
    assert res.status_code == 429 and res.json() == {"detail": "Too many upload authorizations"}
    assert res.headers["retry-after"] == str((TS // SLOT_WINDOW_SECONDS + 1) * SLOT_WINDOW_SECONDS - TS)
    assert UUIDS[3] not in fresh_store._grants and len(fresh_store._grants) == 3 and len(fresh_store._grant_slots) == 3


def test_retries_do_not_consume_rate_limit(client, signed_on, monkeypatch):
    monkeypatch.setattr(settings, "UPLOAD_GRANTS_PER_HOUR", 2)
    for _ in range(10):
        assert post(client, payload(UUIDS[0])).status_code == 200
    assert post(client, payload(UUIDS[1])).status_code == 200
    assert post(client, payload(UUIDS[2])).status_code == 429


def test_rate_limit_is_per_user(client, signed_on, monkeypatch):
    monkeypatch.setattr(settings, "UPLOAD_GRANTS_PER_HOUR", 1)
    assert post(client, payload(UUIDS[0]), uid="user_A").status_code == 200
    assert post(client, payload(UUIDS[1]), uid="user_A").status_code == 429
    assert post(client, payload(UUIDS[2]), uid="user_B").status_code == 200


def test_rate_limit_window_resets_next_hour(client, signed_on, monkeypatch, clock):
    monkeypatch.setattr(settings, "UPLOAD_GRANTS_PER_HOUR", 1)
    assert post(client, payload(UUIDS[0])).status_code == 200
    assert post(client, payload(UUIDS[1])).status_code == 429
    clock.advance(SLOT_WINDOW_SECONDS)
    assert post(client, payload(UUIDS[1])).status_code == 200


def test_rejected_requests_do_not_consume_rate_limit(client, fresh_store, signed_on, monkeypatch):
    monkeypatch.setattr(settings, "UPLOAD_GRANTS_PER_HOUR", 1)
    assert post(client, payload(UUIDS[0]), uid="user_B").status_code == 200  # người khác giữ imageId này
    for _ in range(5):
        assert post(client, payload(UUIDS[1], originalSize=0)).status_code == 400  # payload sai
        assert post(client, payload(UUIDS[0]), uid="user_A").status_code == 403  # imageId của người khác
    assert fresh_store._grant_slots and all(s["ownerId"] == "user_B" for s in fresh_store._grant_slots.values())
    assert post(client, payload(UUIDS[5]), uid="user_A").status_code == 200  # user_A chưa tốn slot nào
    assert post(client, payload(UUIDS[6]), uid="user_A").status_code == 429


def test_slot_ids_do_not_contain_uid(client, fresh_store, signed_on):
    post(client, payload(), uid="user_A")
    assert all("user_A" not in slot_id for slot_id in fresh_store._grant_slots)


# ------------------------------------------------------------------ đồng thời (kho RAM; Emulator kiểm tra riêng)
def _run_threads(n, fn):
    barrier = threading.Barrier(n)
    results: list = [None] * n

    def work(i):
        barrier.wait()
        try:
            results[i] = ("ok", fn(i))
        except HTTPException as exc:
            results[i] = ("err", exc.status_code)

    threads = [threading.Thread(target=work, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    return results


def test_concurrent_same_owner_same_image_id_creates_one_grant(fresh_store, signed_on):
    svc = upload_authorization_service
    results = _run_threads(16, lambda i: svc.authorize("user_A", payload()))
    assert all(kind == "ok" for kind, _ in results), results
    assert len(fresh_store._grants) == 1 and len(fresh_store._grant_slots) == 1
    assert {r["uploads"]["webp"]["fields"]["public_id"] for _, r in results} == {f"hybrid/test/{IMAGE_ID}/full"}


def test_concurrent_two_owners_same_image_id_exactly_one_wins(fresh_store, signed_on):
    svc = upload_authorization_service
    results = _run_threads(16, lambda i: svc.authorize("user_A" if i % 2 == 0 else "user_B", payload()))
    winner = fresh_store._grants[IMAGE_ID]["ownerId"]
    for i, (kind, value) in enumerate(results):
        mine = "user_A" if i % 2 == 0 else "user_B"
        assert (kind == "ok") == (mine == winner), (i, kind, value)
        if kind == "err":
            assert value == 403
    assert len(fresh_store._grants) == 1 and len(fresh_store._grant_slots) == 1


def test_concurrent_distinct_images_respect_exact_limit(fresh_store, signed_on, monkeypatch):
    monkeypatch.setattr(settings, "UPLOAD_GRANTS_PER_HOUR", 5)
    svc = upload_authorization_service
    results = _run_threads(24, lambda i: svc.authorize("user_A", payload(UUIDS[i])))
    ok = [r for r in results if r[0] == "ok"]
    limited = [r for r in results if r == ("err", 429)]
    assert len(ok) == 5 and len(limited) == 19, results
    assert len(fresh_store._grants) == 5 and len(fresh_store._grant_slots) == 5


# ------------------------------------------------------------------ Firestore giả (đường code Firestore)
class GrantFakeFirestore(FakeFirestore):
    def __init__(self) -> None:
        super().__init__()
        self.collections["uploadGrants"] = {}
        self.collections["uploadGrantSlots"] = {}

    @property
    def grants(self):
        return self.collections["uploadGrants"]

    @property
    def slots(self):
        return self.collections["uploadGrantSlots"]


@pytest.fixture
def fake_db(fresh_store):
    db = GrantFakeFirestore()
    image_repo.configure(FirestoreImageStore(lambda: db, server_timestamp=SERVER_TS))
    return db


def test_firestore_path_new_retry_cross_owner_conflict(client, fake_db, signed_on, clock):
    first = post(client, payload())
    assert first.status_code == 200
    assert set(fake_db.grants) == {IMAGE_ID} and len(fake_db.slots) == 1
    assert fake_db.batch_commits == 1  # grant + slot cùng MỘT batch
    clock.advance(5)
    assert post(client, payload()).status_code == 200
    assert fake_db.batch_commits == 1 and len(fake_db.slots) == 1
    assert post(client, payload(), uid="user_B").status_code == 403
    assert post(client, payload(originalSize=9)).status_code == 409
    grant = fake_db.grants[IMAGE_ID]
    assert grant["ownerId"] == "user_A" and grant["issuedAt"] == T0
    assert "images" in fake_db.collections and fake_db.docs == {}


def test_firestore_path_slot_ids_and_rate_limit(client, fake_db, signed_on, monkeypatch):
    monkeypatch.setattr(settings, "UPLOAD_GRANTS_PER_HOUR", 2)
    assert post(client, payload(UUIDS[0])).status_code == 200
    assert post(client, payload(UUIDS[1])).status_code == 200
    assert post(client, payload(UUIDS[2])).status_code == 429
    assert len(fake_db.grants) == 2 and len(fake_db.slots) == 2
    bucket = TS // SLOT_WINDOW_SECONDS
    assert all(slot_id.split("_")[1] == str(bucket) and "user_A" not in slot_id for slot_id in fake_db.slots)


def test_firestore_create_outcomes_exists_vs_slot_taken(fake_db):
    store = FirestoreImageStore(lambda: fake_db, server_timestamp=SERVER_TS)
    g1 = {"imageId": IMAGE_ID, "ownerId": "user_A"}
    g2 = {"imageId": IMAGE_ID_2, "ownerId": "user_A"}
    assert store.create_upload_grant(g1, "slot_1", {"n": 1}) == "created"
    assert store.create_upload_grant(g1, "slot_2", {"n": 2}) == "exists"  # imageId đã có grant, slot_2 KHÔNG bị chiếm
    assert "slot_2" not in fake_db.slots
    assert store.create_upload_grant(g2, "slot_1", {"n": 1}) == "slot_taken"  # slot đã bị chiếm, grant g2 KHÔNG được tạo
    assert IMAGE_ID_2 not in fake_db.grants


@pytest.mark.parametrize("op", ["get", "batch_commit"])
def test_firestore_unavailable_returns_503_without_leaking(client, fake_db, signed_on, caplog, op):
    fake_db.fail_with = ServiceUnavailable("connection to 10.0.0.1 failed s3cr3t-detail")
    with caplog.at_level("DEBUG"):
        res = post(client, payload())
    assert res.status_code == 503 and res.json() == {"detail": "Storage unavailable"}
    assert "s3cr3t-detail" not in res.text and "10.0.0.1" not in res.text and "signature" not in res.text
    assert SECRET not in caplog.text
    assert fake_db.grants == {} and fake_db.slots == {}


def test_firestore_commit_failure_after_reads_never_returns_signature(client, fake_db, signed_on):
    original = fake_db.batch

    class FailingBatch:
        def __init__(self, inner):
            self.inner = inner

        def create(self, ref, data):
            self.inner.create(ref, data)

        def commit(self, **kw):
            raise ServiceUnavailable("deadline")

    fake_db.batch = lambda: FailingBatch(original())
    res = post(client, payload())
    assert res.status_code == 503 and "signature" not in res.text
    assert fake_db.grants == {} and fake_db.slots == {}


# ------------------------------------------------------------------ confirm KHÔNG đổi (H4B-2 không đụng confirm)
def test_legacy_confirm_still_works_without_any_grant(client, fresh_store):
    res = client.post(CONFIRM_URL, headers=bearer("user_A"), json=full_payload())  # mặc định: mode legacy, cờ authorize tắt
    assert res.status_code == 200 and res.json()["status"] == "DONE"
    assert fresh_store._grants == {}


def test_legacy_confirm_does_not_read_or_modify_grants(client, fresh_store, signed_on, monkeypatch):
    post(client, payload())
    before = dict(fresh_store._grants[IMAGE_ID])
    assert legacy_confirm(client, monkeypatch).status_code == 200
    assert fresh_store._grants[IMAGE_ID] == before and before["status"] == "ISSUED"


def test_confirm_works_with_feature_flag_off_and_authorize_does_not_change_it(client, fresh_store):
    assert client.post(CONFIRM_URL, headers=bearer("user_A"), json=full_payload()).status_code == 200


def test_confirm_route_is_not_gated_by_the_new_flag():
    from app.routes import image_routes

    src = open(image_routes.__file__, encoding="utf-8").read()
    start = src.index("async def cloudinary_confirm")
    end = src.index("@router.post(\"/cloudinary/authorize\")")
    block = src[start:end]
    for forbidden in ("grant", "authorize", "SIGNED_UPLOAD"):
        assert forbidden not in block


def test_upload_url_endpoint_is_unchanged(client, fresh_store):
    res = client.post("/images/upload-url", headers=bearer("user_A"), json={"filename": "a.jpg", "contentType": "image/jpeg", "sizeBytes": 1000})
    assert res.status_code == 200


# ------------------------------------------------------------------ không gọi Cloudinary thật
def test_authorize_makes_no_network_calls(client, signed_on, no_network):
    assert post(client, payload()).status_code == 200
    assert post(client, payload()).status_code == 200
    assert no_network == []  # fixture no_network cũng làm test lỗi nếu có lời gọi


def test_service_uses_injected_repo_and_clock():
    store = MemoryImageStore()
    clock = Clock()
    svc = UploadAuthorizationService(repo=store, clock=clock)
    assert svc.repo is store and svc._clock is clock


# ------------------------------------------------------------------ kho: ngữ nghĩa create nguyên tử + thua cuộc đua đọc-rồi-tạo
@pytest.mark.parametrize("kind", ["memory", "firestore"])
def test_store_create_upload_grant_is_conditional_and_all_or_nothing(kind):
    if kind == "memory":
        store = MemoryImageStore()
        grants, slots = store._grants, store._grant_slots
    else:
        db = GrantFakeFirestore()
        store = FirestoreImageStore(lambda: db, server_timestamp=SERVER_TS)
        grants, slots = db.grants, db.slots
    g1 = {"imageId": IMAGE_ID, "ownerId": "user_A", "v": 1}
    assert store.create_upload_grant(g1, "s1", {"n": 1}) == "created"
    assert store.create_upload_grant({**g1, "ownerId": "user_B", "v": 2}, "s2", {"n": 2}) == "exists"
    assert grants[IMAGE_ID]["ownerId"] == "user_A" and grants[IMAGE_ID]["v"] == 1 and "s2" not in slots  # không ghi đè, không chiếm slot
    assert store.create_upload_grant({"imageId": IMAGE_ID_2, "ownerId": "user_A"}, "s1", {"n": 3}) == "slot_taken"
    assert IMAGE_ID_2 not in grants and slots["s1"] == {"n": 1}
    assert store.get_upload_grant(IMAGE_ID)["ownerId"] == "user_A" and store.get_upload_grant(IMAGE_ID_2) is None


class StaleGrantReadStore(MemoryImageStore):
    """Đọc grant lần đầu thấy 'chưa có' dù bên khác vừa tạo xong (mô phỏng thua cuộc đua giữa đọc và tạo)."""

    def __init__(self) -> None:
        super().__init__()
        self.stale_reads = 1

    def get_upload_grant(self, image_id):
        if self.stale_reads > 0:
            self.stale_reads -= 1
            return None
        return super().get_upload_grant(image_id)


@pytest.mark.parametrize("uid,expected", [("user_A", 200), ("user_B", 403)])
def test_losing_the_create_race_rereads_the_winner_grant(client, signed_on, uid, expected):
    store = StaleGrantReadStore()
    store.stale_reads = 0
    image_repo.configure(store)
    assert post(client, payload(), uid="user_A").status_code == 200  # bên thắng đã tạo
    store.stale_reads = 1
    res = post(client, payload(), uid=uid)
    assert res.status_code == expected
    assert len(store._grants) == 1 and len(store._grant_slots) == 1 and store._grants[IMAGE_ID]["ownerId"] == "user_A"
    assert "user_A" not in res.text or expected == 200


# ------------------------------------------------------------------ tranh chấp khóa Firestore (`Aborted`): commit chưa áp dụng => đọc lại + thử lại có giới hạn
class Aborted(Exception):
    """Tên lớp trùng google.api_core.exceptions.Aborted (nhận diện theo tên)."""


class ContendedStore(MemoryImageStore):
    def __init__(self, fail_times: int) -> None:
        super().__init__()
        self.fail_times = fail_times
        self.attempts = 0

    def create_upload_grant(self, grant, slot_id, slot):
        self.attempts += 1
        if self.fail_times > 0:
            self.fail_times -= 1
            return "contention"
        return super().create_upload_grant(grant, slot_id, slot)


def _svc(store, sleeps):
    repo = ImageRepository()
    repo.configure(store)
    return UploadAuthorizationService(repo=repo, clock=Clock(), sleep=sleeps.append)


def test_contention_is_retried_with_backoff_then_succeeds(signed_on):
    store, sleeps = ContendedStore(fail_times=3), []
    result = _svc(store, sleeps).authorize("user_A", payload())
    assert result["imageId"] == IMAGE_ID and store.attempts == 4
    assert len(sleeps) == 3 and all(0 <= s <= 0.4 for s in sleeps)
    assert len(store._grants) == 1 and len(store._grant_slots) == 1


def test_persistent_contention_fails_closed_with_503_and_no_signature(signed_on):
    store, sleeps = ContendedStore(fail_times=10_000), []
    with pytest.raises(HTTPException) as err:
        _svc(store, sleeps).authorize("user_A", payload())
    assert err.value.status_code == 503 and "signature" not in str(err.value.detail)
    assert store.attempts == 10 and len(sleeps) == 10  # có giới hạn, không lặp vô hạn
    assert store._grants == {}


def test_contention_then_other_owner_won_gives_403(signed_on):
    class WinnerAppears(ContendedStore):
        def create_upload_grant(self, grant, slot_id, slot):
            outcome = super().create_upload_grant(grant, slot_id, slot)
            if outcome == "contention":  # trong lúc tranh chấp, bên khác đã tạo xong
                self._grants[grant["imageId"]] = {**grant, "ownerId": "user_B"}
            return outcome

    store = WinnerAppears(fail_times=1)
    with pytest.raises(HTTPException) as err:
        _svc(store, []).authorize("user_A", payload())
    assert err.value.status_code == 403


def test_firestore_aborted_maps_to_contention_and_nothing_is_written(fake_db):
    store = FirestoreImageStore(lambda: fake_db, server_timestamp=SERVER_TS)
    original = fake_db.batch

    class AbortingBatch:
        def __init__(self, inner):
            self.inner = inner

        def create(self, ref, data):
            self.inner.create(ref, data)

        def commit(self, **kw):
            raise Aborted("too much contention on these documents")

    fake_db.batch = lambda: AbortingBatch(original())
    assert store.create_upload_grant({"imageId": IMAGE_ID, "ownerId": "user_A"}, "s1", {"n": 1}) == "contention"
    assert fake_db.grants == {} and fake_db.slots == {}
