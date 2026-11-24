"""H4B-6.1: connection của Admin client không được quay lại pool khi body CHƯA đọc hết (BUG-1).

Máy chủ localhost THẬT, HTTP/1.1 keep-alive, CÙNG MỘT PoolManager (nhỏ: maxsize=1) giữa các lời gọi.
Không mock `release_conn`/`close`. Mỗi lời gọi phục hồi phải thành công NGAY lần đầu (đúng 1 request tới máy chủ, không retry/503 giả).

Cách phát hiện: máy chủ ghi cổng nguồn (client port) của mỗi request.
- Sau response đọc HẾT body: connection được TÁI SỬ DỤNG (cùng cổng nguồn) => keep-alive vẫn hoạt động, không đóng thừa.
- Sau response chưa đọc hết/lỗi đọc: lời gọi kế tiếp đi qua connection MỚI (khác cổng nguồn) và thành công.
Rò rỉ: slot của pool phải được trả lại (qsize == maxsize) và số socket mở phía máy chủ không tăng dần.
"""
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import urllib3

from app.services.cloudinary_admin import (
    MAX_RESPONSE_BYTES,
    AdminConfigError,
    AdminNotFound,
    AdminRateLimited,
    AdminUnavailable,
    HttpCloudinaryAdminClient,
)

IDS = ["hybrid/test/x/thumb", "hybrid/test/x/medium", "hybrid/test/x/full"]
OK_BODY = json.dumps({"resources": []}).encode()
GAP = 0.25  # khoảng nghỉ giữa header và body: lúc lời gọi kế tiếp kiểm tra connection thì body chưa tới socket => lỗi cũ lộ ra ổn định


@pytest.fixture(autouse=True)
def loopback_only(monkeypatch):
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


class KeepAliveServer:
    """HTTP/1.1 keep-alive. `plan`: hàng đợi hành vi cho từng request (hết thì trả 200 bình thường)."""

    def __init__(self) -> None:
        self.plan: list[dict] = []
        self.requests: list[int] = []  # cổng nguồn của từng request, theo thứ tự
        self.open_connections = 0
        self._lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def setup(self):
                super().setup()
                with outer._lock:
                    outer.open_connections += 1

            def finish(self):
                try:
                    super().finish()
                finally:
                    with outer._lock:
                        outer.open_connections -= 1

            def do_GET(self):
                with outer._lock:
                    outer.requests.append(self.client_address[1])
                    step = outer.plan.pop(0) if outer.plan else {}
                status = step.get("status", 200)
                body = step.get("body", OK_BODY)
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    for k, v in step.get("headers", {}).items():
                        self.send_header(k, v)
                    self.send_header("Content-Length", str(step.get("declared", len(body))))
                    self.end_headers()
                    self.wfile.flush()
                    if step.get("gap"):
                        time.sleep(step["gap"])
                    if step.get("drip"):
                        for i in range(0, len(body), 64):
                            self.wfile.write(body[i : i + 64])
                            self.wfile.flush()
                            time.sleep(step["drip"])
                    else:
                        self.wfile.write(body)
                        self.wfile.flush()
                    if step.get("stall"):
                        time.sleep(step["stall"])
                    if step.get("cut"):  # kết thúc sớm: đóng connection khi body mới được gửi một phần
                        self.close_connection = True
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def srv():
    s = KeepAliveServer()
    yield s
    s.close()


@pytest.fixture
def pool():
    p = urllib3.PoolManager(num_pools=1, maxsize=1, retries=False)
    yield p
    p.clear()


def make_client(srv, pool):
    return HttpCloudinaryAdminClient("test-cloud", "123456789012345", "test-secret-not-real-0123456789", base_url=srv.url, pool=pool)


def slot_returned(srv, pool):
    return pool.connection_from_url(srv.url).pool.qsize() == 1


def recovers_in_one_call(srv, client, pool):
    """Admin hồi phục: ĐÚNG MỘT lời gọi tiếp theo phải thành công, trên connection mới (connection cũ còn dữ liệu dở không được dùng lại)."""
    before = len(srv.requests)
    failed_port = srv.requests[-1]
    assert client.get_resources(IDS, timeout=3) == {"resources": []}
    assert len(srv.requests) == before + 1  # không retry, không 503 giả
    assert srv.requests[-1] != failed_port  # không tái dùng connection còn dữ liệu chưa đọc
    assert slot_returned(srv, pool)


