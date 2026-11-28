import io
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseDownload, MediaIoBaseUpload
from app.exceptions import UnauthorizedException
from app.services.cloudinary_admin import AdminUnavailable
from app.services.google_oauth import google_oauth_service


class GoogleDriveService:
    ROOT_FOLDER_NAME = "App_Image_Pipeline"
    STAGE_FOLDERS = ("upload", "processing", "processed")

    def _get_drive_client(self, uid: str):
        creds = google_oauth_service.get_user_credentials(uid)
        if not creds:
            raise UnauthorizedException(
                "Tài khoản chưa liên kết Google Drive. Vui lòng đăng nhập Google trước."
            )
        return build("drive", "v3", credentials=creds)

    def create_folder(self, uid: str, folder_name: str, parent_id: str | None = None) -> dict:
        drive_service = self._get_drive_client(uid)
        query = (
            f"name='{folder_name}' and "
            "mimeType='application/vnd.google-apps.folder' and trashed=false"
        )
        if parent_id:
            query += f" and '{parent_id}' in parents"

        results = drive_service.files().list(q=query, fields="files(id, name, webViewLink)").execute()
        existing = results.get("files", [])
        if existing:
            return {
                "folderId": existing[0]["id"],
                "folderName": existing[0]["name"],
                "webViewLink": existing[0].get("webViewLink", ""),
                "existed": True,
            }

        folder_metadata: dict = {
            "name": folder_name,
            "mimeType": "application/vnd.google-apps.folder",
        }
        if parent_id:
            folder_metadata["parents"] = [parent_id]

        folder = (
            drive_service.files()
            .create(body=folder_metadata, fields="id, name, webViewLink")
            .execute()
        )
        return {
            "folderId": folder["id"],
            "folderName": folder["name"],
            "webViewLink": folder.get("webViewLink", ""),
            "existed": False,
        }

    def ensure_pipeline_folders(self, uid: str, root_folder_id: str | None = None) -> dict[str, str]:
        if not root_folder_id:
            root = self.create_folder(uid, self.ROOT_FOLDER_NAME)
            root_folder_id = root["folderId"]

        mapping = {"root": root_folder_id}
        for stage in self.STAGE_FOLDERS:
            folder_info = self.create_folder(uid, stage, parent_id=root_folder_id)
            mapping[stage] = folder_info["folderId"]
        return mapping

    def list_images_in_folder(self, uid: str, folder_id: str) -> list[dict]:
        """Đọc danh sách file ảnh (jpeg/png/webp) nằm trong một thư mục Google Drive cụ thể."""
        drive_service = self._get_drive_client(uid)
        query = (
            f"'{folder_id}' in parents and trashed=false and "
            "(mimeType='image/jpeg' or mimeType='image/png' or mimeType='image/webp')"
        )
        results = (
            drive_service.files()
            .list(
                q=query,
                pageSize=100,
                fields="files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink)",
            )
            .execute()
        )
        return results.get("files", [])

    def list_all_pipeline_images(self, uid: str, root_folder_id: str | None = None) -> list[dict]:
        """Tự động quét và đọc toàn bộ ảnh từ 3 thư mục upload/, processing/, processed/ trên Drive."""
        folders = self.ensure_pipeline_folders(uid, root_folder_id)
        stage_to_status = {
            "upload": "PENDING",
            "processing": "PROCESSING",
            "processed": "DONE",
        }

        collected: list[dict] = []
        for stage in self.STAGE_FOLDERS:
            folder_id = folders[stage]
            files = self.list_images_in_folder(uid, folder_id)
            for f in files:
                collected.append({
                    "driveFileId": f["id"],
                    "name": f["name"],
                    "mimeType": f.get("mimeType", "image/jpeg"),
                    "sizeBytes": int(f.get("size", 0)),
                    "stage": stage,
                    "status": stage_to_status[stage],
                    "webViewLink": f.get("webViewLink", ""),
                    "createdTime": f.get("createdTime"),
                    "modifiedTime": f.get("modifiedTime"),
                    "pipelineFolders": folders,
                })
        return collected

    def upload_bytes_to_folder(
        self,
        uid: str,
        filename: str,
        content_type: str,
        file_bytes: bytes,
        folder_id: str,
    ) -> dict[str, str]:
        drive_service = self._get_drive_client(uid)
        file_metadata = {
            "name": filename,
            "parents": [folder_id],
        }
        media = MediaIoBaseUpload(io.BytesIO(file_bytes), mimetype=content_type, resumable=True)
        uploaded = (
            drive_service.files()
            .create(body=file_metadata, media_body=media, fields="id, webViewLink, parents")
            .execute()
        )
        return {
            "driveFileId": uploaded["id"],
            "webViewLink": uploaded.get("webViewLink", ""),
            "folderId": folder_id,
        }

    def move_file_to_folder(self, uid: str, file_id: str, target_folder_id: str) -> dict[str, str]:
        drive_service = self._get_drive_client(uid)
        file_info = drive_service.files().get(fileId=file_id, fields="parents").execute()
        previous_parents = ",".join(file_info.get("parents", []))

        updated = (
            drive_service.files()
            .update(
                fileId=file_id,
                addParents=target_folder_id,
                removeParents=previous_parents,
                fields="id, parents, webViewLink",
            )
            .execute()
        )
        return {
            "driveFileId": updated["id"],
            "folderId": target_folder_id,
            "webViewLink": updated.get("webViewLink", ""),
        }

    def download_file_bytes(self, uid: str, file_id: str) -> tuple[bytes, str]:
        drive_service = self._get_drive_client(uid)
        meta = drive_service.files().get(fileId=file_id, fields="mimeType").execute()
        mime_type = meta.get("mimeType", "image/jpeg")

        request = drive_service.files().get_media(fileId=file_id)
        buffer = io.BytesIO()
        downloader = MediaIoBaseDownload(buffer, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()

        return buffer.getvalue(), mime_type

    def delete_file(self, uid: str, file_id: str) -> None:
        if not file_id or not str(file_id).strip():
            raise ValueError("Missing Google Drive file_id")

        drive_service = self._get_drive_client(uid)
        try:
            drive_service.files().delete(fileId=file_id.strip()).execute()
        except HttpError as exc:
            status_code = getattr(exc.resp, "status", None)
            if status_code == 404:
                return
            raise AdminUnavailable(f"Google Drive delete failed ({status_code})") from exc
        except Exception as exc:
            raise AdminUnavailable(f"Google Drive delete error: {exc}") from exc


google_drive_service = GoogleDriveService()