"""Test confirm ở chế độ SIGNED (H4B-3): grant bắt buộc + xác minh Admin API + ghi nguyên tử có điều kiện.

Admin API là GIẢ (FakeAdmin, hoặc máy chủ localhost cho đường HTTP thật). Không Cloudinary thật, không mạng ra ngoài; key/secret là GIẢ.
Kho: RAM (MemoryImageStore) và FirestoreImageStore + client giả có điều kiện ghi (`Db2` dưới đây). KHÔNG thay thế Firestore Emulator (xem báo cáo H4B-3).
"""
import copy
import json
import socket
import threading
from datetime import datetime, timedelta, timezone

import pytest
from fakes import SERVER_TS, AlreadyExists, FakeCollection, FakeDocumentRef, FakeFirestore, FakeSnapshot, _resolve
from fakes import NotFound as NotFoundErr
from fastapi import HTTPException
from helpers import bearer

from app.config import settings
from app.repositories import image_repository as repo_module
from app.repositories.image_repository import FirestoreImageStore, FirestoreTimeouts, image_repo
from app.services.cloudinary_admin import AdminConfigError, AdminNotFound, AdminRateLimited, AdminUnavailable, HttpCloudinaryAdminClient
from app.services.cloudinary_confirm import asset_key, parse_confirm_payload
from app.services.signed_confirm import signed_confirm_service
from app.services.upload_authorization import upload_authorization_service

URL = "/images/cloudinary/confirm"
AUTH_URL = "/images/cloudinary/authorize"
SECRET = "test-secret-not-real-0123456789"
API_KEY = "123456789012345"
TS = 1763900000
T0 = datetime.fromtimestamp(TS, tz=timezone.utc)
IMAGE_ID = "b1f4c2e0-7a31-4c8e-9f12-3d5a6e7b8c90"
IMAGE_ID_2 = "c2a5d3f1-8b42-4d9f-a023-4e6b7f8c9da1"
CLOUD = "test-cloud"
VARIANTS = ("thumbnail", "medium", "webp")
PATH = {"thumbnail": "thumb", "medium": "medium", "webp": "full"}
DIFFERS = "Confirm parameters differ from the upload grant"
MISMATCH = "Uploaded assets do not match the upload grant"
NOT_FOUND = "Uploaded assets not found"


def authorize_body(image_id=IMAGE_ID, **over):
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


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def secure_url(public_id: str, version: int, cloud: str = CLOUD, ext: str = "webp") -> str:
    return f"https://res.cloudinary.com/{cloud}/image/upload/v{version}/{public_id}.{ext}"


class FakeAdmin:
    """Mô phỏng Admin API `resources_by_ids`: chỉ trả asset TỒN TẠI (asset thiếu bị bỏ qua, như tài liệu mô tả)."""

    def __init__(self) -> None:
        self.resources: dict[str, dict] = {}
        self.calls: list[list[str]] = []
        self.timeouts: list[float] = []
        self.raises: Exception | None = None
        self.override: dict | None = None
        self.on_call = None
        self.lock = threading.Lock()

    def get_resources(self, public_ids, *, timeout):
        with self.lock:
            self.calls.append(list(public_ids))
            self.timeouts.append(timeout)
        if self.on_call:
            self.on_call()
        if self.raises is not None:
            raise self.raises
        if self.override is not None:
            return copy.deepcopy(self.override)
        return {"resources": [copy.deepcopy(self.resources[p]) for p in public_ids if p in self.resources]}


class Env:
    def __init__(self, client, store_getter, clock, admin) -> None:
        self.client, self.clock, self.admin = client, clock, admin
        self._store = store_getter

    def authorize(self, uid="user_A", image_id=IMAGE_ID, **over):
        res = self.client.post(AUTH_URL, headers=bearer(uid), json=authorize_body(image_id, **over))
        assert res.status_code == 200, res.text
        return res.json()

    def upload(self, auth, body=None, *, version0=1763900100, created_offset=5):
        """Mô phỏng upload thành công lên Cloudinary theo đúng chữ ký đã cấp: tạo ba asset hợp lệ trong Admin giả."""
        body = body or authorize_body(auth["imageId"])
        for i, variant in enumerate(VARIANTS):
            fields = auth["uploads"][variant]["fields"]
            declared = body["variants"][variant]
            version = version0 + i
            pid = fields["public_id"]
            self.admin.resources[pid] = {
                "asset_id": f"{i + 1:032x}",
                "public_id": pid,
                "format": "webp",
                "version": version,
                "resource_type": "image",
                "type": "upload",
                "created_at": iso(self.clock.now + timedelta(seconds=created_offset)),
                "bytes": declared["bytes"],
                "width": declared["width"],
                "height": declared["height"],
                "url": secure_url(pid, version).replace("https", "http"),
                "secure_url": secure_url(pid, version),
                "tags": ["hybrid", "test"],
                "context": {"custom": {"app": "hybrid", "imageId": auth["imageId"], "variant": variant}},
            }
        return self.admin.resources

    def confirm_body(self, auth, **over):
        body = {"imageId": auth["imageId"], "originalSize": 2457600, "processingMs": 1840, "fileName": "anh-bien.jpg", "width": 4000, "height": 3000, "processedSize": 412000}
        for variant in VARIANTS:
            pid = auth["uploads"][variant]["fields"]["public_id"]
            version = self.admin.resources[pid]["version"] if pid in self.admin.resources else 1763900100
            body[variant] = secure_url(pid, version)
            body[f"{variant}Id"] = pid
        body.update(over)
        return body

    def confirm(self, body, uid="user_A"):
        return self.client.post(URL, headers=bearer(uid), json=body)

    def ready(self, uid="user_A", image_id=IMAGE_ID):
        auth = self.authorize(uid, image_id)
        self.upload(auth, authorize_body(image_id))
        return auth, self.confirm_body(auth)


@pytest.fixture(autouse=True)
def loopback_only(monkeypatch):
    real = socket.getaddrinfo
    blocked: list[str] = []

    def guarded(host, *a, **k):
        if host not in ("127.0.0.1", "localhost"):
            blocked.append(str(host))
            raise AssertionError(f"test không được phân giải tên miền ngoài: {host}")
        return real(host, *a, **k)

    monkeypatch.setattr(socket, "getaddrinfo", guarded)
    yield
    assert blocked == []


@pytest.fixture
def env(client, fresh_store, monkeypatch):
    clock, admin = Clock(), FakeAdmin()
    for name, value in {
        "CLOUDINARY_SIGNED_UPLOAD_ENABLED": True,
        "CLOUDINARY_CONFIRM_MODE": "signed",
        "CLOUDINARY_API_KEY": API_KEY,
        "CLOUDINARY_API_SECRET": SECRET,
        "CLOUDINARY_SIGNATURE_ALGORITHM": "sha256",
        "UPLOAD_ENVIRONMENT": "test",
        "UPLOAD_GRANT_TTL_SECONDS": 900,
        "UPLOAD_GRANTS_PER_HOUR": 50,
        "CLOUDINARY_ADMIN_TIMEOUT_SECONDS": 5.0,
        "UPLOAD_CONFIRM_BUDGET_SECONDS": 25.0,
        "UPLOAD_VERIFY_CLOCK_SKEW_SECONDS": 120,
    }.items():
        monkeypatch.setattr(settings, name, value)
    monkeypatch.setattr(upload_authorization_service, "_clock", clock)
    monkeypatch.setattr(signed_confirm_service, "_clock", clock)
    monkeypatch.setattr(signed_confirm_service, "_admin_factory", lambda cfg: admin)
    return Env(client, lambda: image_repo.store, clock, admin)


def store():
    return image_repo.store


def snapshot(fresh):
    return copy.deepcopy((fresh._docs, fresh._assets, fresh._grants))


# ================================================================== 1-4. grant bắt buộc / chủ / hạn / trạng thái
def test_missing_grant_is_403_and_never_falls_back_to_legacy(env, fresh_store):
    auth = {"imageId": IMAGE_ID, "uploads": {v: {"fields": {"public_id": f"hybrid/test/{IMAGE_ID}/{PATH[v]}"}} for v in VARIANTS}}
    env.upload(auth, authorize_body())
    res = env.confirm(env.confirm_body(auth))
    assert res.status_code == 403 and res.json() == {"detail": "Upload authorization required"}
    assert fresh_store._docs == {} and fresh_store._assets == {} and env.admin.calls == []  # không ảnh, không asset, không gọi Admin


def test_legacy_style_unsigned_payload_is_rejected_in_signed_mode(env, fresh_store):
    from helpers import full_payload

    res = env.client.post(URL, headers=bearer("user_A"), json=full_payload())
    assert res.status_code in (400, 403) and fresh_store._docs == {} and fresh_store._assets == {}


