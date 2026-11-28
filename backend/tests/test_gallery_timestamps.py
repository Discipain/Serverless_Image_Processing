"""INT-2.1: `createdAt`/`updatedAt` cùng kiểu (datetime UTC có múi giờ) ở mọi đường ghi metadata, để Gallery sắp xếp đúng
giữa ảnh Google Drive, ảnh upload-url và ảnh Cloudinary (confirm).

Chạy trên kho RAM và `FirestoreImageStore` + Firestore stub. Drive và Cloudinary là stub/spy; không gọi dịch vụ thật.
Dữ liệu CŨ (createdAt dạng chuỗi đã nằm trong Firestore) KHÔNG được sửa ở đây: xem test `test_existing_records_are_never_rewritten`.
"""
import logging
from datetime import datetime, timedelta, timezone

import pytest
from fakes import SERVER_TS, FakeFirestore
from helpers import bearer, full_payload

from app.repositories.image_repository import FirestoreImageStore, MemoryImageStore, image_repo
from app.services.cloudinary_service import cloudinary_service
from app.services.google_drive import google_drive_service
from app.services.image_service import parse_timestamp_utc

pytestmark = pytest.mark.usefixtures("legacy_upload_compat")  # H4B-7B.2: các test này kiểm thử đường LEGACY; mặc định mới là "disabled" nên bật tương thích TƯỜNG MINH (xem conftest)

UTC = timezone.utc


# ------------------------------------------------------------------ hạ tầng
@pytest.fixture(params=["memory", "firestore"])
def store(request):
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
def drive(monkeypatch):
    """Drive giả: `drive["files"][uid]` là danh sách file (đúng định dạng google_drive.list_all_pipeline_images)."""
    state = {"files": {}}
    monkeypatch.setattr(google_drive_service, "list_all_pipeline_images", lambda uid, root_folder_id=None: state["files"].get(uid, []))
    monkeypatch.setattr(cloudinary_service, "list_images", lambda prefix="": [])
    return state


def drive_file(file_id, created="2026-01-01T00:00:00Z", modified="2026-01-02T00:00:00Z", **extra):
    listing = {
        "driveFileId": file_id, "name": f"{file_id}.png", "mimeType": "image/png", "sizeBytes": 10, "stage": "processed",
        "status": "DONE", "webViewLink": "", "createdTime": created, "modifiedTime": modified,
        "pipelineFolders": {"root": "r", "upload": "u", "processing": "p", "processed": "d"},
    }
    listing.update(extra)
    return listing


def cloud_doc(owner, n, created):
    """Bản ghi như `confirm` tạo ra: createdAt/updatedAt là datetime (server timestamp)."""
    return {"imageId": f"cld-{owner}-{n:04d}", "ownerId": owner, "status": "DONE", "provider": "cloudinary", "createdAt": created, "updatedAt": created}


def get(client, uid, **params):
    return client.get("/images", headers=bearer(uid), params={k: v for k, v in params.items() if v is not None})


def walk_ids(client, uid, limit):
    cursor, out = None, []
    for _ in range(60):
        body = get(client, uid, limit=limit, cursor=cursor).json()
        out += [i["imageId"] for i in body["items"]]
        if not body["hasMore"]:
            return out
        cursor = body["nextCursor"]
    raise AssertionError("phân trang không kết thúc")


def is_utc_datetime(value):
    return isinstance(value, datetime) and value.tzinfo is not None and value.utcoffset() == timedelta(0)


# ------------------------------------------------------------------ parse_timestamp_utc
@pytest.mark.parametrize(
    "raw,expected",
    [
        ("2026-01-02T03:04:05Z", datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)),
        ("2026-01-02T03:04:05.678Z", datetime(2026, 1, 2, 3, 4, 5, 678000, tzinfo=UTC)),
        ("2026-01-02T03:04:05.123456Z", datetime(2026, 1, 2, 3, 4, 5, 123456, tzinfo=UTC)),
        ("2026-01-02T03:04:05.123456789Z", datetime(2026, 1, 2, 3, 4, 5, 123456, tzinfo=UTC)),  # cắt tới micro giây
        ("2026-01-02T10:04:05+07:00", datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)),
        ("2026-01-02T10:04:05+0700", datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)),
        ("2026-01-01T22:34:05-05:30", datetime(2026, 1, 2, 4, 4, 5, tzinfo=UTC)),
        ("2026-01-02t03:04:05z", datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)),
        ("  2026-01-02T03:04:05Z  ", datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)),
        ("2026-01-02T03:04:05+00:00", datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)),
        (datetime(2026, 1, 2, 10, 4, 5, tzinfo=timezone(timedelta(hours=7))), datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)),
    ],
)
def test_parse_timestamp_converts_any_offset_to_utc(raw, expected):
    parsed = parse_timestamp_utc(raw)
    assert parsed == expected and is_utc_datetime(parsed)


