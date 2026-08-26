"""User CRUD + password reset endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from .. import org
from ..auth import require_admin
from ..models import PasswordReset, UserCreate, UserUpdate

router = APIRouter()


@router.get("/users")
def list_all_users(request: Request, email: str | None = None) -> dict:
    """List users across all clubs, optionally filtered by email.

    When ``email`` is provided, uses ``find_users_by_email`` to search
    across every club — a user may have memberships in multiple clubs.
    """
    require_admin(request)
    registry = org.get_registry()
    if email:
        users = registry.find_users_by_email(email)
    else:
        # List all users via Firestore stream (or memory registry)
        users = []
        if hasattr(registry, "_db"):
            docs = registry._db.collection("orgs_users").stream()  # type: ignore[attr-defined]
            from biq_core.org import User

            users = [User(id=d.id, **{k: v for k, v in d.to_dict().items() if k != "password_hash"}) for d in docs]
        elif hasattr(registry, "_users"):
            users = list(registry._users.values())  # type: ignore[attr-defined]
    return {
        "users": [
            {
                "id": u.id,
                "club_id": u.club_id,
                "email": u.email,
                "display_name": u.display_name,
                "role": u.role,
                "default_team_id": u.default_team_id,
                "status": u.status,
            }
            for u in users
        ],
        "total": len(users),
    }


@router.post("/clubs/{club_id}/users")
def create_user(club_id: str, payload: UserCreate, request: Request) -> dict:
    require_admin(request, club_id)
    from biq_core.org import User
    from biq_core.org.passwords import hash_password
    from biq_core.roles import RoleAssignment
    from biq_core.roles.models import ROLES

    if payload.role not in ROLES:
        raise HTTPException(status_code=400, detail=f"Unknown role: {payload.role}")

    registry = org.get_registry()
    roles = org.get_roles()
    scope = f"club:{club_id}"

    pw_hash = hash_password(payload.password) if payload.password else None
    user = User(
        id=payload.id,
        club_id=club_id,
        role=payload.role,
        display_name=payload.display_name,
        email=payload.email,
        default_team_id=payload.default_team_id,
        password_hash=pw_hash,
    )
    registry.upsert_user(user)

    # Create the RoleAssignment so the user gets methodology capabilities
    assignment = RoleAssignment(
        id=f"{payload.id}__{payload.role}__{scope}",
        user_id=payload.id,
        role=payload.role,
        scope=scope,
    )
    roles.put_assignment(assignment)

    return {"ok": True, "user": {"id": user.id, "club_id": club_id}, "role_assigned": payload.role}


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
                "email": m.email,
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
    from biq_core.roles import RoleAssignment
    from biq_core.roles.models import ROLES

    registry = org.get_registry()
    roles = org.get_roles()
    scope = f"club:{club_id}"

    existing = registry.get_user(user_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="user not found")

    new_role = payload.role or existing.role
    if new_role not in ROLES:
        raise HTTPException(status_code=400, detail=f"Unknown role: {new_role}")

    user = User(
        id=user_id,
        club_id=club_id,
        role=new_role,
        display_name=payload.display_name or existing.display_name,
        email=payload.email or existing.email,
        default_team_id=payload.default_team_id or existing.default_team_id,
        password_hash=existing.password_hash,
    )
    registry.upsert_user(user)

    # Sync the RoleAssignment when the role changes
    if payload.role and payload.role != existing.role:
        old_assignment_id = f"{user_id}__{existing.role}__{scope}"
        try:
            roles.remove_assignment(old_assignment_id)
        except Exception:
            pass
        new_assignment = RoleAssignment(
            id=f"{user_id}__{new_role}__{scope}",
            user_id=user_id,
            role=new_role,
            scope=scope,
        )
        roles.put_assignment(new_assignment)

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
