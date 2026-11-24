"""H4B-7B.3A – Retire proxy xác thực Firebase kiểu cũ: POST /auth/firebase/login | register | refresh luôn trả 410, không mạng, không side effect,
không đòi Bearer, không đọc cấu hình credential; xác thực hiện tại (Firebase SDK ở Frontend + Backend verify Bearer), Gallery, Drive, OAuth, CORS không đổi.

Dùng `app.main.app` thật; KHÔNG gọi Firebase/Google thật. Ranh giới mạng được GIÁM SÁT (spy) để chứng minh không có outbound request.
"""
import json
import socket
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pytest
from helpers import IMAGE_ID, IMAGE_ID_2, bearer

from app.config import Settings, settings
from app.exceptions import FirebaseAuthRetiredException
from app.services import firebase_auth_service as service_module
from app.services.firebase_auth_service import FirebaseAuthService

BACKEND_DIR = Path(__file__).resolve().parents[1]
ENDPOINTS = ["/auth/firebase/login", "/auth/firebase/register", "/auth/firebase/refresh"]
RETIRED = {"detail": "Firebase authentication endpoint is retired"}
ORIGIN = "http://localhost:5173"
EMAIL, PASSWORD, REFRESH = "victim@example.test", "S3cr3t-Passw0rd-sentinel", "refresh-token-sentinel-0123456789"
GOOD_BODIES = {
    "/auth/firebase/login": {"email": EMAIL, "password": PASSWORD},
    "/auth/firebase/register": {"email": EMAIL, "password": PASSWORD},
    "/auth/firebase/refresh": {"refreshToken": REFRESH},
}
SENSITIVE_KEYS = ("idToken", "refreshToken", "expiresIn", "localId", "uid", "email", "id_token", "refresh_token", "token", "password")


# ------------------------------------------------------------------ giám sát ranh giới mạng
@pytest.fixture
def outbound(monkeypatch):
    """Ghi lại MỌI nỗ lực mạng ra ngoài loopback: urlopen, http.client, getaddrinfo, socket.connect. Test kiểm tra danh sách rỗng."""
    calls: list[str] = []

    def fake_urlopen(*args, **kwargs):
        calls.append(f"urlopen:{getattr(args[0], 'full_url', args[0]) if args else '?'}")
        raise AssertionError("urlopen không được gọi")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(service_module, "urlopen", fake_urlopen)

    real_getaddrinfo, real_connect = socket.getaddrinfo, socket.socket.connect

    def spy_getaddrinfo(host, *a, **k):
        if str(host) not in ("127.0.0.1", "::1", "localhost", "testserver", "None"):
            calls.append(f"getaddrinfo:{host}")
            raise OSError("chặn mạng ngoài")
        return real_getaddrinfo(host, *a, **k)

    def spy_connect(self, address):
        host = address[0] if isinstance(address, tuple) else str(address)
        if host not in ("127.0.0.1", "::1", "localhost", "0.0.0.0"):
            calls.append(f"connect:{host}")
            raise OSError("chặn mạng ngoài")
        return real_connect(self, address)

    monkeypatch.setattr(socket, "getaddrinfo", spy_getaddrinfo)
    monkeypatch.setattr(socket.socket, "connect", spy_connect)
    return calls


class ExplodingSettings:
    """Mọi truy cập thuộc tính đều lỗi: chứng minh cổng chặn chạy TRƯỚC khi đọc cấu hình credential."""

    def __getattr__(self, name):
        raise AssertionError(f"không được đọc cấu hình: {name}")


# ------------------------------------------------------------------ 1-3, 4: ba endpoint trả 410
@pytest.mark.parametrize("path", ENDPOINTS)
def test_each_legacy_firebase_endpoint_returns_410_with_a_generic_message(client, outbound, path):
    res = client.post(path, json=GOOD_BODIES[path])
    assert res.status_code == 410 and res.json() == RETIRED
    assert outbound == []  # body hợp lệ KHÔNG kích hoạt proxy


def test_the_three_paths_still_exist_and_nothing_else_was_added(client):
    from app.main import app

    firebase_paths = sorted(route.path for route in app.routes if route.path.startswith("/auth"))
    assert firebase_paths == sorted(ENDPOINTS)
    assert all(route.methods == {"POST"} for route in app.routes if route.path.startswith("/auth"))
    for path in ENDPOINTS:
        assert client.get(path).status_code == 405  # không thêm phương thức nào khác


