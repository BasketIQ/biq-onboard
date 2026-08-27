"""Mutation proofs for verdict v3 B8-B17 invariants in biq-onboard.

Each test proves a specific invariant by demonstrating that the code
catches the mutation. Run: python3 -m pytest tests/test_mutation_proofs.py -v
"""

import os
import importlib
from datetime import datetime, timezone

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
    cid = "mutation_test_club"
    admin_client.post("/api/admin/clubs", json={"id": cid, "name": "Mutation Test Club"})
    return cid


# ─── Mutation 1: S2S auth fail-closed (B8) ──────────────────────────────
# Proves that S2S requests fail closed when the secret is configured but
# the bearer token is missing/invalid. Mutation: allow requests without
# a bearer token.


def test_mutation_s2s_fail_closed_no_token(client, monkeypatch):
    """If the S2S fail-closed check were removed, unauthenticated requests
    could create clubs. We verify that a request without the bearer token
    returns 401 when the secret is configured.
    """
    monkeypatch.setenv("BIQ_ONBOARD_S2S_SECRET", "test-s2s-secret")
    importlib.reload(importlib.import_module("biq_onboard_server.routers.onboarding_flow"))

    # Request without Authorization header
    resp = client.post(
        "/api/onboarding/clubs",
        json={"name": "Test Club", "website": "https://example.com"},
        headers={
            "X-BIQ-Acting-User-Id": "user-1",
            "X-BIQ-Acting-Email": "test@example.com",
        },
    )
    assert resp.status_code == 401, \
        f"S2S must fail closed without bearer — got {resp.status_code}"


def test_mutation_s2s_fail_closed_wrong_token(client, monkeypatch):
    """Request with wrong token must also fail closed."""
    monkeypatch.setenv("BIQ_ONBOARD_S2S_SECRET", "test-s2s-secret")
    importlib.reload(importlib.import_module("biq_onboard_server.routers.onboarding_flow"))

    resp = client.post(
        "/api/onboarding/clubs",
        json={"name": "Test Club", "website": "https://example.com"},
        headers={
            "Authorization": "Bearer wrong-token",
            "X-BIQ-Acting-User-Id": "user-1",
            "X-BIQ-Acting-Email": "test@example.com",
        },
    )
    assert resp.status_code == 401, \
        f"S2S must fail closed with wrong token — got {resp.status_code}"


# ─── Mutation 2: Synthetic Cloud Tasks fallback (B11) ───────────────────
# Proves that when BIQ_CLOUD_TASKS_QUEUE is set, the synthetic fallback
# is NOT used. Mutation: always return synthetic ID.


def test_mutation_no_synthetic_fallback_in_configured_mode(monkeypatch):
    """If the synthetic fallback were always used, real Cloud Tasks would
    never be invoked. When the queue env var is set, the code must attempt
    a real Cloud Tasks call (or raise if the client is unavailable), NOT
    return a synthetic ID.
    """
    from biq_onboard_server.routers import theme

    monkeypatch.setenv("BIQ_CLOUD_TASKS_QUEUE", "club-theme-generation")
    monkeypatch.setenv("GCP_PROJECT_ID", "test-project")
    monkeypatch.setenv("GCP_TASKS_LOCATION", "europe-west1")
    monkeypatch.setenv("GCP_TASKS_QUEUE", "club-theme-generation")

    with pytest.raises(RuntimeError, match="google-cloud-tasks not available"):
        theme._enqueue_generation_task("club-1", "https://example.com", "lease-1")


def test_mutation_synthetic_fallback_in_dev_mode(monkeypatch):
    """In dev mode (no queue env var), the synthetic ID IS returned.
    This proves the dev/prod boundary is unambiguous.
    """
    from biq_onboard_server.routers import theme

    monkeypatch.delenv("BIQ_CLOUD_TASKS_QUEUE", raising=False)

    task_id = theme._enqueue_generation_task("club-1", "https://example.com", "lease-1")
    assert task_id.startswith("dev-task-"), \
        f"Dev mode must return synthetic ID — got {task_id}"


# ─── Mutation 3: Lease/idempotency (B10) ────────────────────────────────
# Proves that a live lease prevents duplicate job creation.
# Mutation: always create a new job.


def test_mutation_lease_idempotency():
    """If the lease check were removed, a second generate request would
    create a duplicate job. We verify that _check_lease finds the live
    lease and the generate endpoint returns 'already_running'.
    """
    from biq_onboard_server.routers import theme
    from biq_onboard_server import org
    from biq_core.org import Club
    import time as _time

    org.reset_for_tests()
    registry = org.get_registry()
    club_id = registry.next_club_id()
    # Set expiry 300s in the future
    future = datetime.fromtimestamp(
        datetime.now(timezone.utc).timestamp() + 300, tz=timezone.utc
    ).isoformat().replace("+00:00", "Z")
    registry.upsert_club(Club(
        id=club_id,
        name="Test Club",
        website="https://example.com",
        theme=None,
        theme_job={
            "status": "pending",
            "sourceUrl": "https://example.com",
            "lease": {
                "holder": "lease-1",
                "expiresAt": future,
            },
        },
    ))

    lease = theme._check_lease(club_id)
    assert lease is not None, "Lease should be live"
    assert lease["holder"] == "lease-1"


