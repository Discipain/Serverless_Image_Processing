"""POST /images/cloudinary/authorize (H4B-2): cấp quyền upload có chữ ký Cloudinary.

CHỈ làm: kiểm tra payload -> tạo/đọc `uploadGrants/{imageId}` -> ký 3 bộ tham số do BACKEND quyết định. KHÔNG gọi Cloudinary (kể cả Admin API),
KHÔNG tạo ảnh DONE, KHÔNG đụng POST /images/cloudinary/confirm (H4B-3 mới xác minh asset, chuyển ISSUED -> CONFIRMED và chặn confirm không có grant).
Vì vậy H4B-2 KHÔNG phải luồng upload bảo mật hoàn chỉnh.

Bảo đảm của file này:
  - UID chỉ lấy từ Firebase token (tham số `uid`); client không gửi UID, public_id, folder, URL hay tham số chữ ký (field lạ => 400).
  - Một imageId chỉ thuộc MỘT chủ: grant tạo bằng `create` có điều kiện (tranh chấp đồng thời: đúng một bên thắng, bên kia 403).
  - Giới hạn tốc độ nguyên tử: tối đa `UPLOAD_GRANTS_PER_HOUR` grant MỚI mỗi người mỗi giờ (cửa sổ cố định theo giờ), nhờ tài liệu "slot" tạo cùng batch
    với grant. Gọi lại cùng imageId KHÔNG tốn slot. Cửa sổ cố định => có thể dồn tối đa 2 × giới hạn quanh ranh giới giờ.
  - Tính năng MẶC ĐỊNH TẮT; thiếu/sai cấu hình => fail closed (503, không tạo grant, không lộ tên/giá trị cấu hình).
Giới hạn: kích thước client khai KHÔNG chứng minh kích thước thực tế upload; TTL grant KHÔNG thu hồi chữ ký Cloudinary đã cấp (còn hiệu lực ~1 giờ phía
Cloudinary): confirm (H4B-3) phải tự kiểm tra `expiresAt`.
Kiểm tra imageId chưa thuộc ảnh nào là "đọc rồi ghi" giữa hai collection (không nguyên tử); H4B-3 phải chặn hướng ngược lại ở confirm.
"""
import hashlib
import logging
import random
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from app.config import settings
from app.exceptions import (
    ConflictException,
    ForbiddenAccessException,
    InvalidFileException,
    SignedUploadUnavailableException,
    StorageUnavailableException,
    TooManyRequestsException,
)
from app.repositories.image_repository import image_repo
from app.services.upload_mode import authorize_allowed
from app.services.cloudinary_signing import (
    UUID_V4_RE,
    VARIANTS,
    SigningConfig,
    SigningConfigError,
    build_public_ids,
    build_signed_upload,
)

logger = logging.getLogger(__name__)

GRANT_STATUS_ISSUED = "ISSUED"
GRANT_SCHEMA_VERSION = 1
SLOT_WINDOW_SECONDS = 3600

TOP_REQUIRED = frozenset({"imageId", "originalSize", "variants"})
TOP_OPTIONAL = frozenset({"fileName", "width", "height"})
VARIANT_FIELDS = frozenset({"bytes", "width", "height"})
MAX_FILE_NAME_LENGTH = 255
MAX_DIMENSION = 65535  # cùng giới hạn của confirm
VARIANT_MAX_SIDE = {"thumbnail": 200, "medium": 800, "webp": MAX_DIMENSION}  # CONTRACT: thumb 200, medium 800, full không giới hạn riêng
MAX_TTL_SECONDS = 3600
MAX_GRANTS_PER_HOUR = 100
MAX_ATTEMPTS = 10  # số vòng đọc-rồi-tạo tối đa khi thua cuộc đua hoặc bị tranh chấp khóa (Firestore `Aborted`)
MAX_BACKOFF_SECONDS = 0.4

# Ký tự nguy hiểm trong tên file: điều khiển, dấu phân cách đường dẫn, và ký tự đảo chiều hiển thị (giả mạo đuôi file).
_FILE_NAME_FORBIDDEN = re.compile("[\x00-\x1f\x7f/\\\\‎‏‪-‮⁦-⁩]")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: Any) -> datetime:
    if not isinstance(value, datetime):
        raise StorageUnavailableException()  # dữ liệu grant hỏng: không đoán
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _iso(value: datetime) -> str:
    return _aware(value).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _bad(detail: str) -> InvalidFileException:
    return InvalidFileException(detail)


