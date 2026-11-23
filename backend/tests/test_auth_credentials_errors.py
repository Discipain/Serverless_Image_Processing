"""BE-FIX.5C: phân biệt lỗi NGƯỜI DÙNG (401) với lỗi CẤU HÌNH/HẠ TẦNG của Backend (503) khi xác thực Firebase.

Bối cảnh đã kiểm chứng: firebase-admin dựng client xác thực bằng `google.auth.default()` (Application Default Credentials).
Thiếu ADC => DefaultCredentialsError ở mọi request. Đó là lỗi của Backend, KHÔNG phải token sai, nên phải là 503 (không phải 401).

Mọi thứ dùng lớp ngoại lệ THẬT của firebase-admin/google-auth nhưng dữ liệu GIẢ. KHÔNG gọi Firebase, KHÔNG dùng credential thật,
KHÔNG truy cập mạng/metadata server (169.254.169.254): fixture autouse bên dưới chặn socket ra ngoài loopback và
`google.auth.default`, rồi làm test thất bại nếu có bất kỳ lần thử nào.
"""
import logging
import socket

import google.auth
import pytest
from firebase_admin import auth as fb_auth
from google.auth.exceptions import DefaultCredentialsError, GoogleAuthError
from helpers import IMAGE_ID, bearer, minimal_payload

import app.auth as auth_module
from app.config import settings

# Hàm THẬT (fixture autouse của conftest thay nó trong từng test; test cần thì khôi phục lại bằng REAL_VERIFY).
REAL_VERIFY = auth_module._verify_id_token

MISSING = {"detail": "Missing token"}
UNAVAILABLE = {"detail": "Authentication service unavailable"}
# Các chuỗi mô phỏng chi tiết nhạy cảm có thể nằm trong thông điệp ngoại lệ: KHÔNG được xuất hiện ở response hay log.
LEAKY = ["LEAKMARKER-DETAIL", "/secret/path/key.json", "tok-abc123", "private" "_key"]
URL = "/images/cloudinary/confirm"


@pytest.fixture(autouse=True)
def no_external_network(monkeypatch):
    """Chặn mọi socket ra ngoài loopback và cấm dò ADC thật; test thất bại nếu code cố truy cập."""
    attempts = []
    real_connect = socket.socket.connect
    real_getaddrinfo = socket.getaddrinfo

    def is_local(host):
        return str(host) in ("localhost", "::1", "") or str(host).startswith("127.")

    def guarded_connect(self, addr):
        host = addr[0] if isinstance(addr, tuple) else addr
        if not is_local(host):
            attempts.append(f"connect:{host}")
            raise OSError("test: kết nối ra ngoài bị chặn")
        return real_connect(self, addr)

    def guarded_getaddrinfo(host, *args, **kwargs):
        if host is not None and not is_local(host):
            attempts.append(f"dns:{host}")
            raise OSError("test: DNS ngoài bị chặn")
        return real_getaddrinfo(host, *args, **kwargs)

    def forbidden_adc(*args, **kwargs):
        attempts.append("google.auth.default")
        raise AssertionError("test: không được dò Application Default Credentials thật")

    monkeypatch.setattr(socket.socket, "connect", guarded_connect)
    monkeypatch.setattr(socket, "getaddrinfo", guarded_getaddrinfo)
    monkeypatch.setattr(google.auth, "default", forbidden_adc)
    yield attempts
    assert attempts == [], f"test đã cố truy cập mạng/ADC thật: {attempts}"


def real_verifier(monkeypatch, *, init=lambda: None, verify=None):
    """Dùng `_verify_id_token` THẬT; chỉ thay hai điểm tiếp xúc với thế giới ngoài (khởi tạo và verify của firebase-admin)."""
    monkeypatch.setattr(auth_module, "_verify_id_token", REAL_VERIFY)
    monkeypatch.setattr(auth_module, "_ensure_firebase_app", init)
    if verify is not None:
        monkeypatch.setattr(fb_auth, "verify_id_token", verify)


