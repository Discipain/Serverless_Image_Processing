from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    APP_NAME: str = "Image Backend Core"
    GOOGLE_CLIENT_SECRETS_FILE: str = "credentials/client_secret.json"
    GOOGLE_REDIRECT_URI: str = "http://localhost:8000/oauth/callback"
    FRONTEND_URL: str = "http://localhost:3000"

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

    class Config:
        env_file = ".env"

settings = Settings()
