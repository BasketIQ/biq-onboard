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

from biq_core.roles import can_assign_role, effective_capabilities

from . import entry_proof, invitations, org
from .auth import (
    _is_break_glass_admin,
    _s2s_secret,
    require_roles_admin_acting,
)

logger = logging.getLogger(__name__)

router = APIRouter()  # ops: S2S + entry proof
staff_router = APIRouter()  # staff-scoped issue endpoint

_MEMBER_ROLES = ("administrator", "sports_director", "coach", "assistant", "coordinator")
_MAX_INVITATION_TTL_DAYS = 14


def _require_s2s(request: Request) -> None:
    secret = _s2s_secret()
    presented = request.headers.get("authorization", "")
    if not secret or not presented.startswith("Bearer ") or not hmac.compare_digest(
        presented[7:], secret
    ):
        raise HTTPException(status_code=401, detail="invalid service token")


def _proof_claims(request: Request) -> dict:
    try:
        return entry_proof.proof_from_request(request)
    except entry_proof.EntryProofError as exc:
        raise HTTPException(status_code=401, detail="invalid entry proof") from exc


def _account_from_proof(request: Request) -> str:
    return _proof_claims(request)["sub"]


def _issuer_still_grants(
    state: invitations.RedeemRead,
    inv: invitations.Invitation,
    roles: list[str],
) -> bool:
    """Live issuer check (R5/B1), inside the redeem fence: the issuer's
    user record and role assignments are read through the transaction, so
    a demotion or membership loss racing the claim aborts it — the invite
    dies when the issuer no longer holds the authority it minted under.
    Platform break-glass issuers are env-bound, not memberships, so they
    are evaluated against the platform gate instead."""
    issuer = inv.issuer_membership_id
    if not issuer:
        return False
    if _is_break_glass_admin(issuer):
        return True
    record = state.get_user(issuer)
    if (
        not record
        or record.get("club_id") != inv.club_id
        or record.get("status") != "active"
    ):
        return False
    from biq_core.roles.models import ROLE_CAPABILITIES, ROLES

    now = _now_iso()
    caps: set[str] = set()
    for assignment in state.list_assignments(issuer, f"club:{inv.club_id}"):
        if not assignment.is_active(now) or assignment.role not in ROLES:
            continue
        caps |= ROLE_CAPABILITIES.get(assignment.role, frozenset())
    return all(can_assign_role(sorted(caps), role) for role in roles)


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


class PreviewBody(BaseModel):
    # The token travels in the body — never in the URL path where access
    # logs and proxies would capture it (R5).
    token: str = Field(default="", max_length=512)


@router.post("/api/ops/invitations/preview")
def invitation_preview(body: PreviewBody, request: Request) -> dict:
    _require_s2s(request)
    _account_from_proof(request)
    if not body.token.strip():
        raise HTTPException(status_code=400, detail="token required")
    store = invitations.get_invitation_store()
    inv = store.get_by_digest(invitations.token_digest(body.token.strip()))
    if inv is None or not inv.is_live(_now_iso()):
        raise HTTPException(status_code=404, detail="invitation not found")
    return _public_invitation(inv)


class RedeemBody(BaseModel):
    token: str = Field(default="", max_length=512)


