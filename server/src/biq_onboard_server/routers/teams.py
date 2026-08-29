"""Team CRUD endpoints (org-registry teams, not per-coach season-plan teams)."""

from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException, Request

from biq_core.roles import effective_capabilities

from .. import org
from ..auth import _is_break_glass_admin, require_admin, session_user
from ..models import TeamCreate, TeamUpdate
from ..routers.onboarding_flow import _resolve_acting_identity

router = APIRouter(prefix="/clubs/{club_id}/teams")


def _s2s_secret() -> str | None:
    """Return the configured S2S secret, or None when S2S is disabled."""
    return os.environ.get("BIQ_ONBOARD_S2S_SECRET") or None


def _require_teams_manage(request: Request, club_id: str) -> str:
    """Authorize team-catalog management, resolving identity from S2S or session.

    F12: Accepts ``club.admin`` (administrator) OR ``club.teams.manage``
    (administrator + Sports Director). This is deliberately separate from
    ``require_admin`` so the broader ``roles.manage`` gate is not loosened
    for non-team endpoints.

    S2S mode (C2): when a valid S2S bearer token is present, identity comes
    from the asserted headers (X-BIQ-Acting-User-Id / X-BIQ-Acting-Email),
    not the local session. This is required for the BFF proxy path
    (browser → biq-app → biq-onboard) where the proxy forwards identity
    via headers, not cookies.

    Standalone mode: falls back to ``session_user()`` when no S2S secret
    is configured.
    """
    secret = _s2s_secret()
    if secret:
        # S2S mode: resolve identity from headers (fail-closed on bad token)
        user_id, _email = _resolve_acting_identity(request)
        if _is_break_glass_admin(user_id):
            return user_id
        caps = effective_capabilities(user_id, f"club:{club_id}", org.get_roles())
        if "club.admin" not in caps and "club.teams.manage" not in caps:
            raise HTTPException(
                status_code=403,
                detail=f"team-catalog management requires club.admin or club.teams.manage for club {club_id}",
            )
        return user_id

    # Standalone mode — local session
    user = session_user(request)
    if _is_break_glass_admin(user):
        return user
    caps = effective_capabilities(user, f"club:{club_id}", org.get_roles())
    if "club.admin" not in caps and "club.teams.manage" not in caps:
        raise HTTPException(
            status_code=403,
            detail=f"team-catalog management requires club.admin or club.teams.manage for club {club_id}",
        )
    return user


@router.post("")
def create_team(club_id: str, payload: TeamCreate, request: Request) -> dict:
    _require_teams_manage(request, club_id)
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
    _require_teams_manage(request, club_id)
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
                "archived": t.archived,
            }
            for t in teams
        ],
        "total": len(teams),
    }


@router.put("/{team_id}")
def update_team(club_id: str, team_id: str, payload: TeamUpdate, request: Request) -> dict:
    _require_teams_manage(request, club_id)
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
    _require_teams_manage(request, club_id)
    from ..onboarding import _delete_team_safe

    registry = org.get_registry()
    _delete_team_safe(registry, club_id, team_id)
    return {"ok": True, "team_id": team_id}


@router.put("/{team_id}/archive")
def archive_team(club_id: str, team_id: str, request: Request) -> dict:
    """Archive or unarchive a team (business remediation B).

    Sets archived=true on the team. Archived teams have their future
    operational occurrences and actions cancelled by the OEE engine.
    """
    _require_teams_manage(request, club_id)
    from biq_core.org import Team

    registry = org.get_registry()
    existing = registry.get_team(club_id, team_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="team not found")

    team = Team(
        id=team_id,
        club_id=club_id,
        name=existing.name,
        category=existing.category,
        gender=existing.gender,
        label=existing.label,
        timezone=existing.timezone,
        staff_user_ids=existing.staff_user_ids,
        archived=True,
    )
    registry.upsert_team(team)
    return {"ok": True, "team_id": team_id, "archived": True}


@router.put("/{team_id}/unarchive")
def unarchive_team(club_id: str, team_id: str, request: Request) -> dict:
    """Unarchive a team — resume normal operational reconciliation."""
    _require_teams_manage(request, club_id)
    from biq_core.org import Team

    registry = org.get_registry()
    existing = registry.get_team(club_id, team_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="team not found")

    team = Team(
        id=team_id,
        club_id=club_id,
        name=existing.name,
        category=existing.category,
        gender=existing.gender,
        label=existing.label,
        timezone=existing.timezone,
        staff_user_ids=existing.staff_user_ids,
        archived=False,
    )
    registry.upsert_team(team)
    return {"ok": True, "team_id": team_id, "archived": False}


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
