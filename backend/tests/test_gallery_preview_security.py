"""Hồi quy BE-FIX.2: rò rỉ quyền sở hữu ảnh ở GET /images và GET /images/preview/{id}.

Lỗi gốc của Gallery: `syncExternalImages` liệt kê CẢ CLOUD Cloudinary (prefix rỗng) khi user không có ảnh dưới
`uploads/<uid>`, gán mọi tài nguyên cho NGƯỜI GỌI và `image_repo.save()` ghi đè bản ghi theo imageId => ảnh của A hiện
trong gallery của B và bản ghi của A bị đổi chủ. Lỗi gốc của Preview: `uid` lấy từ query không xác thực.

Mọi dịch vụ ngoài (Cloudinary, Google Drive, Firestore) là stub/spy. Không gọi dịch vụ thật.
"""
import pytest
from fakes import SERVER_TS, FakeFirestore, ServiceUnavailable
from helpers import IMAGE_ID, bearer, full_payload

from app.exceptions import StorageUnavailableException, UnauthorizedException
from app.repositories.image_repository import FirestoreImageStore, MemoryImageStore, image_repo
from app.services.cloudinary_service import cloudinary_service
from app.services.google_drive import google_drive_service

pytestmark = pytest.mark.usefixtures("legacy_upload_compat")  # H4B-7B.2: các test này kiểm thử đường LEGACY; mặc định mới là "disabled" nên bật tương thích TƯỜNG MINH (xem conftest)

DRIVE_FILE = "drive-file-0001"


def drive_listing(file_id=DRIVE_FILE, name="a.png", stage="processed"):
    return {
        "driveFileId": file_id, "name": name, "mimeType": "image/png", "sizeBytes": 1234, "stage": stage,
        "status": {"upload": "PENDING", "processing": "PROCESSING", "processed": "DONE"}[stage],
        "webViewLink": "", "createdTime": "2026-01-01T00:00:00Z", "modifiedTime": "2026-01-02T00:00:00Z",
        "pipelineFolders": {"root": "r", "upload": "u", "processing": "p", "processed": "d"},
    }


class CloudSpy:
    """Thay cloudinary_service.list_images: ghi lại mọi lần gọi và trả về tài nguyên CỦA NGƯỜI KHÁC."""

    def __init__(self):
        self.calls = []

    def __call__(self, prefix=""):
        self.calls.append(prefix)
        return [
            {
                "publicId": "uploads/user_A/aaaaaaaa-1111-4222-8333-444444444444", "filename": "a.jpg", "mimeType": "image/jpeg",
                "sizeBytes": 10, "secureUrl": "https://res.cloudinary.com/test-cloud/image/upload/v1/x.jpg",
                "variants": {"thumbnail": "t", "medium": "m", "webp": "w"}, "createdAt": "2026-01-01T00:00:00Z",
            },
            {
                "publicId": "randomhybridpublicid1", "filename": "h.webp", "mimeType": "image/webp", "sizeBytes": 5,
                "secureUrl": "https://res.cloudinary.com/test-cloud/image/upload/v1/randomhybridpublicid1.webp",
                "variants": {"thumbnail": "t", "medium": "m", "webp": "w"}, "createdAt": "2026-01-01T00:00:00Z",
            },
        ]


@pytest.fixture
def cloud(monkeypatch):
    spy = CloudSpy()
    monkeypatch.setattr(cloudinary_service, "list_images", spy)
    return spy


@pytest.fixture
def drive(monkeypatch):
    """Drive giả: mỗi uid có danh sách file riêng; ghi lại ai tải file nào."""
    state = {"files": {}, "downloads": [], "mime": "image/png"}

    def list_all(uid, root_folder_id=None):
        result = state["files"].get(uid, [])
        if isinstance(result, Exception):
            raise result
        return result

    def download(uid, file_id):
        state["downloads"].append((uid, file_id))
        return b"\x89PNG-fake-bytes", state["mime"]

    monkeypatch.setattr(google_drive_service, "list_all_pipeline_images", list_all)
    monkeypatch.setattr(google_drive_service, "download_file_bytes", download)
    return state


def get_images(client, as_user, **query):
    """GET /images đăng nhập bằng `as_user`; `query` là tham số URL (để thử cả `uid=`, `ownerId=` do client tự khai)."""
    return client.get("/images", headers=bearer(as_user), params=query)


