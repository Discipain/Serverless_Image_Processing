from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.routes import oauth_routes, image_routes, firebase_auth_routes, auth_routes
from contextlib import asynccontextmanager
from fastapi import FastAPI

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Logic chạy khi start server (nếu cần)
    yield

app = FastAPI(lifespan=lifespan)

app.include_router(oauth_routes.router)
app.include_router(image_routes.router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(oauth_routes.router)
app.include_router(image_routes.router)
app.include_router(firebase_auth_routes.router)
app.include_router(auth_routes.router)


@app.get("/health")
def health_check():
    return {"status": "ok", "branch": "feat/upload"}