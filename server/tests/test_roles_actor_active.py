"""Active-actor gate: ``require_roles_admin_acting`` must deny actors whose
Org Registry record is missing, deactivated, pending or bound to another
club — even when they still hold an active RoleAssignment.

Root cause: ``effective_capabilities`` evaluates RoleAssignment active
dates, never the user's status. A deactivated member with a live
administrator assignment could still mutate roles over S2S.
"""

from __future__ import annotations

import os

os.environ["BIQ_ORG_STORE"] = "memory"
os.environ["BIQ_ROLES_STORE"] = "memory"

import pytest
from biq_core.org import Club, User
from biq_core.roles import RoleAssignment
from fastapi.testclient import TestClient

from biq_onboard_server import org
from biq_onboard_server.app import create_app

_S2S_SECRET = "test-s2s-active-actor"
CLUB = "club_gate"
OTHER_CLUB = "club_other"
TARGET = "member_target"


def _s2s(user_id: str, secret: str = _S2S_SECRET) -> dict:
    return {
        "Authorization": f"Bearer {secret}",
        "X-BIQ-Acting-User-Id": user_id,
        "X-BIQ-Acting-Email": f"{user_id}@fixture.test",
    }


def _seed_member(
    user_id: str,
    club_id: str,
    role: str = "administrator",
    status: str = "active",
) -> None:
    """Registry user + still-active RoleAssignment — the exact state a
    deactivated member can retain."""
    reg = org.get_registry()
    reg.upsert_club(Club(id=club_id, name=f"Club {club_id}"))
    reg.upsert_user(
        User(
            id=user_id,
            club_id=club_id,
            email=f"{user_id}@fixture.test",
            role=role,
            display_name=user_id,
            status=status,
        )
    )
    org.get_roles().put_assignment(
        RoleAssignment(
            id=f"{user_id}__{role}__club:{club_id}",
            user_id=user_id,
            role=role,
            scope=f"club:{club_id}",
        )
    )


def _audit_count(club_id: str) -> int:
    return len(org.get_audit_log().list_for_scope(f"club:{club_id}"))


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("BIQ_ONBOARD_S2S_SECRET", _S2S_SECRET)
    org.reset_for_tests()
    c = TestClient(create_app())
    _seed_member("actor_admin", CLUB)
    _seed_member(TARGET, CLUB, role="coach")
    yield c


def _post(client, actor: str, club: str = CLUB, role: str = "coach"):
    return client.post(
        f"/api/admin/clubs/{club}/roles",
        json={"user_id": TARGET, "role": role},
        headers=_s2s(actor),
    )


def _delete(client, actor: str, club: str = CLUB):
    aid = f"{TARGET}__coach__club:{club}"
    return client.delete(
        f"/api/admin/clubs/{club}/roles/{aid}", headers=_s2s(actor)
    )


# ─── Positive paths (unchanged contract) ─────────────────────────────────


def test_active_admin_actor_can_assign_and_remove(client):
    r = _post(client, "actor_admin")
    assert r.status_code == 200
    aid = r.json()["assignment_id"]
    d = client.delete(
        f"/api/admin/clubs/{CLUB}/roles/{aid}", headers=_s2s("actor_admin")
    )
    assert d.status_code == 200
    audit = org.get_audit_log().list_for_scope(f"club:{CLUB}")
    assert {e.action for e in audit} == {"assign", "remove"}
    assert all(e.actor_id == "actor_admin" for e in audit)


def test_active_sports_director_tiering_preserved(client):
    _seed_member("actor_sd", CLUB, role="sports_director")
    assert _post(client, "actor_sd", role="coach").status_code == 200
    assert _post(client, "actor_sd", role="administrator").status_code == 403


def test_get_roles_and_users_also_gated(client):
    assert client.get(
        f"/api/admin/clubs/{CLUB}/roles", headers=_s2s("actor_admin")
    ).status_code == 200
    assert client.get(
        f"/api/admin/clubs/{CLUB}/users", headers=_s2s("actor_admin")
    ).status_code == 200


