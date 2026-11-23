"""Dữ liệu giả dùng chung cho test confirm. Cloud name khớp conftest (`test-cloud`), không phải cloud thật của nhóm."""
from typing import Any

CLOUD = "test-cloud"
IMAGE_ID = "b1f4c2e0-7a31-4c8e-9f12-3d5a6e7b8c90"
IMAGE_ID_2 = "c2a5d3f1-8b42-4d9f-a023-4e6b7f8c9da1"


def bearer(uid: str) -> dict[str, str]:
    """Header hợp lệ cho `uid` (token giả `token-<uid>`, xem conftest.fake_firebase_auth)."""
    return {"Authorization": f"Bearer token-{uid}"}


def cloud_url(public_id: str, ext: str = "webp", cloud: str = CLOUD) -> str:
    return f"https://res.cloudinary.com/{cloud}/image/upload/v1700000000/{public_id}.{ext}"


def minimal_payload(image_id: str = IMAGE_ID, suffix: str = "") -> dict[str, Any]:
    """Đúng 6 field bắt buộc của CONTRACT."""
    return {
        "imageId": image_id,
        "thumbnail": cloud_url(f"thumb{suffix}abc123"),
        "medium": cloud_url(f"medium{suffix}def456"),
        "webp": cloud_url(f"full{suffix}ghi789"),
        "originalSize": 2457600,
        "processingMs": 1840,
    }


def full_payload(image_id: str = IMAGE_ID, suffix: str = "") -> dict[str, Any]:
    """6 bắt buộc + đủ 7 tùy chọn (không có contentType)."""
    payload = minimal_payload(image_id, suffix)
    payload.update(
        {
            "fileName": "anh-bien.jpg",
            "width": 4000,
            "height": 3000,
            "thumbnailId": f"thumb{suffix}abc123",
            "mediumId": f"medium{suffix}def456",
            "webpId": f"full{suffix}ghi789",
            "processedSize": 412000,
        }
    )
    return payload
