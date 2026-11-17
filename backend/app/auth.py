from fastapi import Header
from app.exceptions import UnauthorizedException


def get_current_uid(x_user_id: str | None = Header(default=None, alias="X-User-Id")) -> str:
    """
    Dependency lấy UID của người dùng hiện tại từ header (hoặc JWT/Session thực tế).
    Dùng header `X-User-Id` giúp test phân quyền A/B cực kỳ trực quan.
    """
    if not x_user_id or not x_user_id.strip():
        raise UnauthorizedException("Thiếu thông tin xác thực người dùng (Header X-User-Id)")
    return x_user_id.strip()