@pytest.mark.parametrize("path", ENDPOINTS)
def test_no_bearer_is_needed_and_a_wrong_bearer_changes_nothing(client, outbound, path):
    for headers in ({}, {"Authorization": "Bearer nope"}, {"Authorization": "Basic abc"}, bearer("user_A"), {"X-User-Id": "user_A"}):
        res = client.post(path, json=GOOD_BODIES[path], headers=headers)
        assert res.status_code == 410 and res.json() == RETIRED  # không 401: không cần đăng nhập để biết endpoint đã retire
    assert outbound == []


# ------------------------------------------------------------------ 5, 6, 7: body sai/thiếu, không 500, không mạng
BAD_BODIES = [
    dict(),  # không body
    dict(json={}),
    dict(json=[]),
    dict(json="chuỗi"),
    dict(json={"email": "không-phải-email", "password": 1}),
    dict(json={"email": EMAIL}),
    dict(json={"password": PASSWORD}),
    dict(json={"refreshToken": 123}),
    dict(json={"email": "a" * 5000 + "@example.test", "password": "p" * 100_000}),
    dict(content="{không phải json".encode("utf-8"), headers={"Content-Type": "application/json"}),
    dict(content=b"\x00\xff\xfe", headers={"Content-Type": "application/octet-stream"}),
    dict(data={"email": EMAIL, "password": PASSWORD}),  # form
    dict(content=b"", headers={"Content-Type": "application/json"}),
]


@pytest.mark.parametrize("path", ENDPOINTS)
def test_any_body_gets_410_never_422_never_500_and_never_touches_the_network(client, outbound, path):
    for kwargs in BAD_BODIES:
        res = client.post(path, **kwargs)
        assert res.status_code == 410 and res.json() == RETIRED, kwargs
    assert outbound == []


@pytest.mark.parametrize("path", ENDPOINTS)
def test_missing_web_api_key_no_longer_causes_a_500(client, outbound, monkeypatch, path):
    assert not hasattr(settings, "FIREBASE_WEB_API_KEY")  # chưa từng được khai báo: đây là nguyên nhân 500 trước đây
    res = client.post(path, json=GOOD_BODIES[path])
    assert res.status_code == 410 and res.status_code != 500 and "FIREBASE_WEB_API_KEY" not in res.text and "RuntimeError" not in res.text
    object.__setattr__(settings, "FIREBASE_WEB_API_KEY", "fake-not-a-real-key-0000")  # Settings không có field này; ép đặt vào instance: kể cả khi có ai đó đặt khóa, vẫn retire
    try:
        again = client.post(path, json=GOOD_BODIES[path])
    finally:
        settings.__dict__.pop("FIREBASE_WEB_API_KEY", None)
    assert again.status_code == 410 and again.json() == RETIRED and "fake-not-a-real-key" not in again.text
    assert not hasattr(settings, "FIREBASE_WEB_API_KEY") and outbound == []


def test_no_request_to_identity_toolkit_or_secure_token_even_from_the_service_layer(outbound):
    svc = FirebaseAuthService()
    for call in (lambda: svc.login_with_email_password(EMAIL, PASSWORD), lambda: svc.register_with_email_password(EMAIL, PASSWORD), lambda: svc.refresh_id_token(REFRESH)):
        with pytest.raises(FirebaseAuthRetiredException) as exc:
            call()
        assert exc.value.status_code == 410 and exc.value.detail == RETIRED["detail"]
    with pytest.raises(FirebaseAuthRetiredException):
        svc._post_json(FirebaseAuthService.SIGN_IN_URL, {"email": EMAIL, "password": PASSWORD})
    assert outbound == []


def test_service_gate_runs_before_reading_any_credential_configuration(monkeypatch, outbound):
    monkeypatch.setattr(service_module, "settings", ExplodingSettings())  # đọc cấu hình => AssertionError
    svc = FirebaseAuthService()
    for call in (lambda: svc.login_with_email_password(EMAIL, PASSWORD), lambda: svc.register_with_email_password(EMAIL, PASSWORD), lambda: svc.refresh_id_token(REFRESH)):
        with pytest.raises(FirebaseAuthRetiredException):
            call()
    assert outbound == []


def test_route_module_does_not_even_import_the_proxy_service_or_any_network_library():
    text = (BACKEND_DIR / "app" / "routes" / "firebase_auth_routes.py").read_text(encoding="utf-8")
    code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
    body = code.split('"""', 2)[-1]
    for needle in ("firebase_auth_service", "urlopen", "urllib", "requests", "httpx", "settings", "get_current_uid", "Depends", "BaseModel", "EmailStr"):
        assert needle not in body, needle


