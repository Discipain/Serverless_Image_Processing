import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from app.config import settings
from app.exceptions import (
    InvalidFileException,
    ForbiddenAccessException,
    NotFoundException,
)
from app.exceptions import SignedUploadUnavailableException, StorageUnavailableException, UnauthorizedException
from app.repositories.image_repository import image_repo
from app.services.google_drive import google_drive_service
from app.services.signed_confirm import signed_confirm_service
from app.services.upload_mode import MODE_LEGACY, MODE_SIGNED, confirm_mode, legacy_compat_provider, require_legacy_upload_allowed
from app.services.cloudinary_confirm import (
    ConfirmData,
    asset_claim_keys,
    build_asset_claims,
    build_completion_fields,
    build_confirm_response,
    build_new_doc,
    parse_confirm_payload,
)

logger = logging.getLogger(__name__)


def createImageId() -> str:
    return str(uuid.uuid4())


# ----- Phân trang GET /images (CONTRACT mục 5) -----
DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 20  # server ép limit <= 20
_CURSOR_VERSION = 1
_CURSOR_MAX_LENGTH = 1024
_CURSOR_CHARS_RE = re.compile(r"[A-Za-z0-9_-]+")
_CURSOR_IMAGE_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,128}")
_CURSOR_KEYS = {"v", "o", "t", "c", "i"}
INVALID_CURSOR = "Invalid cursor"


def _cursor_owner_tag(uid: str) -> str:
    """Nhãn gắn cursor với người gọi: cursor của A đưa cho B bị từ chối. Đây là ràng buộc ngữ cảnh, KHÔNG phải chữ ký bí mật."""
    return hashlib.sha256(("gallery-cursor:" + uid).encode("utf-8")).hexdigest()[:16]


def encode_cursor(uid: str, doc: dict[str, Any]) -> str:
    """Cursor MỜ (opaque) cho Frontend: base64url của {version, nhãn chủ sở hữu, kiểu+giá trị createdAt, imageId} của ảnh CUỐI trang.

    Đó đúng là khóa sắp xếp (createdAt, imageId) nên trang sau bắt đầu ngay sau ảnh này, không đọc thêm tài liệu nào. Frontend
    chỉ được truyền lại nguyên văn `nextCursor`; không được phân tích hay tự tạo."""
    image_id, created_at = doc.get("imageId"), doc.get("createdAt")
    if not isinstance(image_id, str) or not _CURSOR_IMAGE_ID_RE.fullmatch(image_id):
        logger.error("Không tạo được cursor: bản ghi có imageId không hợp lệ.")
        raise StorageUnavailableException()
    if isinstance(created_at, datetime):
        aware = created_at if created_at.tzinfo else created_at.replace(tzinfo=timezone.utc)
        kind, value = "d", aware.astimezone(timezone.utc).isoformat(timespec="microseconds")
    elif isinstance(created_at, str):
        kind, value = "s", created_at
    elif created_at is None:
        kind, value = "n", None
    else:
        logger.error("Không tạo được cursor: kiểu createdAt không hỗ trợ (%s).", type(created_at).__name__)
        raise StorageUnavailableException()
    payload = {"v": _CURSOR_VERSION, "o": _cursor_owner_tag(uid), "t": kind, "c": value, "i": image_id}
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(cursor: str, uid: str) -> tuple[Any, str]:
    """Kiểm tra NGHIÊM và giải mã cursor thành (createdAt, imageId). Mọi sai sót => 400 `Invalid cursor`, không lộ lý do.

    Cursor chỉ chọn VỊ TRÍ trong dữ liệu của chính `uid` (truy vấn luôn có `ownerId == uid` lấy từ token), nên cursor bị sửa
    hay giả mạo không thể đọc ảnh của người khác; tệ nhất chỉ làm lệch vị trí trong ảnh của chính người gọi."""
    bad = InvalidFileException(INVALID_CURSOR)
    if not isinstance(cursor, str) or not cursor or len(cursor) > _CURSOR_MAX_LENGTH or not _CURSOR_CHARS_RE.fullmatch(cursor):
        raise bad
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode("utf-8"))
    except (binascii.Error, ValueError, RecursionError):
        raise bad from None
    if not isinstance(data, dict) or set(data) != _CURSOR_KEYS or data["v"] != _CURSOR_VERSION or isinstance(data["v"], bool):
        raise bad
    tag, kind, value, image_id = data["o"], data["t"], data["c"], data["i"]
    if not isinstance(tag, str) or not hmac.compare_digest(tag.encode("utf-8"), _cursor_owner_tag(uid).encode("utf-8")):
        raise bad  # cursor của người khác (hoặc không gắn với người gọi)
    if not isinstance(image_id, str) or not _CURSOR_IMAGE_ID_RE.fullmatch(image_id):
        raise bad
    if kind == "d" and isinstance(value, str):
        try:
            created_at: Any = datetime.fromisoformat(value)
        except ValueError:
            raise bad from None
        if created_at.tzinfo is None:
            raise bad
        created_at = created_at.astimezone(timezone.utc)
    elif kind == "s" and isinstance(value, str):
        created_at = value
    elif kind == "n" and value is None:
        created_at = None
    else:
        raise bad
    return created_at, image_id


