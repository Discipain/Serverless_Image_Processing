"""Cấu hình pytest cho Backend.

Test KHÔNG cần credential Firebase và KHÔNG gọi dịch vụ thật (Firebase Auth, Firestore, Cloudinary, Google Drive):
- xác thực: thay `app.auth._verify_id_token` bằng hàm giả (token dạng "token-<uid>");
- lưu trữ: dùng kho RAM, hoặc `FirestoreImageStore` với client giả (tests/fakes.py).

Chạy (từ thư mục backend/, đã cài requirements.txt):  python -m pytest tests
"""
import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
for _p in (str(BACKEND_DIR), str(REPO_ROOT)):  # `app.*` (code) và `backend.app.*` (test cũ của nhóm) cùng import được
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Phải đặt TRƯỚC khi import app (Settings đọc biến môi trường lúc import; biến môi trường thắng file .env).
os.environ["IMAGE_STORE"] = "memory"
os.environ["CLOUDINARY_CLOUD_NAME"] = "test-cloud"
os.environ["NO_GCE_CHECK"] = "true"  # thư viện Google không dò máy chủ metadata
os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def fake_firebase_auth(monkeypatch):
    """Token hợp lệ có dạng `token-<uid>`; mọi token khác bị từ chối. Không gọi Firebase thật."""

    def fake_verify(id_token: str) -> dict:
        if id_token.startswith("token-") and len(id_token) > len("token-"):
            uid = id_token[len("token-"):]
            return {"uid": uid, "sub": uid}
        raise ValueError("token sai (lỗi giả lập có chứa chuỗi bí mật: s3cr3t-detail)")

    monkeypatch.setattr("app.auth._verify_id_token", fake_verify)


@pytest.fixture(autouse=True)
def fresh_store():
    """Mỗi test bắt đầu với kho RAM trống. Trả về kho để test kiểm tra nội dung đã lưu."""
    from app.repositories.image_repository import MemoryImageStore, image_repo

    store = MemoryImageStore()
    image_repo.configure(store)
    yield store
    image_repo.configure(None)


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)
