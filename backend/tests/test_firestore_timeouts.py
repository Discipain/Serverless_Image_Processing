"""INT-4C — ngân sách thời gian (timeout/retry) của FirestoreImageStore.

Bối cảnh: mặc định google-cloud-firestore khi kho không phản hồi chờ RẤT lâu (Commit/create ~60 s, get/query tới 300 s) trong khi Frontend
chỉ chờ 30 s. `FirestoreTimeouts` chặn thời gian MỖI lời gọi RPC: đọc retry có giới hạn, ghi KHÔNG retry. Các test này dùng FakeFirestore sẵn có,
bọc bằng `Probe` để (a) ghi lại tham số `retry`/`timeout` thực sự truyền cho từng RPC, (b) tiêm lỗi SDK thật (google.api_core.exceptions).

KHÔNG thay thế việc đo thời gian thật khi Emulator ngừng (xem báo cáo INT-4C): ở đây chỉ kiểm tra CÁCH code dùng API và hành vi lỗi.
"""
import copy
import math

import pytest
from fakes import SERVER_TS, FakeFirestore
from google.api_core import exceptions as gexc
from helpers import IMAGE_ID, IMAGE_ID_2, bearer, minimal_payload

from app.config import settings
from app.exceptions import StorageUnavailableException
from app.repositories.image_repository import (
    DEFAULT_FIRESTORE_TIMEOUTS,
    FirestoreImageStore,
    FirestoreTimeouts,
    ImageRepository,
    MemoryImageStore,
    image_repo,
)

pytestmark = pytest.mark.usefixtures("legacy_upload_compat")  # H4B-7B.2: các test này kiểm thử đường LEGACY; mặc định mới là "disabled" nên bật tương thích TƯỜNG MINH (xem conftest)

URL = "/images/cloudinary/confirm"
RPC_OPS = {"get", "create", "set", "update", "stream", "commit"}
SECRET = "SECRET-INTERNAL-DETAIL-do-not-leak"


class Probe:
    """Bọc đối tượng FakeFirestore: ghi tham số của từng RPC, tiêm lỗi, và bỏ tham số retry/timeout trước khi gọi stub (stub không nhận chúng)."""

    # Thao tác nào là RPC THẬT tùy loại đối tượng: batch.create/update chỉ gom cục bộ (không có RPC), chỉ batch.commit mới gọi mạng.
    RPC_BY_CLASS = {
        "FakeDocumentRef": {"get", "create", "set", "update"},
        "FakeWriteBatch": {"commit"},
        "FakeQuery": {"stream"},
        "FakeCollection": {"stream"},
    }

    def __init__(self, target, log, faults, after_apply):
        self._target, self._log, self._faults, self._after = target, log, faults, after_apply
        self._rpc = self.RPC_BY_CLASS.get(type(target).__name__, set())

    def __getattr__(self, name):
        attr = getattr(self._target, name)
        if name in self._rpc and callable(attr):
            def rpc(*args, **kwargs):
                self._log.append((name, dict(kwargs)))
                make = self._faults.get(name)
                if make is not None and name not in self._after:
                    raise make()  # lỗi TRƯỚC khi áp dụng: không ghi gì
                result = attr(*[a._target if isinstance(a, Probe) else a for a in args])
                if make is not None:  # "kết quả không rõ": đã áp dụng nhưng client nhận lỗi/timeout
                    raise make()
                return result
            return rpc
        if callable(attr):
            def passthrough(*args, **kwargs):
                result = attr(*[a._target if isinstance(a, Probe) else a for a in args], **kwargs)
                return Probe(result, self._log, self._faults, self._after) if type(result).__module__ == type(self._target).__module__ else result
            return passthrough
        return attr


class Harness:
    def __init__(self, timeouts):
        self.db = FakeFirestore()
        self.log: list[tuple[str, dict]] = []
        self.faults: dict = {}
        self.after_apply: set = set()
        self.store = FirestoreImageStore(
            lambda: Probe(self.db, self.log, self.faults, self.after_apply), server_timestamp=SERVER_TS, timeouts=timeouts
        )

    def calls(self, op):
        return [kw for name, kw in self.log if name == op]


@pytest.fixture
def h(fresh_store, monkeypatch):
    monkeypatch.setattr("app.services.image_service.google_drive_service.list_all_pipeline_images", lambda uid, root=None: [])
    harness = Harness(DEFAULT_FIRESTORE_TIMEOUTS)
    image_repo.configure(harness.store)
    return harness


