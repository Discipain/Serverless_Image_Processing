import re
from urllib.parse import urlsplit

from pydantic import field_validator
from pydantic_settings import BaseSettings

# ----- CORS (H4B-7B.1): danh sách origin TƯỜNG MINH, KHÔNG BAO GIỜ có wildcard -----
CORS_MAX_ORIGINS = 10
_CORS_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_CORS_DEFAULT_PORTS = {"http": 80, "https": 443}
# Tên miền ASCII (punycode cho IDN): nhãn 1-63 ký tự [a-z0-9-], không bắt đầu/kết thúc bằng "-". Không có "*", không có dấu chấm cuối.
_CORS_HOST_RE = re.compile(r"(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*")
_CORS_FORBIDDEN_CHARS_RE = re.compile(r"[\s\x00-\x1f\x7f*\\]")


def normalize_cors_origin(raw: object) -> str:
    """Chuẩn hóa MỘT origin cấu hình thành dạng trình duyệt gửi trong header `Origin`: `scheme://host[:port]` (chữ thường, bỏ cổng mặc định).

    Từ chối (ValueError, thông điệp KHÔNG chứa thông tin xác thực): wildcard `*`, `null`, rỗng, scheme ngoài http/https, `http` với host không phải loopback,
    username/password, query, fragment, path (trừ một dấu `/` cuối), host không hợp lệ, cổng ngoài 1..65535.
    """
    if not isinstance(raw, str):
        raise ValueError("CORS origin phải là chuỗi")
    text = raw.strip()
    if not text:
        raise ValueError("CORS origin rỗng")
    if text.lower() == "null":
        raise ValueError('CORS origin "null" không được phép')
    if _CORS_FORBIDDEN_CHARS_RE.search(text):
        raise ValueError("CORS origin chứa ký tự không hợp lệ (wildcard, khoảng trắng, ký tự điều khiển hoặc dấu gạch chéo ngược)")
    if "?" in text or "#" in text:
        raise ValueError("CORS origin không được chứa query hoặc fragment")
    try:
        parts = urlsplit(text)
        port = parts.port
    except ValueError:
        raise ValueError("CORS origin không phải URL hợp lệ") from None
    scheme = parts.scheme.lower()
    if scheme not in _CORS_DEFAULT_PORTS:
        raise ValueError("CORS origin chỉ nhận http hoặc https")
    if "@" in parts.netloc or parts.username is not None or parts.password is not None:
        raise ValueError("CORS origin không được chứa username/password")
    if parts.path not in ("", "/"):
        raise ValueError("CORS origin không được chứa path")
    host = (parts.hostname or "").lower()
    if not host:
        raise ValueError("CORS origin thiếu host")
    if host == "::1":
        host_text = "[::1]"
    elif host in _CORS_LOOPBACK_HOSTS or _CORS_HOST_RE.fullmatch(host):
        host_text = host
    else:
        raise ValueError("CORS origin có host không hợp lệ")
    if scheme == "http" and host not in _CORS_LOOPBACK_HOSTS:
        raise ValueError("CORS origin http chỉ cho phép localhost, 127.0.0.1 hoặc [::1] (host khác phải dùng https)")
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("CORS origin có cổng ngoài 1..65535")
    port_text = "" if port is None or port == _CORS_DEFAULT_PORTS[scheme] else f":{port}"
    return f"{scheme}://{host_text}{port_text}"


def parse_cors_allowed_origins(value: object) -> list[str]:
    """`CORS_ALLOWED_ORIGINS` (các origin cách nhau bằng dấu phẩy) -> danh sách đã chuẩn hóa, bỏ trùng, giữ thứ tự.

    FAIL CLOSED: bất kỳ phần tử sai, danh sách rỗng hoặc quá `CORS_MAX_ORIGINS` phần tử => ValueError (Backend không khởi động). KHÔNG có đường nào
    rơi về `*` hay cấu hình mở.
    """
    if not isinstance(value, str):
        raise ValueError("CORS_ALLOWED_ORIGINS phải là chuỗi các origin cách nhau bằng dấu phẩy")
    origins: list[str] = []
    for index, item in enumerate(value.split(","), start=1):
        try:
            origin = normalize_cors_origin(item)
        except ValueError as exc:
            raise ValueError(f"CORS_ALLOWED_ORIGINS: phần tử #{index} không hợp lệ: {exc}") from None
        if origin not in origins:
            origins.append(origin)
    if len(origins) > CORS_MAX_ORIGINS:
        raise ValueError(f"CORS_ALLOWED_ORIGINS: tối đa {CORS_MAX_ORIGINS} origin")
    return origins