# ------------------------------------------------------------------ 8, 9: không tài khoản/token, không dữ liệu nhạy cảm
@pytest.mark.parametrize("path", ENDPOINTS)
def test_nothing_sensitive_is_returned_logged_or_created(client, outbound, caplog, path):
    with caplog.at_level("DEBUG"):
        res = client.post(path, json=GOOD_BODIES[path])
    assert res.json() == RETIRED
    blob = res.text + json.dumps(dict(res.headers)) + caplog.text
    for secret in (EMAIL, PASSWORD, REFRESH, "idToken", "refreshToken", "localId"):
        assert secret not in blob, secret
    assert not any(key in res.json() for key in SENSITIVE_KEYS)
    assert "set-cookie" not in res.headers and "authorization" not in res.headers
    assert outbound == []


def test_no_account_or_token_state_is_created_in_the_store(client, fresh_store, outbound):
    for path in ENDPOINTS:
        client.post(path, json=GOOD_BODIES[path])
    assert fresh_store._docs == {} and fresh_store._assets == {} and fresh_store._grants == {} and fresh_store._grant_slots == {}


# ------------------------------------------------------------------ 10, 11: không thể bật lại bằng header/query/body/môi trường
@pytest.mark.parametrize("path", ENDPOINTS)
def test_header_query_cookie_or_body_cannot_switch_the_proxy_back_on(client, outbound, path):
    extra = {"enable_firebase_proxy": True, "retired": False, "RETIRED": False, "legacy": True, "mode": "legacy", "FIREBASE_WEB_API_KEY": "fake-key-1234567890", "apiKey": "fake-key-1234567890"}
    attempts = [
        dict(headers={"X-Enable-Firebase-Proxy": "1", "X-Legacy": "true", "X-Test-Mode": "1", "X-Firebase-Api-Key": "fake-key-1234567890"}),
        dict(params={**{k: str(v) for k, v in extra.items()}, "key": "fake-key-1234567890"}),
        dict(headers={"Cookie": "RETIRED=0; legacy=1; FIREBASE_WEB_API_KEY=fake-key-1234567890"}),
    ]
    for kwargs in attempts:
        res = client.post(path, json={**GOOD_BODIES[path], **extra}, **kwargs)
        assert res.status_code == 410 and res.json() == RETIRED
    assert outbound == [] and FirebaseAuthService.RETIRED is True


def test_environment_variables_cannot_switch_the_proxy_back_on_in_process(monkeypatch):
    for name, value in {"FIREBASE_WEB_API_KEY": "fake-key-1234567890", "FIREBASE_AUTH_PROXY_ENABLED": "true", "ENABLE_FIREBASE_AUTH_PROXY": "1", "TEST_MODE": "1", "LEGACY_AUTH": "1", "RETIRED": "0"}.items():
        monkeypatch.setenv(name, value)
    fresh = Settings(_env_file=None)
    assert not any(hasattr(fresh, name) for name in ("FIREBASE_WEB_API_KEY", "FIREBASE_AUTH_PROXY_ENABLED", "ENABLE_FIREBASE_AUTH_PROXY"))
    assert FirebaseAuthService.RETIRED is True


