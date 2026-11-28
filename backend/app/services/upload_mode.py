"""Chế độ upload Cloudinary (H4B-3, siết ở H4B-7B.2 và H4B-7B.2.1): quyết định MỘT chỗ duy nhất, dùng chung cho authorize, confirm và upload-url.

Biến đầu vào (cấu hình môi trường): CLOUDINARY_CONFIRM_MODE, CLOUDINARY_SIGNED_UPLOAD_ENABLED.

  - confirm_mode = "disabled" (MẶC ĐỊNH)  -> DISABLED: không authorize, không confirm, không upload-url, không cấp unsigned preset, không ghi dữ liệu upload.
                                             (chỉ hợp lệ khi cờ authorize TẮT; bật = mâu thuẫn -> INVALID)
  - confirm_mode = "signed"               -> SIGNED: confirm BẮT BUỘC grant + xác minh Admin API (cờ authorize bật/tắt đều được; tắt authorize không bao giờ mở
                                             lại đường unsigned). upload-url bị khóa. KHÔNG BAO GIỜ rơi về legacy, kể cả khi provider legacy đã được tiêm.
  - confirm_mode = "legacy"               -> CẤU HÌNH MÔI TRƯỜNG KHÔNG BAO GIỜ BẬT ĐƯỢC LEGACY. Chỉ khi mã của một harness CÔ LẬP đã tiêm (bằng lời gọi Python
                                             `install_legacy_compat`) một provider cấu hình GIẢ thì mới là LEGACY, và vẫn cần: cờ authorize TẮT, kho KHÔNG phải
                                             Firestore thật (RAM, hoặc Firestore Emulator loopback) và KHÔNG có CLOUDINARY_API_KEY/SECRET. Thiếu bất kỳ điều kiện
                                             nào -> INVALID (KHÔNG tự rơi về disabled hay signed). Các điều kiện về kho/khóa chỉ là lớp phòng thủ PHỤ: chúng không
                                             chứng minh Cloudinary là giả; bằng chứng duy nhất là provider giả được tiêm, và upload-url CHỈ trả cấu hình của provider đó
                                             (không bao giờ cloud name/preset trong settings), nên không thể cấp unsigned config thật cho trình duyệt.
  - giá trị lạ / rỗng / không phải chuỗi  -> INVALID.
INVALID => authorize, confirm và upload-url đều fail closed (503), không ghi Firestore, không gọi Cloudinary. KHÔNG BAO GIỜ tự rơi từ SIGNED/DISABLED về LEGACY.

Việc tiêm provider KHÔNG có đường nào từ HTTP, biến môi trường hay file cấu hình: `install_legacy_compat` chỉ được gọi bằng mã Python của harness/test cô lập
(test_upload_mode_policy.py kiểm tra không module ứng dụng nào khác gọi nó).
"""
import os
import re
from dataclasses import dataclass
from typing import Any

from app.exceptions import LegacyUploadRetiredException, SignedUploadUnavailableException

MODE_DISABLED = "disabled"
MODE_LEGACY = "legacy"
MODE_SIGNED = "signed"
MODE_INVALID = "invalid"

# Tên cloud/preset GIẢ phải có tiền tố rõ ràng; tên thật (vd. cloud name của dự án) không khớp nên bị từ chối ngay khi dựng provider.
_FAKE_NAME_RE = re.compile(r"(?:test|demo|fake|sim)-[a-z0-9]+(?:-[a-z0-9]+)*")


@dataclass(frozen=True)
class LegacyCompatProvider:
    """Cấu hình upload unsigned GIẢ mà harness cô lập tiêm vào; đây là thứ DUY NHẤT mà upload-url legacy được phép trả cho trình duyệt."""

    cloud_name: str
    upload_preset: str

    def __post_init__(self) -> None:
        for field_name in ("cloud_name", "upload_preset"):
            value = getattr(self, field_name)
            if not isinstance(value, str) or _FAKE_NAME_RE.fullmatch(value) is None:
                raise ValueError(f"LegacyCompatProvider.{field_name} phải là tên GIẢ có tiền tố test-/demo-/fake-/sim-")


_legacy_provider: LegacyCompatProvider | None = None


