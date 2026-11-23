"""Test POST /images/cloudinary/confirm theo CONTRACT.md mục 3 (bản Hybrid).

Dùng dữ liệu giả, kho RAM và token giả (conftest). Không gọi Firebase, Firestore hay Cloudinary thật.
"""
import pytest
from helpers import IMAGE_ID, IMAGE_ID_2, bearer, cloud_url, full_payload, minimal_payload

from app.repositories.image_repository import MemoryImageStore, image_repo

URL = "/images/cloudinary/confirm"
REQUIRED = ["imageId", "thumbnail", "medium", "webp", "originalSize", "processingMs"]


def post(client, payload, uid="user_A"):
    return client.post(URL, headers=bearer(uid), json=payload)


# ------------------------------------------------------------------ thành công
def test_confirm_minimal_six_required_fields(client):
    payload = minimal_payload()
    res = post(client, payload)

    assert res.status_code == 200
    body = res.json()
    assert set(body) == {"imageId", "status", "ownerId", "variants", "processingMs", "savedPercent"}
    assert body["imageId"] == IMAGE_ID
    assert body["status"] == "DONE"
    assert body["ownerId"] == "user_A"
    assert body["variants"] == {"thumbnail": payload["thumbnail"], "medium": payload["medium"], "webp": payload["webp"]}
    assert body["processingMs"] == 1840
    assert body["savedPercent"] is None  # không có processedSize => không bịa số


def test_confirm_all_seven_optional_fields_and_saved_percent(client, fresh_store):
    payload = full_payload()
    res = post(client, payload)

    assert res.status_code == 200
    body = res.json()
    assert body["variants"] == {
        "thumbnail": payload["thumbnail"], "thumbnailId": payload["thumbnailId"],
        "medium": payload["medium"], "mediumId": payload["mediumId"],
        "webp": payload["webp"], "webpId": payload["webpId"],
    }
    assert body["savedPercent"] == 83.2  # (1 - 412000/2457600) * 100, đúng ví dụ CONTRACT

    doc = fresh_store.get(IMAGE_ID)
    assert doc["ownerId"] == "user_A"
    assert doc["status"] == "DONE"
    assert doc["provider"] == "cloudinary"
    assert doc["fileName"] == "anh-bien.jpg"
    assert doc["original"] == {"size": 2457600, "width": 4000, "height": 3000}
    assert doc["variants"] == {"thumbnail": payload["thumbnail"], "medium": payload["medium"], "webp": payload["webp"]}
    assert doc["publicIds"] == {"thumbnail": payload["thumbnailId"], "medium": payload["mediumId"], "webp": payload["webpId"]}
    assert doc["previewUrl"] == payload["thumbnail"]
    assert doc["processedSize"] == 412000
    assert doc["processingMs"] == 1840
    assert doc["savedPercent"] == 83.2
    assert doc["retryCount"] == 0
    assert doc["errorReason"] is None
    assert doc["createdAt"] is not None and doc["updatedAt"] is not None


def test_optional_fields_missing_use_defaults(client, fresh_store):
    assert post(client, minimal_payload()).status_code == 200
    doc = fresh_store.get(IMAGE_ID)
    assert doc["fileName"] == IMAGE_ID  # mặc định khi thiếu fileName
    assert doc["original"] == {"size": 2457600, "width": None, "height": None}
    assert doc["publicIds"] == {}
    assert doc["processedSize"] is None and doc["savedPercent"] is None


def test_content_type_and_unknown_fields_are_ignored_not_stored(client, fresh_store):
    payload = minimal_payload()
    payload.update({"contentType": "image/jpeg", "foo": "bar"})
    assert post(client, payload).status_code == 200
    doc = fresh_store.get(IMAGE_ID)
    assert "contentType" not in doc and "foo" not in doc