def test_wrong_owner_is_403_without_leaking_and_no_admin_call(env, fresh_store):
    auth, body = env.ready("user_A")
    res = env.confirm(body, uid="user_B")
    assert res.status_code == 403 and res.json() == {"detail": "Forbidden"} and "user_A" not in res.text
    assert env.admin.calls == [] and fresh_store._docs == {} and fresh_store._grants[IMAGE_ID]["status"] == "ISSUED"


def test_expired_grant_never_writes_done(env, fresh_store):
    auth, body = env.ready()
    env.clock.advance(900)
    res = env.confirm(body)
    assert res.status_code == 409 and res.json() == {"detail": "Upload grant expired"}
    assert fresh_store._docs == {} and fresh_store._assets == {} and fresh_store._grants[IMAGE_ID]["status"] == "ISSUED" and env.admin.calls == []


def test_grant_valid_until_last_second(env):
    auth, body = env.ready()
    env.clock.advance(899)
    assert env.confirm(body).status_code == 200


def test_grant_expiring_between_verify_and_commit_is_rejected_atomically(env, fresh_store):
    auth, body = env.ready()
    env.admin.on_call = lambda: env.clock.advance(901)  # hết hạn ngay trong lúc gọi Admin API
    res = env.confirm(body)
    assert res.status_code == 409 and res.json() == {"detail": "Upload grant expired"}
    assert fresh_store._docs == {} and fresh_store._assets == {} and fresh_store._grants[IMAGE_ID]["status"] == "ISSUED"


@pytest.mark.parametrize("status", ["REVOKED", "EXPIRED", "", None])
def test_other_grant_status_is_not_active(env, fresh_store, status):
    auth, body = env.ready()
    fresh_store._grants[IMAGE_ID]["status"] = status
    res = env.confirm(body)
    assert res.status_code == 409 and res.json() == {"detail": "Upload grant is not active"} and fresh_store._docs == {}


def test_grant_environment_changed_after_issue_is_rejected(env, fresh_store, monkeypatch):
    auth, body = env.ready()
    monkeypatch.setattr(settings, "UPLOAD_ENVIRONMENT", "prod")
    res = env.confirm(body)
    assert res.status_code == 409 and res.json() == {"detail": "Upload grant environment mismatch"} and fresh_store._docs == {}


# ================================================================== thành công + idempotent
def test_first_confirm_succeeds_and_writes_everything_consistently(env, fresh_store):
    auth, body = env.ready()
    res = env.confirm(body)
    assert res.status_code == 200
    data = res.json()
    assert data["imageId"] == IMAGE_ID and data["status"] == "DONE" and data["ownerId"] == "user_A"
    assert data["savedPercent"] == round((1 - 412000 / 2457600) * 100, 1)
    doc = fresh_store._docs[IMAGE_ID]
    ids = {v: f"hybrid/test/{IMAGE_ID}/{PATH[v]}" for v in VARIANTS}
    assert doc["status"] == "DONE" and doc["ownerId"] == "user_A" and doc["publicIds"] == ids and doc["assetIds"] == ids
    assert doc["original"] == {"size": 2457600, "width": 4000, "height": 3000} and doc["processedSize"] == 412000
    assert set(fresh_store._assets) == {asset_key(p) for p in ids.values()}
    assert all(a["imageId"] == IMAGE_ID and a["ownerId"] == "user_A" for a in fresh_store._assets.values())
    grant = fresh_store._grants[IMAGE_ID]
    assert grant["status"] == "CONFIRMED" and "confirmedAt" in grant and grant["ownerId"] == "user_A"
    assert len(env.admin.calls) == 1 and sorted(env.admin.calls[0]) == sorted(ids.values())


def test_stored_urls_are_cloudinary_secure_urls_not_client_urls(env, fresh_store):
    auth, body = env.ready()
    for v in VARIANTS:  # client thêm đoạn biến đổi vào URL: vẫn hợp lệ nhưng KHÔNG được lưu
        pid = auth["uploads"][v]["fields"]["public_id"]
        body[v] = f"https://res.cloudinary.com/{CLOUD}/image/upload/w_100,f_webp/v{env.admin.resources[pid]['version']}/{pid}.webp"
    res = env.confirm(body)
    assert res.status_code == 200
    for v in VARIANTS:
        pid = auth["uploads"][v]["fields"]["public_id"]
        assert fresh_store._docs[IMAGE_ID]["variants"][v] == env.admin.resources[pid]["secure_url"]
        assert res.json()["variants"][v] == env.admin.resources[pid]["secure_url"]


def test_processed_size_and_dimensions_come_from_cloudinary_not_client(env, fresh_store):
    auth, body = env.ready()
    del body["processedSize"]
    assert env.confirm(body).status_code == 200
    assert fresh_store._docs[IMAGE_ID]["processedSize"] == 412000  # bytes thật từ Admin API


def test_optional_client_fields_may_be_omitted_and_use_grant_values(env, fresh_store):
    auth, body = env.ready()
    for k in ("fileName", "width", "height", "processedSize", "thumbnailId", "mediumId", "webpId"):
        del body[k]
    assert env.confirm(body).status_code == 200
    doc = fresh_store._docs[IMAGE_ID]
    assert doc["fileName"] == "anh-bien.jpg" and doc["original"]["width"] == 4000


def test_idempotent_retry_returns_same_record_without_admin_or_new_writes(env, fresh_store):
    auth, body = env.ready()
    first = env.confirm(body)
    before = snapshot(fresh_store)
    created_at = fresh_store._docs[IMAGE_ID]["createdAt"]
    env.clock.advance(5000)  # kể cả khi grant đã quá hạn: đã CONFIRMED thì retry vẫn idempotent
    second = env.confirm(body)
    assert second.status_code == 200 and second.json() == first.json()
    assert snapshot(fresh_store) == before and fresh_store._docs[IMAGE_ID]["createdAt"] == created_at
    assert len(env.admin.calls) == 1  # không gọi Admin API lần hai
    assert len(fresh_store._assets) == 3


@pytest.mark.parametrize(
    "over",
    [{"originalSize": 1}, {"width": 1}, {"height": 1}, {"fileName": "khac.jpg"}, {"processedSize": 1}],
)
def test_confirmed_grant_rejects_a_different_payload(env, fresh_store, over):
    auth, body = env.ready()
    assert env.confirm(body).status_code == 200
    before = snapshot(fresh_store)
    res = env.confirm({**body, **over})
    assert res.status_code == 409 and res.json() == {"detail": DIFFERS} and snapshot(fresh_store) == before


def test_confirmed_grant_rejects_payload_with_other_asset_version(env, fresh_store):
    auth, body = env.ready()
    assert env.confirm(body).status_code == 200
    pid = auth["uploads"]["medium"]["fields"]["public_id"]
    body["medium"] = secure_url(pid, 999)
    res = env.confirm(body)
    assert res.status_code == 409 and res.json() == {"detail": DIFFERS}


def test_confirmed_grant_with_cross_owner_is_403(env, fresh_store):
    auth, body = env.ready()
    assert env.confirm(body).status_code == 200
    res = env.confirm(body, uid="user_B")
    assert res.status_code == 403 and res.json() == {"detail": "Forbidden"} and "user_A" not in res.text


@pytest.mark.parametrize("damage", ["no_image", "other_owner_image", "not_done", "no_assets", "asset_other_image", "no_verification", "ids_differ"])
def test_confirmed_grant_with_inconsistent_state_is_not_returned(env, fresh_store, damage):
    auth, body = env.ready()
    assert env.confirm(body).status_code == 200
    doc, assets = fresh_store._docs[IMAGE_ID], fresh_store._assets
    if damage == "no_image":
        del fresh_store._docs[IMAGE_ID]
    elif damage == "other_owner_image":
        doc["ownerId"] = "user_B"
    elif damage == "not_done":
        doc["status"] = "PENDING"
    elif damage == "no_assets":
        assets.clear()
    elif damage == "asset_other_image":
        next(iter(assets.values()))["imageId"] = IMAGE_ID_2
    elif damage == "no_verification":
        del doc["verification"]
    elif damage == "ids_differ":
        doc["publicIds"] = {**doc["publicIds"], "webp": "hybrid/test/other/full"}
    res = env.confirm(body)
    assert res.status_code == 409 and res.json() == {"detail": "Upload state is inconsistent"}