def doc(image_id, owner="user_A", created=None):
    return {"imageId": image_id, "ownerId": owner, "status": "DONE", "provider": "cloudinary", "createdAt": created or "2026-01-01T00:00:00+00:00"}


def predicate_of(retry):
    return getattr(retry, "predicate", None) or retry._predicate


# ------------------------------------------------------------------ cấu hình FirestoreTimeouts
def test_timeouts_validate_inputs():
    for bad in (0, -1, math.nan, math.inf, True, "10", None, 61, 1e9):
        with pytest.raises(ValueError):
            FirestoreTimeouts(read_s=bad)
        with pytest.raises(ValueError):
            FirestoreTimeouts(write_s=bad)
    assert FirestoreTimeouts(read_s=0.5, write_s=60).write_s == 60


def test_default_budget_leaves_room_below_frontend_timeout():
    """Frontend chờ 30 s. Khi kho ngừng, RPC đầu tiên lỗi làm cả request dừng: thời gian ~ max(read, write), phải dưới 25 s."""
    assert DEFAULT_FIRESTORE_TIMEOUTS.read_s <= 12 and DEFAULT_FIRESTORE_TIMEOUTS.write_s <= 12
    assert max(DEFAULT_FIRESTORE_TIMEOUTS.read_s, DEFAULT_FIRESTORE_TIMEOUTS.write_s) * 2 < 25


def test_read_options_are_bounded_retry_with_sdk_transient_errors_only():
    opts = DEFAULT_FIRESTORE_TIMEOUTS.read_options()
    retry = opts["retry"]
    assert opts["timeout"] == DEFAULT_FIRESTORE_TIMEOUTS.read_s and retry.timeout == DEFAULT_FIRESTORE_TIMEOUTS.read_s  # tổng thời gian retry bị chặn
    for transient in (gexc.ServiceUnavailable("x"), gexc.DeadlineExceeded("x"), gexc.InternalServerError("x")):
        assert predicate_of(retry)(transient) is True
    for permanent in (gexc.Aborted("x"), gexc.AlreadyExists("x"), gexc.PermissionDenied("x"), gexc.NotFound("x"), gexc.InvalidArgument("x"), ValueError("x")):
        assert predicate_of(retry)(permanent) is False


def test_write_options_never_retry():
    opts = DEFAULT_FIRESTORE_TIMEOUTS.write_options()
    assert opts == {"retry": None, "timeout": DEFAULT_FIRESTORE_TIMEOUTS.write_s}


def test_production_wiring_uses_default_timeouts_lazily(monkeypatch):
    monkeypatch.setattr(settings, "IMAGE_STORE", "firestore")
    store = ImageRepository().store
    assert isinstance(store, FirestoreImageStore) and store._timeouts is DEFAULT_FIRESTORE_TIMEOUTS
    assert store._client is None  # khởi tạo lười: chưa tạo client, chưa chạm mạng


# ------------------------------------------------------------------ 1-4. Firestore hoạt động
def test_get_passes_read_options_and_returns_document(h):
    h.store.create(doc("img-a-0001"))
    assert h.store.get("img-a-0001")["ownerId"] == "user_A" and h.store.get("img-missing-1") is None
    gets = h.calls("get")
    assert len(gets) == 2 and all(set(k) == {"retry", "timeout"} and k["timeout"] == 10.0 and k["retry"] is not None for k in gets)


def test_create_passes_write_options_and_stays_atomic(h):
    assert h.store.create(doc("img-a-0001")) is True and h.store.create({**doc("img-a-0001"), "status": "FAILED"}) is False
    assert h.db.docs["img-a-0001"]["status"] == "DONE"  # create thứ hai không ghi đè
    assert all(kw == {"retry": None, "timeout": 10.0} for kw in h.calls("create"))


def test_paginated_query_uses_read_options_and_matches_memory_store_order(h):
    memory = MemoryImageStore()
    for i in range(25):
        d = doc(f"img-{i:04d}-xx", created=f"2026-01-01T00:00:{i % 7:02d}+00:00")
        assert h.store.create(d) and memory.create(copy.deepcopy(d))

    def walk(store):
        ids, after = [], None
        while True:
            page = store.list_page_by_owner("user_A", 10, after)
            ids += [x["imageId"] for x in page[:10]]
            if len(page) <= 10:
                return ids
            after = (page[9]["createdAt"], page[9]["imageId"])

    assert walk(h.store) == walk(memory) and len(set(walk(h.store))) == 25
    streams = h.calls("stream")
    assert streams and all(k["timeout"] == 10.0 and k["retry"] is not None for k in streams)
    assert [x["imageId"] for x in h.store.list_by_owner("user_A")] and h.store.find_by_drive_file_id("nope") == []


