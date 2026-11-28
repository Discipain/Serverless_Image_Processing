"""Kiểm tra payload và dựng bản ghi cho `POST /images/cloudinary/confirm` (CONTRACT.md mục 3, bản Hybrid).

Thuần Python: không gọi mạng, không đọc Firestore. Mọi lỗi dữ liệu là `400 {"detail": ...}`.

Payload:
- 6 field BẮT BUỘC: imageId, thumbnail, medium, webp, originalSize, processingMs.
- 7 field TÙY CHỌN: fileName, width, height, thumbnailId, mediumId, webpId, processedSize (thiếu thì bỏ qua).
- `contentType` (và mọi field lạ khác) bị bỏ qua, không bắt buộc, không lưu.
- Không bao giờ đọc `ownerId`/`uid` từ body: chủ sở hữu chỉ lấy từ Firebase ID token.

Định danh asset: mỗi URL được phân tích thành `public_id` (xem `parse_cloudinary_url`) và việc "một asset chỉ thuộc một
imageId" dựa trên `public_id` đó (sổ đăng ký `cloudinaryAssets`), KHÔNG dựa trên chuỗi URL. Đổi đoạn biến đổi
(`w_200,f_webp`), số version hay phần mở rộng không đổi được định danh. URL mà không xác định được `public_id` một cách
đáng tin cậy (thiếu version, đoạn không nhận ra, có dấu chấm trong public_id...) bị từ chối `400`.

GIỚI HẠN QUAN TRỌNG (defense-in-depth, KHÔNG phải bằng chứng quyền sở hữu): Cloudinary unsigned preset không gắn người
upload vào asset. Cơ chế này chỉ ngăn cùng một public_id bị đăng ký cho nhiều chủ/imageId; nó KHÔNG chứng minh ai đã
upload file, cũng không chứng minh asset tồn tại. Ai đăng ký TRƯỚC thì giữ asset ("first-come").
"""
import hashlib
import math
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from app.config import settings
from app.exceptions import InvalidFileException

REQUIRED_FIELDS = ("imageId", "thumbnail", "medium", "webp", "originalSize", "processingMs")
OPTIONAL_FIELDS = ("fileName", "width", "height", "thumbnailId", "mediumId", "webpId", "processedSize")
VARIANT_KEYS = ("thumbnail", "medium", "webp")

CLOUDINARY_HOST = "res.cloudinary.com"
MAX_URL_LENGTH = 2048
MAX_FILE_NAME_LENGTH = 255
MAX_DIMENSION = 65535
# Chính sách của Backend (không có trong CONTRACT): nén 1 ảnh ≤10MB không thể mất hơn 1 giờ.
MAX_PROCESSING_MS = 3_600_000

_IMAGE_ID_RE = re.compile(r"[A-Za-z0-9_-]{8,128}")  # UUID v4 của Frontend; cấm "/" và "." (an toàn làm id doc Firestore)
_PUBLIC_ID_RE = re.compile(r"[A-Za-z0-9_\-./]{1,255}")
_URL_PATH_RE = re.compile(r"/[A-Za-z0-9_\-./,:]+")
_URL_FORBIDDEN_RE = re.compile(r"[\s\x00-\x1f\x7f]")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")

# Cấu trúc URL giao hàng Cloudinary: /<cloud>/image/upload/[<biến đổi>/...][v<version>/]<public_id>[.<ext>]
_VERSION_RE = re.compile(r"v[0-9]{1,12}")
_TRANSFORM_SEGMENT_RE = re.compile(r"[a-z]{1,3}_[A-Za-z0-9_.:\-]+(?:,[a-z]{1,3}_[A-Za-z0-9_.:\-]+)*")  # vd w_200,f_webp
_PUBLIC_ID_SEGMENT_RE = re.compile(r"[A-Za-z0-9_\-]+")  # KHÔNG có dấu chấm: dấu chấm cuối cùng luôn là phần mở rộng
_ASSET_FILE_RE = re.compile(r"(?P<name>[A-Za-z0-9_\-]+)\.(?P<ext>webp|jpe?g|png)", re.IGNORECASE)
MAX_TRANSFORM_SEGMENTS = 5
MAX_PUBLIC_ID_SEGMENTS = 6
MAX_PUBLIC_ID_LENGTH = 255
ASSET_KEY_NAMESPACE = "image/upload/"


