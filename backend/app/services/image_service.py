import io
import os
import uuid
from datetime import datetime, timezone
from typing import Any
from PIL import Image
from app.config import settings
from app.exceptions import (
    InvalidFileException,
    ForbiddenAccessException,
    NotFoundException,
)
from app.repositories.image_repository import image_repo
from app.services.google_drive import google_drive_service


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
        raise ForbiddenAccessException(
            f"403 Forbidden: User '{uid}' không có quyền truy cập ảnh của '{doc.get('ownerId')}'."
        )


class ImageService:
    _raw_file_cache: dict[str, bytes] = {}

    def requestUpload(
        self,
        uid: str,
        filename: str,
        content_type: str | None,
        size_bytes: int,
        drive_file_id: str | None = None,
        pipeline_folders: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        checkFile(filename=filename, content_type=content_type, size_bytes=size_bytes)

        image_id = createImageId()
        ext = os.path.splitext(filename)[1].lower()
        now = datetime.now(timezone.utc).isoformat()

        preview_url = f"/images/preview/{drive_file_id}" if drive_file_id else None

        doc = {
            "imageId": image_id,
            "ownerId": uid,
            "originalName": filename,
            "mimeType": content_type,
            "sizeBytes": size_bytes,
            "status": "PENDING",
            "currentFolder": "upload",
            "storagePath": f"upload/{uid}/{image_id}{ext}",
            "driveFileId": drive_file_id,
            "previewUrl": preview_url,
            "pipelineFolders": pipeline_folders or {},
            "variants": {
                "thumbnail": None,
                "medium": None,
                "webp": None,
            },
            "createdAt": now,
            "updatedAt": now,
        }
        image_repo.save(doc)

        return {
            "imageId": image_id,  # <-- Trả trực tiếp ở top-level để Frontend dễ nhận
            "uploadUrl": f"https://storage.googleapis.com/upload/uploads/{uid}/{image_id}{ext}?mockSignedToken=1",
            "image": doc,
        }

    def uploadAndInitPipeline(
        self,
        uid: str,
        filename: str,
        content_type: str,
        file_bytes: bytes,
        root_folder_id: str | None = None,
    ) -> dict[str, Any]:
        checkFile(filename=filename, content_type=content_type, size_bytes=len(file_bytes))

        folders = google_drive_service.ensure_pipeline_folders(uid, root_folder_id)
        drive_res = google_drive_service.upload_bytes_to_folder(
            uid=uid,
            filename=filename,
            content_type=content_type,
            file_bytes=file_bytes,
            folder_id=folders["upload"],
        )

        result = self.requestUpload(
            uid=uid,
            filename=filename,
            content_type=content_type,
            size_bytes=len(file_bytes),
            drive_file_id=drive_res["driveFileId"],
            pipeline_folders=folders,
        )
        image_id = result["image"]["imageId"]
        self._raw_file_cache[image_id] = file_bytes
        result["driveWebViewLink"] = drive_res["webViewLink"]
        return result

    def moveToProcessing(self, uid: str, image_id: str) -> dict[str, Any]:
        doc = self.getImage(uid, image_id)
        folders = doc.get("pipelineFolders", {})
        drive_file_id = doc.get("driveFileId")

        if drive_file_id and folders.get("processing"):
            google_drive_service.move_file_to_folder(
                uid=uid,
                file_id=drive_file_id,
                target_folder_id=folders["processing"],
            )

        doc["status"] = "PROCESSING"
        doc["currentFolder"] = "processing"
        doc["storagePath"] = f"processing/{uid}/{os.path.basename(doc['storagePath'])}"
        doc["updatedAt"] = datetime.now(timezone.utc).isoformat()
        image_repo.save(doc)
        return doc

    def completeProcessing(self, uid: str, image_id: str) -> dict[str, Any]:
        doc = self.getImage(uid, image_id)
        folders = doc.get("pipelineFolders", {})
        drive_file_id = doc.get("driveFileId")
        processed_folder_id = folders.get("processed")

        raw_bytes = self._raw_file_cache.get(image_id)
        variant_urls = {
            "thumbnail": None,
            "medium": None,
            "webp": None,
        }

        if raw_bytes and processed_folder_id:
            img = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
            base_name = os.path.splitext(doc["originalName"])[0]

            specs = {
                "thumbnail": (200, 200),
                "medium": (800, 800),
                "webp": img.size,
            }

            for variant_key, max_size in specs.items():
                resized = img.copy()
                resized.thumbnail(max_size)
                buf = io.BytesIO()
                resized.save(buf, format="WEBP", quality=85)
                buf.seek(0)

                up_res = google_drive_service.upload_bytes_to_folder(
                    uid=uid,
                    filename=f"{base_name}_{variant_key}.webp",
                    content_type="image/webp",
                    file_bytes=buf.read(),
                    folder_id=processed_folder_id,
                )
                # Trả về endpoint preview trực tiếp để Frontend gắn vào thẻ <img>
                variant_urls[variant_key] = f"/images/preview/{up_res['driveFileId']}"

        if drive_file_id and processed_folder_id:
            move_res = google_drive_service.move_file_to_folder(
                uid=uid,
                file_id=drive_file_id,
                target_folder_id=processed_folder_id,
            )
            doc["driveWebViewLink"] = move_res.get("webViewLink", "")

        doc["status"] = "COMPLETED"
        doc["currentFolder"] = "processed"
        doc["storagePath"] = f"processed/{uid}/{os.path.basename(doc['storagePath'])}"
        doc["variants"] = variant_urls
        doc["updatedAt"] = datetime.now(timezone.utc).isoformat()
        image_repo.save(doc)

        self._raw_file_cache.pop(image_id, None)
        return doc

    def getImage(self, uid: str, image_id: str) -> dict[str, Any]:
        doc = image_repo.get_by_id(image_id)
        if not doc:
            raise NotFoundException(f"Không tìm thấy ảnh với imageId='{image_id}'")
        verifyOwner(doc, uid)
        return doc

    def listImages(self, uid: str) -> dict[str, Any]:
        items = image_repo.list_by_owner(uid)
        return {
            "ownerId": uid,
            "total": len(items),
            "items": items,
        }

image_service = ImageService()