@pytest.mark.parametrize(
    "raw",
    [
        None, "", "   ", 0, 1.5, [], {}, b"2026-01-02T03:04:05Z", True,
        "hôm qua", "2026-01-02", "2026-01-02 03:04", "2026-01-02T03:04:05",  # không có múi giờ => mơ hồ => từ chối
        "2026-13-01T00:00:00Z", "2026-02-30T00:00:00Z", "2026-01-02T24:00:00Z", "2026-01-02T00:60:00Z", "2026-01-02T00:00:61Z",
        "2026-01-02T03:04:05+24:00", "2026-01-02T03:04:05+07:60", "0000-01-01T00:00:00Z",
        "9999-12-31T23:59:59-01:00",  # đổi sang UTC bị tràn năm 9999
        "2026-01-02T03:04:05Z extra", "x2026-01-02T03:04:05Z", "２０２６-01-02T03:04:05Z",  # chữ số Unicode
        "2026-01-02T03:04:05.Z", "2026-01-02T03:04:05.1234567890Z",
        datetime(2026, 1, 2, 3, 4, 5),  # datetime không có múi giờ
    ],
)
def test_parse_timestamp_rejects_missing_ambiguous_or_malformed_values(raw):
    assert parse_timestamp_utc(raw) is None


# ------------------------------------------------------------------ Drive
def test_new_drive_images_get_utc_datetimes_and_all_offsets_collapse_to_the_same_instant(client, store, drive):
    drive["files"]["user_A"] = [
        drive_file("fileZ", created="2026-01-01T00:00:00Z", modified="2026-01-03T00:00:00.500Z"),
        drive_file("file7", created="2026-01-01T07:00:00+07:00", modified="2026-01-03T05:30:00+05:30"),
    ]
    assert get(client, "user_A").status_code == 200
    z, p = store.get("drive_fileZ"), store.get("drive_file7")
    for d in (z, p):
        assert is_utc_datetime(d["createdAt"]) and is_utc_datetime(d["updatedAt"])
        assert "createdAtEstimated" not in d
    assert z["createdAt"] == p["createdAt"] == datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)
    assert z["updatedAt"] == datetime(2026, 1, 3, 0, 0, 0, 500000, tzinfo=UTC)
    assert p["updatedAt"] == datetime(2026, 1, 3, 0, 0, 0, tzinfo=UTC)


def test_drive_sync_changes_nothing_else_about_the_record(client, store, drive):
    drive["files"]["user_A"] = [drive_file("abc")]
    get(client, "user_A")
    d = store.get("drive_abc")
    assert d["imageId"] == "drive_abc" and d["ownerId"] == "user_A" and d["provider"] == "google_drive"
    assert d["status"] == "DONE" and d["previewUrl"] == "/images/preview/abc"
    assert d["variants"] == {"thumbnail": "/images/preview/abc", "medium": "/images/preview/abc", "webp": "/images/preview/abc"}


@pytest.mark.parametrize("bad", [None, "", "hôm qua", "2026-01-01T00:00:00", "2026-02-30T00:00:00Z", 12345])
def test_invalid_or_missing_drive_created_time_falls_back_to_sync_time_and_is_marked_and_logged(client, store, drive, caplog, bad):
    drive["files"]["user_A"] = [drive_file("zzz", created=bad, modified="2026-01-02T00:00:00Z")]
    before = datetime.now(UTC) - timedelta(seconds=2)
    with caplog.at_level(logging.WARNING, logger="app.services.image_service"):
        assert get(client, "user_A").status_code == 200
    after = datetime.now(UTC) + timedelta(seconds=2)
    d = store.get("drive_zzz")
    assert is_utc_datetime(d["createdAt"]) and before <= d["createdAt"] <= after  # thời điểm đồng bộ
    assert d["createdAtEstimated"] is True  # ghi nhận: đây KHÔNG phải thời gian thật của ảnh
    assert d["updatedAt"] == datetime(2026, 1, 2, tzinfo=UTC)  # modifiedTime hợp lệ vẫn được dùng
    assert any("createdTime" in r.message and "drive_zzz" in r.message for r in caplog.records)  # có ghi log, không lộ tên file


