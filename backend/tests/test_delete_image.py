import hashlib
from copy import deepcopy
from fastapi.testclient import TestClient
import pytest

from app import main
from app import auth
from app import services


class _FakeSnapshot:
    def __init__(self, doc_id: str, data: dict | None):
        self.id = doc_id
        self._data = deepcopy(data) if data is not None else None

    @property
    def exists(self) -> bool:
        return self._data is not None

    def to_dict(self) -> dict | None:
        return deepcopy(self._data) if self._data is not None else None


class _FakeDocumentRef:
    def __init__(self, store: dict[str, dict[str, dict]], collection_name: str, doc_id: str):
        self._store = store
        self._col = collection_name
        self._id = doc_id

    @property
    def path(self) -> tuple[str, str]:
        return (self._col, self._id)

    def get(self) -> _FakeSnapshot:
        data = self._store.get(self._col, {}).get(self._id)
        return _FakeSnapshot(self._id, data)

    def set(self, data: dict, merge: bool = False) -> None:
        col_dict = self._store.setdefault(self._col, {})
        if merge and self._id in col_dict:
            col_dict[self._id].update(deepcopy(data))
        else:
            col_dict[self._id] = deepcopy(data)

    def delete(self) -> None:
        self._store.get(self._col, {}).pop(self._id, None)


class _FakeCollectionRef:
    def __init__(self, store: dict[str, dict[str, dict]], name: str):
        self._store = store
        self._name = name

    def document(self, doc_id: str) -> _FakeDocumentRef:
        return _FakeDocumentRef(self._store, self._name, doc_id)


class _FakeWriteBatch:
    def __init__(self) -> None:
        self._ops: list[tuple[str, _FakeDocumentRef, dict | None, bool]] = []

    def delete(self, ref: _FakeDocumentRef) -> None:
        self._ops.append(("delete", ref, None, False))

    def set(self, ref: _FakeDocumentRef, data: dict, merge: bool = False) -> None:
        self._ops.append(("set", ref, deepcopy(data), merge))

    def commit(self) -> None:
        for op, ref, data, merge in self._ops:
            if op == "delete":
                ref.delete()
            elif op == "set" and data is not None:
                ref.set(data, merge=merge)
        self._ops.clear()


class FakeFirestoreClient:
    def __init__(self) -> None:
        self.data: dict[str, dict[str, dict]] = {}

    def collection(self, name: str) -> _FakeCollectionRef:
        return _FakeCollectionRef(self.data, name)

    def batch(self) -> _FakeWriteBatch:
        return _FakeWriteBatch()

    def get_doc(self, collection_name: str, doc_id: str) -> dict | None:
        val = self.data.get(collection_name, {}).get(doc_id)
        return deepcopy(val) if val is not None else None


@pytest.fixture()
def fake_db(monkeypatch):
    db = FakeFirestoreClient()
    # Patch db trên image_service (chỉnh lại đường dẫn import nếu instance/module khác tên)
    import app.services.image_service as image_service_mod

    if hasattr(image_service_mod, "image_service"):
        monkeypatch.setattr(image_service_mod.image_service, "db", db, raising=False)
    if hasattr(image_service_mod, "db"):
        monkeypatch.setattr(image_service_mod, "db", db, raising=False)
    return db


@pytest.fixture()
def auth_as():
    """Helper bật/tắt dependency get_current_uid theo uid mong muốn."""
    def _set_uid(uid: str | None):
        if uid is None:
            main.app.dependency_overrides.pop(auth.get_current_uid, None)
        else:
            main.app.dependency_overrides[auth.get_current_uid] = lambda: uid

    yield _set_uid
    main.app.dependency_overrides.pop(auth.get_current_uid, None)


@pytest.fixture()
def seeded_cloudinary_image(fake_db: FakeFirestoreClient, monkeypatch):
    monkeypatch.setenv("UPLOAD_ENVIRONMENT", "dev")
    image_id = "img_cloud_001"
    owner_uid = "user_owner_A"
    public_ids = {
        "thumb": f"hybrid/dev/{image_id}/thumb",
        "medium": f"hybrid/dev/{image_id}/medium",
        "full": f"hybrid/dev/{image_id}/full",
    }

    fake_db.collection("images").document(image_id).set(
        {
            "imageId": image_id,
            "ownerId": owner_uid,
            "provider": "cloudinary",
            "status": "COMPLETED",
            "publicIds": public_ids,
            "variants": {
                "thumbnail": f"https://res.cloudinary.com/demo/image/upload/v1/{public_ids['thumb']}.webp",
                "medium": f"https://res.cloudinary.com/demo/image/upload/v1/{public_ids['medium']}.webp",
                "webp": f"https://res.cloudinary.com/demo/image/upload/v1/{public_ids['full']}.webp",
            },
        }
    )

    for pid in public_ids.values():
        doc_id = hashlib.sha256(pid.encode("utf-8")).hexdigest()
        fake_db.collection("cloudinaryAssets").document(doc_id).set(
            {
                "publicId": pid,
                "imageId": image_id,
                "ownerId": owner_uid,
            }
        )

    fake_db.collection("uploadGrants").document(image_id).set(
        {
            "imageId": image_id,
            "ownerId": owner_uid,
            "status": "CONFIRMED",
        }
    )

    return {
        "imageId": image_id,
        "ownerId": owner_uid,
        "publicIds": [public_ids["thumb"], public_ids["medium"], public_ids["full"]],
    }