def raising(exc):
    def _raise(*args, **kwargs):
        raise exc

    return _raise


def confirm(client, headers=None):
    return client.post(URL, headers=headers or {"Authorization": "Bearer anything"}, json=minimal_payload())


def assert_no_leak(res, caplog):
    for word in LEAKY:
        assert word not in res.text, f"response lộ '{word}'"
        assert word not in caplog.text, f"log lộ '{word}'"


# ------------------------------------------------------------------ 401: lỗi của NGƯỜI DÙNG
@pytest.mark.parametrize("headers", [{}, {"Authorization": ""}, {"Authorization": "Bearer"}, {"Authorization": "Bearer   "}, {"Authorization": "Basic abc"}, {"Authorization": "tok-abc123"}])
def test_missing_or_malformed_bearer_is_401(client, headers):
    res = client.post(URL, headers=headers, json=minimal_payload())
    assert res.status_code == 401 and res.json() == MISSING


@pytest.mark.parametrize(
    "exc",
    [
        fb_auth.InvalidIdTokenError("token sai LEAKMARKER-DETAIL tok-abc123"),
        fb_auth.ExpiredIdTokenError("token hết hạn LEAKMARKER-DETAIL", None),
        fb_auth.RevokedIdTokenError("token bị thu hồi LEAKMARKER-DETAIL"),
        ValueError("Illegal ID token LEAKMARKER-DETAIL"),
    ],
    ids=["token-sai", "token-het-han", "token-bi-thu-hoi", "token-khong-hop-le-value-error"],
)
def test_invalid_expired_or_revoked_token_is_401_never_503(client, monkeypatch, caplog, exc):
    caplog.set_level(logging.DEBUG, logger="app.auth")
    monkeypatch.setattr(auth_module, "_verify_id_token", raising(exc))
    res = confirm(client)
    assert res.status_code == 401 and res.json() == MISSING
    assert_no_leak(res, caplog)
    assert type(exc).__name__ in caplog.text  # log chỉ ghi TÊN loại lỗi để truy vết


def test_unclassified_error_stays_401_fail_closed_and_is_not_blindly_503(client, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger="app.auth")
    monkeypatch.setattr(auth_module, "_verify_id_token", raising(RuntimeError("lỗi bất ngờ LEAKMARKER-DETAIL")))
    res = confirm(client)
    assert res.status_code == 401 and res.json() == MISSING  # từ chối (đóng an toàn), KHÔNG gộp bừa vào 503
    assert_no_leak(res, caplog)
    assert "RuntimeError" in caplog.text


# ------------------------------------------------------------------ 503: Backend không xác thực được
SERVICE_ERRORS = {
    "thiếu-ADC": DefaultCredentialsError("Your default credentials were not found /secret/path/key.json tok-abc123 LEAKMARKER-DETAIL"),
    "không-tải-được-chứng-chỉ": fb_auth.CertificateFetchError("Failed to fetch certs LEAKMARKER-DETAIL", None),
    "lỗi-cấu-hình-nội-bộ": auth_module.AuthConfigurationError("init_failed:ValueError"),
}


@pytest.mark.parametrize("label", list(SERVICE_ERRORS))
def test_backend_cannot_authenticate_is_503_with_generic_message(client, monkeypatch, caplog, label):
    caplog.set_level(logging.DEBUG, logger="app.auth")
    exc = SERVICE_ERRORS[label]
    monkeypatch.setattr(auth_module, "_verify_id_token", raising(exc))
    res = confirm(client)
    assert res.status_code == 503
    assert res.json() == UNAVAILABLE
    assert_no_leak(res, caplog)
    assert (exc.reason if isinstance(exc, auth_module.AuthConfigurationError) else type(exc).__name__) in caplog.text


