"""Xác thực Firebase ID token (`Authorization: Bearer <token>`) bằng firebase-admin.

CONTRACT mục 0: uid CHỈ lấy từ token đã verify. Không đọc uid từ header tự khai, body hay query.
firebase-admin được import lười (trong hàm) để module này import được kể cả khi chưa cấu hình Firebase,
và để test có thể thay `_verify_id_token` mà không cần credential hay mạng.

QUAN TRỌNG về thông tin xác thực của Backend: firebase-admin KHÔNG verify được token nếu thiếu credential của Google.
Khi dựng client xác thực nó gọi `google.auth.default()` (Application Default Credentials); thiếu ADC thì ném
`DefaultCredentialsError` ở MỌI request. Đã kiểm chứng với firebase-admin 6.8.0. Vì vậy cần một trong:
  - `GOOGLE_APPLICATION_CREDENTIALS` trỏ tới file service-account MỚI nằm NGOÀI repo (chạy cục bộ), hoặc
  - `FIREBASE_CREDENTIALS_FILE` trỏ tới file nằm NGOÀI repo, hoặc
  - môi trường Google Cloud tự cung cấp ADC.

Phân biệt lỗi người dùng với lỗi cấu hình của Backend:
  401 `{"detail": "Missing token"}` (CONTRACT mục 3.3/10) khi:
      thiếu hoặc sai định dạng header Bearer; token sai, hết hạn, bị thu hồi (InvalidIdTokenError và lớp con); và mọi lỗi
      KHÁC không thuộc danh sách 503 bên dưới (đóng an toàn: từ chối và chỉ ghi TÊN lớp lỗi để dễ truy vết).
  503 `{"detail": "Authentication service unavailable"}` khi Backend không thể thực hiện việc xác thực:
      - DefaultCredentialsError (thiếu ADC);
      - CertificateFetchError (không tải được chứng chỉ công khai của Google để kiểm chữ ký);
      - lỗi cấu hình khi khởi tạo Firebase Admin (thiếu projectId, file credentials hỏng/không đọc được, tùy chọn sai).
  Token sai KHÔNG BAO GIỜ thành 503, và không có `except` nào biến mọi lỗi thành 503. Phản hồi 503 là thông điệp chung,
  không lộ đường dẫn, credential hay chi tiết ngoại lệ; log chỉ ghi TÊN loại lỗi.
"""
import logging
import os

from fastapi import Header, HTTPException, status

from app.config import settings
from app.exceptions import UnauthorizedException

logger = logging.getLogger(__name__)

# CONTRACT mục 3.3 và 10: thiếu token và sai/hết hạn token đều trả đúng chuỗi này (không lộ lý do cho client).
MISSING_TOKEN = "Missing token"
AUTH_UNAVAILABLE = "Authentication service unavailable"


class AuthServiceUnavailableException(HTTPException):
    """503: Backend không thực hiện được việc xác thực (lỗi cấu hình/hạ tầng), KHÔNG phải lỗi của người dùng."""

    def __init__(self) -> None:
        super().__init__(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=AUTH_UNAVAILABLE)


class AuthConfigurationError(Exception):
    """Lỗi cấu hình Firebase Admin phía Backend. `reason` chỉ chứa nhãn cố định và TÊN lớp lỗi gốc, không có thông điệp."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _ensure_firebase_app() -> None:
    """Khởi tạo firebase-admin một lần. Giữ nguyên tên vì `google_oauth.py` và kho Firestore đang dùng hàm này."""
    import firebase_admin
    from firebase_admin import credentials as fb_credentials

    if firebase_admin._apps:
        return
    options = {"projectId": settings.FIREBASE_PROJECT_ID}
    cred_file = (settings.FIREBASE_CREDENTIALS_FILE or "").strip()
    if cred_file and os.path.isfile(cred_file):
        firebase_admin.initialize_app(fb_credentials.Certificate(cred_file), options)
    else:
        # Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS trỏ tới file NGOÀI repo, hoặc ADC của môi trường
        # Google Cloud). ADC được nạp LƯỜI: nếu thiếu, lỗi DefaultCredentialsError xuất hiện ở lần verify đầu tiên.
        firebase_admin.initialize_app(options=options)


def _initialize_firebase_admin() -> None:
    """Chuẩn bị firebase-admin cho việc xác thực. Mọi lỗi cấu hình => AuthConfigurationError (chỉ mang tên loại lỗi)."""
    from google.auth.exceptions import GoogleAuthError

    if not (settings.FIREBASE_PROJECT_ID or "").strip():
        raise AuthConfigurationError("missing_project_id")
    try:
        _ensure_firebase_app()
    except (ValueError, OSError, GoogleAuthError) as exc:  # file credentials hỏng/không đọc được, tùy chọn khởi tạo sai
        raise AuthConfigurationError(f"init_failed:{type(exc).__name__}") from None


def _verify_id_token(id_token: str) -> dict:
    """Điểm duy nhất gọi firebase-admin để verify token. Test thay hàm này."""
    from firebase_admin import auth as firebase_auth

    _initialize_firebase_admin()
    return firebase_auth.verify_id_token(id_token)


def _is_service_unavailable(exc: BaseException) -> bool:
    """True CHỈ cho các lỗi cho biết Backend không xác thực được; mọi lỗi khác (kể cả token sai) KHÔNG nằm ở đây."""
    from firebase_admin import auth as firebase_auth
    from google.auth.exceptions import DefaultCredentialsError

    return isinstance(exc, (AuthConfigurationError, DefaultCredentialsError, firebase_auth.CertificateFetchError))


def get_current_uid(authorization: str | None = Header(default=None, alias="Authorization")) -> str:
    """Trả về `uid` của người dùng đã đăng nhập. Lỗi người dùng => 401; Backend không xác thực được => 503."""
    scheme, _, token = (authorization or "").partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        raise UnauthorizedException(MISSING_TOKEN)

    try:
        decoded = _verify_id_token(token)
    except Exception as exc:  # chỉ để PHÂN LOẠI thành hai nhóm bên dưới; không nhóm nào lộ chi tiết ngoại lệ
        # Chỉ ghi TÊN loại lỗi, tuyệt đối không ghi token, thông điệp lỗi hay đường dẫn.
        if _is_service_unavailable(exc):
            label = exc.reason if isinstance(exc, AuthConfigurationError) else type(exc).__name__
            logger.error("Dịch vụ xác thực Firebase không khả dụng (lỗi cấu hình/hạ tầng của Backend): %s", label)
            raise AuthServiceUnavailableException() from None
        logger.warning("Firebase ID token bị từ chối: %s", type(exc).__name__)
        raise UnauthorizedException(MISSING_TOKEN) from None

    uid = decoded.get("uid") or decoded.get("sub") if isinstance(decoded, dict) else None
    if not isinstance(uid, str) or not uid:
        raise UnauthorizedException(MISSING_TOKEN)
    return uid