@pytest.mark.parametrize("modified,expect_warning", [(None, False), ("rác", True), ("2026-01-02T00:00:00", True)])
def test_invalid_or_missing_modified_time_uses_created_at(client, store, drive, caplog, modified, expect_warning):
    drive["files"]["user_A"] = [drive_file("mmm", created="2026-01-01T00:00:00Z", modified=modified)]
    with caplog.at_level(logging.WARNING, logger="app.services.image_service"):
        get(client, "user_A")
    d = store.get("drive_mmm")
    assert d["createdAt"] == d["updatedAt"] == datetime(2026, 1, 1, tzinfo=UTC) and "createdAtEstimated" not in d
    assert any("modifiedTime" in r.message for r in caplog.records) is expect_warning


def test_existing_records_are_never_rewritten_by_sync(client, store, drive):
    """Không migration/backfill: bản ghi Drive đã có (kể cả createdAt dạng chuỗi cũ) giữ nguyên khi đồng bộ lại."""
    legacy = {"imageId": "drive_old", "ownerId": "user_A", "provider": "google_drive", "status": "DONE",
              "createdAt": "2025-05-05T05:05:05Z", "updatedAt": "2025-05-06T05:05:05Z"}
    store.save(dict(legacy))
    drive["files"]["user_A"] = [drive_file("old", created="2026-01-01T00:00:00Z")]
    get(client, "user_A")
    assert store.get("drive_old") == legacy


# ------------------------------------------------------------------ upload-url cũ
def test_upload_url_records_are_utc_datetimes(client, store, drive):
    before = datetime.now(UTC) - timedelta(seconds=2)
    res = client.post("/images/upload-url", headers=bearer("user_A"), json={"filename": "a.jpg", "contentType": "image/jpeg", "sizeBytes": 1000})
    assert res.status_code == 200
    saved = store.get(res.json()["imageId"])
    assert is_utc_datetime(saved["createdAt"]) and is_utc_datetime(saved["updatedAt"])
    assert saved["createdAt"] == saved["updatedAt"] and before <= saved["createdAt"] <= datetime.now(UTC) + timedelta(seconds=2)
    assert saved["ownerId"] == "user_A" and saved["status"] == "PENDING"
    # Response JSON vẫn là chuỗi ISO có múi giờ, parse lại được về đúng thời điểm đã lưu.
    echoed = parse_timestamp_utc(res.json()["image"]["createdAt"])
    assert echoed == saved["createdAt"]


# ------------------------------------------------------------------ Hybrid confirm
def test_confirm_still_stores_aware_timestamps(client, store, drive):
    before = datetime.now(UTC) - timedelta(seconds=2)
    payload = full_payload()
    assert client.post("/images/cloudinary/confirm", headers=bearer("user_A"), json=payload).status_code == 200
    saved = store.get(payload["imageId"])
    assert is_utc_datetime(saved["createdAt"]) and is_utc_datetime(saved["updatedAt"])
    assert before <= saved["createdAt"] <= datetime.now(UTC) + timedelta(seconds=2)
    assert saved["status"] == "DONE" and saved["ownerId"] == "user_A"  # confirm không bị ảnh hưởng


def test_confirm_completing_a_pending_upload_url_record_keeps_created_at(client, store, drive):
    """Bản ghi PENDING do upload-url (createdAt là datetime) được confirm hoàn tất: createdAt giữ nguyên, updatedAt mới."""
    payload = full_payload()
    store.save({"imageId": payload["imageId"], "ownerId": "user_A", "status": "PENDING", "retryCount": 1,
                "createdAt": datetime(2026, 1, 1, tzinfo=UTC), "updatedAt": datetime(2026, 1, 1, tzinfo=UTC)})
    assert client.post("/images/cloudinary/confirm", headers=bearer("user_A"), json=payload).status_code == 200
    saved = store.get(payload["imageId"])
    assert saved["createdAt"] == datetime(2026, 1, 1, tzinfo=UTC) and saved["status"] == "DONE"
    assert is_utc_datetime(saved["updatedAt"]) and saved["updatedAt"] > saved["createdAt"]


# ------------------------------------------------------------------ sắp xếp Drive + Cloudinary
def test_newer_drive_image_is_listed_before_older_cloudinary_image(client, store, drive):
    store.save(cloud_doc("user_A", 1, datetime(2026, 3, 1, tzinfo=UTC)))
    drive["files"]["user_A"] = [drive_file("newer", created="2026-04-01T00:00:00Z")]
    res = get(client, "user_A").json()
    assert [i["imageId"] for i in res["items"]] == ["drive_newer", "cld-user_A-0001"]


