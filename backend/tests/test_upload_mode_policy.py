"""H4B-7B.2 / H4B-7B.2.1 – Khóa đường upload unsigned/legacy của Cloudinary: ma trận chế độ upload + POST /images/upload-url + confirm + cô lập legacy +
Gallery/Drive/OAuth + CORS.

Dùng `app.main.app` thật, xác thực giả của conftest (token-<uid>), kho RAM; KHÔNG gọi dịch vụ thật (Cloudinary, Firebase, Firestore, Google).
Test của đường LEGACY cũ nằm ở các file cũ và chạy qua fixture cô lập `legacy_upload_compat` (conftest) – fixture TIÊM provider Cloudinary GIẢ; không có cờ môi trường nào bật legacy.
"""
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from helpers import IMAGE_ID, IMAGE_ID_2, bearer, full_payload

from app.config import Settings, settings
from app.exceptions import LegacyUploadRetiredException, SignedUploadUnavailableException
from app.repositories.image_repository import image_repo
from app.services import upload_mode
from app.services.upload_mode import (
    MODE_DISABLED,
    MODE_INVALID,
    MODE_LEGACY,
    MODE_SIGNED,
    LegacyCompatProvider,
    authorize_allowed,
    confirm_mode,
    install_legacy_compat,
    legacy_compat_provider,
    legacy_upload_allowed,
    require_legacy_upload_allowed,
    uninstall_legacy_compat,
)

UPLOAD_URL = "/images/upload-url"
CONFIRM_URL = "/images/cloudinary/confirm"
AUTH_URL = "/images/cloudinary/authorize"
GOOD_UPLOAD = {"filename": "a.jpg", "contentType": "image/jpeg", "sizeBytes": 1000}
RETIRED = {"detail": "Legacy upload endpoint is retired"}
UNAVAILABLE = {"detail": "Signed upload unavailable"}
UNSIGNED_KEYS = ("uploadPreset", "upload_preset", "publicId", "folder", "uploadUrl", "cloudinaryConfig", "cloudName")
REAL_SENTINEL_CLOUD = "real-cloud-sentinel-0001"
REAL_SENTINEL_PRESET = "REAL-PRESET-SENTINEL-0002"
FAKE = LegacyCompatProvider("test-cloud", "test-unsigned-preset")
AUTH_BODY = {
    "imageId": IMAGE_ID,
    "originalSize": 1000,
    "variants": {
        "thumbnail": {"bytes": 10, "width": 100, "height": 100},
        "medium": {"bytes": 20, "width": 400, "height": 400},
        "webp": {"bytes": 30, "width": 1200, "height": 1200},
    },
}
ALLOWED_ORIGIN = "http://localhost:5173"
APP_DIR = Path(__file__).resolve().parents[1] / "app"


# ------------------------------------------------------------------ tiện ích
@pytest.fixture(autouse=True)
def isolated_legacy_state(monkeypatch):
    """Mặc định KHÔNG có emulator và KHÔNG có provider legacy được tiêm; mọi thay đổi tự hoàn tác sau test."""
    monkeypatch.delenv("FIRESTORE_EMULATOR_HOST", raising=False)
    monkeypatch.setattr(upload_mode, "_legacy_provider", None)


def configure(monkeypatch, mode="disabled", enabled=False, store="memory", key="", secret="", provider=False):
    """Đặt cấu hình upload TƯỜNG MINH cho test. `provider=True` mô phỏng harness cô lập đã tiêm provider GIẢ (cấu hình môi trường không làm được việc này)."""
    monkeypatch.setattr(settings, "CLOUDINARY_CONFIRM_MODE", mode)
    monkeypatch.setattr(settings, "CLOUDINARY_SIGNED_UPLOAD_ENABLED", enabled)
    monkeypatch.setattr(settings, "IMAGE_STORE", store)
    monkeypatch.setattr(settings, "CLOUDINARY_API_KEY", key)
    monkeypatch.setattr(settings, "CLOUDINARY_API_SECRET", secret)
    monkeypatch.setattr(upload_mode, "_legacy_provider", FAKE if provider else None)


LEGACY_OK = dict(mode="legacy", provider=True)
LOCKED = {  # mode hợp lệ NHƯNG không phải legacy: upload-url bị retire (410)
    "disabled": dict(mode="disabled"),
    "signed_authorize_off": dict(mode="signed"),
    "signed_authorize_on": dict(mode="signed", enabled=True, key="k", secret="s"),
    "signed_with_provider_injected": dict(mode="signed", provider=True),
    "disabled_with_provider_injected": dict(mode="disabled", provider=True),
}
INVALID = {  # cấu hình sai / mâu thuẫn: fail closed (503)
    "empty_mode": dict(mode=""),
    "unknown_mode": dict(mode="unsigned"),
    "typo_mode": dict(mode="sign"),
    "none_mode": dict(mode=None),
    "int_mode": dict(mode=1),
    "disabled_but_authorize_on": dict(mode="disabled", enabled=True),
    "legacy_by_config_only_memory": dict(mode="legacy"),
    "legacy_by_config_only_firestore": dict(mode="legacy", store="firestore"),
    "legacy_by_config_only_empty_keys": dict(mode="legacy", key="", secret=""),
    "legacy_provider_but_authorize_on": dict(mode="legacy", enabled=True, provider=True),
    "legacy_provider_but_real_firestore": dict(mode="legacy", store="firestore", provider=True),
    "legacy_provider_but_unknown_store": dict(mode="legacy", store="bogus", provider=True),
    "legacy_provider_but_cloudinary_key": dict(mode="legacy", key="k", provider=True),
    "legacy_provider_but_cloudinary_secret": dict(mode="legacy", secret="s", provider=True),
    "legacy_provider_but_authorize_not_a_bool": dict(mode="legacy", enabled="yes", provider=True),
}
REPO_METHODS = ["save", "get_by_id", "create_if_absent", "update_fields", "create_with_assets", "update_with_assets", "get_asset_claims", "get_upload_grant", "run_signed_confirm", "create_upload_grant"]


