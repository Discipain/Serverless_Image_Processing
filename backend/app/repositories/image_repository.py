import os
from typing import Any
import firebase_admin
from firebase_admin import credentials as fb_credentials, firestore
from app.config import settings


class ImageRepository:
    """Repository lưu metadata ảnh vào Firestore collection `images`."""

    COLLECTION_NAME = "images"

    def __init__(self) -> None:
        self._db = self._init_firestore()
        self._memory_fallback: dict[str, dict[str, Any]] = {}

    def _init_firestore(self):
        try:
            if not firebase_admin._apps:
                if os.path.exists(settings.FIREBASE_CREDENTIALS_FILE):
                    cred = fb_credentials.Certificate(settings.FIREBASE_CREDENTIALS_FILE)
                    firebase_admin.initialize_app(cred, {"projectId": settings.FIREBASE_PROJECT_ID})
                else:
                    firebase_admin.initialize_app(options={"projectId": settings.FIREBASE_PROJECT_ID})
            return firestore.client()
        except Exception:
            return None

    def save(self, image_doc: dict[str, Any]) -> dict[str, Any]:
        image_id = image_doc["imageId"]
        self._memory_fallback[image_id] = image_doc
        if self._db is not None:
            self._db.collection(self.COLLECTION_NAME).document(image_id).set(image_doc)
        return image_doc

    def get_by_id(self, image_id: str) -> dict[str, Any] | None:
        if self._db is not None:
            snap = self._db.collection(self.COLLECTION_NAME).document(image_id).get()
            if snap.exists:
                data = snap.to_dict() or {}
                self._memory_fallback[image_id] = data
                return data
        return self._memory_fallback.get(image_id)

    def list_by_owner(self, owner_id: str) -> list[dict[str, Any]]:
        if self._db is not None:
            docs = (
                self._db.collection(self.COLLECTION_NAME)
                .where("ownerId", "==", owner_id)
                .stream()
            )
            results = [d.to_dict() or {} for d in docs]
            for item in results:
                if "imageId" in item:
                    self._memory_fallback[item["imageId"]] = item
            return results
        return [doc for doc in self._memory_fallback.values() if doc.get("ownerId") == owner_id]


image_repo = ImageRepository()