@pytest.mark.parametrize(
    "method,path,kwargs",
    [
        ("post", URL, {"json": minimal_payload()}),
        ("get", "/images", {}),
        ("get", f"/images/{IMAGE_ID}", {}),
        ("get", "/images/preview/abc", {}),
        ("post", "/images/sync", {}),
        ("post", "/images/upload-url", {"json": {"filename": "a.png", "contentType": "image/png", "sizeBytes": 10}}),
    ],
)
def test_503_applies_to_every_authenticated_endpoint(client, monkeypatch, method, path, kwargs):
    monkeypatch.setattr(auth_module, "_verify_id_token", raising(SERVICE_ERRORS["thiếu-ADC"]))
    res = getattr(client, method)(path, headers={"Authorization": "Bearer anything"}, **kwargs)
    assert res.status_code == 503 and res.json() == UNAVAILABLE


def test_authentication_service_error_wins_over_body_validation(client, monkeypatch):
    monkeypatch.setattr(auth_module, "_verify_id_token", raising(SERVICE_ERRORS["thiếu-ADC"]))
    res = client.post(URL, headers={"Authorization": "Bearer anything", "Content-Type": "application/json"}, content=b"{not json")
    assert res.status_code == 503 and res.json() == UNAVAILABLE  # xác thực chạy trước khi đọc body


def test_no_authorization_header_is_still_401_even_when_the_auth_service_is_broken(client, monkeypatch):
    monkeypatch.setattr(auth_module, "_verify_id_token", raising(SERVICE_ERRORS["thiếu-ADC"]))
    res = client.post(URL, json=minimal_payload())  # không có token: chưa cần gọi dịch vụ xác thực
    assert res.status_code == 401 and res.json() == MISSING


# ------------------------------------------------------------------ đường đi THẬT của _verify_id_token (firebase-admin được thay ở rìa)
def test_real_path_missing_adc_from_firebase_admin_is_503(client, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger="app.auth")
    real_verifier(monkeypatch, verify=raising(DefaultCredentialsError("không có ADC /secret/path/key.json LEAKMARKER-DETAIL")))
    res = confirm(client)
    assert res.status_code == 503 and res.json() == UNAVAILABLE
    assert_no_leak(res, caplog)


def test_real_path_certificate_fetch_failure_is_503(client, monkeypatch):
    real_verifier(monkeypatch, verify=raising(fb_auth.CertificateFetchError("fetch failed", None)))
    res = confirm(client)
    assert res.status_code == 503 and res.json() == UNAVAILABLE


@pytest.mark.parametrize("exc", [fb_auth.InvalidIdTokenError("x"), fb_auth.ExpiredIdTokenError("x", None), ValueError("x")], ids=["sai", "het-han", "ValueError"])
def test_real_path_token_errors_are_401(client, monkeypatch, exc):
    real_verifier(monkeypatch, verify=raising(exc))
    res = confirm(client)
    assert res.status_code == 401 and res.json() == MISSING


@pytest.mark.parametrize("exc", [ValueError("file credentials hỏng LEAKMARKER-DETAIL"), OSError("không đọc được /secret/path/key.json"), GoogleAuthError("lỗi google LEAKMARKER-DETAIL")], ids=["ValueError", "OSError", "GoogleAuthError"])
def test_real_path_firebase_admin_initialisation_failure_is_503(client, monkeypatch, caplog, exc):
    caplog.set_level(logging.DEBUG, logger="app.auth")
    called = []
    real_verifier(monkeypatch, init=raising(exc), verify=lambda token: called.append(token))
    res = confirm(client)
    assert res.status_code == 503 and res.json() == UNAVAILABLE
    assert called == []  # không đi tiếp tới verify khi khởi tạo đã hỏng
    assert_no_leak(res, caplog)
    assert f"init_failed:{type(exc).__name__}" in caplog.text


def test_real_path_unexpected_initialisation_error_is_not_blindly_503(client, monkeypatch):
    real_verifier(monkeypatch, init=raising(RuntimeError("lỗi lạ")), verify=lambda token: {"uid": "u"})
    res = confirm(client)
    assert res.status_code == 401 and res.json() == MISSING  # chỉ các lỗi cấu hình ĐÃ BIẾT mới thành 503


