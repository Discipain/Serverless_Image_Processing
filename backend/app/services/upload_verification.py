"""Chính sách XÁC MINH asset Cloudinary cho confirm ở chế độ signed (H4B-3). THUẦN: không mạng, không Firestore, không log giá trị.

Đầu vào: response của Admin API (`{"resources": [...]}`) + grant (nguồn sự thật do BACKEND cấp). KHÔNG tin URL/bytes/format/kích thước do client gửi.

Mỗi trong ba asset phải thỏa TẤT CẢ (thiếu một trường bắt buộc => TỪ CHỐI, không đoán):
  1. Response có đúng 3 asset, mỗi public_id của grant đúng một lần; không asset lạ, không trùng.
  2. resource_type == "image", type == "upload" (đúng loại đã ký), format == "webp".
  3. bytes là số nguyên 1..MAX_FILE_SIZE và BẰNG bytes đã khai trong grant; width/height BẰNG khai báo trong grant.
  4. context.custom mang đúng app=hybrid, imageId, variant của asset đó; tags chứa "hybrid" và môi trường (đúng thứ authorize đã ký).
  5. created_at (ISO 8601 dạng ...Z) nằm trong [issuedAt - skew, min(expiresAt + skew, now + skew)]: asset có TRƯỚC grant (vd upload bị bỏ qua vì
     overwrite=false, trả existing:true) hoặc ra đời sau hạn grant đều bị từ chối.
  6. asset_id là 32 ký tự hex, ba asset_id khác nhau; version là số nguyên dương.
  7. secure_url do Cloudinary trả về phải qua đúng bộ phân tích URL của confirm (https, res.cloudinary.com, đúng cloud cấu hình, có version, không
     biến đổi) và cho ra đúng public_id + version + đuôi .webp. URL lưu vào Firestore là secure_url này, không phải URL client gửi.
GIỚI HẠN: `tags`/`context` KHÔNG chứng minh asset được upload bằng chữ ký (upload không ký cũng có thể gửi tags/context); H4B-7 phải khóa unsigned preset.
Hình dạng `context` ({"custom": {...}}) và việc Admin API có trả các trường trên hay không CHƯA kiểm chứng với Cloudinary thật.
"""
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from app.config import settings
from app.exceptions import InvalidFileException
from app.services.cloudinary_confirm import parse_cloudinary_url
from app.services.cloudinary_signing import VARIANTS

_ASSET_ID_RE = re.compile(r"[0-9a-f]{32}")
_CREATED_AT_FORMATS = ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%fZ")


class UploadVerificationError(Exception):
    """Bằng chứng upload không đạt. `reason` là mã ngắn cố định (an toàn để log); `missing` = thiếu asset (chưa upload xong/không có)."""

    def __init__(self, reason: str, *, missing: bool = False) -> None:
        super().__init__(reason)
        self.reason = reason
        self.missing = missing


@dataclass(frozen=True)
class VerifiedAsset:
    variant: str
    public_id: str
    asset_id: str
    version: int
    bytes: int
    width: int
    height: int
    secure_url: str
    created_at: datetime


