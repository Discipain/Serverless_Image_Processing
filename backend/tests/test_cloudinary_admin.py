"""Test client Cloudinary Admin API (H4B-3) bằng MÁY CHỦ GIẢ trên localhost (127.0.0.1). Không Internet, không Cloudinary thật, credential GIẢ.

Chỉ kiểm tra đường HTTP thật của client (urllib3): dạng request, xác thực Basic, phân loại lỗi, không retry, giới hạn thời gian/kích thước.
Hình dạng response theo TÀI LIỆU Admin API; chưa được đối chiếu với Cloudinary thật (H4B-7).
"""
import base64
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import pytest

from app.services.cloudinary_admin import (
    MAX_RESPONSE_BYTES,
    AdminConfigError,
    AdminNotFound,
    AdminRateLimited,
    AdminUnavailable,
    HttpCloudinaryAdminClient,
)

API_KEY = "123456789012345"
SECRET = "test-secret-not-real-0123456789"
IDS = ["hybrid/test/x/thumb", "hybrid/test/x/medium", "hybrid/test/x/full"]


@pytest.fixture(autouse=True)
def loopback_only(monkeypatch):
    """Chỉ cho phép phân giải 127.0.0.1/localhost; mọi tên miền khác (kể cả api.cloudinary.com) làm test lỗi."""
    real = socket.getaddrinfo
    blocked: list[str] = []

    def guarded(host, *a, **k):
        if host not in ("127.0.0.1", "localhost"):
            blocked.append(str(host))
            raise AssertionError(f"test không được phân giải tên miền ngoài: {host}")
        return real(host, *a, **k)

    monkeypatch.setattr(socket, "getaddrinfo", guarded)
    yield
    assert blocked == []


