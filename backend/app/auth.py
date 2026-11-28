import os
from fastapi import Header
import firebase_admin
from firebase_admin import auth as firebase_auth, credentials as fb_credentials
from app.config import settings
from app.exceptions import UnauthorizedException
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from firebase_admin import auth, credentials

bearer_scheme = HTTPBearer(auto_error=False)

def _ensure_firebase_app() -> None:
    if firebase_admin._apps:
        return
    if os.path.exists(settings.FIREBASE_CREDENTIALS_FILE):
        cred = fb_credentials.Certificate(settings.FIREBASE_CREDENTIALS_FILE)
        firebase_admin.initialize_app(cred, {"projectId": settings.FIREBASE_PROJECT_ID})
    else:
        firebase_admin.initialize_app(options={"projectId": settings.FIREBASE_PROJECT_ID})

def verify_bearer_token(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict:
    """Xác thực Firebase ID token từ header Authorization: Bearer <token>."""
    if creds is None or creds.scheme.lower() != "bearer" or not creds.credentials.strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    _ensure_firebase_app()
    token = creds.credentials.strip()

    try:
        decoded = auth.verify_id_token(token)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    if not decoded.get("uid"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return decoded

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