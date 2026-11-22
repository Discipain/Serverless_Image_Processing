import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from app.config import settings
from app.exceptions import UnauthorizedException


class FirebaseAuthService:
    SIGN_IN_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword"
    SIGN_UP_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signUp"
    REFRESH_URL = "https://securetoken.googleapis.com/v1/token"

    def _post_json(self, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        api_key = getattr(settings, "FIREBASE_WEB_API_KEY", None)
        if not api_key:
            raise RuntimeError("Thiếu cấu hình FIREBASE_WEB_API_KEY.")

        full_url = f"{url}?key={api_key}"
        data = json.dumps(payload).encode("utf-8")
        req = Request(
            full_url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as exc:
            err_body = exc.read().decode("utf-8", errors="ignore")
            try:
                err_json = json.loads(err_body)
                message = err_json.get("error", {}).get("message", err_body)
            except ValueError:
                message = err_body or str(exc)
            raise UnauthorizedException(f"Firebase Auth lỗi: {message}") from exc
        except URLError as exc:
            raise RuntimeError(f"Không thể kết nối tới Firebase Auth API: {exc.reason}") from exc

    def login_with_email_password(self, email: str, password: str) -> dict[str, Any]:
        res = self._post_json(
            self.SIGN_IN_URL,
            {"email": email, "password": password, "returnSecureToken": True},
        )
        return {
            "uid": res.get("localId"),
            "email": res.get("email"),
            "idToken": res.get("idToken"),
            "refreshToken": res.get("refreshToken"),
            "expiresIn": res.get("expiresIn"),
        }

    def register_with_email_password(self, email: str, password: str) -> dict[str, Any]:
        res = self._post_json(
            self.SIGN_UP_URL,
            {"email": email, "password": password, "returnSecureToken": True},
        )
        return {
            "uid": res.get("localId"),
            "email": res.get("email"),
            "idToken": res.get("idToken"),
            "refreshToken": res.get("refreshToken"),
            "expiresIn": res.get("expiresIn"),
        }

    def refresh_id_token(self, refresh_token: str) -> dict[str, Any]:
        res = self._post_json(
            self.REFRESH_URL,
            {"grant_type": "refresh_token", "refresh_token": refresh_token},
        )
        return {
            "uid": res.get("user_id"),
            "idToken": res.get("id_token"),
            "refreshToken": res.get("refresh_token"),
            "expiresIn": res.get("expires_in"),
        }


firebase_auth_service = FirebaseAuthService()