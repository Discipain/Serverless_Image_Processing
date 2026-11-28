from fastapi.testclient import TestClient
from app import main

client = TestClient(main.app)


def test_cors_preflight_allows_delete_method():
    response = client.options(
        "/images/img_cloud_001",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "DELETE",
            "Access-Control-Request-Headers": "Authorization, Content-Type",
        },
    )
    assert response.status_code in (200, 204)
    allow_methods = [
        m.strip().upper()
        for m in response.headers.get("access-control-allow-methods", "").split(",")
    ]
    assert "DELETE" in allow_methods