def test_newer_cloudinary_image_is_listed_before_older_drive_image(client, store, drive):
    store.save(cloud_doc("user_A", 1, datetime(2026, 3, 1, tzinfo=UTC)))
    drive["files"]["user_A"] = [drive_file("older", created="2026-02-01T00:00:00Z")]
    res = get(client, "user_A").json()
    assert [i["imageId"] for i in res["items"]] == ["cld-user_A-0001", "drive_older"]


def test_interleaved_drive_and_cloudinary_images_follow_one_timeline_across_pages(client, store, drive):
    base = datetime(2026, 5, 1, tzinfo=UTC)
    expected = []
    drive_files = []
    for n in range(10):  # chẵn: Drive, lẻ: Cloudinary; đều tăng theo ngày
        when = base + timedelta(days=n)
        if n % 2 == 0:
            drive_files.append(drive_file(f"d{n:02d}", created=when.strftime("%Y-%m-%dT%H:%M:%SZ")))
            expected.append(f"drive_d{n:02d}")
        else:
            store.save(cloud_doc("user_A", n, when))
            expected.append(f"cld-user_A-{n:04d}")
    drive["files"]["user_A"] = drive_files
    for limit in ("1", "3", "4", None):
        assert walk_ids(client, "user_A", limit) == list(reversed(expected)), f"limit={limit}"


def test_ordering_follows_the_utc_instant_not_the_text_of_the_offset(client, store, drive):
    drive["files"]["user_A"] = [
        drive_file("tokyo", created="2026-01-01T23:00:00+07:00"),  # = 16:00Z
        drive_file("utc", created="2026-01-01T20:00:00Z"),  # muộn hơn, dù chuỗi "đứng trước" khi so sánh văn bản
        drive_file("west", created="2026-01-01T09:00:00-08:00"),  # = 17:00Z
    ]
    assert [i["imageId"] for i in get(client, "user_A").json()["items"]] == ["drive_utc", "drive_west", "drive_tokyo"]


def test_equal_created_at_across_sources_paginates_without_repeat_or_loss(client, store, drive):
    same = datetime(2026, 6, 1, 12, 0, 0, tzinfo=UTC)
    drive["files"]["user_A"] = [drive_file(f"s{n}", created="2026-06-01T12:00:00Z") for n in range(5)]
    seeded = [f"drive_s{n}" for n in range(5)]
    for n in range(5):
        store.save(cloud_doc("user_A", n, same))
        seeded.append(f"cld-user_A-{n:04d}")
    for limit in ("1", "2", "3", "7", "10"):
        flat = walk_ids(client, "user_A", limit)
        assert sorted(flat) == sorted(seeded) and len(set(flat)) == 10, f"limit={limit}"
        assert flat == sorted(seeded, reverse=True)  # khóa phụ imageId: thứ tự cố định


def test_cursor_keeps_working_after_a_mixed_source_page_and_stays_in_one_users_data(client, store, drive):
    drive["files"]["user_A"] = [drive_file(f"a{n}", created=f"2026-02-0{n + 1}T00:00:00Z") for n in range(4)]
    drive["files"]["user_B"] = [drive_file(f"b{n}", created=f"2026-02-0{n + 1}T00:00:00Z") for n in range(4)]
    for n in range(4):
        store.save(cloud_doc("user_A", n, datetime(2026, 2, 1, 12, tzinfo=UTC) + timedelta(days=n)))
    first = get(client, "user_A", limit="3").json()
    second = get(client, "user_A", limit="3", cursor=first["nextCursor"]).json()
    ids = [i["imageId"] for i in first["items"] + second["items"]]
    assert len(set(ids)) == len(ids) and all(i.startswith(("drive_a", "cld-user_A")) for i in ids)
    assert get(client, "user_B", cursor=first["nextCursor"]).status_code == 400  # cursor của A vẫn không dùng được cho B
    assert all(i["ownerId"] == "user_A" for i in first["items"] + second["items"])


def test_all_new_writers_produce_the_same_timestamp_type(client, store, drive):
    drive["files"]["user_A"] = [drive_file("t1")]
    get(client, "user_A")
    upload = client.post("/images/upload-url", headers=bearer("user_A"), json={"filename": "a.jpg", "contentType": "image/jpeg", "sizeBytes": 5})
    payload = full_payload()
    client.post("/images/cloudinary/confirm", headers=bearer("user_A"), json=payload)
    docs = [store.get("drive_t1"), store.get(upload.json()["imageId"]), store.get(payload["imageId"])]
    kinds = {(type(d["createdAt"]).__name__, type(d["updatedAt"]).__name__) for d in docs}
    assert kinds == {("datetime", "datetime")} and all(is_utc_datetime(d["createdAt"]) and is_utc_datetime(d["updatedAt"]) for d in docs)