class Settings(BaseSettings):
    APP_NAME: str = "Image Backend Core"
    GOOGLE_CLIENT_SECRETS_FILE: str = "credentials/client_secret.json"
    GOOGLE_REDIRECT_URI: str = "http://localhost:8000/oauth/callback"
    # Chỉ là ĐÍCH CHUYỂN HƯỚNG của luồng OAuth cũ (/oauth/callback). KHÔNG còn nằm trong danh sách CORS: dùng CORS_ALLOWED_ORIGINS.
    FRONTEND_URL: str = "http://localhost:3000"

    # Các origin trình duyệt được phép GỌI Backend (CORS), cách nhau bằng dấu phẩy. Mặc định: Vite dev (localhost và 127.0.0.1, cổng 5173).
    # Không wildcard; sai định dạng => Backend KHÔNG khởi động (fail closed). Origin production chỉ thêm khi được duyệt, qua biến môi trường.
    CORS_ALLOWED_ORIGINS: str = "http://localhost:5173,http://127.0.0.1:5173"

    FIREBASE_PROJECT_ID: str = "image-processing-project-ea23d"
    FIREBASE_STORAGE_BUCKET: str = "image-processing-project-ea23d.firebasestorage.app"
    # Rỗng = KHÔNG tự nạp file service-account trong repo; dùng Application Default Credentials
    # (biến GOOGLE_APPLICATION_CREDENTIALS trỏ tới file nằm NGOÀI repo). Chỉ đặt giá trị khi file nằm ngoài Git.
    FIREBASE_CREDENTIALS_FILE: str = ""

    # Nơi lưu metadata ảnh: "firestore" (mặc định, production) hoặc "memory" (CHỈ cho dev/test, mất khi tắt server).
    IMAGE_STORE: str = "firestore"

    CLOUDINARY_CLOUD_NAME: str = "zftcbu1g"
    CLOUDINARY_UPLOAD_PRESET: str = "serverless_image_preset"
    CLOUDINARY_API_KEY: str = ""  # chỉ nhận từ biến môi trường hoặc backend/.env (đã bị .gitignore chặn), KHÔNG commit
    CLOUDINARY_API_SECRET: str = ""  # chỉ nhận từ biến môi trường hoặc backend/.env (đã bị .gitignore chặn), KHÔNG commit

    # --- Cấp quyền upload có chữ ký (H4B-2). MẶC ĐỊNH TẮT: tắt thì không cấp grant, không trả chữ ký. Thiếu/sai cấu hình => fail closed (503). ---
    CLOUDINARY_SIGNED_UPLOAD_ENABLED: bool = False
    CLOUDINARY_SIGNATURE_ALGORITHM: str = "sha256"  # "sha1" | "sha256"
    UPLOAD_ENVIRONMENT: str = "dev"  # nằm trong public_id (hybrid/<môi trường>/<imageId>/...): [a-z0-9-], tối đa 20 ký tự
    UPLOAD_GRANT_TTL_SECONDS: int = 900  # thời hạn grant (1..3600). KHÔNG thu hồi được chữ ký Cloudinary đã cấp (hiệu lực ~1 giờ phía Cloudinary)
    UPLOAD_GRANTS_PER_HOUR: int = 20  # tối đa số grant MỚI mỗi người mỗi giờ (1..100), thực thi nguyên tử bằng tài liệu "slot" trong Firestore

    # --- Confirm theo grant + xác minh Cloudinary Admin API (H4B-3) ---
    # "legacy" (MẶC ĐỊNH): confirm như cũ, KHÔNG cần grant. "signed": BẮT BUỘC grant hợp lệ + xác minh asset bằng Admin API; không bao giờ rơi về legacy.
    # Giá trị lạ, hoặc CLOUDINARY_SIGNED_UPLOAD_ENABLED=true mà mode vẫn "legacy" => cấu hình mâu thuẫn => confirm VÀ authorize đều fail closed (503).
    CLOUDINARY_CONFIRM_MODE: str = "legacy"
    CLOUDINARY_ADMIN_TIMEOUT_SECONDS: float = 5.0  # chờ tối đa cho MỘT lần gọi Admin API (0.5..10); không tự retry
    UPLOAD_CONFIRM_BUDGET_SECONDS: float = 25.0  # ngân sách tổng cho một confirm ở chế độ signed (5..28), để lỗi thường gặp xảy ra trước timeout 30 s của Frontend
    UPLOAD_VERIFY_CLOCK_SKEW_SECONDS: int = 120  # sai số đồng hồ chấp nhận khi so created_at của asset với thời hạn grant (0..600)

    GOOGLE_SCOPES: list[str] = [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/drive.file",
    ]

    MAX_FILE_SIZE_BYTES: int = 10 * 1024 * 1024  # 10MB
    ALLOWED_MIME_TYPES: set[str] = {"image/jpeg", "image/png", "image/webp"}
    ALLOWED_EXTENSIONS: set[str] = {".jpg", ".jpeg", ".png", ".webp"}

    @field_validator("CORS_ALLOWED_ORIGINS")
    @classmethod
    def _validate_cors_allowed_origins(cls, value: str) -> str:
        """Kiểm tra NGAY khi nạp cấu hình và lưu dạng đã chuẩn hóa (bỏ trùng). Sai => ValidationError lúc import => Backend không chạy."""
        return ",".join(parse_cors_allowed_origins(value))

    @property
    def cors_origins(self) -> list[str]:
        """Danh sách origin CORS đã kiểm tra và chuẩn hóa (ném ValueError nếu giá trị bị sửa thành sai sau khi nạp)."""
        return parse_cors_allowed_origins(self.CORS_ALLOWED_ORIGINS)

    class Config:
        env_file = ".env"

settings = Settings()
