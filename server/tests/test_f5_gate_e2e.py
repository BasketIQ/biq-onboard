"""F5 end-to-end test: simulate job result callback with a gate-passing theme.

This test exercises the full backend flow that the Cloud Run Job triggers:
1. Generate endpoint creates a pending theme_job (with mocked Cloud Tasks)
2. Job posts a gate-passing theme to /theme/result
3. Frontend polls /theme and sees the draft theme
4. Frontend posts /theme/activate to promote draft → active
5. Frontend polls /theme and sees the active theme

The theme payload includes repaired tokens (action-ghost-text moved from
step 700 to 500 by the repair algorithm) to verify the backend stores them.
"""

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
    cid = "test_f5_gate_club"
    admin_client.post("/api/admin/clubs", json={"id": cid, "name": "F5 Gate Club"})
    return cid


@pytest.fixture
def pending_job(admin_client, club_id, monkeypatch):
    """Create a pending theme_job by calling generate with dev-mode (no Cloud Tasks)."""
    # Disable Cloud Tasks to use dev-mode synthetic task creation
    monkeypatch.delenv("BIQ_CLOUD_TASKS_QUEUE", raising=False)
    from biq_onboard_server.routers import theme as theme_mod
    monkeypatch.setattr(theme_mod, "_tasks_client", None)

    r = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/generate",
        json={"homepage_url": "https://example.com"},
    )
    assert r.status_code == 202, f"generate failed: {r.text}"
    return club_id


def _gate_passing_theme(club_id: str) -> dict:
    """Build a theme payload with a gate that passed, including repaired tokens."""
    return {
        "schemaVersion": 1,
        "generatorVersion": "1.0.0",
        "clubId": club_id,
        "status": "draft",
        "source": {
            "kind": "extracted",
            "homepageUrl": "https://example.com",
            "extractedAt": "2026-08-29T20:00:00Z",
            "confidence": 0.8,
        },
        "seed": {"brand": "#FF5A00", "brandAlt": "", "detectedFrom": "css-vars"},
        "logo": None,
        "tokens": {
            "light": {
                "--biq-color-brand": "#C94500",
                "--biq-color-on-brand": "#FFFFFF",
                "--biq-color-action-primary": "#C94500",
                "--biq-color-action-primary-hover": "#A43700",
                "--biq-color-action-primary-pressed": "#812900",
                "--biq-color-on-action-primary": "#FFFFFF",
                "--biq-color-action-ghost-text": "#A43700",
                "--biq-color-link": "#A43700",
                "--biq-color-brand-tint": "#FFF2ED",
                "--biq-color-on-brand-tint": "#5F1C00",
                "--biq-color-selected-border": "#C94500",
                "--biq-color-selected-bg": "#FFF2ED",
                "--biq-color-focus-ring": "#EB5200",
                "--biq-color-surface-inverse": "#3F1000",
                "--biq-color-inverse-text": "#FFFFFF",
                "--biq-color-inverse-text-muted": "#FFFFFF",
                "--biq-color-inverse-border": "#FFFFFF",
                "--biq-color-inverse-link": "#FFA382",
            },
            "dark": {
                "--biq-color-brand": "#FF7642",
                "--biq-color-on-brand": "#0A153A",
                "--biq-color-action-primary": "#FF7642",
                "--biq-color-action-primary-hover": "#FFA382",
                "--biq-color-action-primary-pressed": "#EB5200",
                "--biq-color-on-action-primary": "#0A153A",
                # F5: This is the REPAIRED value (step 500, not original step 700)
                "--biq-color-action-ghost-text": "#EB5200",
                "--biq-color-link": "#FFA382",
                "--biq-color-brand-tint": "#3F1000",
                "--biq-color-on-brand-tint": "#FFCAB7",
                "--biq-color-selected-border": "#FF7642",
                "--biq-color-selected-bg": "#3F1000",
                "--biq-color-focus-ring": "#FF7642",
                "--biq-color-surface-inverse": "#3F1000",
                "--biq-color-inverse-text": "#FFFFFF",
                "--biq-color-inverse-text-muted": "#FFFFFF",
                "--biq-color-inverse-border": "#FFFFFF",
                "--biq-color-inverse-link": "#FFCAB7",
            },
        },
        "gate": {
            "passed": True,
            "checkedAt": "2026-08-29T20:00:00Z",
            "pairsChecked": 88,
            "failures": [],
            "repairs": [
                {
                    "token": "--biq-color-action-ghost-text",
                    "from": "#A43700",
                    "to": "#C94500",
                    "fromStep": 700,
                    "toStep": 600,
                    "reason": "4.0:1 < 4.5:1 on --biq-color-canvas",
                },
                {
                    "token": "--biq-color-action-ghost-text",
                    "from": "#C94500",
                    "to": "#EB5200",
                    "fromStep": 600,
                    "toStep": 500,
                    "reason": "4.0:1 < 4.5:1 on --biq-color-canvas",
                },
            ],
            "payloadHash": "067532a4b1c19c78",
        },
        "activation": {
            "themeStatus": "draft",
            "reason": "gate passed — draft pending activation",
            "decidedAt": "2026-08-29T20:00:00Z",
        },
    }


