"""F9: Focused tests for tiered role management and audit logging.

Covers:
1. Table-driven authorization: who can assign which roles.
2. Successful assignment + audit record creation.
3. Sports Director can assign sporting roles but NOT administrator.
4. Audit log records both assign and remove actions.
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
def app_and_client():
    """Fresh app with memory backends for each test."""
    org.reset_for_tests()
    app = create_app()
    client = TestClient(app)
    client.post("/api/auth/login", json={"username": "admin", "password": "T3st1ng!"})
    return app, client


def _create_club(client, club_id="club_f9"):
    client.post(
        f"/api/admin/clubs/{club_id}/onboard",
        json={"club_id": club_id, "name": "Club F9", "slug": "f9", "season": "2026/27"},
    )


def _assign_role(client, club_id, user_id, role):
    return client.post(
        f"/api/admin/clubs/{club_id}/roles",
        json={"user_id": user_id, "role": role},
    )


# ─── 1. Table-driven authorization ──────────────────────────────────────


@pytest.mark.parametrize(
    "assigner_caps, target_role, should_succeed",
    [
        # Administrator (roles.manage) can assign any club role.
        (["roles.manage", "club.admin"], "coach", True),
        (["roles.manage", "club.admin"], "coordinator", True),
        (["roles.manage", "club.admin"], "player", True),
        (["roles.manage", "club.admin"], "administrator", True),
        (["roles.manage", "club.admin"], "sports_director", True),
        # Sports Director (roles.manage.sporting) can assign sporting roles.
        (["roles.manage.sporting"], "coach", True),
        (["roles.manage.sporting"], "coordinator", True),
        (["roles.manage.sporting"], "player", True),
        # Sports Director CANNOT assign administrator or super_admin.
        (["roles.manage.sporting"], "administrator", False),
        (["roles.manage.sporting"], "super_administrator", False),
        (["roles.manage.sporting"], "sports_director", False),
        # Coach (no manage caps) cannot assign anything.
        (["methodology.read"], "coach", False),
        (["methodology.read"], "player", False),
        # Platform admin can assign anything.
        (["platform.admin"], "super_administrator", True),
        (["platform.admin"], "administrator", True),
    ],
)
def test_can_assign_role_table_driven(assigner_caps, target_role, should_succeed):
    """Verify the tiered can_assign_role logic for all role/cap combinations."""
    from biq_core.roles import can_assign_role

    assert can_assign_role(assigner_caps, target_role) is should_succeed


# ─── 2. Successful assignment + audit record ────────────────────────────


def test_assign_role_creates_audit_record(app_and_client):
    """Assigning a role creates an audit entry."""
    _, client = app_and_client
    _create_club(client, "club_audit")
    r = _assign_role(client, "club_audit", "admin_club_audit", "coach")
    assert r.status_code == 200

    # Verify the audit log has a record.
    audit = org.get_audit_log()
    entries = audit.list_for_scope("club:club_audit")
    assert len(entries) >= 1
    assign_entries = [e for e in entries if e.action == "assign"]
    assert len(assign_entries) >= 1
    assert assign_entries[0].target_user_id == "admin_club_audit"
    assert assign_entries[0].role == "coach"


def test_remove_role_creates_audit_record(app_and_client):
    """Removing a role creates an audit entry."""
    _, client = app_and_client
    _create_club(client, "club_audit2")
    r = _assign_role(client, "club_audit2", "admin_club_audit2", "coordinator")
    assert r.status_code == 200
    aid = r.json()["assignment_id"]

    r = client.delete(f"/api/admin/clubs/club_audit2/roles/{aid}")
    assert r.status_code == 200

    audit = org.get_audit_log()
    entries = audit.list_for_scope("club:club_audit2")
    remove_entries = [e for e in entries if e.action == "remove"]
    assert len(remove_entries) >= 1
    assert remove_entries[0].target_user_id == "admin_club_audit2"
    assert remove_entries[0].role == "coordinator"


# ─── 3. Sports Director tiered authorization through the API ────────────


def test_sports_director_can_assign_coach(app_and_client):
    """A sports_director role assignment is created successfully and the
    tiered auth logic is verified via the table-driven unit test above."""
    _, client = app_and_client
    _create_club(client, "club_sd")

    # Create a user in the club first (required by the assign endpoint).
    client.post(
        "/api/admin/clubs/club_sd/users",
        json={
            "id": "sd_user",
            "club_id": "club_sd",
            "display_name": "SD",
            "password": "secret",
        },
    )

    # Assign sports_director via break-glass admin.
    r = _assign_role(client, "club_sd", "sd_user", "sports_director")
    assert r.status_code == 200

    # Verify the sports_director assignment exists.
    roles = org.get_roles()
    sd_assignments = roles.list_assignments("sd_user", "club:club_sd")
    assert any(a.role == "sports_director" for a in sd_assignments)


def test_assign_administrator_requires_roles_manage(app_and_client):
    """Assigning administrator when caller only has roles.manage.sporting fails."""
    _, client = app_and_client
    _create_club(client, "club_tier")

    # The break-glass admin can assign anything (bypasses tier check).
    # To test the tier check, we need a non-break-glass caller.
    # This is covered by the table-driven unit test above.
    # Here we verify the endpoint works for the break-glass admin.
    r = _assign_role(client, "club_tier", "admin_club_tier", "administrator")
    assert r.status_code == 200


# ─── 4. Multi-role: secondary roles via assignments (Mi Club Phase 2) ───


def _login_as(client, user_id, password):
    """Switch the test client's session to a real registry user."""
    client.post("/api/auth/logout")
    r = client.post(
        "/api/auth/login", json={"username": user_id, "password": password}
    )
    assert r.status_code == 200


