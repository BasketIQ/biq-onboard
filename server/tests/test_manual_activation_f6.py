"""F6 — Manual theme and activation integration tests.

Per the active architect handoff:
  - Unit test for deterministic payload hash (in biq-app JS)
  - Integration test for manual generation→gate→activation
  - One mutation/authorization test (high-risk publication invariant)

This file covers the integration and mutation/authorization tests for the
biq-onboard activation endpoint, exercising the real POST /activate route.
"""

from __future__ import annotations

import hashlib
import json

import pytest
from biq_core.org import Club
from biq_onboard_server import org
from biq_onboard_server.app import create_app
from fastapi.testclient import TestClient

_RESULT_TOKEN = "test-result-token-f6"


@pytest.fixture
def client(monkeypatch):
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
    cid = "f6_club"
    admin_client.post("/api/admin/clubs", json={"id": cid, "name": "F6 Club"})
    return cid


def _result_headers():
    return {"Authorization": f"Bearer {_RESULT_TOKEN}"}


def _compute_hash(light: dict, dark: dict) -> str:
    """Compute the canonical payload hash matching the JS engine."""
    payload = {"light": light, "dark": dark}
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()[:16]


def _seed_gate_passed_theme(club_id: str, light: dict, dark: dict) -> dict:
    """Seed a club with a gate-passed draft theme (simulating job completion)."""
    reg = org.get_registry()
    payload_hash = _compute_hash(light, dark)
    theme = {
        "schemaVersion": 1,
        "clubId": club_id,
        "status": "draft",
        "source": {"kind": "manual", "homepageUrl": ""},
        "seed": {"brand": "#FF5A00", "brandAlt": "#0A153A", "detectedFrom": "manual"},
        "logo": None,
        "tokens": {"light": light, "dark": dark},
        "gate": {
            "passed": True,
            "checkedAt": "2026-01-01T00:00:00Z",
            "pairsChecked": 44,
            "failures": [],
            "repairs": [],
            "payloadHash": payload_hash,
        },
        "activation": {
            "themeStatus": "draft",
            "reason": "manual override — gate validation applied",
            "decidedAt": "2026-01-01T00:00:00Z",
        },
    }
    reg.merge_club_fields(club_id, {"theme": theme})
    return theme


# ─── F6: Integration — manual generation → gate → activation ─────────────


def test_manual_generation_to_gate_to_activation(admin_client, club_id):
    """F6: Full manual flow: PUT /theme (draft) → job result (gate passed) → POST /activate (active).

    1. PUT /theme creates a draft with pending gate
    2. Job callback posts the result with gate-passed tokens + payloadHash
    3. POST /activate promotes draft → active
    4. Final theme status is active
    """
    light = {"primary": "#FF5A00", "onPrimary": "#FFFFFF", "surface": "#FFFFFF"}
    dark = {"primary": "#FF5A00", "onPrimary": "#0A153A", "surface": "#111A2D"}
    payload_hash = _compute_hash(light, dark)

    # 1. PUT manual theme (creates draft with pending gate)
    r_put = admin_client.put(
        f"/api/admin/clubs/{club_id}/theme",
        json={"seed_brand": "#FF5A00", "seed_brand_alt": "#0A153A"},
    )
    assert r_put.status_code == 200
    assert r_put.json()["theme"]["status"] == "draft"
    assert r_put.json()["theme"]["gate"]["pending"] is True

    job_id = r_put.json()["themeJob"]["lease"]["holder"]

    # 2. Job callback: succeeded with gate-passed theme
    completed_theme = {
        "schemaVersion": 1,
        "clubId": club_id,
        "status": "draft",
        "source": {"kind": "manual", "homepageUrl": ""},
        "seed": {"brand": "#FF5A00", "brandAlt": "#0A153A", "detectedFrom": "manual"},
        "logo": None,
        "tokens": {"light": light, "dark": dark},
        "gate": {
            "passed": True,
            "checkedAt": "2026-01-01T00:00:00Z",
            "pairsChecked": 44,
            "failures": [],
            "repairs": [],
            "payloadHash": payload_hash,
        },
        "activation": {
            "themeStatus": "draft",
            "reason": "manual override — gate validation applied",
            "decidedAt": "2026-01-01T00:00:00Z",
        },
    }
    r_result = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/result",
        json={
            "status": "succeeded",
            "theme": completed_theme,
            "jobId": job_id,
            "sourceUrl": "",
        },
        headers=_result_headers(),
    )
    assert r_result.status_code == 200

    # 3. POST /activate — promote draft to active
    r_activate = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/activate",
        json={"confirmed": True},
    )
    assert r_activate.status_code == 200
    activated = r_activate.json()
    assert activated["ok"] is True
    assert activated["status"] == "active"
    assert activated["theme"]["status"] == "active"
    assert activated["theme"]["activation"]["themeStatus"] == "active"
    assert activated["theme"]["activation"]["reason"] == "admin-activated"


# ─── F6: Mutation test — token tampering rejected ────────────────────────


