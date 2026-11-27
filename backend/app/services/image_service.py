import os
import uuid
from datetime import datetime, timezone
from typing import Any

from google.cloud import firestore

from app.config import settings
from app.exceptions import (
    ForbiddenAccessException,
    InvalidFileException,
    NotFoundException,
)
from app.repositories.image_repository import image_repo
from app.services.cloudinary_admin import (
    asset_doc_id,
    delete_resources,
    extract_three_public_ids,
)
from app.services.cloudinary_service import cloudinary_service
from app.services.google_drive import google_drive_service

try:
    from app.services.cloudinary_admin import (
        AdminError,
        AdminRateLimited,
        AdminUnavailable,
    )
except ImportError:
    class AdminError(Exception):
        """Lỗi chung khi gọi Cloudinary Admin API."""

    class AdminRateLimited(AdminError):
        """Cloudinary Admin API vượt giới hạn request (429 / rate limit)."""

    class AdminUnavailable(AdminError):
        """Cloudinary Admin API lỗi, timeout hoặc không khả dụng (5xx / network)."""


class ImageNotFoundError(Exception):
    pass


class ForbiddenImageError(Exception):
    pass


class UnsupportedProviderError(Exception):
    pass


class ImageAlreadyDeletedError(Exception):
    pass


def ensure_grant_not_deleted(grant_doc: dict | None) -> None:
    """Gọi trong luồng confirm để trả 409 nếu imageId đã bị xóa."""
    if grant_doc and str(grant_doc.get("status", "")).upper() == "DELETED":
        raise ImageAlreadyDeletedError("Image grant has been deleted")


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
    def __init__(self, db: firestore.Client | None = None) -> None:
        self.db = db

    def _resolve_db(self, db: firestore.Client | None = None):
        if db is not None:
            return db
        if getattr(self, "db", None) is not None:
            return self.db
        repo_db = getattr(image_repo, "db", None)
        if repo_db is not None:
            return repo_db
        try:
            import firebase_admin
            from firebase_admin import firestore as fb_firestore

            if firebase_admin._apps:
                return fb_firestore.client()
        except Exception:
            pass
        return firestore.Client(project=getattr(settings, "FIREBASE_PROJECT_ID", None) or "image-processing-project-ea23d")

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
        file_name: str,
        original_size: int,
        processed_size: int,
        thumbnail_public_id: str,
        medium_public_id: str,
        webp_public_id: str,
        processing_ms: int | float = 0,
        content_type: str | None = None,
    ) -> dict[str, Any]:
        if not thumbnail_public_id or not medium_public_id or not webp_public_id:
            raise InvalidFileException(
                "Thiếu đủ 3 publicId biến thể: thumbnailPublicId, mediumPublicId, webpPublicId."
            )

        checkFile(
            filename=file_name,
            content_type=content_type or "image/jpeg",
            size_bytes=original_size,
        )

        cloud_base = f"https://res.cloudinary.com/{settings.CLOUDINARY_CLOUD_NAME}/image/upload"
        thumbnail_url = f"{cloud_base}/{thumbnail_public_id}"
        medium_url = f"{cloud_base}/{medium_public_id}"
        webp_url = f"{cloud_base}/{webp_public_id}.webp"

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
                "originalName": file_name,
                "mimeType": content_type or "image/jpeg",
                "sizeBytes": original_size,
                "currentFolder": "processed",
                "storagePath": f"processed/{uid}/{file_name}",
                "driveFileId": None,
                "cloudinaryPublicId": medium_public_id,
                "pipelineFolders": {},
                "createdAt": now,
            }

        doc["status"] = "DONE"
        doc["currentFolder"] = "processed"
        doc["processedSize"] = processed_size
        doc["previewUrl"] = webp_url or medium_url or thumbnail_url
        doc["variants"] = {
            "thumbnail": thumbnail_url,
            "medium": medium_url,
            "webp": webp_url,
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

    def _extract_drive_file_id(self, doc: dict[str, Any], image_id: str) -> str | None:
        raw_id = doc.get("driveFileId") or doc.get("drive_file_id")
        if isinstance(raw_id, str) and raw_id.strip():
            return raw_id.strip()
        if image_id.startswith("drive_") and len(image_id) > len("drive_"):
            return image_id[len("drive_") :].strip()
        return None

    def delete_image(self, uid: str, image_id: str, db: firestore.Client | None = None) -> None:
        firestore_db = self._resolve_db(db)
        image_ref = firestore_db.collection("images").document(image_id)
        snap = image_ref.get()
        if not snap.exists:
            raise ImageNotFoundError("Image not found")

        doc = snap.to_dict() or {}
        if doc.get("ownerId") != uid:
            raise ForbiddenImageError("Forbidden")

        provider = (doc.get("provider") or "").strip().lower()

        if provider == "cloudinary":
            public_ids = extract_three_public_ids(doc, image_id)
            delete_resources(public_ids=public_ids)

            batch = firestore_db.batch()
            batch.delete(image_ref)

            for pid in public_ids:
                asset_ref = firestore_db.collection("cloudinaryAssets").document(asset_doc_id(pid))
                batch.delete(asset_ref)

            grant_ref = firestore_db.collection("uploadGrants").document(image_id)
            batch.set(
                grant_ref,
                {
                    "status": "DELETED",
                    "deletedAt": datetime.now(timezone.utc).isoformat(),
                },
                merge=True,
            )
            batch.commit()
            return

        if provider in {"google_drive", "drive"}:
            drive_file_id = self._extract_drive_file_id(doc, image_id)
            if not drive_file_id:
                raise AdminUnavailable("Missing Google Drive fileId")

            # Xóa trên Google Drive trước; nếu lỗi thì raise để trả 503 và giữ nguyên doc
            google_drive_service.delete_file(uid=uid, file_id=drive_file_id)

            batch = firestore_db.batch()
            batch.delete(image_ref)
            grant_ref = firestore_db.collection("uploadGrants").document(image_id)
            if grant_ref.get().exists:
                batch.set(
                    grant_ref,
                    {
                        "status": "DELETED",
                        "deletedAt": datetime.now(timezone.utc).isoformat(),
                    },
                    merge=True,
                )
            batch.commit()
            return

        raise UnsupportedProviderError("Unsupported provider")


image_service = ImageService()