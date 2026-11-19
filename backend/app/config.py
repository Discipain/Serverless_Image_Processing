from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    APP_NAME: str = "Image Backend Core"
    SECRET_KEY: str = "dev-secret-key"
    GOOGLE_CLIENT_SECRETS_FILE: str = "credentials/client_secret.json"
    GOOGLE_REDIRECT_URI: str = "http://localhost:8000/oauth/callback"
    FRONTEND_URL: str = "http://localhost:3000"

    FIREBASE_PROJECT_ID: str = "image-processing-project-ea23d"
    FIREBASE_STORAGE_BUCKET: str = "image-processing-project-ea23d.firebasestorage.app"

    CLOUDINARY_CLOUD_NAME: str = "znawrd5q"
    CLOUDINARY_UPLOAD_PRESET: str = "serverless_image_preset"
    CLOUDINARY_API_KEY: str = "325155291857765"
    CLOUDINARY_API_SECRET: str = "rKeprzW5vQkeDixIZt_WW1aDVZQ"

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