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
            {"id": t.id, "club_id": t.club_id, "name": t.name, "category": t.category, "gender": t.gender, "label": t.label}
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
    team = Team(
        id=team_id,
        club_id=club_id,
        name=payload.name or existing.name,
        category=payload.category or existing.category,
        gender=payload.gender or existing.gender,
        label=payload.label or existing.label,
    )
    registry.upsert_team(team)
    return {"ok": True, "team": {"id": team.id, "name": team.name}}


@router.delete("/{team_id}")
def delete_team(club_id: str, team_id: str, request: Request) -> dict:
    require_admin(request, club_id)
    from ..onboarding import _delete_team_safe

    registry = org.get_registry()
    _delete_team_safe(registry, club_id, team_id)
    return {"ok": True, "team_id": team_id}
