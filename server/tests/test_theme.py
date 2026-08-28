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
    assert r.status_code == 202
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
    assert r.status_code == 202
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
    task_id = theme_mod._enqueue_generation_task("club_x", "https://example.com", "lease-test-1")
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
    monkeypatch.setenv("GCP_TASK_INVOKER_SA", "biq-task-invoker@test-project.iam.gserviceaccount.com")

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
    # C4: Mock now includes OAuthToken (not OidcToken)
    class MockTasksV2:
        class Task:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

        class HttpRequest:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

        class HttpMethod:
            POST = "POST"

        class OAuthToken:
            def __init__(self, **kwargs):
                pass

        CloudTasksClient = MockCloudTasksClient

    mock_client = MockCloudTasksClient()

    # Patch _get_tasks_client to return our mock
    monkeypatch.setattr(theme_mod, "_get_tasks_client", lambda: mock_client)
    # Patch the tasks_v2 import inside the function
    import sys
    monkeypatch.setitem(sys.modules, "google.cloud.tasks_v2", MockTasksV2())

    task_id = theme_mod._enqueue_generation_task("club_test", "https://example.com", "lease-test-1")

    # Verify the task ID is from the created task
    assert task_id == "fake-task-123"

    # Verify create_task was called with the right payload
    assert len(mock_client.create_task_calls) == 1
    call = mock_client.create_task_calls[0]
    assert "parent" in call
    assert "club-theme-generation" in call["parent"]
    assert "task" in call

    # Regression guard (2026-09-02 stuck-at-"pending" incident): the Cloud
    # Run Admin API v2 RunJobRequest only recognizes {validateOnly, etag,
    # overrides} at the top level. A body of {"containerOverrides": [...]}
    # instead of {"overrides": {"containerOverrides": [...]}} is silently
    # rejected with INVALID_ARGUMENT by run.googleapis.com — Cloud Tasks
    # retries exhaust and the job never runs, with no visible error to the
    # caller. Assert the real wire shape, not just presence of the kwarg.
    #
    # Note: `from google.cloud import tasks_v2` inside _enqueue_generation_task
    # resolves to the REAL tasks_v2 module here, not MockTasksV2 above —
    # `sys.modules` patching doesn't override an already-imported package
    # attribute (google.cloud.tasks_v2 gets imported for real elsewhere in
    # the test session first). So `call["task"]` is a real protobuf Task;
    # read its fields directly instead of assuming the Mock* `.kwargs` shape.
    task_obj = call["task"]
    if hasattr(task_obj, "kwargs"):  # the mock path did take effect
        body_bytes = task_obj.kwargs["http_request"].kwargs["body"]
    else:  # real protobuf Task/HttpRequest
        body_bytes = task_obj.http_request.body
    body = json.loads(body_bytes)
    assert "overrides" in body, (
        "RunJobRequest body must nest containerOverrides under 'overrides' "
        "or the Cloud Run Admin API rejects it with INVALID_ARGUMENT"
    )
    assert "containerOverrides" not in body, "containerOverrides must not be a top-level key"
    assert "containerOverrides" in body["overrides"]
    env_names = {e["name"] for e in body["overrides"]["containerOverrides"][0]["env"]}
    assert {"CLUB_ID", "SOURCE_URL", "LEASE_ID"} <= env_names

    # Clean up
    monkeypatch.delenv("BIQ_CLOUD_TASKS_QUEUE", raising=False)