@pytest.fixture
def repo_calls(monkeypatch):
    """Bất kỳ lần đọc/ghi repository nào cũng bị ghi lại VÀ làm test lỗi: chứng minh cổng chặn chạy TRƯỚC mọi side effect."""
    calls: list[str] = []

    def spy(name):
        def fail(*args, **kwargs):
            calls.append(name)
            raise AssertionError(f"repository.{name} không được gọi")

        return fail

    for name in REPO_METHODS:
        monkeypatch.setattr(image_repo, name, spy(name))
    return calls


def assert_nothing_stored(store):
    assert store._docs == {} and store._assets == {} and store._grants == {} and store._grant_slots == {}


def assert_no_unsigned_config(res):
    for key in UNSIGNED_KEYS:
        assert key not in res.text, key
    for real in (settings.CLOUDINARY_UPLOAD_PRESET, "api.cloudinary.com", REAL_SENTINEL_CLOUD, REAL_SENTINEL_PRESET):
        assert real not in res.text


# ------------------------------------------------------------------ A. mặc định thật của Backend
def test_real_defaults_are_disabled_and_there_is_no_flag_to_enable_legacy(monkeypatch):
    for name in ("CLOUDINARY_CONFIRM_MODE", "CLOUDINARY_SIGNED_UPLOAD_ENABLED"):
        monkeypatch.delenv(name, raising=False)
    fresh = Settings(_env_file=None)
    assert fresh.CLOUDINARY_CONFIRM_MODE == "disabled" and fresh.CLOUDINARY_SIGNED_UPLOAD_ENABLED is False
    assert confirm_mode(fresh) == MODE_DISABLED and authorize_allowed(fresh) is False and legacy_upload_allowed(fresh) is False
    assert not [name for name in Settings.model_fields if "LEGACY" in name or "COMPAT" in name]  # không có cờ cấu hình nào cho legacy


def test_the_live_settings_object_used_by_the_tests_is_not_legacy_by_default():
    assert settings.CLOUDINARY_CONFIRM_MODE == "disabled" and legacy_compat_provider() is None


@pytest.mark.parametrize("env", [
    {"CLOUDINARY_CONFIRM_MODE": "legacy"},
    {"CLOUDINARY_CONFIRM_MODE": "legacy", "CLOUDINARY_LEGACY_UPLOAD_COMPAT": "true"},
    {"CLOUDINARY_CONFIRM_MODE": "legacy", "CLOUDINARY_LEGACY_UPLOAD_COMPAT": "true", "IMAGE_STORE": "memory", "CLOUDINARY_API_KEY": "", "CLOUDINARY_API_SECRET": ""},
    {"CLOUDINARY_CONFIRM_MODE": "legacy", "IMAGE_STORE": "firestore", "FIRESTORE_EMULATOR_HOST": "127.0.0.1:8681"},
    {"CLOUDINARY_CONFIRM_MODE": "legacy", "TEST_MODE": "1", "TESTING": "true", "PYTEST_RUNNING": "1", "ALLOW_LEGACY_UPLOAD": "true", "LEGACY": "1"},
])
def test_legacy_requested_only_through_the_environment_is_always_rejected(monkeypatch, env):
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("IMAGE_STORE", env.get("IMAGE_STORE", "memory"))
    assert confirm_mode(Settings(_env_file=None)) == MODE_INVALID  # không có biến môi trường nào (kể cả TEST_MODE) bật được legacy
    assert legacy_upload_allowed(Settings(_env_file=None)) is False


# ------------------------------------------------------------------ B. ma trận chế độ (hàm thuần, một nguồn diễn giải)
def ns(mode, enabled=False, store="memory", key="", secret=""):
    return SimpleNamespace(CLOUDINARY_CONFIRM_MODE=mode, CLOUDINARY_SIGNED_UPLOAD_ENABLED=enabled, IMAGE_STORE=store, CLOUDINARY_API_KEY=key, CLOUDINARY_API_SECRET=secret)


