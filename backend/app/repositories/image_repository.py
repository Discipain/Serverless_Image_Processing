"""Kho metadata ảnh (collection `images/{imageId}`).

- Mặc định lưu Firestore (`IMAGE_STORE=firestore`). KHÔNG còn tự rơi về RAM khi Firestore lỗi: lỗi => 503.
- `IMAGE_STORE=memory` chỉ dành cho dev/test (mất dữ liệu khi tắt server, không dùng chung giữa nhiều instance).
- Khởi tạo lười: import module này không chạm mạng hay credential.
- `create_if_absent` là thao tác nguyên tử (Firestore `create()` báo lỗi nếu doc đã có) nên hai request confirm
  cùng `imageId` không thể ghi đè nhau.
"""
import copy
import logging
import threading
from datetime import datetime, timezone
from typing import Any, Callable

from app.config import settings
from app.exceptions import StorageUnavailableException

logger = logging.getLogger(__name__)

COLLECTION_NAME = "images"
# Sổ đăng ký asset Cloudinary: tài liệu `cloudinaryAssets/{sha256(public_id)}` = {publicId, imageId, ownerId, createdAt}.
# Tạo bằng `create` (thất bại nếu đã có) CÙNG LÚC với bản ghi ảnh trong một batch nguyên tử, nên một public_id chỉ thuộc một imageId.
ASSET_COLLECTION_NAME = "cloudinaryAssets"


def _is_already_exists(exc: BaseException) -> bool:
    """google.api_core.exceptions.AlreadyExists (nhận diện theo tên để test không cần cài thư viện Google)."""
    return any(cls.__name__ == "AlreadyExists" for cls in type(exc).__mro__)


def _is_not_found(exc: BaseException) -> bool:
    """google.api_core.exceptions.NotFound (cập nhật một tài liệu không còn tồn tại)."""
    return any(cls.__name__ == "NotFound" for cls in type(exc).__mro__)