def test_enqueue_run_job_request_body_has_overrides_wrapper(monkeypatch):
    """F5 regression test: the Cloud Run Admin API v2 RunJob method
    (POST .../jobs/{job}:run) requires the HTTP body to be a RunJobRequest,
    which wraps containerOverrides inside an "overrides" field:

        {"overrides": {"containerOverrides": [...]}}

    Sending containerOverrides at the top level (missing the "overrides"
    wrapper) is rejected by Cloud Run's schema validation with
    INVALID_ARGUMENT before the job is ever triggered. Cloud Tasks then
    exhausts retries and silently drops the task — no job execution, no
    audit trail (confirmed live on staging: task_operations_log showed
    status=INVALID_ARGUMENT with ~15-25ms response times, i.e. Cloud Run's
    API rejecting the request at validation, not attempting to run it).

    This test captures the actual JSON body passed to HttpRequest and
    asserts it matches the RunJobRequest schema.

    Note on mocking strategy: we import the REAL google.cloud.tasks_v2
    module and monkeypatch its classes in place (setattr on the module
    object). This works regardless of whether the package was already
    imported and cached as an attribute on google.cloud — which is the
    exact failure mode that broke the earlier version of this test in CI
    (where google-cloud-tasks IS installed). Replacing sys.modules alone
    does not update the cached attribute, so _enqueue_generation_task's
    `from google.cloud import tasks_v2` still resolved to the real module.
    """
    import json

    monkeypatch.setenv("BIQ_CLOUD_TASKS_QUEUE", "club-theme-generation")
    monkeypatch.setenv("GCP_PROJECT_ID", "test-project")
    monkeypatch.setenv("GCP_TASKS_LOCATION", "europe-west1")
    monkeypatch.setenv("GCP_TASK_INVOKER_SA", "biq-task-invoker@test-project.iam.gserviceaccount.com")

    from biq_onboard_server.routers import theme as theme_mod

    # Import the real module and patch its classes in place. This works
    # whether or not the package is installed (CI) or absent (local dev
    # without google-cloud-tasks). If the package is absent, we skip —
    # the test is only meaningful in an environment where the production
    # code path can actually execute.
    try:
        from google.cloud import tasks_v2 as real_tasks_v2
    except ImportError:
        pytest.skip("google-cloud-tasks not installed; cannot test real module patching")

    captured_http_request_kwargs = {}

    class CapturingHttpRequest:
        def __init__(self, **kwargs):
            captured_http_request_kwargs.update(kwargs)

    class MockCreatedTask:
        name = "projects/test-project/locations/europe-west1/queues/club-theme-generation/tasks/fake-task-456"

    class MockCloudTasksClient:
        def queue_path(self, project, location, queue):
            return f"projects/{project}/locations/{location}/queues/{queue}"

        def create_task(self, request):
            return MockCreatedTask()

    mock_client = MockCloudTasksClient()
    monkeypatch.setattr(theme_mod, "_get_tasks_client", lambda: mock_client)

    # Patch the real module's classes in place — this updates the actual
    # object that `from google.cloud import tasks_v2` resolves to, whether
    # it was imported fresh or retrieved from a cached attribute.
    monkeypatch.setattr(real_tasks_v2, "HttpRequest", CapturingHttpRequest)
    monkeypatch.setattr(real_tasks_v2, "OAuthToken", type("OAuthToken", (), {"__init__": lambda self, **kw: None}))
    # Task and HttpMethod are also used by _enqueue_generation_task
    monkeypatch.setattr(real_tasks_v2, "Task", type("Task", (), {"__init__": lambda self, **kw: None}))
    monkeypatch.setattr(real_tasks_v2, "HttpMethod", type("HttpMethod", (), {"POST": "POST"}))

    theme_mod._enqueue_generation_task("club_test2", "https://example.com", "lease-test-2")

    assert "body" in captured_http_request_kwargs, (
        "HttpRequest was never called with a body — the real tasks_v2.HttpRequest "
        "was used instead of the mock. This means the in-place patch did not take "
        "effect, which would indicate the module was cached differently than expected."
    )
    body = json.loads(captured_http_request_kwargs["body"])

    # The body MUST be a RunJobRequest: {"overrides": {"containerOverrides": [...]}}
    assert "overrides" in body, (
        f"RunJob request body is missing the required 'overrides' wrapper "
        f"field (schema: RunJobRequest). Got top-level keys: {list(body.keys())}"
    )
    assert "containerOverrides" in body["overrides"]
    assert isinstance(body["overrides"]["containerOverrides"], list)
    env_names = {e["name"] for e in body["overrides"]["containerOverrides"][0]["env"]}
    assert "CLUB_ID" in env_names
    assert "SOURCE_URL" in env_names
    assert "LEASE_ID" in env_names

    # Regression guard: containerOverrides must NOT be a top-level key —
    # that was the exact bug (missing overrides wrapper).
    assert "containerOverrides" not in body

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


