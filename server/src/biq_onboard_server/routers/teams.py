"""Team CRUD endpoints (org-registry teams, not per-coach season-plan teams)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from .. import org
from ..auth import require_admin
from ..models import TeamCreate, TeamUpdate

router = APIRouter(prefix="/clubs/{club_id}/teams")


@router.post("")
def create_team(club_id: str, payload: TeamCreate, request: Request) -> dict:
    require_admin(request, club_id)
    from biq_core.org import Team

    registry = org.get_registry()
    team = Team(
        id=payload.id,
        club_id=club_id,
        name=payload.name,
        category=payload.category,
        gender=payload.gender,
        label=payload.label,
    )
    registry.upsert_team(team)
    return {"ok": True, "team": {"id": team.id, "name": team.name}}


@router.get("")
def list_teams(club_id: str, request: Request) -> dict:
    require_admin(request, club_id)
    registry = org.get_registry()
    teams = registry.list_teams(club_id)
    return {
        "teams": [
            {
                "id": t.id,
                "club_id": t.club_id,
                "name": t.name,
                "category": t.category,
                "gender": t.gender,
                "label": t.label,
                "timezone": t.timezone,
                "staff_user_ids": t.staff_user_ids,
            }
            for t in teams
        ],
        "total": len(teams),
    }


@router.put("/{team_id}")
def update_team(club_id: str, team_id: str, payload: TeamUpdate, request: Request) -> dict:
    require_admin(request, club_id)
    from biq_core.org import Team

    registry = org.get_registry()
    existing = registry.get_team(club_id, team_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="team not found")

    # Build the updated team using `is not None` checks (not `or`) so that
    # an explicit empty list (staff_user_ids: []) or empty string is written
    # rather than silently falling through to the existing value.
    # The `payload.x or existing.x` idiom is a trap for list/str fields
    # where falsy values (empty list, empty string) are legitimate.
    team = Team(
        id=team_id,
        club_id=club_id,
        name=payload.name if payload.name is not None else existing.name,
        category=payload.category if payload.category is not None else existing.category,
        gender=payload.gender if payload.gender is not None else existing.gender,
        label=payload.label if payload.label is not None else existing.label,
        timezone=payload.timezone if payload.timezone is not None else existing.timezone,
        staff_user_ids=payload.staff_user_ids if payload.staff_user_ids is not None else existing.staff_user_ids,
    )
    registry.upsert_team(team)
    return {
        "ok": True,
        "team": {
            "id": team.id,
            "name": team.name,
            "timezone": team.timezone,
            "staff_user_ids": team.staff_user_ids,
        },
    }


@router.delete("/{team_id}")
def delete_team(club_id: str, team_id: str, request: Request) -> dict:
    require_admin(request, club_id)
    from ..onboarding import _delete_team_safe

    registry = org.get_registry()
    _delete_team_safe(registry, club_id, team_id)
    return {"ok": True, "team_id": team_id}


@router.post("/migrate-staff")
def migrate_staff(club_id: str, request: Request) -> dict:
    """One-shot membership migration (OEE-1c · A4).

    Seeds ``Team.staff_user_ids`` from the current per-coach ``team_ids``
    selections. Idempotent: only adds users not already in
    ``staff_user_ids``; running it twice produces the same membership.
    """
    require_admin(request, club_id)
    from ..migrate_staff import migrate_club

    return {"ok": True, "summary": migrate_club(club_id)}
