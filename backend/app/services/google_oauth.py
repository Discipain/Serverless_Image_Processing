import logging
import os
from typing import Any
from firebase_admin import auth as firebase_auth
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from app.auth import _ensure_firebase_app
from app.config import settings
from app.repositories.token_repository import token_repo

logger = logging.getLogger(__name__)


class GoogleOAuthService:
    # Lưu tạm code_verifier theo state (dùng Redis/Firestore nếu chạy multi-worker)
    _pkce_verifiers: dict[str, str] = {}

    def _create_flow(self, state: str | None = None, code_verifier: str | None = None) -> Flow:
        if not os.path.exists(settings.GOOGLE_CLIENT_SECRETS_FILE):
            raise FileNotFoundError(
                f"Không tìm thấy {settings.GOOGLE_CLIENT_SECRETS_FILE}. Vui lòng thêm file cấu hình OAuth2."
            )
        flow = Flow.from_client_secrets_file(
            settings.GOOGLE_CLIENT_SECRETS_FILE,
            scopes=settings.GOOGLE_SCOPES,
            state=state,
            autogenerate_code_verifier=True,
        )
        flow.redirect_uri = settings.GOOGLE_REDIRECT_URI
        if code_verifier:
            flow.code_verifier = code_verifier
        return flow

    def get_authorization_url(self) -> tuple[str, str]:
        flow = self._create_flow()
        auth_url, state = flow.authorization_url(
            access_type="offline",
            include_granted_scopes="true",
            prompt="consent",
        )
        if getattr(flow, "code_verifier", None):
            self._pkce_verifiers[state] = flow.code_verifier
        return auth_url, state

    def _ensure_firebase_uid(
        self,
        google_uid: str,
        email: str | None = None,
        name: str | None = None,
    ) -> str | None:
        try:
            _ensure_firebase_app()
            try:
                user_record = firebase_auth.get_user(google_uid)
                return user_record.uid
            except firebase_auth.UserNotFoundError:
                if email:
                    try:
                        existing_user = firebase_auth.get_user_by_email(email)
                        return existing_user.uid
                    except firebase_auth.UserNotFoundError:
                        created = firebase_auth.create_user(
                            uid=google_uid,
                            email=email,
                            display_name=name,
                        )
                        return created.uid
                created = firebase_auth.create_user(uid=google_uid, display_name=name)
                return created.uid
        except Exception as exc:
            logger.exception(
                "Không thể đồng bộ Firebase user cho google_uid=%s (kiểm tra file %s và đồng hồ hệ thống): %s",
                google_uid,
                settings.FIREBASE_CREDENTIALS_FILE,
                exc,
            )
            return None

    def _issue_firebase_custom_token(
        self,
        firebase_uid: str,
        email: str | None = None,
    ) -> str | None:
        try:
            _ensure_firebase_app()
            claims = {"email": email} if email else None
            custom_token_bytes = firebase_auth.create_custom_token(firebase_uid, claims)
            return (
                custom_token_bytes.decode("utf-8")
                if isinstance(custom_token_bytes, bytes)
                else custom_token_bytes
            )
        except Exception as exc:
            logger.exception(
                "Không thể tạo Firebase Custom Token cho firebase_uid=%s: %s",
                firebase_uid,
                exc,
            )
            return None

    def exchange_code_for_tokens(self, code: str, state: str | None = None) -> dict[str, Any]:
        verifier = self._pkce_verifiers.pop(state, None) if state else None
        flow = self._create_flow(state=state, code_verifier=verifier)
        flow.fetch_token(code=code)
        creds = flow.credentials

        oauth2_service = build("oauth2", "v2", credentials=creds)
        user_info = oauth2_service.userinfo().get().execute()
        google_uid = user_info["id"]
        email = user_info.get("email")
        name = user_info.get("name")

        firebase_uid = self._ensure_firebase_uid(
            google_uid=google_uid,
            email=email,
            name=name,
        ) or google_uid

        token_data = {
            "token": creds.token,
            "refresh_token": creds.refresh_token,
            "token_uri": creds.token_uri,
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
            "scopes": list(creds.scopes or []),
        }
        # Lưu theo firebase_uid để khớp với uid do get_current_uid() trích xuất từ Firebase ID Token
        token_repo.save_token(firebase_uid, token_data)
        if firebase_uid != google_uid:
            token_repo.save_token(google_uid, token_data)

        firebase_custom_token = self._issue_firebase_custom_token(
            firebase_uid=firebase_uid,
            email=email,
        )

        return {
            "uid": firebase_uid,
            "googleUid": google_uid,
            "email": email,
            "name": name,
            "driveConnected": True,
            "firebaseCustomToken": firebase_custom_token,
        }

    def get_user_credentials(self, uid: str) -> Credentials | None:
        token_data = token_repo.get_token(uid)
        if not token_data:
            return None
        return Credentials(**token_data)


google_oauth_service = GoogleOAuthService()