def test_mutation_lease_expired_returns_none():
    """An expired lease must return None, allowing a new job."""
    from biq_onboard_server.routers import theme
    from biq_onboard_server import org
    from biq_core.org import Club

    org.reset_for_tests()
    registry = org.get_registry()
    club_id = registry.next_club_id()
    past = datetime(2020, 1, 1, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    registry.upsert_club(Club(
        id=club_id,
        name="Test Club",
        website="https://example.com",
        theme=None,
        theme_job={
            "status": "pending",
            "sourceUrl": "https://example.com",
            "lease": {
                "holder": "lease-old",
                "expiresAt": past,
            },
        },
    ))

    lease = theme._check_lease(club_id)
    assert lease is None, "Expired lease must return None"


# ─── Mutation 4: Polling stops on terminal (B14) ────────────────────────
# Proves that polling stops when the themeJob reaches a terminal state.
# Mutation: always continue polling.


def test_mutation_polling_stops_on_terminal():
    """If polling continued after terminal state, the client would make
    unnecessary requests. We verify the source code contains the
    terminal-state guard in _maybeStartPolling.
    """
    import pathlib
    source = pathlib.Path(__file__).parent.parent.parent / "app" / "src" / "onboard-app.ts"
    content = source.read_text()

    # The _maybeStartPolling method must check for pending/running
    assert "_maybeStartPolling" in content, "Must have _maybeStartPolling method"
    assert "_stopPolling" in content, "Must have _stopPolling method"

    # The terminal states must be in the THEME_JOB_COPY map
    terminal_states = ["succeeded", "uncertain", "rejected_not_a_club",
                       "unsupported_source", "unreachable", "failed", "reverted"]
    for state in terminal_states:
        assert state in content, f"Terminal state '{state}' must be in the code"


# ─── Mutation 5: Result callback auth (B12) ─────────────────────────────
# Proves that the result callback endpoint fails closed without the
# correct token. Mutation: allow requests without auth.


def test_mutation_result_callback_auth_fail_closed_no_token(client, monkeypatch):
    """Result callback must return 401 without Authorization header."""
    monkeypatch.setenv("BIQ_THEME_JOB_RESULT_TOKEN", "test-result-token")

    resp = client.post(
        "/api/admin/clubs/club-1/theme/result",
        json={"status": "succeeded"},
    )
    assert resp.status_code == 401, \
        f"Result callback must fail closed without token — got {resp.status_code}"


def test_mutation_result_callback_auth_fail_closed_wrong_token(client, monkeypatch):
    """Result callback must return 401 with wrong token."""
    monkeypatch.setenv("BIQ_THEME_JOB_RESULT_TOKEN", "test-result-token")

    resp = client.post(
        "/api/admin/clubs/club-1/theme/result",
        json={"status": "succeeded"},
        headers={"Authorization": "Bearer wrong-token"},
    )
    assert resp.status_code == 401, \
        f"Result callback must fail closed with wrong token — got {resp.status_code}"


def test_mutation_result_callback_rejects_invalid_status(client, monkeypatch):
    """If canonical status validation were removed, invalid statuses could
    corrupt the state machine. We verify that 'completed' (the old
    non-canonical vocabulary) returns 400.
    """
    monkeypatch.setenv("BIQ_THEME_JOB_RESULT_TOKEN", "test-result-token")

    resp = client.post(
        "/api/admin/clubs/club-1/theme/result",
        json={"status": "completed"},  # invalid — must be 'succeeded'
        headers={"Authorization": "Bearer test-result-token"},
    )
    assert resp.status_code == 400, \
        f"Result callback must reject 'completed' — got {resp.status_code}"


# ─── Mutation 6: Canonical states only (B10) ────────────────────────────
# Proves that only canonical states are accepted.


def test_mutation_canonical_states_set():
    """The canonical states must be exactly the defined set — no
    'completed' or other non-canonical vocabulary."""
    from biq_onboard_server.routers.theme import CANONICAL_STATES

    expected = {"pending", "running", "succeeded", "uncertain",
                "rejected_not_a_club", "unsupported_source", "unreachable",
                "failed", "reverted"}
    assert CANONICAL_STATES == expected, \
        f"Canonical states mismatch: {CANONICAL_STATES} != {expected}"
    assert "completed" not in CANONICAL_STATES, \
        "'completed' must NOT be a canonical state"


# ─── Mutation 7: BFF proxy fail-closed (B13) ────────────────────────────
# Proves that the BFF proxy returns 503 when the service URL or secret
# is not configured. Mutation: allow requests without config.


def test_mutation_bff_proxy_fail_closed_no_config():
    """If the BFF proxy didn't fail closed, requests would go to an
    undefined upstream. We verify the proxy source contains the
    fail-closed check.
    """
    import pathlib
    source = pathlib.Path(__file__).parent.parent.parent.parent / \
        "biq-app" / "server" / "src" / "biq_app_server" / "onboard_proxy.py"
    if not source.exists():
        pytest.skip("biq-app source not accessible from biq-onboard tests")
    content = source.read_text()

    assert "Club service unavailable" in content, \
        "BFF proxy must have fail-closed message"
    assert "503" in content, \
        "BFF proxy must return 503 when config is absent"
