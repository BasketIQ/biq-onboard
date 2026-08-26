"""Tests for the self-service onboarding flow (ADDENDUM-07 §6).

Covers POST /api/onboarding/clubs — the club step's create path that moved
here from biq-app's /api/auth/register:

- §6.3 authorisation: new users (no membership) and admins of an existing
  club may create; non-admin members get 403 (server-side enforcement).
- W2.1a-ii carries over unchanged: Club.website persisted, non-https
  rejected with 422, no network I/O.
- ADDENDUM-06 §C2.3: name required (≥2 chars), no generated fallback.

Sessions: the shell owns user sessions in production (module contract v1);
the endpoints authenticate through ``session_user`` like every other router
here. Tests stub ``session_user`` directly to exercise the authorisation
matrix against real registry state.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from biq_core.org import Club, User

from biq_onboard_server import org
from biq_onboard_server.app import create_app
from biq_onboard_server.routers import onboarding_flow


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("BIQ_ORG_STORE", "memory")
    monkeypatch.setenv("BIQ_ROLES_STORE", "memory")
    return TestClient(create_app())


def _as_session(monkeypatch: pytest.MonkeyPatch, user_id: str) -> None:
    """Stub the authenticated caller for the onboarding_flow router."""
    monkeypatch.setattr(
        "biq_onboard_server.routers.onboarding_flow.session_user",
        lambda request: user_id,
    )


def _seed_user(
    registry,
    user_id: str,
    email: str,
    role: str = "coach",
    club_id: str | None = None,
) -> None:
    if club_id:
        registry.upsert_club(Club(id=club_id, name=f"Club {club_id}"))
    registry.upsert_user(
        User(
            id=user_id,
            club_id=club_id or "",
            email=email,
            role=role,
            display_name=f"User {user_id}",
        )
    )


def _clubs(registry) -> list[Club]:
    return [c for c in registry._clubs.values()] if hasattr(registry, "_clubs") else []


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------


def test_create_club_without_session_returns_401(client):
    resp = client.post("/api/onboarding/clubs", json={"name": "CB Sin Sesión"})
    assert resp.status_code == 401


def test_create_club_unknown_registry_user_returns_403(client, monkeypatch):
    """A session user absent from the registry (and not the break-glass
    admin) may not create clubs."""
    _as_session(monkeypatch, "u_ghost")
    resp = client.post("/api/onboarding/clubs", json={"name": "CB Fantasma"})
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# §6.3 authorisation matrix
# ---------------------------------------------------------------------------


def test_new_user_with_no_club_can_create(client, monkeypatch):
    """A brand-new user (only a club-less record) may create a club and
    becomes its first administrator."""
    reg = org.get_registry()
    _seed_user(reg, "u_new", "fresh@basketiq.io")  # club-less row
    _as_session(monkeypatch, "u_new")

    resp = client.post(
        "/api/onboarding/clubs",
        json={"name": "CB Nuevo", "website": ""},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True

    club = reg.get_club(data["club"]["id"])
    assert club is not None
    assert club.name == "CB Nuevo"
    # The creator became administrator of exactly one membership row.
    memberships = [u for u in reg.find_users_by_email("fresh@basketiq.io") if u.club_id]
    assert len(memberships) == 1
    assert memberships[0].club_id == data["club"]["id"]
    assert memberships[0].role == "administrator"


def test_non_admin_member_posting_create_club_gets_403(client, monkeypatch):
    """ADDENDUM-07 §6.3: a plain coach of an existing club gets 403 and no
    club is created. Server-side enforcement — the client-side hiding of the
    form is presentation only."""
    reg = org.get_registry()
    _seed_user(reg, "u_coach", "coach@basketiq.io", role="coach", club_id="club_a")
    _as_session(monkeypatch, "u_coach")

    before = {c.id for c in _clubs(reg)}
    resp = client.post("/api/onboarding/clubs", json={"name": "CB Prohibido"})
    assert resp.status_code == 403
    assert {c.id for c in _clubs(reg)} == before


def test_admin_of_existing_club_can_create(client, monkeypatch):
    """ADDENDUM-07 §6.3: administrators of an existing club may create an
    additional club (multi-club founders)."""
    reg = org.get_registry()
    _seed_user(
        reg, "u_admin", "admin@basketiq.io", role="administrator", club_id="club_a"
    )
    _as_session(monkeypatch, "u_admin")

    resp = client.post("/api/onboarding/clubs", json={"name": "CB Segundo"})
    assert resp.status_code == 200
    new_id = resp.json()["club"]["id"]
    assert new_id != "club_a"
    memberships = [
        u for u in reg.find_users_by_email("admin@basketiq.io") if u.club_id
    ]
    assert {m.club_id for m in memberships} == {"club_a", new_id}
    assert all(m.role == "administrator" for m in memberships)


# ---------------------------------------------------------------------------
# Field validation carried over from W2.1a-i / W2.1a-ii
# ---------------------------------------------------------------------------


def test_create_club_persists_website(client, monkeypatch):
    """W2.1a-ii carried over unchanged: the website lands on Club.website."""
    reg = org.get_registry()
    _seed_user(reg, "u_new", "founder@basketiq.io")
    _as_session(monkeypatch, "u_new")

    resp = client.post(
        "/api/onboarding/clubs",
        json={"name": "CB Norte", "website": "https://cbnorte.es/"},
    )
    assert resp.status_code == 200
    club = reg.get_club(resp.json()["club"]["id"])
    assert club.website == "https://cbnorte.es/"
    assert club.created_by == "founder@basketiq.io"


def test_create_club_rejects_non_https_website(client, monkeypatch):
    """W2.1a-ii rule intact on the new endpoint: http:// is rejected with 422
    without fetching (§C2.1 spirit — validation by string check only)."""
    reg = org.get_registry()
    _seed_user(reg, "u_new", "founder@basketiq.io")
    _as_session(monkeypatch, "u_new")

    resp = client.post(
        "/api/onboarding/clubs",
        json={"name": "CB Http", "website": "http://cbhttp.es/"},
    )
    assert resp.status_code == 422
    assert "https" in resp.json()["detail"].lower()
    assert not _clubs(reg), "No club may be created on invalid input"


def test_create_club_requires_name_no_fallback(client, monkeypatch):
    """ADDENDUM-06 §C2.3: name required (trimmed ≥2 chars); the generated
    'Club <localpart>' fallback must never appear."""
    reg = org.get_registry()
    _seed_user(reg, "u_new", "juanjo@basketiq.io")
    _as_session(monkeypatch, "u_new")

    for bad in ("", "   ", "X"):
        resp = client.post("/api/onboarding/clubs", json={"name": bad})
        assert resp.status_code == 422

    assert not any(
        "juanjo" in c.name for c in _clubs(reg)
    ), "A fallback 'Club <localpart>' name was created"


def test_create_club_without_website_leaves_it_none(client, monkeypatch):
    reg = org.get_registry()
    _seed_user(reg, "u_new", "founder@basketiq.io")
    _as_session(monkeypatch, "u_new")

    resp = client.post("/api/onboarding/clubs", json={"name": "CB Sin Web"})
    assert resp.status_code == 200
    club = reg.get_club(resp.json()["club"]["id"])
    assert club.website is None
