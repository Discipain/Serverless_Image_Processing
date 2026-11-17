from typing import Any


class TokenRepository:
    """Lưu trữ OAuth2 credentials của user theo uid (In-memory mock, có thể thay bằng DB/Firestore)."""

    def __init__(self) -> None:
        self._tokens: dict[str, dict[str, Any]] = {}

    def save_token(self, uid: str, token_data: dict[str, Any]) -> None:
        self._tokens[uid] = token_data

    def get_token(self, uid: str) -> dict[str, Any] | None:
        return self._tokens.get(uid)

    def delete_token(self, uid: str) -> None:
        self._tokens.pop(uid, None)


token_repo = TokenRepository()