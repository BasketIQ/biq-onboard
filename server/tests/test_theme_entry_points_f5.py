"""F5 — Integration tests for both theme-generation entry points.

Verifies that the URL-driven and manual-colour paths share the same
canonical pipeline contract:

  - Both produce a persisted intent (theme_job with pending status)
  - Both return 202 with a jobId
  - Task → job → callback state is persisted and observable
  - Dispatch failures return a governed non-2xx response (503), never ok:true
  - Retry is durable and idempotent
  - The result callback contract is identical for both entry points

Per the active architect handoff:
  - one integration success test covering persisted intent and task/job/callback contract
  - one integration failure test covering dispatch failure and retryable state
  - existing unit tests for response/status mapping (already in test_theme.py)
"""

from __future__ import annotations

import pytest
from biq_onboard_server import org
from biq_onboard_server.app import create_app
from fastapi.testclient import TestClient

_RESULT_TOKEN = "test-result-token-f5"


@pytest.fixture
def client(monkeypatch):
    """Fresh app with dev-mode Cloud Tasks (no real GCP calls)."""
    monkeypatch.delenv("BIQ_CLOUD_TASKS_QUEUE", raising=False)
    monkeypatch.setenv("BIQ_THEME_JOB_RESULT_TOKEN", _RESULT_TOKEN)
    org.reset_for_tests()
    app = create_app()
    return TestClient(app)


@pytest.fixture
def admin_client(client):
    client.post("/api/auth/login", json={"username": "admin", "password": "T3st1ng!"})
    return client


@pytest.fixture
def club_id(admin_client):
    cid = "f5_club"
    admin_client.post("/api/admin/clubs", json={"id": cid, "name": "F5 Club"})
    return cid


def _result_headers():
    return {"Authorization": f"Bearer {_RESULT_TOKEN}"}


# ─── F5: URL-driven entry point — persisted intent + callback contract ───


def test_url_entry_point_persists_intent_and_accepts_callback(admin_client, club_id):
    """F5: URL-driven generation persists a pending intent and the result
    callback transitions it through running → succeeded.

    Contract:
      1. POST /generate → 202 + ok:true + status=pending + jobId + themeJob
      2. theme_job is persisted with status=pending, sourceUrl, lease
      3. Result callback: running → 200
      4. Result callback: succeeded + theme → 200
      5. Final theme_job status is succeeded, theme is persisted
    """
    # 1. Enqueue generation
    r = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/generate",
        json={"homepage_url": "https://example.com"},
    )
    assert r.status_code == 202
    data = r.json()
    assert data["ok"] is True
    assert data["status"] == "pending"
    assert "jobId" in data
    job_id = data["themeJob"]["lease"]["holder"]

    # 2. Verify persisted intent
    reg = org.get_registry()
    club = reg.get_club(club_id)
    theme_job = club.theme_job
    assert theme_job["status"] == "pending"
    assert theme_job["sourceUrl"] == "https://example.com"
    assert theme_job["lease"]["holder"] == job_id
    assert theme_job["attempts"] == 1

    # 3. Result callback: running
    r_running = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/result",
        json={"status": "running", "jobId": job_id, "sourceUrl": "https://example.com"},
        headers=_result_headers(),
    )
    assert r_running.status_code == 200
    assert r_running.json()["status"] == "running"

    # Verify running state persisted
    club = reg.get_club(club_id)
    assert club.theme_job["status"] == "running"

    # 4. Result callback: succeeded + theme
    fake_theme = {
        "schemaVersion": 1,
        "clubId": club_id,
        "status": "active",
        "source": {"kind": "extracted", "homepageUrl": "https://example.com"},
        "seed": {"brand": "#FF5A00", "brandAlt": "#0A153A", "detectedFrom": "primary"},
        "tokens": {"light": {"primary": "#FF5A00"}, "dark": {"primary": "#FF5A00"}},
        "gate": {"passed": True, "payloadHash": "abc123"},
    }
    r_done = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/result",
        json={
            "status": "succeeded",
            "theme": fake_theme,
            "jobId": job_id,
            "sourceUrl": "https://example.com",
        },
        headers=_result_headers(),
    )
    assert r_done.status_code == 200

    # 5. Final state: theme_job succeeded, theme persisted
    club = reg.get_club(club_id)
    assert club.theme_job["status"] == "succeeded"
    assert club.theme_job["finishedAt"] is not None
    assert club.theme is not None
    assert club.theme["status"] == "active"


# ─── F5: Manual-colour entry point — same callback contract ──────────────


