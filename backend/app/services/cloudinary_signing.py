"""Ký tham số upload Cloudinary (H4B-2). THUẦN: không mạng, không đọc Firestore, không ghi log.

Backend TỰ quyết định toàn bộ tham số được ký; client không gửi `public_id`, `overwrite`, folder, URL hay bất kỳ tham số chữ ký nào.
Tập tham số ký bị khóa bằng danh sách trắng `SIGNED_KEYS` (thêm khóa lạ => lỗi, không bao giờ ký âm thầm).

Quy tắc chữ ký (tài liệu Cloudinary "Generating authentication signatures"): bỏ `file`, `cloud_name`, `resource_type`, `api_key`;
sắp xếp `tên=giá trị` theo tên, nối bằng `&`, nối thẳng `api_secret`, băm SHA-1 hoặc SHA-256. Dùng đúng helper CHÍNH THỨC của SDK
(`cloudinary.utils.api_sign_request`) với thuật toán truyền TƯỜNG MINH (không phụ thuộc cấu hình toàn cục của SDK). SDK ký SHA-256 chỉ gửi
`signature` + `api_key` + các tham số (không có trường `signature_algorithm` trong request), nên response cũng vậy.
Việc Cloudinary THẬT chấp nhận SHA-256 chưa được kiểm chứng ở bước này (xem H4B-7).

Giới hạn cần nhớ: chữ ký KHÔNG ràng buộc nội dung/kích thước file, và hiệu lực phía Cloudinary ~1 giờ kể từ `timestamp` bất kể TTL của grant.
"""
import re
from dataclasses import dataclass, field
from typing import Any

from cloudinary.utils import api_sign_request

UUID_V4_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")  # đúng dạng crypto.randomUUID() của Frontend
ENVIRONMENT_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,19}")
CLOUD_NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
API_KEY_RE = re.compile(r"[A-Za-z0-9_-]{4,64}")
ALGORITHMS = ("sha1", "sha256")
MIN_SECRET_LENGTH = 8

# Danh sách trắng các tham số được ký. `api_key` và `signature` chỉ được THÊM vào response SAU khi ký.
SIGNED_KEYS = frozenset({"public_id", "timestamp", "overwrite", "allowed_formats", "context", "tags"})
# Giá trị ký chỉ gồm ký tự an toàn (không có `&`, khoảng trắng...) để chuỗi cần ký không thể mơ hồ.
_SAFE_VALUE_RE = re.compile(r"[A-Za-z0-9_\-/|=,]+")

VARIANTS = ("thumbnail", "medium", "webp")
VARIANT_PATH = {"thumbnail": "thumb", "medium": "medium", "webp": "full"}
PUBLIC_ID_PREFIX = "hybrid"
UPLOAD_ALLOWED_FORMATS = "webp"


class SigningConfigError(Exception):
    """Cấu hình ký thiếu/sai. Thông điệp chỉ chứa TÊN biến, không bao giờ chứa giá trị."""


@dataclass(frozen=True)
class SigningConfig:
    cloud_name: str
    api_key: str
    api_secret: str = field(repr=False)
    environment: str = "dev"
    algorithm: str = "sha256"

    def __repr__(self) -> str:  # không bao giờ in secret/khóa
        return f"SigningConfig(cloud_name={self.cloud_name!r}, environment={self.environment!r}, algorithm={self.algorithm!r}, api_key=<ẩn>, api_secret=<ẩn>)"

    @property
    def upload_url(self) -> str:
        return f"https://api.cloudinary.com/v1_1/{self.cloud_name}/image/upload"

    @classmethod
    def from_settings(cls, settings: Any) -> "SigningConfig":
        """Đọc và kiểm tra cấu hình. Sai/thiếu => SigningConfigError (fail closed)."""
        bad: list[str] = []
        cloud = getattr(settings, "CLOUDINARY_CLOUD_NAME", "")
        key = getattr(settings, "CLOUDINARY_API_KEY", "")
        secret = getattr(settings, "CLOUDINARY_API_SECRET", "")
        env = getattr(settings, "UPLOAD_ENVIRONMENT", "")
        algo = str(getattr(settings, "CLOUDINARY_SIGNATURE_ALGORITHM", "")).strip().lower()
        if not (isinstance(cloud, str) and CLOUD_NAME_RE.fullmatch(cloud)):
            bad.append("CLOUDINARY_CLOUD_NAME")
        if not (isinstance(key, str) and API_KEY_RE.fullmatch(key)):
            bad.append("CLOUDINARY_API_KEY")
        if not (isinstance(secret, str) and len(secret) >= MIN_SECRET_LENGTH and not re.search(r"\s", secret)):
            bad.append("CLOUDINARY_API_SECRET")
        if not (isinstance(env, str) and ENVIRONMENT_RE.fullmatch(env)):
            bad.append("UPLOAD_ENVIRONMENT")
        if algo not in ALGORITHMS:
            bad.append("CLOUDINARY_SIGNATURE_ALGORITHM")
        if bad:
            raise SigningConfigError("Cấu hình ký upload thiếu hoặc sai: " + ", ".join(bad))
        return cls(cloud_name=cloud, api_key=key, api_secret=secret, environment=env, algorithm=algo)


