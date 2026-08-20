"""Role assignment CRUD endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from biq_core.roles import RoleAssignment
from biq_core.roles.models import ROLES

from .. import org
from ..auth import require_admin
from ..models import RoleAssign

router = APIRouter(prefix="/clubs/{club_id}/roles")


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

    scope = payload.scope or f"club:{club_id}"
    assignment = RoleAssignment(
        id=f"{payload.user_id}__{payload.role}__{scope}",
        user_id=payload.user_id,
        role=payload.role,
        scope=scope,
    )
    roles.put_assignment(assignment)
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
        raise HTTPException(status_code=403, detail="assignment does not belong to this club")
    roles.remove_assignment(assignment_id)
    return {"ok": True, "assignment_id": assignment_id}
