"""Team CRUD endpoints (org-registry teams, not per-coach season-plan teams)."""

from __future__ import annotations

import os
import re

from fastapi import APIRouter, HTTPException, Request

from biq_core.roles import effective_capabilities

from .. import org
from ..auth import _is_break_glass_admin, require_admin, session_user
from ..models import TeamCreate, TeamUpdate
from ..auth import _resolve_acting_identity

router = APIRouter(prefix="/clubs/{club_id}/teams")
# Mounted alongside `router` at /api/admin — club-scoped endpoints that are
# about the team catalog but not under the /teams path itself.
club_router = APIRouter(prefix="/clubs/{club_id}")


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
    # competitive_level is only passed when the caller sent it — under the
    # registry's partial-write contract an omitted field means "leave alone",
    # so a create against an existing id cannot silently clear a stored level.
    extra = {}
    if payload.competitive_level is not None:
        extra["competitive_level"] = payload.competitive_level
    team = Team(
        id=payload.id,
        club_id=club_id,
        name=payload.name,
        category=payload.category,
        gender=payload.gender,
        label=payload.label,
        **extra,
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
                "competitive_level": t.competitive_level,
            }
            for t in teams
        ],
        "total": len(teams),
    }


# team_<slug>_<category>[_<cohort>]_<gender> — category slugs from
# biq_core.org.catalog.CATEGORIES; cohort only for cohorted categories.
_CATALOG_TEAM_ID_RE = re.compile(
    r"^team_(.+)_(babybasket|prebenjamin|benjamin|alevin|infantil|cadete|junior|senior|veteranos)"
    r"(?:_\d+)?_[mfx]$"
)


def _catalog_slug(club_id: str, teams: list, job: dict | None) -> str:
    """Recover the catalog slug (team-id namespace) the club was seeded under.

    Self-service clubs seed under ``club_id``; admin-onboarded clubs may use a
    distinct slug (``onboard_club``'s ``slug`` param). Order of recovery: the
    recorded ``catalog_slug`` on the last seeding job (survives a zero-team
    state), then an existing team id — the greedy ``(.+)`` keeps working when
    the slug itself contains a category word (``team_mi_senior_club_senior_m``
    → ``mi_senior_club``) — then ``club_id`` (the self-service convention,
    covering pre-tracking clubs like the reported zero-team incident).
    """
    if job and job.get("catalog_slug"):
        return job["catalog_slug"]
    for t in teams:
        m = _CATALOG_TEAM_ID_RE.match(t.id)
        if m:
            return m.group(1)
    return club_id


@club_router.get("/team-seeding")
def get_team_seeding(club_id: str, request: Request) -> dict:
    """Return the club's team-seeding job status, ``null`` if it never ran.

    Same response-shape convention as ``GET /clubs/{club_id}/theme``; same
    capability gate as team CRUD (``club.admin`` or ``club.teams.manage``).
    """
    _require_teams_manage(request, club_id)
    club = org.get_registry().get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")
    return {"ok": True, "team_seeding_job": club.team_seeding_job}


@router.post("/reseed")
def reseed_teams(club_id: str, request: Request) -> dict:
    """Regenerate the default team catalog in place (idempotent).

    ``bulk_upsert_teams`` merge semantics relabel existing docs rather than
    duplicating, so this is safe to call any number of times — including from
    a zero-team state, which is the recovery path for clubs whose creation-time
    seeding failed silently (the Equipos tab's "Reintentar" action).
    """
    _require_teams_manage(request, club_id)
    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")

    from ..onboarding import seed_club_team_catalog
    from .onboarding_flow import _current_season_year

    slug = _catalog_slug(club_id, registry.list_teams(club_id), club.team_seeding_job)
    season_str = registry.get_season()
    season_year = (
        int(season_str.split("/")[0]) if season_str else _current_season_year()
    )
    try:
        written = seed_club_team_catalog(registry, club_id, slug, season_year)
    except Exception as exc:
        # The helper already persisted the failed job — surface it as a hard
        # error so the caller knows the retry did not succeed; the durable
        # state stays queryable via GET .../team-seeding.
        raise HTTPException(
            status_code=500, detail=f"team reseed failed: {exc}"
        ) from exc
    return {
        "ok": True,
        "teams_written": written,
        "team_seeding_job": registry.get_club(club_id).team_seeding_job,
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
        competitive_level=payload.competitive_level if payload.competitive_level is not None else existing.competitive_level,
    )
    registry.upsert_team(team)
    return {
        "ok": True,
        "team": {
            "id": team.id,
            "name": team.name,
            "timezone": team.timezone,
            "staff_user_ids": team.staff_user_ids,
            "competitive_level": team.competitive_level,
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
        competitive_level=existing.competitive_level,
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
        competitive_level=existing.competitive_level,
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
