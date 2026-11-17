from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    APP_NAME: str = "Image Backend Core"
    SECRET_KEY: str = "dev-secret-key"
    GOOGLE_CLIENT_SECRETS_FILE: str = "credentials/client_secret.json"
    GOOGLE_REDIRECT_URI: str = "http://localhost:8000/oauth/callback"
    FRONTEND_URL: str = "http://localhost:3000"

    # Quyền truy cập Google Profile + Google Drive (chỉ file do app tạo ra)
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