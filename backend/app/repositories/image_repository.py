from typing import Any


class ImageRepository:
    """Kho lưu trữ metadata ảnh tuân thủ SCHEMA.md."""

    def __init__(self) -> None:
        self._images: dict[str, dict[str, Any]] = {}

    def save(self, image_doc: dict[str, Any]) -> dict[str, Any]:
        self._images[image_doc["imageId"]] = image_doc
        return image_doc

    def get_by_id(self, image_id: str) -> dict[str, Any] | None:
        return self._images.get(image_id)

    def list_by_owner(self, owner_id: str) -> list[dict[str, Any]]:
        return [doc for doc in self._images.values() if doc["ownerId"] == owner_id]


image_repo = ImageRepository()