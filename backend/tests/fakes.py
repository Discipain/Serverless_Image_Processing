"""Stub Firestore tối thiểu cho test: chỉ hỗ trợ đúng các lời gọi mà `FirestoreImageStore` dùng.

LƯU Ý: đây là stub do nhóm tự viết để test cách code dùng API; nó KHÔNG chứng minh hành vi của Firestore thật
(index, giới hạn kích thước, quyền, độ trễ...). Đặc biệt `batch()` ở đây GIẢ ĐỊNH đúng ngữ nghĩa mà tài liệu Firestore mô tả
cho WriteBatch (tất cả hoặc không gì cả; `create` thất bại nếu tài liệu đã tồn tại; `update` thất bại nếu chưa có) và dùng
một khóa để mô phỏng tính nguyên tử. Cần kiểm thử riêng với Firestore Emulator hoặc project thử.
"""
import copy
import threading
from datetime import datetime, timezone
from typing import Any

_MISSING = object()
SERVER_TS = object()  # thay cho firestore.SERVER_TIMESTAMP


class AlreadyExists(Exception):
    """Tên lớp trùng google.api_core.exceptions.AlreadyExists (code nhận diện theo tên)."""


class NotFound(Exception):
    """Tên lớp trùng google.api_core.exceptions.NotFound (cập nhật tài liệu không tồn tại)."""


class ServiceUnavailable(Exception):
    pass


def _resolve(value: Any) -> Any:
    if value is SERVER_TS:
        return datetime.now(timezone.utc)
    if isinstance(value, dict):
        return {k: _resolve(v) for k, v in value.items()}
    return copy.deepcopy(value)


def _get_path(data: dict[str, Any], dotted: str) -> Any:
    cur: Any = data
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return _MISSING
        cur = cur[part]
    return cur


class FakeSnapshot:
    def __init__(self, doc_id: str, data: dict[str, Any] | None) -> None:
        self.id = doc_id
        self._data = data

    @property
    def exists(self) -> bool:
        return self._data is not None

    def to_dict(self) -> dict[str, Any] | None:
        return copy.deepcopy(self._data) if self._data is not None else None


class FakeDocumentRef:
    def __init__(self, db: "FakeFirestore", collection: str, doc_id: str) -> None:
        self._db = db
        self.collection = collection
        self.id = doc_id

    @property
    def _store(self) -> dict[str, dict[str, Any]]:
        return self._db.collections[self.collection]

    def get(self) -> FakeSnapshot:
        self._db._tick("get")
        return FakeSnapshot(self.id, self._store.get(self.id))

    def create(self, data: dict[str, Any]) -> None:
        self._db._tick("create")
        with self._db.lock:
            if self.id in self._store:
                raise AlreadyExists("document already exists")
            self._store[self.id] = _resolve(data)

    def set(self, data: dict[str, Any]) -> None:
        self._db._tick("set")
        with self._db.lock:
            self._store[self.id] = _resolve(data)

    def update(self, fields: dict[str, Any]) -> None:
        self._db._tick("update")
        with self._db.lock:
            if self.id not in self._store:
                raise NotFound("not found")
            for key, value in fields.items():  # chỉ khóa cấp cao nhất (service không dùng đường dẫn có dấu chấm khi update)
                self._store[self.id][key] = _resolve(value)


class FakeWriteBatch:
    """Mô phỏng WriteBatch: kiểm tra TẤT CẢ điều kiện trước, rồi mới ghi; một điều kiện sai => không ghi gì."""

    def __init__(self, db: "FakeFirestore") -> None:
        self._db = db
        self._ops: list[tuple[str, FakeDocumentRef, dict[str, Any]]] = []

    def create(self, ref: FakeDocumentRef, data: dict[str, Any]) -> None:
        self._ops.append(("create", ref, data))

    def update(self, ref: FakeDocumentRef, fields: dict[str, Any]) -> None:
        self._ops.append(("update", ref, fields))

    def commit(self) -> None:
        self._db._tick("batch_commit")
        with self._db.lock:
            created: set[tuple[str, str]] = set()
            for kind, ref, _ in self._ops:  # bước 1: kiểm tra điều kiện (chưa ghi gì)
                key = (ref.collection, ref.id)
                if kind == "create":
                    if ref.id in ref._store or key in created:
                        raise AlreadyExists("document already exists")
                    created.add(key)
                elif ref.id not in ref._store and key not in created:
                    raise NotFound("not found")
            for kind, ref, data in self._ops:  # bước 2: ghi
                if kind == "create":
                    ref._store[ref.id] = _resolve(data)
                else:
                    for k, v in data.items():
                        ref._store[ref.id][k] = _resolve(v)
            self._db.batch_commits += 1


def _type_rank(value: Any) -> int:
    """Thứ tự kiểu của Firestore khi sắp xếp: null < bool < số < timestamp < chuỗi (chỉ phần các kiểu mà Backend dùng)."""
    if value is None:
        return 0
    if isinstance(value, bool):
        return 1
    if isinstance(value, (int, float)):
        return 2
    if isinstance(value, datetime):
        return 3
    if isinstance(value, str):
        return 4
    return 5


def _order_value(value: Any) -> tuple:
    if isinstance(value, datetime) and value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return (_type_rank(value), value)


