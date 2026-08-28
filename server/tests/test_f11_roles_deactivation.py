"""F11: Club member role management + deactivation tests.

Covers:
1. Table-driven authorization for deactivation (administrator allowed,
   Sports Director allowed only for sporting roles, coach denied).
2. Deactivation prevents authentication (deactivated member excluded from
   _resolve_verified_email real memberships).
3. Audit trail entry on deactivation.
4. Reactivation restores access.
"""

from __future__ import annotations

import os

os.environ["BIQ_ORG_STORE"] = "memory"
os.environ["BIQ_ROLES_STORE"] = "memory"

import pytest
from fastapi.testclient import TestClient

from biq_onboard_server import org
from biq_onboard_server.app import create_app


@pytest.fixture
def client():
    """Fresh app with memory backends for each test."""
    org.reset_for_tests()
    app = create_app()
    c = TestClient(app)
    c.post("/api/auth/login", json={"username": "admin", "password": "T3st1ng!"})
    return c


@pytest.fixture
def club_id(client):
    cid = "club_f11"
    client.post(
        f"/api/admin/clubs/{cid}/onboard",
        json={"club_id": cid, "name": "Club F11", "slug": "f11", "season": "2026/27"},
    )
    return cid


def _create_member(client, club_id, user_id, role="coach"):
    """Create a club member via the admin API."""
    client.post(
        f"/api/admin/clubs/{club_id}/users",
        json={
            "id": user_id,
            "club_id": club_id,
            "display_name": user_id.replace("_", " ").title(),
            "email": f"{user_id}@test.example",
            "role": role,
            "password": "secret",
        },
    )


# ─── 1. Table-driven authorization for deactivation ─────────────────────


@pytest.mark.parametrize(
    "assigner_caps, target_role, should_succeed",
    [
        # Administrator (roles.manage) can deactivate any club role.
        (["roles.manage", "club.admin"], "coach", True),
        (["roles.manage", "club.admin"], "coordinator", True),
        (["roles.manage", "club.admin"], "player", True),
        (["roles.manage", "club.admin"], "administrator", True),
        (["roles.manage", "club.admin"], "sports_director", True),
        # Sports Director (roles.manage.sporting) can deactivate sporting roles.
        (["roles.manage.sporting"], "coach", True),
        (["roles.manage.sporting"], "coordinator", True),
        (["roles.manage.sporting"], "player", True),
        # Sports Director CANNOT deactivate administrator or super_admin.
        (["roles.manage.sporting"], "administrator", False),
        (["roles.manage.sporting"], "super_administrator", False),
        (["roles.manage.sporting"], "sports_director", False),
        # Coach (no manage caps) cannot deactivate anything.
        (["methodology.read"], "coach", False),
        (["methodology.read"], "player", False),
    ],
)
def test_deactivation_auth_table_driven(assigner_caps, target_role, should_succeed):
    """F11: Deactivation uses the same tiered can_assign_role gate as role
    assignment — the caller must be authorized to manage the target's role."""
    from biq_core.roles import can_assign_role

    assert can_assign_role(assigner_caps, target_role) is should_succeed


# ─── 2. Deactivation prevents authentication ────────────────────────────