# ------------------------------------------------------------------ Gallery
def test_user_sees_own_confirmed_image(client, cloud, drive):
    assert client.post("/images/cloudinary/confirm", headers=bearer("user_A"), json=full_payload()).status_code == 200
    res = get_images(client, "user_A")
    assert res.status_code == 200
    assert [i["imageId"] for i in res.json()["items"]] == [IMAGE_ID]
    assert [i["ownerId"] for i in res.json()["items"]] == ["user_A"]
    assert res.json()["nextCursor"] is None and res.json()["hasMore"] is False  # CONTRACT mục 5 (INT-2)


def test_user_b_does_not_see_user_a_images(client, cloud, drive):
    assert client.post("/images/cloudinary/confirm", headers=bearer("user_A"), json=full_payload()).status_code == 200
    res = get_images(client, "user_B")
    assert res.status_code == 200
    assert res.json() == {"items": [], "nextCursor": None, "hasMore": False}  # gallery trống vẫn hoạt động


def test_get_images_never_scans_cloudinary(client, cloud, drive):
    for uid in ("user_A", "user_B"):  # kể cả user chưa có ảnh nào (đúng điều kiện từng kích hoạt quét cả cloud)
        res = get_images(client, uid)
        assert res.status_code == 200 and res.json()["items"] == []
    assert cloud.calls == []  # không gọi list_images dù với prefix nào


def test_cloudinary_resources_of_others_are_not_auto_claimed(client, cloud, drive, fresh_store):
    res = get_images(client, "user_B")
    assert res.json()["items"] == []
    assert fresh_store.list_by_owner("user_B") == []  # không tạo bản ghi nào cho B
    assert fresh_store.list_by_owner("user_A") == []


def test_legacy_image_id_collision_cannot_change_owner(client, cloud, drive, fresh_store, monkeypatch):
    """Tái hiện đúng lỗi cũ: bản ghi của A (luồng upload-url) có imageId trùng đoạn cuối public_id `uploads/user_A/<id>`."""
    created = client.post(
        "/images/upload-url", headers=bearer("user_A"),
        json={"filename": "a.jpg", "contentType": "image/jpeg", "sizeBytes": 1000},
    )
    image_id = created.json()["imageId"]
    original = fresh_store.get(image_id)

    # Cloudinary giả trả đúng tài nguyên `uploads/user_A/<imageId của A>`
    monkey_calls = []

    def listing(prefix=""):
        monkey_calls.append(prefix)
        return [{
            "publicId": f"uploads/user_A/{image_id}", "filename": "a.jpg", "mimeType": "image/jpeg", "sizeBytes": 1000,
            "secureUrl": "https://res.cloudinary.com/test-cloud/image/upload/v1/a.jpg",
            "variants": {"thumbnail": "t", "medium": "m", "webp": "w"}, "createdAt": "2026-01-01T00:00:00Z",
        }]

    monkeypatch.setattr(cloudinary_service, "list_images", listing)
    for _ in range(2):
        get_images(client, "user_B")
        client.post("/images/sync", headers=bearer("user_B"))

    assert monkey_calls == []
    assert fresh_store.get(image_id) == original  # không đổi chủ, không ghi đè bất kỳ field nào
    assert fresh_store.get(image_id)["ownerId"] == "user_A"
    assert fresh_store.list_by_owner("user_B") == []


def test_sync_endpoint_reports_no_cloudinary_import(client, cloud, drive):
    res = client.post("/images/sync", headers=bearer("user_B"))
    assert res.status_code == 200
    assert res.json()["sync"] == {"syncedFromGoogleDrive": 0, "syncedFromCloudinary": 0}
    assert cloud.calls == []


@pytest.mark.parametrize("params", [{"ownerId": "user_A"}, {"uid": "user_A"}, {"userId": "user_A"}, {"folderId": "x"}])
def test_owner_in_query_is_ignored(client, cloud, drive, params):
    client.post("/images/cloudinary/confirm", headers=bearer("user_A"), json=full_payload())
    res = get_images(client, "user_B", **params)
    assert res.status_code == 200
    assert res.json() == {"items": [], "nextCursor": None, "hasMore": False}  # B không có ảnh; tham số ownerId/uid bị bỏ qua


