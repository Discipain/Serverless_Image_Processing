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