@dataclass(frozen=True)
class CloudinaryAsset:
    """Asset Cloudinary đã xác định được từ URL."""

    public_id: str  # định danh ỔN ĐỊNH (phân biệt hoa/thường như Cloudinary), không có version/biến đổi/đuôi file
    version: str
    extension: str


def asset_key(public_id: str) -> str:
    """Khóa sổ đăng ký asset: SHA-256 của public_id (Firestore cấm "/" trong id tài liệu; hash tránh mọi va chạm ký tự)."""
    return hashlib.sha256((ASSET_KEY_NAMESPACE + public_id).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ConfirmData:
    image_id: str
    urls: dict[str, str]  # thumbnail / medium / webp
    asset_ids: dict[str, str]  # public_id SUY RA từ URL cho cả 3 biến thể (đáng tin hơn *Id do client khai)
    public_ids: dict[str, str]  # *Id do client gửi (đã kiểm tra BẰNG đúng asset_ids); chỉ chứa khóa client có gửi
    original_size: int
    processing_ms: float
    file_name: str
    width: int | None
    height: int | None
    processed_size: int | None
    saved_percent: float | None


def _bad(detail: str) -> InvalidFileException:
    return InvalidFileException(detail)


def _as_int(value: Any, name: str, *, minimum: int, maximum: int | None = None) -> int:
    if isinstance(value, bool):
        raise _bad(f"Invalid {name}")
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise _bad(f"Invalid {name}")
        value = int(value)
    if not isinstance(value, int) or value < minimum or (maximum is not None and value > maximum):
        raise _bad(f"Invalid {name}")
    return value


def parse_cloudinary_url(raw: Any, cloud_name: str) -> CloudinaryAsset:
    """Phân tích URL giao hàng Cloudinary thành asset; mọi URL mập mờ hoặc lạ là `400 "Invalid cloudinary url"`.

    Chấp nhận: `https://res.cloudinary.com/<cloud>/image/upload/[biến đổi/]v<version>/[thư-mục/]<tên>.<webp|jpg|jpeg|png>`.
    Từ chối (không đoán): thiếu version (không phân biệt được biến đổi với thư mục), đoạn trước version không phải biến
    đổi, public_id có dấu chấm hoặc ký tự lạ, nhiều đoạn giống version trong public_id, URL ký (`s--...--`), mã hóa `%`.
    """
    err = _bad("Invalid cloudinary url")
    if not isinstance(raw, str) or not raw or len(raw) > MAX_URL_LENGTH or not raw.isascii() or _URL_FORBIDDEN_RE.search(raw):
        raise err
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError:
        raise err from None
    if parts.scheme != "https" or parts.hostname != CLOUDINARY_HOST or parts.username or parts.password:
        raise err
    if port is not None or parts.query or parts.fragment:
        raise err
    # Dạng chuẩn DUY NHẤT (chữ thường, không cổng, không userinfo): để chống lách kiểm tra "một URL chỉ thuộc một imageId"
    # bằng cách đổi cách viết (vd host viết hoa, `:443`).
    if not raw.startswith(f"https://{CLOUDINARY_HOST}/"):
        raise err
    if not _URL_PATH_RE.fullmatch(parts.path):
        raise err
    segments = parts.path.split("/")  # ["", <cloud>, "image", "upload", ...]
    if len(segments) < 5 or segments[1] != cloud_name or segments[2] != "image" or segments[3] != "upload":
        raise err
    rest = segments[4:]
    if any(seg in ("", ".", "..") for seg in rest):
        raise err

    version_index = next((i for i, seg in enumerate(rest) if _VERSION_RE.fullmatch(seg)), None)
    if version_index is None:
        raise err  # không có version: không phân biệt được "biến đổi" với "thư mục" => mập mờ, không đoán
    transforms, id_segments = rest[:version_index], rest[version_index + 1:]
    if len(transforms) > MAX_TRANSFORM_SEGMENTS or any(not _TRANSFORM_SEGMENT_RE.fullmatch(seg) for seg in transforms):
        raise err
    if not id_segments or len(id_segments) > MAX_PUBLIC_ID_SEGMENTS or any(_VERSION_RE.fullmatch(seg) for seg in id_segments):
        raise err
    *folders, last = id_segments
    match = _ASSET_FILE_RE.fullmatch(last)
    if match is None or any(not _PUBLIC_ID_SEGMENT_RE.fullmatch(seg) for seg in folders):
        raise err
    public_id = "/".join([*folders, match.group("name")])
    if len(public_id) > MAX_PUBLIC_ID_LENGTH:
        raise err
    return CloudinaryAsset(public_id=public_id, version=rest[version_index], extension=match.group("ext").lower())


def _validate_public_id(value: Any, name: str, expected: str) -> str:
    """`*Id` do client khai: phải đúng dạng VÀ bằng đúng public_id suy ra từ URL (không dùng so khớp 'kết thúc bằng')."""
    if (
        not isinstance(value, str)
        or not _PUBLIC_ID_RE.fullmatch(value)
        or ".." in value
        or value.startswith("/")
        or value.endswith("/")
    ):
        raise _bad(f"Invalid {name}")
    if value != expected:
        raise _bad("Invalid cloudinary url")  # mâu thuẫn với URL: không tin giá trị client khai
    return value


def _present(body: dict[str, Any], name: str) -> bool:
    return name in body and body[name] is not None


def parse_confirm_payload(body: Any) -> ConfirmData:
    """Validate toàn bộ payload. Raise `InvalidFileException` (400) khi sai."""
    if not isinstance(body, dict):
        raise _bad("Invalid body")

    for name in REQUIRED_FIELDS:
        if not _present(body, name):
            raise _bad(f"Missing field: {name}")

    image_id = body["imageId"]
    if not isinstance(image_id, str) or not _IMAGE_ID_RE.fullmatch(image_id):
        raise _bad("Invalid imageId")

    original_size = body["originalSize"]
    if isinstance(original_size, (int, float)) and not isinstance(original_size, bool) and math.isfinite(original_size):
        if original_size > settings.MAX_FILE_SIZE_BYTES:
            raise _bad("File too large")
    original_size = _as_int(original_size, "originalSize", minimum=1)

    processing_ms = body["processingMs"]
    if (
        isinstance(processing_ms, bool)
        or not isinstance(processing_ms, (int, float))
        or not math.isfinite(processing_ms)
        or processing_ms < 0
        or processing_ms > MAX_PROCESSING_MS
    ):
        raise _bad("Invalid processingMs")

    cloud_name = settings.CLOUDINARY_CLOUD_NAME
    urls: dict[str, str] = {}
    asset_ids: dict[str, str] = {}
    for key in VARIANT_KEYS:
        urls[key] = body[key]
        asset_ids[key] = parse_cloudinary_url(body[key], cloud_name).public_id

    public_ids: dict[str, str] = {}
    for key in VARIANT_KEYS:
        id_name = f"{key}Id"
        if _present(body, id_name):
            public_ids[key] = _validate_public_id(body[id_name], id_name, asset_ids[key])

    file_name = body.get("fileName") if _present(body, "fileName") else None
    if file_name is None:
        file_name = image_id
    else:
        if not isinstance(file_name, str):
            raise _bad("Invalid fileName")
        file_name = _CONTROL_RE.sub("", file_name).strip()
        if not file_name or len(file_name) > MAX_FILE_NAME_LENGTH:
            raise _bad("Invalid fileName")

    width = _as_int(body["width"], "width", minimum=1, maximum=MAX_DIMENSION) if _present(body, "width") else None
    height = _as_int(body["height"], "height", minimum=1, maximum=MAX_DIMENSION) if _present(body, "height") else None
    processed_size = _as_int(body["processedSize"], "processedSize", minimum=0) if _present(body, "processedSize") else None

    saved_percent = None
    if processed_size is not None:
        saved_percent = round((1 - processed_size / original_size) * 100, 1)

    return ConfirmData(
        image_id=image_id,
        urls=urls,
        asset_ids=asset_ids,
        public_ids=public_ids,
        original_size=original_size,
        processing_ms=processing_ms,
        file_name=file_name,
        width=width,
        height=height,
        processed_size=processed_size,
        saved_percent=saved_percent,
    )


def _result_fields(data: ConfirmData, server_time: Any) -> dict[str, Any]:
    """Các field mô tả kết quả DONE (dùng cho cả bản ghi mới lẫn hoàn tất bản ghi PENDING có sẵn)."""
    return {
        "status": "DONE",
        "provider": "cloudinary",
        "fileName": data.file_name,
        "original": {"size": data.original_size, "width": data.width, "height": data.height},
        "variants": dict(data.urls),
        "publicIds": dict(data.public_ids),  # *Id do client gửi (đã đối chiếu với URL)
        "assetIds": dict(data.asset_ids),  # public_id SUY RA từ URL: nguồn tin cậy cho dọn dẹp/xóa sau này
        "previewUrl": data.urls["thumbnail"],
        "processedSize": data.processed_size,
        "processingMs": data.processing_ms,
        "savedPercent": data.saved_percent,
        "errorReason": None,
        "updatedAt": server_time,
    }


def build_new_doc(uid: str, data: ConfirmData, server_time: Any) -> dict[str, Any]:
    """Bản ghi `images/{imageId}` mới. `ownerId` luôn là uid từ token."""
    doc = {"imageId": data.image_id, "ownerId": uid, "retryCount": 0, "createdAt": server_time}
    doc.update(_result_fields(data, server_time))
    return doc


def asset_claim_keys(data: ConfirmData) -> dict[str, str]:
    """{khóa sổ đăng ký: public_id} cho các asset DUY NHẤT của lần confirm (3 biến thể có thể dùng chung 1 public_id)."""
    return {asset_key(public_id): public_id for public_id in dict.fromkeys(data.asset_ids.values())}


def build_asset_claims(uid: str, data: ConfirmData, server_time: Any, skip_keys: Any = ()) -> dict[str, dict[str, Any]]:
    """Bản ghi sổ đăng ký asset cần tạo (bỏ các khóa đã thuộc chính imageId này). `ownerId` luôn là uid từ token."""
    return {
        key: {"publicId": public_id, "imageId": data.image_id, "ownerId": uid, "createdAt": server_time}
        for key, public_id in asset_claim_keys(data).items()
        if key not in skip_keys
    }


def build_completion_fields(data: ConfirmData, server_time: Any) -> dict[str, Any]:
    """Field cập nhật cho bản ghi đã có ở trạng thái chưa DONE (vd PENDING sau retry). Không đụng createdAt/retryCount."""
    return _result_fields(data, server_time)


def build_confirm_response(doc: dict[str, Any]) -> dict[str, Any]:
    """Response 200 theo CONTRACT mục 3.2. *Id chỉ xuất hiện khi đã lưu."""
    stored = doc.get("variants") or {}
    ids = doc.get("publicIds") or {}
    variants: dict[str, Any] = {}
    for key in VARIANT_KEYS:
        variants[key] = stored.get(key)
        if ids.get(key):
            variants[f"{key}Id"] = ids[key]
    return {
        "imageId": doc.get("imageId"),
        "status": doc.get("status"),
        "ownerId": doc.get("ownerId"),
        "variants": variants,
        "processingMs": doc.get("processingMs"),
        "savedPercent": doc.get("savedPercent"),
    }