@pytest.mark.parametrize("project_id", ["", "   ", None])
def test_missing_project_id_is_a_backend_configuration_error_503(client, monkeypatch, project_id):
    calls = []
    real_verifier(monkeypatch, init=lambda: calls.append("init"), verify=lambda token: calls.append("verify") or {"uid": "u"})
    monkeypatch.setattr(settings, "FIREBASE_PROJECT_ID", project_id)
    res = confirm(client)
    assert res.status_code == 503 and res.json() == UNAVAILABLE
    assert calls == []  # không khởi tạo, không verify khi thiếu projectId


def test_malformed_credentials_file_through_the_real_initialiser_is_503(client, monkeypatch, tmp_path, caplog):
    """Dùng `_ensure_firebase_app` THẬT với một file credentials hỏng (JSON hợp lệ nhưng không phải service account)."""
    import firebase_admin

    bad = tmp_path / "not-a-service-account.json"
    bad.write_text('{"note": "khong phai service account", "marker": "LEAKMARKER-DETAIL"}', encoding="utf8")
    caplog.set_level(logging.DEBUG, logger="app.auth")
    monkeypatch.setattr(firebase_admin, "_apps", {})  # coi như chưa khởi tạo
    monkeypatch.setattr(settings, "FIREBASE_CREDENTIALS_FILE", str(bad))
    monkeypatch.setattr(auth_module, "_verify_id_token", REAL_VERIFY)
    monkeypatch.setattr(fb_auth, "verify_id_token", lambda token: {"uid": "u"})

    res = confirm(client)

    assert res.status_code == 503 and res.json() == UNAVAILABLE
    assert "LEAKMARKER-DETAIL" not in res.text and "LEAKMARKER-DETAIL" not in caplog.text
    assert str(bad) not in res.text and str(bad) not in caplog.text  # không lộ đường dẫn file credentials


# ------------------------------------------------------------------ ADC hợp lệ + token hợp lệ (mock) => đúng uid
def test_valid_adc_and_valid_token_resolve_the_right_uid(client, monkeypatch, fresh_store):
    seen = []
    real_verifier(monkeypatch, verify=lambda token: seen.append(token) or {"uid": "uid-from-token", "sub": "uid-from-token"})
    res = client.post(URL, headers={"Authorization": "Bearer valid-looking-token"}, json=minimal_payload())
    assert res.status_code == 200
    assert res.json()["ownerId"] == "uid-from-token"
    assert fresh_store.get(IMAGE_ID)["ownerId"] == "uid-from-token"
    assert seen == ["valid-looking-token"]  # token được chuyển nguyên vẹn cho firebase-admin


def test_valid_adc_and_valid_token_work_for_gallery_without_touching_cloudinary(client, monkeypatch):
    real_verifier(monkeypatch, verify=lambda token: {"uid": "uid-gallery"})
    res = client.get("/images", headers={"Authorization": "Bearer valid-looking-token"})
    assert res.status_code == 200
    assert res.json() == {"ownerId": "uid-gallery", "total": 0, "items": []}


def test_x_user_id_still_cannot_replace_a_token_when_the_auth_service_is_up(client, monkeypatch):
    real_verifier(monkeypatch, verify=lambda token: {"uid": "uid-real"})
    res = client.post(URL, headers={"Authorization": "Bearer t", "X-User-Id": "attacker"}, json=minimal_payload())
    assert res.status_code == 200 and res.json()["ownerId"] == "uid-real"


def test_default_and_fake_verification_paths_do_not_depend_on_adc(client):
    """Với verifier giả của conftest (token-<uid>), không có lời gọi ADC/mạng nào (fixture autouse sẽ làm test thất bại nếu có)."""
    res = client.post(URL, headers=bearer("user_A"), json=minimal_payload())
    assert res.status_code == 200 and res.json()["ownerId"] == "user_A"