def raises(client, exc, timeout=3):
    with pytest.raises(exc):
        client.get_resources(IDS, timeout=timeout)


# ---------------------------------------------------------------- A-C: lỗi HTTP có body
def test_a_420_with_body_then_200(srv, pool):
    c = make_client(srv, pool)
    for _ in range(3):  # lặp để không phụ thuộc may rủi về thời điểm body tới socket
        srv.plan = [{"status": 420, "body": b'{"error": {"message": "Rate Limit Exceeded"}}', "gap": GAP, "headers": {"X-FeatureRateLimit-Reset": "Wed, 01 Jan 2031 00:00:00 GMT"}}]
        raises(c, AdminRateLimited)
        recovers_in_one_call(srv, c, pool)


def test_a2_429_with_body_then_200(srv, pool):
    c = make_client(srv, pool)
    srv.plan = [{"status": 429, "body": b"{}", "gap": GAP}]
    raises(c, AdminRateLimited)
    recovers_in_one_call(srv, c, pool)


def test_b_500_with_body_then_200(srv, pool):
    c = make_client(srv, pool)
    for _ in range(3):
        srv.plan = [{"status": 500, "body": b'{"error": {"message": "boom"}}', "gap": GAP}]
        raises(c, AdminUnavailable)
        recovers_in_one_call(srv, c, pool)


@pytest.mark.parametrize("status,exc", [(401, AdminConfigError), (403, AdminConfigError), (404, AdminNotFound)])
def test_c_auth_and_not_found_then_200(srv, pool, status, exc):
    c = make_client(srv, pool)
    for _ in range(2):
        srv.plan = [{"status": status, "body": b'{"error": {"message": "x"}}', "gap": GAP}]
        raises(c, exc)
        recovers_in_one_call(srv, c, pool)


@pytest.mark.parametrize("status", [400, 418, 502, 503, 504, 302, 204])
def test_c2_unexpected_status_then_200(srv, pool, status):
    c = make_client(srv, pool)
    srv.plan = [{"status": status, "body": b'{"error": {"message": "x"}}' if status != 204 else b"", "gap": GAP}]
    raises(c, AdminUnavailable)
    recovers_in_one_call(srv, c, pool)


def test_c3_immediate_error_body_also_recovers(srv, pool):
    """Body tới ngay (không có khoảng nghỉ): dù có tình cờ ổn hay không, lời gọi tiếp theo vẫn phải thành công 1 lần."""
    c = make_client(srv, pool)
    for status in (420, 500, 404, 401):
        srv.plan = [{"status": status, "body": b"{}"}]
        before = len(srv.requests)
        with pytest.raises(Exception):
            c.get_resources(IDS, timeout=3)
        assert c.get_resources(IDS, timeout=3) == {"resources": []}
        assert len(srv.requests) == before + 2 and slot_returned(srv, pool)


# ---------------------------------------------------------------- D: quá 256KB
def test_d_oversized_body_then_200(srv, pool):
    c = make_client(srv, pool)
    srv.plan = [{"body": b"x" * (MAX_RESPONSE_BYTES + 100_000)}]
    raises(c, AdminUnavailable)
    recovers_in_one_call(srv, c, pool)


# ---------------------------------------------------------------- E: body bị cắt / timeout đọc body
def test_e_truncated_body_then_200(srv, pool):
    c = make_client(srv, pool)
    srv.plan = [{"body": OK_BODY[:5], "declared": len(OK_BODY), "gap": 0.05, "cut": True}]
    raises(c, AdminUnavailable)
    recovers_in_one_call(srv, c, pool)


def test_e2_stalled_body_times_out_then_200(srv, pool):
    c = make_client(srv, pool)
    srv.plan = [{"body": OK_BODY[:5], "declared": len(OK_BODY), "gap": 0.05, "stall": 3.0, "cut": True}]
    started = time.monotonic()
    raises(c, AdminUnavailable, timeout=0.6)
    assert time.monotonic() - started < 2.0
    recovers_in_one_call(srv, c, pool)


def test_e3_status_200_headers_only_then_body_never_comes(srv, pool):
    c = make_client(srv, pool)
    srv.plan = [{"body": b"", "declared": len(OK_BODY), "stall": 3.0}]
    started = time.monotonic()
    raises(c, AdminUnavailable, timeout=0.6)
    assert time.monotonic() - started < 2.0
    recovers_in_one_call(srv, c, pool)


