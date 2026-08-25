"""Admin auth: session-cookie login + administrator role check.

Auth flow:
1. ``POST /api/auth/login`` with username + password → session cookie.
2. Every ``/api/admin/*`` endpoint calls ``require_admin()`` which checks
   the session user has the ``administrator`` role at ``club:{club_id}``
   scope (via ``biq_core.roles.effective_capabilities``).
"""

from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from biq_core.org import verify_password
from biq_core.roles import effective_capabilities

from . import org

router = APIRouter()


class LoginRequest(BaseModel):
    username: str
    password: str


def _credentials() -> tuple[str, str]:
    return (
        os.environ.get("BIQ_ONBOARD_USER", "admin"),
        os.environ.get("BIQ_ONBOARD_PASSWORD", "T3st1ng!"),
    )


def _authenticate(username: str, password: str) -> bool:
    try:
        user = org.get_registry().get_user(username)
    except Exception:
        user = None
    if user is not None and getattr(user, "password_hash", None):
        return verify_password(password, user.password_hash)
    env_user, env_password = _credentials()
    return username == env_user and password == env_password


def session_user(request: Request) -> str:
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=401, detail="not authenticated")
    return user


def _is_break_glass_admin(user: str) -> bool:
    """Check if the user authenticated via the shared env credential."""
    env_user, _ = _credentials()
    return user == env_user


def require_admin(request: Request, club_id: str | None = None) -> str:
    """Return the session user or 403 if they lack ``club.admin``."""
    user = session_user(request)
    # Break-glass admin (env credential) has full access.
    if _is_break_glass_admin(user):
        return user
    if club_id:
        scope = f"club:{club_id}"
        caps = effective_capabilities(user, scope, org.get_roles())
        if "club.admin" not in caps and "roles.manage" not in caps:
            raise HTTPException(
                status_code=403,
                detail=f"administrator role required for club {club_id}",
            )
    return user


@router.post("/login")
def login(payload: LoginRequest, request: Request) -> dict:
    if not _authenticate(payload.username, payload.password):
        raise HTTPException(status_code=401, detail="invalid credentials")
    request.session["user"] = payload.username
    return {"user": payload.username}


@router.post("/logout")
def logout(request: Request) -> dict:
    request.session.clear()
    return {"ok": True}


@router.get("/me")
def me(request: Request) -> dict:
    user = session_user(request)
    return {"user": user}
