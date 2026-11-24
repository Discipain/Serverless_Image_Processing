from fastapi import HTTPException, status


class InvalidFileException(HTTPException):
    def __init__(self, detail: str):
        super().__init__(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


class ForbiddenAccessException(HTTPException):
    def __init__(self, detail: str = "403 Forbidden: Bạn không có quyền truy cập tài nguyên này"):
        super().__init__(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


class NotFoundException(HTTPException):
    def __init__(self, detail: str = "Không tìm thấy dữ liệu"):
        super().__init__(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


class UnauthorizedException(HTTPException):
    def __init__(self, detail: str = "Chưa xác thực người dùng"):
        super().__init__(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)


class StorageUnavailableException(HTTPException):
    """Kho metadata (Firestore) không dùng được. Không lộ chi tiết nội bộ cho client."""

    def __init__(self, detail: str = "Storage unavailable"):
        super().__init__(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=detail)


class ConflictException(HTTPException):
    """Xung đột trạng thái (vd grant upload đã hết hạn / khai báo khác lần cấp trước)."""

    def __init__(self, detail: str = "Conflict"):
        super().__init__(status_code=status.HTTP_409_CONFLICT, detail=detail)


class TooManyRequestsException(HTTPException):
    def __init__(self, detail: str = "Too many requests", retry_after_seconds: int | None = None):
        headers = {"Retry-After": str(max(1, int(retry_after_seconds)))} if retry_after_seconds else None
        super().__init__(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=detail, headers=headers)


class UploadVerificationUnavailableException(HTTPException):
    """Không xác minh được asset Cloudinary lúc này (Admin API lỗi/quá tải/timeout/sai cấu hình). Không lộ chi tiết; client có thể thử lại."""

    def __init__(self, detail: str = "Upload verification unavailable", retry_after_seconds: int | None = None):
        headers = {"Retry-After": str(max(1, int(retry_after_seconds)))} if retry_after_seconds else None
        super().__init__(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=detail, headers=headers)


class SignedUploadUnavailableException(HTTPException):
    """Tính năng cấp chữ ký upload đang tắt hoặc cấu hình Backend thiếu/sai. Không lộ tên hay giá trị cấu hình cho client."""

    def __init__(self, detail: str = "Signed upload unavailable"):
        super().__init__(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=detail)