def test_batch_confirm_is_atomic_with_write_options(h, client):
    res = client.post(URL, headers=bearer("user_A"), json=minimal_payload())
    assert res.status_code == 200 and len(h.db.docs) == 1 and len(h.db.assets) == 3
    assert h.calls("commit") == [{"retry": None, "timeout": 10.0}]
    assert h.calls("get") and all(k["timeout"] == 10.0 for k in h.calls("get"))  # đọc get_by_id + asset dùng ngân sách đọc
    other = client.post(URL, headers=bearer("user_B"), json=minimal_payload(IMAGE_ID_2))  # cùng asset => bị từ chối
    assert other.status_code in (400, 403) and len(h.db.docs) == 1 and len(h.db.assets) == 3


# ------------------------------------------------------------------ 5-9. Firestore ngừng / lỗi
FAULTS = {
    "ServiceUnavailable": lambda: gexc.ServiceUnavailable(SECRET),
    "DeadlineExceeded": lambda: gexc.DeadlineExceeded(SECRET),
    "Aborted": lambda: gexc.Aborted(SECRET),
    "RetryError": lambda: gexc.RetryError(f"Deadline of 10.0s exceeded while calling target function: {SECRET}", gexc.ServiceUnavailable(SECRET)),
}
STORE_OPS = {
    "get": lambda s: s.get("img-a-0001"),
    "create": lambda s: s.create(doc("img-a-0001")),
    "save": lambda s: s.save(doc("img-a-0001")),
    "update": lambda s: s.update("img-a-0001", {"status": "FAILED"}),
    "list_by_owner": lambda s: s.list_by_owner("user_A"),
    "list_page_by_owner": lambda s: s.list_page_by_owner("user_A", 20),
    "find_by_drive_file_id": lambda s: s.find_by_drive_file_id("f1"),
    "get_asset_claims": lambda s: s.get_asset_claims(["k1", "k2"]),
    "create_with_assets": lambda s: s.create_with_assets(doc("img-a-0001"), {"k1": {"imageId": "img-a-0001"}}),
    "update_with_assets": lambda s: s.update_with_assets("img-a-0001", {"status": "DONE"}, {"k1": {"imageId": "img-a-0001"}}),
}


@pytest.mark.parametrize("fault", list(FAULTS))
@pytest.mark.parametrize("op", list(STORE_OPS))
def test_every_store_operation_turns_firestore_failure_into_503_without_leaking(h, fault, op):
    h.store.create(doc("img-a-0001"))  # có sẵn một ảnh để các thao tác update/get có đối tượng
    for rpc in RPC_OPS:
        h.faults[rpc] = FAULTS[fault]
    with pytest.raises(StorageUnavailableException) as exc:
        STORE_OPS[op](h.store)
    assert exc.value.status_code == 503 and exc.value.detail == "Storage unavailable" and SECRET not in str(exc.value.detail)


@pytest.mark.parametrize("fault", list(FAULTS))
def test_http_list_get_and_confirm_return_503_never_empty_list(h, client, fault):
    h.store.create(doc(IMAGE_ID))
    for rpc in RPC_OPS:
        h.faults[rpc] = FAULTS[fault]
    first = client.get("/images?limit=20", headers=bearer("user_A"))
    one = client.get(f"/images/{IMAGE_ID}", headers=bearer("user_A"))
    conf = client.post(URL, headers=bearer("user_A"), json=minimal_payload(IMAGE_ID_2))
    for res in (first, one, conf):
        assert res.status_code == 503 and res.json() == {"detail": "Storage unavailable"} and SECRET not in res.text
    assert "items" not in first.json()  # KHÔNG phải danh sách rỗng giả


