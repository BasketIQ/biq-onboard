"""Role assignment CRUD endpoints.

F9: Uses tiered authorization — ``roles.manage`` (administrator) can assign
any club role; ``roles.manage.sporting`` (Sports Director) can only assign
sporting roles (coach, coordinator, player). All mutations are recorded in
the audit log.
"""

from __future__ import annotations

from biq_core.roles import RoleAssignment, can_assign_role, effective_capabilities
from biq_core.roles.models import ROLES
from fastapi import APIRouter, HTTPException, Request

from .. import org
from ..auth import _is_break_glass_admin, require_admin, session_user
from ..models import RoleAssign

router = APIRouter(prefix="/clubs/{club_id}/roles")


def _actor_caps(request: Request, club_id: str) -> list[str]:
    """Resolve the caller's effective capabilities for the club scope."""
    user = session_user(request)
    scope = f"club:{club_id}"
    return effective_capabilities(user, scope, org.get_roles())


def _audit_log():
    """Return the cached RoleAuditLog from org module."""
    return org.get_audit_log()


@router.post("")
def assign_role(club_id: str, payload: RoleAssign, request: Request) -> dict:
    require_admin(request, club_id)
    if payload.role not in ROLES:
        raise HTTPException(status_code=400, detail=f"Unknown role: {payload.role}")

    registry = org.get_registry()
    roles = org.get_roles()

    user = registry.get_user(payload.user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")
    if user.club_id != club_id:
        raise HTTPException(status_code=403, detail="user does not belong to this club")

    # F9: Tiered authorization — break-glass admin bypasses; otherwise
    # check can_assign_role with caller's effective capabilities.
    actor = session_user(request)
    if not _is_break_glass_admin(actor):
        caps = _actor_caps(request, club_id)
        if not can_assign_role(caps, payload.role):
            raise HTTPException(
                status_code=403,
                detail=f"insufficient privileges to assign role: {payload.role}",
            )

    scope = payload.scope or f"club:{club_id}"
    assignment = RoleAssignment(
        id=f"{payload.user_id}__{payload.role}__{scope}",
        user_id=payload.user_id,
        role=payload.role,
        scope=scope,
    )
    roles.put_assignment(assignment)

    # F9: Audit log.
    from biq_core.roles import RoleChangeAudit

    _audit_log().record(
        RoleChangeAudit(
            action="assign",
            actor_id=actor,
            target_user_id=payload.user_id,
            role=payload.role,
            scope=scope,
            assignment_id=assignment.id,
        )
    )

    return {
        "ok": True,
        "assignment_id": assignment.id,
        "user_id": payload.user_id,
        "role": payload.role,
        "scope": scope,
    }


@router.get("")
def list_roles(club_id: str, request: Request) -> dict:
    require_admin(request, club_id)
    roles = org.get_roles()
    scope = f"club:{club_id}"
    assignments = roles.list_assignments_for_scope(scope)
    return {
        "assignments": [
            {"id": a.id, "user_id": a.user_id, "role": a.role, "scope": a.scope}
            for a in assignments
        ],
        "total": len(assignments),
        "scope": scope,
    }


@router.delete("/{assignment_id}")
def remove_role(club_id: str, assignment_id: str, request: Request) -> dict:
    require_admin(request, club_id)
    roles = org.get_roles()
    scope = f"club:{club_id}"
    # Verify the assignment belongs to this club scope
    if scope not in assignment_id:
        raise HTTPException(
            status_code=403, detail="assignment does not belong to this club"
        )

    # F9: Find the assignment before removing so we can audit it.
    assignments = roles.list_assignments_for_scope(scope)
    removed_assignment = next((a for a in assignments if a.id == assignment_id), None)

    roles.remove_assignment(assignment_id)

    # F9: Audit log.
    if removed_assignment is not None:
        from biq_core.roles import RoleChangeAudit

        actor = session_user(request)
        _audit_log().record(
            RoleChangeAudit(
                action="remove",
                actor_id=actor,
                target_user_id=removed_assignment.user_id,
                role=removed_assignment.role,
                scope=scope,
                assignment_id=assignment_id,
            )
        )

    return {"ok": True, "assignment_id": assignment_id}
