"""RETIRED (H4B-7B.3A): proxy xác thực Firebase kiểu cũ (/auth/firebase/login|register|refresh).

Frontend đăng nhập Google bằng Firebase SDK trực tiếp và gửi `Authorization: Bearer <ID token>`; Backend chỉ VERIFY token (app/auth.py). Các endpoint này từng chuyển tiếp
email/password và refresh token tới Identity Toolkit / Secure Token API bằng FIREBASE_WEB_API_KEY (không hề được khai báo trong Settings => luôn lỗi 500).

Giữ đường dẫn để trả lỗi RÕ RÀNG: HTTP 410 cho MỌI request, không điều kiện:
  - không khai báo body/dependency nào => KHÔNG đọc/kiểm tra body (không 422 thăm dò), KHÔNG yêu cầu Bearer, KHÔNG đọc cấu hình credential;
  - KHÔNG gọi service, KHÔNG mạng, KHÔNG tạo tài khoản/token, KHÔNG side effect;
  - không có biến môi trường, header, query hay body nào bật lại được. (Mã proxy cũ vẫn nằm trong firebase_auth_service.py nhưng cũng bị chặn ở đó.)
"""
from fastapi import APIRouter

from app.exceptions import FirebaseAuthRetiredException

router = APIRouter(prefix="/auth/firebase", tags=["Firebase Auth (retired)"])

_RETIRED = {410: {"description": "Firebase authentication endpoint is retired"}}


@router.post("/login", deprecated=True, responses=_RETIRED)
def firebase_login():
    raise FirebaseAuthRetiredException()


@router.post("/register", deprecated=True, responses=_RETIRED)
def firebase_register():
    raise FirebaseAuthRetiredException()


@router.post("/refresh", deprecated=True, responses=_RETIRED)
def firebase_refresh():
    raise FirebaseAuthRetiredException()