def _int(value: Any, name: str, *, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
        raise _bad(f"Invalid {name}")
    return value


def parse_authorize_payload(body: Any) -> dict[str, Any]:
    """Kiểm tra NGHIÊM và chuẩn hóa payload. Field lạ ở BẤT KỲ cấp nào => 400 (không có đường nào đưa dữ liệu client vào chữ ký)."""
    if not isinstance(body, dict):
        raise _bad("Invalid body")
    for name in TOP_REQUIRED:
        if body.get(name) is None:
            raise _bad(f"Missing field: {name}")
    if set(body) - TOP_REQUIRED - TOP_OPTIONAL:
        raise _bad("Unknown field")

    image_id = body["imageId"]
    if not isinstance(image_id, str) or not UUID_V4_RE.fullmatch(image_id):
        raise _bad("Invalid imageId")

    file_name = None
    if body.get("fileName") is not None:
        raw = body["fileName"]
        if not isinstance(raw, str):
            raise _bad("Invalid fileName")
        file_name = raw.strip()
        if not file_name or len(file_name) > MAX_FILE_NAME_LENGTH or _FILE_NAME_FORBIDDEN.search(file_name):
            raise _bad("Invalid fileName")

    max_bytes = settings.MAX_FILE_SIZE_BYTES  # đọc tại thời điểm gọi
    original_size = _int(body["originalSize"], "originalSize", minimum=1, maximum=max_bytes)
    width = _int(body["width"], "width", minimum=1, maximum=MAX_DIMENSION) if body.get("width") is not None else None
    height = _int(body["height"], "height", minimum=1, maximum=MAX_DIMENSION) if body.get("height") is not None else None

    raw_variants = body["variants"]
    if not isinstance(raw_variants, dict) or set(raw_variants) != set(VARIANTS):
        raise _bad("Invalid variants")  # đúng ba biến thể thumbnail/medium/webp, không hơn không kém
    variants: dict[str, dict[str, int]] = {}
    for name in VARIANTS:
        item = raw_variants[name]
        if not isinstance(item, dict) or set(item) != VARIANT_FIELDS:
            raise _bad(f"Invalid variant: {name}")
        w = _int(item["width"], f"variant {name} width", minimum=1, maximum=MAX_DIMENSION)
        h = _int(item["height"], f"variant {name} height", minimum=1, maximum=MAX_DIMENSION)
        if max(w, h) > VARIANT_MAX_SIDE[name]:
            raise _bad(f"Invalid variant {name} size")
        variants[name] = {"bytes": _int(item["bytes"], f"variant {name} bytes", minimum=1, maximum=max_bytes), "width": w, "height": h}

    return {"imageId": image_id, "fileName": file_name, "originalSize": original_size, "width": width, "height": height, "variants": variants}


def _declared(payload: dict[str, Any]) -> dict[str, Any]:
    """Phần metadata KHAI BÁO được lưu trong grant và so sánh khi gọi lại (không gồm imageId)."""
    return {key: payload[key] for key in ("fileName", "originalSize", "width", "height", "variants")}


class UploadAuthorizationService:
    def __init__(self, repo: Any = None, clock: Callable[[], datetime] | None = None, rng: random.Random | None = None, sleep: Callable[[float], None] | None = None) -> None:
        self._repo = repo
        self._clock = clock or _utcnow
        self._rng = rng or random.SystemRandom()
        self._sleep = sleep or time.sleep

    @property
    def repo(self) -> Any:
        return self._repo if self._repo is not None else image_repo

    # ----- cấu hình (fail closed) -----
    @staticmethod
    def _unavailable() -> SignedUploadUnavailableException:
        return SignedUploadUnavailableException()

    def _config(self) -> tuple[SigningConfig, int, int]:
        if not authorize_allowed(settings):
            raise self._unavailable()  # tắt, hoặc confirm chưa ở chế độ "signed" (mâu thuẫn): không grant, không chữ ký
        try:
            signing = SigningConfig.from_settings(settings)
        except SigningConfigError:
            logger.error("Cấu hình ký upload thiếu hoặc sai (tính năng bị chặn).")  # không ghi tên/giá trị
            raise self._unavailable() from None
        ttl, per_hour = getattr(settings, "UPLOAD_GRANT_TTL_SECONDS", None), getattr(settings, "UPLOAD_GRANTS_PER_HOUR", None)
        if any(isinstance(v, bool) or not isinstance(v, int) for v in (ttl, per_hour)) or not 1 <= ttl <= MAX_TTL_SECONDS or not 1 <= per_hour <= MAX_GRANTS_PER_HOUR:
            logger.error("Giới hạn grant upload sai (tính năng bị chặn).")
            raise self._unavailable()
        return signing, ttl, per_hour

    # ----- API -----
    def authorize(self, uid: str, body: Any) -> dict[str, Any]:
        signing, ttl, per_hour = self._config()
        payload = parse_authorize_payload(body)
        image_id = payload["imageId"]
        now = self._clock()

        for attempt in range(MAX_ATTEMPTS):  # >1 vòng chỉ khi thua cuộc đua tạo grant hoặc bị tranh chấp khóa: đọc lại grant của bên thắng
            grant = self.repo.get_upload_grant(image_id)
            if grant is not None:
                return self._respond_existing(signing, uid, payload, grant, now)
            self._ensure_image_free(uid, image_id)
            outcome = self._create_grant(signing, uid, payload, now, ttl, per_hour)
            if outcome == "created":
                return self._respond(signing, self._read_back(image_id), now)
            if outcome == "contention":  # Firestore `Aborted`: commit chưa được áp dụng; chờ ngẫu nhiên ngắn rồi đọc lại
                self._sleep(self._rng.uniform(0, min(MAX_BACKOFF_SECONDS, 0.03 * 2 ** attempt)))
                continue
            if outcome == "rate_limited":
                retry_after = ((int(now.timestamp()) // SLOT_WINDOW_SECONDS) + 1) * SLOT_WINDOW_SECONDS - int(now.timestamp())
                raise TooManyRequestsException("Too many upload authorizations", retry_after_seconds=retry_after)
        raise StorageUnavailableException()  # tranh chấp kéo dài: fail closed, client thử lại sau

    # ----- nội bộ -----
    def _read_back(self, image_id: str) -> dict[str, Any]:
        grant = self.repo.get_upload_grant(image_id)
        if grant is None:
            raise StorageUnavailableException()
        return grant

    def _ensure_image_free(self, uid: str, image_id: str) -> None:
        """imageId không được đã thuộc một ảnh hiện hữu: ảnh của người khác => 403; ảnh của chính mình => 409. KHÔNG tạo/ghi đè ảnh."""
        existing = self.repo.get_by_id(image_id)
        if existing is not None:
            if existing.get("ownerId") != uid:
                raise ForbiddenAccessException("Forbidden")
            raise ConflictException("Image already exists")

    def _respond_existing(self, signing: SigningConfig, uid: str, payload: dict[str, Any], grant: dict[str, Any], now: datetime) -> dict[str, Any]:
        if grant.get("ownerId") != uid:
            raise ForbiddenAccessException("Forbidden")  # không lộ chủ sở hữu
        self._ensure_image_free(uid, payload["imageId"])
        if now >= _aware(grant.get("expiresAt")):
            raise ConflictException("Upload grant expired")  # không cấp chữ ký mới: dùng imageId mới
        if grant.get("status") != GRANT_STATUS_ISSUED:
            raise ConflictException("Upload grant is not active")
        if grant.get("declared") != _declared(payload):
            raise ConflictException("Upload parameters differ from the existing grant")  # không sửa grant cũ
        return self._respond(signing, grant, now)

    def _create_grant(self, signing: SigningConfig, uid: str, payload: dict[str, Any], now: datetime, ttl: int, per_hour: int) -> str:
        grant = {
            "imageId": payload["imageId"],
            "ownerId": uid,
            "status": GRANT_STATUS_ISSUED,
            "schemaVersion": GRANT_SCHEMA_VERSION,
            "environment": signing.environment,
            "publicIds": build_public_ids(signing.environment, payload["imageId"]),
            "declared": _declared(payload),
            "issuedAt": now,
            "expiresAt": now + timedelta(seconds=ttl),
        }
        bucket = int(now.timestamp()) // SLOT_WINDOW_SECONDS
        owner_key = hashlib.sha256(uid.encode("utf-8")).hexdigest()[:32]
        start = self._rng.randrange(per_hour)
        for offset in range(per_hour):  # mỗi slot thử tối đa một lần: chỉ báo hết lượt khi THẤY đủ `per_hour` slot đã bị chiếm
            n = (start + offset) % per_hour
            slot = {
                "ownerId": uid,
                "imageId": payload["imageId"],
                "bucket": bucket,
                "slot": n,
                "issuedAt": now,
                "expireAt": now + timedelta(seconds=SLOT_WINDOW_SECONDS * 2),  # dành cho chính sách TTL của Firestore (chưa bật)
            }
            outcome = self.repo.create_upload_grant(grant, f"{owner_key}_{bucket}_{n}", slot)
            if outcome != "slot_taken":
                return outcome
        return "rate_limited"

    def _respond(self, signing: SigningConfig, grant: dict[str, Any], now: datetime) -> dict[str, Any]:
        image_id = grant["imageId"]
        expected = build_public_ids(signing.environment, image_id)
        if grant.get("publicIds") != expected:
            raise ConflictException("Upload grant environment mismatch")  # cấu hình đổi sau khi cấp: không ký public_id khác với grant
        timestamp = int(now.timestamp())
        uploads = {variant: {"fields": build_signed_upload(signing, image_id=image_id, variant=variant, timestamp=timestamp)} for variant in VARIANTS}
        for variant in VARIANTS:  # tự kiểm: public_id được ký đúng là public_id trong grant
            if uploads[variant]["fields"]["public_id"] != grant["publicIds"][variant]:
                raise StorageUnavailableException()
        return {
            "imageId": image_id,
            "expiresAt": _iso(grant["expiresAt"]),
            "uploadUrl": signing.upload_url,
            "apiKey": signing.api_key,
            "uploads": uploads,
        }


upload_authorization_service = UploadAuthorizationService()