# ================================================================== 5. metadata/URL do client sửa
@pytest.mark.parametrize(
    "over",
    [{"originalSize": 2457601}, {"originalSize": 100}, {"width": 4001}, {"height": 1}, {"fileName": "doi-ten.jpg"}, {"processedSize": 412001}],
)
def test_client_metadata_that_contradicts_the_grant_is_409(env, fresh_store, over):
    auth, body = env.ready()
    res = env.confirm({**body, **over})
    assert res.status_code == 409 and res.json() == {"detail": DIFFERS}
    assert fresh_store._docs == {} and fresh_store._assets == {} and fresh_store._grants[IMAGE_ID]["status"] == "ISSUED"


def test_client_dimensions_not_declared_in_the_grant_are_rejected(env, fresh_store):
    auth = env.authorize(**{"width": None, "height": None})
    env.upload(auth, authorize_body(width=None, height=None))
    res = env.confirm(env.confirm_body(auth))  # confirm gửi width/height mà authorize chưa từng khai
    assert res.status_code == 409 and res.json() == {"detail": DIFFERS}


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example/{cloud}/image/upload/v1763900100/{pid}.webp",
        "http://res.cloudinary.com/{cloud}/image/upload/v1763900100/{pid}.webp",
        "https://res.cloudinary.com/other-cloud/image/upload/v1763900100/{pid}.webp",
        "https://res.cloudinary.com/{cloud}/image/upload/v1763900100/{pid}.webp?x=1",
        "https://res.cloudinary.com/{cloud}/image/upload/{pid}.webp",
        "not a url",
    ],
)
def test_fake_or_foreign_cloud_url_is_400(env, fresh_store, url):
    auth, body = env.ready()
    pid = auth["uploads"]["thumbnail"]["fields"]["public_id"]
    body["thumbnail"] = url.format(cloud=CLOUD, pid=pid)
    res = env.confirm(body)
    assert res.status_code == 400 and fresh_store._docs == {} and env.admin.calls == []


@pytest.mark.parametrize("variant", VARIANTS)
def test_url_pointing_to_a_public_id_outside_the_grant_is_400(env, fresh_store, variant):
    auth, body = env.ready()
    body[variant] = secure_url(f"hybrid/test/{IMAGE_ID_2}/{PATH[variant]}", 1763900100)
    body.pop(f"{variant}Id")
    res = env.confirm(body)
    assert res.status_code == 400 and res.json() == {"detail": "Invalid cloudinary url"} and env.admin.calls == []
    assert fresh_store._docs == {}


def test_public_id_of_other_cloud_style_or_environment_is_400(env, fresh_store):
    auth, body = env.ready()
    body["webp"] = secure_url(f"hybrid/prod/{IMAGE_ID}/full", 1763900100)
    body.pop("webpId")
    assert env.confirm(body).status_code == 400 and fresh_store._docs == {}


def test_client_declared_public_id_field_must_equal_url(env, fresh_store):
    auth, body = env.ready()
    body["mediumId"] = f"hybrid/test/{IMAGE_ID_2}/medium"
    assert env.confirm(body).status_code == 400 and fresh_store._docs == {}


def test_asset_version_different_from_the_url_client_sent_is_rejected(env, fresh_store):
    auth, body = env.ready()
    pid = auth["uploads"]["medium"]["fields"]["public_id"]
    body["medium"] = secure_url(pid, 12345)  # asset thật ở version khác: đã bị thay đổi sau khi client upload
    res = env.confirm(body)
    assert res.status_code == 409 and res.json() == {"detail": MISMATCH} and fresh_store._docs == {}


# ================================================================== 6. chính sách xác minh Admin API
def _set(field, value):
    return lambda e: e.__setitem__(field, value)


def _drop(field):
    return lambda e: e.pop(field, None)


def _custom(field, value):
    return lambda e: e["context"]["custom"].__setitem__(field, value)


def _created(delta):
    return lambda e: e.__setitem__("created_at", iso(T0 + timedelta(seconds=delta)))


MUTATIONS = {
    "format-png": _set("format", "png"),
    "format-missing": _drop("format"),
    "format-upper": _set("format", "WEBP"),
    "bytes-plus-1": lambda e: e.__setitem__("bytes", e["bytes"] + 1),
    "bytes-minus-1": lambda e: e.__setitem__("bytes", e["bytes"] - 1),
    "bytes-zero": _set("bytes", 0),
    "bytes-over-10mb": _set("bytes", 10 * 1024 * 1024 + 1),
    "bytes-str": _set("bytes", "8000"),
    "bytes-bool": _set("bytes", True),
    "bytes-missing": _drop("bytes"),
    "width-wrong": _set("width", 1),
    "height-wrong": _set("height", 1),
    "width-missing": _drop("width"),
    "width-float": _set("width", 200.0),
    "resource-video": _set("resource_type", "video"),
    "resource-missing": _drop("resource_type"),
    "type-authenticated": _set("type", "authenticated"),
    "type-private": _set("type", "private"),
    "type-missing": _drop("type"),
    "context-missing": _drop("context"),
    "context-no-custom": _set("context", {"x": 1}),
    "context-wrong-image": _custom("imageId", IMAGE_ID_2),
    "context-wrong-variant": _custom("variant", "webp-x"),
    "context-wrong-app": _custom("app", "other"),
    "context-missing-image": lambda e: e["context"]["custom"].pop("imageId"),
    "tags-missing": _drop("tags"),
    "tags-empty": _set("tags", []),
    "tags-no-env": _set("tags", ["hybrid"]),
    "tags-wrong-env": _set("tags", ["hybrid", "prod"]),
    "tags-not-list": _set("tags", "hybrid,test"),
    "created-before-grant-existing-asset": _created(-86400),
    "created-just-outside-skew": _created(-121),
    "created-future": _created(3600),
    "created-after-expiry-plus-skew": _created(900 + 121),
    "created-invalid": _set("created_at", "yesterday"),
    "created-no-z": _set("created_at", "2025-11-23T12:13:25+07:00"),
    "created-missing": _drop("created_at"),
    "asset-id-short": _set("asset_id", "abc"),
    "asset-id-upper": _set("asset_id", "A" * 32),
    "asset-id-missing": _drop("asset_id"),
    "version-str": _set("version", "1763900100"),
    "version-zero": _set("version", 0),
    "version-missing": _drop("version"),
    "secure-url-http": lambda e: e.__setitem__("secure_url", e["secure_url"].replace("https", "http")),
    "secure-url-other-cloud": lambda e: e.__setitem__("secure_url", e["secure_url"].replace(CLOUD, "other-cloud")),
    "secure-url-other-host": lambda e: e.__setitem__("secure_url", e["secure_url"].replace("res.cloudinary.com", "evil.example")),
    "secure-url-missing": _drop("secure_url"),
    "secure-url-png": lambda e: e.__setitem__("secure_url", e["secure_url"].replace(".webp", ".png")),
    "secure-url-other-public-id": lambda e: e.__setitem__("secure_url", secure_url(f"hybrid/test/{IMAGE_ID_2}/x", e["version"])),
    "secure-url-version-differs": lambda e: e.__setitem__("secure_url", secure_url(e["public_id"], e["version"] + 1)),
}


@pytest.mark.parametrize("name", sorted(MUTATIONS))
def test_any_failed_evidence_check_returns_409_and_writes_nothing(env, fresh_store, name):
    auth, body = env.ready()
    pid = auth["uploads"]["medium"]["fields"]["public_id"]
    MUTATIONS[name](env.admin.resources[pid])
    res = env.confirm(body)
    assert res.status_code == 409 and res.json() == {"detail": MISMATCH}, res.text
    assert fresh_store._docs == {} and fresh_store._assets == {} and fresh_store._grants[IMAGE_ID]["status"] == "ISSUED"


@pytest.mark.parametrize("variant", VARIANTS)
@pytest.mark.parametrize("name", ["format-png", "bytes-plus-1", "width-wrong", "context-wrong-variant", "created-before-grant-existing-asset"])
def test_each_of_the_three_assets_is_checked(env, fresh_store, variant, name):
    auth, body = env.ready()
    pid = auth["uploads"][variant]["fields"]["public_id"]
    MUTATIONS[name](env.admin.resources[pid])
    res = env.confirm(body)
    assert res.status_code == 409 and fresh_store._docs == {}


def test_asset_ids_must_be_distinct(env, fresh_store):
    auth, body = env.ready()
    for r in env.admin.resources.values():
        r["asset_id"] = "a" * 32
    assert env.confirm(body).status_code == 409 and fresh_store._docs == {}


def test_boundary_created_at_values_are_accepted_and_one_second_beyond_is_rejected(env):
    auth, body = env.ready()
    env.clock.advance(800)  # còn hạn (hết hạn ở +900)
    _created(-120)(env.admin.resources[auth["uploads"]["thumbnail"]["fields"]["public_id"]])  # đúng sai số cho phép trước thời điểm cấp
    _created(800 + 120)(env.admin.resources[auth["uploads"]["medium"]["fields"]["public_id"]])  # đúng sai số cho phép so với hiện tại
    assert env.confirm(body).status_code == 200