def build_public_ids(environment: str, image_id: str) -> dict[str, str]:
    """Ba public_id XÁC ĐỊNH TRƯỚC từ imageId (không chứa UID): hybrid/<môi trường>/<imageId>/(thumb|medium|full)."""
    if not ENVIRONMENT_RE.fullmatch(environment or ""):
        raise SigningConfigError("UPLOAD_ENVIRONMENT sai.")
    if not UUID_V4_RE.fullmatch(image_id or ""):
        raise ValueError("imageId không phải UUID v4 chữ thường.")
    return {variant: f"{PUBLIC_ID_PREFIX}/{environment}/{image_id}/{VARIANT_PATH[variant]}" for variant in VARIANTS}


def build_params_to_sign(config: SigningConfig, *, image_id: str, variant: str, timestamp: int) -> dict[str, str]:
    """Tham số sẽ được ký — DO BACKEND QUYẾT ĐỊNH. `context`/`tags` phục vụ audit và dọn rác theo thẻ (không chứa UID)."""
    if variant not in VARIANT_PATH:
        raise ValueError("Biến thể không hợp lệ.")
    if isinstance(timestamp, bool) or not isinstance(timestamp, int) or timestamp <= 0:
        raise ValueError("timestamp phải là số nguyên dương (giây Unix).")
    params = {
        "public_id": build_public_ids(config.environment, image_id)[variant],
        "timestamp": str(timestamp),
        "overwrite": "false",  # KHÔNG ghi đè asset đã tồn tại (mặc định của upload có ký là true)
        "allowed_formats": UPLOAD_ALLOWED_FORMATS,
        "context": f"app={PUBLIC_ID_PREFIX}|imageId={image_id}|variant={variant}",
        "tags": f"{PUBLIC_ID_PREFIX},{config.environment}",
    }
    _assert_signable(params)
    return params


def _assert_signable(params: dict[str, str]) -> None:
    extra = set(params) - SIGNED_KEYS
    if extra:
        raise ValueError(f"Tham số không nằm trong danh sách trắng được ký: {sorted(extra)}")
    for name, value in params.items():
        if not isinstance(value, str) or not _SAFE_VALUE_RE.fullmatch(value):
            raise ValueError(f"Giá trị tham số '{name}' không an toàn để ký.")  # không in giá trị


def sign_params(params: dict[str, str], api_secret: str, algorithm: str) -> str:
    """Chữ ký hex của `params` (đã qua danh sách trắng) bằng helper chính thức của SDK, thuật toán tường minh."""
    _assert_signable(params)
    if algorithm not in ALGORITHMS:
        raise ValueError("Thuật toán chữ ký không được hỗ trợ.")
    return api_sign_request(dict(params), api_secret, algorithm)


def build_signed_upload(config: SigningConfig, *, image_id: str, variant: str, timestamp: int) -> dict[str, str]:
    """Các trường form (multipart) client phải gửi NGUYÊN VĂN, cùng `file`: tham số đã ký + `api_key` + `signature`."""
    params = build_params_to_sign(config, image_id=image_id, variant=variant, timestamp=timestamp)
    signature = sign_params(params, config.api_secret, config.algorithm)
    return {**params, "api_key": config.api_key, "signature": signature}
