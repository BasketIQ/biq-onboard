"""Onboarding (one-shot) + staff listing endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from biq_core.roles import effective_capabilities

from .. import org
from ..auth import require_admin
from ..models import OnboardRequest
from ..onboarding import offboard_club, onboard_club

router = APIRouter(prefix="/clubs/{club_id}")


@router.post("/onboard")
def onboard(club_id: str, payload: OnboardRequest, request: Request) -> dict:
    require_admin(request, club_id)
    try:
        return onboard_club(
            club_id=payload.club_id,
            name=payload.name,
            slug=payload.slug,
            short_name=payload.short_name,
            season=payload.season,
            staff=payload.staff,
            password=payload.password,
            reset_passwords=payload.reset_passwords,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/staff")
def list_staff(club_id: str, request: Request) -> dict:
    require_admin(request, club_id)
    registry = org.get_registry()
    roles = org.get_roles()
    scope = f"club:{club_id}"

    members = registry.list_members(club_id)
    assignments = roles.list_assignments_for_scope(scope)

    # Build a map of user_id → roles
    roles_by_user: dict[str, list[str]] = {}
    for a in assignments:
        roles_by_user.setdefault(a.user_id, []).append(a.role)

    result = []
    for m in members:
        user_roles = roles_by_user.get(m.id, [])
        caps = effective_capabilities(m.id, scope, roles)
        result.append({
            "user_id": m.id,
            "display_name": m.display_name,
            "default_team_id": m.default_team_id,
            "org_role": m.role,
            "methodology_roles": sorted(user_roles),
            "capabilities": sorted(caps),
        })

    return {
        "club_id": club_id,
        "scope": scope,
        "members": result,
        "total_members": len(result),
        "total_assignments": len(assignments),
    }


@router.delete("/offboard")
def offboard(club_id: str, request: Request) -> dict:
    require_admin(request, club_id)
    return offboard_club(club_id)
