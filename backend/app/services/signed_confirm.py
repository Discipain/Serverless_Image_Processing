"""Confirm ở chế độ SIGNED (H4B-3): BẮT BUỘC upload grant + xác minh asset bằng Cloudinary Admin API + ghi nguyên tử có điều kiện.

Luồng (không có đường rơi về legacy; mọi thiếu sót => từ chối hoặc 503):
  1. Cấu hình (cloud/key/secret/môi trường, timeout, ngân sách) sai/thiếu => 503 "Signed upload unavailable" (không lộ tên/giá trị).
  2. Đọc grant. Không có => 403; sai chủ => 403 "Forbidden" (không lộ chủ); public_id trong URL client gửi khác grant => 400;
     metadata client gửi khác grant => 409; grant ISSUED hết hạn => 409; trạng thái khác ISSUED/CONFIRMED => 409.
  3. Grant ISSUED: gọi Admin API MỘT lần (ngoài mọi thao tác ghi, không retry), kiểm tra bằng chứng (xem upload_verification). Bất kỳ trường thiếu/sai => 409.
     Grant CONFIRMED: KHÔNG gọi Admin API; chỉ trả lại kết quả cũ nếu ảnh + sổ asset nhất quán với grant và payload KHÔNG khác lần đã xác nhận.
  4. `run_signed_confirm`: đọc lại grant/ảnh/asset, KIỂM TRA LẠI mọi điều kiện (chủ, hạn grant tại thời điểm này, trạng thái, ảnh chưa tồn tại, asset chưa bị
     đăng ký) rồi ghi ảnh DONE + 3 asset + grant ISSUED->CONFIRMED trong MỘT WriteBatch có điều kiện. Tranh chấp => đọc lại, quyết định lại; Admin API không bao giờ
     bị gọi lại trong vòng này.
URL lưu vào Firestore là `secure_url` do Cloudinary trả về, bytes/kích thước lấy từ Cloudinary; không tin giá trị client gửi.

GIỚI HẠN: hạn grant được kiểm tra bằng đồng hồ của Backend ngay trước commit (không thể ràng buộc nguyên tử với thời gian); `processingMs` là số liệu client khai,
không xác minh được; tags/context không chứng minh asset được upload bằng chữ ký (H4B-7 phải khóa unsigned preset).
"""
import logging
import time
from datetime import datetime, timezone
from typing import Any, Callable

from app.config import settings
from app.exceptions import (
    ConflictException,
    ForbiddenAccessException,
    InvalidFileException,
    SignedUploadUnavailableException,
    StorageUnavailableException,
    UploadVerificationUnavailableException,
)
from app.repositories.image_repository import ConfirmPlan, image_repo
from app.services.cloudinary_admin import (
    AdminConfigError,
    AdminError,
    AdminNotFound,
    AdminRateLimited,
    CloudinaryAdminClient,
    HttpCloudinaryAdminClient,
)
from app.services.cloudinary_confirm import (
    VARIANT_KEYS,
    ConfirmData,
    asset_claim_keys,
    asset_key,
    build_confirm_response,
    parse_cloudinary_url,
    parse_confirm_payload,
)
from app.services.cloudinary_signing import SigningConfig, SigningConfigError, build_public_ids
from app.services.upload_verification import UploadVerificationError, VerifiedAsset, verify_uploaded_assets

logger = logging.getLogger(__name__)

STATUS_ISSUED = "ISSUED"
STATUS_CONFIRMED = "CONFIRMED"
MIN_ADMIN_TIMEOUT, MAX_ADMIN_TIMEOUT = 0.5, 10.0
MIN_BUDGET, MAX_BUDGET = 5.0, 28.0
MAX_SKEW = 600
COMMIT_RESERVE_SECONDS = 3.0  # phần ngân sách dành lại cho bước ghi sau khi gọi Admin API

DIFFERS = "Confirm parameters differ from the upload grant"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: Any) -> datetime:
    if not isinstance(value, datetime):
        raise StorageUnavailableException()  # dữ liệu grant hỏng: không đoán
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _number(value: Any, minimum: float, maximum: float) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and minimum <= value <= maximum


