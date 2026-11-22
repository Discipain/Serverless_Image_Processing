import os
from fastapi import Header
import firebase_admin
from firebase_admin import auth as firebase_auth, credentials as fb_credentials
from app.config import settings
from app.exceptions import UnauthorizedException


def _ensure_firebase_app() -> None:
    if firebase_admin._apps:
        return
    if os.path.exists(settings.FIREBASE_CREDENTIALS_FILE):
        cred = fb_credentials.Certificate(settings.FIREBASE_CREDENTIALS_FILE)
        firebase_admin.initialize_app(cred, {"projectId": settings.FIREBASE_PROJECT_ID})
    else:
        firebase_admin.initialize_app(options={"projectId": settings.FIREBASE_PROJECT_ID})


def get_current_uid(authorization: str | None = Header(default=None, alias="Authorization")) -> str:
    """
    Xác thực Firebase ID Token từ header `Authorization: Bearer <token>` và trả về `uid`.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise UnauthorizedException("Thiếu hoặc sai định dạng header Authorization: Bearer <Firebase ID Token>")

    id_token = authorization.split("Bearer ", 1)[1].strip()
    if not id_token:
        raise UnauthorizedException("Firebase ID Token rỗng.")

    try:
        _ensure_firebase_app()
        decoded_token = firebase_auth.verify_id_token(id_token)
        uid = decoded_token.get("uid") or decoded_token.get("sub")
        if not uid:
            raise UnauthorizedException("Token không chứa uid hợp lệ.")
        return uid
    except UnauthorizedException:
        raise
    except Exception as exc:
        raise UnauthorizedException(f"Firebase Bearer token không hợp lệ hoặc đã hết hạn: {str(exc)}") from exc