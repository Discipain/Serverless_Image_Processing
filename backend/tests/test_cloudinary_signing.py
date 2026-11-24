"""Test chữ ký upload Cloudinary (H4B-2). Không mạng, không Cloudinary thật; secret trong file là GIẢ.

Vector độc lập: tính bằng `hashlib` theo quy tắc của tài liệu Cloudinary (sắp xếp `k=v` nối `&` rồi nối api_secret), KHÔNG dùng SDK/code dự án.
"""
import hashlib

import pytest

from app.services import cloudinary_signing as cs
from app.services.cloudinary_signing import (
    SIGNED_KEYS,
    SigningConfig,
    SigningConfigError,
    build_params_to_sign,
    build_public_ids,
    build_signed_upload,
    sign_params,
)

IMAGE_ID = "b1f4c2e0-7a31-4c8e-9f12-3d5a6e7b8c90"
SECRET = "test-secret-not-real-0123456789"
TS = 1763900000

# Tính độc lập bằng hashlib (scratch make_vector.py) cho env=test, secret=SECRET, timestamp=TS.
VECTORS_SHA256 = {
    "thumbnail": "3065bc68cc0ce51e4336155d22951c779823b592bdd5660c19353e02302b6b5c",
    "medium": "bc6a7ec24122af60992b81a3c6259576f9ccf95d2a81f21c6900d3855e23755d",
    "webp": "4ff307e868b9c248e4e51964d571b0d0e48ac4de8a4592529921ec9bfd855307",
}
VECTORS_SHA1 = {
    "thumbnail": "c55b6ee2b4a4800ce266f7cecb6db79fb0b3b92c",
    "medium": "0a43273298b3d76368abce338da6954ba26e13cd",
    "webp": "457274966358aaffbb01716a6bd08e1684b57137",
}


def cfg(**kw) -> SigningConfig:
    base = dict(cloud_name="test-cloud", api_key="123456789012345", api_secret=SECRET, environment="test", algorithm="sha256")
    base.update(kw)
    return SigningConfig(**base)


def independent_signature(params: dict[str, str], secret: str, algo: str) -> str:
    to_sign = "&".join(f"{k}={params[k]}" for k in sorted(params)) + secret
    return hashlib.new(algo, to_sign.encode()).hexdigest()


# ------------------------------------------------------------------ chuẩn chữ ký (vector của TÀI LIỆU Cloudinary)
def test_sdk_helper_matches_cloudinary_documentation_vectors():
    # Hai ví dụ SHA-1 trong tài liệu "Generating authentication signatures" (secret "abcd").
    assert sign_params_raw({"timestamp": "1315060510"}, "abcd", "sha1") == "a21ad0f63beb4de2e5575204b79ab90bffb02c10"
    doc_string = "eager=w_400,h_300,c_pad|w_260,h_200,c_crop&public_id=sample_image&timestamp=1315060510abcd"
    assert hashlib.sha1(doc_string.encode()).hexdigest() == "bfd09f95f331f558cbd1320e67aa8d488770583e"
    assert hashlib.sha256(doc_string.encode()).hexdigest() == "cc927e1290f9e3ae4c1a741eda21a4630b4ce80f9ce0bc0296337d25cf40f91e"


def sign_params_raw(params, secret, algo):
    from cloudinary.utils import api_sign_request

    return api_sign_request(dict(params), secret, algo)


@pytest.mark.parametrize("variant", ["thumbnail", "medium", "webp"])
def test_signature_equals_independent_vectors_sha256_and_sha1(variant):
    p256 = build_params_to_sign(cfg(), image_id=IMAGE_ID, variant=variant, timestamp=TS)
    assert sign_params(p256, SECRET, "sha256") == VECTORS_SHA256[variant]
    assert sign_params(p256, SECRET, "sha1") == VECTORS_SHA1[variant]
    assert independent_signature(p256, SECRET, "sha256") == VECTORS_SHA256[variant]


def test_signed_upload_fields_contain_exactly_params_api_key_and_signature():
    fields = build_signed_upload(cfg(), image_id=IMAGE_ID, variant="medium", timestamp=TS)
    assert set(fields) == SIGNED_KEYS | {"api_key", "signature"}
    assert fields["signature"] == VECTORS_SHA256["medium"]
    assert fields["api_key"] == "123456789012345"
    assert SECRET not in "".join(fields.values())


# ------------------------------------------------------------------ tham số do BACKEND quyết định
def test_public_ids_have_fixed_shape_and_no_uid():
    ids = build_public_ids("test", IMAGE_ID)
    assert ids == {
        "thumbnail": f"hybrid/test/{IMAGE_ID}/thumb",
        "medium": f"hybrid/test/{IMAGE_ID}/medium",
        "webp": f"hybrid/test/{IMAGE_ID}/full",
    }


def test_params_force_no_overwrite_webp_only_timestamp_context_tags():
    p = build_params_to_sign(cfg(), image_id=IMAGE_ID, variant="thumbnail", timestamp=TS)
    assert p["overwrite"] == "false"
    assert p["allowed_formats"] == "webp"
    assert p["timestamp"] == str(TS)
    assert p["context"] == f"app=hybrid|imageId={IMAGE_ID}|variant=thumbnail"
    assert p["tags"] == "hybrid,test"
    assert set(p) == SIGNED_KEYS