class TestF5GateE2E:
    """End-to-end test: job result callback → theme visible → activate → active."""

    def test_job_result_callback_persists_gate_passing_theme(self, admin_client, pending_job, monkeypatch):
        """The result callback stores a gate-passing theme with repaired tokens."""
        club_id = pending_job
        monkeypatch.setenv("BIQ_THEME_JOB_RESULT_TOKEN", "test-result-token")

        # Get the lease ID from the pending job
        r = admin_client.get(f"/api/admin/clubs/{club_id}/theme")
        assert r.status_code == 200
        data = r.json()
        assert data["themeJob"]["status"] == "pending"
        lease_id = data["themeJob"]["lease"]["holder"]

        payload = {
            "status": "succeeded",
            "jobId": lease_id,
            "sourceUrl": "https://example.com",
            "theme": _gate_passing_theme(club_id),
            "verdict": {
                "verdict": "club_confirmed",
                "score": 0.85,
                "families": ["basketball_keywords"],
                "negatives": [],
                "reason": "Basketball club",
            },
        }

        r = admin_client.post(
            f"/api/admin/clubs/{club_id}/theme/result",
            json=payload,
            headers={"Authorization": "Bearer test-result-token"},
        )
        assert r.status_code == 200, f"result callback failed: {r.text}"

        # Verify the theme is now visible
        r = admin_client.get(f"/api/admin/clubs/{club_id}/theme")
        assert r.status_code == 200
        data = r.json()
        assert data["theme"] is not None
        assert data["theme"]["status"] == "draft"
        assert data["theme"]["gate"]["passed"] is True
        assert data["themeJob"]["status"] == "succeeded"

        # F5: Verify the REPAIRED token value is stored, not the original
        dark_ghost = data["theme"]["tokens"]["dark"]["--biq-color-action-ghost-text"]
        assert dark_ghost == "#EB5200", f"expected repaired #EB5200, got {dark_ghost}"

    def test_activate_gate_passing_theme_succeeds(self, admin_client, pending_job, monkeypatch):
        """A gate-passing draft theme can be activated."""
        club_id = pending_job
        monkeypatch.setenv("BIQ_THEME_JOB_RESULT_TOKEN", "test-result-token")

        # Get the lease ID
        r = admin_client.get(f"/api/admin/clubs/{club_id}/theme")
        data = r.json()
        lease_id = data["themeJob"]["lease"]["holder"]

        # Post the gate-passing theme
        payload = {
            "status": "succeeded",
            "jobId": lease_id,
            "sourceUrl": "https://example.com",
            "theme": _gate_passing_theme(club_id),
            "verdict": {
                "verdict": "club_confirmed",
                "score": 0.85,
                "families": ["basketball_keywords"],
                "negatives": [],
                "reason": "Basketball club",
            },
        }
        r = admin_client.post(
            f"/api/admin/clubs/{club_id}/theme/result",
            json=payload,
            headers={"Authorization": "Bearer test-result-token"},
        )
        assert r.status_code == 200

        # Activate the theme
        r = admin_client.post(
            f"/api/admin/clubs/{club_id}/theme/activate",
            json={"confirmed": True},
        )
        assert r.status_code == 200, f"activation failed: {r.text}"

        # Verify the theme is now active
        r = admin_client.get(f"/api/admin/clubs/{club_id}/theme")
        data = r.json()
        assert data["theme"]["status"] == "active"

    def test_activate_gate_failing_theme_returns_error(self, admin_client, pending_job, monkeypatch):
        """A gate-failing theme cannot be activated."""
        club_id = pending_job
        monkeypatch.setenv("BIQ_THEME_JOB_RESULT_TOKEN", "test-result-token")

        # Get the lease ID
        r = admin_client.get(f"/api/admin/clubs/{club_id}/theme")
        data = r.json()
        lease_id = data["themeJob"]["lease"]["holder"]

        # Build a gate-FAILING theme
        failing_theme = _gate_passing_theme(club_id)
        failing_theme["status"] = "rejected"
        failing_theme["gate"]["passed"] = False
        failing_theme["gate"]["failures"] = [
            {"fg": "--biq-color-action-ghost-text", "bg": "--biq-color-canvas",
             "ratio": 4.0, "required": 4.5, "fgHex": "#A43700", "bgHex": "#080D1A"}
        ]
        failing_theme["activation"]["themeStatus"] = "rejected"

        payload = {
            "status": "succeeded",
            "jobId": lease_id,
            "sourceUrl": "https://example.com",
            "theme": failing_theme,
            "verdict": {
                "verdict": "club_confirmed",
                "score": 0.85,
                "families": ["basketball_keywords"],
                "negatives": [],
                "reason": "Basketball club",
            },
        }
        r = admin_client.post(
            f"/api/admin/clubs/{club_id}/theme/result",
            json=payload,
            headers={"Authorization": "Bearer test-result-token"},
        )
        assert r.status_code == 200

        # Try to activate — should fail
        r = admin_client.post(
            f"/api/admin/clubs/{club_id}/theme/activate",
            json={"confirmed": True},
        )
        assert r.status_code in (400, 409), f"activation should fail for rejected theme: {r.text}"
