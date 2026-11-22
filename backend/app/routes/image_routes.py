from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from pydantic import BaseModel
from app.auth import get_current_uid
from app.services.image_service import image_service
from app.services.google_drive import google_drive_service
from app.exceptions import UnauthorizedException

router = APIRouter(prefix="/images", tags=["Images, Google Drive & Cloudinary"])


class RequestUploadPayload(BaseModel):
    filename: str
    contentType: str
    sizeBytes: int

class CloudinaryConfirmPayload(BaseModel):
    imageId: str
    fileName: str
    originalSize: int
    processedSize: int
    thumbnailPublicId: str
    mediumPublicId: str
    webpPublicId: str
    processingMs: int | float = 0
    contentType: str | None = None


class CreateFolderPayload(BaseModel):
    folderName: str
    parentId: str | None = None


@router.post("/sync")
def sync_images_from_sources(
    folderId: str | None = Query(default=None),
    uid: str = Depends(get_current_uid),
):
    """Chủ động quét và đọc toàn bộ ảnh từ Google Drive folder & Cloudinary."""
    sync_stats = image_service.syncExternalImages(uid=uid, root_folder_id=folderId)
    gallery = image_service.listImages(uid=uid, auto_sync=False)
    return {
        "sync": sync_stats,
        **gallery,
    }


@router.post("/cloudinary/confirm")
def cloudinary_confirm(
    payload: CloudinaryConfirmPayload,
    uid: str = Depends(get_current_uid),
):
    """API duy nhất Frontend gọi sau khi upload Cloudinary xong."""
    return image_service.confirmCloudinaryUpload(
        uid=uid,
        image_id=payload.imageId,
        file_name=payload.fileName,
        original_size=payload.originalSize,
        processed_size=payload.processedSize,
        thumbnail_public_id=payload.thumbnailPublicId,
        medium_public_id=payload.mediumPublicId,
        webp_public_id=payload.webpPublicId,
        processing_ms=payload.processingMs,
        content_type=payload.contentType,
    )

@router.post("/upload-url")
def get_upload_url(
    payload: RequestUploadPayload,
    uid: str = Depends(get_current_uid),
):
    return image_service.requestUpload(
        uid=uid,
        filename=payload.filename,
        content_type=payload.contentType,
        size_bytes=payload.sizeBytes,
        provider="cloudinary",
    )


@router.post("/drive/folders")
def create_google_drive_folder(
    payload: CreateFolderPayload,
    uid: str = Depends(get_current_uid),
):
    root = google_drive_service.create_folder(
        uid=uid,
        folder_name=payload.folderName,
        parent_id=payload.parentId,
    )
    stages = google_drive_service.ensure_pipeline_folders(uid, root["folderId"])
    return {**root, "pipelineFolders": stages}


@router.get("/preview/{drive_file_id}")
def preview_drive_image(
    drive_file_id: str,
    uid: str | None = Query(default=None),
):
    if not uid:
        raise UnauthorizedException("Thiếu uid xác thực để xem ảnh.")
    image_bytes, mime_type = google_drive_service.download_file_bytes(uid=uid, file_id=drive_file_id)
    return Response(content=image_bytes, media_type=mime_type)


@router.get("")
def list_images(
    folderId: str | None = Query(default=None),
    uid: str = Depends(get_current_uid),
):
    """UC04: Tự động đọc ảnh từ Google Drive folder & Cloudinary + trả về danh sách ảnh của user."""
    return image_service.listImages(uid=uid, auto_sync=True, root_folder_id=folderId)


@router.get("/{image_id}")
def get_image_status(image_id: str, uid: str = Depends(get_current_uid)):
    """UC03: Xem chi tiết trạng thái ảnh (kiểm tra ownerId == uid -> 403)."""
    return image_service.getImage(uid=uid, image_id=image_id)