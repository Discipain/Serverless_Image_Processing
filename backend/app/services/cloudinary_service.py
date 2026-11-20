import requests
from cloudinary.utils import cloudinary_url
from app.config import settings
from app.exceptions import InvalidFileException


class CloudinaryService:
    def upload_image(
        self,
        file_bytes: bytes,
        filename: str,
        public_id: str,
        folder: str = "uploads",
    ) -> dict:
        """Gọi trực tiếp Unsigned Upload API của Cloudinary bằng cloud_name & upload_preset."""
        upload_url = f"https://api.cloudinary.com/v1_1/{settings.CLOUDINARY_CLOUD_NAME}/image/upload"

        data = {
            "upload_preset": settings.CLOUDINARY_UPLOAD_PRESET,
            "public_id": public_id,
            "folder": folder,
        }
        files = {
            "file": (filename, file_bytes),
        }

        response = requests.post(upload_url, data=data, files=files, timeout=30)
        res_json = response.json()

        if response.status_code != 200:
            error_msg = res_json.get("error", {}).get("message", "Unknown Cloudinary error")
            raise InvalidFileException(f"Lỗi upload Cloudinary: {error_msg}")

        actual_public_id = res_json.get("public_id", f"{folder}/{public_id}")
        variants = self.build_variants(actual_public_id)

        return {
            "publicId": actual_public_id,
            "assetId": res_json.get("asset_id"),
            "secureUrl": res_json.get("secure_url"),
            "format": res_json.get("format"),
            "width": res_json.get("width"),
            "height": res_json.get("height"),
            "bytes": res_json.get("bytes"),
            "variants": variants,
        }

    def build_variants(self, public_id: str) -> dict[str, str]:
        """Tạo URL cho 3 biến thể cố định: thumbnail, medium, webp."""
        cloud = settings.CLOUDINARY_CLOUD_NAME
        thumb_url, _ = cloudinary_url(
            public_id,
            cloud_name=cloud,
            width=200,
            height=200,
            crop="fill",
            gravity="auto",
            format="webp",
            quality="auto",
            secure=True,
        )
        medium_url, _ = cloudinary_url(
            public_id,
            cloud_name=cloud,
            width=800,
            height=800,
            crop="limit",
            format="webp",
            quality="auto",
            secure=True,
        )
        webp_url, _ = cloudinary_url(
            public_id,
            cloud_name=cloud,
            format="webp",
            quality="auto",
            secure=True,
        )
        return {
            "thumbnail": thumb_url,
            "medium": medium_url,
            "webp": webp_url,
        }


cloudinary_service = CloudinaryService()