class MemoryImageStore:
    """Kho trong RAM. CHỈ dev/test."""

    def __init__(self) -> None:
        self._docs: dict[str, dict[str, Any]] = {}
        self._assets: dict[str, dict[str, Any]] = {}  # khóa asset -> bản ghi đăng ký
        self._lock = threading.Lock()

    def server_time(self) -> datetime:
        return datetime.now(timezone.utc)

    def create(self, doc: dict[str, Any]) -> bool:
        with self._lock:
            if doc["imageId"] in self._docs:
                return False
            self._docs[doc["imageId"]] = copy.deepcopy(doc)
            return True

    def get(self, image_id: str) -> dict[str, Any] | None:
        with self._lock:
            doc = self._docs.get(image_id)
            return copy.deepcopy(doc) if doc is not None else None

    def save(self, doc: dict[str, Any]) -> None:
        with self._lock:
            self._docs[doc["imageId"]] = copy.deepcopy(doc)

    def update(self, image_id: str, fields: dict[str, Any]) -> None:
        with self._lock:
            if image_id not in self._docs:
                raise KeyError(image_id)
            self._docs[image_id].update(copy.deepcopy(fields))

    def list_by_owner(self, owner_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return [copy.deepcopy(d) for d in self._docs.values() if d.get("ownerId") == owner_id]

    def create_with_assets(self, doc: dict[str, Any], claims: dict[str, dict[str, Any]]) -> bool:
        """NGUYÊN TỬ (dưới một khóa): tạo bản ghi ảnh + đăng ký các asset. False (không ghi gì) nếu ảnh hoặc BẤT KỲ asset đã có."""
        with self._lock:
            if doc["imageId"] in self._docs or any(key in self._assets for key in claims):
                return False
            self._docs[doc["imageId"]] = copy.deepcopy(doc)
            for key, claim in claims.items():
                self._assets[key] = copy.deepcopy(claim)
            return True

    def update_with_assets(self, image_id: str, fields: dict[str, Any], claims: dict[str, dict[str, Any]]) -> bool:
        """NGUYÊN TỬ: cập nhật bản ghi ảnh có sẵn + đăng ký asset. False (không ghi gì) nếu ảnh không còn hoặc có asset đã bị chiếm."""
        with self._lock:
            if image_id not in self._docs or any(key in self._assets for key in claims):
                return False
            self._docs[image_id].update(copy.deepcopy(fields))
            for key, claim in claims.items():
                self._assets[key] = copy.deepcopy(claim)
            return True

    def get_asset_claims(self, keys: list[str]) -> dict[str, dict[str, Any]]:
        with self._lock:
            return {key: copy.deepcopy(self._assets[key]) for key in keys if key in self._assets}

    def find_by_drive_file_id(self, drive_file_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return [copy.deepcopy(d) for d in self._docs.values() if d.get("driveFileId") == drive_file_id]

    def clear(self) -> None:
        with self._lock:
            self._docs.clear()
            self._assets.clear()


def _default_firestore_client():
    from firebase_admin import firestore

    from app.auth import _ensure_firebase_app

    _ensure_firebase_app()
    return firestore.client()


class FirestoreImageStore:
    """Kho Firestore. `client_factory` và `server_timestamp` được tiêm vào để test bằng stub (không cần credential)."""

    def __init__(self, client_factory: Callable[[], Any] = _default_firestore_client, server_timestamp: Any = None) -> None:
        self._client_factory = client_factory
        self._client: Any = None
        self._server_timestamp = server_timestamp

    # ----- nội bộ -----
    def _db(self):
        if self._client is None:
            try:
                self._client = self._client_factory()
            except Exception as exc:  # thiếu credential, sai project, mất mạng...
                logger.error("Không khởi tạo được Firestore: %s", type(exc).__name__)
                raise StorageUnavailableException() from None
        return self._client

    def _ref(self, image_id: str):
        return self._db().collection(COLLECTION_NAME).document(image_id)

    @staticmethod
    def _unavailable(exc: BaseException) -> StorageUnavailableException:
        logger.error("Lỗi Firestore: %s", type(exc).__name__)  # không ghi thông điệp (có thể chứa dữ liệu)
        return StorageUnavailableException()

    @staticmethod
    def _where(query: Any, field: str, value: Any) -> Any:
        try:
            from google.cloud.firestore_v1.base_query import FieldFilter

            return query.where(filter=FieldFilter(field, "==", value))
        except ImportError:
            return query.where(field, "==", value)

    # ----- API -----
    def server_time(self) -> Any:
        if self._server_timestamp is None:
            from firebase_admin import firestore

            self._server_timestamp = firestore.SERVER_TIMESTAMP
        return self._server_timestamp

    def create(self, doc: dict[str, Any]) -> bool:
        ref = self._ref(doc["imageId"])
        try:
            ref.create(doc)
            return True
        except Exception as exc:
            if _is_already_exists(exc):
                return False
            raise self._unavailable(exc) from None

    def get(self, image_id: str) -> dict[str, Any] | None:
        ref = self._ref(image_id)
        try:
            snap = ref.get()
            return (snap.to_dict() or {}) if snap.exists else None
        except Exception as exc:
            raise self._unavailable(exc) from None

    def save(self, doc: dict[str, Any]) -> None:
        ref = self._ref(doc["imageId"])
        try:
            ref.set(doc)
        except Exception as exc:
            raise self._unavailable(exc) from None

    def update(self, image_id: str, fields: dict[str, Any]) -> None:
        ref = self._ref(image_id)
        try:
            ref.update(fields)
        except Exception as exc:
            raise self._unavailable(exc) from None

    def list_by_owner(self, owner_id: str) -> list[dict[str, Any]]:
        try:
            query = self._where(self._db().collection(COLLECTION_NAME), "ownerId", owner_id)
            return [d.to_dict() or {} for d in query.stream()]
        except StorageUnavailableException:
            raise
        except Exception as exc:
            raise self._unavailable(exc) from None

    def _asset_ref(self, key: str):
        return self._db().collection(ASSET_COLLECTION_NAME).document(key)

    def _commit_batch(self, build) -> bool:
        """Chạy một WriteBatch. True nếu commit; False nếu một `create` đụng tài liệu đã có hoặc một `update` nhắm tài liệu
        không còn tồn tại (toàn bộ batch bị hủy, không ghi gì)."""
        batch = self._db().batch()
        build(batch)
        try:
            batch.commit()
            return True
        except Exception as exc:
            if _is_already_exists(exc) or _is_not_found(exc):
                return False
            raise self._unavailable(exc) from None

    def create_with_assets(self, doc: dict[str, Any], claims: dict[str, dict[str, Any]]) -> bool:
        """NGUYÊN TỬ: một WriteBatch tạo images/{imageId} và các cloudinaryAssets/{key}. Có tài liệu nào đã tồn tại => hủy hết."""
        image_ref = self._ref(doc["imageId"])
        asset_refs = {key: self._asset_ref(key) for key in claims}

        def build(batch):
            batch.create(image_ref, doc)
            for key, claim in claims.items():
                batch.create(asset_refs[key], claim)

        return self._commit_batch(build)

    def update_with_assets(self, image_id: str, fields: dict[str, Any], claims: dict[str, dict[str, Any]]) -> bool:
        """NGUYÊN TỬ: một WriteBatch cập nhật bản ghi ảnh có sẵn và tạo các asset. Asset đã bị chiếm => hủy hết (False)."""
        image_ref = self._ref(image_id)
        asset_refs = {key: self._asset_ref(key) for key in claims}

        def build(batch):
            batch.update(image_ref, fields)
            for key, claim in claims.items():
                batch.create(asset_refs[key], claim)

        return self._commit_batch(build)

    def get_asset_claims(self, keys: list[str]) -> dict[str, dict[str, Any]]:
        result: dict[str, dict[str, Any]] = {}
        for key in keys:
            ref = self._asset_ref(key)
            try:
                snap = ref.get()
                if snap.exists:
                    result[key] = snap.to_dict() or {}
            except Exception as exc:
                raise self._unavailable(exc) from None
        return result

    def find_by_drive_file_id(self, drive_file_id: str) -> list[dict[str, Any]]:
        try:
            query = self._where(self._db().collection(COLLECTION_NAME), "driveFileId", drive_file_id).limit(10)
            return [snap.to_dict() or {} for snap in query.stream()]
        except StorageUnavailableException:
            raise
        except Exception as exc:
            raise self._unavailable(exc) from None


class ImageRepository:
    """Mặt tiền (facade) giữ API cũ `save/get_by_id/list_by_owner` và thêm các thao tác cho confirm."""

    COLLECTION_NAME = COLLECTION_NAME

    def __init__(self, store: Any = None) -> None:
        self._store = store
        self._memory_warned = False

    def configure(self, store: Any) -> None:
        """Tiêm kho khác (dùng cho test)."""
        self._store = store

    @property
    def store(self) -> Any:
        if self._store is None:
            mode = (settings.IMAGE_STORE or "").strip().lower()
            if mode == "firestore":
                self._store = FirestoreImageStore()
            elif mode == "memory":
                if not self._memory_warned:
                    logger.warning("IMAGE_STORE=memory: metadata chỉ nằm trong RAM, KHÔNG dùng cho production.")
                    self._memory_warned = True
                self._store = MemoryImageStore()
            else:
                logger.error("IMAGE_STORE không hợp lệ (chỉ nhận 'firestore' hoặc 'memory').")
                raise StorageUnavailableException()
        return self._store

    # ----- API cũ (giữ nguyên chữ ký) -----
    def save(self, image_doc: dict[str, Any]) -> dict[str, Any]:
        self.store.save(image_doc)
        return image_doc

    def get_by_id(self, image_id: str) -> dict[str, Any] | None:
        return self.store.get(image_id)

    def list_by_owner(self, owner_id: str) -> list[dict[str, Any]]:
        return self.store.list_by_owner(owner_id)

    # ----- API cho confirm -----
    def server_time(self) -> Any:
        return self.store.server_time()

    def create_if_absent(self, image_doc: dict[str, Any]) -> bool:
        """True nếu vừa tạo; False nếu `imageId` đã tồn tại (không ghi đè)."""
        return self.store.create(image_doc)

    def update_fields(self, image_id: str, fields: dict[str, Any]) -> None:
        self.store.update(image_id, fields)

    def create_with_assets(self, image_doc: dict[str, Any], claims: dict[str, dict[str, Any]]) -> bool:
        """Tạo ảnh + đăng ký asset NGUYÊN TỬ. False nếu `imageId` hoặc bất kỳ asset đã tồn tại (không ghi gì)."""
        return self.store.create_with_assets(image_doc, claims)

    def update_with_assets(self, image_id: str, fields: dict[str, Any], claims: dict[str, dict[str, Any]]) -> bool:
        """Cập nhật ảnh có sẵn + đăng ký asset NGUYÊN TỬ. False nếu ảnh không còn hoặc có asset đã bị chiếm."""
        return self.store.update_with_assets(image_id, fields, claims)

    def get_asset_claims(self, keys: list[str]) -> dict[str, dict[str, Any]]:
        """Các asset đã được đăng ký (khóa -> {publicId, imageId, ownerId, ...}). Chỉ để báo lỗi rõ; quyết định cuối là batch nguyên tử."""
        return self.store.get_asset_claims(keys)

    def find_by_drive_file_id(self, drive_file_id: str) -> list[dict[str, Any]]:
        """Các bản ghi trỏ tới một file Google Drive (tối đa 10). Dùng để kiểm tra quyền sở hữu trước khi xem Preview."""
        return self.store.find_by_drive_file_id(drive_file_id)


image_repo = ImageRepository()