MATRIX = [
    # (cấu hình, provider được tiêm?, mode mong đợi, authorize_allowed)
    (ns("disabled"), False, MODE_DISABLED, False),
    (ns(" Disabled "), False, MODE_DISABLED, False),
    (ns("disabled", store="firestore", key="k", secret="s"), False, MODE_DISABLED, False),
    (ns("disabled"), True, MODE_DISABLED, False),  # tiêm provider KHÔNG làm disabled thành legacy
    (ns("disabled", enabled=True), False, MODE_INVALID, False),
    (ns("signed"), False, MODE_SIGNED, False),
    (ns("SIGNED", enabled=True), False, MODE_SIGNED, True),
    (ns("signed", enabled=True, store="firestore", key="k", secret="s"), False, MODE_SIGNED, True),
    (ns("signed"), True, MODE_SIGNED, False),  # tiêm provider KHÔNG làm signed rơi về legacy
    (ns("signed", enabled=True), True, MODE_SIGNED, True),
    # legacy: cấu hình một mình không bao giờ đủ
    (ns("legacy"), False, MODE_INVALID, False),
    (ns("legacy "), False, MODE_INVALID, False),
    (ns("legacy", store="firestore"), False, MODE_INVALID, False),
    # legacy: có provider giả được tiêm + môi trường cô lập
    (ns("legacy"), True, MODE_LEGACY, False),
    (ns("legacy "), True, MODE_LEGACY, False),
    (ns("LEGACY"), True, MODE_LEGACY, False),
    (ns("legacy", enabled=True), True, MODE_INVALID, False),
    (ns("legacy", store="firestore"), True, MODE_INVALID, False),
    (ns("legacy", store=None), True, MODE_INVALID, False),
    (ns("legacy", store="bogus"), True, MODE_INVALID, False),
    (ns("legacy", key="k"), True, MODE_INVALID, False),
    (ns("legacy", secret="s"), True, MODE_INVALID, False),
    (ns("legacy", enabled="true"), True, MODE_INVALID, False),
    # sai
    (ns(""), False, MODE_INVALID, False),
    (ns("unsigned"), True, MODE_INVALID, False),
    (ns("legacy-compat"), True, MODE_INVALID, False),
    (ns(None), True, MODE_INVALID, False),
    (ns(0), True, MODE_INVALID, False),
    (ns(["signed"]), False, MODE_INVALID, False),
]


@pytest.mark.parametrize("cfg,provider,expected,authorize", MATRIX)
def test_mode_matrix(monkeypatch, cfg, provider, expected, authorize):
    monkeypatch.setattr(upload_mode, "_legacy_provider", FAKE if provider else None)
    assert confirm_mode(cfg) == expected
    assert authorize_allowed(cfg) is authorize and legacy_upload_allowed(cfg) is (expected == MODE_LEGACY)


@pytest.mark.parametrize("host,expected", [
    ("127.0.0.1:8681", MODE_LEGACY), ("localhost:8080", MODE_LEGACY), ("[::1]:8681", MODE_LEGACY), (" 127.0.0.1:8681 ", MODE_LEGACY),
    ("", MODE_INVALID), ("firestore.googleapis.com", MODE_INVALID), ("firestore.googleapis.com:443", MODE_INVALID), ("10.0.0.5:8681", MODE_INVALID),
    ("127.0.0.1", MODE_INVALID), ("127.0.0.1:8681.evil.example:1", MODE_INVALID), ("evil.example/127.0.0.1:8681", MODE_INVALID), ("127.0.0.1:99999999", MODE_INVALID),
])
def test_legacy_with_firestore_needs_a_loopback_emulator_AND_the_injected_provider(monkeypatch, host, expected):
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", host)
    cfg = ns("legacy", store="firestore")
    monkeypatch.setattr(upload_mode, "_legacy_provider", FAKE)
    assert confirm_mode(cfg) == expected
    monkeypatch.setattr(upload_mode, "_legacy_provider", None)
    assert confirm_mode(cfg) == MODE_INVALID  # emulator loopback một mình KHÔNG đủ (không chứng minh Cloudinary là giả)
    assert confirm_mode(ns("legacy", store="memory")) == MODE_INVALID  # kho RAM một mình cũng không đủ


def test_missing_attributes_never_resolve_to_a_permissive_mode(monkeypatch):
    monkeypatch.setattr(upload_mode, "_legacy_provider", FAKE)
    assert confirm_mode(SimpleNamespace()) == MODE_INVALID
    assert confirm_mode(SimpleNamespace(CLOUDINARY_CONFIRM_MODE="legacy")) == MODE_INVALID  # thiếu cấu hình kho => không coi là cục bộ
    assert authorize_allowed(SimpleNamespace()) is False


def test_gate_function_raises_the_right_exception_for_each_state(monkeypatch):
    monkeypatch.setattr(upload_mode, "_legacy_provider", FAKE)
    require_legacy_upload_allowed(ns("legacy"))  # không ném
    for cfg in (ns("disabled"), ns("signed"), ns("signed", enabled=True)):
        with pytest.raises(LegacyUploadRetiredException) as retired:
            require_legacy_upload_allowed(cfg)
        assert retired.value.status_code == 410 and retired.value.detail == RETIRED["detail"]
    for cfg in (ns(""), ns("legacy", store="firestore"), ns("disabled", enabled=True)):
        with pytest.raises(SignedUploadUnavailableException) as bad:
            require_legacy_upload_allowed(cfg)
        assert bad.value.status_code == 503 and bad.value.detail == UNAVAILABLE["detail"]
    monkeypatch.setattr(upload_mode, "_legacy_provider", None)
    with pytest.raises(SignedUploadUnavailableException):
        require_legacy_upload_allowed(ns("legacy"))  # thiếu provider => 503


