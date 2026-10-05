"""Authorized entry ops — invitations + gated club creation.

Consumed ONLY by biq-app's context entry endpoints over the S2S channel:
``Authorization: Bearer <BIQ_ONBOARD_S2S_SECRET>`` plus the App-minted
``X-BIQ-Entry-Token`` (``biq:onboard:entry-v1``) binding the call to a
resolved account. Machine auth + entry proof verify BEFORE any
invitation/club data is touched.

- ``GET  /api/ops/invitations/{token}/preview`` — club display name only,
  never member data; a dead/expired token answers the same 404.
- ``POST /api/ops/invitations/redeem`` — atomic single-use claim: creates
  the membership row + role assignments and binds the account.
- ``POST /api/ops/clubs`` — PC-01 transport: App has already gated the
  account (verified identity + allowlist); here the idempotent creation
  itself runs.
- ``POST /api/admin/clubs/{club_id}/invitations`` — staff-facing issue
  endpoint (acting-identity + role-management capability), returns the
  raw token once.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from . import entry_proof, invitations, org
from .auth import _s2s_secret, require_roles_admin_acting

logger = logging.getLogger(__name__)

router = APIRouter()  # ops: S2S + entry proof
staff_router = APIRouter()  # staff-scoped issue endpoint

_MEMBER_ROLES = ("administrator", "sports_director", "coach", "assistant", "coordinator")


def _require_s2s(request: Request) -> None:
    secret = _s2s_secret()
    presented = request.headers.get("authorization", "")
    if not secret or not presented.startswith("Bearer ") or not hmac.compare_digest(
        presented[7:], secret
    ):
        raise HTTPException(status_code=401, detail="invalid service token")


def _account_from_proof(request: Request) -> str:
    try:
        claims = entry_proof.proof_from_request(request)
    except entry_proof.EntryProofError as exc:
        raise HTTPException(status_code=401, detail="invalid entry proof") from exc
    return claims["sub"]


def _now_iso() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat()


def _public_invitation(inv: invitations.Invitation) -> dict[str, Any]:
    club = None
    try:
        club = org.get_registry().get_club(inv.club_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="registry unavailable") from exc
    return {
        "club_id": inv.club_id,
        "club_name": getattr(club, "name", "") if club else "",
        "proposed_roles": list(inv.proposed_roles),
        "expires_at": inv.expires_at,
    }


# ── ops endpoints (S2S + entry proof) ────────────────────────────────────


@router.get("/api/ops/invitations/{token}/preview")
def invitation_preview(token: str, request: Request) -> dict:
    _require_s2s(request)
    _account_from_proof(request)
    store = invitations.get_invitation_store()
    inv = store.get_by_digest(invitations.token_digest(token.strip()))
    if inv is None or not inv.is_live(_now_iso()):
        raise HTTPException(status_code=404, detail="invitation not found")
    return _public_invitation(inv)


class RedeemBody(BaseModel):
    token: str = Field(max_length=512)


@router.post("/api/ops/invitations/redeem")
def invitation_redeem(body: RedeemBody, request: Request) -> dict:
    _require_s2s(request)
    account_id = _account_from_proof(request)
    store = invitations.get_invitation_store()
    inv = store.get_by_digest(invitations.token_digest(body.token.strip()))
    if inv is None:
        raise HTTPException(status_code=404, detail="invitation not found")

    # Deterministic membership id: concurrent claims upsert the same row,
    # the transact() gate picks exactly one winner — no duplicate members.
    membership_id = f"f1f2m_{hashlib.sha256(inv.invitation_id.encode()).hexdigest()[:12]}"
    now = _now_iso()

    def _claim(current: invitations.Invitation | None) -> invitations.Invitation | None:
        if current is None or not current.is_live(now):
            return None
        current.status = "redeemed"
        current.redeemed_at = now
        current.redeemed_account_id = account_id
        current.membership_subject_id = membership_id
        return current

    claimed = store.transact(inv.invitation_id, _claim)
    if claimed is None or claimed.redeemed_account_id != account_id:
        raise HTTPException(status_code=409, detail="invitation unavailable")

    try:
        from biq_core.org import User
        from biq_core.roles import RoleAssignment

        registry = org.get_registry()
        roles = [r for r in inv.proposed_roles if r in _MEMBER_ROLES] or ["coach"]
        membership = User(
            id=membership_id,
            club_id=inv.club_id,
            email="",
            display_name="",
            role=roles[0],
            status="active",
        )
        registry.upsert_user(membership)
        role_registry = org.get_roles()
        for role in roles:
            scope = f"club:{inv.club_id}"
            role_registry.put_assignment(
                RoleAssignment(
                    user_id=membership_id,
                    role=role,
                    scope=scope,
                    id=f"{membership_id}__{role}__{scope}",
                )
            )
    except Exception as exc:
        logger.error("invitation membership write failed: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="registry unavailable") from exc

    return {
        "club_id": inv.club_id,
        "membership_subject_id": membership_id,
        "roles": roles,
    }


class ClubCreateBody(BaseModel):
    # Loosely typed: auth (S2S + entry proof) must precede field validation.
    name: str = Field(default="", max_length=200)
    website: str | None = Field(default=None, max_length=512)
    idempotency_key: str | None = Field(default=None, max_length=128)
    email: str | None = Field(default=None, max_length=320)


@router.post("/api/ops/clubs", status_code=201)
def ops_create_club(body: ClubCreateBody, request: Request) -> dict:
    """PC-01 transport — App has already gated the account; this service
    runs the idempotent creation and returns the creator membership."""
    _require_s2s(request)
    _account_from_proof(request)

    name = body.name.strip()
    if len(name) < 2:
        raise HTTPException(status_code=422, detail="club name required")
    website = (body.website or "").strip()
    if website and not website.startswith("https://"):
        raise HTTPException(status_code=422, detail="website must use https://")

    from biq_core.org import Club, User
    from biq_core.roles import RoleAssignment

    registry = org.get_registry()
    idem = (body.idempotency_key or "").strip()
    if idem:
        digest = hashlib.sha256(idem.encode()).hexdigest()[:12]
        club_id = f"f1f2_{digest}"
        membership_id = f"f1f2m_{digest}"
    else:
        club_id = registry.next_club_id()
        membership_id = registry.next_user_id()
    scope = f"club:{club_id}"
    email = (body.email or "").strip().lower()

    club = Club(id=club_id, name=name, status="active", website=website or None)
    membership = User(
        id=membership_id,
        club_id=club_id,
        email=email,
        role="administrator",
        status="active",
    )
    assignments = [
        RoleAssignment(
            user_id=membership_id, role=role, scope=scope,
            id=f"{membership_id}__{role}__{scope}",
        )
        for role in ("administrator", "sports_director")
    ]
    try:
        registry.create_club_with_creator_tx(
            club, membership, assignments, role_registry=org.get_roles()
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail="club creation failed") from exc

    teams_seeded = 0
    try:
        from .onboarding import seed_club_team_catalog

        season_str = registry.get_season()
        season_year = (
            int((season_str or "").split("/")[0])
            if season_str
            else __import__("datetime").datetime.now(__import__("datetime").UTC).year
        )
        teams_seeded = seed_club_team_catalog(registry, club_id, club_id, season_year)
    except Exception as exc:
        logger.error("entry club-create seeding failed for %s: %s", club_id, exc)

    return {
        "club": {"id": club_id, "name": name, "website": website or None},
        "membership_subject_id": membership_id,
        "idempotent": bool(idem),
        "teams_seeded": teams_seeded,
    }


# ── staff-scoped issue endpoint ──────────────────────────────────────────


class IssueBody(BaseModel):
    proposed_roles: list[str] = Field(default_factory=lambda: ["coach"])
    recipient_email: str | None = Field(default=None, max_length=320)
    expires_at: str | None = Field(default=None)


@staff_router.post("/api/admin/clubs/{club_id}/invitations", status_code=201)
def issue_invitation(club_id: str, body: IssueBody, request: Request) -> dict:
    """Issue a tokenized invitation — requires role-management capability."""
    issuer = require_roles_admin_acting(request, club_id)
    roles = [r for r in body.proposed_roles if r in _MEMBER_ROLES]
    if not roles:
        raise HTTPException(status_code=422, detail="proposed_roles required")
    inv = invitations.Invitation(
        invitation_id=invitations.new_id(),
        club_id=club_id,
        token_digest="",  # set below
        proposed_roles=roles,
        recipient_email=(body.recipient_email or "").strip().lower(),
        issuer_membership_id=issuer,
        expires_at=(body.expires_at or "").strip() or invitations.default_expiry(),
        created_at=_now_iso(),
    )
    token = invitations.new_token()
    inv.token_digest = invitations.token_digest(token)
    try:
        invitations.get_invitation_store().put(inv)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="invitation store unavailable") from exc
    return {
        "invitation_id": inv.invitation_id,
        "token": token,
        "club_id": club_id,
        "expires_at": inv.expires_at,
    }