@router.post("/api/ops/invitations/redeem")
async def invitation_redeem(request: Request) -> dict:
    _require_s2s(request)
    try:
        body = RedeemBody(**(await request.json()))
    except Exception:
        raise HTTPException(status_code=400, detail="invalid body")
    if not body.token.strip():
        raise HTTPException(status_code=400, detail="token required")
    claims = _proof_claims(request)
    account_id = claims["sub"]
    # Verified mailbox carried by the proof — checked inside the fence
    # against the authoritative invitation record.
    proven = (
        str(claims.get("vemail") or "").strip().lower()
        if claims.get("scope") == "verified"
        else ""
    )
    store = invitations.get_invitation_store()
    found = store.get_by_digest(invitations.token_digest(body.token.strip()))
    if found is None:
        raise HTTPException(status_code=404, detail="invitation not found")
    # Deterministic membership id: concurrent claims upsert the same row,
    # the transaction fence picks exactly one winner — no duplicate members.
    membership_id = f"f1f2m_{hashlib.sha256(found.invitation_id.encode()).hexdigest()[:12]}"

    from biq_core.org import User
    from biq_core.roles import RoleAssignment

    def _decide(state: invitations.RedeemRead) -> invitations.RedeemPlan:
        inv = state.invitation
        if inv is None:
            return invitations.RedeemPlan(error=(404, "invitation not found"))
        now = _now_iso()
        if inv.is_live(now):
            # Verified recipient binding (R5/B1): an issuer-targeted mailbox
            # must match the claimant's cryptographically-bound proof —
            # evaluated here so out-of-band invitation edits can't slip
            # between a preflight read and the claim.
            recipient = (inv.recipient_email or "").strip().lower()
            if recipient and proven != recipient:
                return invitations.RedeemPlan(error=(403, "invitation unavailable"))
            # Stored roles must be a strict subset of the assignable set —
            # an out-of-band edit is corrupt data, not a reason to mint a
            # default coach (fail closed, no widening).
            roles = [r for r in inv.proposed_roles if r in _MEMBER_ROLES]
            if not roles or len(roles) != len(inv.proposed_roles):
                return invitations.RedeemPlan(error=(409, "invitation unavailable"))
            if not _issuer_still_grants(state, inv, roles):
                return invitations.RedeemPlan(error=(409, "invitation unavailable"))
            inv.status = "redeemed"
            inv.redeemed_at = now
            inv.redeemed_account_id = account_id
            inv.membership_subject_id = membership_id
            scope = f"club:{inv.club_id}"
            member = User(
                id=membership_id,
                club_id=inv.club_id,
                email="",
                display_name="",
                role=roles[0],
                status="active",
            )
            assignments = [
                RoleAssignment(
                    user_id=membership_id,
                    role=role,
                    scope=scope,
                    id=f"{membership_id}__{role}__{scope}",
                )
                for role in roles
            ]
            return invitations.RedeemPlan(
                invitation=inv,
                member=member,
                assignments=assignments,
                response={
                    "club_id": inv.club_id,
                    "membership_subject_id": membership_id,
                    "roles": roles,
                },
            )
        # Dead invitation. A same-account replay of its own redemption is
        # the single idempotent re-answer — and it re-answers the RECORDED
        # result as a pure read: no member upsert, no role re-grant (B1).
        # A disabled membership must never be reactivated and a removed
        # role never regranted by a stale retry.
        if (
            inv.status == "redeemed"
            and inv.redeemed_account_id == account_id
            and inv.membership_subject_id == membership_id
        ):
            return invitations.RedeemPlan(
                response={
                    "club_id": inv.club_id,
                    "membership_subject_id": membership_id,
                    "roles": list(inv.proposed_roles),
                }
            )
        # Every other dead end: revoked (absolute — even the original
        # claimer cannot replay), expired, or a claim owned by another
        # account.
        return invitations.RedeemPlan(error=(409, "invitation unavailable"))

    try:
        plan = invitations.transact_redeem(
            found.invitation_id,
            _decide,
            store=store,
            registry=org.get_registry(),
            role_registry=org.get_roles(),
        )
    except invitations.InvitationStoreUnavailable as exc:
        raise HTTPException(status_code=503, detail="invitation store unavailable") from exc
    except Exception as exc:
        logger.error("invitation redeem transaction failed: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="registry unavailable") from exc
    if plan.error:
        status, detail = plan.error
        raise HTTPException(status_code=status, detail=detail)
    return plan.response or {}


class ClubCreateBody(BaseModel):
    # Loosely typed: auth (S2S + entry proof) must precede field validation.
    name: str = Field(default="", max_length=200)
    website: str | None = Field(default=None, max_length=512)
    idempotency_key: str | None = Field(default=None, max_length=128)
    email: str | None = Field(default=None, max_length=320)


@router.post("/api/ops/clubs", status_code=201)
def ops_create_club(body: ClubCreateBody, request: Request) -> dict:
    """PC-01 transport — App has already gated the account; this service
    runs the idempotent creation and returns the creator membership.

    Idempotency is actor- AND payload-bound (R5): the deterministic ids
    derive from ``(account_id, key)`` so one account's key can never
    collide with another's, and a replayed key carrying a different
    name/website conflicts (409) instead of silently overwriting the
    club document."""
    _require_s2s(request)
    account_id = _account_from_proof(request)

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
        digest = hashlib.sha256(f"{account_id}|{idem}".encode()).hexdigest()[:12]
        club_id = f"f1f2_{digest}"
        membership_id = f"f1f2m_{digest}"
        try:
            existing = registry.get_club(club_id)
            existing_member = registry.get_user(membership_id)
        except Exception as exc:
            raise HTTPException(status_code=503, detail="registry unavailable") from exc
        if existing is not None:
            same = (
                getattr(existing, "name", "") == name
                and (getattr(existing, "website", None) or "") == website
                and (
                    existing_member is None
                    or getattr(existing_member, "email", "")
                    == (body.email or "").strip().lower()
                )
            )
            if not same:
                raise HTTPException(
                    status_code=409,
                    detail="idempotency key already used with different payload",
                )
            return {
                "club": {"id": club_id, "name": name, "website": website or None},
                "membership_subject_id": membership_id,
                "idempotent": True,
                "teams_seeded": 0,
            }
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


def _bounded_expiry(raw: str | None) -> str:
    """Bounded lifetime (R5): caller-supplied expiry must be a valid
    future ISO timestamp and may not exceed the product ceiling."""
    from datetime import UTC, datetime, timedelta

    now = datetime.now(UTC)
    ceiling = now + timedelta(days=_MAX_INVITATION_TTL_DAYS)
    if not raw or not raw.strip():
        return ceiling.isoformat()
    try:
        parsed = datetime.fromisoformat(raw.strip())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="malformed expires_at") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    if parsed <= now or parsed > ceiling:
        raise HTTPException(
            status_code=422,
            detail=f"expires_at must be within {_MAX_INVITATION_TTL_DAYS} days",
        )
    return parsed.isoformat()


