"""Test kho Firestore của confirm bằng client GIẢ (tests/fakes.py). Không cần credential, không gọi Firestore thật.

Chỉ kiểm tra cách code dùng API Firestore (create/get/update/query) và hành vi khi lỗi. KHÔNG thay thế việc thử với
Firestore Emulator hoặc project thử (index, quyền, giới hạn, độ trễ).
"""
import datetime

import pytest
from fakes import SERVER_TS, FakeFirestore, ServiceUnavailable
from helpers import IMAGE_ID, IMAGE_ID_2, bearer, full_payload, minimal_payload

from app.config import Settings, settings
from app.repositories.image_repository import FirestoreImageStore, ImageRepository, MemoryImageStore, image_repo

pytestmark = pytest.mark.usefixtures("legacy_upload_compat")  # H4B-7B.2: các test này kiểm thử đường LEGACY; mặc định mới là "disabled" nên bật tương thích TƯỜNG MINH (xem conftest)

URL = "/images/cloudinary/confirm"


@pytest.fixture
def fake_db(fresh_store):
    """Đưa kho Firestore (client giả) vào repository dùng chung của app."""
    db = FakeFirestore()
    image_repo.configure(FirestoreImageStore(lambda: db, server_timestamp=SERVER_TS))
    return db


def post(client, payload, uid="user_A"):
    return client.post(URL, headers=bearer(uid), json=payload)


# ------------------------------------------------------------------ lưu và đọc metadata
def test_confirm_writes_contract_document_to_firestore(client, fake_db, fresh_store):
    payload = full_payload()
    res = post(client, payload)

    assert res.status_code == 200
    doc = fake_db.docs[IMAGE_ID]
    assert doc["ownerId"] == "user_A" and doc["status"] == "DONE" and doc["provider"] == "cloudinary"
    assert doc["fileName"] == "anh-bien.jpg"
    assert doc["original"] == {"size": 2457600, "width": 4000, "height": 3000}
    assert doc["variants"] == {"thumbnail": payload["thumbnail"], "medium": payload["medium"], "webp": payload["webp"]}
    assert doc["publicIds"] == {"thumbnail": payload["thumbnailId"], "medium": payload["mediumId"], "webp": payload["webpId"]}
    assert doc["previewUrl"] == payload["thumbnail"]
    assert doc["processedSize"] == 412000 and doc["savedPercent"] == 83.2 and doc["processingMs"] == 1840
    assert doc["retryCount"] == 0 and doc["errorReason"] is None
    # createdAt/updatedAt là SERVER TIMESTAMP (stub quy đổi sentinel thành thời gian), không phải chuỗi do client tự ghi
    assert isinstance(doc["createdAt"], datetime.datetime) and isinstance(doc["updatedAt"], datetime.datetime)
    assert fresh_store.get(IMAGE_ID) is None  # KHÔNG có bản sao trong RAM


def test_written_metadata_can_be_read_back_through_the_api(client, fake_db):
    assert post(client, full_payload()).status_code == 200

    own = client.get(f"/images/{IMAGE_ID}", headers=bearer("user_A"))
    assert own.status_code == 200
    assert own.json()["variants"]["webp"] == full_payload()["webp"]

    other = client.get(f"/images/{IMAGE_ID}", headers=bearer("user_B"))
    assert other.status_code == 403 and other.json() == {"detail": "Forbidden"}


def test_idempotent_and_ownership_on_firestore(client, fake_db):
    first = post(client, full_payload())
    stored = dict(fake_db.docs[IMAGE_ID])

    second = post(client, full_payload(suffix="Z"))
    assert second.status_code == 200 and second.json() == first.json()
    assert fake_db.docs[IMAGE_ID] == stored  # không ghi đè
    assert fake_db.calls.count("set") == 0 and fake_db.calls.count("update") == 0

    other = post(client, full_payload(suffix="Q"), uid="user_B")
    assert other.status_code == 403 and other.json() == {"detail": "Forbidden"}
    assert fake_db.docs[IMAGE_ID] == stored


def test_asset_registry_blocks_another_user_on_firestore(client, fake_db):
    assert post(client, full_payload()).status_code == 200
    # Sổ đăng ký asset: 3 public_id khác nhau, mỗi cái thuộc user_A / IMAGE_ID
    assert len(fake_db.assets) == 3
    assert {c["ownerId"] for c in fake_db.assets.values()} == {"user_A"}
    assert {c["imageId"] for c in fake_db.assets.values()} == {IMAGE_ID}

    res = post(client, full_payload(image_id=IMAGE_ID_2), uid="user_B")  # cùng asset của A
    assert res.status_code == 403
    assert IMAGE_ID_2 not in fake_db.docs  # không tạo bản ghi
    assert len(fake_db.assets) == 3  # và không đăng ký thêm asset


