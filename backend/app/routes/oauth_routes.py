from urllib.parse import urlencode
from fastapi import APIRouter, Query
from fastapi.responses import RedirectResponse
from app.config import settings
from app.services.google_oauth import google_oauth_service

router = APIRouter(prefix="/oauth", tags=["Google OAuth & Drive"])


@router.get("/google/login")
def login_google():
    auth_url, state = google_oauth_service.get_authorization_url()
    return {"authUrl": auth_url, "state": state}


@router.get("/google/redirect")
def redirect_google():
    auth_url, _ = google_oauth_service.get_authorization_url()
    return RedirectResponse(url=auth_url)


@router.get("/callback")
def oauth_callback(code: str = Query(...), state: str | None = Query(default=None)):
    user_session = google_oauth_service.exchange_code_for_tokens(code=code, state=state)
    params = urlencode({
        "uid": user_session["uid"],
        "email": user_session.get("email") or "",
        "name": user_session.get("name") or "",
        "firebaseCustomToken": user_session.get("firebaseCustomToken") or "",
    })
    return RedirectResponse(url=f"{settings.FRONTEND_URL}/index.html?{params}")