# ------------------------------------------------------------------ B2. cơ chế cô lập: provider giả, tiêm bằng mã, không từ HTTP/môi trường
@pytest.mark.parametrize("cloud,preset", [
    ("zftcbu1g", "test-unsigned-preset"), ("test-cloud", "serverless_image_preset"), ("", "test-x"), ("test-cloud", ""), ("realcloud", "realpreset"),
    ("test-", "test-x"), ("test-Cloud", "test-x"), ("test cloud", "test-x"), ("test-cloud/", "test-x"), ("production-cloud", "demo-x"), (None, "test-x"), ("test-cloud", 5),
])
def test_provider_must_have_fake_names_so_real_cloud_names_are_rejected(cloud, preset):
    with pytest.raises(ValueError):
        LegacyCompatProvider(cloud, preset)


@pytest.mark.parametrize("cloud,preset", [("test-cloud", "test-unsigned-preset"), ("demo-cloud", "demo-unsigned"), ("fake-cloud-1", "fake-preset-1"), ("sim-cloud", "sim-preset")])
def test_provider_accepts_clearly_fake_names(cloud, preset):
    assert LegacyCompatProvider(cloud, preset).cloud_name == cloud


def test_install_and_uninstall_only_manage_the_provider_and_enable_nothing_by_themselves():
    assert legacy_compat_provider() is None
    install_legacy_compat(FAKE)
    assert legacy_compat_provider() is FAKE
    assert confirm_mode(settings) == MODE_DISABLED  # đã tiêm nhưng mode vẫn disabled => không có gì được bật
    with pytest.raises(TypeError):
        install_legacy_compat({"cloud_name": "test-cloud", "upload_preset": "test-x"})
    with pytest.raises(TypeError):
        install_legacy_compat("test-cloud")
    uninstall_legacy_compat()
    assert legacy_compat_provider() is None


def test_no_application_module_can_install_the_legacy_provider():
    """Không route/service/config nào của ứng dụng gọi hàm tiêm: chỉ định nghĩa trong upload_mode.py. Vì vậy không có đường từ HTTP, môi trường hay file cấu hình."""
    users = []
    for path in APP_DIR.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        if "install_legacy_compat" in text or "_legacy_provider" in text or "legacy_compat_provider" in text:
            users.append(path.name)
    assert sorted(users) == ["image_service.py", "upload_mode.py"], users  # image_service chỉ ĐỌC provider (legacy_compat_provider), không tiêm


def test_the_only_reader_of_the_provider_never_installs_one():
    text = (APP_DIR / "services" / "image_service.py").read_text(encoding="utf-8")
    assert "install_legacy_compat" not in text and "_legacy_provider" not in text


def test_http_requests_cannot_switch_legacy_on(client, fresh_store, repo_calls):
    attempts = [
        dict(headers={**bearer("user_A"), "X-Legacy-Compat": "1", "X-Test-Mode": "1", "X-Enable-Legacy": "true"}),
        dict(headers=bearer("user_A"), params={"legacy": "1", "test": "1", "compat": "true", "mode": "legacy", "CLOUDINARY_CONFIRM_MODE": "legacy"}),
        dict(headers={**bearer("user_A"), "Cookie": "legacy=1; CLOUDINARY_CONFIRM_MODE=legacy"}),
    ]
    for kwargs in attempts:
        res = client.post(UPLOAD_URL, json={**GOOD_UPLOAD, "legacy": True, "mode": "legacy", "compat": True}, **kwargs)
        assert res.status_code == 410 and res.json() == RETIRED
        conf = client.post(CONFIRM_URL, json={**full_payload(IMAGE_ID), "legacy": True, "mode": "legacy"}, **kwargs)
        assert conf.status_code == 503 and conf.json() == UNAVAILABLE
    paths = {route.path for route in client.app.routes}
    assert not [p for p in paths if any(word in p.lower() for word in ("legacy", "compat", "test", "__ctl", "debug", "config", "admin"))]
    assert repo_calls == [] and settings.CLOUDINARY_CONFIRM_MODE == "disabled" and legacy_compat_provider() is None
    assert_nothing_stored(fresh_store)


# ------------------------------------------------------------------ C. POST /images/upload-url bị khóa
def test_upload_url_is_locked_by_default_without_any_configuration(client, fresh_store, repo_calls):
    res = client.post(UPLOAD_URL, headers=bearer("user_A"), json=GOOD_UPLOAD)
    assert res.status_code == 410 and res.json() == RETIRED
    assert_no_unsigned_config(res)
    assert repo_calls == [] and fresh_store._docs == {}


@pytest.mark.parametrize("name", list(LOCKED))
def test_upload_url_is_retired_in_disabled_and_signed_modes(client, fresh_store, repo_calls, monkeypatch, name):
    configure(monkeypatch, **LOCKED[name])
    res = client.post(UPLOAD_URL, headers=bearer("user_A"), json=GOOD_UPLOAD)
    assert res.status_code == 410 and res.json() == RETIRED
    assert_no_unsigned_config(res)
    assert res.headers.get("retry-after") is None
    assert repo_calls == []
    assert_nothing_stored(fresh_store)


