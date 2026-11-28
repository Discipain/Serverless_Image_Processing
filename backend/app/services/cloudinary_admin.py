import hashlib
import json
import os
import re
from typing import Iterable
import logging
from urllib.parse import urlencode, urlparse

import requests


class AdminError(Exception):
    """Lỗi thao tác Cloudinary Admin API."""


class AdminRateLimited(AdminError):
    """Cloudinary Admin API trả về 429 Too Many Requests."""


class AdminUnavailable(AdminError):
    """Cloudinary Admin API timeout, lỗi mạng hoặc lỗi 5xx."""


def _get_cloudinary_credentials() -> tuple[str, str, str]:
    try:
        from app.config import settings
    except Exception:
        settings = None

    def _pick(*names: str) -> str:
        for name in names:
            val = os.getenv(name)
            if isinstance(val, str) and val.strip():
                return val.strip()
            if settings is not None:
                s_val = getattr(settings, name, None)
                if isinstance(s_val, str) and s_val.strip():
                    return s_val.strip()
        return ""

    cloud_name = _pick("CLOUDINARY_CLOUD_NAME", "CLOUDINARY_CLOUD")
    api_key = _pick("CLOUDINARY_API_KEY")
    api_secret = _pick("CLOUDINARY_API_SECRET")

    if not cloud_name or not api_key or not api_secret:
        raise AdminUnavailable("Missing Cloudinary admin credentials")

    return cloud_name, api_key, api_secret

def asset_doc_id(public_id: str) -> str:
    """Sinh document ID cho collection cloudinaryAssets theo sha256(public_id)."""
    return hashlib.sha256(public_id.strip().encode("utf-8")).hexdigest()


def parse_cloudinary_url(url: str | None) -> str | None:
    """
    Tách public_id từ URL Cloudinary.
    Hỗ trợ dạng:
    https://res.cloudinary.com/<cloud>/image/upload/<optional_transformations>/v<version>/<public_id>.<ext>
    """
    if not url or not isinstance(url, str):
        return None

    parsed = urlparse(url.strip())
    if not parsed.path:
        return None

    match = re.search(r"/image/upload/(?:[^/]+/)*?(?:v\d+/)?(.+)$", parsed.path)
    if not match:
        return None

    public_id_with_ext = match.group(1)
    public_id, _ = os.path.splitext(public_id_with_ext)
    return public_id or None


def extract_three_public_ids(image_doc: dict, image_id: str) -> list[str]:
    """
    Lấy danh sách public_id cho thumb, medium, full từ field publicIds.
    Nếu doc cũ không có publicIds thì tách từ URL bằng parse_cloudinary_url.
    Fallback cuối cùng theo quy ước hybrid/<UPLOAD_ENVIRONMENT>/<imageId>/thumb|medium|full.
    """
    variants = ("thumb", "medium", "full")
    env_name = (os.getenv("UPLOAD_ENVIRONMENT") or "dev").strip()
    collected: list[str] = []

    raw_public_ids = image_doc.get("publicIds")
    if isinstance(raw_public_ids, dict):
        for key in variants:
            val = raw_public_ids.get(key)
            if isinstance(val, str) and val.strip():
                collected.append(val.strip())
    elif isinstance(raw_public_ids, (list, tuple)):
        for val in raw_public_ids:
            if isinstance(val, str) and val.strip():
                collected.append(val.strip())

    if not collected:
        url_candidates = []
        raw_variants = image_doc.get("variants")
        if isinstance(raw_variants, dict):
            for k in ("thumbnail", "thumb", "medium", "full", "original", "webp"):
                if isinstance(raw_variants.get(k), str) and raw_variants.get(k).strip():
                    url_candidates.append(raw_variants[k].strip())

        for extra_key in ("previewUrl", "secureUrl", "url", "imageUrl"):
            if isinstance(image_doc.get(extra_key), str) and image_doc.get(extra_key).strip():
                url_candidates.append(image_doc[extra_key].strip())

        for u in url_candidates:
            pid = parse_cloudinary_url(u)
            if pid and pid not in collected:
                collected.append(pid)

    if not collected:
        collected = [f"hybrid/{env_name}/{image_id}/{v}" for v in variants]

    # Loại trùng lặp giữ nguyên thứ tự
    deduped: list[str] = []
    for pid in collected:
        if pid not in deduped:
            deduped.append(pid)
    return deduped