def test_manual_entry_point_persists_intent_and_accepts_callback(admin_client, club_id):
    """F5: Manual-colour generation persists a pending intent with manualSeed
    and the result callback transitions it through the same contract.

    Both entry points must not drift into separate contracts.
    """
    # 1. PUT manual theme
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

    # Verify persisted intent (theme_job with manualSeed)
    reg = org.get_registry()
    club = reg.get_club(club_id)
    theme_job = club.theme_job
    assert theme_job["status"] == "pending"
    assert theme_job["manualSeed"]["brand"] == "#FF5A00"
    assert theme_job["manualSeed"]["brandAlt"] == "#0A153A"
    job_id = theme_job["lease"]["holder"]

    # 2. Result callback: running (same contract as URL path)
    r_running = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/result",
        json={"status": "running", "jobId": job_id, "sourceUrl": ""},
        headers=_result_headers(),
    )
    assert r_running.status_code == 200
    assert r_running.json()["status"] == "running"

    # 3. Result callback: succeeded + theme (same contract)
    manual_theme = {
        "schemaVersion": 1,
        "clubId": club_id,
        "status": "draft",
        "source": {"kind": "manual", "homepageUrl": ""},
        "seed": {"brand": "#FF5A00", "brandAlt": "#0A153A", "detectedFrom": "manual"},
        "tokens": {"light": {"primary": "#FF5A00"}, "dark": {"primary": "#FF5A00"}},
        "gate": {"passed": True, "payloadHash": "def456"},
    }
    r_done = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/result",
        json={
            "status": "succeeded",
            "theme": manual_theme,
            "jobId": job_id,
            "sourceUrl": "",
        },
        headers=_result_headers(),
    )
    assert r_done.status_code == 200

    # 4. Final state
    club = reg.get_club(club_id)
    assert club.theme_job["status"] == "succeeded"
    assert club.theme is not None
    assert club.theme["source"]["kind"] == "manual"


# ─── F5: Dispatch failure — governed 503, retryable state ────────────────


def test_dispatch_failure_returns_503_and_persists_retryable_state(admin_client, club_id, monkeypatch):
    """F5: When Cloud Tasks dispatch fails, the response is a governed 503
    (never ok:true), and the theme_job is persisted in a retryable 'failed'
    state so retry can proceed.
    """
    # Force the production path so _enqueue_generation_task tries real Cloud Tasks
    monkeypatch.setenv("BIQ_CLOUD_TASKS_QUEUE", "club-theme-generation")
    monkeypatch.setenv("GCP_PROJECT_ID", "test-project")
    monkeypatch.setenv("GCP_TASKS_LOCATION", "europe-west1")
    monkeypatch.setenv("GCP_TASK_INVOKER_SA", "invoker@test-project.iam.gserviceaccount.com")

    from biq_onboard_server.routers import theme as theme_mod

    # Mock the client to raise on create_task (dispatch failure)
    class FailingClient:
        def queue_path(self, project, location, queue):
            return f"projects/{project}/locations/{location}/queues/{queue}"

        def create_task(self, request):
            raise RuntimeError("Cloud Tasks unavailable")

    monkeypatch.setattr(theme_mod, "_get_tasks_client", lambda: FailingClient())

    # Mock tasks_v2 module
    import sys

    class MockTasksV2:
        class Task:
            def __init__(self, **kwargs): pass
        class HttpRequest:
            def __init__(self, **kwargs): pass
        class HttpMethod:
            POST = "POST"
        class OAuthToken:
            def __init__(self, **kwargs): pass
        CloudTasksClient = FailingClient

    monkeypatch.setitem(sys.modules, "google.cloud.tasks_v2", MockTasksV2())

    r = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/generate",
        json={"homepage_url": "https://example.com"},
    )

    # Governed 503, never ok:true
    assert r.status_code == 503
    assert "ok" not in r.json() or r.json().get("ok") is not True

    # theme_job persisted in retryable 'failed' state
    reg = org.get_registry()
    club = reg.get_club(club_id)
    theme_job = club.theme_job
    assert theme_job["status"] == "failed"
    assert theme_job["finishedAt"] is not None
    assert "enqueue failed" in (theme_job.get("reason") or "")

    # Retry must be available (failed is a retryable terminal state)
    monkeypatch.delenv("BIQ_CLOUD_TASKS_QUEUE", raising=False)
    r_retry = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/retry",
    )
    assert r_retry.status_code in (200, 202)
    retry_data = r_retry.json()
    assert retry_data["ok"] is True
    assert retry_data["status"] == "pending"
    assert retry_data["themeJob"]["attempts"] == 2