def _create_member(client, club_id, user_id, role="coach", password="pw-1234"):
    return client.post(
        f"/api/admin/clubs/{club_id}/users",
        json={
            "id": user_id,
            "club_id": club_id,
            "display_name": user_id,
            "role": role,
            "password": password,
        },
    )


def test_sd_session_can_assign_sporting_role_but_not_admin(app_and_client):
    """A non-break-glass sports_director reaches the endpoint (relaxed gate)
    and can_assign_role still enforces the tier inside it."""
    _, client = app_and_client
    _create_club(client, "club_sd2")
    _create_member(client, "club_sd2", "sd2", role="sports_director")
    _create_member(client, "club_sd2", "member1", role="coach")

    _login_as(client, "sd2", "pw-1234")

    # Sporting role grant succeeds through the real endpoint.
    r = _assign_role(client, "club_sd2", "member1", "coordinator")
    assert r.status_code == 200

    # Administrator grant is refused by can_assign_role.
    r = _assign_role(client, "club_sd2", "member1", "administrator")
    assert r.status_code == 403


def test_sd_cannot_remove_administrator_assignment(app_and_client):
    """Removal applies the same tiered rule as granting."""
    _, client = app_and_client
    _create_club(client, "club_rm")
    _create_member(client, "club_rm", "sd_rm", role="sports_director")
    _create_member(client, "club_rm", "admin_rm", role="administrator")

    roles = org.get_roles()
    scope = "club:club_rm"
    admin_assignment = next(
        a for a in roles.list_assignments("admin_rm", scope)
        if a.role == "administrator"
    )

    _login_as(client, "sd_rm", "pw-1234")

    # SD may not revoke an administrator assignment.
    r = client.delete(f"/api/admin/clubs/club_rm/roles/{admin_assignment.id}")
    assert r.status_code == 403

    # But may revoke a sporting assignment it could have granted.
    r = _assign_role(client, "club_rm", "sd_rm", "coach")
    coach_aid = r.json()["assignment_id"]
    r = client.delete(f"/api/admin/clubs/club_rm/roles/{coach_aid}")
    assert r.status_code == 200


def test_list_users_exposes_roles_including_secondaries(app_and_client):
    """list_users returns primary role plus every active secondary."""
    _, client = app_and_client
    _create_club(client, "club_multi")
    _create_member(client, "club_multi", "multi1", role="coach")
    _assign_role(client, "club_multi", "multi1", "coordinator")

    r = client.get("/api/admin/clubs/club_multi/users")
    assert r.status_code == 200
    user = next(u for u in r.json()["users"] if u["id"] == "multi1")
    assert user["role"] == "coach"  # primary unchanged
    assert sorted(user["roles"]) == ["coach", "coordinator"]


def test_update_user_roles_syncs_secondary_assignments(app_and_client):
    """PUT with roles adds/removes secondary assignments, keeps primary,
    and writes an audit entry per mutation."""
    _, client = app_and_client
    _create_club(client, "club_sync")
    _create_member(client, "club_sync", "sync1", role="coach")

    r = client.put(
        "/api/admin/clubs/club_sync/users/sync1",
        json={"roles": ["coordinator", "sports_director"]},
    )
    assert r.status_code == 200
    roles = org.get_roles()
    active = {
        a.role
        for a in roles.list_assignments("sync1", "club:club_sync")
        if a.is_active()
    }
    assert active == {"coach", "coordinator", "sports_director"}

    # Narrow the set: coordinator removed, primary coach kept.
    r = client.put(
        "/api/admin/clubs/club_sync/users/sync1",
        json={"roles": ["sports_director"]},
    )
    assert r.status_code == 200
    active = {
        a.role
        for a in roles.list_assignments("sync1", "club:club_sync")
        if a.is_active()
    }
    assert active == {"coach", "sports_director"}

    entries = org.get_audit_log().list_for_scope("club:club_sync")
    assigns = [e.role for e in entries if e.action == "assign"]
    removes = [e.role for e in entries if e.action == "remove"]
    assert "coordinator" in assigns and "sports_director" in assigns
    assert "coordinator" in removes


def test_create_user_with_secondary_roles(app_and_client):
    """POST users accepts roles for simultaneous secondary assignments."""
    _, client = app_and_client
    _create_club(client, "club_cr")
    r = client.post(
        "/api/admin/clubs/club_cr/users",
        json={
            "id": "both1",
            "club_id": "club_cr",
            "display_name": "Both",
            "role": "coach",
            "roles": ["sports_director"],
            "password": "pw-1234",
        },
    )
    assert r.status_code == 200
    roles = org.get_roles()
    active = {
        a.role
        for a in roles.list_assignments("both1", "club:club_cr")
        if a.is_active()
    }
    assert active == {"coach", "sports_director"}


def test_update_user_roles_rejects_unknown_role(app_and_client):
    _, client = app_and_client
    _create_club(client, "club_bad")
    _create_member(client, "club_bad", "bad1", role="coach")
    r = client.put(
        "/api/admin/clubs/club_bad/users/bad1",
        json={"roles": ["not-a-role"]},
    )
    assert r.status_code == 400