class Fake:
    """Máy chủ Admin API giả: `plan` quyết định mỗi request trả gì; `requests` ghi lại mọi request."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.status = 200
        self.body: bytes = json.dumps({"resources": []}).encode()
        self.headers: dict[str, str] = {}
        self.delay = 0.0
        self.drip = False
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):  # im lặng
                pass

            def do_GET(self):
                outer.requests.append({"path": self.path, "headers": dict(self.headers)})
                if outer.delay:
                    time.sleep(outer.delay)
                try:
                    self.send_response(outer.status)
                    self.send_header("Content-Type", "application/json")
                    for k, v in outer.headers.items():
                        self.send_header(k, v)
                    self.send_header("Content-Length", str(len(outer.body)))
                    self.end_headers()
                    if outer.drip:
                        for i in range(0, len(outer.body), 4):
                            self.wfile.write(outer.body[i : i + 4])
                            self.wfile.flush()
                            time.sleep(0.05)
                    else:
                        self.wfile.write(outer.body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def client(self) -> HttpCloudinaryAdminClient:
        return HttpCloudinaryAdminClient("test-cloud", API_KEY, SECRET, base_url=self.url)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def fake():
    f = Fake()
    yield f
    f.close()


def test_success_returns_parsed_json_and_sends_expected_request(fake):
    fake.body = json.dumps({"resources": [{"public_id": IDS[0]}]}).encode()
    result = fake.client().get_resources(IDS, timeout=3)
    assert result == {"resources": [{"public_id": IDS[0]}]}
    assert len(fake.requests) == 1
    req = fake.requests[0]
    split = urlsplit(req["path"])
    assert split.path == "/v1_1/test-cloud/resources/image/upload"
    query = parse_qs(split.query)
    assert query["public_ids[]"] == IDS and query["tags"] == ["true"] and query["context"] == ["true"]
    assert "fields" not in query  # `fields` sẽ đè tags/context
    auth = {k.lower(): v for k, v in req["headers"].items()}["authorization"]
    assert base64.b64decode(auth.split()[1]).decode() == f"{API_KEY}:{SECRET}"


def test_no_api_secret_in_url_or_repr(fake):
    fake.client().get_resources(IDS, timeout=3)
    assert SECRET not in fake.requests[0]["path"] and API_KEY not in fake.requests[0]["path"]
    assert SECRET not in repr(fake.client()) and API_KEY not in repr(fake.client())


def test_404_maps_to_not_found(fake):
    fake.status, fake.body = 404, json.dumps({"error": {"message": "Resource not found - x"}}).encode()
    with pytest.raises(AdminNotFound):
        fake.client().get_resources(IDS, timeout=3)


def test_420_maps_to_rate_limited_with_retry_after_from_reset_header(fake):
    fake.status, fake.body = 420, json.dumps({"error": {"message": "Rate Limit Exceeded"}}).encode()
    reset = time.time() + 120
    fake.headers = {"X-FeatureRateLimit-Reset": time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(reset))}
    with pytest.raises(AdminRateLimited) as err:
        fake.client().get_resources(IDS, timeout=3)
    assert 100 <= err.value.retry_after_seconds <= 121
    assert len(fake.requests) == 1  # không retry


def test_420_without_or_with_bad_reset_header_defaults_to_60(fake):
    fake.status, fake.body = 420, b"{}"
    with pytest.raises(AdminRateLimited) as err:
        fake.client().get_resources(IDS, timeout=3)
    assert err.value.retry_after_seconds == 60
    fake.headers = {"X-FeatureRateLimit-Reset": "khong-phai-ngay"}
    with pytest.raises(AdminRateLimited) as err:
        fake.client().get_resources(IDS, timeout=3)
    assert err.value.retry_after_seconds == 60


@pytest.mark.parametrize("status", [401, 403])
def test_auth_errors_map_to_config_error_and_do_not_leak_body(fake, status):
    fake.status, fake.body = status, json.dumps({"error": {"message": f"Invalid api_key {API_KEY} secret {SECRET}"}}).encode()
    with pytest.raises(AdminConfigError) as err:
        fake.client().get_resources(IDS, timeout=3)
    assert SECRET not in str(err.value) and API_KEY not in str(err.value)


@pytest.mark.parametrize("status", [400, 500, 502, 503, 504, 302, 418])
def test_other_statuses_are_unavailable_and_not_retried(fake, status):
    fake.status, fake.body = status, b'{"error": {"message": "boom with secret"}}'
    with pytest.raises(AdminUnavailable) as err:
        fake.client().get_resources(IDS, timeout=3)
    assert "boom" not in str(err.value) and len(fake.requests) == 1


@pytest.mark.parametrize("body", [b"<html>nope</html>", b"", b"[1,2]", b'"x"', b"\xff\xfe", b'{"resources": '])
def test_bad_json_or_shape_is_unavailable(fake, body):
    fake.body = body
    with pytest.raises(AdminUnavailable):
        fake.client().get_resources(IDS, timeout=3)


def test_oversized_response_is_rejected(fake):
    fake.body = json.dumps({"resources": [], "pad": "x" * (MAX_RESPONSE_BYTES + 10)}).encode()
    with pytest.raises(AdminUnavailable):
        fake.client().get_resources(IDS, timeout=3)


def test_timeout_is_bounded_and_not_retried(fake):
    fake.delay = 3.0
    started = time.monotonic()
    with pytest.raises(AdminUnavailable):
        fake.client().get_resources(IDS, timeout=0.6)
    assert time.monotonic() - started < 2.0  # nếu SDK retry mặc định thì sẽ ~4 lần timeout
    time.sleep(0.2)
    assert len(fake.requests) == 1


def test_slow_drip_body_is_cut_by_total_deadline(fake):
    fake.body = json.dumps({"resources": [], "pad": "y" * 400}).encode()
    fake.drip = True  # ~100 khúc x 50 ms = 5 s
    started = time.monotonic()
    with pytest.raises(AdminUnavailable):
        fake.client().get_resources(IDS, timeout=0.8)
    assert time.monotonic() - started < 2.5


def test_connection_refused_is_unavailable_without_retry():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()  # cổng đóng
    client = HttpCloudinaryAdminClient("test-cloud", API_KEY, SECRET, base_url=f"http://127.0.0.1:{port}")
    started = time.monotonic()
    with pytest.raises(AdminUnavailable) as err:
        client.get_resources(IDS, timeout=2)
    assert time.monotonic() - started < 4.0 and SECRET not in str(err.value)  # Windows: RST tới cổng đóng có thể mất ~2 s; connect timeout bị chặn ở 2 s


@pytest.mark.parametrize("ids,timeout", [([], 3), (["a"] * 101, 3), (IDS, 0), (IDS, -1), (IDS, "5")])
def test_invalid_arguments_rejected_before_any_request(fake, ids, timeout):
    with pytest.raises(AdminUnavailable):
        fake.client().get_resources(ids, timeout=timeout)
    assert fake.requests == []


def test_default_base_url_is_https_cloudinary():
    from app.services.cloudinary_admin import DEFAULT_BASE_URL

    assert DEFAULT_BASE_URL == "https://api.cloudinary.com"
