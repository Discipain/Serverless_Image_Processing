from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.routes import oauth_routes, image_routes
from app.routes import oauth_routes, image_routes, firebase_auth_routes

app = FastAPI(title=settings.APP_NAME)

# CORS (H4B-7B.1): chỉ các origin trong CORS_ALLOWED_ORIGINS (không wildcard). Frontend xác thực bằng header `Authorization: Bearer` và gọi với
# `credentials: 'omit'` (không cookie) nên allow_credentials=False; header Authorization vẫn được phép qua allow_headers. CORS chỉ là chính sách của
# trình duyệt: mọi route vẫn tự kiểm tra Firebase token và quyền sở hữu. `Retry-After` PHẢI được expose để JavaScript đọc được (BUG-3).
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["Retry-After"],
)

app.include_router(oauth_routes.router)
app.include_router(image_routes.router)
app.include_router(firebase_auth_routes.router)


@app.get("/health")
def health_check():
    return {"status": "ok", "branch": "feat/upload"}