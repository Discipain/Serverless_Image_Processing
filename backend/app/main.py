from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.routes import oauth_routes, image_routes
from app.routes import oauth_routes, image_routes, firebase_auth_routes

app = FastAPI(title=settings.APP_NAME)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.FRONTEND_URL, "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Retry-After"],
)

app.include_router(oauth_routes.router)
app.include_router(image_routes.router)
app.include_router(firebase_auth_routes.router)


@app.get("/health")
def health_check():
    return {"status": "ok", "branch": "feat/upload"}