def test_pending_record_is_completed_in_place(client, fake_db):
    created_at = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
    fake_db.docs[IMAGE_ID] = {
        "imageId": IMAGE_ID, "ownerId": "user_A", "status": "PENDING", "retryCount": 1,
        "createdAt": created_at, "updatedAt": created_at, "variants": None,
    }

    res = post(client, full_payload())

    assert res.status_code == 200 and res.json()["status"] == "DONE"
    doc = fake_db.docs[IMAGE_ID]
    assert doc["status"] == "DONE" and doc["savedPercent"] == 83.2
    assert doc["createdAt"] == created_at and doc["retryCount"] == 1  # giữ nguyên
    assert doc["updatedAt"] > created_at  # đã đổi sang server timestamp mới
    # Cập nhật + đăng ký asset là MỘT batch nguyên tử (không có create/update/set lẻ)
    assert fake_db.batch_commits == 1
    assert [c for c in fake_db.calls if c in ("create", "update", "set")] == []
    assert len(fake_db.assets) == 3 and {c["ownerId"] for c in fake_db.assets.values()} == {"user_A"}


def test_pending_record_of_another_user_cannot_be_completed(client, fake_db):
    fake_db.docs[IMAGE_ID] = {"imageId": IMAGE_ID, "ownerId": "user_A", "status": "PENDING"}
    res = post(client, full_payload(), uid="user_B")
    assert res.status_code == 403
    assert fake_db.docs[IMAGE_ID] == {"imageId": IMAGE_ID, "ownerId": "user_A", "status": "PENDING"}


# ------------------------------------------------------------------ Firestore lỗi => 503, KHÔNG rơi về RAM
def test_firestore_error_returns_503_without_leaking_details_or_using_ram(client, fake_db, fresh_store):
    fake_db.fail_with = ServiceUnavailable("chi tiết nội bộ bí mật xyz project-123")

    res = post(client, minimal_payload())

    assert res.status_code == 503
    assert res.json() == {"detail": "Storage unavailable"}
    assert "xyz" not in res.text and "project-123" not in res.text
    assert fresh_store.get(IMAGE_ID) is None  # không lén lưu vào RAM


def test_firestore_create_error_other_than_already_exists_returns_503(client, fake_db, monkeypatch):
    import fakes

    class Boom(Exception):
        pass

    def exploding_commit(self):
        raise Boom("lỗi lạ")

    monkeypatch.setattr(fakes.FakeWriteBatch, "commit", exploding_commit)

    res = post(client, minimal_payload())

    assert res.status_code == 503 and res.json() == {"detail": "Storage unavailable"}
    assert IMAGE_ID not in fake_db.docs and fake_db.assets == {}  # không ghi dở dang


def test_client_factory_failure_returns_503_and_is_retried_next_request(client, fresh_store):
    attempts = []

    def failing_factory():
        attempts.append(1)
        raise RuntimeError("DefaultCredentialsError giả lập: không có credential")

    image_repo.configure(FirestoreImageStore(failing_factory, server_timestamp=SERVER_TS))

    first = post(client, minimal_payload())
    second = post(client, minimal_payload())

    assert first.status_code == 503 and second.status_code == 503
    assert first.json() == {"detail": "Storage unavailable"}
    assert "DefaultCredentials" not in first.text
    assert len(attempts) == 2  # lỗi không bị cache; lần sau thử lại
    assert fresh_store.get(IMAGE_ID) is None


# ------------------------------------------------------------------ cấu hình chọn kho
def test_default_settings_are_production_safe():
    assert Settings.model_fields["IMAGE_STORE"].default == "firestore"
    assert Settings.model_fields["FIREBASE_CREDENTIALS_FILE"].default == ""  # không tự nạp file credentials trong repo


def test_repository_selects_store_from_settings_lazily(monkeypatch):
    monkeypatch.setattr(settings, "IMAGE_STORE", "firestore")
    repo = ImageRepository()
    store = repo.store
    assert isinstance(store, FirestoreImageStore)
    assert store._client is None  # chưa kết nối Firestore cho tới khi thật sự dùng

    monkeypatch.setattr(settings, "IMAGE_STORE", " Memory ")
    assert isinstance(ImageRepository().store, MemoryImageStore)


def test_invalid_image_store_setting_returns_503(client, monkeypatch):
    monkeypatch.setattr(settings, "IMAGE_STORE", "bogus")
    image_repo.configure(None)  # buộc chọn lại kho từ cấu hình
    # H4B-7B.2: mode legacy chỉ chạy với IMAGE_STORE=memory (cổng chặn trước, 503 "Signed upload unavailable"), nên không còn dùng legacy confirm làm
    # phương tiện thử kho sai; dùng route đọc (qua repository) để kiểm đúng cùng mục tiêu: IMAGE_STORE sai => 503 "Storage unavailable", không tự rơi về RAM.
    res = client.get(f"/images/{IMAGE_ID}", headers=bearer("user_A"))
    assert res.status_code == 503 and res.json() == {"detail": "Storage unavailable"}
