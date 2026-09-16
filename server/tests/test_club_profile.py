"""Mi Club Phase 3: club profile summary endpoint tests.

GET /api/admin/clubs/{id}/summary — member-readable club card data with
tri-state presence checks (True/False/None→"unknown").
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


def _create_club(client, club_id="club_p3"):
    client.post(
        f"/api/admin/clubs/{club_id}/onboard",
        json={"club_id": club_id, "name": "Club P3", "slug": "p3", "season": "2026/27"},
    )


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


def test_summary_returns_club_data(monkeypatch, app_and_client):
    """Real counts from the registry; presence checks wired (mocked)."""
    _, client = app_and_client
    _create_club(client, "club_p3a")
    _create_member(client, "club_p3a", "m1")
    _create_member(client, "club_p3a", "m2")

    from biq_onboard_server.routers import club_profile
    monkeypatch.setattr(club_profile.clients, "methodology_present", lambda cid: True)
    monkeypatch.setattr(club_profile.clients, "season_plan_present", lambda ids: False)

    r = client.get("/api/admin/clubs/club_p3a/summary")
    assert r.status_code == 200
    body = r.json()
    assert body["club"]["id"] == "club_p3a"
    assert body["club"]["name"] == "Club P3"
    assert body["member_count"] >= 3  # admin member created by onboard + m1 + m2
    assert body["methodology_present"] is True
    assert body["season_plan_present"] is False


def test_summary_presence_unknown_on_upstream_failure(monkeypatch, app_and_client):
    """Upstream failures surface as null (unknown), not a false 'absent'."""
    _, client = app_and_client
    _create_club(client, "club_p3b")

    from biq_onboard_server.routers import club_profile
    monkeypatch.setattr(club_profile.clients, "methodology_present", lambda cid: None)
    monkeypatch.setattr(club_profile.clients, "season_plan_present", lambda ids: None)

    r = client.get("/api/admin/clubs/club_p3b/summary")
    assert r.status_code == 200
    assert r.json()["methodology_present"] is None
    assert r.json()["season_plan_present"] is None


def test_summary_member_can_read(app_and_client, monkeypatch):
    """A plain club member (no admin caps) can read the summary."""
    _, client = app_and_client
    _create_club(client, "club_p3c")
    _create_member(client, "club_p3c", "plain_member")

    from biq_onboard_server.routers import club_profile
    monkeypatch.setattr(club_profile.clients, "methodology_present", lambda cid: False)
    monkeypatch.setattr(club_profile.clients, "season_plan_present", lambda ids: False)

    client.post("/api/auth/logout")
    client.post("/api/auth/login", json={"username": "plain_member", "password": "pw-1234"})
    r = client.get("/api/admin/clubs/club_p3c/summary")
    assert r.status_code == 200
    assert r.json()["club"]["id"] == "club_p3c"


def test_summary_non_member_forbidden(app_and_client, monkeypatch):
    """A user with no membership and no club caps gets 403."""
    _, client = app_and_client
    _create_club(client, "club_p3d")
    # member of a DIFFERENT club
    _create_club(client, "club_other")
    _create_member(client, "club_other", "outsider")

    from biq_onboard_server.routers import club_profile
    monkeypatch.setattr(club_profile.clients, "methodology_present", lambda cid: False)
    monkeypatch.setattr(club_profile.clients, "season_plan_present", lambda ids: False)

    client.post("/api/auth/logout")
    client.post("/api/auth/login", json={"username": "outsider", "password": "pw-1234"})
    r = client.get("/api/admin/clubs/club_p3d/summary")
    assert r.status_code == 403


def test_summary_unauthenticated_401(app_and_client):
    _, client = app_and_client
    client.post("/api/auth/logout")
    r = client.get("/api/admin/clubs/club_p3/summary")
    assert r.status_code == 401


def test_summary_missing_club_404(app_and_client):
    _, client = app_and_client
    r = client.get("/api/admin/clubs/club_nope/summary")
    assert r.status_code == 404
