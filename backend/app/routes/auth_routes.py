from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.auth import verify_bearer_token

router = APIRouter(prefix="/auth", tags=["Authentication"])


class TokenVerifyResponse(BaseModel):
    valid: bool
    uid: str
    email: str | None = None
    name: str | None = None


@router.get("/me", response_model=TokenVerifyResponse)
def get_current_user_profile(claims: dict = Depends(verify_bearer_token)):
    return TokenVerifyResponse(
        valid=True,
        uid=claims["uid"],
        email=claims.get("email"),
        name=claims.get("name"),
    )


@router.post("/verify", response_model=TokenVerifyResponse)
def verify_current_token(claims: dict = Depends(verify_bearer_token)):
    return TokenVerifyResponse(
        valid=True,
        uid=claims["uid"],
        email=claims.get("email"),
        name=claims.get("name"),
    )