def install_legacy_compat(provider: LegacyCompatProvider) -> None:
    """CHỈ cho harness/test cô lập (Cloudinary giả, auth giả, kho RAM hoặc Firestore Emulator). Tự nó KHÔNG bật legacy: vẫn cần CLOUDINARY_CONFIRM_MODE=legacy
    và các điều kiện cô lập. Không route, biến môi trường hay file cấu hình nào gọi được hàm này."""
    global _legacy_provider
    if not isinstance(provider, LegacyCompatProvider):
        raise TypeError("cần LegacyCompatProvider")
    _legacy_provider = provider


def uninstall_legacy_compat() -> None:
    global _legacy_provider
    _legacy_provider = None


def legacy_compat_provider() -> LegacyCompatProvider | None:
    return _legacy_provider


_FIRESTORE_EMULATOR_RE = re.compile(r"(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]{1,5}")


def _firestore_is_loopback_emulator() -> bool:
    """SDK Firestore chỉ nói chuyện với emulator (không bao giờ với Firestore thật) khi FIRESTORE_EMULATOR_HOST đặt; ở đây chỉ chấp nhận host:port LOOPBACK."""
    return _FIRESTORE_EMULATOR_RE.fullmatch(os.environ.get("FIRESTORE_EMULATOR_HOST", "").strip()) is not None


def _legacy_environment_is_local(settings: Any) -> bool:
    """Lớp phòng thủ PHỤ của LEGACY: KHÔNG chạm Firestore thật (kho RAM, hoặc Firestore Emulator loopback) và KHÔNG có khóa API/secret Cloudinary.
    Điều kiện này KHÔNG chứng minh Cloudinary là giả (unsigned upload không cần khóa) — việc đó do provider giả được tiêm bảo đảm."""
    store = getattr(settings, "IMAGE_STORE", None)
    store = store.strip().lower() if isinstance(store, str) else None
    if store != "memory" and not (store == "firestore" and _firestore_is_loopback_emulator()):
        return False
    return not getattr(settings, "CLOUDINARY_API_KEY", None) and not getattr(settings, "CLOUDINARY_API_SECRET", None)


def confirm_mode(settings: Any) -> str:
    raw = getattr(settings, "CLOUDINARY_CONFIRM_MODE", None)
    mode = raw.strip().lower() if isinstance(raw, str) else None
    enabled = getattr(settings, "CLOUDINARY_SIGNED_UPLOAD_ENABLED", False)
    if mode == MODE_DISABLED:
        return MODE_DISABLED if enabled is False else MODE_INVALID  # authorize bật mà confirm disabled => mâu thuẫn (không âm thầm bỏ qua cờ)
    if mode == MODE_SIGNED:
        return MODE_SIGNED
    if mode == MODE_LEGACY:
        # Cấu hình môi trường một mình KHÔNG BAO GIỜ đủ: phải có provider giả do harness tiêm + authorize tắt tường minh + môi trường cục bộ.
        return MODE_LEGACY if _legacy_provider is not None and enabled is False and _legacy_environment_is_local(settings) else MODE_INVALID
    return MODE_INVALID


def authorize_allowed(settings: Any) -> bool:
    """authorize chỉ chạy khi cờ bật VÀ confirm đã ở chế độ signed."""
    return getattr(settings, "CLOUDINARY_SIGNED_UPLOAD_ENABLED", False) is True and confirm_mode(settings) == MODE_SIGNED


def legacy_upload_allowed(settings: Any) -> bool:
    return confirm_mode(settings) == MODE_LEGACY


def require_legacy_upload_allowed(settings: Any) -> None:
    """Cổng của POST /images/upload-url (cấp unsigned preset + tạo PENDING). Gọi TRƯỚC mọi tác dụng phụ.

    LEGACY (chỉ trong harness cô lập) -> cho qua. SIGNED hoặc DISABLED -> 410 (endpoint đã retire theo chính sách; cùng một thông điệp, không lộ mode).
    INVALID (cấu hình sai/mâu thuẫn, kể cả "legacy" chỉ đặt bằng môi trường) -> 503, cùng thông điệp với authorize/confirm."""
    mode = confirm_mode(settings)
    if mode == MODE_LEGACY:
        return
    if mode == MODE_INVALID:
        raise SignedUploadUnavailableException()
    raise LegacyUploadRetiredException()