def _aware(value: Any) -> datetime:
    if not isinstance(value, datetime):
        raise UploadVerificationError("grant_time_invalid")
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _int(value: Any, reason: str, *, minimum: int, maximum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or (maximum is not None and value > maximum):
        raise UploadVerificationError(reason)
    return value


def parse_created_at(value: Any) -> datetime:
    if not isinstance(value, str):
        raise UploadVerificationError("created_at_invalid")
    for fmt in _CREATED_AT_FORMATS:
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    raise UploadVerificationError("created_at_invalid")


def _string_set(value: Any, reason: str) -> set[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise UploadVerificationError(reason)
    return set(value)


def verify_uploaded_assets(response: Any, *, grant: dict[str, Any], cloud_name: str, now: datetime, skew_seconds: int) -> dict[str, VerifiedAsset]:
    """Trả {variant: VerifiedAsset} khi ĐẠT CẢ BA; ngược lại raise UploadVerificationError."""
    if not isinstance(response, dict) or not isinstance(response.get("resources"), list):
        raise UploadVerificationError("bad_response")
    public_ids = grant.get("publicIds")
    declared_variants = (grant.get("declared") or {}).get("variants")
    image_id = grant.get("imageId")
    if not isinstance(public_ids, dict) or set(public_ids) != set(VARIANTS) or not isinstance(declared_variants, dict) or not isinstance(image_id, str):
        raise UploadVerificationError("grant_invalid")
    issued_at, expires_at = _aware(grant.get("issuedAt")), _aware(grant.get("expiresAt"))
    environment = grant.get("environment")
    skew = timedelta(seconds=skew_seconds)
    now = _aware(now)

    by_public_id: dict[str, dict[str, Any]] = {}
    expected = {public_ids[v]: v for v in VARIANTS}
    for entry in response["resources"]:
        pid = entry.get("public_id") if isinstance(entry, dict) else None
        if not isinstance(pid, str):
            raise UploadVerificationError("bad_response")
        if pid in by_public_id:
            raise UploadVerificationError("duplicate_asset")
        if pid not in expected:
            raise UploadVerificationError("unexpected_asset")
        by_public_id[pid] = entry
    if len(by_public_id) != len(expected):
        raise UploadVerificationError("missing_asset", missing=True)

    verified: dict[str, VerifiedAsset] = {}
    for variant in VARIANTS:
        pid = public_ids[variant]
        entry = by_public_id[pid]
        declared = declared_variants.get(variant)
        if not isinstance(declared, dict):
            raise UploadVerificationError("grant_invalid")

        if entry.get("resource_type") != "image" or entry.get("type") != "upload":
            raise UploadVerificationError("resource_kind")
        if entry.get("format") != "webp":
            raise UploadVerificationError("format")

        size = _int(entry.get("bytes"), "bytes", minimum=1, maximum=settings.MAX_FILE_SIZE_BYTES)
        if size != declared.get("bytes"):
            raise UploadVerificationError("bytes_mismatch")
        width = _int(entry.get("width"), "dimensions", minimum=1)
        height = _int(entry.get("height"), "dimensions", minimum=1)
        if width != declared.get("width") or height != declared.get("height"):
            raise UploadVerificationError("dimensions_mismatch")

        context = entry.get("context")
        custom = context.get("custom") if isinstance(context, dict) else None
        if not isinstance(custom, dict) or custom.get("app") != "hybrid" or custom.get("imageId") != image_id or custom.get("variant") != variant:
            raise UploadVerificationError("context_mismatch")
        tags = _string_set(entry.get("tags"), "tags_mismatch")
        if not {"hybrid", environment} <= tags:
            raise UploadVerificationError("tags_mismatch")

        created_at = parse_created_at(entry.get("created_at"))
        if created_at < issued_at - skew or created_at > min(expires_at + skew, now + skew):
            raise UploadVerificationError("created_at_out_of_window")

        asset_id = entry.get("asset_id")
        if not isinstance(asset_id, str) or not _ASSET_ID_RE.fullmatch(asset_id):
            raise UploadVerificationError("asset_id_invalid")
        version = _int(entry.get("version"), "version_invalid", minimum=1)

        secure_url = entry.get("secure_url")
        try:
            parsed = parse_cloudinary_url(secure_url, cloud_name)
        except InvalidFileException:
            raise UploadVerificationError("secure_url_invalid") from None
        if parsed.public_id != pid or parsed.version != f"v{version}" or parsed.extension != "webp":
            raise UploadVerificationError("secure_url_mismatch")

        verified[variant] = VerifiedAsset(variant, pid, asset_id, version, size, width, height, secure_url, created_at)

    if len({a.asset_id for a in verified.values()}) != len(verified):
        raise UploadVerificationError("asset_id_duplicate")
    return verified