@staff_router.post("/api/admin/clubs/{club_id}/invitations", status_code=201)
def issue_invitation(club_id: str, body: IssueBody, request: Request) -> dict:
    """Issue a tokenized invitation — requires role-management capability
    and the live per-role right to grant every proposed role (R5)."""
    issuer = require_roles_admin_acting(request, club_id)
    roles = [r for r in body.proposed_roles if r in _MEMBER_ROLES]
    if not roles or len(roles) != len({r for r in body.proposed_roles if r}):
        raise HTTPException(status_code=422, detail="unsupported proposed_roles")
    caps = (
        ["platform.admin"]
        if _is_break_glass_admin(issuer)
        else effective_capabilities(issuer, f"club:{club_id}", org.get_roles())
    )
    if not all(can_assign_role(caps, role) for role in roles):
        # A Sports Director cannot mint administrator invites — the grant
        # must never exceed the issuer's live assignable set.
        raise HTTPException(status_code=403, detail="proposed role not assignable")
    inv = invitations.Invitation(
        invitation_id=invitations.new_id(),
        club_id=club_id,
        token_digest="",  # set below
        proposed_roles=roles,
        recipient_email=(body.recipient_email or "").strip().lower(),
        issuer_membership_id=issuer,
        expires_at=_bounded_expiry(body.expires_at),
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


@staff_router.delete("/api/admin/clubs/{club_id}/invitations/{invitation_id}")
def revoke_invitation(club_id: str, invitation_id: str, request: Request) -> dict:
    """Revoke a pending invitation — same role-management gate as issue.
    Revocation is absolute at redeem, including for the original claimer."""
    require_roles_admin_acting(request, club_id)
    store = invitations.get_invitation_store()

    def _revoke(current: invitations.Invitation | None) -> invitations.Invitation | None:
        if current is None or current.club_id != club_id:
            return None
        if current.status == "pending":
            current.status = "revoked"
        return current

    try:
        inv = store.transact(invitation_id, _revoke)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="invitation store unavailable") from exc
    if inv is None:
        raise HTTPException(status_code=404, detail="invitation not found")
    return {"invitation_id": invitation_id, "status": inv.status}