def get_resources(
    public_ids: Iterable[str],
    timeout: float = 10.0,
    max_response_bytes: int = 1024 * 1024,
) -> dict:
    """Đọc thông tin resources từ Cloudinary Admin API (không log key/secret)."""
    ids = [pid.strip() for pid in public_ids if pid and pid.strip()]
    if not ids:
        return {"resources": []}

    cloud_name, api_key, api_secret = _get_cloudinary_credentials()
    base_url = f"https://api.cloudinary.com/v1_1/{cloud_name}/resources/image/upload"
    query = urlencode([("public_ids[]", pid) for pid in ids])
    url = f"{base_url}?{query}"

    try:
        resp = requests.get(
            url,
            auth=(api_key, api_secret),
            timeout=timeout,
            stream=True,
        )
        chunks: list[bytes] = []
        total = 0
        for chunk in resp.iter_content(chunk_size=16384):
            if not chunk:
                continue
            total += len(chunk)
            if total > max_response_bytes:
                raise AdminError("Cloudinary admin response exceeded size limit")
            chunks.append(chunk)
        raw_body = b"".join(chunks).decode("utf-8", errors="replace")
    except requests.Timeout as exc:
        raise AdminUnavailable("Cloudinary admin request timed out") from exc
    except requests.RequestException as exc:
        raise AdminUnavailable("Cloudinary admin network error") from exc

    if resp.status_code == 429:
        raise AdminRateLimited("Cloudinary admin rate limited")
    if resp.status_code >= 500:
        raise AdminUnavailable(f"Cloudinary admin upstream error ({resp.status_code})")
    if resp.status_code >= 400:
        raise AdminError(f"Cloudinary admin rejected request ({resp.status_code})")

    try:
        return json.loads(raw_body) if raw_body else {}
    except ValueError as exc:
        raise AdminError("Invalid JSON from Cloudinary admin") from exc


def delete_resources(
    public_ids: Iterable[str],
    timeout: float = 10.0,
    max_response_bytes: int = 1024 * 1024,
) -> dict[str, str]:
    """
    Xóa nhiều resource trên Cloudinary Admin API bằng 1 request DELETE.
    Có giới hạn timeout và kích thước response, không retry, không log key/secret.
    Asset trả 'not_found' được coi như đã xóa.
    """
    ids = [pid.strip() for pid in public_ids if pid and pid.strip()]
    if not ids:
        return {}

    cloud_name, api_key, api_secret = _get_cloudinary_credentials()
    base_url = f"https://api.cloudinary.com/v1_1/{cloud_name}/resources/image/upload"
    query = urlencode([("public_ids[]", pid) for pid in ids])
    url = f"{base_url}?{query}"

    try:
        resp = requests.delete(
            url,
            auth=(api_key, api_secret),
            timeout=timeout,
            stream=True,
        )
        chunks: list[bytes] = []
        total = 0
        for chunk in resp.iter_content(chunk_size=16384):
            if not chunk:
                continue
            total += len(chunk)
            if total > max_response_bytes:
                raise AdminError("Cloudinary delete response exceeded size limit")
            chunks.append(chunk)
        raw_body = b"".join(chunks).decode("utf-8", errors="replace")
    except requests.Timeout as exc:
        raise AdminUnavailable("Cloudinary delete timed out") from exc
    except requests.RequestException as exc:
        raise AdminUnavailable("Cloudinary delete network error") from exc

    if resp.status_code == 429:
        raise AdminRateLimited("Cloudinary delete rate limited")
    if resp.status_code >= 500:
        raise AdminUnavailable(f"Cloudinary delete upstream error ({resp.status_code})")
    if resp.status_code >= 400:
        raise AdminError(f"Cloudinary delete rejected ({resp.status_code})")

    try:
        payload = json.loads(raw_body) if raw_body else {}
    except ValueError as exc:
        raise AdminError("Invalid JSON from Cloudinary delete") from exc

    deleted = payload.get("deleted")
    if not isinstance(deleted, dict):
        deleted = {}

    result: dict[str, str] = {}
    for pid in ids:
        status_val = str(deleted.get(pid, "deleted")).lower()
        if status_val in {"deleted", "not_found"}:
            result[pid] = status_val
        else:
            raise AdminError(f"Unexpected delete status '{status_val}' for {pid}")

    return result

logger = logging.getLogger(__name__)