client = TestClient(main.app)


def test_owner_can_delete_and_reconfirm_returns_409(
    monkeypatch, auth_as, fake_db: FakeFirestoreClient, seeded_cloudinary_image
):
    image_id = seeded_cloudinary_image["imageId"]
    owner_id = seeded_cloudinary_image["ownerId"]
    expected_public_ids = seeded_cloudinary_image["publicIds"]

    captured_calls: list[list[str]] = []

    def fake_delete_resources(public_ids, **kwargs):
        ids = list(public_ids)
        captured_calls.append(ids)
        return {pid: "deleted" for pid in ids}

    monkeypatch.setattr("app.services.image_service.delete_resources", fake_delete_resources)
    auth_as(owner_id)

    res = client.delete(f"/images/{image_id}", headers={"Authorization": "Bearer valid-token"})
    assert res.status_code == 204
    assert res.content == b""

    # Cloudinary fake nhận đúng 1 lời gọi với đủ 3 public_id
    assert len(captured_calls) == 1
    assert captured_calls[0] == expected_public_ids

    # Kiểm tra WriteBatch trên Firestore:
    # - images/{imageId} đã bị xóa
    assert fake_db.get_doc("images", image_id) is None

    # - 3 doc cloudinaryAssets/{sha256(public_id)} đã bị xóa
    for pid in expected_public_ids:
        sha_id = hashlib.sha256(pid.encode("utf-8")).hexdigest()
        assert fake_db.get_doc("cloudinaryAssets", sha_id) is None

    # - uploadGrants/{imageId} KHÔNG bị xóa và status == "DELETED"
    grant_doc = fake_db.get_doc("uploadGrants", image_id)
    assert grant_doc is not None
    assert grant_doc["status"] == "DELETED"

    # 6. Xóa xong gọi confirm lại cùng imageId -> 409
    confirm_payload = {
        "imageId": image_id,
        "fileName": "photo.jpg",
        "originalSize": 102400,
        "processedSize": 51200,
        "thumbnailPublicId": expected_public_ids[0],
        "mediumPublicId": expected_public_ids[1],
        "webpPublicId": expected_public_ids[2],
        "processingMs": 120.0,
        "contentType": "image/jpeg",
    }
    confirm_res = client.post(
        "/images/cloudinary/confirm",
        json=confirm_payload,
        headers={"Authorization": "Bearer valid-token"},
    )
    assert confirm_res.status_code == 409


# 2. Người khác xóa -> 403
def test_non_owner_delete_returns_403(
    monkeypatch, auth_as, fake_db: FakeFirestoreClient, seeded_cloudinary_image
):
    image_id = seeded_cloudinary_image["imageId"]
    called = False

    def fake_delete_resources(*args, **kwargs):
        nonlocal called
        called = True
        return {}

    monkeypatch.setattr("app.services.image_service.delete_resources", fake_delete_resources)
    auth_as("other_user_B")

    res = client.delete(f"/images/{image_id}", headers={"Authorization": "Bearer other-token"})
    assert res.status_code == 403
    assert res.json() == {"detail": "Forbidden"}
    assert called is False
    assert fake_db.get_doc("images", image_id) is not None


# 3. Không token -> 401
def test_missing_token_returns_401(auth_as):
    auth_as(None)
    res = client.delete("/images/img_cloud_001")
    assert res.status_code == 401
    assert res.json() == {"detail": "Missing token"}


# 4. imageId không tồn tại -> 404
def test_nonexistent_image_returns_404(auth_as, fake_db: FakeFirestoreClient):
    auth_as("user_owner_A")
    res = client.delete("/images/does_not_exist", headers={"Authorization": "Bearer valid-token"})
    assert res.status_code == 404
    assert res.json() == {"detail": "Image not found"}


# 5. Cloudinary lỗi -> 503 và doc còn nguyên
def test_cloudinary_failure_returns_503_and_preserves_firestore_docs(
    monkeypatch, auth_as, fake_db: FakeFirestoreClient, seeded_cloudinary_image
):
    image_id = seeded_cloudinary_image["imageId"]
    owner_id = seeded_cloudinary_image["ownerId"]

    def failing_delete_resources(*args, **kwargs):
        raise services.image_service.AdminUnavailable("Cloudinary Admin API timeout")

    monkeypatch.setattr("app.services.image_service.delete_resources", failing_delete_resources)
    auth_as(owner_id)

    res = client.delete(f"/images/{image_id}", headers={"Authorization": "Bearer valid-token"})
    assert res.status_code == 503
    assert res.json() == {"detail": "Delete unavailable"}

    # Toàn bộ doc Firestore vẫn giữ nguyên để user có thể xóa lại
    assert fake_db.get_doc("images", image_id) is not None
    assert fake_db.get_doc("uploadGrants", image_id)["status"] == "CONFIRMED"
    for pid in seeded_cloudinary_image["publicIds"]:
        sha_id = hashlib.sha256(pid.encode("utf-8")).hexdigest()
        assert fake_db.get_doc("cloudinaryAssets", sha_id) is not None