def test_whitelist_rejects_extra_signed_parameter():
    p = build_params_to_sign(cfg(), image_id=IMAGE_ID, variant="webp", timestamp=TS)
    for extra in ("eager", "folder", "upload_preset", "notification_url", "callback", "transformation", "api_key", "file"):
        with pytest.raises(ValueError):
            sign_params({**p, extra: "x"}, SECRET, "sha256")


@pytest.mark.parametrize("bad", ["a&b", "a b", "a\nb", "a;b", "", "ảnh", "a?b"])
def test_unsafe_value_is_never_signed(bad):
    p = build_params_to_sign(cfg(), image_id=IMAGE_ID, variant="webp", timestamp=TS)
    with pytest.raises(ValueError) as err:
        sign_params({**p, "tags": bad}, SECRET, "sha256")
    assert bad not in str(err.value) or bad == ""


@pytest.mark.parametrize("image_id", ["../x", "B1F4C2E0-7A31-4C8E-9F12-3D5A6E7B8C90", "b1f4c2e0-7a31-1c8e-9f12-3d5a6e7b8c90", "x" * 36, "", None])
def test_public_id_requires_uuid_v4_lowercase(image_id):
    with pytest.raises(ValueError):
        build_public_ids("test", image_id)


@pytest.mark.parametrize("variant", ["original", "", "full", "THUMBNAIL", None])
def test_unknown_variant_rejected(variant):
    with pytest.raises(ValueError):
        build_params_to_sign(cfg(), image_id=IMAGE_ID, variant=variant, timestamp=TS)


@pytest.mark.parametrize("ts", [0, -1, 1.5, "1763900000", None, True])
def test_timestamp_must_be_positive_int(ts):
    with pytest.raises(ValueError):
        build_params_to_sign(cfg(), image_id=IMAGE_ID, variant="webp", timestamp=ts)


def test_unsupported_algorithm_rejected():
    p = build_params_to_sign(cfg(), image_id=IMAGE_ID, variant="webp", timestamp=TS)
    with pytest.raises(ValueError):
        sign_params(p, SECRET, "md5")


# ------------------------------------------------------------------ cấu hình + không lộ secret
class S:
    CLOUDINARY_CLOUD_NAME = "test-cloud"
    CLOUDINARY_API_KEY = "123456789012345"
    CLOUDINARY_API_SECRET = SECRET
    UPLOAD_ENVIRONMENT = "test"
    CLOUDINARY_SIGNATURE_ALGORITHM = "SHA256"


def test_config_from_settings_ok_and_upload_url():
    c = SigningConfig.from_settings(S)
    assert c.algorithm == "sha256" and c.upload_url == "https://api.cloudinary.com/v1_1/test-cloud/image/upload"


@pytest.mark.parametrize(
    "name,value,reported",
    [
        ("CLOUDINARY_CLOUD_NAME", "", "CLOUDINARY_CLOUD_NAME"),
        ("CLOUDINARY_CLOUD_NAME", "a/b", "CLOUDINARY_CLOUD_NAME"),
        ("CLOUDINARY_API_KEY", "", "CLOUDINARY_API_KEY"),
        ("CLOUDINARY_API_KEY", "a b c d", "CLOUDINARY_API_KEY"),
        ("CLOUDINARY_API_SECRET", "", "CLOUDINARY_API_SECRET"),
        ("CLOUDINARY_API_SECRET", "short", "CLOUDINARY_API_SECRET"),
        ("CLOUDINARY_API_SECRET", "has space in it secret", "CLOUDINARY_API_SECRET"),
        ("UPLOAD_ENVIRONMENT", "", "UPLOAD_ENVIRONMENT"),
        ("UPLOAD_ENVIRONMENT", "Prod/../x", "UPLOAD_ENVIRONMENT"),
        ("UPLOAD_ENVIRONMENT", "a" * 21, "UPLOAD_ENVIRONMENT"),
        ("CLOUDINARY_SIGNATURE_ALGORITHM", "md5", "CLOUDINARY_SIGNATURE_ALGORITHM"),
    ],
)
def test_bad_config_fails_closed_and_message_has_names_only(name, value, reported):
    class Bad(S):
        pass

    setattr(Bad, name, value)
    with pytest.raises(SigningConfigError) as err:
        SigningConfig.from_settings(Bad)
    assert reported in str(err.value)
    assert SECRET not in str(err.value)
    if value and name != "UPLOAD_ENVIRONMENT":
        assert value not in str(err.value)


def test_repr_never_contains_secret_or_api_key():
    c = cfg()
    assert SECRET not in repr(c) and SECRET not in str(c)
    assert "123456789012345" not in repr(c)


def test_signing_module_does_not_log_or_use_network():
    import inspect

    src = inspect.getsource(cs)
    assert "logging" not in src and "print(" not in src
    for token in ("requests", "httpx", "urllib", "socket", "cloudinary.uploader", "cloudinary.api"):
        assert token not in src
