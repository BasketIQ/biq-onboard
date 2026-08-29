"""Self-service onboarding endpoints (ADDENDUM-07 §6 — auth-then-club).

Step 2 of the two-step onboarding flow, served post-authentication. Unlike
``/api/admin/*`` (back-office CRUD for existing administrators), these
endpoints are for the signed-in user managing their own org state:

- ``POST /api/onboarding/clubs`` — *create my club*. Authorisation enforces
  the §6.3 rule server-side: visible to **new users** (no club membership)
  and to **administrators** of an existing club; a non-admin member of an
  existing club gets **403**. Client-side visibility in the module is
  presentation only.

The creation path carries over W2.1a-ii unchanged: ``Club.website`` is
persisted from the submitted URL and non-``https`` schemes are rejected
with a 422 without any network I/O (ADDENDUM-06 §C2.1/C2.3 rules move with
the endpoint). The creator becomes the new club's first administrator.

S2S channel (ADDENDUM-07 §5.1): when the request carries a valid
``Authorization: Bearer`` shared-secret token (``BIQ_ONBOARD_S2S_SECRET``),
the identity is taken from the ``X-BIQ-Acting-User-Id`` and
``X-BIQ-Acting-Email`` headers instead of the local session. Fail-closed:
bad/missing token ⇒ 401 even if a local session exists. When the secret is
unset, the service behaves exactly as today (standalone sessions only).
"""

from __future__ import annotations

import hmac
import logging
import os

from fastapi import APIRouter, HTTPException, Request

from .. import org
from ..auth import _is_break_glass_admin, session_user
from ..models import ClubSelfCreate

logger = logging.getLogger(__name__)

router = APIRouter()  # mounted at /api/onboarding by app.py

# Roles that may create additional clubs per ADDENDUM-07 §6.3.
ADMIN_ROLES = ("administrator", "sports_director", "super_administrator")


def _s2s_secret() -> str | None:
    """Return the configured S2S secret, or None when S2S is disabled."""
    return os.environ.get("BIQ_ONBOARD_S2S_SECRET") or None


def _current_season_year() -> int:
    """Return the current calendar year as a sensible season fallback."""
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).year