# ─── C2: S2S identity resolution for theme routes ──────────────────────


def test_s2s_theme_get_with_valid_bearer_and_admin(client, monkeypatch):
    """C2: Theme GET with valid S2S bearer + admin identity succeeds."""
    monkeypatch.setenv("BIQ_ONBOARD_S2S_SECRET", "test-s2s-secret")
    # Create a club + admin membership via the onboarding flow
    from biq_onboard_server import org
    from biq_core.org import Club, User

    reg = org.get_registry()
    reg.upsert_club(Club(id="c2test", name="C2 Test", status="active"))
    reg.upsert_user(User(id="u_admin", club_id="c2test", email="admin@test.io",
                         display_name="Admin", role="administrator", status="active"))
    # Assign admin role in roles registry (use org.get_roles() for memory store)
    from biq_core.roles import RoleAssignment
    rr = org.get_roles()
    rr.put_assignment(RoleAssignment(user_id="u_admin", role="administrator", scope="club:c2test"))

    resp = client.get(
        "/api/admin/clubs/c2test/theme",
        headers={
            "Authorization": "Bearer test-s2s-secret",
            "X-BIQ-Acting-User-Id": "u_admin",
            "X-BIQ-Acting-Email": "admin@test.io",
        },
    )
    assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"


def test_s2s_theme_get_with_bad_token_returns_401(client, monkeypatch):
    """C2: Theme GET with bad S2S bearer returns 401 (fail-closed)."""
    monkeypatch.setenv("BIQ_ONBOARD_S2S_SECRET", "test-s2s-secret")
    resp = client.get(
        "/api/admin/clubs/c2test/theme",
        headers={
            "Authorization": "Bearer wrong-token",
            "X-BIQ-Acting-User-Id": "u_admin",
            "X-BIQ-Acting-Email": "admin@test.io",
        },
    )
    assert resp.status_code == 401


def test_s2s_theme_get_with_missing_bearer_returns_401(client, monkeypatch):
    """C2: Theme GET with S2S configured but no bearer returns 401."""
    monkeypatch.setenv("BIQ_ONBOARD_S2S_SECRET", "test-s2s-secret")
    resp = client.get(
        "/api/admin/clubs/c2test/theme",
        headers={
            "X-BIQ-Acting-User-Id": "u_admin",
            "X-BIQ-Acting-Email": "admin@test.io",
        },
    )
    assert resp.status_code == 401


def test_s2s_theme_get_with_non_admin_returns_403(client, monkeypatch):
    """V18: Theme GET is readable by any active club member."""
    monkeypatch.setenv("BIQ_ONBOARD_S2S_SECRET", "test-s2s-secret")
    from biq_onboard_server import org
    from biq_core.org import Club, User

    reg = org.get_registry()
    reg.upsert_club(Club(id="c2test2", name="C2 Test 2", status="active"))
    reg.upsert_user(User(id="u_coach", club_id="c2test2", email="coach@test.io",
                         display_name="Coach", role="coach", status="active"))

    resp = client.get(
        "/api/admin/clubs/c2test2/theme",
        headers={
            "Authorization": "Bearer test-s2s-secret",
            "X-BIQ-Acting-User-Id": "u_coach",
            "X-BIQ-Acting-Email": "coach@test.io",
        },
    )
    assert resp.status_code == 200


def test_s2s_theme_get_missing_user_id_returns_403(client, monkeypatch):
    """C2: S2S request with valid token but missing X-BIQ-Acting-User-Id returns 403."""
    monkeypatch.setenv("BIQ_ONBOARD_S2S_SECRET", "test-s2s-secret")
    resp = client.get(
        "/api/admin/clubs/c2test/theme",
        headers={
            "Authorization": "Bearer test-s2s-secret",
            "X-BIQ-Acting-Email": "admin@test.io",
        },
    )
    assert resp.status_code == 403


