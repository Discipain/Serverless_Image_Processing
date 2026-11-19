import asyncio
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from app.auth import get_current_uid
from app.services.image_service import image_service
from app.services.google_drive import google_drive_service
from app.exceptions import UnauthorizedException

router = APIRouter(prefix="/images", tags=["Images, Drive & Cloudinary"])


class RequestUploadPayload(BaseModel):
    filename: str
    contentType: str
    sizeBytes: int


class CreateFolderPayload(BaseModel):
    folderName: str
    parentId: str | None = None


async def _run_auto_pipeline_task(uid: str, image_id: str):
    await asyncio.sleep(2)
    image_service.moveToProcessing(uid=uid, image_id=image_id)
    await asyncio.sleep(2)
    image_service.completeProcessing(uid=uid, image_id=image_id)


# ==========================================
# CLOUDINARY USE CASES (UC01, UC02, UC03, UC04)
# ==========================================

@router.post("/cloudinary/upload-url")
def cloudinary_request_upload(
    payload: RequestUploadPayload,
    uid: str = Depends(get_current_uid),
):
    """UC01 (Cloudinary): Kiểm tra file & trả về uploadUrl + imageId theo contract."""
    return image_service.requestUpload(
        uid=uid,
        filename=payload.filename,
        content_type=payload.contentType,
        size_bytes=payload.sizeBytes,
        provider="cloudinary",
    )


@router.post("/cloudinary/upload")
async def cloudinary_upload_image(
    file: UploadFile = File(...),
    uid: str = Depends(get_current_uid),
):
    """UC01 + UC02 (Cloudinary): Upload ảnh lên Cloudinary và sinh variants (thumbnail, medium, webp)."""
    file_bytes = await file.read()
    return image_service.uploadAndProcessCloudinary(
        uid=uid,
        filename=file.filename or "upload.jpg",
        content_type=file.content_type or "image/jpeg",
        file_bytes=file_bytes,
    )


@router.post("/cloudinary/{image_id}/process")
def cloudinary_process_image(
    image_id: str,
    uid: str = Depends(get_current_uid),
):
    """UC02 (Cloudinary): Xử lý / tạo lại variants cho ảnh trên Cloudinary."""
    return image_service.processCloudinaryImage(uid=uid, image_id=image_id)


@router.get("/cloudinary")
def cloudinary_list_images(uid: str = Depends(get_current_uid)):
    """UC04 (Cloudinary): Danh sách ảnh của user (lọc provider=cloudinary)."""
    data = image_service.listImages(uid=uid)
    cloudinary_items = [item for item in data["items"] if item.get("provider") == "cloudinary"]
    return {
        "ownerId": uid,
        "provider": "cloudinary",
        "total": len(cloudinary_items),
        "items": cloudinary_items,
    }


@router.get("/cloudinary/{image_id}")
def cloudinary_get_image_status(
    image_id: str,
    uid: str = Depends(get_current_uid),
):
    """UC03 (Cloudinary): Xem chi tiết & trạng thái ảnh (chặn 403 nếu không phải chủ sở hữu)."""
    return image_service.getImage(uid=uid, image_id=image_id)


# ==========================================
# GOOGLE DRIVE & CORE USE CASES (UC01, UC03, UC04)
# ==========================================

@router.get("/preview/{drive_file_id}")
def preview_drive_image(
    drive_file_id: str,
    uid: str | None = Query(default=None),
):
    if not uid:
        raise UnauthorizedException("Thiếu uid xác thực để xem ảnh.")
    image_bytes, mime_type = google_drive_service.download_file_bytes(uid=uid, file_id=drive_file_id)
    return Response(content=image_bytes, media_type=mime_type)


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
        provider="google_drive",
    )


@router.post("/upload-drive")
async def upload_to_google_drive(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    folderId: str | None = Form(default=None),
    autoProcess: bool = Form(default=False),
    uid: str = Depends(get_current_uid),
):
    file_bytes = await file.read()
    result = image_service.uploadAndInitPipeline(
        uid=uid,
        filename=file.filename or "upload.jpg",
        content_type=file.content_type or "image/jpeg",
        file_bytes=file_bytes,
        root_folder_id=folderId or None,
    )

    if autoProcess:
        background_tasks.add_task(_run_auto_pipeline_task, uid, result["image"]["imageId"])

    return result


@router.post("/{image_id}/process")
def start_processing_image(image_id: str, uid: str = Depends(get_current_uid)):
    return image_service.moveToProcessing(uid=uid, image_id=image_id)


@router.post("/{image_id}/complete")
def complete_processing_image(image_id: str, uid: str = Depends(get_current_uid)):
    return image_service.completeProcessing(uid=uid, image_id=image_id)


@router.get("")
def list_images(uid: str = Depends(get_current_uid)):
    return image_service.listImages(uid=uid)


@router.get("/{image_id}")
def get_image_status(image_id: str, uid: str = Depends(get_current_uid)):
    return image_service.getImage(uid=uid, image_id=image_id)