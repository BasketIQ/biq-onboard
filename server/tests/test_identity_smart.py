import json

import pytest
from fastapi import HTTPException

from biq_onboard_server.identity_smart import IdentitySmart


@pytest.fixture
def gateway(monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.setenv("BIQ_ENV", "staging")
    monkeypatch.setenv("BIQ_APP_BASE_URL", "https://app.example")
    monkeypatch.setenv("BIQ_APP_INTERNAL_TOKEN", "fake")
    return IdentitySmart()


def test_source_queue_admission_is_bounded_non_model_and_private(gateway, monkeypatch):
    calls = []

    def post(path, body):
        calls.append((path, body))
        return {"state": "started", "newly_admitted": True}

    monkeypatch.setattr(gateway, "post", post)
    identifier = gateway.begin("club1", "member", "lease", "2026-11-16T10:00:00Z",
                               "https://club.example/PRIVATE_SOURCE")
    assert len(identifier) == 64
    body = calls[0][1]
    assert body["subject"] == "club:club1"
    assert body["membership_subject_id"] == "member" and body["team_id"] is None
    assert body["model"] == "none"
    assert all(value == 0 for value in body["token_bounds"].values())
    assert "PRIVATE_SOURCE" not in json.dumps(body)


@pytest.mark.parametrize("reply", [{"state": "started"}, {"state": "started", "newly_admitted": False},
                                  {"state": "delivered", "newly_admitted": False}])
def test_replayed_or_unconfirmed_admission_cannot_dispatch(gateway, monkeypatch, reply):
    monkeypatch.setattr(gateway, "post", lambda *_: reply)
    with pytest.raises(HTTPException) as error:
        gateway.begin("club1", "member", "lease", "2026-11-16T10:00:00Z", "https://club.example")
    assert error.value.status_code == 409


def test_ci_default_has_no_live_consumption_transport(monkeypatch):
    monkeypatch.setenv("CI", "true")
    monkeypatch.setenv("BIQ_ENV", "staging")
    gateway = IdentitySmart()
    monkeypatch.setattr(gateway, "post", lambda *_: pytest.fail("CI must not call App"))
    identifier = gateway.begin("club1", "member", "lease", "2026-11-16T10:00:00Z", "https://club.example")
    gateway.finish(identifier, "failed")


def test_existing_onboard_app_bindings_do_not_require_new_secrets(monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.setenv("BIQ_ENV", "prod")
    monkeypatch.delenv("BIQ_APP_BASE_URL", raising=False)
    monkeypatch.delenv("BIQ_APP_INTERNAL_TOKEN", raising=False)
    monkeypatch.setenv("BIQ_APP_URL", "https://app.example")
    monkeypatch.setenv("BIQ_INTERNAL_TOKEN", "test-existing-token")
    gateway = IdentitySmart()
    assert gateway.base == "https://app.example"
    assert gateway.token == "test-existing-token"
    assert gateway.fake is False