def _resolve_acting_identity(request: Request) -> tuple[str, str]:
    """Resolve the acting user_id and email for the request.

    S2S path: when ``Authorization: Bearer <secret>`` matches the configured
    secret, the identity comes from ``X-BIQ-Acting-User-Id`` and
    ``X-BIQ-Acting-Email`` headers. Fail-closed: bad/missing token ⇒ 401
    even if a local session exists.

    Standalone path: when no secret is configured, falls back to
    ``session_user(request)`` with an empty email (the caller resolves it
    from the registry).
    """
    secret = _s2s_secret()
    if secret:
        auth_header = request.headers.get("authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
            if hmac.compare_digest(token, secret):
                user_id = request.headers.get("x-biq-acting-user-id", "")
                email = request.headers.get("x-biq-acting-email", "")
                if not user_id:
                    raise HTTPException(
                        status_code=403,
                        detail="S2S request missing acting user identity",
                    )
                return user_id, email
            # Bad token: fail-closed even if a session exists.
            raise HTTPException(status_code=401, detail="invalid service token")
        # Secret configured but no bearer header: fail-closed.
        raise HTTPException(status_code=401, detail="invalid service token")

    # Standalone mode — no S2S secret configured.
    return session_user(request), ""


def _caller_memberships(registry, email: str) -> list:
    """Membership rows (club_id != "") for the caller's email."""
    return [u for u in registry.find_users_by_email(email) if u.club_id]


@router.post("/clubs")
def create_my_club(payload: ClubSelfCreate, request: Request) -> dict:
    """Create a club on the caller's behalf; caller becomes its administrator."""
    user_id, asserted_email = _resolve_acting_identity(request)
    registry = org.get_registry()

    # In S2S mode the email may be asserted directly; in standalone mode the
    # email is resolved from the registry (as before).
    caller = registry.get_user(user_id)

    if caller is None or not getattr(caller, "email", ""):
        # Unknown registry user: only the platform break-glass admin may pass
        # (mirrors require_admin's semantics in auth.py). In S2S mode, an
        # unknown user_id with no registry record is a 403 (the asserted
        # identity must exist in the registry for §6.3 evaluation).
        if not _is_break_glass_admin(user_id):
            if _s2s_secret():
                raise HTTPException(
                    status_code=403,
                    detail="asserted identity not found in registry",
                )
            raise HTTPException(status_code=403, detail="not allowed to create clubs")
        caller_email = ""
        caller_display = ""
    else:
        caller_email = caller.email
        caller_display = caller.display_name or ""

    # In S2S mode, prefer the asserted email when the registry record lacks
    # one (e.g. a club-less user created through the shell's register flow).
    if not caller_email and asserted_email:
        caller_email = asserted_email

    # §6.3 server-side authorisation: new users (no membership) and admins of
    # an existing club may create; non-admin members get 403.
    if caller_email:
        memberships = _caller_memberships(registry, caller_email)
        if memberships and not any(m.role in ADMIN_ROLES for m in memberships):
            raise HTTPException(
                status_code=403,
                detail="Solo los administradores pueden crear un club nuevo.",
            )

    # club_name required (ADDENDUM-06 §C2.3): trimmed, ≥2 characters, no
    # generated-name fallback.
    club_name = (payload.name or "").strip()
    if len(club_name) < 2:
        raise HTTPException(
            status_code=422,
            detail="El nombre del club es obligatorio (mínimo 2 caracteres).",
        )

    # W2.1a-ii carried over unchanged: persist the website as Club.website,
    # rejecting non-https without fetching. The client normalises a bare
    # domain to https:// before submitting; the server enforces the scheme.
    website = (payload.website or "").strip()
    if website and not website.startswith("https://"):
        raise HTTPException(
            status_code=422,
            detail="La web del club debe usar https://",
        )

    from biq_core.org import Club, User
    from biq_core.roles import RoleAssignment

    # F2: canonical creation transaction. Deterministic ids when the client
    # supplies an idempotency key, so replaying the same operation writes the
    # same documents and never duplicates the club/member/roles.
    import hashlib

    idem = (payload.idempotency_key or "").strip()
    if idem:
        digest = hashlib.sha256(idem.encode()).hexdigest()[:12]
        club_id = f"f1f2_{digest}"
        membership_id = f"f1f2m_{digest}"
    else:
        club_id = registry.next_club_id()
        membership_id = registry.next_user_id()
    scope = f"club:{club_id}"

    club = Club(
        id=club_id,
        name=club_name,
        status="active",
        created_by=caller_email or None,
        website=website or None,
    )
    membership = User(
        id=membership_id,
        club_id=club_id,
        email=caller_email,
        display_name=caller_display,
        role="administrator",
        status="active",
    )
    assignments = [
        RoleAssignment(
            user_id=membership_id, role="administrator", scope=scope,
            id=f"{membership_id}__administrator__{scope}",
        ),
        RoleAssignment(
            user_id=membership_id, role="sports_director", scope=scope,
            id=f"{membership_id}__sports_director__{scope}",
        ),
    ]
    try:
        registry.create_club_with_creator_tx(
            club, membership, assignments, role_registry=org.get_roles()
        )
    except Exception as exc:
        # The transaction is atomic: nothing persisted. A retry with the same
        # idempotency key reuses the same ids; a retry without one starts clean.
        raise HTTPException(
            status_code=503,
            detail="No se pudo crear el club",
        ) from exc

    # F12: Seed the default team catalog for the new club. This mirrors
    # what onboard_club() does — build_team_catalog() generates every
    # category × gender combination (with birth-year cohorts) for a season.
    # Club creation never fails or rolls back because team seeding fails:
    # the club/creator are already persisted atomically above. If a team
    # write fails, log it clearly (same discipline as the theme-job enqueue
    # failure below — visible, not swallowed).
    #
    # upsert_team() uses merge semantics (Firestore set(merge=True) /
    # Memory _merge_partial), so re-seeding with the same IDs on an
    # idempotent replay is safe — it relabels docs in place.
    teams_seeded = 0
    try:
        from biq_core.org.catalog import build_team_catalog
        from biq_core.org import Team

        season_str = registry.get_season()
        season_year = int((season_str or "").split("/")[0]) if season_str else _current_season_year()
        catalog_dicts = build_team_catalog(club_id, season_year)
        for t in catalog_dicts:
            registry.upsert_team(Team(
                id=t["id"],
                club_id=club_id,
                name=t["name"],
                category=t.get("category"),
                gender=t.get("gender"),
                label=t.get("label"),
            ))
        teams_seeded = len(catalog_dicts)
    except Exception as exc:
        logger.error(
            "F12 team-catalog seeding failed for club %s: %s (club creation succeeded)",
            club_id, exc, exc_info=True,
        )

    # B9/B10: if website present, enqueue theme generation asynchronously.
    # Club creation never fails or rolls back because optional generation
    # cannot enqueue/complete.
    #
    # C3: Use the org_registry (not the role_registry) for merge_club_fields.
    # Do not swallow orchestration defects with a broad except:pass —
    # persist a visible failed job when enqueue fails.
    if website:
        from .theme import _enqueue_generation_task, _create_lease
        import time as _time
        from datetime import datetime, timezone

        lease_id = f"lease-{club_id}-{int(_time.time())}"
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        theme_job = {
            "status": "pending",
            "sourceUrl": website,
            "requestedAt": now,
            "finishedAt": None,
            "attempts": 1,
            "verdict": None,
            "notifiedAt": None,
            "lease": _create_lease(lease_id),
        }
        # Persist pending state BEFORE dispatch (B10: worker cannot race absent state)
        registry.merge_club_fields(club_id, {"theme_job": theme_job})

        # Enqueue after state is persisted. Enqueue failure → club succeeds,
        # persisted recoverable job failure (B9). Do NOT swallow this with a
        # broad except:pass (C3).
        try:
            _enqueue_generation_task(club_id, website, lease_id)
        except Exception as exc:
            theme_job["status"] = "failed"
            theme_job["finishedAt"] = now
            theme_job["reason"] = f"enqueue failed after club creation: {exc}"
            registry.merge_club_fields(club_id, {"theme_job": theme_job})

    return {
        "ok": True,
        "club": {"id": club_id, "name": club_name, "website": website or None},
        "membership_user_id": membership_id,
        "idempotent": bool(idem),
        "teams_seeded": teams_seeded,
    }