@pytest.mark.parametrize("name", list(INVALID))
def test_upload_url_fails_closed_on_invalid_or_contradictory_config(client, fresh_store, repo_calls, monkeypatch, name):
    configure(monkeypatch, **INVALID[name])
    res = client.post(UPLOAD_URL, headers=bearer("user_A"), json=GOOD_UPLOAD)
    assert res.status_code == 503 and res.json() == UNAVAILABLE
    assert_no_unsigned_config(res)
    assert repo_calls == []
    assert_nothing_stored(fresh_store)


@pytest.mark.parametrize("body", [{}, {"filename": "a.exe", "contentType": "image/jpeg", "sizeBytes": 1}, {"filename": "a.jpg", "contentType": "image/jpeg", "sizeBytes": 10**9}, {"filename": 1}])
def test_gate_runs_before_body_validation_and_before_checkFile(client, fresh_store, repo_calls, body):
    res = client.post(UPLOAD_URL, headers=bearer("user_A"), json=body)
    assert res.status_code == 410 and res.json() == RETIRED  # không 422/400: không thăm dò được quy tắc của endpoint đã retire
    assert repo_calls == []


@pytest.mark.parametrize("name", ["disabled", "signed_authorize_off", "signed_authorize_on"])
def test_upload_url_still_requires_a_valid_bearer_first(client, fresh_store, repo_calls, monkeypatch, name):
    configure(monkeypatch, **LOCKED[name])
    missing = client.post(UPLOAD_URL, json=GOOD_UPLOAD)
    wrong = client.post(UPLOAD_URL, headers={"Authorization": "Bearer nope"}, json=GOOD_UPLOAD)
    scheme = client.post(UPLOAD_URL, headers={"Authorization": "Basic abc"}, json=GOOD_UPLOAD)
    spoof = client.post(UPLOAD_URL, headers={"X-User-Id": "user_A"}, json=GOOD_UPLOAD)
    for res in (missing, wrong, scheme, spoof):
        assert res.status_code == 401 and "410" not in res.text and "retired" not in res.text  # chưa đăng nhập thì không biết trạng thái endpoint
        assert_no_unsigned_config(res)
        assert "s3cr3t" not in res.text  # lỗi nội bộ của verifier giả không lọt ra
    assert repo_calls == []


def test_unauthenticated_request_gets_401_even_when_config_is_invalid(client, repo_calls, monkeypatch):
    configure(monkeypatch, **INVALID["unknown_mode"])
    assert client.post(UPLOAD_URL, json=GOOD_UPLOAD).status_code == 401
    assert repo_calls == []


def test_retired_response_does_not_reveal_which_mode_is_active(client, monkeypatch):
    texts = set()
    for name in LOCKED:
        configure(monkeypatch, **LOCKED[name])
        res = client.post(UPLOAD_URL, headers=bearer("user_A"), json=GOOD_UPLOAD)
        texts.add((res.status_code, res.text))
    assert len(texts) == 1


def test_service_level_call_is_also_gated_not_only_the_route(fresh_store, repo_calls):
    from app.services.image_service import image_service

    with pytest.raises(LegacyUploadRetiredException):
        image_service.requestUpload(uid="user_A", filename="a.jpg", content_type="image/jpeg", size_bytes=1000)
    assert repo_calls == []


# ------------------------------------------------------------------ D. LEGACY chỉ chạy trong harness cô lập, với cấu hình GIẢ
def test_isolated_legacy_works_but_only_ever_hands_out_the_injected_fake_config(client, fresh_store, monkeypatch):
    configure(monkeypatch, **LEGACY_OK)
    monkeypatch.setattr(settings, "CLOUDINARY_CLOUD_NAME", REAL_SENTINEL_CLOUD)  # "cloud thật" trong settings
    monkeypatch.setattr(settings, "CLOUDINARY_UPLOAD_PRESET", REAL_SENTINEL_PRESET)  # "preset unsigned thật" trong settings
    res = client.post(UPLOAD_URL, headers=bearer("user_A"), json=GOOD_UPLOAD)
    assert res.status_code == 200
    cfg = res.json()["cloudinaryConfig"]
    assert set(cfg) == {"cloudName", "uploadPreset", "folder", "publicId"}
    assert cfg["cloudName"] == "test-cloud" and cfg["uploadPreset"] == "test-unsigned-preset"
    assert REAL_SENTINEL_CLOUD not in res.text and REAL_SENTINEL_PRESET not in res.text  # KHÔNG bao giờ cấp cấu hình unsigned thật
    assert res.json()["uploadUrl"] == "https://api.cloudinary.com/v1_1/test-cloud/image/upload"
    stored = fresh_store._docs[res.json()["imageId"]]
    assert stored["status"] == "PENDING" and stored["ownerId"] == "user_A"
    monkeypatch.setattr(settings, "CLOUDINARY_CLOUD_NAME", "test-cloud")  # confirm legacy đối chiếu URL với cloud name trong settings (conftest dùng test-cloud)
    done = client.post(CONFIRM_URL, headers=bearer("user_A"), json=full_payload(IMAGE_ID))
    assert done.status_code == 200 and done.json()["status"] == "DONE" and fresh_store._grants == {}


