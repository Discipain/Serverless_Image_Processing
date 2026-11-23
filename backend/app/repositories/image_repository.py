"""Kho metadata ảnh (collection `images/{imageId}`).

- Mặc định lưu Firestore (`IMAGE_STORE=firestore`). KHÔNG còn tự rơi về RAM khi Firestore lỗi: lỗi => 503.
- `IMAGE_STORE=memory` chỉ dành cho dev/test (mất dữ liệu khi tắt server, không dùng chung giữa nhiều instance).
- Khởi tạo lười: import module này không chạm mạng hay credential.
- `create_if_absent` là thao tác nguyên tử (Firestore `create()` báo lỗi nếu doc đã có) nên hai request confirm
  cùng `imageId` không thể ghi đè nhau.
"""
import copy
import logging
import math
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from app.config import settings
from app.exceptions import StorageUnavailableException

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class FirestoreTimeouts:
    """Ngân sách thời gian CHO MỖI lời gọi RPC Firestore (không phải cho cả một HTTP request).

    Vì sao cần: mặc định của google-cloud-firestore khi kho không phản hồi là QUÁ DÀI — Commit/create: retry tới 60 s; get (BatchGetDocuments)
    và query (RunQuery): retry tới 300 s. Frontend chỉ chờ 30 s nên người dùng thấy "timeout" trong khi Backend vẫn treo một luồng.

    - ĐỌC (get, query, đọc asset): retry CÓ GIỚI HẠN với đúng các lỗi tạm thời mà SDK đã coi là retry được (DeadlineExceeded, InternalServerError,
      ServiceUnavailable), tổng thời gian retry VÀ deadline mỗi lần gọi đều bị chặn ở `read_s`. Đọc không có tác dụng phụ nên retry an toàn.
    - GHI (create, set, update, batch.commit): KHÔNG retry tự động (`retry=None`), chỉ chặn deadline mỗi lần gọi ở `write_s`. Lý do: commit có thể đã
      được áp dụng dù client không nhận phản hồi; việc xử lý "đã tồn tại / DONE" nằm ở tầng service (ImageService) và client có thể gọi lại an toàn.

    Một HTTP request có thể gồm nhiều RPC nối tiếp, nhưng khi kho ngừng thì RPC ĐẦU TIÊN thất bại làm cả request dừng ngay (lỗi nổi lên thành 503),
    nên thời gian tối đa khi kho ngừng xấp xỉ `max(read_s, write_s)`, không phải tổng của các RPC.
    """

    read_s: float = 10.0
    write_s: float = 10.0

    def __post_init__(self) -> None:
        for name in ("read_s", "write_s"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 < value <= 60:
                raise ValueError(f"FirestoreTimeouts.{name} phải là số trong (0, 60] giây.")

    def read_options(self) -> dict[str, Any]:
        """Tham số `retry`/`timeout` cho lời gọi ĐỌC (đã xác nhận SDK hỗ trợ: DocumentReference.get, Query.stream)."""
        from google.api_core import exceptions as gexc
        from google.api_core import retry as gretry

        retry = gretry.Retry(
            predicate=gretry.if_exception_type(gexc.DeadlineExceeded, gexc.InternalServerError, gexc.ServiceUnavailable),
            initial=0.1,
            maximum=1.0,
            multiplier=2.0,
            timeout=float(self.read_s),
        )
        return {"retry": retry, "timeout": float(self.read_s)}

    def write_options(self) -> dict[str, Any]:
        """Tham số cho lời gọi GHI: không retry, chỉ có deadline."""
        return {"retry": None, "timeout": float(self.write_s)}


# Cấu hình production (ImageRepository.store). Chọn 10 s để một request lỗi kho kết thúc ~10 s, còn dư nhiều so với timeout 30 s của Frontend.
DEFAULT_FIRESTORE_TIMEOUTS = FirestoreTimeouts()

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


def _page_sort_key(created_at: Any, image_id: str) -> tuple:
    """Khóa sắp xếp của Gallery: (createdAt, imageId), cùng thứ tự kiểu như Firestore (null < số < timestamp < chuỗi).

    `createdAt` có thể là datetime (confirm: server timestamp) hoặc chuỗi ISO (ảnh đồng bộ từ Drive / upload-url cũ). Khóa phụ
    `imageId` (= ID tài liệu) làm thứ tự là TOÀN PHẦN: hai ảnh cùng createdAt vẫn có vị trí cố định, không lặp/mất giữa các trang.
    Tài liệu không có createdAt xếp cuối khi sắp xếp giảm dần (kho Firestore thật thì LOẠI chúng khỏi truy vấn `order_by`)."""
    if isinstance(created_at, datetime):
        value = created_at if created_at.tzinfo else created_at.replace(tzinfo=timezone.utc)
        return (3, value, image_id)
    if isinstance(created_at, str):
        return (4, created_at, image_id)
    if created_at is None:
        return (0, 0, image_id)
    return (5, str(created_at), image_id)


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

    def list_page_by_owner(self, owner_id: str, limit: int, after: tuple[Any, str] | None = None) -> list[dict[str, Any]]:
        """Tối đa `limit + 1` ảnh của `owner_id`, mới nhất trước (createdAt giảm dần, rồi imageId giảm dần), SAU vị trí `after`
        = (createdAt, imageId) của ảnh cuối trang trước. Ảnh thứ `limit + 1` (nếu có) cho biết còn trang sau."""
        with self._lock:
            docs = [copy.deepcopy(d) for d in self._docs.values() if d.get("ownerId") == owner_id]
        docs.sort(key=lambda d: _page_sort_key(d.get("createdAt"), str(d.get("imageId", ""))), reverse=True)
        if after is not None:
            boundary = _page_sort_key(after[0], after[1])
            docs = [d for d in docs if _page_sort_key(d.get("createdAt"), str(d.get("imageId", ""))) < boundary]
        return docs[: limit + 1]

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

    def __init__(
        self,
        client_factory: Callable[[], Any] = _default_firestore_client,
        server_timestamp: Any = None,
        timeouts: FirestoreTimeouts | None = None,
    ) -> None:
        self._client_factory = client_factory
        self._client: Any = None
        self._server_timestamp = server_timestamp
        # `timeouts=None` (mặc định, dùng cho stub) = KHÔNG truyền retry/timeout, giữ nguyên chữ ký lời gọi cũ để FakeFirestore hoạt động.
        # Production (ImageRepository.store) truyền DEFAULT_FIRESTORE_TIMEOUTS.
        self._timeouts = timeouts
        self._read_opts: dict[str, Any] = timeouts.read_options() if timeouts is not None else {}
        self._write_opts: dict[str, Any] = timeouts.write_options() if timeouts is not None else {}

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
            ref.create(doc, **self._write_opts)
            return True
        except Exception as exc:
            if _is_already_exists(exc):
                return False
            raise self._unavailable(exc) from None

    def get(self, image_id: str) -> dict[str, Any] | None:
        ref = self._ref(image_id)
        try:
            snap = ref.get(**self._read_opts)
            return (snap.to_dict() or {}) if snap.exists else None
        except Exception as exc:
            raise self._unavailable(exc) from None

    def save(self, doc: dict[str, Any]) -> None:
        ref = self._ref(doc["imageId"])
        try:
            ref.set(doc, **self._write_opts)
        except Exception as exc:
            raise self._unavailable(exc) from None

    def update(self, image_id: str, fields: dict[str, Any]) -> None:
        ref = self._ref(image_id)
        try:
            ref.update(fields, **self._write_opts)
        except Exception as exc:
            raise self._unavailable(exc) from None

    def list_by_owner(self, owner_id: str) -> list[dict[str, Any]]:
        try:
            query = self._where(self._db().collection(COLLECTION_NAME), "ownerId", owner_id)
            return [d.to_dict() or {} for d in query.stream(**self._read_opts)]
        except StorageUnavailableException:
            raise
        except Exception as exc:
            raise self._unavailable(exc) from None

    def list_page_by_owner(self, owner_id: str, limit: int, after: tuple[Any, str] | None = None) -> list[dict[str, Any]]:
        """Một trang ảnh của `owner_id`, phân trang NGAY TRONG truy vấn Firestore (không tải cả collection):

            where ownerId == owner_id  ->  order_by createdAt DESC, __name__ DESC  ->  [start_after]  ->  limit(limit + 1)

        `__name__` (ID tài liệu = imageId) là khóa phụ duy nhất nên thứ tự toàn phần. Truy vấn này dùng index composite
        `ownerId ASC + createdAt DESC` đã có trong firestore.indexes.json (Firestore tự thêm `__name__` cùng hướng với
        trường cuối của index). CHƯA kiểm chứng với Firestore thật. Mọi lỗi => 503, không bao giờ thành danh sách rỗng.
        """
        try:
            query = self._where(self._db().collection(COLLECTION_NAME), "ownerId", owner_id)
            query = query.order_by("createdAt", direction="DESCENDING").order_by("__name__", direction="DESCENDING")
            if after is not None:
                # Thư viện google-cloud-firestore đổi chuỗi ở khóa "__name__" thành tham chiếu tài liệu trong collection.
                query = query.start_after({"createdAt": after[0], "__name__": after[1]})
            return [d.to_dict() or {} for d in query.limit(limit + 1).stream(**self._read_opts)]
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
            batch.commit(**self._write_opts)
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
                snap = ref.get(**self._read_opts)
                if snap.exists:
                    result[key] = snap.to_dict() or {}
            except Exception as exc:
                raise self._unavailable(exc) from None
        return result

    def find_by_drive_file_id(self, drive_file_id: str) -> list[dict[str, Any]]:
        try:
            query = self._where(self._db().collection(COLLECTION_NAME), "driveFileId", drive_file_id).limit(10)
            return [snap.to_dict() or {} for snap in query.stream(**self._read_opts)]
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
                self._store = FirestoreImageStore(timeouts=DEFAULT_FIRESTORE_TIMEOUTS)
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

    def list_page_by_owner(self, owner_id: str, limit: int, after: tuple[Any, str] | None = None) -> list[dict[str, Any]]:
        """Trang ảnh của một chủ sở hữu (tối đa `limit + 1` bản ghi, mới nhất trước). Xem `FirestoreImageStore.list_page_by_owner`."""
        return self.store.list_page_by_owner(owner_id, limit, after)

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