# ─── C9: Result callback state transition tests ────────────────────────


def test_result_rejects_terminal_to_running_regression(client, monkeypatch):
    """C9: A terminal job cannot regress to running."""
    monkeypatch.setenv("BIQ_THEME_JOB_RESULT_TOKEN", "result-token")
    from biq_onboard_server import org
    from biq_core.org import Club
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    reg = org.get_registry()
    reg.upsert_club(Club(id="c9test", name="C9 Test", status="active",
                         theme_job={
                             "status": "succeeded",
                             "sourceUrl": "https://example.com",
                             "lease": {"holder": "lease-1", "expiresAt": None},
                             "finishedAt": now,
                         }))

    resp = client.post(
        "/api/admin/clubs/c9test/theme/result",
        json={"status": "running", "jobId": "lease-1", "sourceUrl": "https://example.com"},
        headers={"Authorization": "Bearer result-token"},
    )
    assert resp.status_code == 409
    assert "regress" in resp.json()["detail"].lower()


def test_result_rejects_missing_job_id(client, monkeypatch):
    """C9: Missing jobId is rejected (422 — required field)."""
    monkeypatch.setenv("BIQ_THEME_JOB_RESULT_TOKEN", "result-token")
    resp = client.post(
        "/api/admin/clubs/c9test/theme/result",
        json={"status": "running", "sourceUrl": "https://example.com"},
        headers={"Authorization": "Bearer result-token"},
    )
    assert resp.status_code == 422  # Pydantic validation error


def test_result_rejects_source_url_mismatch(client, monkeypatch):
    """C9: Source URL mismatch is rejected."""
    monkeypatch.setenv("BIQ_THEME_JOB_RESULT_TOKEN", "result-token")
    from biq_onboard_server import org
    from biq_core.org import Club

    reg = org.get_registry()
    reg.upsert_club(Club(id="c9test2", name="C9 Test 2", status="active",
                         theme_job={
                             "status": "pending",
                             "sourceUrl": "https://original.com",
                             "lease": {"holder": "lease-2", "expiresAt": None},
                         }))

    resp = client.post(
        "/api/admin/clubs/c9test2/theme/result",
        json={"status": "running", "jobId": "lease-2", "sourceUrl": "https://different.com"},
        headers={"Authorization": "Bearer result-token"},
    )
    assert resp.status_code == 409
    assert "source url" in resp.json()["detail"].lower()


# ─── R7: Rate-limit history preservation ───────────────────────────────


def test_r7_history_preserved_across_replacement(monkeypatch):
    """R7: When generate_theme() creates a new theme_job, prior history
    must be preserved so the 5/hour + 20/day counters accumulate.
    """
    from biq_onboard_server.routers import theme
    from biq_onboard_server import org
    from biq_core.org import Club
    from datetime import datetime, timezone

    org.reset_for_tests()
    monkeypatch.delenv("BIQ_CLOUD_TASKS_QUEUE", raising=False)

    reg = org.get_registry()
    # Seed a club with existing history (3 prior attempts)
    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    reg.upsert_club(Club(
        id="r7club",
        name="R7 Club",
        website="https://example.com",
        status="active",
        theme_job={
            "status": "failed",
            "sourceUrl": "https://example.com",
            "history": [
                {"sourceUrl": "https://example.com", "requestedAt": now_iso},
                {"sourceUrl": "https://example.com", "requestedAt": now_iso},
                {"sourceUrl": "https://example.com", "requestedAt": now_iso},
            ],
        },
    ))

    # Check rate limit — should see 3 attempts, allow more
    assert theme._check_rate_limit("r7club", "https://example.com") == True

    # Now generate a new theme — history should be preserved + new entry added
    # Clear the lease so generate doesn't see an active job, but keep history
    club = reg.get_club("r7club")
    club.theme_job["lease"] = None
    club.theme_job["status"] = "failed"
    club.theme_job["finishedAt"] = now_iso
    reg.upsert_club(club)

    # Use the generate endpoint via the test client
    from biq_onboard_server.app import create_app
    from fastapi.testclient import TestClient
    c = TestClient(create_app())
    c.post("/api/auth/login", json={"username": "admin", "password": "T3st1ng!"})

    resp = c.post("/api/admin/clubs/r7club/theme/generate",
                  json={"homepage_url": "https://example.com"})
    assert resp.status_code == 202, resp.text

    # Verify history was preserved (3 prior + 1 new = 4)
    club = reg.get_club("r7club")
    history = club.theme_job.get("history", [])
    assert len(history) == 4, \
        f"R7: History should have 4 entries (3 prior + 1 new), got {len(history)}"