def test_a_test_that_does_not_use_the_isolation_fixture_sees_legacy_disabled(request):
    assert legacy_compat_provider() is None and confirm_mode(settings) == MODE_DISABLED
    assert "legacy_upload_compat" not in request.fixturenames


@pytest.mark.usefixtures("legacy_upload_compat")
def test_the_conftest_isolation_fixture_enables_legacy_with_a_fake_provider(client, fresh_store):
    assert confirm_mode(settings) == MODE_LEGACY and legacy_compat_provider().cloud_name == "test-cloud"
    res = client.post(UPLOAD_URL, headers=bearer("user_A"), json=GOOD_UPLOAD)
    assert res.status_code == 200 and res.json()["cloudinaryConfig"]["cloudName"] == "test-cloud"


@pytest.mark.parametrize("name", [n for n in INVALID if n.startswith("legacy")])
def test_legacy_guards_each_block_both_upload_url_and_confirm(client, fresh_store, repo_calls, monkeypatch, name):
    configure(monkeypatch, **INVALID[name])
    up = client.post(UPLOAD_URL, headers=bearer("user_A"), json=GOOD_UPLOAD)
    assert up.status_code == 503 and up.json() == UNAVAILABLE
    res = client.post(CONFIRM_URL, headers=bearer("user_A"), json=full_payload(IMAGE_ID))
    assert res.status_code == 503 and res.json() == UNAVAILABLE
    assert repo_calls == []
    assert_nothing_stored(fresh_store)


@pytest.mark.parametrize("store,emulator", [("memory", None), ("firestore", "127.0.0.1:8681")])
def test_legacy_by_config_alone_is_rejected_on_the_normal_app_even_with_memory_or_emulator(client, fresh_store, repo_calls, monkeypatch, store, emulator):
    configure(monkeypatch, mode="legacy", store=store, key="", secret="")  # KHÔNG tiêm provider
    if emulator:
        monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", emulator)
    for res in (
        client.post(UPLOAD_URL, headers=bearer("user_A"), json=GOOD_UPLOAD),
        client.post(CONFIRM_URL, headers=bearer("user_A"), json=full_payload(IMAGE_ID)),
        client.post(AUTH_URL, headers=bearer("user_A"), json=AUTH_BODY),
    ):
        assert res.status_code == 503 and res.json() == UNAVAILABLE
        assert_no_unsigned_config(res)
    assert repo_calls == []
    assert_nothing_stored(fresh_store)


def test_empty_cloudinary_keys_do_not_open_unsigned_upload(client, fresh_store, repo_calls, monkeypatch):
    configure(monkeypatch, mode="disabled", key="", secret="")
    assert client.post(UPLOAD_URL, headers=bearer("user_A"), json=GOOD_UPLOAD).status_code == 410
    assert client.post(CONFIRM_URL, headers=bearer("user_A"), json=full_payload(IMAGE_ID)).status_code == 503
    assert repo_calls == []


def test_legacy_provider_with_real_firestore_style_config_is_blocked(client, fresh_store, repo_calls, monkeypatch):
    configure(monkeypatch, mode="legacy", store="firestore", provider=True)  # không có FIRESTORE_EMULATOR_HOST => Firestore thật
    assert client.post(CONFIRM_URL, headers=bearer("user_A"), json=full_payload(IMAGE_ID)).status_code == 503
    assert repo_calls == []


# ------------------------------------------------------------------ E. confirm / authorize khi disabled hoặc cấu hình sai
def test_confirm_and_authorize_are_closed_by_default_and_touch_nothing(client, fresh_store, repo_calls):
    for url, body in ((CONFIRM_URL, full_payload(IMAGE_ID)), (AUTH_URL, AUTH_BODY)):
        res = client.post(url, headers=bearer("user_A"), json=body)
        assert res.status_code == 503 and res.json() == UNAVAILABLE
    assert repo_calls == []
    assert_nothing_stored(fresh_store)


@pytest.mark.parametrize("name", list(INVALID))
def test_confirm_and_authorize_fail_closed_on_every_invalid_config(client, fresh_store, repo_calls, monkeypatch, name):
    configure(monkeypatch, **INVALID[name])
    for url, body in ((CONFIRM_URL, full_payload(IMAGE_ID)), (AUTH_URL, AUTH_BODY)):
        res = client.post(url, headers=bearer("user_A"), json=body)
        assert res.status_code == 503 and res.json() == UNAVAILABLE
    assert repo_calls == []
    assert_nothing_stored(fresh_store)


def test_disabled_confirm_registers_no_asset_from_a_client_supplied_url(client, fresh_store, repo_calls):
    body = full_payload(IMAGE_ID)
    body["thumbnail"] = "https://res.cloudinary.com/some-other-cloud/image/upload/v1/evil.webp"
    res = client.post(CONFIRM_URL, headers=bearer("user_A"), json=body)
    assert res.status_code == 503 and repo_calls == [] and fresh_store._assets == {} and fresh_store._docs == {}