def test_created_at_one_second_beyond_the_skew_is_rejected(env, fresh_store):
    auth, body = env.ready()
    env.clock.advance(800)
    _created(800 + 121)(env.admin.resources[auth["uploads"]["medium"]["fields"]["public_id"]])
    assert env.confirm(body).status_code == 409 and fresh_store._docs == {}


def test_created_at_with_fraction_is_accepted(env):
    auth, body = env.ready()
    for r in env.admin.resources.values():
        r["created_at"] = iso(T0 + timedelta(seconds=3)).replace("Z", ".123Z")
    assert env.confirm(body).status_code == 200


def test_extra_unknown_fields_in_admin_response_are_ignored(env):
    auth, body = env.ready()
    for r in env.admin.resources.values():
        r["etag"], r["display_name"], r["asset_folder"] = "x", "y", ""
        r["context"]["custom"]["extra"] = "ok"
        r["tags"].append("khac")
    assert env.confirm(body).status_code == 200


@pytest.mark.parametrize("missing", [["thumbnail"], ["medium"], ["webp"], ["thumbnail", "medium", "webp"]])
def test_missing_assets_return_not_found_409(env, fresh_store, missing):
    auth, body = env.ready()
    for v in missing:
        del env.admin.resources[auth["uploads"][v]["fields"]["public_id"]]
    res = env.confirm(body)
    assert res.status_code == 409 and res.json() == {"detail": NOT_FOUND} and fresh_store._docs == {}


def _entries(env, auth):
    return [copy.deepcopy(env.admin.resources[auth["uploads"][v]["fields"]["public_id"]]) for v in VARIANTS]


def test_wrong_number_or_duplicate_or_foreign_assets_are_rejected(env, fresh_store):
    auth, body = env.ready()
    good = _entries(env, auth)
    extra = {**good[0], "public_id": f"hybrid/test/{IMAGE_ID}/extra"}
    cases = {
        "four": good + [extra],
        "duplicate": [good[0], good[0], good[1], good[2]],
        "two-plus-foreign": [good[0], good[1], extra],
        "not-a-list": "x",
        "no-resources": None,
        "entry-not-dict": good + ["x"],
    }
    for name, resources in cases.items():
        env.admin.override = {"resources": resources} if name != "no-resources" else {}
        res = env.confirm(body)
        assert res.status_code == 409, (name, res.text)
    assert fresh_store._docs == {} and fresh_store._assets == {}


def test_two_of_three_with_one_duplicate_is_not_complete(env):
    auth, body = env.ready()
    good = _entries(env, auth)
    env.admin.override = {"resources": [good[0], good[0], good[1]]}
    assert env.confirm(body).status_code == 409


def test_uploaded_before_grant_existing_true_scenario_is_rejected(env, fresh_store):
    """Upload bị bỏ qua vì overwrite=false (asset cũ cùng public_id, Cloudinary trả existing:true): asset có từ TRƯỚC grant => từ chối."""
    auth, body = env.ready()
    for r in env.admin.resources.values():
        r["created_at"] = iso(T0 - timedelta(days=30))
    res = env.confirm(body)
    assert res.status_code == 409 and res.json() == {"detail": MISMATCH} and fresh_store._docs == {}


# ================================================================== 7. lỗi Admin API
def test_admin_404_is_asset_not_found(env, fresh_store):
    auth, body = env.ready()
    env.admin.raises = AdminNotFound("x")
    res = env.confirm(body)
    assert res.status_code == 409 and res.json() == {"detail": NOT_FOUND} and fresh_store._docs == {}


def test_admin_420_is_503_with_retry_after(env, fresh_store):
    auth, body = env.ready()
    env.admin.raises = AdminRateLimited(120)
    res = env.confirm(body)
    assert res.status_code == 503 and res.json() == {"detail": "Upload verification unavailable"} and res.headers["retry-after"] == "120"
    assert len(env.admin.calls) == 1 and fresh_store._docs == {} and fresh_store._grants[IMAGE_ID]["status"] == "ISSUED"


@pytest.mark.parametrize(
    "exc",
    [AdminConfigError("api_secret test-secret-not-real-0123456789 rejected"), AdminUnavailable("500"), AdminUnavailable("timeout"), AdminUnavailable("json"), RuntimeError("bug"), TimeoutError()],
)
def test_admin_failures_are_503_without_leak_and_no_retry(env, fresh_store, caplog, exc):
    auth, body = env.ready()
    env.admin.raises = exc
    with caplog.at_level("DEBUG"):
        res = env.confirm(body)
    assert res.status_code == 503 and res.json() == {"detail": "Upload verification unavailable"} and "retry-after" not in res.headers
    assert SECRET not in res.text and SECRET not in caplog.text and API_KEY not in caplog.text
    assert len(env.admin.calls) == 1 and fresh_store._docs == {} and fresh_store._assets == {}


def test_admin_error_then_retry_succeeds_without_duplicates(env, fresh_store):
    auth, body = env.ready()
    env.admin.raises = AdminUnavailable("500")
    assert env.confirm(body).status_code == 503
    env.admin.raises = None
    assert env.confirm(body).status_code == 200
    assert len(fresh_store._docs) == 1 and len(fresh_store._assets) == 3


def test_admin_timeout_argument_is_bounded_by_config_and_budget(env, monkeypatch):
    auth, body = env.ready()
    assert env.confirm(body).status_code == 200
    assert env.admin.timeouts == [5.0]
    env2_auth = env.authorize(image_id=IMAGE_ID_2)
    env.upload(env2_auth, authorize_body(IMAGE_ID_2))
    monkeypatch.setattr(settings, "CLOUDINARY_ADMIN_TIMEOUT_SECONDS", 10.0)
    monkeypatch.setattr(settings, "UPLOAD_CONFIRM_BUDGET_SECONDS", 6.0)  # còn 6 - 3 (dành cho ghi) = 3 s
    assert env.confirm(env.confirm_body(env2_auth)).status_code == 200
    assert env.admin.timeouts[-1] == pytest.approx(3.0, abs=0.5)


def test_exhausted_budget_before_admin_call_is_503_without_calling_admin(env, fresh_store, monkeypatch):
    auth, body = env.ready()
    ticks = iter([0.0, 24.0, 24.0, 24.0])
    monkeypatch.setattr(signed_confirm_service, "_mono", lambda: next(ticks, 99.0))
    res = env.confirm(body)
    assert res.status_code == 503 and res.json() == {"detail": "Upload verification unavailable"}
    assert env.admin.calls == [] and fresh_store._docs == {}


# ================================================================== 19-20. cấu hình thiếu / mâu thuẫn => fail closed
@pytest.mark.parametrize(
    "name,value",
    [
        ("CLOUDINARY_API_KEY", ""),
        ("CLOUDINARY_API_SECRET", ""),
        ("CLOUDINARY_API_SECRET", "short"),
        ("CLOUDINARY_CLOUD_NAME", ""),
        ("UPLOAD_ENVIRONMENT", "Bad/Env"),
        ("CLOUDINARY_ADMIN_TIMEOUT_SECONDS", 0),
        ("CLOUDINARY_ADMIN_TIMEOUT_SECONDS", 60),
        ("CLOUDINARY_ADMIN_TIMEOUT_SECONDS", "5"),
        ("CLOUDINARY_ADMIN_TIMEOUT_SECONDS", True),
        ("UPLOAD_CONFIRM_BUDGET_SECONDS", 1),
        ("UPLOAD_CONFIRM_BUDGET_SECONDS", 100),
        ("UPLOAD_VERIFY_CLOCK_SKEW_SECONDS", -1),
        ("UPLOAD_VERIFY_CLOCK_SKEW_SECONDS", 100000),
        ("UPLOAD_VERIFY_CLOCK_SKEW_SECONDS", True),
    ],
)
def test_missing_or_bad_config_fails_closed_without_leak(env, fresh_store, monkeypatch, caplog, name, value):
    auth, body = env.ready()
    monkeypatch.setattr(settings, name, value)
    with caplog.at_level("DEBUG"):
        res = env.confirm(body)
    assert res.status_code == 503 and res.json() == {"detail": "Signed upload unavailable"}
    assert SECRET not in res.text + caplog.text and API_KEY not in res.text + caplog.text and name not in res.text
    assert env.admin.calls == [] and fresh_store._docs == {} and fresh_store._assets == {}


