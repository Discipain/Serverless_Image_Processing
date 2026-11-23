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
