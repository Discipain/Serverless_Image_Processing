"""Chính sách CORS (H4B-7B.1): allowlist TƯỜNG MINH, không wildcard, không credentials, vẫn expose Retry-After.

Mọi kiểm thử HTTP dùng `app.main.app` THẬT (cấu hình thật của middleware), không dựng app giả. Các cấu hình khác mặc định được kiểm bằng một TIẾN TRÌNH
PHỤ chạy `import app.main` với biến môi trường khác (Settings đọc môi trường lúc import, nên đổi cấu hình trong cùng tiến trình sẽ làm nhiễu singleton
của test khác). Không có mạng ngoài: TestClient gọi thẳng ứng dụng, tiến trình phụ chỉ import ứng dụng.

Lưu ý: CORS là chính sách của TRÌNH DUYỆT. Máy chủ vẫn xử lý request từ origin lạ (HTTP 200 không có `Access-Control-Allow-Origin`); trình duyệt mới là bên
chặn việc ĐỌC phản hồi, còn preflight bị từ chối (400) thì trình duyệt không gửi request thật. Vì vậy test kiểm đúng HEADER, không kỳ vọng 403.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from helpers import bearer
from pydantic import ValidationError

from app.config import CORS_MAX_ORIGINS, Settings, normalize_cors_origin, parse_cors_allowed_origins, settings

BACKEND_DIR = Path(__file__).resolve().parents[1]
LOCALHOST = "http://localhost:5173"
LOOPBACK_IP = "http://127.0.0.1:5173"
ALLOWED = (LOCALHOST, LOOPBACK_IP)

# Origin trông giống localhost nhưng KHÔNG nằm trong allowlist.
LOOKALIKES = [
    "http://localhost:5173.evil.example",
    "http://localhost.evil.example:5173",
    "http://evil-localhost:5173",
    "http://localhost:5173@evil.example",
    "https://localhost:5173",  # khác scheme
    "http://localhost:5174",  # khác cổng
    "http://localhost",  # thiếu cổng (cổng 80)
    "http://127.0.0.1:5173.evil.example",
    "http://127.0.0.2:5173",
    "http://[::1]:5173",  # loopback IPv6 không nằm trong mặc định
    "http://LOCALHOST:5173",  # trình duyệt luôn gửi chữ thường; so khớp chính xác nên không chấp nhận biến thể
    "http://localhost:5173/",  # header Origin không bao giờ có path
]
OUTSIDERS = ["https://evil.example", "http://evil.example", "https://app.example.com", "http://localhost:3000", "null", "*", ""]


@pytest.fixture
def app_client():
    from app.main import app

    return TestClient(app)


def _h(res):
    return {k.lower(): v for k, v in res.headers.items()}


def _cors_entry():
    from starlette.middleware.cors import CORSMiddleware

    from app.main import app

    return next(m for m in app.user_middleware if m.cls is CORSMiddleware)


def _run_app_subprocess(cors_value: str | None, probes: list[str], extra_env: dict[str, str] | None = None):
    """`import app.main` trong tiến trình MỚI với CORS_ALLOWED_ORIGINS cho trước; trả (returncode, {origin: Access-Control-Allow-Origin|None}, stderr)."""
    script = (
        "import json, os\n"
        "from fastapi.testclient import TestClient\n"
        "from app.main import app\n"
        "c = TestClient(app)\n"
        "out = {}\n"
        "for origin in json.loads(os.environ['PROBE_ORIGINS']):\n"
        "    r = c.get('/health', headers={'Origin': origin})\n"
        "    out[origin] = r.headers.get('access-control-allow-origin')\n"
        "print('RESULT=' + json.dumps(out))\n"
    )
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CORS_", "FRONTEND_URL"))}
    env.update({"IMAGE_STORE": "memory", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(BACKEND_DIR), "PROBE_ORIGINS": json.dumps(probes)})
    if cors_value is not None:
        env["CORS_ALLOWED_ORIGINS"] = cors_value
    env.update(extra_env or {})
    done = subprocess.run([sys.executable, "-c", script], cwd=str(BACKEND_DIR), env=env, capture_output=True, text=True, timeout=120)
    line = next((ln for ln in done.stdout.splitlines() if ln.startswith("RESULT=")), None)
    return done.returncode, (json.loads(line[len("RESULT="):]) if line else None), done.stderr


# ============================================================ 1-3. Origin hợp lệ nhận Access-Control-Allow-Origin
@pytest.mark.parametrize("origin", ALLOWED)
def test_default_allowed_origins_get_exact_allow_origin_and_vary(app_client, origin):
    res = app_client.get("/health", headers={"Origin": origin})
    h = _h(res)
    assert res.status_code == 200
    assert h["access-control-allow-origin"] == origin  # chính xác origin gọi, KHÔNG phải "*"
    assert "origin" in h["vary"].lower()  # bộ nhớ đệm không được trộn phản hồi giữa các origin
    assert "access-control-allow-credentials" not in h  # không cookie/credentials
    assert "retry-after" in [x.strip().lower() for x in h["access-control-expose-headers"].split(",")]


def test_default_origins_are_exactly_the_two_vite_dev_origins():
    assert settings.cors_origins == list(ALLOWED)
    assert Settings().cors_origins == list(ALLOWED)  # mặc định của lớp, không phụ thuộc môi trường test


def test_explicitly_configured_origin_is_allowed_and_defaults_are_replaced():
    # Origin cấu hình tường minh (https, cổng riêng) được chấp nhận; khi đã cấu hình thì mặc định localhost KHÔNG còn (không cộng dồn ngầm).
    code, result, err = _run_app_subprocess("https://app.example.test:8443", ["https://app.example.test:8443", LOCALHOST, LOOPBACK_IP])
    assert code == 0, err
    assert result == {"https://app.example.test:8443": "https://app.example.test:8443", LOCALHOST: None, LOOPBACK_IP: None}


def test_frontend_url_is_not_a_cors_origin_but_still_used_for_oauth_redirect(monkeypatch):
    # FRONTEND_URL (đích chuyển hướng OAuth) không còn tự động là origin CORS.
    code, result, err = _run_app_subprocess(None, ["http://localhost:3000", "http://localhost:4000"], {"FRONTEND_URL": "http://localhost:4000"})
    assert code == 0, err
    assert result == {"http://localhost:3000": None, "http://localhost:4000": None}


# ============================================================ 4-6. Origin ngoài allowlist không được cấp
@pytest.mark.parametrize("origin", OUTSIDERS + LOOKALIKES)
def test_origin_outside_allowlist_gets_no_allow_origin_header(app_client, origin):
    res = app_client.get("/health", headers={"Origin": origin})
    h = _h(res)
    assert res.status_code == 200  # CORS không phải xác thực: máy chủ vẫn trả lời, TRÌNH DUYỆT mới chặn việc đọc
    assert "access-control-allow-origin" not in h
    assert "access-control-allow-credentials" not in h


def test_null_origin_is_rejected_by_policy(app_client):
    res = app_client.get("/health", headers={"Origin": "null"})
    assert "access-control-allow-origin" not in _h(res)
    pre = app_client.options("/images", headers={"Origin": "null", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"})
    assert pre.status_code == 400 and "access-control-allow-origin" not in _h(pre)


def test_request_without_origin_header_has_no_cors_headers(app_client):
    # Công cụ không phải trình duyệt (curl, server-to-server) không gửi Origin: không có header CORS, ứng dụng vẫn chạy bình thường.
    res = app_client.get("/health")
    assert res.status_code == 200 and "access-control-allow-origin" not in _h(res)


# ============================================================ 7-8. Preflight
@pytest.mark.parametrize("origin", ALLOWED)
@pytest.mark.parametrize("path", ["/images/cloudinary/authorize", "/images/cloudinary/confirm"])
def test_preflight_post_with_authorization_and_content_type_succeeds_for_allowed_origin(app_client, origin, path):
    res = app_client.options(path, headers={"Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"})
    h = _h(res)
    assert res.status_code == 200
    assert h["access-control-allow-origin"] == origin
    assert "POST" in [x.strip() for x in h["access-control-allow-methods"].split(",")]
    allowed_headers = [x.strip().lower() for x in h["access-control-allow-headers"].split(",")]
    assert "authorization" in allowed_headers and "content-type" in allowed_headers  # allow_credentials=False KHÔNG cấm header Authorization
    assert "access-control-allow-credentials" not in h
    assert "origin" in h["vary"].lower()


@pytest.mark.parametrize("origin", ["https://evil.example", "null", "http://localhost:5174", "http://localhost:5173.evil.example"])
def test_preflight_from_disallowed_origin_is_rejected(app_client, origin):
    res = app_client.options("/images/cloudinary/authorize", headers={"Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"})
    h = _h(res)
    assert res.status_code == 400  # trình duyệt không gửi request thật sau preflight bị từ chối
    # Starlette vẫn gắn các header chung của preflight (Allow-Methods/Headers, Max-Age) cho cả lần từ chối; điều trình duyệt cần để cho phép là Allow-Origin.
    assert "access-control-allow-origin" not in h and "access-control-allow-credentials" not in h


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_preflight_for_methods_used_by_routes_succeeds(app_client, method):
    res = app_client.options("/images", headers={"Origin": LOCALHOST, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": "authorization"})
    assert res.status_code == 200 and _h(res)["access-control-allow-origin"] == LOCALHOST


@pytest.mark.parametrize("method", ["DELETE", "PUT", "PATCH"])
def test_preflight_for_methods_no_route_uses_is_rejected(app_client, method):
    res = app_client.options("/images/x", headers={"Origin": LOCALHOST, "Access-Control-Request-Method": method})
    assert res.status_code == 400


def test_preflight_with_unlisted_custom_header_is_rejected(app_client):
    # Header lạ (vd X-User-Id đã bị CONTRACT cấm) không được phép: không còn allow_headers=["*"].
    res = app_client.options("/images", headers={"Origin": LOCALHOST, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization,x-user-id"})
    assert res.status_code == 400


# ============================================================ 9. Bearer vẫn hoạt động; CORS không thay xác thực
@pytest.mark.parametrize("origin", ALLOWED)
def test_get_images_with_valid_bearer_works_from_allowed_origin(app_client, origin):
    res = app_client.get("/images", headers={**bearer("user_A"), "Origin": origin})
    h = _h(res)
    assert res.status_code == 200 and res.json() == {"items": [], "nextCursor": None, "hasMore": False}
    assert h["access-control-allow-origin"] == origin


def test_missing_or_bad_token_is_still_401_and_readable_by_allowed_origin(app_client):
    for headers in ({}, {"Authorization": "Bearer sai-token"}, {"Authorization": "Basic abc"}):
        res = app_client.get("/images", headers={**headers, "Origin": LOCALHOST})
        assert res.status_code == 401 and res.json() == {"detail": "Missing token"}
        assert _h(res)["access-control-allow-origin"] == LOCALHOST  # Frontend đọc được 401 để xử lý đăng nhập lại


def test_cors_never_substitutes_authentication_disallowed_origin_with_valid_bearer_is_served_but_unreadable(app_client):
    # Máy chủ xử lý theo token, KHÔNG theo origin: origin lạ + token hợp lệ vẫn nhận 200 nhưng không có Allow-Origin (trình duyệt không cho JS đọc).
    ok = app_client.get("/images", headers={**bearer("user_A"), "Origin": "https://evil.example"})
    assert ok.status_code == 200 and "access-control-allow-origin" not in _h(ok)
    # Origin hợp lệ KHÔNG thay token: thiếu token vẫn 401.
    assert app_client.get("/images", headers={"Origin": LOCALHOST}).status_code == 401


# ============================================================ 13-14. Không wildcard, cấu hình sai không fallback sang chính sách mở
def test_real_app_policy_has_no_wildcard_anywhere():
    kwargs = _cors_entry().kwargs
    for key in ("allow_origins", "allow_methods", "allow_headers", "expose_headers"):
        assert "*" not in kwargs[key], key
    assert kwargs["allow_credentials"] is False
    assert kwargs.get("allow_origin_regex") is None
    assert kwargs["allow_origins"] == list(ALLOWED)
    assert kwargs["expose_headers"] == ["Retry-After"]  # giữ nguyên, không tái xuất hiện BUG-3
    assert set(kwargs["allow_headers"]) == {"Authorization", "Content-Type"} and set(kwargs["allow_methods"]) == {"GET", "POST"}


@pytest.mark.parametrize(
    "value",
    [
        "*",
        "http://localhost:5173,*",
        "null",
        "",
        "   ",
        ",",
        "http://localhost:5173,",
        "http://localhost:5173,,http://127.0.0.1:5173",
        "https://*.example.com",
        "http://localhost:5173/app",
        "http://localhost:5173?x=1",
        "http://localhost:5173#frag",
        "http://user:pass@localhost:5173",
        "http://user@localhost:5173",
        "ftp://localhost:5173",
        "javascript:alert(1)",
        "localhost:5173",
        "http://",
        "http://localhost:0",
        "http://localhost:65536",
        "http://localhost:abc",
        "http://example.com",  # http chỉ cho loopback
        "http://10.0.0.5:5173",
        "https://exa mple.com",
        "https://example.com.",
        "https://-bad.example",
        "https://bad_host.example",
        "https://例え.jp",
        "http://localhost:5173\\@evil.example",
    ],
)
def test_invalid_cors_configuration_is_rejected_not_widened(value):
    with pytest.raises(ValueError):
        parse_cors_allowed_origins(value)
    with pytest.raises(ValidationError):
        Settings(CORS_ALLOWED_ORIGINS=value)


def test_too_many_origins_is_rejected():
    many = ",".join(f"https://app{i}.example.com" for i in range(CORS_MAX_ORIGINS + 1))
    with pytest.raises(ValueError):
        parse_cors_allowed_origins(many)
    assert len(parse_cors_allowed_origins(",".join(f"https://app{i}.example.com" for i in range(CORS_MAX_ORIGINS)))) == CORS_MAX_ORIGINS


def test_error_message_for_wildcard_names_the_setting():
    with pytest.raises(ValueError) as exc:
        parse_cors_allowed_origins("*")
    assert "CORS_ALLOWED_ORIGINS" in str(exc.value)


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("http://localhost:5173", "http://localhost:5173"),
        ("  HTTP://LocalHost:5173  ", "http://localhost:5173"),
        ("http://localhost:5173/", "http://localhost:5173"),
        ("http://localhost:80", "http://localhost"),
        ("https://Example.COM:443", "https://example.com"),
        ("https://example.com:8443/", "https://example.com:8443"),
        ("http://[::1]:5173", "http://[::1]:5173"),
        ("http://127.0.0.1:5173", "http://127.0.0.1:5173"),
        ("https://xn--r8jz45g.jp", "https://xn--r8jz45g.jp"),
    ],
)
def test_normalization_matches_what_browsers_send(raw, expected):
    assert normalize_cors_origin(raw) == expected


def test_parse_deduplicates_and_keeps_order():
    assert parse_cors_allowed_origins("http://127.0.0.1:5173, HTTP://localhost:5173/ ,http://127.0.0.1:5173,http://localhost:5173") == [LOOPBACK_IP, LOCALHOST]
    assert Settings(CORS_ALLOWED_ORIGINS=" HTTP://localhost:5173/ , http://localhost:5173 ").CORS_ALLOWED_ORIGINS == LOCALHOST


def test_settings_read_cors_from_environment_variable(monkeypatch):
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://app.example.test")
    assert Settings().cors_origins == ["https://app.example.test"]
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "*")
    with pytest.raises(ValidationError):
        Settings()


def test_value_corrupted_after_loading_never_becomes_an_open_policy(monkeypatch):
    # Nếu ai đó gán giá trị sai sau khi nạp, thuộc tính `cors_origins` ném lỗi (không trả "*", không trả danh sách rỗng "mở").
    monkeypatch.setattr(settings, "CORS_ALLOWED_ORIGINS", "*")
    with pytest.raises(ValueError):
        settings.cors_origins


@pytest.mark.parametrize("value", ["*", "http://localhost:5173,*", "null", "", "http://user:pass@localhost:5173", "http://example.com"])
def test_backend_refuses_to_start_with_invalid_cors_config(value):
    code, result, err = _run_app_subprocess(value, [LOCALHOST])
    assert code != 0 and result is None  # không có ứng dụng nào được tạo => không có chính sách mở nào
    assert "CORS_ALLOWED_ORIGINS" in err


def test_backend_starts_with_default_when_variable_is_absent():
    code, result, err = _run_app_subprocess(None, [LOCALHOST, LOOPBACK_IP, "https://evil.example"])
    assert code == 0, err
    assert result == {LOCALHOST: LOCALHOST, LOOPBACK_IP: LOOPBACK_IP, "https://evil.example": None}


# ============================================================ 11-12. Retry-After vẫn đọc được từ origin hợp lệ (429, 503) — qua route thật
@pytest.mark.parametrize("origin", ALLOWED)
def test_429_and_503_expose_retry_after_through_real_routes(app_client, monkeypatch, origin):
    from app.exceptions import TooManyRequestsException, UploadVerificationUnavailableException
    from app.services import image_service as image_service_module
    from app.services.upload_authorization import upload_authorization_service

    def too_many(uid, body):
        raise TooManyRequestsException("Too many upload authorizations", retry_after_seconds=1234)

    def unavailable(uid, body):
        raise UploadVerificationUnavailableException(retry_after_seconds=77)

    monkeypatch.setattr(upload_authorization_service, "authorize", too_many)
    monkeypatch.setattr(image_service_module.image_service, "confirmCloudinaryUpload", unavailable)
    r429 = app_client.post("/images/cloudinary/authorize", headers={**bearer("user_A"), "Origin": origin}, json={})
    r503 = app_client.post("/images/cloudinary/confirm", headers={**bearer("user_A"), "Origin": origin}, json={})
    for res, code, seconds in ((r429, 429, "1234"), (r503, 503, "77")):
        h = _h(res)
        assert res.status_code == code and h["retry-after"] == seconds
        assert h["access-control-allow-origin"] == origin
        assert "retry-after" in [x.strip().lower() for x in h["access-control-expose-headers"].split(",")]


# ============================================================ 15. Không phá endpoint Google Drive / OAuth
def test_oauth_endpoints_work_and_redirect_target_still_uses_frontend_url(app_client, monkeypatch):
    from app.services.google_oauth import google_oauth_service

    monkeypatch.setattr(google_oauth_service, "get_authorization_url", lambda: ("https://accounts.google.com/o/oauth2/auth?scope=drive.file", "state-1"))
    monkeypatch.setattr(google_oauth_service, "exchange_code_for_tokens", lambda code, state: {"uid": "u1", "email": "a@example.test", "name": "A", "firebaseCustomToken": "ct"})
    login = app_client.get("/oauth/google/login", headers={"Origin": LOCALHOST})
    assert login.status_code == 200 and login.json() == {"authUrl": "https://accounts.google.com/o/oauth2/auth?scope=drive.file", "state": "state-1"}
    assert _h(login)["access-control-allow-origin"] == LOCALHOST
    redirect = app_client.get("/oauth/google/redirect", follow_redirects=False)
    assert redirect.status_code in (302, 307) and redirect.headers["location"].startswith("https://accounts.google.com/")
    callback = app_client.get("/oauth/callback?code=c&state=s", follow_redirects=False)
    assert callback.status_code in (302, 307)
    assert callback.headers["location"].startswith(f"{settings.FRONTEND_URL}/index.html?")  # đích chuyển hướng vẫn là FRONTEND_URL (điều hướng, không phải CORS)


def test_google_drive_endpoints_still_work_with_bearer_from_allowed_origin(app_client, monkeypatch):
    from app.services import image_service as image_service_module
    from app.services.google_drive import google_drive_service

    monkeypatch.setattr(google_drive_service, "create_folder", lambda uid, folder_name, parent_id=None: {"folderId": "root-1", "webViewLink": "https://drive.example/root-1"})
    monkeypatch.setattr(google_drive_service, "ensure_pipeline_folders", lambda uid, root_id: {"upload": "f1", "processing": "f2", "processed": "f3"})
    monkeypatch.setattr(image_service_module.google_drive_service, "list_all_pipeline_images", lambda uid, root_folder_id=None: [])
    headers = {**bearer("user_A"), "Origin": LOCALHOST}

    folders = app_client.post("/images/drive/folders", headers=headers, json={"folderName": "App_Image_Pipeline"})
    assert folders.status_code == 200 and folders.json()["folderId"] == "root-1" and folders.json()["pipelineFolders"]["upload"] == "f1"
    assert _h(folders)["access-control-allow-origin"] == LOCALHOST

    sync = app_client.post("/images/sync", headers=headers)
    assert sync.status_code == 200 and sync.json()["sync"] == {"syncedFromGoogleDrive": 0, "syncedFromCloudinary": 0}

    preview = app_client.get("/images/preview/unknown-file", headers=headers)
    assert preview.status_code == 404  # không có bản ghi của người này => 404, không gọi Drive
    unauth = app_client.get("/images/preview/unknown-file", headers={"Origin": LOCALHOST})
    assert unauth.status_code == 401 and _h(unauth)["access-control-allow-origin"] == LOCALHOST

    pre = app_client.options("/images/drive/folders", headers={"Origin": LOCALHOST, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"})
    assert pre.status_code == 200