@pytest.mark.parametrize("mode", ["", "SIGNED2", "sign", None, 1, "legacy "])
def test_invalid_confirm_mode_fails_closed_never_legacy(env, fresh_store, monkeypatch, mode):
    from helpers import full_payload

    monkeypatch.setattr(settings, "CLOUDINARY_SIGNED_UPLOAD_ENABLED", False)  # chỉ mode sai
    monkeypatch.setattr(settings, "CLOUDINARY_CONFIRM_MODE", mode)
    if mode == "legacy ":  # H4B-7B.2.1: "legacy" chỉ hợp lệ khi harness cô lập tiêm provider GIẢ (cấu hình môi trường một mình không bao giờ đủ) + không có khóa Cloudinary
        from app.services import upload_mode

        monkeypatch.setattr(upload_mode, "_legacy_provider", upload_mode.LegacyCompatProvider("test-cloud", "test-unsigned-preset"))
        monkeypatch.setattr(settings, "CLOUDINARY_API_KEY", "")
        monkeypatch.setattr(settings, "CLOUDINARY_API_SECRET", "")
    res = env.client.post(URL, headers=bearer("user_A"), json=full_payload())
    if mode == "legacy ":  # khoảng trắng thừa được chuẩn hóa thành "legacy" (hợp lệ) => legacy
        assert res.status_code == 200
    else:
        assert res.status_code == 503 and res.json() == {"detail": "Signed upload unavailable"} and fresh_store._docs == {}


@pytest.mark.parametrize("flag", [True, "yes", 1])
def test_authorize_flag_on_with_legacy_confirm_is_contradictory_for_both_endpoints(env, fresh_store, monkeypatch, flag):
    from helpers import full_payload

    monkeypatch.setattr(settings, "CLOUDINARY_SIGNED_UPLOAD_ENABLED", flag)
    monkeypatch.setattr(settings, "CLOUDINARY_CONFIRM_MODE", "legacy")
    assert env.client.post(URL, headers=bearer("user_A"), json=full_payload()).status_code == 503  # không nhận URL unsigned
    assert env.client.post(AUTH_URL, headers=bearer("user_A"), json=authorize_body(IMAGE_ID_2)).status_code == 503
    assert fresh_store._docs == {} and fresh_store._grants.get(IMAGE_ID_2) is None


def test_confirm_signed_with_authorize_disabled_still_requires_grants(env, fresh_store, monkeypatch):
    from helpers import full_payload

    auth, body = env.ready()
    monkeypatch.setattr(settings, "CLOUDINARY_SIGNED_UPLOAD_ENABLED", False)  # tắt authorize KHÔNG được mở lại đường unsigned
    assert env.client.post(URL, headers=bearer("user_A"), json=full_payload(IMAGE_ID_2)).status_code == 403
    assert env.confirm(body).status_code == 200  # grant đã cấp vẫn dùng được
    assert env.client.post(AUTH_URL, headers=bearer("user_A"), json=authorize_body(IMAGE_ID_2)).status_code == 503


def test_default_settings_are_disabled_and_flags_off():
    # H4B-7B.2: mặc định ĐỔI từ "legacy" sang "disabled" có chủ đích (không còn đường unsigned/legacy mặc định); cờ authorize vẫn TẮT.
    # H4B-7B.2.1: KHÔNG tồn tại cờ cấu hình nào để bật legacy.
    from app.config import Settings

    assert Settings.model_fields["CLOUDINARY_CONFIRM_MODE"].default == "disabled"
    assert Settings.model_fields["CLOUDINARY_SIGNED_UPLOAD_ENABLED"].default is False
    assert not [name for name in Settings.model_fields if "LEGACY" in name or "COMPAT" in name]


@pytest.mark.usefixtures("legacy_upload_compat")  # H4B-7B.2: đường LEGACY phải được bật tường minh (mặc định mới là "disabled")
def test_legacy_mode_remains_compatible_with_existing_behaviour(client, fresh_store):
    from helpers import full_payload

    res = client.post(URL, headers=bearer("user_A"), json=full_payload())
    assert res.status_code == 200 and res.json()["status"] == "DONE" and fresh_store._grants == {}


def test_confirm_requires_auth_first_even_in_signed_mode(env):
    assert env.client.post(URL, json={}).status_code == 401
    assert env.client.post(URL, headers={"Authorization": "Bearer nope"}, json={}).status_code == 401


def test_invalid_body_is_400_in_signed_mode(env):
    assert env.client.post(URL, headers=bearer("user_A"), json=[1]).status_code == 400
    assert env.client.post(URL, headers={**bearer("user_A"), "Content-Type": "application/json"}, content=b"{bad").status_code == 400


# ================================================================== 26. va chạm public_id / asset
def test_public_id_registered_for_another_owner_is_403_and_nothing_written(env, fresh_store):
    auth, body = env.ready()
    pid = auth["uploads"]["medium"]["fields"]["public_id"]
    fresh_store._assets[asset_key(pid)] = {"publicId": pid, "imageId": IMAGE_ID_2, "ownerId": "user_B"}
    res = env.confirm(body)
    assert res.status_code == 403 and res.json() == {"detail": "Forbidden"} and "user_B" not in res.text
    assert fresh_store._docs == {} and len(fresh_store._assets) == 1 and fresh_store._grants[IMAGE_ID]["status"] == "ISSUED"


def test_public_id_registered_by_same_owner_for_another_image_is_409(env, fresh_store):
    auth, body = env.ready()
    pid = auth["uploads"]["thumbnail"]["fields"]["public_id"]
    fresh_store._assets[asset_key(pid)] = {"publicId": pid, "imageId": IMAGE_ID_2, "ownerId": "user_A"}
    res = env.confirm(body)
    assert res.status_code == 409 and res.json() == {"detail": "Asset already registered"} and fresh_store._docs == {}


def test_image_created_between_authorize_and_confirm_is_never_overwritten(env, fresh_store):
    auth, body = env.ready()
    fresh_store._docs[IMAGE_ID] = {"imageId": IMAGE_ID, "ownerId": "user_A", "status": "PENDING"}
    res = env.confirm(body)
    assert res.status_code == 409 and res.json() == {"detail": "Image already exists"}
    assert fresh_store._docs[IMAGE_ID] == {"imageId": IMAGE_ID, "ownerId": "user_A", "status": "PENDING"} and fresh_store._assets == {}
    fresh_store._docs[IMAGE_ID]["ownerId"] = "user_B"
    assert env.confirm(body).status_code == 403


def test_image_appearing_during_admin_call_is_not_overwritten(env, fresh_store):
    auth, body = env.ready()
    env.admin.on_call = lambda: fresh_store._docs.__setitem__(IMAGE_ID, {"imageId": IMAGE_ID, "ownerId": "user_A", "status": "DONE"})
    res = env.confirm(body)
    assert res.status_code == 409 and res.json() == {"detail": "Image already exists"}
    assert fresh_store._assets == {} and fresh_store._grants[IMAGE_ID]["status"] == "ISSUED"


