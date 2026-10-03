"""Mi Club Phase 4: PATCH /api/admin/clubs/{id}/users/{uid}/status tests.

Deactivate/reactivate a member — F9-tiered (can_assign_role on the target's
primary role), audited, S2S-aware like the rest of the member surface.
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
    org.reset_for_tests()
    app = create_app()
    client = TestClient(app)
    client.post("/api/auth/login", json={"username": "admin", "password": "T3st1ng!"})
    return app, client


def _create_club(client, club_id="club_p4"):
    client.post(
        f"/api/admin/clubs/{club_id}/onboard",
        json={"club_id": club_id, "name": "Club P4", "slug": "p4", "season": "2026/27"},
    )


def _create_member(client, club_id, user_id, role="coach", password="pw-1234"):
    return client.post(
        f"/api/admin/clubs/{club_id}/users",
        json={"id": user_id, "club_id": club_id, "display_name": user_id,
              "role": role, "password": password},
    )


def test_deactivate_and_reactivate(app_and_client):
    _, client = app_and_client
    _create_club(client, "club_p4a")
    _create_member(client, "club_p4a", "m1")

    r = client.patch("/api/admin/clubs/club_p4a/users/m1/status",
                     json={"status": "deactivated"})
    assert r.status_code == 200
    assert r.json()["status"] == "deactivated"

    reg = org.get_registry()
    u = reg.get_user("m1")
    assert u.status == "deactivated"

    r = client.patch("/api/admin/clubs/club_p4a/users/m1/status",
                     json={"status": "active"})
    assert r.status_code == 200
    u = reg.get_user("m1")
    assert u.status == "active"


def test_status_audit_entries(app_and_client):
    _, client = app_and_client
    _create_club(client, "club_p4b")
    _create_member(client, "club_p4b", "m1")
    client.patch("/api/admin/clubs/club_p4b/users/m1/status", json={"status": "deactivated"})
    client.patch("/api/admin/clubs/club_p4b/users/m1/status", json={"status": "active"})

    audits = org.get_audit_log().list_for_scope("club:club_p4b")
    actions = [a.action for a in audits]
    assert "deactivate" in actions and "reactivate" in actions


def test_status_invalid_value_400(app_and_client):
    _, client = app_and_client
    _create_club(client, "club_p4c")
    _create_member(client, "club_p4c", "m1")
    r = client.patch("/api/admin/clubs/club_p4c/users/m1/status",
                     json={"status": "banned"})
    assert r.status_code == 400


def test_status_missing_user_404(app_and_client):
    _, client = app_and_client
    _create_club(client, "club_p4d")
    r = client.patch("/api/admin/clubs/club_p4d/users/ghost/status",
                     json={"status": "deactivated"})
    assert r.status_code == 404


def test_status_wrong_club_403(app_and_client):
    _, client = app_and_client
    _create_club(client, "club_p4e")
    _create_club(client, "club_p4e2")
    _create_member(client, "club_p4e2", "outsider_member")
    r = client.patch("/api/admin/clubs/club_p4e/users/outsider_member/status",
                     json={"status": "deactivated"})
    assert r.status_code == 403


def test_status_unauthenticated_401(app_and_client):
    _, client = app_and_client
    client.post("/api/auth/logout")
    r = client.patch("/api/admin/clubs/club_p4/users/m1/status",
                     json={"status": "deactivated"})
    assert r.status_code == 401


def test_status_self_change_rejected(app_and_client):
    _, client = app_and_client
    _create_club(client, "club_p4f")
    _create_member(client, "club_p4f", "selfadmin", role="administrator")
    client.post("/api/auth/logout")
    client.post("/api/auth/login", json={"username": "selfadmin", "password": "pw-1234"})
    r = client.patch("/api/admin/clubs/club_p4f/users/selfadmin/status",
                     json={"status": "deactivated"})
    assert r.status_code == 400
    assert "own status" in r.json()["detail"]


def test_status_sd_cannot_deactivate_administrator(app_and_client):
    """F9 tiered: SD's roles.manage.sporting doesn't cover administrator."""
    _, client = app_and_client
    _create_club(client, "club_p4g")
    _create_member(client, "club_p4g", "sd", role="sports_director")
    _create_member(client, "club_p4g", "boss", role="administrator")
    client.post("/api/auth/logout")
    client.post("/api/auth/login", json={"username": "sd", "password": "pw-1234"})
    r = client.patch("/api/admin/clubs/club_p4g/users/boss/status",
                     json={"status": "deactivated"})
    assert r.status_code == 403
    assert "insufficient privileges" in r.json()["detail"]


def test_status_sd_can_deactivate_coach(app_and_client):
    _, client = app_and_client
    _create_club(client, "club_p4h")
    _create_member(client, "club_p4h", "sd", role="sports_director")
    _create_member(client, "club_p4h", "coach1", role="coach")
    client.post("/api/auth/logout")
    client.post("/api/auth/login", json={"username": "sd", "password": "pw-1234"})
    r = client.patch("/api/admin/clubs/club_p4h/users/coach1/status",
                     json={"status": "deactivated"})
    assert r.status_code == 200


def test_status_plain_member_forbidden(app_and_client):
    _, client = app_and_client
    _create_club(client, "club_p4i")
    _create_member(client, "club_p4i", "plain")
    _create_member(client, "club_p4i", "victim")
    client.post("/api/auth/logout")
    client.post("/api/auth/login", json={"username": "plain", "password": "pw-1234"})
    r = client.patch("/api/admin/clubs/club_p4i/users/victim/status",
                     json={"status": "deactivated"})
    assert r.status_code == 403


def test_status_idempotent_noop(app_and_client):
    """Patching to the current status is a 200 no-op (no audit noise)."""
    _, client = app_and_client
    _create_club(client, "club_p4j")
    _create_member(client, "club_p4j", "m1")
    before = len(org.get_audit_log().list_for_scope("club:club_p4j"))
    r = client.patch("/api/admin/clubs/club_p4j/users/m1/status",
                     json={"status": "active"})
    assert r.status_code == 200
    after = len(org.get_audit_log().list_for_scope("club:club_p4j"))
    assert after == before


def test_update_preserves_deactivated_status(app_and_client):
    """Regression: a generic PUT user update on a deactivated member must
    never implicitly reactivate — only the audited PATCH status endpoint
    may change status (2026-09-30 A3 follow-up)."""
    _, client = app_and_client
    _create_club(client, "club_p4l")
    _create_member(client, "club_p4l", "m1", role="coach")
    client.patch("/api/admin/clubs/club_p4l/users/m1/status",
                 json={"status": "deactivated"})
    reg = org.get_registry()
    assert reg.get_user("m1").status == "deactivated"

    # Authorized admin edits name + role — the intended fields change,
    # but the member must stay deactivated through the registry round-trip.
    r = client.put("/api/admin/clubs/club_p4l/users/m1",
                   json={"display_name": "Renamed Coach", "role": "coordinator"})
    assert r.status_code == 200
    u = reg.get_user("m1")
    assert u.display_name == "Renamed Coach"
    assert u.role == "coordinator"
    assert u.status == "deactivated", (
        "generic PUT update implicitly reactivated a deactivated member"
    )


def test_update_preserves_apple_sub(app_and_client):
    """Same defect class: the reconstructed User must carry apple_sub —
    an admin field edit must never unlink a bound Apple identity.
    Forward-compatible: biq-core <0.23 does not model the field, so the
    carry is a no-op there and the assertion only applies when present."""
    from biq_core.org.models import User as _User
    if "apple_sub" not in _User.model_fields:
        pytest.skip("pinned biq-core does not model User.apple_sub")
    _, client = app_and_client
    _create_club(client, "club_p4m")
    _create_member(client, "club_p4m", "m1", role="coach")
    reg = org.get_registry()
    m1 = reg.get_user("m1")
    reg.upsert_user(m1.model_copy(update={"apple_sub": "001122.apple.sub"}))

    r = client.put("/api/admin/clubs/club_p4m/users/m1",
                   json={"display_name": "Apple Coach"})
    assert r.status_code == 200
    u = reg.get_user("m1")
    assert u.display_name == "Apple Coach"
    assert u.apple_sub == "001122.apple.sub", (
        "generic PUT update silently unlinked the member's apple_sub"
    )


def test_explicit_status_endpoint_still_governs(app_and_client):
    """After a field edit on a deactivated member, only PATCH /status can
    reactivate — and the earlier edits survive."""
    _, client = app_and_client
    _create_club(client, "club_p4n")
    _create_member(client, "club_p4n", "m1", role="coach")
    client.patch("/api/admin/clubs/club_p4n/users/m1/status",
                 json={"status": "deactivated"})
    client.put("/api/admin/clubs/club_p4n/users/m1",
               json={"display_name": "Still Inactive"})
    reg = org.get_registry()
    assert reg.get_user("m1").status == "deactivated"

    r = client.patch("/api/admin/clubs/club_p4n/users/m1/status",
                     json={"status": "active"})
    assert r.status_code == 200
    u = reg.get_user("m1")
    assert u.status == "active"
    assert u.display_name == "Still Inactive"

    audits = org.get_audit_log().list_for_scope("club:club_p4n")
    assert "reactivate" in [a.action for a in audits]


def test_sd_cannot_use_generic_update_path(app_and_client):
    """Boundary preserved: the generic PUT update stays administrator-
    gated (``roles.manage``/``club.admin``) — a Sports Director holding
    only ``roles.manage.sporting`` gets 403 and therefore can never reach
    the implicit-reactivation path at all."""
    _, client = app_and_client
    _create_club(client, "club_p4o")
    _create_member(client, "club_p4o", "sd", role="sports_director")
    _create_member(client, "club_p4o", "coach1", role="coach")
    client.patch("/api/admin/clubs/club_p4o/users/coach1/status",
                 json={"status": "deactivated"})
    client.post("/api/auth/logout")
    client.post("/api/auth/login", json={"username": "sd", "password": "pw-1234"})

    r = client.put("/api/admin/clubs/club_p4o/users/coach1",
                   json={"display_name": "SD Renamed"})
    assert r.status_code == 403
    u = org.get_registry().get_user("coach1")
    assert u.display_name != "SD Renamed"
    assert u.status == "deactivated"


def test_member_endpoints_s2s_acting_identity(app_and_client, monkeypatch):
    """The whole member surface resolves identity via S2S acting headers —
    the biq-app proxy path sends Bearer + X-BIQ-Acting-User-Id, not a session.
    """
    _, client = app_and_client
    _create_club(client, "club_p4k")
    _create_member(client, "club_p4k", "admin_s2s", role="administrator")
    _create_member(client, "club_p4k", "target", role="coach")
    monkeypatch.setenv("BIQ_ONBOARD_S2S_SECRET", "test-s2s")
    h = {"Authorization": "Bearer test-s2s", "X-BIQ-Acting-User-Id": "admin_s2s"}

    r = client.get("/api/admin/clubs/club_p4k/users", headers=h)
    assert r.status_code == 200
    assert any(u["id"] == "target" for u in r.json()["users"])

    r = client.patch("/api/admin/clubs/club_p4k/users/target/status",
                     json={"status": "deactivated"}, headers=h)
    assert r.status_code == 200

    r = client.put("/api/admin/clubs/club_p4k/users/target",
                   json={"display_name": "Renamed"}, headers=h)
    assert r.status_code == 200

    r = client.delete("/api/admin/clubs/club_p4k/users/target", headers=h)
    assert r.status_code == 200

    # Session cookies don't substitute for a valid bearer when S2S is on.
    r = client.get("/api/admin/clubs/club_p4k/users",
                   headers={**h, "Authorization": "Bearer wrong"})
    assert r.status_code == 401