def test_r7_rate_limit_5_per_hour(monkeypatch):
    """R7: 6th attempt within 1 hour should be rejected."""
    from biq_onboard_server.routers import theme
    from biq_onboard_server import org
    from biq_core.org import Club
    from datetime import datetime, timezone, timedelta

    org.reset_for_tests()
    reg = org.get_registry()
    now = datetime.now(timezone.utc)
    # Create 5 entries within the last hour
    history = []
    for i in range(5):
        ts = (now - timedelta(minutes=i * 5)).isoformat().replace("+00:00", "Z")
        history.append({"sourceUrl": "https://example.com", "requestedAt": ts})

    reg.upsert_club(Club(
        id="r7hour",
        name="R7 Hour Club",
        website="https://example.com",
        status="active",
        theme_job={
            "status": "failed",
            "sourceUrl": "https://example.com",
            "history": history,
        },
    ))

    # 6th attempt should be rejected
    assert theme._check_rate_limit("r7hour", "https://example.com") == False, \
        "R7: 6th attempt within 1 hour should be rate-limited"


def test_r7_rate_limit_20_per_day(monkeypatch):
    """R7: 21st attempt within 1 day should be rejected."""
    from biq_onboard_server.routers import theme
    from biq_onboard_server import org
    from biq_core.org import Club
    from datetime import datetime, timezone, timedelta

    org.reset_for_tests()
    reg = org.get_registry()
    now = datetime.now(timezone.utc)
    # Create 20 entries within the last day, spread >1hr apart so hour limit doesn't hit
    # 20 entries over 23 hours: each ~1.15 hours apart, 5 per hour max
    history = []
    for i in range(20):
        # Spread: 0.1, 1.2, 2.3, ... hours ago — within 24h, >1hr apart groups
        ts = (now - timedelta(minutes=int(i * 70))).isoformat().replace("+00:00", "Z")
        history.append({"sourceUrl": "https://example.com", "requestedAt": ts})

    reg.upsert_club(Club(
        id="r7day",
        name="R7 Day Club",
        website="https://example.com",
        status="active",
        theme_job={
            "status": "failed",
            "sourceUrl": "https://example.com",
            "history": history,
        },
    ))

    # 21st attempt should be rejected
    assert theme._check_rate_limit("r7day", "https://example.com") == False, \
        "R7: 21st attempt within 1 day should be rate-limited"


def test_r7_rate_limit_url_separation(monkeypatch):
    """R7: Rate limits are per club + normalized URL — different URLs don't count."""
    from biq_onboard_server.routers import theme
    from biq_onboard_server import org
    from biq_core.org import Club
    from datetime import datetime, timezone, timedelta

    org.reset_for_tests()
    reg = org.get_registry()
    now = datetime.now(timezone.utc)
    # 5 attempts to example.com
    history = []
    for i in range(5):
        ts = (now - timedelta(minutes=i * 5)).isoformat().replace("+00:00", "Z")
        history.append({"sourceUrl": "https://example.com", "requestedAt": ts})

    reg.upsert_club(Club(
        id="r7url",
        name="R7 URL Club",
        website="https://example.com",
        status="active",
        theme_job={
            "status": "failed",
            "sourceUrl": "https://example.com",
            "history": history,
        },
    ))

    # Same URL — should be rate-limited
    assert theme._check_rate_limit("r7url", "https://example.com") == False
    # Different URL — should be allowed
    assert theme._check_rate_limit("r7url", "https://other.com") == True