def test_e4_bad_json_body_fully_read_keeps_connection_reusable(srv, pool):
    """Body đã đọc HẾT (dù JSON hỏng) => connection sạch, được tái sử dụng."""
    c = make_client(srv, pool)
    srv.plan = [{"body": b"<html>nope</html>"}]
    raises(c, AdminUnavailable)
    first = srv.requests[-1]
    assert c.get_resources(IDS, timeout=3) == {"resources": []}
    assert srv.requests[-1] == first and slot_returned(srv, pool)


# ---------------------------------------------------------------- F: 200 liên tiếp
def test_f_consecutive_200_reuse_one_connection(srv, pool):
    c = make_client(srv, pool)
    for _ in range(10):
        assert c.get_resources(IDS, timeout=3) == {"resources": []}
    assert len(set(srv.requests)) == 1 and len(srv.requests) == 10  # keep-alive thật sự được dùng, không đóng thừa
    assert slot_returned(srv, pool)


# ---------------------------------------------------------------- G: nhiều vòng lỗi/phục hồi không cạn pool, không rò socket
def test_g_many_failure_recovery_cycles_do_not_exhaust_pool_or_leak_sockets(srv, pool):
    c = make_client(srv, pool)
    failures = [{"status": 420, "gap": 0.02}, {"status": 500, "gap": 0.02}, {"status": 404, "gap": 0.02}, {"status": 401, "gap": 0.02}, {"body": b"x" * (MAX_RESPONSE_BYTES + 10)}, {"body": OK_BODY[:3], "declared": len(OK_BODY), "cut": True}]
    for i in range(24):
        srv.plan = [dict(failures[i % len(failures)], body=failures[i % len(failures)].get("body", b"{}"))]
        before = len(srv.requests)
        with pytest.raises(Exception):
            c.get_resources(IDS, timeout=3)
        assert c.get_resources(IDS, timeout=3) == {"resources": []}
        assert len(srv.requests) == before + 2
        assert slot_returned(srv, pool)
    time.sleep(0.4)
    assert srv.open_connections <= 2  # connection hỏng đã được ĐÓNG (không giữ socket mở cho tới khi hết)


# ---------------------------------------------------------------- H: body lỗi rất lớn / nhỏ giọt không phá ngân sách timeout
def test_h_huge_error_body_does_not_delay_or_drain(srv, pool):
    c = make_client(srv, pool)
    srv.plan = [{"status": 500, "body": b"x" * (8 * 1024 * 1024)}]
    started = time.monotonic()
    raises(c, AdminUnavailable, timeout=1.0)
    assert time.monotonic() - started < 1.0  # không đọc/drain body lỗi
    assert c.get_resources(IDS, timeout=3) == {"resources": []} and slot_returned(srv, pool)


def test_h2_dripping_error_body_does_not_break_budget(srv, pool):
    c = make_client(srv, pool)
    srv.plan = [{"status": 503, "body": b"y" * 640, "drip": 0.2}]  # ~2 giây nếu bị đọc/drain
    started = time.monotonic()
    raises(c, AdminUnavailable, timeout=0.8)
    assert time.monotonic() - started < 0.8
    assert c.get_resources(IDS, timeout=3) == {"resources": []} and slot_returned(srv, pool)


def test_h3_dripping_ok_body_still_cut_by_deadline_then_recovers(srv, pool):
    c = make_client(srv, pool)
    srv.plan = [{"body": json.dumps({"resources": [], "pad": "z" * 600}).encode(), "drip": 0.1}]
    started = time.monotonic()
    raises(c, AdminUnavailable, timeout=0.6)
    assert time.monotonic() - started < 1.5
    assert c.get_resources(IDS, timeout=3) == {"resources": []} and slot_returned(srv, pool)


# ---------------------------------------------------------------- lỗi kết nối: không có response => không có gì để dọn
def test_connection_failure_returns_pool_slot(pool):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    c = HttpCloudinaryAdminClient("test-cloud", "123456789012345", "test-secret-not-real-0123456789", base_url=f"http://127.0.0.1:{port}", pool=pool)
    raises(c, AdminUnavailable, timeout=2)
    assert pool.connection_from_url(f"http://127.0.0.1:{port}").pool.qsize() == 1