def test_confirm_still_requires_auth_when_disabled(client, repo_calls):
    assert client.post(CONFIRM_URL, json=full_payload(IMAGE_ID)).status_code == 401
    assert client.post(CONFIRM_URL, headers={"Authorization": "Bearer nope"}, json=full_payload(IMAGE_ID)).status_code == 401
    assert repo_calls == []


def test_no_fallback_between_modes_in_one_process(client, fresh_store, monkeypatch):
    configure(monkeypatch, mode="disabled")
    assert client.post(CONFIRM_URL, headers=bearer("user_A"), json=full_payload(IMAGE_ID)).status_code == 503
    configure(monkeypatch, mode="signed", provider=True)  # signed: confirm CẦN grant, không có thì từ chối; không rơi về legacy kể cả khi provider đã được tiêm
    res = client.post(CONFIRM_URL, headers=bearer("user_A"), json=full_payload(IMAGE_ID))
    assert res.status_code in (403, 503) and res.status_code != 200 and fresh_store._docs == {}
    configure(monkeypatch, mode="legacy")  # mode legacy chỉ bằng cấu hình: fail closed
    assert client.post(CONFIRM_URL, headers=bearer("user_A"), json=full_payload(IMAGE_ID)).status_code == 503
    assert fresh_store._docs == {} and fresh_store._assets == {}


# ------------------------------------------------------------------ F. Gallery, Google Drive, OAuth KHÔNG bị ảnh hưởng bởi mode upload
DRIVE_FILE = "drive-file-1"


def seed_old_cloudinary_image(store, uid="user_A", image_id=IMAGE_ID):
    """Ảnh Cloudinary DONE tạo từ thời legacy: phải vẫn đọc được theo chủ sở hữu dù upload đang disabled."""
    store.save(
        {
            "imageId": image_id, "ownerId": uid, "provider": "cloudinary", "status": "DONE", "originalName": "cu.jpg",
            "createdAt": datetime(2026, 1, 3, tzinfo=timezone.utc), "updatedAt": datetime(2026, 1, 3, tzinfo=timezone.utc),
            "variants": {"thumbnail": "https://res.cloudinary.com/test-cloud/image/upload/v1/t.webp", "medium": None, "webp": None},
        }
    )


@pytest.fixture
def drive(monkeypatch):
    from app.services.google_drive import google_drive_service

    listing = {
        "driveFileId": DRIVE_FILE, "name": "a.png", "mimeType": "image/png", "sizeBytes": 1234, "stage": "processed", "status": "DONE", "webViewLink": "",
        "createdTime": "2026-01-01T00:00:00Z", "modifiedTime": "2026-01-02T00:00:00Z", "pipelineFolders": {"root": "r", "upload": "u", "processing": "p", "processed": "d"},
    }
    downloads: list[tuple[str, str]] = []

    def list_all(uid, root_folder_id=None):
        return [listing] if uid == "user_A" else []

    def download(uid, file_id):
        downloads.append((uid, file_id))
        return b"\x89PNG-bytes", "image/png"

    monkeypatch.setattr(google_drive_service, "list_all_pipeline_images", list_all)
    monkeypatch.setattr(google_drive_service, "download_file_bytes", download)
    monkeypatch.setattr(google_drive_service, "create_folder", lambda uid, folder_name, parent_id=None: {"folderId": "root-1", "webViewLink": "https://drive.example/root-1"})
    monkeypatch.setattr(google_drive_service, "ensure_pipeline_folders", lambda uid, root_id: {"upload": "f1", "processing": "f2", "processed": "f3"})
    return downloads


UPLOAD_OFF_STATES = {"default_disabled": None, "signed_authorize_off": LOCKED["signed_authorize_off"], "invalid_config": INVALID["unknown_mode"], "legacy_by_config_only": INVALID["legacy_by_config_only_memory"]}


@pytest.mark.parametrize("state", list(UPLOAD_OFF_STATES))
def test_gallery_and_drive_work_in_every_upload_mode_including_disabled(client, fresh_store, drive, monkeypatch, state):
    if UPLOAD_OFF_STATES[state] is not None:
        configure(monkeypatch, **UPLOAD_OFF_STATES[state])
    seed_old_cloudinary_image(fresh_store)
    seed_old_cloudinary_image(fresh_store, uid="user_B", image_id=IMAGE_ID_2)

    page = client.get("/images", headers=bearer("user_A"))
    assert page.status_code == 200
    ids = [item["imageId"] for item in page.json()["items"]]
    assert IMAGE_ID in ids and f"drive_{DRIVE_FILE}" in ids and IMAGE_ID_2 not in ids  # ảnh Cloudinary cũ + Drive; không thấy ảnh người khác

    other = client.get("/images", headers=bearer("user_B"))
    assert [item["imageId"] for item in other.json()["items"]] == [IMAGE_ID_2]  # cách ly chủ sở hữu giữ nguyên

    own = client.get(f"/images/{IMAGE_ID}", headers=bearer("user_A"))
    assert own.status_code == 200 and own.json()["status"] == "DONE" and own.json()["provider"] == "cloudinary"
    assert client.get(f"/images/{IMAGE_ID}", headers=bearer("user_B")).status_code == 403
    assert client.get(f"/images/{IMAGE_ID}").status_code == 401

    preview = client.get(f"/images/preview/{DRIVE_FILE}", headers=bearer("user_A"))
    assert preview.status_code == 200 and preview.content == b"\x89PNG-bytes" and preview.headers["content-type"] == "image/png"
    assert client.get(f"/images/preview/{DRIVE_FILE}", headers=bearer("user_B")).status_code == 403
    assert drive == [("user_A", DRIVE_FILE)]  # chỉ owner mới kích hoạt tải file Drive

    sync = client.post("/images/sync", headers=bearer("user_A"))
    assert sync.status_code == 200 and "sync" in sync.json() and sync.json()["sync"]["syncedFromCloudinary"] == 0
    folders = client.post("/images/drive/folders", headers=bearer("user_A"), json={"folderName": "App"})
    assert folders.status_code == 200 and folders.json()["folderId"] == "root-1" and folders.json()["pipelineFolders"]["upload"] == "f1"
    assert fresh_store._grants == {} and fresh_store._grant_slots == {}  # đọc/đồng bộ không tạo grant hay slot