# ------------------------------------------------------------------ 10-11. Không lặp ghi, không dở dang
@pytest.mark.parametrize("fault", list(FAULTS))
def test_failed_writes_are_attempted_exactly_once_by_the_store(h, fault):
    for rpc in ("create", "set", "update", "commit"):
        h.faults[rpc] = FAULTS[fault]
    for name in ("create", "save", "update", "create_with_assets", "update_with_assets"):
        with pytest.raises(StorageUnavailableException):
            STORE_OPS[name](h.store)
    for rpc, expected in (("create", 1), ("set", 1), ("update", 1), ("commit", 2)):
        assert len(h.calls(rpc)) == expected, f"{rpc} bị lặp ghi"
    assert all(kw["retry"] is None for rpc in ("create", "set", "update", "commit") for kw in h.calls(rpc))  # không có retry tự động cho ghi
    assert h.db.docs == {} and h.db.assets == {}


def test_confirm_timeout_before_commit_leaves_nothing_then_retry_succeeds(h, client):
    h.faults["commit"] = FAULTS["DeadlineExceeded"]
    res = client.post(URL, headers=bearer("user_A"), json=minimal_payload())
    assert res.status_code == 503 and h.db.docs == {} and h.db.assets == {} and len(h.calls("commit")) == 1
    h.faults.clear()
    ok = client.post(URL, headers=bearer("user_A"), json=minimal_payload())
    assert ok.status_code == 200 and len(h.db.docs) == 1 and len(h.db.assets) == 3


def test_confirm_with_unknown_commit_outcome_is_recovered_by_idempotent_retry_without_duplicates(h, client):
    """Commit ĐÃ được áp dụng nhưng client nhận DeadlineExceeded (không biết kết quả). Gọi lại confirm phải trả bản cũ, không nhân đôi, không đổi chủ."""
    h.faults["commit"] = FAULTS["DeadlineExceeded"]
    h.after_apply.add("commit")
    first = client.post(URL, headers=bearer("user_A"), json=minimal_payload())
    assert first.status_code == 503 and len(h.db.docs) == 1 and len(h.db.assets) == 3  # đã ghi thật
    h.faults.clear()
    again = client.post(URL, headers=bearer("user_A"), json=minimal_payload())
    assert again.status_code == 200 and again.json()["imageId"] == IMAGE_ID and again.json()["ownerId"] == "user_A"
    assert len(h.db.docs) == 1 and len(h.db.assets) == 3
    thief = client.post(URL, headers=bearer("user_B"), json=minimal_payload(IMAGE_ID_2))  # tranh chấp quyền sở hữu KHÔNG thành công giả
    assert thief.status_code == 403 and len(h.db.docs) == 1
    stolen_id = client.post(URL, headers=bearer("user_B"), json=minimal_payload(IMAGE_ID))
    assert stolen_id.status_code == 403 and h.db.docs[IMAGE_ID]["ownerId"] == "user_A"


def test_reads_are_not_repeated_by_the_store_itself(h):
    h.faults["get"] = FAULTS["ServiceUnavailable"]
    h.faults["stream"] = FAULTS["ServiceUnavailable"]
    with pytest.raises(StorageUnavailableException):
        h.store.get("img-a-0001")
    with pytest.raises(StorageUnavailableException):
        h.store.list_page_by_owner("user_A", 20)
    assert len(h.calls("get")) == 1 and len(h.calls("stream")) == 1  # retry (nếu có) nằm TRONG SDK theo ngân sách đã chặn, không lặp ở store


# ------------------------------------------------------------------ 12. Tương thích
def test_default_store_without_timeouts_keeps_old_call_signatures_for_stubs(fresh_store):
    """timeouts=None (mặc định): KHÔNG truyền retry/timeout => FakeFirestore (chữ ký cũ) và các test cũ vẫn chạy."""
    log: list = []
    store = FirestoreImageStore(lambda: Probe(FakeFirestore(), log, {}, set()), server_timestamp=SERVER_TS)
    assert store._timeouts is None
    store.create(doc("img-a-0001"))
    assert store.get("img-a-0001")["ownerId"] == "user_A" and store.list_page_by_owner("user_A", 5)
    assert log and all(kw == {} for _, kw in log)
    plain = FirestoreImageStore(lambda: FakeFirestore(), server_timestamp=SERVER_TS)  # không qua Probe: stub thật sự không nhận kwargs
    assert plain.create(doc("img-b-0001")) and plain.get("img-b-0001") is not None


def test_memory_store_is_untouched_by_the_timeout_policy():
    memory = MemoryImageStore()
    assert memory.create(doc("img-m-0001")) and memory.get("img-m-0001")["ownerId"] == "user_A" and not hasattr(memory, "_timeouts")