def test_owner_comes_from_token_never_from_body(client, fresh_store):
    payload = minimal_payload()
    payload.update({"ownerId": "attacker", "uid": "attacker", "userId": "attacker"})
    res = post(client, payload, uid="user_A")
    assert res.status_code == 200
    assert res.json()["ownerId"] == "user_A"
    assert fresh_store.get(IMAGE_ID)["ownerId"] == "user_A"


def test_old_public_id_field_names_are_not_accepted(client):
    payload = {
        "imageId": IMAGE_ID, "fileName": "a.jpg", "originalSize": 1000, "processedSize": 100, "processingMs": 5,
        "thumbnailPublicId": "a", "mediumPublicId": "b", "webpPublicId": "c",
    }
    res = post(client, payload)
    assert res.status_code == 400
    assert res.json() == {"detail": "Missing field: thumbnail"}


@pytest.mark.parametrize("processed,original,expected", [(412000, 2457600, 83.2), (0, 1000, 100.0), (1, 3, 66.7), (1500, 1000, -50.0)])
def test_saved_percent_formula(client, processed, original, expected):
    payload = full_payload()
    payload.update({"processedSize": processed, "originalSize": original})
    res = post(client, payload)
    assert res.status_code == 200
    assert res.json()["savedPercent"] == expected  # công thức TEST-PLAN: (1 - processed/original) x 100, 1 chữ số lẻ, không cắt âm


def test_original_size_exactly_10mb_is_accepted(client):
    payload = minimal_payload()
    payload["originalSize"] = 10 * 1024 * 1024
    assert post(client, payload).status_code == 200


# ------------------------------------------------------------------ dữ liệu sai => 400
@pytest.mark.parametrize("name", REQUIRED)
def test_missing_required_field_returns_400(client, name):
    payload = minimal_payload()
    del payload[name]
    res = post(client, payload)
    assert res.status_code == 400
    assert res.json() == {"detail": f"Missing field: {name}"}


@pytest.mark.parametrize("name", REQUIRED)
def test_null_required_field_returns_400(client, name):
    payload = minimal_payload()
    payload[name] = None
    res = post(client, payload)
    assert res.status_code == 400
    assert res.json() == {"detail": f"Missing field: {name}"}


BAD_URLS = {
    "http": "http://res.cloudinary.com/test-cloud/image/upload/v1/a.webp",
    "other-host": "https://evil.example.com/test-cloud/image/upload/v1/a.webp",
    "host-suffix-trick": "https://res.cloudinary.com.evil.com/test-cloud/image/upload/v1/a.webp",
    "host-uppercase": "https://RES.cloudinary.com/test-cloud/image/upload/v1/a.webp",
    "wrong-cloud": "https://res.cloudinary.com/other-cloud/image/upload/v1/a.webp",
    "cloud-prefix-trick": "https://res.cloudinary.com/test-cloud-evil/image/upload/v1/a.webp",
    "video-resource": "https://res.cloudinary.com/test-cloud/video/upload/v1/a.webp",
    "query": cloud_url("a") + "?x=1",
    "fragment": cloud_url("a") + "#frag",
    "userinfo": "https://user:pw@res.cloudinary.com/test-cloud/image/upload/v1/a.webp",
    "port-8443": "https://res.cloudinary.com:8443/test-cloud/image/upload/v1/a.webp",
    "port-443": "https://res.cloudinary.com:443/test-cloud/image/upload/v1/a.webp",
    "traversal": "https://res.cloudinary.com/test-cloud/image/upload/../../x.webp",
    "empty-segment": "https://res.cloudinary.com/test-cloud/image/upload//a.webp",
    "no-resource": "https://res.cloudinary.com/test-cloud/image/upload/",
    "trailing-newline": cloud_url("a") + "\n",
    "embedded-newline": "https://res.cloudinary.com/test-cloud/image/upload/v1/a\nb.webp",
    "space": "https://res.cloudinary.com/test-cloud/image/upload/v1/a b.webp",
    "non-ascii": "https://res.cloudinary.com/test-cloud/image/upload/v1/ảnh.webp",
    "javascript": "javascript:alert(1)",
    "protocol-relative": "//res.cloudinary.com/test-cloud/image/upload/v1/a.webp",
    "empty": "",
    "number": 123,
    "list": ["x"],
    "too-long": cloud_url("a" * 3000),
}


