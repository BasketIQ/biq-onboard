"""Club profile summary endpoint (Mi Club Phase 3).

``GET /clubs/{club_id}/summary`` — the Perfil tab's club card data: club id,
team count, active member count, methodology presence, season-plan presence.
Readable by any authenticated member of the club (not admin-gated — the
Perfil tab renders for every member).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from biq_core.roles import effective_capabilities

from .. import clients, org
from ..auth import _is_break_glass_admin
from ..auth import _resolve_acting_identity

router = APIRouter()


def _require_member(request: Request, club_id: str) -> str:
    """Return the acting user or 403 if they don't belong to the club.

    S2S-aware: the browser reaches this endpoint through the biq-app proxy
    (Bearer S2S secret + asserted identity headers); standalone deployments
    (no secret configured) fall back to the local session cookie.
    """
    user, _email = _resolve_acting_identity(request)
    if _is_break_glass_admin(user):
        return user
    registry = org.get_registry()
    member = registry.get_user(user)
    if member is not None and member.club_id == club_id:
        return user
    # Club admins/SDs may not carry a member doc — allow via capabilities.
    caps = effective_capabilities(user, f"club:{club_id}", org.get_roles())
    if {"club.admin", "roles.manage", "roles.manage.sporting"} & set(caps):
        return user
    raise HTTPException(status_code=403, detail=f"not a member of club {club_id}")


@router.get("/clubs/{club_id}/summary")
def club_summary(club_id: str, request: Request) -> dict:
    _require_member(request, club_id)
    registry = org.get_registry()

    club = registry.get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")

    teams = registry.list_teams(club_id)
    members = registry.list_members(club_id)
    active_members = [m for m in members if getattr(m, "status", "active") == "active"]

    team_ids = [t.id for t in teams]
    return {
        "club": {
            "id": club.id,
            "name": club.name,
            "status": club.status,
        },
        "team_count": len(teams),
        "member_count": len(active_members),
        "methodology_present": clients.methodology_present(club_id),
        "season_plan_present": clients.season_plan_present(team_ids),
    }
