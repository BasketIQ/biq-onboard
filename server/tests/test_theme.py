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


# ─── Cloud Tasks integration ────────────────────────────────────────────────


def test_enqueue_dev_mode_returns_synthetic_id(monkeypatch):
    """When BIQ_CLOUD_TASKS_QUEUE is unset, _enqueue_generation_task
    returns a synthetic dev-mode ID and does not call Cloud Tasks."""
    import os
    monkeypatch.delenv("BIQ_CLOUD_TASKS_QUEUE", raising=False)
    from biq_onboard_server.routers import theme as theme_mod
    # Reset cached client
    monkeypatch.setattr(theme_mod, "_tasks_client", None)
    task_id = theme_mod._enqueue_generation_task("club_x", "https://example.com")
    assert task_id.startswith("dev-task-")


def test_enqueue_production_calls_cloud_tasks(monkeypatch):
    """When BIQ_CLOUD_TASKS_QUEUE is set, _enqueue_generation_task
    creates a real Cloud Tasks task via the client library."""
    import json

    # Set the env var to enable the production path
    monkeypatch.setenv("BIQ_CLOUD_TASKS_QUEUE", "club-theme-generation")
    monkeypatch.setenv("GCP_PROJECT_ID", "test-project")
    monkeypatch.setenv("GCP_TASKS_LOCATION", "europe-west1")
    monkeypatch.setenv("CLUB_THEME_JOB_URL", "https://job.run.app/gen")
    monkeypatch.setenv("GCP_DEPLOYER_SA", "deployer@test-project.iam.gserviceaccount.com")

    from biq_onboard_server.routers import theme as theme_mod

    # Mock the Cloud Tasks client
    class MockCreatedTask:
        name = "projects/test-project/locations/europe-west1/queues/club-theme-generation/tasks/fake-task-123"

    class MockHttpRequest:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class MockTask:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class MockCloudTasksClient:
        def __init__(self):
            self.create_task_calls = []

        def queue_path(self, project, location, queue):
            return f"projects/{project}/locations/{location}/queues/{queue}"

        def create_task(self, request):
            self.create_task_calls.append(request)
            return MockCreatedTask()

    # Build a mock module to replace google.cloud.tasks_v2
    class MockTasksV2:
        class Task:
            def __init__(self, **kwargs):
                pass

        class HttpRequest:
            def __init__(self, **kwargs):
                pass

        class HttpMethod:
            POST = "POST"

        class OidcToken:
            def __init__(self, **kwargs):
                pass

        CloudTasksClient = MockCloudTasksClient

    mock_client = MockCloudTasksClient()

    # Patch _get_tasks_client to return our mock
    monkeypatch.setattr(theme_mod, "_get_tasks_client", lambda: mock_client)
    # Patch the tasks_v2 import inside the function
    import sys
    monkeypatch.setitem(sys.modules, "google.cloud.tasks_v2", MockTasksV2())

    task_id = theme_mod._enqueue_generation_task("club_test", "https://example.com")

    # Verify the task ID is from the created task
    assert task_id == "fake-task-123"

    # Verify create_task was called with the right payload
    assert len(mock_client.create_task_calls) == 1
    call = mock_client.create_task_calls[0]
    assert "parent" in call
    assert "club-theme-generation" in call["parent"]
    assert "task" in call

    # Clean up
    monkeypatch.delenv("BIQ_CLOUD_TASKS_QUEUE", raising=False)


# ─── Logo rights affirmation (ADDENDUM-06 section C3) ───────────────────────


def test_affirm_logo_rights_404_without_theme(admin_client, club_id):
    """Logo rights endpoint requires an existing theme with a logo."""
    r = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/logo-rights",
        json={"affirmed": True},
    )
    assert r.status_code == 404


def test_affirm_logo_rights_404_without_logo(admin_client, club_id):
    """Logo rights endpoint requires a theme with a logo."""
    # Create a theme without a logo (manual override)
    admin_client.put(
        f"/api/admin/clubs/{club_id}/theme",
        json={"seed_brand": "#FF5A00"},
    )
    r = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/logo-rights",
        json={"affirmed": True},
    )
    assert r.status_code == 404  # no logo in the theme


def test_affirm_logo_rights_requires_auth(client):
    assert client.post(
        "/api/admin/clubs/any/theme/logo-rights",
        json={"affirmed": True},
    ).status_code == 401
