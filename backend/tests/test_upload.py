from fastapi.testclient import TestClient
from backend.app.main import app

client = TestClient(app)


def test_uc01_valid_file_upload_url():
    res = client.post(
        "/images/upload-url",
        headers={"Authorization": "Bearer token-user_A"},
        json={
            "filename": "avatar.png",
            "contentType": "image/png",
            "sizeBytes": 500_000,
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert "uploadUrl" in data
    assert data["image"]["ownerId"] == "user_A"
    # Kiểm tra chốt cứng tên field variants
    assert set(data["image"]["variants"].keys()) == {"thumbnail", "medium", "webp"}


def test_uc01_reject_invalid_extension():
    res = client.post(
        "/images/upload-url",
        headers={"Authorization": "Bearer token-user_A"},
        json={
            "filename": "malware.exe",
            "contentType": "application/x-msdownload",
            "sizeBytes": 1024,
        },
    )
    assert res.status_code == 400


def test_uc01_reject_oversize_file():
    res = client.post(
        "/images/upload-url",
        headers={"Authorization": "Bearer token-user_A"},
        json={
            "filename": "huge.jpg",
            "contentType": "image/jpeg",
            "sizeBytes": 11 * 1024 * 1024,  # 11MB > 10MB
        },
    )
    assert res.status_code == 400