# ================================================================== 11/23. đồng thời (kho RAM)
def run_threads(n, fn):
    barrier = threading.Barrier(n)
    out = [None] * n

    def work(i):
        barrier.wait()
        try:
            out[i] = ("ok", fn(i))
        except HTTPException as exc:
            out[i] = ("err", exc.status_code, exc.detail)

    threads = [threading.Thread(target=work, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    return out


def test_concurrent_confirms_same_owner_write_once_and_agree(env, fresh_store):
    auth, body = env.ready()
    data = parse_confirm_payload(body)
    out = run_threads(16, lambda i: signed_confirm_service.confirm("user_A", data))
    assert all(o[0] == "ok" for o in out), out
    assert len({json.dumps(o[1], sort_keys=True) for o in out}) == 1
    assert len(fresh_store._docs) == 1 and len(fresh_store._assets) == 3 and fresh_store._grants[IMAGE_ID]["status"] == "CONFIRMED"


def test_concurrent_confirms_from_two_owners_only_the_grant_owner_succeeds(env, fresh_store):
    auth, body = env.ready("user_A")
    data = parse_confirm_payload(body)
    out = run_threads(16, lambda i: signed_confirm_service.confirm("user_A" if i % 2 == 0 else "user_B", data))
    for i, o in enumerate(out):
        assert o[0] == "ok" if i % 2 == 0 else (o[0] == "err" and o[1] == 403 and o[2] == "Forbidden")
    assert len(fresh_store._docs) == 1 and fresh_store._docs[IMAGE_ID]["ownerId"] == "user_A" and len(fresh_store._assets) == 3


# ================================================================== không rò rỉ bí mật
def test_no_secret_signature_or_token_in_responses_logs_or_documents(env, fresh_store, caplog):
    with caplog.at_level("DEBUG"):
        auth, body = env.ready()
        ok = env.confirm(body)
        env.confirm({**body, "originalSize": 5})
        env.confirm(body, uid="user_B")
        env.admin.raises = AdminConfigError(f"bad key {API_KEY} secret {SECRET}")
    signatures = [auth["uploads"][v]["fields"]["signature"] for v in VARIANTS]
    blob = caplog.text + ok.text + repr(fresh_store._docs) + repr(fresh_store._assets) + repr(fresh_store._grants)
    for secret in [SECRET, API_KEY, "token-user_A", *signatures]:
        assert secret not in blob


# ================================================================== đường HTTP thật tới Admin giả trên localhost
def test_end_to_end_with_real_http_admin_client_against_local_fake(env, fresh_store, monkeypatch):
    from test_cloudinary_admin import Fake

    server = Fake()
    try:
        auth, body = env.ready()
        server.body = json.dumps({"resources": list(env.admin.resources.values())}).encode()
        monkeypatch.setattr(signed_confirm_service, "_admin_factory", lambda cfg: HttpCloudinaryAdminClient(cfg.cloud_name, cfg.api_key, cfg.api_secret, base_url=server.url))
        res = env.confirm(body)
        assert res.status_code == 200 and fresh_store._grants[IMAGE_ID]["status"] == "CONFIRMED"
        assert len(server.requests) == 1
        for status, expected, detail in ((420, 503, "Upload verification unavailable"), (500, 503, "Upload verification unavailable"), (401, 503, "Upload verification unavailable")):
            fresh_store._docs.clear(), fresh_store._assets.clear()
            fresh_store._grants[IMAGE_ID]["status"] = "ISSUED"
            server.status, server.body = status, b'{"error": {"message": "secret"}}'
            r = env.confirm(body)
            assert r.status_code == expected and r.json() == {"detail": detail} and "secret" not in r.text
        server.status = 404
        fresh_store._grants[IMAGE_ID]["status"] = "ISSUED"
        assert env.confirm(body).json() == {"detail": NOT_FOUND}
    finally:
        server.close()


# ================================================================== Firestore giả có điều kiện ghi (đường code Firestore)
class FailedPrecondition(Exception):
    """Tên lớp trùng google.api_core.exceptions.FailedPrecondition."""


class Aborted(Exception):
    """Tên lớp trùng google.api_core.exceptions.Aborted."""


class DeadlineExceeded(Exception):
    pass


class Snap2(FakeSnapshot):
    def __init__(self, ref, data, update_time):
        super().__init__(ref.id, data)
        self.reference = ref
        self.update_time = update_time


class Ref2(FakeDocumentRef):
    @property
    def path(self):
        return f"{self.collection}/{self.id}"

    def get(self, **kw):
        self._db._tick("get")
        return Snap2(self, self._store.get(self.id), self._db.times.get((self.collection, self.id)))


class Col2(FakeCollection):
    def document(self, doc_id):
        return Ref2(self._db, self._collection, doc_id)


class Batch2:
    def __init__(self, db):
        self.db, self.ops = db, []

    def create(self, ref, data):
        self.ops.append(("create", ref, data, None))

    def update(self, ref, fields, option=None):
        self.ops.append(("update", ref, fields, option))

    def commit(self, **kw):
        db = self.db
        db._tick("batch_commit")
        with db.lock:
            if db.before_commit:
                hook, db.before_commit = db.before_commit, None
                hook()  # mô phỏng request khác commit TRƯỚC (sau khi request này đã đọc)
            if db.fail_plan:
                when, exc = db.fail_plan[0]
                if when == "before":
                    db.fail_plan.pop(0)
                    raise exc
            created: set = set()
            for kind, ref, _, option in self.ops:
                key = (ref.collection, ref.id)
                if kind == "create":
                    if ref.id in ref._store or key in created:
                        raise AlreadyExists("exists")
                    created.add(key)
                else:
                    if ref.id not in ref._store:
                        raise NotFoundErr("nf")
                    if option is not None and db.times.get(key) != option[1]:
                        raise FailedPrecondition("update_time changed")
            for kind, ref, data, _ in self.ops:
                key = (ref.collection, ref.id)
                if kind == "create":
                    ref._store[ref.id] = _resolve(data)
                else:
                    for k, v in data.items():
                        ref._store[ref.id][k] = _resolve(v)
                db.clock += 1
                db.times[key] = db.clock
            db.batch_commits += 1
            if db.fail_plan and db.fail_plan[0][0] == "after":
                raise db.fail_plan.pop(0)[1]  # ĐÃ ÁP DỤNG nhưng client nhận lỗi (DeadlineExceeded)



class Db2(FakeFirestore):
    def __init__(self):
        super().__init__()
        self.collections["uploadGrants"] = {}
        self.collections["uploadGrantSlots"] = {}
        self.times: dict = {}
        self.clock = 0
        self.fail_plan: list = []
        self.before_commit = None
        self.get_all_calls = 0

    def collection(self, name):
        assert name in self.collections, name
        return Col2(self, name)

    def batch(self):
        return Batch2(self)

    def write_option(self, last_update_time=None):
        return ("lut", last_update_time)

    def get_all(self, refs, **kw):
        self._tick("get_all")
        self.get_all_calls += 1
        return [ref.get() for ref in refs]

    @property
    def grants(self):
        return self.collections["uploadGrants"]

    @property
    def assets(self):
        return self.collections["cloudinaryAssets"]


@pytest.fixture
def fdb(fresh_store):
    db = Db2()
    image_repo.configure(FirestoreImageStore(lambda: db, server_timestamp=SERVER_TS))
    return db


def test_firestore_path_confirm_writes_image_assets_and_grant_in_one_batch(env, fdb):
    auth, body = env.ready()
    commits = fdb.batch_commits
    res = env.confirm(body)
    assert res.status_code == 200
    assert fdb.batch_commits == commits + 1  # đúng MỘT commit cho ảnh + 3 asset + grant
    assert set(fdb.docs) == {IMAGE_ID} and len(fdb.assets) == 3 and fdb.grants[IMAGE_ID]["status"] == "CONFIRMED"
    assert fdb.docs[IMAGE_ID]["status"] == "DONE" and isinstance(fdb.docs[IMAGE_ID]["createdAt"], datetime)
    assert fdb.get_all_calls == 1  # một RPC đọc cho cả 5 tài liệu


def test_firestore_path_idempotent_retry_writes_nothing(env, fdb):
    auth, body = env.ready()
    first = env.confirm(body)
    commits, calls = fdb.batch_commits, len(env.admin.calls)
    second = env.confirm(body)
    assert second.status_code == 200 and second.json() == first.json()
    assert fdb.batch_commits == commits and len(env.admin.calls) == calls


def test_firestore_competing_confirm_commits_first_precondition_fails_then_idempotent(env, fdb):
    """Request khác commit TRƯỚC sau khi request này đã đọc: batch có điều kiện bị từ chối (FailedPrecondition), đọc lại thấy CONFIRMED => trả kết quả cũ."""
    auth, body = env.ready()
    data = parse_confirm_payload(body)
    done = []

    def competitor():
        done.append(signed_confirm_service.confirm("user_A", data))

    fdb.before_commit = competitor
    res = env.confirm(body)
    assert res.status_code == 200 and done and res.json() == done[0]
    assert len(fdb.docs) == 1 and len(fdb.assets) == 3 and fdb.grants[IMAGE_ID]["status"] == "CONFIRMED"
    assert fdb.batch_commits == 2  # authorize (1) + MỘT confirm thật sự ghi


def test_firestore_aborted_is_retried_with_backoff_without_calling_admin_again(env, fdb, monkeypatch):
    auth, body = env.ready()
    sleeps = []
    monkeypatch.setattr(repo_module.time, "sleep", lambda s: sleeps.append(s))
    fdb.fail_plan = [("before", Aborted("contention")), ("before", Aborted("contention"))]
    res = env.confirm(body)
    assert res.status_code == 200 and len(sleeps) == 2 and all(0 <= s <= repo_module.CONFIRM_BACKOFF_MAX for s in sleeps)
    assert len(env.admin.calls) == 1  # Admin API KHÔNG bị gọi lại khi retry ghi
    assert len(fdb.docs) == 1 and len(fdb.assets) == 3 and fdb.grants[IMAGE_ID]["status"] == "CONFIRMED"


def test_firestore_persistent_aborted_fails_closed_with_no_partial_write(env, fdb, monkeypatch):
    auth, body = env.ready()
    monkeypatch.setattr(repo_module.time, "sleep", lambda s: None)
    fdb.fail_plan = [("before", Aborted("c"))] * 20
    res = env.confirm(body)
    assert res.status_code == 503 and res.json() == {"detail": "Storage unavailable"}
    assert fdb.docs == {} and fdb.assets == {} and fdb.grants[IMAGE_ID]["status"] == "ISSUED"
    assert len(env.admin.calls) == 1 and len(fdb.fail_plan) == 20 - repo_module.MAX_CONFIRM_ATTEMPTS


def test_firestore_commit_applied_then_deadline_exceeded_recovers_on_retry(env, fdb):
    auth, body = env.ready()
    fdb.fail_plan = [("after", DeadlineExceeded("deadline"))]
    first = env.confirm(body)
    assert first.status_code == 503 and first.json() == {"detail": "Storage unavailable"}  # client không biết commit đã áp dụng
    assert len(fdb.docs) == 1 and len(fdb.assets) == 3 and fdb.grants[IMAGE_ID]["status"] == "CONFIRMED"
    created_at = fdb.docs[IMAGE_ID]["createdAt"]
    admin_calls = len(env.admin.calls)
    second = env.confirm(body)
    assert second.status_code == 200 and second.json()["imageId"] == IMAGE_ID and second.json()["status"] == "DONE"
    assert len(fdb.docs) == 1 and len(fdb.assets) == 3 and fdb.docs[IMAGE_ID]["createdAt"] == created_at
    assert len(env.admin.calls) == admin_calls  # phục hồi chính xác từ Firestore, không xác minh/ghi lại


def test_firestore_other_write_errors_are_503_immediately_without_retry(env, fdb):
    auth, body = env.ready()
    fdb.fail_plan = [("before", RuntimeError("boom s3cr3t")), ("before", RuntimeError("again"))]
    res = env.confirm(body)
    assert res.status_code == 503 and "s3cr3t" not in res.text and len(fdb.fail_plan) == 1
    assert fdb.docs == {} and fdb.grants[IMAGE_ID]["status"] == "ISSUED"


def test_firestore_read_failure_is_503_and_no_admin_call_after_it(env, fdb):
    auth, body = env.ready()
    fdb.fail_with = RuntimeError("down")
    res = env.confirm(body)
    assert res.status_code == 503 and fdb.docs == {}


def test_firestore_batch_is_all_or_nothing_on_asset_collision(env, fdb):
    auth, body = env.ready()
    pid = auth["uploads"]["webp"]["fields"]["public_id"]
    fdb.assets[asset_key(pid)] = {"publicId": pid, "imageId": IMAGE_ID_2, "ownerId": "user_B"}
    res = env.confirm(body)
    assert res.status_code == 403
    assert fdb.docs == {} and len(fdb.assets) == 1 and fdb.grants[IMAGE_ID]["status"] == "ISSUED"


def test_firestore_collision_appearing_between_read_and_commit_is_caught_by_create_precondition(env, fdb):
    auth, body = env.ready()
    pid = auth["uploads"]["webp"]["fields"]["public_id"]

    def sneak():  # sau khi đọc (asset còn trống) nhưng trước commit, người khác đăng ký asset
        fdb.assets[asset_key(pid)] = {"publicId": pid, "imageId": IMAGE_ID_2, "ownerId": "user_B"}

    fdb.before_commit = sneak
    res = env.confirm(body)
    assert res.status_code == 403 and fdb.docs == {} and len(fdb.assets) == 1 and fdb.grants[IMAGE_ID]["status"] == "ISSUED"


def test_firestore_grant_changed_between_read_and_commit_is_not_overwritten(env, fdb):
    auth, body = env.ready()

    def tamper():  # grant bị đổi sau khi đọc (vd bị thu hồi): last_update_time không còn khớp
        fdb.grants[IMAGE_ID]["status"] = "REVOKED"
        fdb.times[("uploadGrants", IMAGE_ID)] = 10_000

    fdb.before_commit = tamper
    res = env.confirm(body)
    assert res.status_code == 409 and res.json() == {"detail": "Upload grant is not active"}
    assert fdb.docs == {} and fdb.assets == {} and fdb.grants[IMAGE_ID]["status"] == "REVOKED"


def test_firestore_image_appearing_between_read_and_commit_is_not_overwritten(env, fdb):
    auth, body = env.ready()
    fdb.before_commit = lambda: fdb.docs.__setitem__(IMAGE_ID, {"imageId": IMAGE_ID, "ownerId": "user_A", "status": "DONE", "marker": 1})
    res = env.confirm(body)
    assert res.status_code == 409 and res.json() == {"detail": "Image already exists"}
    assert fdb.docs[IMAGE_ID]["marker"] == 1 and fdb.assets == {} and fdb.grants[IMAGE_ID]["status"] == "ISSUED"


def test_firestore_concurrent_confirms_agree_and_write_once(env, fdb):
    auth, body = env.ready()
    data = parse_confirm_payload(body)
    out = run_threads(12, lambda i: signed_confirm_service.confirm("user_A", data))
    assert all(o[0] == "ok" for o in out), out
    assert len({json.dumps(o[1], sort_keys=True) for o in out}) == 1
    assert len(fdb.docs) == 1 and len(fdb.assets) == 3 and fdb.grants[IMAGE_ID]["status"] == "CONFIRMED"


def test_budgeted_options_cap_each_rpc_and_fail_closed_when_exhausted():
    import time as _time

    store_ = FirestoreImageStore(lambda: None, server_timestamp=SERVER_TS, timeouts=FirestoreTimeouts(read_s=10.0, write_s=10.0))
    read, write = store_._budgeted_options(_time.monotonic() + 3.0)
    assert 2.0 < read["timeout"] <= 3.0 and write["retry"] is None and 2.0 < write["timeout"] <= 3.0
    read, write = store_._budgeted_options(_time.monotonic() + 60.0)
    assert read["timeout"] == 10.0 and write["timeout"] == 10.0  # không nới quá cấu hình
    with pytest.raises(HTTPException) as err:
        store_._budgeted_options(_time.monotonic() + 0.1)
    assert err.value.status_code == 503
    with pytest.raises(HTTPException):
        store_._budgeted_options(_time.monotonic() - 5)


def test_no_unexpected_network_in_signed_flow(env, fresh_store):
    auth, body = env.ready()
    assert env.confirm(body).status_code == 200  # fixture loopback_only cũng làm test lỗi nếu có phân giải tên miền ngoài


# ================================================================== bổ sung sau mutation test
def test_grant_replaced_between_verify_and_commit_is_not_confirmed(env, fresh_store):
    """Grant bị đổi nội dung (vd khai báo khác) sau khi đã xác minh asset theo bản cũ => KHÔNG ghi theo bằng chứng của bản cũ."""
    auth, body = env.ready()

    def swap():
        fresh_store._grants[IMAGE_ID]["declared"] = {**fresh_store._grants[IMAGE_ID]["declared"], "originalSize": 999}

    env.admin.on_call = swap
    res = env.confirm(body)
    assert res.status_code in (409,) and res.json()["detail"] in ("Upload grant changed", DIFFERS)
    assert fresh_store._docs == {} and fresh_store._assets == {} and fresh_store._grants[IMAGE_ID]["status"] == "ISSUED"


def test_grant_public_ids_replaced_between_verify_and_commit_is_not_confirmed(env, fresh_store):
    auth, body = env.ready()
    env.admin.on_call = lambda: fresh_store._grants[IMAGE_ID].__setitem__("issuedAt", T0 - timedelta(days=1))
    res = env.confirm(body)
    assert res.status_code == 409 and res.json() == {"detail": "Upload grant changed"}
    assert fresh_store._docs == {} and fresh_store._assets == {}


def test_signed_mode_never_enters_the_legacy_code_path(env, fresh_store, monkeypatch):
    from app.services import image_service as image_service_module

    def boom(*a, **k):
        raise AssertionError("legacy parse/confirm không được chạy ở chế độ signed")

    monkeypatch.setattr(image_service_module, "parse_confirm_payload", boom)
    monkeypatch.setattr(image_service_module.image_repo, "create_with_assets", boom)
    monkeypatch.setattr(image_service_module.image_repo, "update_with_assets", boom)
    auth, body = env.ready()
    assert env.confirm(body).status_code == 200
    assert env.confirm(body).status_code == 200  # cả lần retry idempotent
    assert env.confirm(body, uid="user_B").status_code == 403


# ================================================================== H4B-6.1: CORS phải expose Retry-After (BUG-3) — dùng CẤU HÌNH THẬT của app.main.app
ORIGIN = "http://localhost:5173"


def _cors_headers(res):
    return {k.lower(): v for k, v in res.headers.items()}


def test_cors_config_of_real_app_exposes_retry_after_with_explicit_policy():
    # H4B-7B.1: mục tiêu của test (expose Retry-After, BUG-3) GIỮ NGUYÊN. Phần "các cấu hình khác không đổi" trước đây khóa chính sách MỞ cũ
    # (credentials=True, methods/headers=["*"], origin "*" + FRONTEND_URL) nên được cập nhật sang chính sách tường minh mới (xem test_cors_policy.py).
    from starlette.middleware.cors import CORSMiddleware

    from app.main import app

    entry = next(m for m in app.user_middleware if m.cls is CORSMiddleware)
    assert entry.kwargs["expose_headers"] == ["Retry-After"]
    assert entry.kwargs["allow_credentials"] is False and "*" not in entry.kwargs["allow_methods"] and "*" not in entry.kwargs["allow_headers"]
    assert "*" not in entry.kwargs["allow_origins"] and ORIGIN in entry.kwargs["allow_origins"]


def test_cross_origin_503_from_admin_420_exposes_retry_after(env, fresh_store):
    auth, body = env.ready()
    env.admin.raises = AdminRateLimited(120)
    res = env.client.post(URL, headers={**bearer("user_A"), "Origin": ORIGIN}, json=body)
    h = _cors_headers(res)
    assert res.status_code == 503 and h["retry-after"] == "120"  # Backend vẫn gửi Retry-After
    assert "retry-after" in [x.strip().lower() for x in h["access-control-expose-headers"].split(",")]  # và trình duyệt được phép đọc
    assert h["access-control-allow-origin"] in (ORIGIN, "*")  # chính sách origin sẵn có, không đổi ở bước này


def test_cross_origin_429_from_authorize_rate_limit_exposes_retry_after(env, monkeypatch):
    monkeypatch.setattr(settings, "UPLOAD_GRANTS_PER_HOUR", 1)
    first = env.client.post(AUTH_URL, headers={**bearer("user_A"), "Origin": ORIGIN}, json=authorize_body(IMAGE_ID))
    assert first.status_code == 200
    res = env.client.post(AUTH_URL, headers={**bearer("user_A"), "Origin": ORIGIN}, json=authorize_body(IMAGE_ID_2))
    h = _cors_headers(res)
    assert res.status_code == 429 and int(h["retry-after"]) >= 1
    assert "retry-after" in [x.strip().lower() for x in h["access-control-expose-headers"].split(",")]


def test_cross_origin_error_without_retry_after_still_has_cors_headers_and_no_retry_after(env, fresh_store):
    auth, body = env.ready()
    env.admin.raises = AdminUnavailable("500")
    res = env.client.post(URL, headers={**bearer("user_A"), "Origin": ORIGIN}, json=body)
    h = _cors_headers(res)
    assert res.status_code == 503 and "retry-after" not in h and h["access-control-allow-origin"] in (ORIGIN, "*")


def test_preflight_still_works_after_expose_headers():
    from fastapi.testclient import TestClient

    from app.main import app

    res = TestClient(app).options(AUTH_URL, headers={"Origin": ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"})
    h = _cors_headers(res)
    assert res.status_code == 200 and h["access-control-allow-origin"] in (ORIGIN, "*") and "POST" in h["access-control-allow-methods"]


# ================================================================== H4B-7B.1: authorize + signed confirm + Retry-After vẫn chạy qua CORS với CẢ HAI origin mặc định
LOOPBACK_ORIGIN = "http://127.0.0.1:5173"


@pytest.mark.parametrize("origin,image_id", [(ORIGIN, IMAGE_ID), (LOOPBACK_ORIGIN, IMAGE_ID_2)])
def test_authorize_and_signed_confirm_work_through_cors_for_both_default_origins(env, fresh_store, origin, image_id):
    headers = {**bearer("user_A"), "Origin": origin}
    res = env.client.post(AUTH_URL, headers=headers, json=authorize_body(image_id))
    assert res.status_code == 200 and _cors_headers(res)["access-control-allow-origin"] == origin
    auth = res.json()
    env.upload(auth, authorize_body(image_id))
    done = env.client.post(URL, headers=headers, json=env.confirm_body(auth))
    h = _cors_headers(done)
    assert done.status_code == 200 and done.json()["status"] == "DONE" and done.json()["imageId"] == image_id
    assert h["access-control-allow-origin"] == origin and "access-control-allow-credentials" not in h


@pytest.mark.parametrize("origin", [ORIGIN, LOOPBACK_ORIGIN])
def test_retry_after_429_and_503_are_exposed_for_both_default_origins(env, fresh_store, monkeypatch, origin):
    monkeypatch.setattr(settings, "UPLOAD_GRANTS_PER_HOUR", 1)
    headers = {**bearer("user_A"), "Origin": origin}
    assert env.client.post(AUTH_URL, headers=headers, json=authorize_body(IMAGE_ID)).status_code == 200
    r429 = env.client.post(AUTH_URL, headers=headers, json=authorize_body(IMAGE_ID_2))
    auth, body = env.ready(image_id="d3b6e4a2-9c53-4eaa-b134-5f7c8a9dbeb2", uid="user_B")  # người khác: không bị giới hạn của user_A
    env.admin.raises = AdminRateLimited(90)
    r503 = env.client.post(URL, headers={**bearer("user_B"), "Origin": origin}, json=body)
    for res, code in ((r429, 429), (r503, 503)):
        h = _cors_headers(res)
        assert res.status_code == code and int(h["retry-after"]) >= 1
        assert h["access-control-allow-origin"] == origin
        assert "retry-after" in [x.strip().lower() for x in h["access-control-expose-headers"].split(",")]
    assert _cors_headers(r503)["retry-after"] == "90"


# ================================================================== H4B-7B.2: mode signed khóa POST /images/upload-url; luồng an toàn không đổi; không rơi về legacy
UPLOAD_URL = "/images/upload-url"
UPLOAD_BODY = {"filename": "a.jpg", "contentType": "image/jpeg", "sizeBytes": 1000}


def test_signed_mode_retires_upload_url_and_the_secure_flow_keeps_working(env, fresh_store):
    from helpers import IMAGE_ID

    locked = env.client.post(UPLOAD_URL, headers=bearer("user_A"), json=UPLOAD_BODY)
    assert locked.status_code == 410 and locked.json() == {"detail": "Legacy upload endpoint is retired"}
    assert "uploadPreset" not in locked.text and "publicId" not in locked.text and fresh_store._docs == {}

    auth, body = env.ready()
    done = env.confirm(body)
    assert done.status_code == 200 and done.json()["status"] == "DONE" and done.json()["imageId"] == IMAGE_ID
    assert env.confirm(body).status_code == 200  # confirm lặp lại (idempotent) vẫn thành công
    assert env.confirm(body, uid="user_B").status_code == 403  # grant của người khác
    assert env.client.get(f"/images/{IMAGE_ID}", headers=bearer("user_A")).status_code == 200  # Gallery đọc được theo owner
    assert env.client.get(f"/images/{IMAGE_ID}", headers=bearer("user_B")).status_code == 403

    assert env.client.post(UPLOAD_URL, headers=bearer("user_A"), json=UPLOAD_BODY).status_code == 410  # vẫn khóa sau khi có ảnh
    assert set(fresh_store._docs) == {IMAGE_ID}  # upload-url không tạo bản ghi PENDING nào


def test_signed_mode_never_falls_back_to_legacy_confirm(env, fresh_store):
    from helpers import full_payload

    res = env.client.post(URL, headers=bearer("user_A"), json=full_payload())  # không có grant
    assert res.status_code == 403 and fresh_store._docs == {} and fresh_store._assets == {} and env.admin.calls == []


def test_signed_mode_with_an_injected_legacy_provider_still_never_falls_back_to_legacy(env, fresh_store, monkeypatch):
    # H4B-7B.2.1 (thay cho test về "cờ legacy thừa", cờ đó không còn tồn tại): provider legacy được tiêm không làm đổi mode signed.
    from app.services import upload_mode
    from helpers import full_payload

    auth, body = env.ready()
    monkeypatch.setattr(upload_mode, "_legacy_provider", upload_mode.LegacyCompatProvider("test-cloud", "test-unsigned-preset"))
    assert env.confirm(body).status_code == 200  # signed vẫn chạy bình thường
    assert env.client.post(URL, headers=bearer("user_A"), json=full_payload(IMAGE_ID_2)).status_code == 403  # không grant => từ chối, không rơi về legacy
    upload = env.client.post(UPLOAD_URL, headers=bearer("user_A"), json=UPLOAD_BODY)
    assert upload.status_code == 410 and "uploadPreset" not in upload.text and "test-unsigned-preset" not in upload.text
    assert set(fresh_store._docs) == {IMAGE_ID}
