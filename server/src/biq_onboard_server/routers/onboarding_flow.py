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
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from .. import org
from ..auth import _is_break_glass_admin, session_user
from ..models import ClubSelfCreate

router = APIRouter()  # mounted at /api/onboarding by app.py

# Roles that may create additional clubs per ADDENDUM-07 §6.3.
ADMIN_ROLES = ("administrator", "sports_director", "super_administrator")


def _caller_memberships(registry, email: str) -> list:
    """Membership rows (club_id != "") for the caller's email."""
    return [u for u in registry.find_users_by_email(email) if u.club_id]


@router.post("/clubs")
def create_my_club(payload: ClubSelfCreate, request: Request) -> dict:
    """Create a club on the caller's behalf; caller becomes its administrator."""
    user_id = session_user(request)
    registry = org.get_registry()
    caller = registry.get_user(user_id)

    if caller is None or not getattr(caller, "email", ""):
        # Unknown registry user: only the platform break-glass admin may pass
        # (mirrors require_admin's semantics in auth.py).
        if not _is_break_glass_admin(user_id):
            raise HTTPException(status_code=403, detail="not allowed to create clubs")
        caller_email = ""
        caller_display = ""
    else:
        caller_email = caller.email
        caller_display = caller.display_name or ""

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

    club_id = registry.next_club_id()
    from biq_core.org import Club

    registry.upsert_club(
        Club(
            id=club_id,
            name=club_name,
            status="active",
            created_by=caller_email or None,
            website=website or None,
        )
    )

    # Memberships are one User row per club (same model as join approval):
    # the creator becomes the first administrator of the new club.
    membership_id = registry.next_user_id()
    from biq_core.org import User

    membership = User(
        id=membership_id,
        club_id=club_id,
        email=caller_email,
        display_name=caller_display,
        role="administrator",
        status="active",
    )
    registry.upsert_user(membership)

    # Assign the administrator role in the roles registry (best-effort, same
    # as the rest of the codebase; the user record is the source of truth).
    try:
        from biq_core.roles import RoleAssignment, get_role_registry

        get_role_registry().put_assignment(
            RoleAssignment(
                user_id=membership_id, role="administrator", scope=f"club:{club_id}"
            )
        )
    except Exception:
        pass

    return {
        "ok": True,
        "club": {"id": club_id, "name": club_name, "website": website or None},
        "membership_user_id": membership_id,
    }