# ─── Deactivated / pending / unknown / wrong-club actors ─────────────────


def test_deactivated_actor_with_live_assignment_denied(client):
    """The core regression: still-active RoleAssignment is not enough."""
    _seed_member("actor_gone", CLUB, status="deactivated")
    before = _audit_count(CLUB)
    assert _post(client, "actor_gone").status_code == 403
    assert _delete(client, "actor_gone").status_code == 403
    assert _audit_count(CLUB) == before  # zero audit writes
    # The shared gate protects the reads too.
    assert client.get(
        f"/api/admin/clubs/{CLUB}/users", headers=_s2s("actor_gone")
    ).status_code == 403
    assert client.get(
        f"/api/admin/clubs/{CLUB}/roles", headers=_s2s("actor_gone")
    ).status_code == 403


def test_pending_actor_denied(client):
    _seed_member("actor_pending", CLUB, status="pending")
    assert _post(client, "actor_pending").status_code == 403


def test_unknown_actor_denied(client):
    assert _post(client, "actor_ghost").status_code == 403


def test_wrong_club_actor_denied_after_valid_bearer(client):
    """Active member of club B with caps there targeting club A -> 403,
    not 401 — the bearer was valid, the actor is out of scope."""
    _seed_member("actor_b", OTHER_CLUB)
    r = _post(client, "actor_b", club=CLUB)
    assert r.status_code == 403
    # Same actor against their own club passes the identity gate.
    _seed_member("member_b", OTHER_CLUB, role="coach")
    ok = client.post(
        f"/api/admin/clubs/{OTHER_CLUB}/roles",
        json={"user_id": "member_b", "role": "coach"},
        headers=_s2s("actor_b"),
    )
    assert ok.status_code == 200


# ─── Bearer contract preserved ────────────────────────────────────────────


def test_missing_and_bad_bearer_still_401(client):
    assert client.post(
        f"/api/admin/clubs/{CLUB}/roles",
        json={"user_id": TARGET, "role": "coach"},
    ).status_code == 401
    assert client.post(
        f"/api/admin/clubs/{CLUB}/roles",
        json={"user_id": TARGET, "role": "coach"},
        headers=_s2s("actor_admin", secret="wrong"),
    ).status_code == 401


def test_cookie_session_does_not_bypass(client):
    """A valid break-glass session cookie plus no bearer => 401 in S2S mode."""
    client.post(
        "/api/auth/login", json={"username": "admin", "password": "T3st1ng!"}
    )
    r = client.post(
        f"/api/admin/clubs/{CLUB}/roles",
        json={"user_id": TARGET, "role": "coach"},
    )
    assert r.status_code == 401


# ─── Standalone mode (no S2S secret) — session path still gated ──────────


def test_standalone_session_deactivated_member_denied(monkeypatch):
    """Standalone fallback (no S2S secret): a deactivated member who can
    still log in is denied by the same active-member gate."""
    from biq_core.org.passwords import hash_password

    monkeypatch.delenv("BIQ_ONBOARD_S2S_SECRET", raising=False)
    org.reset_for_tests()
    reg = org.get_registry()
    reg.upsert_club(Club(id=CLUB, name="Club"))
    reg.upsert_user(
        User(
            id="deact",
            club_id=CLUB,
            email="d@fixture.test",
            role="administrator",
            display_name="deact",
            status="deactivated",
            password_hash=hash_password("pw-1234"),
        )
    )
    c = TestClient(create_app())
    r = c.post("/api/auth/login", json={"username": "deact", "password": "pw-1234"})
    assert r.status_code == 200
    r = c.post(
        f"/api/admin/clubs/{CLUB}/roles",
        json={"user_id": "x", "role": "coach"},
    )
    assert r.status_code == 403
