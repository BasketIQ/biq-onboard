"""User CRUD + password reset endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from biq_core.roles import can_assign_role, effective_capabilities

from .. import org
from ..auth import (
    _is_break_glass_admin,
    _resolve_acting_identity,
    require_admin,
    require_admin_acting,
    require_roles_admin,
    require_roles_admin_acting,
    session_user,
)
from ..models import PasswordReset, UserCreate, UserUpdate

from biq_core.roles import canonical_club_role, validate_club_role
from biq_core.roles.membership import replace_member_role

router = APIRouter()


def _single_role(primary: str, additional: list[str] | None) -> str:
    primary = validate_club_role(primary)
    if any(validate_club_role(r) != primary for r in additional or []):
        raise HTTPException(422, "Cada miembro tiene un único rol en el club.")
    return primary


def _replace(club_id: str, user_id: str, role: str, actor: str, fields=None, *, remove=False) -> None:
    from google.api_core.exceptions import Aborted
    try:
        replace_member_role(org.get_registry(), org.get_roles(), org.get_audit_log(),
                            club_id=club_id, user_id=user_id, role=role, actor_id=actor, fields=fields, remove=remove)
    except Aborted as exc:
        raise HTTPException(503, "Conflicto temporal. Vuelve a intentarlo.") from exc
    except ValueError as exc:
        if isinstance(exc.__cause__, Aborted):
            raise HTTPException(503, "Conflicto temporal. Vuelve a intentarlo.") from exc
        raise HTTPException(409, str(exc)) from exc



def _active_roles_by_user(club_id: str) -> dict[str, list[str]]:
    """Map user_id -> active role names assigned at ``club:{club_id}`` scope."""
    roles = org.get_roles()
    by_user: dict[str, set[str]] = {}
    for a in roles.list_assignments_for_scope(f"club:{club_id}"):
        if a.is_active():
            by_user.setdefault(a.user_id, set()).add(a.role)
    return {uid: sorted(rs) for uid, rs in by_user.items()}


def _member_roles(member, assigned: dict[str, list[str]]) -> list[str]:
    """Primary ``User.role`` plus active secondary assignment roles."""
    return [canonical_club_role(member.role)]


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
    assigned_by_club = {
        cid: _active_roles_by_user(cid)
        for cid in {u.club_id for u in users if u.club_id}
    }
    return {
        "users": [
            {
                "id": u.id,
                "club_id": u.club_id,
                "email": u.email,
                "display_name": u.display_name,
                "role": u.role,
                "roles": _member_roles(u, assigned_by_club.get(u.club_id or "", {})),
                "default_team_id": u.default_team_id,
                "status": u.status,
            }
            for u in users
        ],
        "total": len(users),
    }


@router.post("/clubs/{club_id}/users")
def create_user(club_id: str, payload: UserCreate, request: Request) -> dict:
    require_admin_acting(request, club_id)
    from biq_core.org import User
    from biq_core.org.passwords import hash_password
    from biq_core.roles import RoleAssignment
    from biq_core.roles.models import ROLES

    if payload.role not in ROLES:
        raise HTTPException(status_code=400, detail=f"Unknown role: {payload.role}")

    _single_role(payload.role, payload.roles)
    registry = org.get_registry()
    if registry.get_user(payload.id) is not None:
        raise HTTPException(409, "user already exists")
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
    # F9: sports_directors need the member list to manage sporting roles.
    require_roles_admin_acting(request, club_id)
    registry = org.get_registry()
    members = registry.list_members(club_id)
    assigned = _active_roles_by_user(club_id)
    return {
        "users": [
            {
                "id": m.id,
                "club_id": m.club_id,
                "email": m.email,
                "display_name": m.display_name,
                "role": m.role,
                "roles": _member_roles(m, assigned),
                "status": m.status,
                "default_team_id": m.default_team_id,
            }
            for m in members
        ],
        "total": len(members),
    }


@router.put("/clubs/{club_id}/users/{user_id}")
def update_user(club_id: str, user_id: str, payload: UserUpdate, request: Request) -> dict:
    actor = require_admin_acting(request, club_id)

    registry = org.get_registry()

    existing = registry.get_user(user_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="user not found")

    if existing.club_id != club_id:
        raise HTTPException(403, "user does not belong to this club")
    new_role = _single_role(payload.role or existing.role, payload.roles)
    fields = payload.model_dump(exclude_unset=True, exclude={"role", "roles"})
    _replace(club_id, user_id, new_role, actor, fields)

    return {"ok": True, "user": {"id": user_id}}


@router.delete("/clubs/{club_id}/users/{user_id}")
def delete_user(club_id: str, user_id: str, request: Request) -> dict:
    actor = require_admin_acting(request, club_id)

    registry = org.get_registry()
    existing = registry.get_user(user_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="user not found")
    if existing.club_id != club_id:
        raise HTTPException(403, "user does not belong to this club")
    _replace(club_id, user_id, existing.role, actor, remove=True)
    return {"ok": True, "user_id": user_id}


class UserStatusUpdate(BaseModel):
    status: str  # "active" | "deactivated"


@router.patch("/clubs/{club_id}/users/{user_id}/status")
def set_user_status(club_id: str, user_id: str, payload: UserStatusUpdate,
                    request: Request) -> dict:
    """Deactivate/reactivate a member (Mi Club Phase 4, F11 enabler).

    F9-tiered like role removal: the actor must hold a role-management cap
    AND ``can_assign_role`` on the target's primary role — a Sports Director
    can deactivate a coach but never an administrator. Audited via
    ``RoleChangeAudit`` with action ``deactivate``/``reactivate``.
    """
    actor = require_roles_admin_acting(request, club_id)

    if payload.status not in ("active", "deactivated"):
        raise HTTPException(
            status_code=400, detail="status must be 'active' or 'deactivated'")

    registry = org.get_registry()
    existing = registry.get_user(user_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="user not found")
    if existing.club_id != club_id:
        raise HTTPException(status_code=403, detail="user does not belong to this club")
    if existing.status == payload.status:
        return {"ok": True, "user_id": user_id, "status": payload.status}

    # F9: the target's primary role bounds who may deactivate/reactivate them.
    if not _is_break_glass_admin(actor):
        caps = effective_capabilities(actor, f"club:{club_id}", org.get_roles())
        if not can_assign_role(caps, existing.role):
            raise HTTPException(
                status_code=403,
                detail=f"insufficient privileges to change status for role: {existing.role}",
            )
    if user_id == actor:
        raise HTTPException(status_code=400, detail="cannot change own status")

    _replace(club_id, user_id, existing.role, actor, {"status": payload.status})
    return {"ok": True, "user_id": user_id, "status": payload.status}


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
