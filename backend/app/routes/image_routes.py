from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel
from app.auth import get_current_uid
from app.services.image_service import image_service
from app.services.google_drive import google_drive_service
from app.exceptions import InvalidFileException

router = APIRouter(prefix="/images", tags=["Images, Google Drive & Cloudinary"])


class RequestUploadPayload(BaseModel):
    filename: str
    contentType: str
    sizeBytes: int

class CreateFolderPayload(BaseModel):
    folderName: str
    parentId: str | None = None


@router.post("/sync")
def sync_images_from_sources(
    folderId: str | None = Query(default=None),
    uid: str = Depends(get_current_uid),
):
    """Chủ động đồng bộ ảnh từ Google Drive của chính user (Cloudinary không còn được quét tự động)."""
    sync_stats = image_service.syncExternalImages(uid=uid, root_folder_id=folderId)
    gallery = image_service.listImages(uid=uid, auto_sync=False)
    return {
        "sync": sync_stats,
        **gallery,
    }


@router.post("/cloudinary/confirm")
async def cloudinary_confirm(
    request: Request,
    uid: str = Depends(get_current_uid),
):
    """API duy nhất Frontend gọi sau khi upload Cloudinary xong (CONTRACT mục 3).

    Xác thực chạy TRƯỚC (thiếu/sai token => 401). Body được đọc thô để mọi lỗi dữ liệu là 400 theo CONTRACT
    (FastAPI mặc định trả 422). `uid` chỉ lấy từ token, không từ body.
    """
    try:
        body = await request.json()
    except ValueError:
        raise InvalidFileException("Invalid body") from None
    return await run_in_threadpool(image_service.confirmCloudinaryUpload, uid, body)

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
    uid: str = Depends(get_current_uid),
):
    """Xem ảnh Google Drive. Bắt buộc Firebase Bearer; uid CHỈ lấy từ token (mọi `?uid=` trong query bị bỏ qua).

    Chỉ trả ảnh khi có bản ghi thuộc `uid` trỏ tới file đó (không có => 404, của người khác => 403 `Forbidden`).
    Vì thẻ <img src> không gửi được header Authorization, Frontend phải gọi bằng fetch kèm Bearer rồi tạo blob URL.
    """
    image_bytes, mime_type = image_service.getDrivePreview(uid=uid, drive_file_id=drive_file_id)
    return Response(
        content=image_bytes,
        media_type=mime_type,
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.get("")
def list_images(
    folderId: str | None = Query(default=None),
    uid: str = Depends(get_current_uid),
):
    """UC04: Danh sách ảnh CỦA user đang đăng nhập (uid từ Firebase ID token). Tự đồng bộ Google Drive của chính user;
    KHÔNG quét Cloudinary (tài nguyên Cloudinary chỉ được đăng ký qua POST /images/cloudinary/confirm)."""
    return image_service.listImages(uid=uid, auto_sync=True, root_folder_id=folderId)


@router.get("/{image_id}")
def get_image_status(image_id: str, uid: str = Depends(get_current_uid)):
    """UC03: Xem chi tiết trạng thái ảnh (kiểm tra ownerId == uid -> 403)."""
    return image_service.getImage(uid=uid, image_id=image_id)