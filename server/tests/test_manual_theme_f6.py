"""F6 — Manual color entry reachable without prior theme object.

Defect F6: renderClubDetails() only rendered the manual color picker when
a `theme` object already existed. Since automatic generation (F5) currently
fails before producing a theme, manual entry — the intended fallback — was
completely inaccessible.

This test confirms the server-side contract: PUT /api/admin/clubs/{id}/theme
with manual seeds succeeds and persists a draft theme even when no prior
theme/theme_job exists for the club. The UI fix (rendering the picker
always) is validated by the build succeeding with the updated renderClubDetails.
"""

from __future__ import annotations

import pytest
from biq_onboard_server import org
from biq_onboard_server.app import create_app
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch):
    """Fresh app with dev-mode Cloud Tasks (no real GCP calls)."""
    monkeypatch.delenv("BIQ_CLOUD_TASKS_QUEUE", raising=False)
    monkeypatch.setenv("BIQ_THEME_JOB_RESULT_TOKEN", "test-f6-token")
    org.reset_for_tests()
    app = create_app()
    return TestClient(app)


@pytest.fixture
def admin_client(client):
    client.post("/api/auth/login", json={"username": "admin", "password": "T3st1ng!"})
    return client


@pytest.fixture
def club_id(admin_client):
    cid = "f6_manual_club"
    admin_client.post("/api/admin/clubs", json={"id": cid, "name": "F6 Manual Club"})
    return cid


def test_manual_theme_submission_succeeds_without_prior_theme(admin_client, club_id):
    """F6: PUT /theme with manual seeds must succeed even when no prior
    theme or theme_job exists for the club.

    This is the server-side contract that makes the manual picker usable
    as a fallback when automatic extraction hasn't run or has failed.
    """
    # Verify no theme exists yet (GET may return 200 with null theme or 404)
    resp = admin_client.get(f"/api/admin/clubs/{club_id}/theme")
    if resp.status_code == 200:
        assert resp.json().get("theme") is None, "club should have no theme before manual submission"

    # Submit manual colors
    resp = admin_client.put(f"/api/admin/clubs/{club_id}/theme", json={
        "seed_brand": "#FF5A00",
        "seed_brand_alt": "#0A153A",
    })
    assert resp.status_code == 200, f"manual submission must succeed: {resp.text}"
    data = resp.json()
    assert data.get("ok") is True
    assert data.get("theme", {}).get("status") == "draft"
    assert data["theme"]["seed"]["brand"] == "#FF5A00"
    assert data["theme"]["seed"]["brandAlt"] == "#0A153A"
    assert data["theme"]["source"]["kind"] == "manual"

    # Verify theme is now persisted and readable
    resp = admin_client.get(f"/api/admin/clubs/{club_id}/theme")
    assert resp.status_code == 200
    theme = resp.json()["theme"]
    assert theme["status"] == "draft"
    assert theme["seed"]["brand"] == "#FF5A00"
    assert theme["seed"]["detectedFrom"] == "manual"


def test_manual_theme_persists_draft_even_if_enqueue_fails(monkeypatch, admin_client, club_id):
    """F6: The manual theme draft is persisted even when the enqueue step
    fails (e.g. IAM issue from F5). The PUT returns 503 but the theme
    draft is stored, so the UI can still show it on reload.

    This ensures the manual fallback is resilient: the admin's color
    choice is never lost due to an infrastructure failure.
    """
    # Simulate enqueue failure by setting a queue env without real GCP access
    monkeypatch.setenv("BIQ_CLOUD_TASKS_QUEUE", "club-theme-generation")
    monkeypatch.setenv("GCP_PROJECT_ID", "fake-project")
    monkeypatch.setenv("GCP_TASKS_QUEUE", "club-theme-generation")
    monkeypatch.setenv("GCP_TASKS_LOCATION", "europe-west1")
    monkeypatch.setenv("GCP_THEME_JOB_NAME", "club-theme-generation")
    monkeypatch.setenv("GCP_TASK_INVOKER_SA", "invoker@fake-project.iam.gserviceaccount.com")

    # The _get_tasks_client() will try to create a real client and may
    # succeed (library installed), but create_task will fail because the
    # project/queue doesn't exist. Either way, the 503 is expected.
    resp = admin_client.put(f"/api/admin/clubs/{club_id}/theme", json={
        "seed_brand": "#FF5A00",
        "seed_brand_alt": None,
    })
    # 503 is expected — enqueue failed. But the theme draft should be persisted.
    assert resp.status_code == 503

    # Verify the theme draft was still persisted (resilient fallback)
    resp = admin_client.get(f"/api/admin/clubs/{club_id}/theme")
    assert resp.status_code == 200
    theme = resp.json()["theme"]
    assert theme["status"] == "draft"
    assert theme["seed"]["brand"] == "#FF5A00"
    assert theme["source"]["kind"] == "manual"
