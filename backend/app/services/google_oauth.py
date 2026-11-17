import os
from typing import Any
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from app.config import settings
from app.repositories.token_repository import token_repo


class GoogleOAuthService:
    def _create_flow(self, state: str | None = None) -> Flow:
        if not os.path.exists(settings.GOOGLE_CLIENT_SECRETS_FILE):
            raise FileNotFoundError(
                f"Không tìm thấy {settings.GOOGLE_CLIENT_SECRETS_FILE}. Vui lòng thêm file cấu hình OAuth2."
            )
        flow = Flow.from_client_secrets_file(
            settings.GOOGLE_CLIENT_SECRETS_FILE,
            scopes=settings.GOOGLE_SCOPES,
            state=state,
        )
        flow.redirect_uri = settings.GOOGLE_REDIRECT_URI
        return flow

    def get_authorization_url(self) -> tuple[str, str]:
        flow = self._create_flow()
        auth_url, state = flow.authorization_url(
            access_type="offline",
            include_granted_scopes="true",
            prompt="consent",
        )
        return auth_url, state

    def exchange_code_for_tokens(self, code: str, state: str | None = None) -> dict[str, Any]:
        flow = self._create_flow(state=state)
        flow.fetch_token(code=code)
        creds = flow.credentials

        # Lấy thông tin profile Google để định danh uid
        oauth2_service = build("oauth2", "v2", credentials=creds)
        user_info = oauth2_service.userinfo().get().execute()
        uid = user_info["id"]

        token_data = {
            "token": creds.token,
            "refresh_token": creds.refresh_token,
            "token_uri": creds.token_uri,
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
            "scopes": list(creds.scopes or []),
        }
        token_repo.save_token(uid, token_data)

        return {
            "uid": uid,
            "email": user_info.get("email"),
            "name": user_info.get("name"),
            "driveConnected": True,
        }

    def get_user_credentials(self, uid: str) -> Credentials | None:
        token_data = token_repo.get_token(uid)
        if not token_data:
            return None
        return Credentials(**token_data)


google_oauth_service = GoogleOAuthService()