def checkFile(filename: str, content_type: str | None, size_bytes: int) -> None:
    if not filename:
        raise InvalidFileException("Tên file không hợp lệ.")

    ext = os.path.splitext(filename)[1].lower()
    if ext not in settings.ALLOWED_EXTENSIONS:
        raise InvalidFileException(
            f"Định dạng file '{ext}' không được hỗ trợ. Chỉ chấp nhận: jpg, png, webp."
        )

    if content_type not in settings.ALLOWED_MIME_TYPES:
        raise InvalidFileException(
            f"MIME type '{content_type}' không hợp lệ. Chỉ chấp nhận image/jpeg, image/png, image/webp."
        )

    if size_bytes <= 0:
        raise InvalidFileException("File rỗng (0 bytes).")

    if size_bytes > settings.MAX_FILE_SIZE_BYTES:
        raise InvalidFileException(
            f"Dung lượng file vượt quá giới hạn 10MB ({size_bytes} bytes)."
        )


# ----- Chuẩn hóa thời gian (INT-2.1) -----
# RFC 3339 / ISO 8601 có múi giờ (Google Drive trả dạng `2026-01-02T03:04:05.678Z`). Tự phân tích bằng regex để KHÔNG phụ thuộc
# phiên bản Python (`datetime.fromisoformat` chỉ nhận hậu tố `Z` và phần thập phân tùy ý từ Python 3.11).
_RFC3339_RE = re.compile(
    r"(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:([Zz])|([+-])(\d{2}):?(\d{2}))",
    re.ASCII,  # chỉ chữ số 0-9 (không nhận chữ số Unicode như "２０２６")
)


def parse_timestamp_utc(value: Any) -> datetime | None:
    """Chuyển thời gian của Drive/dữ liệu ngoài thành datetime UTC có múi giờ; KHÔNG BAO GIỜ đoán.

    Nhận: chuỗi RFC 3339 có múi giờ (`Z` hoặc `±hh:mm`), hoặc datetime ĐÃ có múi giờ. Phần thập phân dài hơn micro giây bị cắt
    (Firestore chỉ lưu đến micro giây). Trả về None nếu thiếu, không phải chuỗi/datetime, sai định dạng, ngày giờ không tồn tại,
    hoặc THIẾU múi giờ (mơ hồ: không biết đó là giờ nào). Nơi gọi quyết định chính sách khi nhận None."""
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc) if value.tzinfo is not None else None
    if not isinstance(value, str):
        return None
    match = _RFC3339_RE.fullmatch(value.strip())
    if match is None:
        return None
    year, month, day, hour, minute, second, fraction, zulu, sign, off_h, off_m = match.groups()
    try:
        if zulu:
            tz = timezone.utc
        else:
            if int(off_h) > 23 or int(off_m) > 59:
                return None
            offset = timedelta(hours=int(off_h), minutes=int(off_m))
            tz = timezone(offset if sign == "+" else -offset)
        moment = datetime(
            int(year), int(month), int(day), int(hour), int(minute), int(second),
            int((fraction or "0").ljust(6, "0")[:6]), tzinfo=tz,
        )
        return moment.astimezone(timezone.utc)
    except (ValueError, OverflowError):  # tháng/ngày/giờ không tồn tại, năm ngoài miền, offset quá lớn
        return None


