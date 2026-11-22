from fastapi import APIRouter
from pydantic import BaseModel, EmailStr
from app.services.firebase_auth_service import firebase_auth_service

router = APIRouter(prefix="/auth/firebase", tags=["Firebase Auth"])


class EmailPasswordPayload(BaseModel):
    email: EmailStr
    password: str


class RefreshTokenPayload(BaseModel):
    refreshToken: str


@router.post("/login")
def firebase_login(payload: EmailPasswordPayload):
    return firebase_auth_service.login_with_email_password(
        email=payload.email,
        password=payload.password,
    )


@router.post("/register")
def firebase_register(payload: EmailPasswordPayload):
    return firebase_auth_service.register_with_email_password(
        email=payload.email,
        password=payload.password,
    )


@router.post("/refresh")
def firebase_refresh(payload: RefreshTokenPayload):
    return firebase_auth_service.refresh_id_token(
        refresh_token=payload.refreshToken,
    )