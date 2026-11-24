"""Chế độ upload (H4B-3): quyết định MỘT chỗ duy nhất, dùng chung cho authorize và confirm.

  - confirm_mode = "legacy" (mặc định) và cờ authorize TẮT  -> LEGACY: confirm như cũ, không cần grant.
  - confirm_mode = "signed"                                  -> SIGNED: confirm BẮT BUỘC grant + xác minh Admin API (cờ authorize bật/tắt đều được;
                                                               tắt authorize không bao giờ mở lại đường unsigned).
  - cờ authorize BẬT mà confirm_mode = "legacy"              -> MÂU THUẪN (authorize cấp chữ ký nhưng confirm vẫn nhận URL unsigned) -> INVALID.
  - confirm_mode giá trị lạ                                   -> INVALID.
INVALID => cả authorize lẫn confirm trả 503 (fail closed). KHÔNG BAO GIỜ tự rơi từ SIGNED về LEGACY.
"""
from typing import Any

MODE_LEGACY = "legacy"
MODE_SIGNED = "signed"
MODE_INVALID = "invalid"


def confirm_mode(settings: Any) -> str:
    raw = getattr(settings, "CLOUDINARY_CONFIRM_MODE", None)
    mode = raw.strip().lower() if isinstance(raw, str) else None
    if mode == MODE_SIGNED:
        return MODE_SIGNED
    if mode == MODE_LEGACY:
        # Chỉ coi là hợp lệ khi cờ authorize TẮT một cách tường minh (False). Bật (hoặc giá trị lạ) mà confirm vẫn legacy => mâu thuẫn.
        return MODE_LEGACY if getattr(settings, "CLOUDINARY_SIGNED_UPLOAD_ENABLED", False) is False else MODE_INVALID
    return MODE_INVALID


def authorize_allowed(settings: Any) -> bool:
    """authorize chỉ chạy khi cờ bật VÀ confirm đã ở chế độ signed."""
    return getattr(settings, "CLOUDINARY_SIGNED_UPLOAD_ENABLED", False) is True and confirm_mode(settings) == MODE_SIGNED