class FakeQuery:
    """Mô phỏng Query của Firestore ở mức Backend dùng: where(==), order_by, start_after(dict), limit, stream.

    GIẢ ĐỊNH (theo tài liệu Firestore, chưa kiểm chứng với dịch vụ thật): `order_by(field)` loại các tài liệu KHÔNG có
    field đó; các kiểu khác nhau được so sánh theo thứ tự kiểu; `__name__` là ID tài liệu; `start_after` loại trừ đúng vị trí
    cursor; `limit` cắt SAU khi sắp xếp và áp cursor. `db.streamed` đếm số tài liệu thực sự được trả ra (để test chứng minh
    phân trang được đẩy xuống kho, không tải cả collection)."""

    def __init__(
        self,
        db: "FakeFirestore",
        collection: str,
        filters: tuple = (),
        limit: int | None = None,
        orders: tuple = (),
        cursor: dict[str, Any] | None = None,
    ) -> None:
        self._db = db
        self._collection = collection
        self._filters = filters
        self._limit = limit
        self._orders = orders
        self._cursor = cursor

    def _clone(self, **changes: Any) -> "FakeQuery":
        state = {"filters": self._filters, "limit": self._limit, "orders": self._orders, "cursor": self._cursor}
        state.update(changes)
        return FakeQuery(self._db, self._collection, **state)

    def where(self, *args: Any, filter: Any = None) -> "FakeQuery":  # noqa: A002 (đúng tên tham số của thư viện thật)
        field, op, value = (filter.field_path, filter.op_string, filter.value) if filter is not None else args
        assert op == "==", "stub chỉ hỗ trợ =="
        return self._clone(filters=self._filters + ((field, value),))

    def limit(self, n: int) -> "FakeQuery":
        return self._clone(limit=n)

    def order_by(self, field: str, direction: str = "ASCENDING") -> "FakeQuery":
        assert direction in ("ASCENDING", "DESCENDING"), f"hướng sắp xếp lạ: {direction!r}"
        return self._clone(orders=self._orders + ((field, direction),))

    def start_after(self, fields: dict[str, Any]) -> "FakeQuery":
        assert isinstance(fields, dict), "stub chỉ hỗ trợ cursor dạng dict"
        return self._clone(cursor=dict(fields))

    @staticmethod
    def _sort_key(doc_id: str, data: dict[str, Any], field: str) -> tuple:
        return (3, doc_id) if field == "__name__" else _order_value(_get_path(data, field))

    def _rows(self) -> list[tuple[str, dict[str, Any]]]:
        rows = [
            (doc_id, data)
            for doc_id, data in self._db.collections[self._collection].items()
            if all(_get_path(data, field) == value for field, value in self._filters)
        ]
        # Firestore loại tài liệu không có field dùng để sắp xếp (trừ __name__ luôn có).
        for field, _ in self._orders:
            if field != "__name__":
                rows = [(i, d) for i, d in rows if _get_path(d, field) is not _MISSING]
        for field, direction in reversed(self._orders):  # sắp xếp ổn định theo từng khóa, khóa đầu có ưu tiên cao nhất
            rows.sort(key=lambda row, f=field: self._sort_key(row[0], row[1], f), reverse=direction == "DESCENDING")
        if self._cursor is not None:
            keys = [field for field, _ in self._orders]
            missing = [k for k in keys if k not in self._cursor]
            assert self._orders and not missing, f"cursor thiếu giá trị cho {missing}"  # thư viện thật ném ValueError

            def after(doc_id: str, data: dict[str, Any]) -> bool:
                for field, direction in self._orders:
                    mine = self._sort_key(doc_id, data, field)
                    given = (3, self._cursor[field]) if field == "__name__" else _order_value(self._cursor[field])
                    if mine == given:
                        continue
                    return mine < given if direction == "DESCENDING" else mine > given
                return False  # đúng vị trí cursor => loại trừ (start_after)

            rows = [(i, d) for i, d in rows if after(i, d)]
        return rows

    def stream(self):
        self._db._tick("stream")
        self._db.queries.append(
            {"filters": self._filters, "orders": self._orders, "limit": self._limit, "cursor": self._cursor}
        )
        rows = self._rows()
        if self._limit is not None:
            rows = rows[: self._limit]
        for doc_id, data in rows:
            self._db.streamed += 1
            yield FakeSnapshot(doc_id, data)


class FakeCollection(FakeQuery):
    def document(self, doc_id: str) -> FakeDocumentRef:
        return FakeDocumentRef(self._db, self._collection, doc_id)


class FakeFirestore:
    """Hai collection: `images` và `cloudinaryAssets`. `fail_with` (nếu đặt) làm MỌI thao tác sau đó ném lỗi đó."""

    def __init__(self) -> None:
        self.collections: dict[str, dict[str, dict[str, Any]]] = {"images": {}, "cloudinaryAssets": {}}
        self.calls: list[str] = []
        self.batch_commits = 0
        self.fail_with: Exception | None = None
        self.queries: list[dict[str, Any]] = []  # mỗi lần stream(): bộ lọc, thứ tự, limit, cursor
        self.streamed = 0  # tổng số tài liệu mà các query đã trả ra
        self.lock = threading.RLock()

    @property
    def docs(self) -> dict[str, dict[str, Any]]:
        """Collection `images` (giữ tên cũ cho các test hiện có)."""
        return self.collections["images"]

    @property
    def assets(self) -> dict[str, dict[str, Any]]:
        return self.collections["cloudinaryAssets"]

    def _tick(self, name: str) -> None:
        self.calls.append(name)
        if self.fail_with is not None:
            raise self.fail_with

    def collection(self, name: str) -> FakeCollection:
        assert name in self.collections, f"collection lạ: '{name}'"
        return FakeCollection(self, name)

    def batch(self) -> FakeWriteBatch:
        return FakeWriteBatch(self)