def verifyOwner(doc: dict[str, Any], uid: str) -> None:
    if doc.get("ownerId") != uid:
        # CONTRACT mục 0.2 và 10: đúng `{"detail": "Forbidden"}`, tuyệt đối không lộ uid của người khác.
        raise ForbiddenAccessException("Forbidden")


class ImageService:
    def requestUpload(
        self,
        uid: str,
        filename: str,
        content_type: str | None,
        size_bytes: int,
        provider: str = "cloudinary",
        drive_file_id: str | None = None,
        pipeline_folders: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        # H4B-7B.2: LEGACY (cấp unsigned preset + tạo PENDING). Chỉ chạy ở mode "legacy" tường minh; disabled/signed => 410, cấu hình sai => 503.
        # Cổng này chạy TRƯỚC mọi kiểm tra dữ liệu và mọi ghi (cả route lẫn lời gọi trực tiếp đều qua đây): không PENDING, không preset trong response.
        require_legacy_upload_allowed(settings)
        compat = legacy_compat_provider()  # cấu hình unsigned GIẢ do harness cô lập tiêm; KHÔNG bao giờ dùng cloud name/preset trong settings (không cấp unsigned config thật)
        if compat is None:
            raise SignedUploadUnavailableException()
        checkFile(filename=filename, content_type=content_type, size_bytes=size_bytes)

        image_id = createImageId()
        ext = os.path.splitext(filename)[1].lower()
        now = datetime.now(timezone.utc)  # datetime UTC có múi giờ (cùng kiểu với server timestamp của confirm), không phải chuỗi

        doc = {
            "imageId": image_id,
            "ownerId": uid,
            "provider": provider,
            "originalName": filename,
            "mimeType": content_type,
            "sizeBytes": size_bytes,
            "status": "PENDING",
            "currentFolder": "upload",
            "storagePath": f"upload/{uid}/{image_id}{ext}",
            "driveFileId": drive_file_id,
            "cloudinaryPublicId": None,
            "previewUrl": f"/images/preview/{drive_file_id}" if drive_file_id else None,
            "pipelineFolders": pipeline_folders or {},
            "variants": {
                "thumbnail": None,
                "medium": None,
                "webp": None,
            },
            "processingMs": None,
            "createdAt": now,
            "updatedAt": now,
        }
        image_repo.save(doc)

        return {
            "imageId": image_id,
            "uploadUrl": f"https://api.cloudinary.com/v1_1/{compat.cloud_name}/image/upload",
            "cloudinaryConfig": {
                "cloudName": compat.cloud_name,
                "uploadPreset": compat.upload_preset,
                "folder": f"uploads/{uid}",
                "publicId": image_id,
            },
            "image": doc,
        }

    def confirmCloudinaryUpload(self, uid: str, body: Any) -> dict[str, Any]:
        """POST /images/cloudinary/confirm (CONTRACT mục 3).

        `uid` lấy từ Firebase ID token đã verify. Idempotent: imageId đã DONE thì trả bản ghi cũ, KHÔNG ghi đè.

        Chế độ (`CLOUDINARY_CONFIRM_MODE`, diễn giải tập trung ở upload_mode.py): "disabled" (MẶC ĐỊNH) và cấu hình sai => 503 trước mọi đọc/ghi;
        "signed" (H4B-3, `signed_confirm_service`); "legacy" (đoạn code dưới đây, không cần grant) CHỈ trong harness cô lập đã tiêm provider giả (không bật được bằng cấu hình môi trường).

        Asset được định danh bằng `public_id` suy ra từ URL (không phải chuỗi URL) và đăng ký trong sổ `cloudinaryAssets`
        CÙNG LÚC với bản ghi ảnh bằng MỘT thao tác nguyên tử: hai request đồng thời cùng một asset không thể cùng thành công.
        Đây là defense-in-depth: nó KHÔNG chứng minh ai đã upload asset (unsigned preset không cung cấp bằng chứng đó).
        """
        mode = confirm_mode(settings)
        if mode not in (MODE_LEGACY, MODE_SIGNED):
            raise SignedUploadUnavailableException()  # disabled hoặc cấu hình mâu thuẫn/không hợp lệ: fail closed, không đọc/ghi gì, không tự chọn legacy
        if mode == MODE_SIGNED:
            return signed_confirm_service.confirm_payload(uid, body)  # H4B-3: BẮT BUỘC grant + xác minh Admin API; không có đường rơi về legacy bên dưới
        data = parse_confirm_payload(body)

        existing = image_repo.get_by_id(data.image_id)
        if existing is not None:
            return self._confirm_existing(uid, data, existing)

        claims = self._claims_to_register(uid, data)  # báo 403/400 rõ ràng nếu asset đã thuộc imageId khác
        doc = build_new_doc(uid, data, image_repo.server_time())
        if image_repo.create_with_assets(doc, claims):  # nguyên tử: ảnh + asset cùng thành công hoặc cùng không ghi gì
            return build_confirm_response(doc)

        # Thua cuộc đua: ai đó vừa tạo cùng imageId hoặc vừa chiếm asset. Đọc lại để trả đúng kết quả, không đoán.
        existing = image_repo.get_by_id(data.image_id)
        if existing is not None:
            return self._confirm_existing(uid, data, existing)
        self._claims_to_register(uid, data)  # asset bị chiếm trong lúc đó => 403/400
        raise StorageUnavailableException()  # xung đột nhưng không thấy nguyên nhân (hiếm): để client thử lại

    def _confirm_existing(self, uid: str, data: ConfirmData, existing: dict[str, Any]) -> dict[str, Any]:
        verifyOwner(existing, uid)  # người khác dùng lại imageId => 403 {"detail": "Forbidden"}
        if existing.get("status") == "DONE":
            return build_confirm_response(existing)  # idempotent: trả bản cũ, không ghi đè, không đăng ký asset mới

        # Bản ghi cùng chủ nhưng chưa DONE (vd PENDING do retry): hoàn tất + đăng ký asset trong MỘT thao tác nguyên tử.
        claims = self._claims_to_register(uid, data)
        fields = build_completion_fields(data, image_repo.server_time())
        if image_repo.update_with_assets(data.image_id, fields, claims):
            return build_confirm_response({**existing, **fields})

        latest = image_repo.get_by_id(data.image_id)
        if latest is not None:
            verifyOwner(latest, uid)
            if latest.get("status") == "DONE":  # request song song vừa hoàn tất: trả bản đó
                return build_confirm_response(latest)
        self._claims_to_register(uid, data)  # asset bị chiếm trong lúc đó => 403/400
        raise StorageUnavailableException()

    @staticmethod
    def _claims_to_register(uid: str, data: ConfirmData) -> dict[str, dict[str, Any]]:
        """Asset nào đã đăng ký cho imageId KHÁC thì từ chối: người khác => 403 Forbidden; chính chủ nhưng imageId khác => 400.
        Trả về các bản ghi đăng ký còn phải tạo (bỏ asset đã thuộc chính imageId này). Bước đọc này chỉ để báo lỗi rõ;
        quyết định cuối cùng là thao tác ghi nguyên tử của kho."""
        taken = image_repo.get_asset_claims(list(asset_claim_keys(data)))
        for claim in taken.values():
            if claim.get("ownerId") != uid:
                raise ForbiddenAccessException("Forbidden")
            if claim.get("imageId") != data.image_id:
                raise InvalidFileException("Invalid cloudinary url")
        return build_asset_claims(uid, data, image_repo.server_time(), skip_keys=taken.keys())

    def syncExternalImages(self, uid: str, root_folder_id: str | None = None) -> dict[str, int]:
        """Đồng bộ ảnh Google Drive CỦA CHÍNH user đang đăng nhập vào kho metadata.

        - Google Drive: gọi bằng OAuth credentials của `uid` (uid lấy từ Firebase ID token), nên chỉ thấy file mà user đó
          truy cập được. Mỗi file thành bản ghi `drive_<fileId>` với `ownerId = uid`; KHÔNG BAO GIỜ ghi đè bản ghi sẵn có.
        - Cloudinary: ĐÃ VÔ HIỆU HÓA nhập tự động. Bản cũ liệt kê CẢ CLOUD (prefix rỗng) rồi gán mọi tài nguyên cho người
          gọi và ghi đè bản ghi theo imageId => ảnh của user A hiện trong gallery của B và bản ghi của A bị đổi chủ.
          Tài nguyên Cloudinary chỉ được đăng ký qua POST /images/cloudinary/confirm.
        """
        try:
            drive_files = google_drive_service.list_all_pipeline_images(uid, root_folder_id)
        except UnauthorizedException:
            drive_files = []  # user chưa liên kết Google Drive: bỏ qua phần Drive (hành vi cũ)
        except Exception as exc:  # lỗi Drive API: chỉ bỏ qua phần Drive; KHÔNG bọc phần ghi kho (lỗi lưu trữ phải nổi lên)
            logger.warning("Bỏ qua đồng bộ Google Drive: %s", type(exc).__name__)
            drive_files = []

        now = datetime.now(timezone.utc)
        added_drive = 0
        for df in drive_files:
            d_id = df["driveFileId"]
            preview = f"/images/preview/{d_id}"
            processed = df["stage"] == "processed"

            # Thời gian luôn là datetime UTC (cùng kiểu với confirm) để Gallery sắp xếp đúng giữa Drive và Cloudinary.
            # Chính sách khi Drive không cho thời gian dùng được (thiếu / sai định dạng / không có múi giờ):
            #  - createdAt: dùng thời điểm ĐỒNG BỘ, ĐÁNH DẤU `createdAtEstimated: True` và ghi log (không giả làm thời gian thật);
            #  - updatedAt: dùng createdAt đã xác định, ghi log nếu Drive có gửi giá trị nhưng không dùng được.
            created_at = parse_timestamp_utc(df.get("createdTime"))
            estimated = created_at is None
            if estimated:
                logger.warning("Drive createdTime thiếu/không hợp lệ cho ảnh drive_%s: dùng thời điểm đồng bộ và đánh dấu ước lượng.", d_id)
                created_at = now
            updated_at = parse_timestamp_utc(df.get("modifiedTime"))
            if updated_at is None:
                if df.get("modifiedTime") is not None:
                    logger.warning("Drive modifiedTime không hợp lệ cho ảnh drive_%s: dùng createdAt.", d_id)
                updated_at = created_at

            doc = {
                "imageId": f"drive_{d_id}",
                "ownerId": uid,
                "provider": "google_drive",
                "originalName": df["name"],
                "mimeType": df["mimeType"],
                "sizeBytes": df["sizeBytes"],
                "status": df["status"],
                "currentFolder": df["stage"],
                "storagePath": f"{df['stage']}/{uid}/{df['name']}",
                "driveFileId": d_id,
                "cloudinaryPublicId": None,
                "previewUrl": preview,
                "pipelineFolders": df["pipelineFolders"],
                "variants": {
                    "thumbnail": preview if processed else None,
                    "medium": preview if processed else None,
                    "webp": preview if processed else None,
                },
                "processingMs": None,
                "createdAt": created_at,
                "updatedAt": updated_at,
            }
            if estimated:
                doc["createdAtEstimated"] = True
            if image_repo.create_if_absent(doc):  # nguyên tử: không ghi đè bản ghi đã có (kể cả của người khác)
                added_drive += 1
            else:
                existing = image_repo.get_by_id(doc["imageId"])
                if existing is not None and existing.get("ownerId") != uid:
                    logger.warning("Bỏ qua ảnh Drive: imageId đã thuộc người khác (không ghi đè).")

        return {"syncedFromGoogleDrive": added_drive, "syncedFromCloudinary": 0}

    def getImage(self, uid: str, image_id: str) -> dict[str, Any]:
        doc = image_repo.get_by_id(image_id)
        if not doc:
            raise NotFoundException(f"Không tìm thấy ảnh với imageId='{image_id}'")
        verifyOwner(doc, uid)
        return doc

    def listImages(self, uid: str, auto_sync: bool = True, root_folder_id: str | None = None) -> dict[str, Any]:
        """Danh sách ảnh CỦA `uid` (từ Firebase ID token). Lọc `ownerId` thêm một lần phòng thủ."""
        if auto_sync:
            self.syncExternalImages(uid=uid, root_folder_id=root_folder_id)

        items = [doc for doc in image_repo.list_by_owner(uid) if doc.get("ownerId") == uid]
        return {
            "ownerId": uid,
            "total": len(items),
            "items": items,
        }

    def listImagesPage(
        self,
        uid: str,
        limit: int = DEFAULT_PAGE_SIZE,
        cursor: str | None = None,
        root_folder_id: str | None = None,
    ) -> dict[str, Any]:
        """GET /images (CONTRACT mục 5): một trang ảnh CỦA `uid` (từ Firebase ID token), mới nhất trước.

        - `limit` bị ép vào [1, 20]; `cursor` là `nextCursor` của trang trước (trang đầu: không có).
        - Phân trang diễn ra trong kho (Firestore: order_by + start_after + limit), không tải cả collection.
        - Cursor sai/của người khác => 400 trước mọi thao tác khác. Lỗi kho => 503 (không bao giờ thành danh sách rỗng giả).
        - Đồng bộ Google Drive chỉ chạy ở TRANG ĐẦU (không gọi Drive lại ở mỗi lần cuộn). KHÔNG quét Cloudinary.
        """
        limit = max(1, min(int(limit), MAX_PAGE_SIZE))
        after = decode_cursor(cursor, uid) if cursor else None
        if after is None:
            self.syncExternalImages(uid=uid, root_folder_id=root_folder_id)

        fetched = image_repo.list_page_by_owner(uid, limit, after)  # tối đa limit + 1 bản ghi
        has_more = len(fetched) > limit
        items = [doc for doc in fetched[:limit] if doc.get("ownerId") == uid]  # lọc phòng thủ thêm một lớp
        next_cursor = encode_cursor(uid, items[-1]) if has_more and items else None
        return {"items": items, "nextCursor": next_cursor, "hasMore": next_cursor is not None}

    def getDrivePreview(self, uid: str, drive_file_id: str) -> tuple[bytes, str]:
        """Nội dung ảnh Google Drive cho `uid`, CHỈ khi có bản ghi ảnh thuộc `uid` trỏ tới file đó.

        Không có bản ghi => 404; bản ghi của người khác => 403 `Forbidden` (không lộ ownerId). Việc tải file vẫn dùng
        OAuth credentials của chính `uid`, nên Drive cũng chặn thêm một lớp nữa.
        """
        docs = image_repo.find_by_drive_file_id(drive_file_id)
        if not docs:
            raise NotFoundException("Image not found")
        if not any(doc.get("ownerId") == uid for doc in docs):
            raise ForbiddenAccessException("Forbidden")

        data, mime_type = google_drive_service.download_file_bytes(uid=uid, file_id=drive_file_id)
        if mime_type not in settings.ALLOWED_MIME_TYPES:  # không phát lại nội dung lạ (html, svg...) từ origin của API
            raise InvalidFileException("Invalid file type")
        return data, mime_type


image_service = ImageService()