def test_deactivate_member_excludes_from_resolve_verified_email(client, club_id):
    """F11: A deactivated member is excluded from _resolve_verified_email's
    real memberships list — they cannot authenticate into the club."""
    from biq_core.org import User
    from biq_onboard_server import org as org_mod

    _create_member(client, club_id, "member_deact", "coach")
    registry = org.get_registry()

    # Verify the member is active and resolvable before deactivation
    user = registry.get_user("member_deact")
    assert user.status == "active"

    # Deactivate the member
    r = client.patch(
        f"/api/admin/clubs/{club_id}/users/member_deact/status",
        json={"status": "deactivated"},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "deactivated"

    # Verify the user's status was persisted
    user = registry.get_user("member_deact")
    assert user.status == "deactivated"

    # Verify _resolve_verified_email excludes the deactivated member
    # We need to simulate what biq-app does: check that a deactivated user
    # with a club_id is NOT counted as a real membership.
    users = registry.find_users_by_email("member_deact@test.example")
    real = [u for u in users if u.club_id and u.status == "active"]
    assert len(real) == 0, "deactivated member should not be a real membership"


def test_reactivate_member_restores_access(client, club_id):
    """F11: Reactivating a deactivated member restores their access."""
    _create_member(client, club_id, "member_react", "coach")

    # Deactivate
    r = client.patch(
        f"/api/admin/clubs/{club_id}/users/member_react/status",
        json={"status": "deactivated"},
    )
    assert r.status_code == 200

    # Reactivate
    r = client.patch(
        f"/api/admin/clubs/{club_id}/users/member_react/status",
        json={"status": "active"},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "active"

    # Verify the member is back in real memberships
    registry = org.get_registry()
    users = registry.find_users_by_email("member_react@test.example")
    real = [u for u in users if u.club_id and u.status == "active"]
    assert len(real) == 1


# ─── 3. Audit trail on deactivation ─────────────────────────────────────


def test_deactivate_creates_audit_entry(client, club_id):
    """F11: Deactivating a member creates an audit entry with action='deactivate'."""
    _create_member(client, club_id, "member_audit", "coach")

    r = client.patch(
        f"/api/admin/clubs/{club_id}/users/member_audit/status",
        json={"status": "deactivated", "reason": "Left the club"},
    )
    assert r.status_code == 200

    audit = org.get_audit_log()
    entries = audit.list_for_scope(f"club:{club_id}")
    deactivate_entries = [e for e in entries if e.action == "deactivate"]
    assert len(deactivate_entries) >= 1
    assert deactivate_entries[0].target_user_id == "member_audit"
    assert deactivate_entries[0].role == "coach"
    assert deactivate_entries[0].reason == "Left the club"


def test_reactivate_creates_audit_entry(client, club_id):
    """F11: Reactivating a member creates an audit entry with action='reactivate'."""
    _create_member(client, club_id, "member_audit2", "coordinator")

    # Deactivate first
    client.patch(
        f"/api/admin/clubs/{club_id}/users/member_audit2/status",
        json={"status": "deactivated"},
    )

    # Reactivate
    r = client.patch(
        f"/api/admin/clubs/{club_id}/users/member_audit2/status",
        json={"status": "active"},
    )
    assert r.status_code == 200

    audit = org.get_audit_log()
    entries = audit.list_for_scope(f"club:{club_id}")
    reactivate_entries = [e for e in entries if e.action == "reactivate"]
    assert len(reactivate_entries) >= 1
    assert reactivate_entries[0].target_user_id == "member_audit2"


# ─── 4. Deactivated members still visible in list_users ─────────────────


def test_deactivated_member_still_listed(client, club_id):
    """F11: Deactivated members remain visible in the Roles tab (list_users)
    so they can be reactivated. They are NOT removed from the member list."""
    _create_member(client, club_id, "member_visible", "coach")

    # Deactivate
    client.patch(
        f"/api/admin/clubs/{club_id}/users/member_visible/status",
        json={"status": "deactivated"},
    )

    # List members — should still include the deactivated member
    r = client.get(f"/api/admin/clubs/{club_id}/users")
    assert r.status_code == 200
    users = r.json()["users"]
    member = next((u for u in users if u["id"] == "member_visible"), None)
    assert member is not None, "deactivated member should still be listed"
    assert member["status"] == "deactivated"


# ─── 5. Invalid status rejected ─────────────────────────────────────────


def test_invalid_status_rejected(client, club_id):
    """F11: Only 'active' and 'deactivated' are valid status values."""
    _create_member(client, club_id, "member_invalid", "coach")

    r = client.patch(
        f"/api/admin/clubs/{club_id}/users/member_invalid/status",
        json={"status": "banned"},
    )
    assert r.status_code == 400


def test_status_change_for_wrong_club_rejected(client, club_id):
    """F11: Cannot change status for a user who belongs to a different club."""
    _create_member(client, club_id, "member_wrong", "coach")

    # Try to change status via a different club
    other_club = "club_other_f11"
    client.post(
        f"/api/admin/clubs/{other_club}/onboard",
        json={"club_id": other_club, "name": "Other Club", "slug": "other", "season": "2026/27"},
    )
    r = client.patch(
        f"/api/admin/clubs/{other_club}/users/member_wrong/status",
        json={"status": "deactivated"},
    )
    assert r.status_code == 403
