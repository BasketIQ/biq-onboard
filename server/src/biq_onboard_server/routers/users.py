"""User CRUD + password reset endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from .. import org
from ..auth import require_admin
from ..models import PasswordReset, UserCreate, UserUpdate

router = APIRouter()


@router.post("/clubs/{club_id}/users")
def create_user(club_id: str, payload: UserCreate, request: Request) -> dict:
    require_admin(request, club_id)
    from biq_core.org import User
    from biq_core.org.passwords import hash_password

    registry = org.get_registry()
    pw_hash = hash_password(payload.password) if payload.password else None
    user = User(
        id=payload.id,
        club_id=club_id,
        role=payload.role,
        display_name=payload.display_name,
        default_team_id=payload.default_team_id,
        password_hash=pw_hash,
    )
    registry.upsert_user(user)
    return {"ok": True, "user": {"id": user.id, "club_id": club_id}}


@router.get("/clubs/{club_id}/users")
def list_users(club_id: str, request: Request) -> dict:
    require_admin(request, club_id)
    registry = org.get_registry()
    members = registry.list_members(club_id)
    return {
        "users": [
            {
                "id": m.id,
                "club_id": m.club_id,
                "display_name": m.display_name,
                "role": m.role,
                "default_team_id": m.default_team_id,
            }
            for m in members
        ],
        "total": len(members),
    }


@router.put("/clubs/{club_id}/users/{user_id}")
def update_user(club_id: str, user_id: str, payload: UserUpdate, request: Request) -> dict:
    require_admin(request, club_id)
    from biq_core.org import User

    registry = org.get_registry()
    existing = registry.get_user(user_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="user not found")
    user = User(
        id=user_id,
        club_id=club_id,
        role=payload.role or existing.role,
        display_name=payload.display_name or existing.display_name,
        default_team_id=payload.default_team_id or existing.default_team_id,
        password_hash=existing.password_hash,
    )
    registry.upsert_user(user)
    return {"ok": True, "user": {"id": user_id}}


@router.delete("/clubs/{club_id}/users/{user_id}")
def delete_user(club_id: str, user_id: str, request: Request) -> dict:
    require_admin(request, club_id)
    from ..onboarding import _delete_user_safe

    registry = org.get_registry()
    existing = registry.get_user(user_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="user not found")
    _delete_user_safe(registry, user_id)
    return {"ok": True, "user_id": user_id}


@router.post("/users/{user_id}/reset-password")
def reset_password(user_id: str, payload: PasswordReset, request: Request) -> dict:
    from biq_core.org import User
    from biq_core.org.passwords import hash_password

    registry = org.get_registry()
    existing = registry.get_user(user_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="user not found")
    require_admin(request, existing.club_id)
    user = User(
        id=user_id,
        club_id=existing.club_id,
        role=existing.role,
        display_name=existing.display_name,
        default_team_id=existing.default_team_id,
        password_hash=hash_password(payload.password),
    )
    registry.upsert_user(user)
    return {"ok": True, "user_id": user_id}