def test_activation_rejects_token_tampering(admin_client, club_id):
    """F6: Activation must reject a theme whose tokens were modified after gate validation.

    This is the high-risk publication invariant: if tokens are changed after
    the gate passed, the payloadHash won't match and activation is rejected.
    """
    light = {"primary": "#FF5A00", "onPrimary": "#FFFFFF"}
    dark = {"primary": "#FF5A00", "onPrimary": "#0A153A"}

    # Seed a gate-passed draft theme
    _seed_gate_passed_theme(club_id, light, dark)

    # Tamper with the tokens (change a value after gate)
    reg = org.get_registry()
    club = reg.get_club(club_id)
    tampered_theme = club.theme
    tampered_theme["tokens"]["light"]["primary"] = "#HACKED"
    reg.merge_club_fields(club_id, {"theme": tampered_theme})

    # Activation must reject the tampered theme
    r = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/activate",
        json={"confirmed": True},
    )
    assert r.status_code == 409
    assert "hash mismatch" in r.json()["detail"].lower()


def test_activation_rejects_token_addition(admin_client, club_id):
    """F6: Adding a new token key after gate must also be rejected."""
    light = {"primary": "#FF5A00"}
    dark = {"primary": "#FF5A00"}

    _seed_gate_passed_theme(club_id, light, dark)

    # Add a new token key
    reg = org.get_registry()
    club = reg.get_club(club_id)
    tampered_theme = club.theme
    tampered_theme["tokens"]["light"]["extra"] = "#123456"
    reg.merge_club_fields(club_id, {"theme": tampered_theme})

    r = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/activate",
        json={"confirmed": True},
    )
    assert r.status_code == 409
    assert "hash mismatch" in r.json()["detail"].lower()


def test_activation_accepts_restored_tokens(admin_client, club_id):
    """F6: If tokens are tampered then restored, activation succeeds (hash matches again)."""
    light = {"primary": "#FF5A00", "onPrimary": "#FFFFFF"}
    dark = {"primary": "#FF5A00", "onPrimary": "#0A153A"}

    _seed_gate_passed_theme(club_id, light, dark)

    # Tamper
    reg = org.get_registry()
    club = reg.get_club(club_id)
    original_primary = club.theme["tokens"]["light"]["primary"]
    club.theme["tokens"]["light"]["primary"] = "#HACKED"
    reg.merge_club_fields(club_id, {"theme": club.theme})

    # Restore
    club = reg.get_club(club_id)
    club.theme["tokens"]["light"]["primary"] = original_primary
    reg.merge_club_fields(club_id, {"theme": club.theme})

    # Activation should succeed
    r = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/activate",
        json={"confirmed": True},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "active"


# ─── F6: Authorization test — non-admin cannot activate ──────────────────


def test_activation_requires_auth(client):
    """F6: Unauthenticated activation fails closed."""
    # Create a club directly in the registry (no admin login needed)
    reg = org.get_registry()
    reg.upsert_club(Club(id="f6_auth_club", name="F6 Auth Club", status="active"))
    r = client.post(
        "/api/admin/clubs/f6_auth_club/theme/activate",
        json={"confirmed": True},
    )
    assert r.status_code == 401


def test_activation_rejects_pending_gate(admin_client, club_id):
    """F6: Activation rejects a theme with gate.pending=True."""
    # PUT manual theme (creates draft with pending gate)
    admin_client.put(
        f"/api/admin/clubs/{club_id}/theme",
        json={"seed_brand": "#FF5A00"},
    )

    # Try to activate before job completes
    r = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/activate",
        json={"confirmed": True},
    )
    assert r.status_code == 409
    assert "pending" in r.json()["detail"].lower()


def test_activation_rejects_failed_gate(admin_client, club_id):
    """F6: Activation rejects a theme with gate.passed=False."""
    light = {"primary": "#FF5A00"}
    dark = {"primary": "#FF5A00"}

    reg = org.get_registry()
    theme = _seed_gate_passed_theme(club_id, light, dark)
    theme["gate"]["passed"] = False
    reg.merge_club_fields(club_id, {"theme": theme})

    r = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/activate",
        json={"confirmed": True},
    )
    assert r.status_code == 409
    assert "gate" in r.json()["detail"].lower()


def test_activation_idempotent_already_active(admin_client, club_id):
    """F6: Activating an already-active theme returns already_active (idempotent)."""
    light = {"primary": "#FF5A00"}
    dark = {"primary": "#FF5A00"}

    _seed_gate_passed_theme(club_id, light, dark)

    # First activation
    r1 = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/activate",
        json={"confirmed": True},
    )
    assert r1.status_code == 200
    assert r1.json()["status"] == "active"

    # Second activation (idempotent)
    r2 = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/activate",
        json={"confirmed": True},
    )
    assert r2.status_code == 200
    assert r2.json()["status"] == "already_active"


def test_activation_404_for_nonexistent_club(admin_client):
    """F6: Activation for a nonexistent club returns 404."""
    r = admin_client.post(
        "/api/admin/clubs/nonexistent/theme/activate",
        json={"confirmed": True},
    )
    assert r.status_code == 404


def test_activation_404_for_no_theme(admin_client, club_id):
    """F6: Activation with no theme returns 404."""
    r = admin_client.post(
        f"/api/admin/clubs/{club_id}/theme/activate",
        json={"confirmed": True},
    )
    assert r.status_code == 404
