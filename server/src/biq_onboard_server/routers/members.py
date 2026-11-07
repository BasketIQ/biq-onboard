"""Club member-management endpoints (Mi Club Phases 4-5).

The Miembros tab issues a recipient-bound coach invitation and sends
the email via biq-app's ``/internal/email/invite`` contract.

Auth is S2S-aware like the teams router: when ``BIQ_ONBOARD_S2S_SECRET`` is
configured the identity comes from the asserted ``X-BIQ-Acting-*`` headers
(the BFF proxy path), fail-closed on a bad token; standalone deployments
fall back to the session cookie.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import clients, entry_ops, org
from ..clients import UpstreamServiceError
from ..auth import require_roles_admin_acting

router = APIRouter(prefix="/clubs/{club_id}")

# Deliberately simple: local@domain.tld shape; the invitee need not exist in
# the registry (that's the point of an invite).
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class InviteRequest(BaseModel):
    email: str


@router.post("/invite")
def invite_member(club_id: str, payload: InviteRequest, request: Request) -> dict:
    """Issue a coach invitation and notify its recipient."""
    issuer = require_roles_admin_acting(request, club_id)

    to = (payload.email or "").strip()
    if not _EMAIL_RE.match(to):
        raise HTTPException(status_code=400, detail="invalid email address")

    club = org.get_registry().get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")

    entry_ops._issue_invitation(
        club_id, issuer, entry_ops.IssueBody(recipient_email=to), discoverable=True,
    )
    try:
        result = clients.send_invite(to, club.name, club_id)
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "invited": to, "skipped": bool(result.get("skipped"))}
