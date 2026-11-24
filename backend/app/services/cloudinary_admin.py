"""Client Cloudinary Admin API TỐI GIẢN (H4B-3): chỉ MỘT thao tác ĐỌC — lấy metadata của các asset theo public_id.

`GET https://api.cloudinary.com/v1_1/<cloud>/resources/image/upload?public_ids[]=...&tags=true&context=true` (Basic auth key:secret).

Vì sao không dùng `cloudinary.api.resources_by_ids` của SDK: SDK gọi bằng PoolManager dùng chung với retry mặc định của urllib3 (GET bị thử lại tới 3 lần),
nên thời gian chờ thực tế = nhiều lần `timeout` và không chỉnh được theo từng lời gọi. Ở đây: KHÔNG retry, timeout theo từng lời gọi, hạn chế kích thước
response, và mọi lỗi được quy về vài loại lỗi cố định KHÔNG chứa nội dung phản hồi hay thông tin xác thực.

Giao thức `CloudinaryAdminClient` để tiêm giả (fake) khi test. Chỉ ĐỌC: không upload, không xóa, không ghi gì lên Cloudinary.
Chưa được kiểm chứng với Cloudinary thật (xem H4B-7): hình dạng response được viết theo tài liệu Admin API.
"""
import email.utils
import json
import logging
import time
from typing import Any, Protocol
from urllib.parse import urlencode

import certifi
import urllib3
from urllib3.util import Timeout, make_headers

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.cloudinary.com"
MAX_PUBLIC_IDS = 100  # giới hạn của Admin API cho một lời gọi
MAX_RESPONSE_BYTES = 256 * 1024
DEFAULT_RATE_LIMIT_RETRY_SECONDS = 60
MAX_RATE_LIMIT_RETRY_SECONDS = 3600


class AdminError(Exception):
    """Lỗi gọi Admin API. Thông điệp KHÔNG chứa nội dung phản hồi, URL có credential hay secret."""


class AdminNotFound(AdminError):
    """HTTP 404."""


class AdminRateLimited(AdminError):
    """HTTP 420 (hết lượt Admin API theo giờ)."""

    def __init__(self, retry_after_seconds: int = DEFAULT_RATE_LIMIT_RETRY_SECONDS) -> None:
        super().__init__("Admin API rate limited")
        self.retry_after_seconds = retry_after_seconds


class AdminConfigError(AdminError):
    """HTTP 401/403: key/secret/cloud sai hoặc không đủ quyền."""


class AdminUnavailable(AdminError):
    """5xx, timeout, mất kết nối, response không phải JSON hợp lệ/quá lớn, hoặc trạng thái không mong đợi."""


class CloudinaryAdminClient(Protocol):
    def get_resources(self, public_ids: list[str], *, timeout: float) -> dict[str, Any]:
        """Trả về JSON đã phân tích của Admin API (dict có khóa "resources"). Raise AdminError (và lớp con) khi lỗi."""


_POOL: urllib3.PoolManager | None = None


def _pool() -> urllib3.PoolManager:
    global _POOL
    if _POOL is None:
        _POOL = urllib3.PoolManager(cert_reqs="CERT_REQUIRED", ca_certs=certifi.where(), retries=False)
    return _POOL


def _rate_limit_retry_seconds(headers: Any) -> int:
    """Số giây tới lúc Cloudinary reset đếm theo giờ (header X-FeatureRateLimit-Reset, dạng ngày HTTP). Thiếu/sai => 60 giây."""
    raw = headers.get("x-featureratelimit-reset") if headers is not None else None
    try:
        reset_at = email.utils.parsedate_to_datetime(raw).timestamp() if raw else None
    except (TypeError, ValueError):
        reset_at = None
    if reset_at is None:
        return DEFAULT_RATE_LIMIT_RETRY_SECONDS
    return int(min(MAX_RATE_LIMIT_RETRY_SECONDS, max(1, reset_at - time.time())))