class SignedConfirmService:
    def __init__(
        self,
        repo: Any = None,
        admin_factory: Callable[[SigningConfig], CloudinaryAdminClient] | None = None,
        clock: Callable[[], datetime] | None = None,
        monotonic: Callable[[], float] | None = None,
    ) -> None:
        self._repo = repo
        self._admin_factory = admin_factory or (lambda cfg: HttpCloudinaryAdminClient(cfg.cloud_name, cfg.api_key, cfg.api_secret))
        self._clock = clock or _utcnow
        self._mono = monotonic or time.monotonic

    @property
    def repo(self) -> Any:
        return self._repo if self._repo is not None else image_repo

    # ----- cấu hình (fail closed) -----
    def _config(self) -> tuple[SigningConfig, float, float, int]:
        try:
            signing = SigningConfig.from_settings(settings)
        except SigningConfigError:
            logger.error("Cấu hình xác minh upload thiếu hoặc sai (confirm signed bị chặn).")  # không ghi tên/giá trị
            raise SignedUploadUnavailableException() from None
        admin_timeout = getattr(settings, "CLOUDINARY_ADMIN_TIMEOUT_SECONDS", None)
        budget = getattr(settings, "UPLOAD_CONFIRM_BUDGET_SECONDS", None)
        skew = getattr(settings, "UPLOAD_VERIFY_CLOCK_SKEW_SECONDS", None)
        if (
            not _number(admin_timeout, MIN_ADMIN_TIMEOUT, MAX_ADMIN_TIMEOUT)
            or not _number(budget, MIN_BUDGET, MAX_BUDGET)
            or isinstance(skew, bool)
            or not isinstance(skew, int)
            or not 0 <= skew <= MAX_SKEW
        ):
            logger.error("Giới hạn thời gian xác minh upload sai (confirm signed bị chặn).")
            raise SignedUploadUnavailableException()
        return signing, float(admin_timeout), float(budget), skew

    # ----- API -----
    def confirm_payload(self, uid: str, body: Any) -> dict[str, Any]:
        """Điểm vào từ route: kiểm tra cấu hình TRƯỚC khi đọc payload (cấu hình sai => 503 chứ không phải 400 khó hiểu)."""
        self._config()
        return self.confirm(uid, parse_confirm_payload(body))

    def confirm(self, uid: str, data: ConfirmData) -> dict[str, Any]:
        signing, admin_timeout, budget, skew = self._config()
        deadline = self._mono() + budget

        grant = self.repo.get_upload_grant(data.image_id)
        self._check_grant(uid, data, grant, self._clock(), signing)

        verified: dict[str, VerifiedAsset] | None = None
        if grant["status"] == STATUS_ISSUED:
            verified = self._verify(data, grant, signing, admin_timeout, skew, deadline)
            if data.processed_size is not None and data.processed_size != verified["webp"].bytes:
                raise ConflictException(DIFFERS)  # processedSize client khai khác bytes thật của asset webp
            for v in VARIANT_KEYS:  # URL client gửi phải trỏ đúng phiên bản asset mà Cloudinary đang giữ (asset bị thay sau khi upload => từ chối)
                if parse_cloudinary_url(data.urls[v], signing.cloud_name).version != f"v{verified[v].version}":
                    logger.warning("Phiên bản asset khác URL client gửi (imageId %s, %s).", data.image_id, v)
                    raise ConflictException("Uploaded assets do not match the upload grant")

        decide = self._make_decide(uid, data, signing, grant, verified)
        return self.repo.run_signed_confirm(data.image_id, list(asset_claim_keys(data)), decide, deadline=deadline)

    # ----- kiểm tra grant + payload -----
    def _check_grant(self, uid: str, data: ConfirmData, grant: dict[str, Any] | None, now: datetime, signing: SigningConfig) -> None:
        if grant is None:
            raise ForbiddenAccessException("Upload authorization required")
        if grant.get("ownerId") != uid:
            raise ForbiddenAccessException("Forbidden")  # không lộ chủ sở hữu
        public_ids = grant.get("publicIds")
        if not isinstance(public_ids, dict) or public_ids != build_public_ids(signing.environment, data.image_id):
            raise ConflictException("Upload grant environment mismatch")
        if any(data.asset_ids[v] != public_ids[v] for v in VARIANT_KEYS):
            raise InvalidFileException("Invalid cloudinary url")  # URL client gửi trỏ tới asset khác với grant
        self._check_declared(data, grant)
        status = grant.get("status")
        if status == STATUS_ISSUED:
            if now >= _aware(grant.get("expiresAt")):
                raise ConflictException("Upload grant expired")
        elif status != STATUS_CONFIRMED:
            raise ConflictException("Upload grant is not active")

    @staticmethod
    def _check_declared(data: ConfirmData, grant: dict[str, Any]) -> None:
        """Payload không được mâu thuẫn với những gì đã khai ở authorize (lưu trong grant)."""
        declared = grant.get("declared")
        if not isinstance(declared, dict):
            raise StorageUnavailableException()
        if data.original_size != declared.get("originalSize"):
            raise ConflictException(DIFFERS)
        # Bỏ qua trường thì được (dùng giá trị đã khai); đã gửi thì phải BẰNG giá trị đã khai (gửi cái chưa từng khai cũng là khác).
        if (data.width is not None and data.width != declared.get("width")) or (data.height is not None and data.height != declared.get("height")):
            raise ConflictException(DIFFERS)
        if data.file_name != data.image_id and data.file_name != declared.get("fileName"):  # fileName = imageId nghĩa là payload không gửi
            raise ConflictException(DIFFERS)

    # ----- Admin API -----
    def _verify(self, data: ConfirmData, grant: dict[str, Any], signing: SigningConfig, admin_timeout: float, skew: int, deadline: float) -> dict[str, VerifiedAsset]:
        remaining = deadline - self._mono() - COMMIT_RESERVE_SECONDS
        if remaining < MIN_ADMIN_TIMEOUT:
            logger.warning("Hết ngân sách trước khi gọi Admin API.")
            raise UploadVerificationUnavailableException()
        timeout = min(admin_timeout, remaining)
        public_ids = [grant["publicIds"][v] for v in VARIANT_KEYS]
        try:
            response = self._admin_factory(signing).get_resources(public_ids, timeout=timeout)
        except AdminRateLimited as exc:
            logger.warning("Admin API hết lượt (420); thử lại sau %ss.", exc.retry_after_seconds)
            raise UploadVerificationUnavailableException(retry_after_seconds=exc.retry_after_seconds) from None
        except AdminNotFound:
            logger.warning("Admin API 404 cho imageId %s.", data.image_id)
            raise ConflictException("Uploaded assets not found") from None
        except AdminConfigError:
            logger.error("Admin API từ chối xác thực: kiểm tra CLOUDINARY_API_KEY/SECRET/CLOUD_NAME.")
            raise UploadVerificationUnavailableException() from None
        except AdminError as exc:
            logger.warning("Admin API lỗi: %s", type(exc).__name__)
            raise UploadVerificationUnavailableException() from None
        except Exception as exc:  # client tiêm vào lỗi không theo giao thức: vẫn fail closed
            logger.error("Admin client lỗi không lường trước: %s", type(exc).__name__)
            raise UploadVerificationUnavailableException() from None
        try:
            return verify_uploaded_assets(response, grant=grant, cloud_name=signing.cloud_name, now=self._clock(), skew_seconds=skew)
        except UploadVerificationError as exc:
            logger.warning("Xác minh asset không đạt (imageId %s): %s", data.image_id, exc.reason)
            if exc.missing:
                raise ConflictException("Uploaded assets not found") from None
            raise ConflictException("Uploaded assets do not match the upload grant") from None

    # ----- quyết định bên trong thao tác ghi có điều kiện -----
    def _make_decide(self, uid: str, data: ConfirmData, signing: SigningConfig, seen: dict[str, Any], verified: dict[str, VerifiedAsset] | None) -> Callable[[dict[str, Any]], ConfirmPlan]:
        def decide(state: dict[str, Any]) -> ConfirmPlan:
            now = self._clock()
            grant, image, assets = state["grant"], state["image"], state["assets"]
            self._check_grant(uid, data, grant, now, signing)  # kiểm tra LẠI trên dữ liệu vừa đọc (chủ, hạn tại thời điểm này, trạng thái)
            if grant["status"] == STATUS_CONFIRMED:
                return ConfirmPlan(result=self._idempotent_result(uid, data, grant, image, assets, signing))
            if verified is None or any(grant.get(k) != seen.get(k) for k in ("ownerId", "publicIds", "declared", "issuedAt", "expiresAt", "environment")):
                raise ConflictException("Upload grant changed")  # grant khác với bản đã dùng để xác minh
            if image is not None:
                if image.get("ownerId") != uid:
                    raise ForbiddenAccessException("Forbidden")
                raise ConflictException("Image already exists")
            if assets:  # một public_id của grant đã được đăng ký (vd bởi confirm legacy): không bao giờ chiếm lại
                if any(claim.get("ownerId") != uid for claim in assets.values()):
                    raise ForbiddenAccessException("Forbidden")
                raise ConflictException("Asset already registered")
            return self._build_plan(uid, data, grant, verified)

        return decide

    def _build_plan(self, uid: str, data: ConfirmData, grant: dict[str, Any], verified: dict[str, VerifiedAsset]) -> ConfirmPlan:
        server_time = self.repo.server_time()
        declared = grant["declared"]
        webp_bytes = verified["webp"].bytes
        original = declared["originalSize"]
        doc = {
            "imageId": data.image_id,
            "ownerId": uid,
            "retryCount": 0,
            "createdAt": server_time,
            "status": "DONE",
            "provider": "cloudinary",
            "fileName": declared.get("fileName") or data.image_id,
            "original": {"size": original, "width": declared.get("width"), "height": declared.get("height")},
            "variants": {v: verified[v].secure_url for v in VARIANT_KEYS},  # URL do Cloudinary trả về, không phải URL client gửi
            "publicIds": dict(grant["publicIds"]),
            "assetIds": dict(grant["publicIds"]),
            "previewUrl": verified["thumbnail"].secure_url,
            "processedSize": webp_bytes,
            "processingMs": data.processing_ms,  # số liệu client khai (không xác minh được)
            "savedPercent": round((1 - webp_bytes / original) * 100, 1),
            "errorReason": None,
            "updatedAt": server_time,
            "verification": {
                "mode": "signed",
                "assets": {v: {"assetId": verified[v].asset_id, "version": verified[v].version, "bytes": verified[v].bytes} for v in VARIANT_KEYS},
            },
        }
        claims = {
            asset_key(grant["publicIds"][v]): {"publicId": grant["publicIds"][v], "imageId": data.image_id, "ownerId": uid, "createdAt": server_time}
            for v in VARIANT_KEYS
        }
        return ConfirmPlan(
            result=build_confirm_response(doc),
            image_doc=doc,
            asset_claims=claims,
            grant_updates={"status": STATUS_CONFIRMED, "confirmedAt": server_time},
        )

    def _idempotent_result(self, uid: str, data: ConfirmData, grant: dict[str, Any], image: dict[str, Any] | None, assets: dict[str, Any], signing: SigningConfig) -> dict[str, Any]:
        """Grant đã CONFIRMED: chỉ trả lại bản ghi cũ khi ảnh + sổ asset nhất quán với grant và payload KHÔNG khác lần đã xác nhận."""
        ids = grant["publicIds"]
        verification = (image or {}).get("verification")
        recorded = verification.get("assets") if isinstance(verification, dict) else None
        consistent = (
            isinstance(image, dict)
            and image.get("ownerId") == uid
            and image.get("status") == "DONE"
            and image.get("publicIds") == ids
            and image.get("assetIds") == ids
            and isinstance(recorded, dict)
            and set(recorded) == set(VARIANT_KEYS)
            and all(
                isinstance(assets.get(asset_key(ids[v])), dict)
                and assets[asset_key(ids[v])].get("imageId") == data.image_id
                and assets[asset_key(ids[v])].get("ownerId") == uid
                for v in VARIANT_KEYS
            )
        )
        if not consistent:
            logger.error("Grant CONFIRMED nhưng ảnh/sổ asset không nhất quán (imageId %s).", data.image_id)
            raise ConflictException("Upload state is inconsistent")
        for v in VARIANT_KEYS:  # payload phải trỏ đúng phiên bản asset đã được xác nhận
            if parse_cloudinary_url(data.urls[v], signing.cloud_name).version != f"v{recorded[v].get('version')}":
                raise ConflictException(DIFFERS)
        if data.processed_size is not None and data.processed_size != image.get("processedSize"):
            raise ConflictException(DIFFERS)
        return build_confirm_response(image)


signed_confirm_service = SignedConfirmService()