def test_gallery_read_does_not_modify_old_cloudinary_records(client, fresh_store, drive):
    seed_old_cloudinary_image(fresh_store)
    before = dict(fresh_store._docs[IMAGE_ID])
    client.get("/images", headers=bearer("user_A"))
    client.post("/images/sync", headers=bearer("user_A"))
    assert fresh_store._docs[IMAGE_ID] == before and fresh_store._assets == {}  # không migrate/xóa/đổi dữ liệu legacy


def test_oauth_endpoints_are_unaffected_by_upload_mode(client, monkeypatch):
    from app.services.google_oauth import google_oauth_service

    monkeypatch.setattr(google_oauth_service, "get_authorization_url", lambda: ("https://accounts.google.com/o/oauth2/auth?scope=drive.file", "state-1"))
    monkeypatch.setattr(google_oauth_service, "exchange_code_for_tokens", lambda code, state: {"uid": "u1", "email": "a@example.test", "name": "A", "firebaseCustomToken": "ct"})
    login = client.get("/oauth/google/login")
    assert login.status_code == 200 and login.json()["state"] == "state-1"
    callback = client.get("/oauth/callback?code=c&state=s", follow_redirects=False)
    assert callback.status_code in (302, 307) and callback.headers["location"].startswith(f"{settings.FRONTEND_URL}/index.html?")


# ------------------------------------------------------------------ G. CORS (H4B-7B.1) vẫn nguyên vẹn
def _cors_entry():
    from fastapi.middleware.cors import CORSMiddleware

    from app.main import app

    return next(m for m in app.user_middleware if m.cls is CORSMiddleware).kwargs


def test_cors_policy_of_7b1_is_unchanged():
    kw = _cors_entry()
    assert kw["expose_headers"] == ["Retry-After"] and kw["allow_credentials"] is False
    assert kw["allow_origins"] == ["http://localhost:5173", "http://127.0.0.1:5173"] and "*" not in kw["allow_origins"]
    assert kw["allow_methods"] == ["GET", "POST"] and kw["allow_headers"] == ["Authorization", "Content-Type"]


@pytest.mark.parametrize("origin", ["http://localhost:5173", "http://127.0.0.1:5173"])
def test_locked_upload_responses_are_readable_by_allowed_origins_only(client, monkeypatch, origin):
    retired = client.post(UPLOAD_URL, headers={**bearer("user_A"), "Origin": origin}, json=GOOD_UPLOAD)
    unavailable = client.post(CONFIRM_URL, headers={**bearer("user_A"), "Origin": origin}, json=full_payload(IMAGE_ID))
    for res, code in ((retired, 410), (unavailable, 503)):
        assert res.status_code == code and res.headers["access-control-allow-origin"] == origin
        assert "retry-after" in [x.strip().lower() for x in res.headers["access-control-expose-headers"].split(",")]
    evil = client.post(UPLOAD_URL, headers={**bearer("user_A"), "Origin": "https://evil.example"}, json=GOOD_UPLOAD)
    assert evil.status_code == 410 and "access-control-allow-origin" not in evil.headers  # trình duyệt của origin lạ không đọc được kết quả


def test_retry_after_still_exposed_on_a_429_from_authorize(client, fresh_store, monkeypatch):
    # authorize thật (cấu hình ký GIẢ) vẫn trả Retry-After khi hết lượt và vẫn được expose; không có mode nào làm mất header này
    configure(monkeypatch, mode="signed", enabled=True, key="12345678", secret="secret-value-1234")
    monkeypatch.setattr(settings, "UPLOAD_GRANTS_PER_HOUR", 1)
    monkeypatch.setattr(settings, "UPLOAD_ENVIRONMENT", "test")
    headers = {**bearer("user_A"), "Origin": ALLOWED_ORIGIN}
    assert client.post(AUTH_URL, headers=headers, json=AUTH_BODY).status_code == 200
    second = {**AUTH_BODY, "imageId": str(uuid.UUID("c2a5d3f1-8b42-4d9f-a023-4e6b7f8c9da1"))}
    res = client.post(AUTH_URL, headers=headers, json=second)
    assert res.status_code == 429 and int(res.headers["retry-after"]) >= 1
    assert "retry-after" in [x.strip().lower() for x in res.headers["access-control-expose-headers"].split(",")]
