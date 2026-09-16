"""Club member-management endpoints (Mi Club Phases 4-5).

Phase 5 ships ``POST /clubs/{club_id}/invite`` — an invite-by-email nudge
at the existing self-service join flow, sent via biq-app's
``/internal/email/invite`` contract. Phase 4 adds the Miembros tab's
member list/edit/status endpoints here.

Auth is S2S-aware like the teams router: when ``BIQ_ONBOARD_S2S_SECRET`` is
configured the identity comes from the asserted ``X-BIQ-Acting-*`` headers
(the BFF proxy path), fail-closed on a bad token; standalone deployments
fall back to the session cookie.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from biq_core.roles import effective_capabilities

from .. import clients, org
from ..auth import _is_break_glass_admin
from ..clients import UpstreamServiceError
from ..routers.onboarding_flow import _resolve_acting_identity

router = APIRouter(prefix="/clubs/{club_id}")

# Deliberately simple: local@domain.tld shape; the invitee need not exist in
# the registry (that's the point of an invite).
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class InviteRequest(BaseModel):
    email: str


def _require_member_admin(request: Request, club_id: str) -> str:
    """Acting user must hold a role-management capability at the club scope.

    Same capability set as ``require_roles_admin`` (``club.admin`` /
    ``roles.manage`` / ``roles.manage.sporting``) but resolved through the
    S2S acting-identity channel so the biq-app proxy path works.
    """
    user, _email = _resolve_acting_identity(request)
    if _is_break_glass_admin(user):
        return user
    caps = effective_capabilities(user, f"club:{club_id}", org.get_roles())
    if not ({"club.admin", "roles.manage", "roles.manage.sporting"} & set(caps)):
        raise HTTPException(
            status_code=403,
            detail=f"member-management capability required for club {club_id}",
        )
    return user


@router.post("/invite")
def invite_member(club_id: str, payload: InviteRequest, request: Request) -> dict:
    """Send an invite-by-email nudge to a prospective club member."""
    _require_member_admin(request, club_id)

    to = (payload.email or "").strip()
    if not _EMAIL_RE.match(to):
        raise HTTPException(status_code=400, detail="invalid email address")

    club = org.get_registry().get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")

    try:
        result = clients.send_invite(to, club.name, club_id)
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "invited": to, "skipped": bool(result.get("skipped"))}