@pytest.mark.parametrize("key", ["thumbnail", "medium", "webp"])
@pytest.mark.parametrize("label", list(BAD_URLS))
def test_invalid_cloudinary_url_returns_400(client, fresh_store, key, label):
    payload = minimal_payload()
    payload[key] = BAD_URLS[label]
    res = post(client, payload)
    assert res.status_code == 400, f"{key}/{label}"
    assert res.json() == {"detail": "Invalid cloudinary url"}
    assert fresh_store.get(IMAGE_ID) is None  # không ghi gì khi sai


def test_url_is_checked_against_configured_cloud_name(client, monkeypatch):
    from app.config import settings

    payload = minimal_payload()  # URL thuộc test-cloud
    monkeypatch.setattr(settings, "CLOUDINARY_CLOUD_NAME", "another-team-cloud")
    res = post(client, payload)
    assert res.status_code == 400 and res.json() == {"detail": "Invalid cloudinary url"}


def test_original_size_over_10mb_returns_file_too_large(client):
    payload = minimal_payload()
    payload["originalSize"] = 10 * 1024 * 1024 + 1
    res = post(client, payload)
    assert res.status_code == 400
    assert res.json() == {"detail": "File too large"}


@pytest.mark.parametrize("value", [0, -1, 1.5, "2457600", True, [1], {"a": 1}])
def test_invalid_original_size_returns_400(client, value):
    payload = minimal_payload()
    payload["originalSize"] = value
    res = post(client, payload)
    assert res.status_code == 400
    assert res.json() == {"detail": "Invalid originalSize"}


@pytest.mark.parametrize("value", [-1, "1840", True, [1], 3_600_001])
def test_invalid_processing_ms_returns_400(client, value):
    payload = minimal_payload()
    payload["processingMs"] = value
    res = post(client, payload)
    assert res.status_code == 400
    assert res.json() == {"detail": "Invalid processingMs"}


def test_non_finite_numbers_are_rejected(client):
    for literal, field, detail in [("NaN", "processingMs", "Invalid processingMs"), ("Infinity", "originalSize", "Invalid originalSize"), ("NaN", "originalSize", "Invalid originalSize")]:
        raw = ('{"imageId":"%s","thumbnail":"%s","medium":"%s","webp":"%s","originalSize":%s,"processingMs":%s}') % (
            IMAGE_ID, cloud_url("a1"), cloud_url("b2"), cloud_url("c3"),
            literal if field == "originalSize" else "100", literal if field == "processingMs" else "10",
        )
        res = client.post(URL, headers={**bearer("user_A"), "Content-Type": "application/json"}, content=raw)
        assert res.status_code == 400, f"{field}={literal}"
        assert res.json() == {"detail": detail}


@pytest.mark.parametrize("value", ["../x", "a/b", "short", "has space", "a" * 129, "id.with.dots1", "", 12345678, ["x"]])
def test_invalid_image_id_returns_400(client, value):
    payload = minimal_payload()
    payload["imageId"] = value
    res = post(client, payload)
    assert res.status_code == 400
    assert res.json()["detail"] in {"Invalid imageId", "Missing field: imageId"}


