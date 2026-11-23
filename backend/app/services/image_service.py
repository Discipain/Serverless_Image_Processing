import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any
from app.config import settings
from app.exceptions import (
    InvalidFileException,
    ForbiddenAccessException,
    NotFoundException,
)
from app.exceptions import StorageUnavailableException, UnauthorizedException
from app.repositories.image_repository import image_repo
from app.services.google_drive import google_drive_service
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
        checkFile(filename=filename, content_type=content_type, size_bytes=size_bytes)

        image_id = createImageId()
        ext = os.path.splitext(filename)[1].lower()
        now = datetime.now(timezone.utc).isoformat()

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
            "uploadUrl": f"https://api.cloudinary.com/v1_1/{settings.CLOUDINARY_CLOUD_NAME}/image/upload",
            "cloudinaryConfig": {
                "cloudName": settings.CLOUDINARY_CLOUD_NAME,
                "uploadPreset": settings.CLOUDINARY_UPLOAD_PRESET,
                "folder": f"uploads/{uid}",
                "publicId": image_id,
            },
            "image": doc,
        }

    def confirmCloudinaryUpload(self, uid: str, body: Any) -> dict[str, Any]:
        """POST /images/cloudinary/confirm (CONTRACT mục 3).

        `uid` lấy từ Firebase ID token đã verify. Idempotent: imageId đã DONE thì trả bản ghi cũ, KHÔNG ghi đè.

        Asset được định danh bằng `public_id` suy ra từ URL (không phải chuỗi URL) và đăng ký trong sổ `cloudinaryAssets`
        CÙNG LÚC với bản ghi ảnh bằng MỘT thao tác nguyên tử: hai request đồng thời cùng một asset không thể cùng thành công.
        Đây là defense-in-depth: nó KHÔNG chứng minh ai đã upload asset (unsigned preset không cung cấp bằng chứng đó).
        """
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

        now = datetime.now(timezone.utc).isoformat()
        added_drive = 0
        for df in drive_files:
            d_id = df["driveFileId"]
            preview = f"/images/preview/{d_id}"
            processed = df["stage"] == "processed"
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
                "createdAt": df.get("createdTime") or now,
                "updatedAt": df.get("modifiedTime") or now,
            }
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