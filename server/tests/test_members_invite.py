"""Mi Club Phase 5: POST /api/admin/clubs/{id}/invite tests.

Session/S2S-gated member-management endpoint that asks biq-app to send an
invite email. Email format validated before any upstream call; the invitee
need not exist in the registry.
"""

from __future__ import annotations

import os

os.environ["BIQ_ORG_STORE"] = "memory"
os.environ["BIQ_ROLES_STORE"] = "memory"

import pytest
from fastapi.testclient import TestClient

from biq_onboard_server import org
from biq_onboard_server.app import create_app
from biq_onboard_server.clients import UpstreamServiceError


@pytest.fixture
def app_and_client():
    org.reset_for_tests()
    app = create_app()
    client = TestClient(app)
    client.post("/api/auth/login", json={"username": "admin", "password": "T3st1ng!"})
    return app, client


def _create_club(client, club_id="club_p5"):
    client.post(
        f"/api/admin/clubs/{club_id}/onboard",
        json={"club_id": club_id, "name": "Club P5", "slug": "p5", "season": "2026/27"},
    )


def _create_member(client, club_id, user_id, role="coach", password="pw-1234"):
    return client.post(
        f"/api/admin/clubs/{club_id}/users",
        json={"id": user_id, "club_id": club_id, "display_name": user_id,
              "role": role, "password": password},
    )


def _patch_send(monkeypatch, result=None, exc=None):
    from biq_onboard_server.routers import members
    calls = []
    def _fake(to, club_name, club_id):
        calls.append((to, club_name, club_id))
        if exc:
            raise exc
        return result or {"ok": True, "id": "e1"}
    monkeypatch.setattr(members.clients, "send_invite", _fake)
    return calls


def test_invite_sends_via_app_client(monkeypatch, app_and_client):
    _, client = app_and_client
    _create_club(client, "club_p5a")
    calls = _patch_send(monkeypatch)
    r = client.post("/api/admin/clubs/club_p5a/invite", json={"email": "new@basketiq.io"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "invited": "new@basketiq.io", "skipped": False}
    assert calls == [("new@basketiq.io", "Club P5", "club_p5a")]


def test_invite_nonexistent_invitee_ok(monkeypatch, app_and_client):
    """The invitee is not required to exist — that's the point of an invite."""
    _, client = app_and_client
    _create_club(client, "club_p5b")
    calls = _patch_send(monkeypatch)
    r = client.post("/api/admin/clubs/club_p5b/invite",
                    json={"email": "never-seen@basketiq.io"})
    assert r.status_code == 200
    assert calls == [("never-seen@basketiq.io", "Club P5", "club_p5b")]


def test_invite_invalid_email_400_no_send(monkeypatch, app_and_client):
    _, client = app_and_client
    _create_club(client, "club_p5c")
    calls = _patch_send(monkeypatch)
    for bad in ["nope", "a@b", "@x.com", "a b@c.com", ""]:
        r = client.post("/api/admin/clubs/club_p5c/invite", json={"email": bad})
        assert r.status_code == 400, bad
    assert calls == []


def test_invite_missing_club_404(monkeypatch, app_and_client):
    _, client = app_and_client
    _patch_send(monkeypatch)
    r = client.post("/api/admin/clubs/club_nope/invite", json={"email": "a@b.co"})
    assert r.status_code == 404


def test_invite_unauthenticated_401(app_and_client):
    _, client = app_and_client
    client.post("/api/auth/logout")
    r = client.post("/api/admin/clubs/club_p5/invite", json={"email": "a@b.co"})
    assert r.status_code == 401


def test_invite_plain_member_forbidden(app_and_client, monkeypatch):
    """A coach with no role-management cap cannot invite."""
    _, client = app_and_client
    _create_club(client, "club_p5d")
    _create_member(client, "club_p5d", "plain_coach")
    _patch_send(monkeypatch)
    client.post("/api/auth/logout")
    client.post("/api/auth/login", json={"username": "plain_coach", "password": "pw-1234"})
    r = client.post("/api/admin/clubs/club_p5d/invite", json={"email": "a@b.co"})
    assert r.status_code == 403


def test_invite_sports_director_allowed(app_and_client, monkeypatch):
    """SDs hold roles.manage.sporting — the Miembros tab admits them."""
    _, client = app_and_client
    _create_club(client, "club_p5e")
    _create_member(client, "club_p5e", "sd_user", role="sports_director")
    calls = _patch_send(monkeypatch)
    client.post("/api/auth/logout")
    client.post("/api/auth/login", json={"username": "sd_user", "password": "pw-1234"})
    r = client.post("/api/admin/clubs/club_p5e/invite", json={"email": "a@b.co"})
    assert r.status_code == 200
    assert len(calls) == 1


def test_invite_upstream_failure_502(monkeypatch, app_and_client):
    _, client = app_and_client
    _create_club(client, "club_p5f")
    _patch_send(monkeypatch, exc=UpstreamServiceError("invite endpoint returned 500"))
    r = client.post("/api/admin/clubs/club_p5f/invite", json={"email": "a@b.co"})
    assert r.status_code == 502


def test_invite_s2s_acting_identity(app_and_client, monkeypatch):
    """BFF proxy path: Bearer S2S + acting headers resolve the caller."""
    _, client = app_and_client
    _create_club(client, "club_p5g")
    _create_member(client, "club_p5g", "admin_via_s2s", role="administrator")
    calls = _patch_send(monkeypatch)
    monkeypatch.setenv("BIQ_ONBOARD_S2S_SECRET", "test-s2s")
    headers = {"Authorization": "Bearer test-s2s",
               "X-BIQ-Acting-User-Id": "admin_via_s2s"}
    r = client.post("/api/admin/clubs/club_p5g/invite",
                    json={"email": "a@b.co"}, headers=headers)
    assert r.status_code == 200
    assert calls == [("a@b.co", "Club P5", "club_p5g")]
    # Bad token fails closed even with the admin session still present.
    r = client.post("/api/admin/clubs/club_p5g/invite",
                    json={"email": "a@b.co"},
                    headers={**headers, "Authorization": "Bearer wrong"})
    assert r.status_code == 401
