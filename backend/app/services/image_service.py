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
from app.repositories.image_repository import image_repo
from app.services.google_drive import google_drive_service
from app.services.cloudinary_service import cloudinary_service


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

    def confirmCloudinaryUpload(
        self,
        uid: str,
        image_id: str,
        thumbnail: str,
        medium: str,
        webp: str,
        processing_ms: int | float,
        filename: str | None = None,
        content_type: str | None = None,
        size_bytes: int | None = None,
    ) -> dict[str, Any]:
        if not thumbnail or not medium or not webp:
            raise InvalidFileException("Thiếu đủ 3 link biến thể: thumbnail, medium, webp.")

        if filename is not None or content_type is not None or size_bytes is not None:
            checkFile(
                filename=filename or "confirmed_image.webp",
                content_type=content_type or "image/webp",
                size_bytes=size_bytes if size_bytes is not None else 1,
            )

        existing = image_repo.get_by_id(image_id)
        now = datetime.now(timezone.utc).isoformat()

        if existing:
            verifyOwner(existing, uid)
            doc = existing
        else:
            doc = {
                "imageId": image_id,
                "ownerId": uid,
                "provider": "cloudinary",
                "originalName": filename or f"{image_id}.webp",
                "mimeType": content_type or "image/webp",
                "sizeBytes": size_bytes or 0,
                "currentFolder": "processed",
                "storagePath": f"processed/{uid}/{image_id}.webp",
                "driveFileId": None,
                "cloudinaryPublicId": f"uploads/{uid}/{image_id}",
                "pipelineFolders": {},
                "createdAt": now,
            }

        doc["status"] = "DONE"
        doc["currentFolder"] = "processed"
        doc["previewUrl"] = webp or medium or thumbnail
        doc["variants"] = {
            "thumbnail": thumbnail,
            "medium": medium,
            "webp": webp,
        }
        doc["processingMs"] = processing_ms
        doc["updatedAt"] = now

        image_repo.save(doc)
        return doc

    def syncExternalImages(self, uid: str, root_folder_id: str | None = None) -> dict[str, int]:
        """
        Tự động đọc ảnh từ cả Google Drive folder và Cloudinary của user,
        ánh xạ sang chuẩn CONTRACT và lưu vào repository nếu chưa có.
        """
        existing_docs = image_repo.list_by_owner(uid)
        known_drive_ids = {d.get("driveFileId") for d in existing_docs if d.get("driveFileId")}
        known_cloud_ids = {
            d.get("cloudinaryPublicId") for d in existing_docs if d.get("cloudinaryPublicId")
        }

        added_drive = 0
        added_cloudinary = 0
        now = datetime.now(timezone.utc).isoformat()

        # 1. Tự động đọc ảnh trong Google Drive folder (nếu user đã kết nối Drive)
        try:
            drive_files = google_drive_service.list_all_pipeline_images(uid, root_folder_id)
            for df in drive_files:
                d_id = df["driveFileId"]
                if d_id in known_drive_ids:
                    continue
                img_id = f"drive_{d_id}"
                preview = f"/images/preview/{d_id}"
                doc = {
                    "imageId": img_id,
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
                        "thumbnail": preview if df["stage"] == "processed" else None,
                        "medium": preview if df["stage"] == "processed" else None,
                        "webp": preview if df["stage"] == "processed" else None,
                    },
                    "processingMs": None,
                    "createdAt": df.get("createdTime") or now,
                    "updatedAt": df.get("modifiedTime") or now,
                }
                image_repo.save(doc)
                known_drive_ids.add(d_id)
                added_drive += 1
        except Exception:
            # Bỏ qua nếu user chưa đăng nhập Google Drive
            pass

        # 2. Tự động đọc ảnh trên Cloudinary (thư mục uploads/{uid} hoặc toàn bộ cloud)
        cloud_files = cloudinary_service.list_images(prefix=f"uploads/{uid}")
        if not cloud_files:
            cloud_files = cloudinary_service.list_images(prefix="")

        for cf in cloud_files:
            pub_id = cf["publicId"]
            if pub_id in known_cloud_ids:
                continue
            img_id = pub_id.split("/")[-1]
            doc = {
                "imageId": img_id,
                "ownerId": uid,
                "provider": "cloudinary",
                "originalName": cf["filename"],
                "mimeType": cf["mimeType"],
                "sizeBytes": cf["sizeBytes"],
                "status": "DONE",
                "currentFolder": "processed",
                "storagePath": f"processed/{uid}/{cf['filename']}",
                "driveFileId": None,
                "cloudinaryPublicId": pub_id,
                "previewUrl": cf["secureUrl"],
                "pipelineFolders": {},
                "variants": cf["variants"],
                "processingMs": None,
                "createdAt": cf.get("createdAt") or now,
                "updatedAt": now,
            }
            image_repo.save(doc)
            known_cloud_ids.add(pub_id)
            added_cloudinary += 1

        return {
            "syncedFromGoogleDrive": added_drive,
            "syncedFromCloudinary": added_cloudinary,
        }

    def getImage(self, uid: str, image_id: str) -> dict[str, Any]:
        doc = image_repo.get_by_id(image_id)
        if not doc:
            raise NotFoundException(f"Không tìm thấy ảnh với imageId='{image_id}'")
        verifyOwner(doc, uid)
        return doc

    def listImages(self, uid: str, auto_sync: bool = True, root_folder_id: str | None = None) -> dict[str, Any]:
        if auto_sync:
            self.syncExternalImages(uid=uid, root_folder_id=root_folder_id)

        items = image_repo.list_by_owner(uid)
        return {
            "ownerId": uid,
            "total": len(items),
            "items": items,
        }


image_service = ImageService()