@pytest.mark.parametrize(
    "field,value,detail",
    [
        ("width", 0, "Invalid width"), ("width", -5, "Invalid width"), ("width", "4000", "Invalid width"),
        ("width", 1.5, "Invalid width"), ("width", True, "Invalid width"), ("width", 70000, "Invalid width"),
        ("height", 0, "Invalid height"), ("height", "3000", "Invalid height"),
        ("processedSize", -1, "Invalid processedSize"), ("processedSize", "1", "Invalid processedSize"),
        ("processedSize", 1.5, "Invalid processedSize"), ("processedSize", True, "Invalid processedSize"),
        ("fileName", 123, "Invalid fileName"), ("fileName", "", "Invalid fileName"),
        ("fileName", "   ", "Invalid fileName"), ("fileName", "x" * 256, "Invalid fileName"),
        ("thumbnailId", 5, "Invalid thumbnailId"), ("thumbnailId", "a/../b", "Invalid thumbnailId"),
        ("mediumId", "/abs", "Invalid mediumId"), ("webpId", "bad id", "Invalid webpId"),
    ],
)
def test_invalid_optional_fields_return_400(client, field, value, detail):
    payload = full_payload()
    payload[field] = value
    res = post(client, payload)
    assert res.status_code == 400, f"{field}={value!r}"
    assert res.json() == {"detail": detail}


def test_public_id_must_match_its_url(client):
    payload = full_payload()
    payload["thumbnailId"] = "somethingelse999"  # hợp lệ về dạng nhưng KHÔNG khớp URL thumbnail
    res = post(client, payload)
    assert res.status_code == 400
    assert res.json() == {"detail": "Invalid cloudinary url"}


def test_file_name_control_characters_are_stripped(client, fresh_store):
    payload = full_payload()
    payload["fileName"] = "an\x00h\nbien.jpg"
    assert post(client, payload).status_code == 200
    assert fresh_store.get(IMAGE_ID)["fileName"] == "anhbien.jpg"


@pytest.mark.parametrize("raw", [b"", b"{not json", b"\xff\xfe\x00", b"[]", b"123", b'"text"', b"null"])
def test_non_object_or_invalid_json_body_returns_400(client, raw):
    res = client.post(URL, headers={**bearer("user_A"), "Content-Type": "application/json"}, content=raw)
    assert res.status_code == 400
    assert res.json() == {"detail": "Invalid body"}


# ------------------------------------------------------------------ quyền sở hữu
def test_user_b_cannot_confirm_image_id_of_user_a(client, fresh_store):
    assert post(client, full_payload(), uid="user_A").status_code == 200
    before = fresh_store.get(IMAGE_ID)

    res = post(client, full_payload(suffix="B"), uid="user_B")

    assert res.status_code == 403
    assert res.json() == {"detail": "Forbidden"}
    assert "user_A" not in res.text and "user_B" not in res.text  # không lộ uid
    assert fresh_store.get(IMAGE_ID) == before  # bản ghi của A không bị đụng


def test_user_b_cannot_claim_an_asset_already_registered_by_user_a(client, fresh_store):
    assert post(client, full_payload(), uid="user_A").status_code == 200
    stolen = full_payload(image_id=IMAGE_ID_2)  # cùng URL của A nhưng imageId mới
    res = post(client, stolen, uid="user_B")
    assert res.status_code == 403
    assert res.json() == {"detail": "Forbidden"}
    assert fresh_store.get(IMAGE_ID_2) is None


def test_same_user_cannot_register_the_same_asset_under_another_image_id(client, fresh_store):
    assert post(client, full_payload(), uid="user_A").status_code == 200
    res = post(client, full_payload(image_id=IMAGE_ID_2), uid="user_A")
    assert res.status_code == 400
    assert res.json() == {"detail": "Invalid cloudinary url"}
    assert fresh_store.get(IMAGE_ID_2) is None


def test_two_users_with_different_assets_do_not_interfere(client, fresh_store):
    assert post(client, full_payload(IMAGE_ID, suffix="A"), uid="user_A").status_code == 200
    assert post(client, full_payload(IMAGE_ID_2, suffix="B"), uid="user_B").status_code == 200
    assert fresh_store.get(IMAGE_ID)["ownerId"] == "user_A"
    assert fresh_store.get(IMAGE_ID_2)["ownerId"] == "user_B"


