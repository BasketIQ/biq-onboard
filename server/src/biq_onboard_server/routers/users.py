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

router = APIRouter()


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
    return sorted({member.role, *assigned.get(member.id, [])})


def _sync_secondary_roles(
    *,
    club_id: str,
    user_id: str,
    primary_role: str,
    target_roles: list[str],
    actor: str,
) -> None:
    """Sync club-scope assignments to ``primary_role ∪ target_roles``.

    Adds/removes RoleAssignments only — ``User.role`` is untouched. Each
    mutation is F9-gated (``can_assign_role`` on the actor's capabilities)
    and recorded in the role-change audit log. The primary role's assignment
    is always present and never removed by the sync.
    """
    from biq_core.roles import RoleAssignment, RoleChangeAudit, can_assign_role, effective_capabilities
    from biq_core.roles.models import ROLES

    for r in target_roles:
        if r not in ROLES:
            raise HTTPException(status_code=400, detail=f"Unknown role: {r}")

    roles = org.get_roles()
    scope = f"club:{club_id}"
    target = {primary_role, *target_roles}
    break_glass = _is_break_glass_admin(actor)
    caps = effective_capabilities(actor, scope, roles)

    existing = {
        a.role: a
        for a in roles.list_assignments(user_id, scope)
        if a.is_active()
    }
    for role in sorted(target - set(existing)):
        if not break_glass and not can_assign_role(caps, role):
            raise HTTPException(
                status_code=403,
                detail=f"insufficient privileges to assign role: {role}",
            )
        assignment = RoleAssignment(
            id=f"{user_id}__{role}__{scope}",
            user_id=user_id,
            role=role,
            scope=scope,
        )
        roles.put_assignment(assignment)
        org.get_audit_log().record(RoleChangeAudit(
            action="assign", actor_id=actor, target_user_id=user_id,
            role=role, scope=scope, assignment_id=assignment.id,
        ))
    for role, assignment in sorted(existing.items()):
        if role not in target:
            if not break_glass and not can_assign_role(caps, role):
                raise HTTPException(
                    status_code=403,
                    detail=f"insufficient privileges to remove role: {role}",
                )
            roles.remove_assignment(assignment.id)
            org.get_audit_log().record(RoleChangeAudit(
                action="remove", actor_id=actor, target_user_id=user_id,
                role=role, scope=scope, assignment_id=assignment.id,
            ))


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

    # F9 multi-role: grant any secondary roles as additional assignments.
    if payload.roles:
        _sync_secondary_roles(
            club_id=club_id, user_id=payload.id, primary_role=payload.role,
            target_roles=payload.roles, actor=session_user(request),
        )

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

    # F9 multi-role: sync secondary roles when the caller provides the set.
    if payload.roles is not None:
        _sync_secondary_roles(
            club_id=club_id, user_id=user_id, primary_role=new_role,
            target_roles=payload.roles, actor=actor,
        )

    return {"ok": True, "user": {"id": user_id}}


@router.delete("/clubs/{club_id}/users/{user_id}")
def delete_user(club_id: str, user_id: str, request: Request) -> dict:
    require_admin_acting(request, club_id)
    from ..onboarding import _delete_user_safe

    registry = org.get_registry()
    existing = registry.get_user(user_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="user not found")
    _delete_user_safe(registry, user_id)
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

    from biq_core.org import User
    from biq_core.roles import RoleChangeAudit

    updated = User(
        id=user_id,
        club_id=club_id,
        role=existing.role,
        display_name=existing.display_name,
        email=existing.email,
        default_team_id=existing.default_team_id,
        password_hash=existing.password_hash,
        status=payload.status,
    )
    registry.upsert_user(updated)
    org.get_audit_log().record(RoleChangeAudit(
        action="deactivate" if payload.status == "deactivated" else "reactivate",
        actor_id=actor,
        target_user_id=user_id,
        role=existing.role,
        scope=f"club:{club_id}",
    ))
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