class HttpCloudinaryAdminClient:
    """Cài đặt thật bằng urllib3. `base_url` chỉ để test (máy chủ localhost); cấu hình chạy thật luôn dùng https://api.cloudinary.com."""

    def __init__(self, cloud_name: str, api_key: str, api_secret: str, *, base_url: str = DEFAULT_BASE_URL, pool: urllib3.PoolManager | None = None) -> None:
        self._cloud_name = cloud_name
        self._auth_headers = make_headers(basic_auth=f"{api_key}:{api_secret}")
        self._base_url = base_url.rstrip("/")
        self._injected_pool = pool

    def __repr__(self) -> str:
        return f"HttpCloudinaryAdminClient(cloud_name={self._cloud_name!r}, credentials=<ẩn>)"

    def get_resources(self, public_ids: list[str], *, timeout: float) -> dict[str, Any]:
        if not public_ids or len(public_ids) > MAX_PUBLIC_IDS or not isinstance(timeout, (int, float)) or timeout <= 0:
            raise AdminUnavailable("Tham số gọi Admin API không hợp lệ")
        deadline = time.monotonic() + timeout
        query = urlencode([("public_ids[]", pid) for pid in public_ids] + [("tags", "true"), ("context", "true")])
        url = f"{self._base_url}/v1_1/{self._cloud_name}/resources/image/upload?{query}"
        headers = {**self._auth_headers, "Accept": "application/json", "User-Agent": "hybrid-backend-admin-verify"}
        pool = self._injected_pool or _pool()
        try:
            response = pool.request(
                "GET",
                url,
                headers=headers,
                timeout=Timeout(connect=min(2.0, timeout), read=timeout),
                retries=False,  # KHÔNG tự retry
                redirect=False,
                preload_content=False,
            )
        except Exception as exc:  # urllib3.exceptions.* (timeout, mất kết nối, TLS...) hoặc OSError
            logger.warning("Admin API: lỗi kết nối (%s)", type(exc).__name__)
            raise AdminUnavailable("Không kết nối được Admin API") from None
        try:
            status = response.status
            if status == 420 or status == 429:
                raise AdminRateLimited(_rate_limit_retry_seconds(response.headers))
            if status in (401, 403):
                raise AdminConfigError(f"Admin API từ chối xác thực ({status})")
            if status == 404:
                raise AdminNotFound("Admin API 404")
            if status != 200:
                raise AdminUnavailable(f"Admin API trả trạng thái {status}")
            body = self._read_body(response, deadline)
        finally:
            response.release_conn()
        try:
            result = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise AdminUnavailable("Response Admin API không phải JSON hợp lệ") from None
        if not isinstance(result, dict):
            raise AdminUnavailable("Response Admin API sai định dạng")
        return result

    @staticmethod
    def _read_body(response: Any, deadline: float) -> bytes:
        """Đọc từng khúc, chặn tổng thời gian (kể cả server nhỏ giọt) và kích thước."""
        chunks: list[bytes] = []
        total = 0
        # `read1` (urllib3 >= 2) trả về NGAY khi có dữ liệu nên kiểm tra deadline được cả với server nhỏ giọt; urllib3 1.x không có => `read(amt)` (chặn tới đủ amt).
        read = getattr(response, "read1", None) or response.read
        try:
            while True:
                chunk = read(8192)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_RESPONSE_BYTES:
                    raise AdminUnavailable("Response Admin API quá lớn")
                chunks.append(chunk)
                if time.monotonic() > deadline:
                    raise AdminUnavailable("Admin API quá hạn")
        except AdminError:
            raise
        except Exception as exc:
            logger.warning("Admin API: lỗi đọc response (%s)", type(exc).__name__)
            raise AdminUnavailable("Lỗi đọc response Admin API") from None
        if time.monotonic() > deadline:
            raise AdminUnavailable("Admin API quá hạn")
        return b"".join(chunks)