# ------------------------------------------------------------------ idempotent
def test_confirm_same_image_id_again_returns_old_record_without_overwrite(client, fresh_store):
    first = post(client, full_payload())
    assert first.status_code == 200
    stored_before = fresh_store.get(IMAGE_ID)

    different = full_payload(suffix="Z")  # URL, kích thước, thời gian khác hẳn
    different.update({"processingMs": 99999, "processedSize": 1, "fileName": "khac.png", "width": 10, "height": 10})
    second = post(client, different)

    assert second.status_code == 200
    assert second.json() == first.json()  # trả đúng bản cũ
    assert fresh_store.get(IMAGE_ID) == stored_before  # không ghi đè bất kỳ field nào (kể cả updatedAt)
    assert len(fresh_store.list_by_owner("user_A")) == 1


def test_confirm_completes_an_existing_pending_record_of_the_same_owner(client, fresh_store):
    created = client.post(
        "/images/upload-url", headers=bearer("user_A"),
        json={"filename": "a.png", "contentType": "image/png", "sizeBytes": 1000},
    )
    assert created.status_code == 200
    image_id = created.json()["imageId"]
    pending = fresh_store.get(image_id)
    assert pending["status"] == "PENDING"

    res = post(client, full_payload(image_id=image_id))

    assert res.status_code == 200
    assert res.json()["status"] == "DONE"
    done = fresh_store.get(image_id)
    assert done["status"] == "DONE" and done["savedPercent"] == 83.2
    assert done["createdAt"] == pending["createdAt"]  # không đụng createdAt
    assert done["ownerId"] == "user_A"


def test_confirm_cannot_complete_a_pending_record_of_another_user(client, fresh_store):
    created = client.post(
        "/images/upload-url", headers=bearer("user_A"),
        json={"filename": "a.png", "contentType": "image/png", "sizeBytes": 1000},
    )
    image_id = created.json()["imageId"]
    res = post(client, full_payload(image_id=image_id), uid="user_B")
    assert res.status_code == 403 and res.json() == {"detail": "Forbidden"}
    assert fresh_store.get(image_id)["status"] == "PENDING"


class _StaleReadStore(MemoryImageStore):
    """Mô phỏng race: lần `get` đầu trả None dù bản ghi đã tồn tại (request khác vừa tạo xong)."""

    def __init__(self):
        super().__init__()
        self._first_get = True

    def get(self, image_id):
        if self._first_get:
            self._first_get = False
            return None
        return super().get(image_id)


@pytest.mark.parametrize("uid,expected", [("user_A", 200), ("user_B", 403)])
def test_race_between_check_and_create_never_overwrites(client, fresh_store, uid, expected):
    assert post(client, full_payload(), uid="user_A").status_code == 200
    original = fresh_store.get(IMAGE_ID)

    racy = _StaleReadStore()
    racy.save(original)
    image_repo.configure(racy)

    res = post(client, full_payload(suffix="Z"), uid=uid)

    assert res.status_code == expected
    assert racy.get(IMAGE_ID) == original  # `create` nguyên tử thất bại, không ghi đè


# ------------------------------------------------------------------ endpoint cũ không bị phá
def test_get_image_of_another_user_returns_forbidden_without_uid_leak(client):
    assert post(client, full_payload()).status_code == 200
    ok = client.get(f"/images/{IMAGE_ID}", headers=bearer("user_A"))
    assert ok.status_code == 200 and ok.json()["ownerId"] == "user_A"

    res = client.get(f"/images/{IMAGE_ID}", headers=bearer("user_B"))
    assert res.status_code == 403
    assert res.json() == {"detail": "Forbidden"}
    assert "user_A" not in res.text


def test_upload_url_still_works_with_bearer(client):
    res = client.post(
        "/images/upload-url", headers=bearer("user_A"),
        json={"filename": "avatar.png", "contentType": "image/png", "sizeBytes": 500_000},
    )
    assert res.status_code == 200
    assert res.json()["image"]["ownerId"] == "user_A"