def test_environment_variables_cannot_switch_the_proxy_back_on_in_a_fresh_process():
    """Tiến trình mới với các biến môi trường 'bật lại' được đặt: ứng dụng vẫn trả 410 và urlopen/mạng không được gọi."""
    script = (
        f"import json, socket, sys, urllib.request\nsys.path.insert(0, {str(BACKEND_DIR)!r})\n"
        "calls = []\n"
        "def boom(*a, **k):\n    calls.append('urlopen'); raise AssertionError('urlopen')\n"
        "urllib.request.urlopen = boom\n"
        "real = socket.socket.connect\n"
        "def guard(self, address):\n"
        "    host = address[0] if isinstance(address, tuple) else str(address)\n"
        "    if host not in ('127.0.0.1', '::1', 'localhost', '0.0.0.0'):\n        calls.append('connect:' + host); raise OSError('blocked')\n"
        "    return real(self, address)\n"
        "socket.socket.connect = guard\n"
        "from fastapi.testclient import TestClient\n"
        "from app.main import app\n"
        "c = TestClient(app)\n"
        "out = [c.post(p, json={'email': 'a@example.test', 'password': 'x', 'refreshToken': 'y'}).status_code for p in ('/auth/firebase/login', '/auth/firebase/register', '/auth/firebase/refresh')]\n"
        "print(json.dumps({'status': out, 'calls': calls}))\n"
    )
    import os

    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(("GOOGLE_", "FIREBASE", "CLOUDINARY"))}
    env.update({"IMAGE_STORE": "memory", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(BACKEND_DIR), "NO_GCE_CHECK": "true",
                "FIREBASE_WEB_API_KEY": "fake-key-1234567890", "FIREBASE_AUTH_PROXY_ENABLED": "true", "ENABLE_FIREBASE_AUTH_PROXY": "1", "TEST_MODE": "1", "LEGACY_AUTH": "1", "RETIRED": "0"})
    proc = subprocess.run([sys.executable, "-I", "-c", script], cwd=str(BACKEND_DIR), env=env, capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr[-800:]
    result = json.loads(proc.stdout.strip().splitlines()[-1])
    assert result == {"status": [410, 410, 410], "calls": []}


# ------------------------------------------------------------------ 12, 13: CORS không đổi
@pytest.mark.parametrize("origin", ["http://localhost:5173", "http://127.0.0.1:5173"])
def test_allowed_origins_can_read_the_410_and_preflight_works(client, origin):
    res = client.post(ENDPOINTS[0], json=GOOD_BODIES[ENDPOINTS[0]], headers={"Origin": origin})
    assert res.status_code == 410 and res.headers["access-control-allow-origin"] == origin
    assert "access-control-allow-credentials" not in res.headers
    assert "retry-after" in [x.strip().lower() for x in res.headers["access-control-expose-headers"].split(",")]
    pre = client.options(ENDPOINTS[0], headers={"Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
    assert pre.status_code == 200 and pre.headers["access-control-allow-origin"] == origin


@pytest.mark.parametrize("origin", ["https://evil.example", "http://localhost:5174", "http://localhost:5173.evil.example", "null", "*"])
def test_other_origins_get_no_allow_origin(client, origin):
    for path in ENDPOINTS:
        res = client.post(path, json=GOOD_BODIES[path], headers={"Origin": origin})
        assert res.status_code == 410 and "access-control-allow-origin" not in res.headers
    pre = client.options(ENDPOINTS[0], headers={"Origin": origin, "Access-Control-Request-Method": "POST"})
    assert pre.status_code == 400 and "access-control-allow-origin" not in pre.headers


# ------------------------------------------------------------------ 14-15: xác thực Bearer hiện tại không đổi
def test_a_valid_firebase_bearer_still_reaches_the_gallery(client, fresh_store, drive, outbound):
    res = client.get("/images", headers=bearer("user_A"))
    assert res.status_code == 200 and "items" in res.json()
    assert outbound == []


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer nope"}, {"Authorization": "Basic abc"}, {"Authorization": "Bearer "}, {"X-User-Id": "user_A"}])
def test_missing_or_wrong_bearer_is_still_rejected_everywhere_it_matters(client, fresh_store, headers):
    for method, path in (("get", "/images"), ("get", f"/images/{IMAGE_ID}"), ("post", "/images/sync"), ("post", "/images/cloudinary/authorize"), ("post", "/images/cloudinary/confirm"), ("post", "/images/upload-url")):
        res = getattr(client, method)(path, headers=headers)
        assert res.status_code == 401, (path, res.status_code)
    assert "s3cr3t" not in client.get("/images", headers={"Authorization": "Bearer nope"}).text  # lỗi nội bộ của verifier giả không lọt ra


def test_uid_still_comes_only_from_the_verified_token(client, fresh_store, drive):
    seed_image(fresh_store, "user_A", IMAGE_ID)
    seed_image(fresh_store, "user_B", IMAGE_ID_2)
    res = client.get("/images", headers={**bearer("user_B"), "X-User-Id": "user_A"}, params={"uid": "user_A", "ownerId": "user_A"})
    assert [i["imageId"] for i in res.json()["items"]] == [IMAGE_ID_2]


# ------------------------------------------------------------------ 17, 18: owner isolation, Drive, OAuth
DRIVE_FILE = "drive-file-9"


def seed_image(store, uid, image_id):
    store.save({"imageId": image_id, "ownerId": uid, "provider": "cloudinary", "status": "DONE", "originalName": "x.jpg",
                "createdAt": datetime(2026, 1, 3, tzinfo=timezone.utc), "updatedAt": datetime(2026, 1, 3, tzinfo=timezone.utc),
                "variants": {"thumbnail": "https://res.cloudinary.com/test-cloud/image/upload/v1/t.webp", "medium": None, "webp": None}})


@pytest.fixture
def drive(monkeypatch):
    from app.services.google_drive import google_drive_service

    listing = {"driveFileId": DRIVE_FILE, "name": "a.png", "mimeType": "image/png", "sizeBytes": 1234, "stage": "processed", "status": "DONE", "webViewLink": "",
               "createdTime": "2026-01-01T00:00:00Z", "modifiedTime": "2026-01-02T00:00:00Z", "pipelineFolders": {"root": "r", "upload": "u", "processing": "p", "processed": "d"}}
    downloads: list[tuple[str, str]] = []
    monkeypatch.setattr(google_drive_service, "list_all_pipeline_images", lambda uid, root_folder_id=None: [listing] if uid == "user_A" else [])
    monkeypatch.setattr(google_drive_service, "download_file_bytes", lambda uid, file_id: (downloads.append((uid, file_id)) or (b"\x89PNG-bytes", "image/png")))
    monkeypatch.setattr(google_drive_service, "create_folder", lambda uid, folder_name, parent_id=None: {"folderId": "root-1", "webViewLink": "https://drive.example/root-1"})
    monkeypatch.setattr(google_drive_service, "ensure_pipeline_folders", lambda uid, root_id: {"upload": "f1", "processing": "f2", "processed": "f3"})
    return downloads


def test_owner_isolation_is_unchanged(client, fresh_store, drive, outbound):
    seed_image(fresh_store, "user_A", IMAGE_ID)
    seed_image(fresh_store, "user_B", IMAGE_ID_2)
    client.post(ENDPOINTS[0], json=GOOD_BODIES[ENDPOINTS[0]])  # gọi proxy đã retire xen kẽ không ảnh hưởng gì
    assert client.get(f"/images/{IMAGE_ID}", headers=bearer("user_A")).status_code == 200
    assert client.get(f"/images/{IMAGE_ID}", headers=bearer("user_B")).status_code == 403
    assert client.get(f"/images/{IMAGE_ID_2}", headers=bearer("user_A")).status_code == 403
    a = [i["imageId"] for i in client.get("/images", headers=bearer("user_A")).json()["items"]]
    b = [i["imageId"] for i in client.get("/images", headers=bearer("user_B")).json()["items"]]
    assert IMAGE_ID in a and IMAGE_ID_2 not in a and b == [IMAGE_ID_2]
    assert outbound == []


def test_google_drive_sync_preview_and_folders_are_unaffected(client, fresh_store, drive, outbound):
    for path in ENDPOINTS:
        client.post(path, json=GOOD_BODIES[path])
    headers = bearer("user_A")
    assert client.post("/images/sync", headers=headers).status_code == 200
    page = client.get("/images", headers=headers)
    assert f"drive_{DRIVE_FILE}" in [i["imageId"] for i in page.json()["items"]]
    preview = client.get(f"/images/preview/{DRIVE_FILE}", headers=headers)
    assert preview.status_code == 200 and preview.content == b"\x89PNG-bytes"
    assert client.get(f"/images/preview/{DRIVE_FILE}", headers=bearer("user_B")).status_code == 403
    folders = client.post("/images/drive/folders", headers=headers, json={"folderName": "App"})
    assert folders.status_code == 200 and folders.json()["folderId"] == "root-1"
    assert drive == [("user_A", DRIVE_FILE)] and outbound == []


def test_oauth_redirect_and_callback_are_unaffected(client, monkeypatch, outbound):
    from app.services.google_oauth import google_oauth_service

    monkeypatch.setattr(google_oauth_service, "get_authorization_url", lambda: ("https://accounts.google.com/o/oauth2/auth?scope=drive.file", "state-1"))
    monkeypatch.setattr(google_oauth_service, "exchange_code_for_tokens", lambda code, state: {"uid": "u1", "email": "a@example.test", "name": "A", "firebaseCustomToken": "ct"})
    login = client.get("/oauth/google/login")
    assert login.status_code == 200 and login.json()["state"] == "state-1"
    redirect = client.get("/oauth/google/redirect", follow_redirects=False)
    assert redirect.status_code in (302, 307) and redirect.headers["location"].startswith("https://accounts.google.com/")
    callback = client.get("/oauth/callback?code=c&state=s", follow_redirects=False)
    assert callback.status_code in (302, 307) and callback.headers["location"].startswith(f"{settings.FRONTEND_URL}/index.html?")


def test_upload_mode_policy_is_unchanged_by_this_step(client, fresh_store):
    assert client.post("/images/upload-url", headers=bearer("user_A"), json={"filename": "a.jpg", "contentType": "image/jpeg", "sizeBytes": 10}).status_code == 410
    assert client.post("/images/cloudinary/confirm", headers=bearer("user_A"), json={}).status_code in (400, 503)
    assert fresh_store._docs == {}
