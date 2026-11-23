"""Test xác thực Firebase Bearer (CONTRACT mục 0). Token giả; KHÔNG gọi Firebase thật, không cần credential."""
import pytest
from helpers import IMAGE_ID, bearer, minimal_payload

import app.auth as auth_module

# Lấy hàm THẬT trước khi fixture autouse thay thế nó (fixture chỉ patch trong thời gian chạy từng test).
REAL_VERIFY = auth_module._verify_id_token
URL = "/images/cloudinary/confirm"


def test_missing_authorization_header_returns_401_missing_token(client):
    res = client.post(URL, json=minimal_payload())
    assert res.status_code == 401
    assert res.json() == {"detail": "Missing token"}


@pytest.mark.parametrize(
    "header",
    ["", "Bearer", "Bearer ", "Bearer    ", "Basic dXNlcjpwYXNz", "token-user_A", "Bearer wrong-token", "Bearer token-"],
)
def test_malformed_or_invalid_authorization_returns_401(client, header):
    res = client.post(URL, headers={"Authorization": header}, json=minimal_payload())
    assert res.status_code == 401
    assert res.json() == {"detail": "Missing token"}


def test_scheme_is_case_insensitive(client):
    res = client.post(URL, headers={"Authorization": "bearer token-user_A"}, json=minimal_payload())
    assert res.status_code == 200
    assert res.json()["ownerId"] == "user_A"


def test_x_user_id_header_is_not_authentication(client):
    res = client.post(URL, headers={"X-User-Id": "user_A"}, json=minimal_payload())
    assert res.status_code == 401
    assert res.json() == {"detail": "Missing token"}


def test_x_user_id_cannot_override_the_token_uid(client, fresh_store):
    res = client.post(URL, headers={**bearer("user_A"), "X-User-Id": "user_B"}, json=minimal_payload())
    assert res.status_code == 200
    assert res.json()["ownerId"] == "user_A"
    assert fresh_store.get(IMAGE_ID)["ownerId"] == "user_A"


def test_x_user_id_does_not_rescue_an_invalid_token(client):
    res = client.post(URL, headers={"Authorization": "Bearer nope", "X-User-Id": "user_A"}, json=minimal_payload())
    assert res.status_code == 401


def test_authentication_is_checked_before_body_validation(client):
    res = client.post(URL, content=b"{not json", headers={"Content-Type": "application/json"})
    assert res.status_code == 401  # không lộ việc body sai cho người chưa đăng nhập


def test_token_error_details_are_not_leaked_to_the_client(client):
    res = client.post(URL, headers={"Authorization": "Bearer nope"}, json=minimal_payload())
    assert res.status_code == 401
    assert "s3cr3t-detail" not in res.text and "ValueError" not in res.text and "nope" not in res.text


@pytest.mark.parametrize("decoded", [{}, {"uid": ""}, {"uid": None}, {"uid": 123}, ["uid"], None, "uid"])
def test_verified_token_without_a_valid_uid_returns_401(client, monkeypatch, decoded):
    monkeypatch.setattr("app.auth._verify_id_token", lambda token: decoded)
    res = client.post(URL, headers={"Authorization": "Bearer anything"}, json=minimal_payload())
    assert res.status_code == 401
    assert res.json() == {"detail": "Missing token"}


def test_uid_falls_back_to_sub_of_a_verified_token(client, monkeypatch):
    monkeypatch.setattr("app.auth._verify_id_token", lambda token: {"sub": "uid-from-sub"})
    res = client.post(URL, headers={"Authorization": "Bearer anything"}, json=minimal_payload())
    assert res.status_code == 200
    assert res.json()["ownerId"] == "uid-from-sub"


def test_unexpected_verifier_exception_is_401_not_500(client, monkeypatch):
    def boom(token):
        raise RuntimeError("mất mạng khi tải chứng chỉ Google")

    monkeypatch.setattr("app.auth._verify_id_token", boom)
    res = client.post(URL, headers={"Authorization": "Bearer anything"}, json=minimal_payload())
    assert res.status_code == 401
    assert "mất mạng" not in res.text


@pytest.mark.parametrize(
    "path,method",
    [("/images", "get"), (f"/images/{IMAGE_ID}", "get"), ("/images/sync", "post"), ("/images/upload-url", "post")],
)
def test_other_image_endpoints_also_require_bearer(client, path, method):
    res = getattr(client, method)(path, headers={"X-User-Id": "user_A"})
    assert res.status_code == 401
    assert res.json() == {"detail": "Missing token"}


# ----- nối dây thật với firebase-admin (đã stub, không gọi mạng) -----
def test_real_verifier_delegates_to_firebase_admin(monkeypatch):
    import firebase_admin.auth as fb_auth

    calls = []
    monkeypatch.setattr(auth_module, "_ensure_firebase_app", lambda: calls.append("init"))
    monkeypatch.setattr(fb_auth, "verify_id_token", lambda token: calls.append(("verify", token)) or {"uid": "u1"})

    assert REAL_VERIFY("the-token") == {"uid": "u1"}
    assert calls == ["init", ("verify", "the-token")]


def test_firebase_app_init_never_loads_a_credential_file_by_default(monkeypatch):
    import firebase_admin

    from app.config import settings

    recorded = {}
    monkeypatch.setattr(firebase_admin, "_apps", {})
    monkeypatch.setattr(firebase_admin, "initialize_app", lambda *args, **kwargs: recorded.update(args=args, kwargs=kwargs))
    monkeypatch.setattr(settings, "FIREBASE_CREDENTIALS_FILE", "")

    auth_module._ensure_firebase_app()

    assert recorded["args"] == ()  # không có credential tường minh => Application Default Credentials
    assert recorded["kwargs"] == {"options": {"projectId": settings.FIREBASE_PROJECT_ID}}


def test_firebase_app_init_ignores_a_missing_credential_path(monkeypatch, tmp_path):
    import firebase_admin

    from app.config import settings

    recorded = {}
    monkeypatch.setattr(firebase_admin, "_apps", {})
    monkeypatch.setattr(firebase_admin, "initialize_app", lambda *args, **kwargs: recorded.update(args=args, kwargs=kwargs))
    monkeypatch.setattr(settings, "FIREBASE_CREDENTIALS_FILE", str(tmp_path / "khong-ton-tai.json"))

    auth_module._ensure_firebase_app()

    assert recorded["args"] == ()  # file không tồn tại => không cố nạp Certificate


def test_firebase_app_is_not_initialised_twice(monkeypatch):
    import firebase_admin

    calls = []
    monkeypatch.setattr(firebase_admin, "_apps", {"[DEFAULT]": object()})
    monkeypatch.setattr(firebase_admin, "initialize_app", lambda *a, **k: calls.append(1))

    auth_module._ensure_firebase_app()

    assert calls == []