def test_foreign_docs_returned_by_store_are_filtered_out(client, cloud, drive, fresh_store):
    """Phòng thủ chồng lớp: dù kho trả nhầm bản ghi của người khác, API không đưa chúng cho người gọi."""
    class LeakyStore(MemoryImageStore):
        def list_by_owner(self, owner_id):
            return list(self._docs.values())  # cố ý trả TẤT CẢ

    leaky = LeakyStore()
    leaky.save({"imageId": "x1", "ownerId": "user_A", "status": "DONE"})
    leaky.save({"imageId": "x2", "ownerId": "user_B", "status": "DONE"})
    image_repo.configure(leaky)
    res = get_images(client, "user_B")
    assert [i["imageId"] for i in res.json()["items"]] == ["x2"]


@pytest.mark.parametrize("path,method", [("/images", "get"), ("/images/sync", "post"), (f"/images/preview/{DRIVE_FILE}", "get")])
def test_gallery_and_preview_require_bearer(client, cloud, drive, path, method):
    for headers in ({}, {"X-User-Id": "user_A"}):
        res = getattr(client, method)(path, headers=headers, params={"uid": "user_A"})
        assert res.status_code == 401
        assert res.json() == {"detail": "Missing token"}
    assert cloud.calls == [] and drive["downloads"] == []


# ------------------------------------------------------------------ Google Drive (luồng được giữ nguyên)
def test_drive_sync_registers_own_files_for_the_caller_only(client, cloud, drive, fresh_store):
    drive["files"]["user_A"] = [drive_listing()]

    res = get_images(client, "user_A")

    assert res.status_code == 200
    items = res.json()["items"]
    assert [i["imageId"] for i in items] == [f"drive_{DRIVE_FILE}"]
    assert items[0]["ownerId"] == "user_A" and items[0]["provider"] == "google_drive"
    assert get_images(client, "user_B").json()["items"] == []  # B không thấy ảnh Drive của A


def test_drive_sync_never_overwrites_a_record_owned_by_someone_else(client, cloud, drive, fresh_store):
    drive["files"]["user_A"] = [drive_listing()]
    get_images(client, "user_A")
    before = fresh_store.get(f"drive_{DRIVE_FILE}")

    drive["files"]["user_B"] = [drive_listing(name="b-doi-ten.png")]  # B (cấu hình sai) cũng "thấy" cùng file id
    res = get_images(client, "user_B")

    assert res.status_code == 200 and res.json()["items"] == []
    assert fresh_store.get(f"drive_{DRIVE_FILE}") == before
    assert fresh_store.get(f"drive_{DRIVE_FILE}")["ownerId"] == "user_A"


def test_drive_sync_is_idempotent_for_the_same_owner(client, cloud, drive, fresh_store):
    drive["files"]["user_A"] = [drive_listing()]
    first = client.post("/images/sync", headers=bearer("user_A")).json()
    second = client.post("/images/sync", headers=bearer("user_A")).json()
    assert first["sync"]["syncedFromGoogleDrive"] == 1
    assert second["sync"]["syncedFromGoogleDrive"] == 0
    assert second["total"] == 1


@pytest.mark.parametrize("failure", [UnauthorizedException("chưa liên kết Drive"), RuntimeError("Drive API lỗi")])
def test_drive_unavailable_is_skipped_but_own_images_still_listed(client, cloud, drive, failure):
    client.post("/images/cloudinary/confirm", headers=bearer("user_A"), json=full_payload())
    drive["files"]["user_A"] = failure
    res = get_images(client, "user_A")
    assert res.status_code == 200
    assert [i["imageId"] for i in res.json()["items"]] == [IMAGE_ID]


def test_storage_error_while_saving_drive_docs_is_not_swallowed(client, cloud, drive):
    class FailingCreate(MemoryImageStore):
        def create(self, doc):
            raise StorageUnavailableException()

    image_repo.configure(FailingCreate())
    drive["files"]["user_A"] = [drive_listing()]
    res = get_images(client, "user_A")
    assert res.status_code == 503  # không biến lỗi lưu trữ thành "thành công giả" với danh sách rỗng
    assert res.json() == {"detail": "Storage unavailable"}


def test_firestore_failure_is_503_not_an_empty_gallery(client, cloud, drive, fresh_store):
    db = FakeFirestore()
    image_repo.configure(FirestoreImageStore(lambda: db, server_timestamp=SERVER_TS))
    db.fail_with = ServiceUnavailable("chi tiết nội bộ bí mật")
    res = get_images(client, "user_A")
    assert res.status_code == 503
    assert res.json() == {"detail": "Storage unavailable"} and "bí mật" not in res.text


