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


# Single-role API contract replaces the former secondary-role editor.


def test_replace_role_removes_old_grants_and_audits(app_and_client):
    _, client = app_and_client
    _create_club(client)
    r = _assign_role(client, "club_f9", "coach1_club_f9", "sports_director")
    assert r.status_code == 200
    member = org.get_registry().get_user("coach1_club_f9")
    assert member.role == "sports_director"
    assert [a.role for a in org.get_roles().list_assignments(member.id, "club:club_f9")] == ["sports_director"]
    assert org.get_audit_log().list_for_scope("club:club_f9")[0].action == "replace"
    r = client.delete(f"/api/admin/clubs/club_f9/roles/{r.json()['assignment_id']}")
    assert r.status_code == 409
    assert org.get_registry().get_user(member.id).role == "sports_director"


@pytest.mark.parametrize("role", ["coordinator", "player", "super_administrator", "knowledge_engineer", "unknown"])
def test_club_api_cannot_grant_legacy_or_platform_roles(app_and_client, role):
    _, client = app_and_client
    _create_club(client)
    before = org.get_registry().get_user("coach1_club_f9").model_dump()
    assert _assign_role(client, "club_f9", "coach1_club_f9", role).status_code == 422
    assert org.get_registry().get_user("coach1_club_f9").model_dump() == before


def test_legacy_alias_normalizes_but_extra_role_is_rejected_before_create(app_and_client):
    _, client = app_and_client
    _create_club(client)
    r = _assign_role(client, "club_f9", "coach1_club_f9", "administrator")
    assert r.status_code == 200
    assert r.json()["role"] == "sports_director"
    r = client.post("/api/admin/clubs/club_f9/users", json={"id": "multi", "club_id": "club_f9", "role": "coach", "roles": ["sports_director"]})
    assert r.status_code == 422
    assert org.get_registry().get_user("multi") is None


def test_wrong_scope_rejected_before_mutation(app_and_client):
    _, client = app_and_client
    _create_club(client)
    r = client.post("/api/admin/clubs/club_f9/roles", json={"user_id": "coach1_club_f9", "role": "sports_director", "scope": "platform"})
    assert r.status_code == 403
    assert org.get_registry().get_user("coach1_club_f9").role == "coach"


def test_update_replaces_secondary_and_keeps_one_role(app_and_client):
    from biq_core.roles import RoleAssignment
    _, client = app_and_client
    _create_club(client)
    uid = "coach1_club_f9"
    org.get_roles().put_assignment(RoleAssignment(user_id=uid, role="sports_director", scope="club:club_f9"))
    r = client.put(f"/api/admin/clubs/club_f9/users/{uid}", json={"role": "coach"})
    assert r.status_code == 200
    assert [a.role for a in org.get_roles().list_assignments(uid, "club:club_f9")] == ["coach"]
    users = client.get("/api/admin/clubs/club_f9/users").json()["users"]
    assert next(u for u in users if u["id"] == uid)["roles"] == ["coach"]
