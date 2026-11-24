from fastapi.testclient import TestClient
from backend.app.main import app
import pytest

client = TestClient(app)


@pytest.mark.usefixtures("legacy_upload_compat")  # H4B-7B.2: đường LEGACY phải được bật tường minh (mặc định mới là "disabled")
def test_user_a_cannot_read_user_b_image_returns_403():
    # 1. User B tạo ảnh
    create_res = client.post(
        "/images/upload-url",
        headers={"Authorization": "Bearer token-user_B"},
        json={
            "filename": "secret_b.webp",
            "contentType": "image/webp",
            "sizeBytes": 10240,
        },
    )
    assert create_res.status_code == 200
    image_id_of_b = create_res.json()["image"]["imageId"]

    # 2. User B tự đọc ảnh của mình -> 200 OK
    owner_res = client.get(
        f"/images/{image_id_of_b}",
        headers={"Authorization": "Bearer token-user_B"},
    )
    assert owner_res.status_code == 200

    # 3. User A cố tình đọc trộm ảnh của User B -> 403 Forbidden
    intruder_res = client.get(
        f"/images/{image_id_of_b}",
        headers={"Authorization": "Bearer token-user_A"},
    )
    assert intruder_res.status_code == 403