def test_manual_entry_point_dispatch_failure_also_503(admin_client, club_id, monkeypatch):
    """F5: Manual-colour dispatch failure must also return governed 503."""
    monkeypatch.setenv("BIQ_CLOUD_TASKS_QUEUE", "club-theme-generation")
    monkeypatch.setenv("GCP_PROJECT_ID", "test-project")
    monkeypatch.setenv("GCP_TASKS_LOCATION", "europe-west1")
    monkeypatch.setenv("GCP_TASK_INVOKER_SA", "invoker@test-project.iam.gserviceaccount.com")

    from biq_onboard_server.routers import theme as theme_mod

    class FailingClient:
        def queue_path(self, project, location, queue):
            return f"projects/{project}/locations/{location}/queues/{queue}"

        def create_task(self, request):
            raise RuntimeError("Cloud Tasks unavailable")

    monkeypatch.setattr(theme_mod, "_get_tasks_client", lambda: FailingClient())

    import sys

    class MockTasksV2:
        class Task:
            def __init__(self, **kwargs): pass
        class HttpRequest:
            def __init__(self, **kwargs): pass
        class HttpMethod:
            POST = "POST"
        class OAuthToken:
            def __init__(self, **kwargs): pass
        CloudTasksClient = FailingClient

    monkeypatch.setitem(sys.modules, "google.cloud.tasks_v2", MockTasksV2())

    r = admin_client.put(
        f"/api/admin/clubs/{club_id}/theme",
        json={"seed_brand": "#FF5A00"},
    )

    assert r.status_code == 503
    assert "ok" not in r.json() or r.json().get("ok") is not True

    # theme_job persisted in failed state
    reg = org.get_registry()
    club = reg.get_club(club_id)
    assert club.theme_job["status"] == "failed"
    assert "manual enqueue failed" in (club.theme_job.get("reason") or "")


# ─── F5: Idempotent retry — same lease returns same job ──────────────────


def test_retry_after_success_is_idempotent(admin_client, club_id):
    """F5: After a succeeded job, retry returns 409 (not a failure state)."""
    # Generate
    r = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/generate",
        json={"homepage_url": "https://example.com"},
    )
    assert r.status_code == 202
    job_id = r.json()["themeJob"]["lease"]["holder"]

    # Complete the job via callback
    r_done = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/result",
        json={
            "status": "succeeded",
            "theme": {"clubId": club_id, "status": "active", "gate": {"passed": True}},
            "jobId": job_id,
            "sourceUrl": "https://example.com",
        },
        headers=_result_headers(),
    )
    assert r_done.status_code == 200

    # Retry on succeeded → 409 (not a failure state)
    r_retry = admin_client.post(f"/api/admin/clubs/{club_id}/theme/retry")
    assert r_retry.status_code == 409


# ─── F5: Both entry points share the same result callback format ─────────


def test_both_entry_points_same_callback_contract(admin_client, club_id):
    """F5: The result callback endpoint accepts the same payload shape
    regardless of which entry point created the job.
    """
    # URL path
    r1 = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/generate",
        json={"homepage_url": "https://example.com"},
    )
    assert r1.status_code == 202
    job1_id = r1.json()["themeJob"]["lease"]["holder"]

    # Complete URL job
    r1_done = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/result",
        json={"status": "succeeded", "theme": {"clubId": club_id, "status": "active"}, "jobId": job1_id, "sourceUrl": "https://example.com"},
        headers=_result_headers(),
    )
    assert r1_done.status_code == 200

    # Manual path (clear lease first)
    reg = org.get_registry()
    club = reg.get_club(club_id)
    club.theme_job["lease"] = {"holder": "", "expiresAt": None}
    club.theme_job["status"] = "failed"
    club.theme_job["finishedAt"] = "2026-01-01T00:00:00Z"
    reg.upsert_club(club)

    r2 = admin_client.put(
        f"/api/admin/clubs/{club_id}/theme",
        json={"seed_brand": "#00FF00"},
    )
    assert r2.status_code == 200
    job2_id = r2.json()["themeJob"]["lease"]["holder"]

    # Complete manual job with the SAME callback format
    r2_done = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/result",
        json={"status": "succeeded", "theme": {"clubId": club_id, "status": "draft"}, "jobId": job2_id, "sourceUrl": ""},
        headers=_result_headers(),
    )
    assert r2_done.status_code == 200
    assert r2_done.json()["status"] == "succeeded"