# ------------------------------------------------------------------ Preview
def _seed_drive_image(client, drive, owner="user_A"):
    drive["files"][owner] = [drive_listing()]
    assert get_images(client, owner).status_code == 200


def test_owner_can_preview_own_drive_image(client, cloud, drive):
    _seed_drive_image(client, drive)
    res = client.get(f"/images/preview/{DRIVE_FILE}", headers=bearer("user_A"))
    assert res.status_code == 200
    assert res.content == b"\x89PNG-fake-bytes" and res.headers["content-type"] == "image/png"
    assert res.headers["cache-control"] == "private, no-store" and res.headers["x-content-type-options"] == "nosniff"
    assert drive["downloads"] == [("user_A", DRIVE_FILE)]  # tải bằng credentials của CHÍNH người gọi


def test_other_user_cannot_preview_even_knowing_the_drive_file_id(client, cloud, drive):
    _seed_drive_image(client, drive)
    res = client.get(f"/images/preview/{DRIVE_FILE}", headers=bearer("user_B"))
    assert res.status_code == 403
    assert res.json() == {"detail": "Forbidden"}
    assert "user_A" not in res.text and "user_B" not in res.text  # không lộ ownerId
    assert drive["downloads"] == []  # chưa chạm tới Drive


def test_uid_in_query_cannot_impersonate_the_owner(client, cloud, drive):
    _seed_drive_image(client, drive)
    res = client.get(f"/images/preview/{DRIVE_FILE}", headers=bearer("user_B"), params={"uid": "user_A"})
    assert res.status_code == 403 and drive["downloads"] == []
    only_query = client.get(f"/images/preview/{DRIVE_FILE}", params={"uid": "user_A"})
    assert only_query.status_code == 401 and drive["downloads"] == []


def test_preview_of_unknown_file_is_404_without_touching_drive(client, cloud, drive):
    res = client.get("/images/preview/khong-co-ban-ghi", headers=bearer("user_A"))
    assert res.status_code == 404 and res.json() == {"detail": "Image not found"}
    assert drive["downloads"] == []


def test_preview_refuses_non_image_content(client, cloud, drive):
    _seed_drive_image(client, drive)
    drive["mime"] = "text/html"
    res = client.get(f"/images/preview/{DRIVE_FILE}", headers=bearer("user_A"))
    assert res.status_code == 400 and res.json() == {"detail": "Invalid file type"}
    assert b"fake-bytes" not in res.content


def test_preview_storage_failure_is_503(client, cloud, drive):
    db = FakeFirestore()
    image_repo.configure(FirestoreImageStore(lambda: db, server_timestamp=SERVER_TS))
    db.fail_with = ServiceUnavailable("x")
    res = client.get(f"/images/preview/{DRIVE_FILE}", headers=bearer("user_A"))
    assert res.status_code == 503 and drive["downloads"] == []


def test_preview_ownership_lookup_works_on_firestore_store(client, cloud, drive):
    db = FakeFirestore()
    image_repo.configure(FirestoreImageStore(lambda: db, server_timestamp=SERVER_TS))
    drive["files"]["user_A"] = [drive_listing()]
    assert get_images(client, "user_A").status_code == 200
    assert f"drive_{DRIVE_FILE}" in db.docs

    assert client.get(f"/images/preview/{DRIVE_FILE}", headers=bearer("user_A")).status_code == 200
    assert client.get(f"/images/preview/{DRIVE_FILE}", headers=bearer("user_B")).status_code == 403


# ------------------------------------------------------------------ không phá luồng hợp lệ
def test_confirmed_metadata_is_still_readable_from_firestore(client, cloud, drive):
    db = FakeFirestore()
    image_repo.configure(FirestoreImageStore(lambda: db, server_timestamp=SERVER_TS))
    assert client.post("/images/cloudinary/confirm", headers=bearer("user_A"), json=full_payload()).status_code == 200

    listed = get_images(client, "user_A").json()
    assert [i["imageId"] for i in listed["items"]] == [IMAGE_ID]
    assert get_images(client, "user_B").json()["items"] == []
    assert client.get(f"/images/{IMAGE_ID}", headers=bearer("user_A")).status_code == 200
    assert client.get(f"/images/{IMAGE_ID}", headers=bearer("user_B")).status_code == 403
    assert cloud.calls == []
