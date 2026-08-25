"""Tests for the club theme endpoints (ADDENDUM-02 section 8, ADDENDUM-06 section C13)."""

import pytest
from fastapi.testclient import TestClient

from biq_onboard_server.app import create_app


@pytest.fixture
def client():
    app = create_app()
    return TestClient(app)


@pytest.fixture
def admin_client(client):
    """Authenticated client with a session cookie."""
    client.post("/api/auth/login", json={"username": "admin", "password": "T3st1ng!"})
    return client


@pytest.fixture
def club_id(admin_client):
    """Create a test club and return its ID."""
    cid = "test_theme_club"
    admin_client.post("/api/admin/clubs", json={"id": cid, "name": "Test Theme Club"})
    return cid


# ─── Auth ────────────────────────────────────────────────────────────────────


def test_theme_endpoints_require_auth(client):
    """All theme endpoints require authentication."""
    assert client.get("/api/admin/clubs/any/theme").status_code == 401
    assert client.post("/api/admin/clubs/any/theme/generate", json={"homepage_url": "https://example.com"}).status_code == 401
    assert client.put("/api/admin/clubs/any/theme", json={"seed_brand": "#FF5A00"}).status_code == 401
    assert client.delete("/api/admin/clubs/any/theme").status_code == 401


# ─── GET theme ───────────────────────────────────────────────────────────────


def test_get_theme_returns_null_for_new_club(admin_client, club_id):
    """A club with no theme should return null."""
    r = admin_client.get(f"/api/admin/clubs/{club_id}/theme")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["theme"] is None


def test_get_theme_404_for_nonexistent_club(admin_client):
    r = admin_client.get("/api/admin/clubs/nonexistent/theme")
    assert r.status_code == 404


# ─── POST generate ───────────────────────────────────────────────────────────


def test_generate_theme_enqueues_job(admin_client, club_id):
    """POST /generate should return 202-style pending status."""
    r = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/generate",
        json={"homepage_url": "https://example.com"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["status"] == "pending"
    assert "jobId" in data
    assert data["themeJob"]["status"] == "pending"
    assert data["themeJob"]["sourceUrl"] == "https://example.com"
    assert data["themeJob"]["attempts"] == 1


def test_generate_theme_normalises_url(admin_client, club_id):
    """URL without scheme should be normalised to https://."""
    r = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/generate",
        json={"homepage_url": "example.com"},
    )
    assert r.status_code == 200
    assert r.json()["themeJob"]["sourceUrl"] == "https://example.com"


def test_generate_theme_rejects_http(admin_client, club_id):
    """http:// URLs should be rejected."""
    r = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/generate",
        json={"homepage_url": "http://example.com"},
    )
    assert r.status_code == 400


def test_generate_theme_404_for_nonexistent_club(admin_client):
    r = admin_client.post(
        "/api/admin/clubs/nonexistent/theme/generate",
        json={"homepage_url": "https://example.com"},
    )
    assert r.status_code == 404


def test_generate_theme_increments_attempts(admin_client, club_id):
    """Repeated calls should increment the attempts counter."""
    # First call
    r1 = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/generate",
        json={"homepage_url": "https://example.com"},
    )
    assert r1.json()["themeJob"]["attempts"] == 1

    # Clear the lease so we can call again
    # In a real system, the lease would expire; here we simulate by
    # directly manipulating the theme_job
    from biq_onboard_server import org
    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club and getattr(club, "theme_job", None):
        theme_job = club.theme_job
        theme_job["lease"] = None
        registry.merge_club_fields(club_id, {"theme_job": theme_job})

    # Second call
    r2 = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/generate",
        json={"homepage_url": "https://example.com"},
    )
    assert r2.json()["themeJob"]["attempts"] == 2


# ─── PUT manual override ─────────────────────────────────────────────────────


def test_put_theme_manual_override(admin_client, club_id):
    """PUT should create a draft theme from a manual seed."""
    r = admin_client.put(
        f"/api/admin/clubs/{club_id}/theme",
        json={"seed_brand": "#FF5A00", "seed_brand_alt": "#0A153A"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["theme"]["status"] == "draft"
    assert data["theme"]["source"]["kind"] == "manual"
    assert data["theme"]["seed"]["brand"] == "#FF5A00"
    assert data["theme"]["seed"]["brandAlt"] == "#0A153A"
    assert data["theme"]["seed"]["detectedFrom"] == "manual"


def test_put_theme_validates_hex(admin_client, club_id):
    """Invalid hex colours should be rejected."""
    r = admin_client.put(
        f"/api/admin/clubs/{club_id}/theme",
        json={"seed_brand": "not-a-color"},
    )
    assert r.status_code == 422  # Pydantic validation error


def test_put_theme_accepts_null_brand_alt(admin_client, club_id):
    """brandAlt is optional."""
    r = admin_client.put(
        f"/api/admin/clubs/{club_id}/theme",
        json={"seed_brand": "#FF5A00"},
    )
    assert r.status_code == 200
    assert r.json()["theme"]["seed"]["brandAlt"] is None


# ─── DELETE theme ────────────────────────────────────────────────────────────


def test_delete_theme_reverts(admin_client, club_id):
    """DELETE should revert to BasketIQ default (theme = null)."""
    # First set a theme
    admin_client.put(
        f"/api/admin/clubs/{club_id}/theme",
        json={"seed_brand": "#FF5A00"},
    )

    # Then delete it
    r = admin_client.delete(f"/api/admin/clubs/{club_id}/theme")
    assert r.status_code == 200
    assert r.json()["status"] == "reverted"

    # Verify theme is null
    r2 = admin_client.get(f"/api/admin/clubs/{club_id}/theme")
    assert r2.json()["theme"] is None


def test_delete_theme_404_for_nonexistent_club(admin_client):
    r = admin_client.delete("/api/admin/clubs/nonexistent/theme")
    assert r.status_code == 404
