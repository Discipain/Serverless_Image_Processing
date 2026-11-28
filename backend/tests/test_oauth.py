from unittest.mock import patch
from fastapi.testclient import TestClient
from backend.app.main import app

client = TestClient(app)


@patch("app.services.google_oauth.google_oauth_service.get_authorization_url")
def test_google_oauth_login_url(mock_auth_url):
    mock_auth_url.return_value = (
        "https://accounts.google.com/o/oauth2/auth?scope=drive.file",
        "mock_state_123",
    )
    res = client.get("/oauth/google/login")
    assert res.status_code == 200
    body = res.json()
    assert "drive.file" in body["authUrl"]
    assert body["state"] == "mock_state_123"