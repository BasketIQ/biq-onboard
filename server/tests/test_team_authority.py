from unittest.mock import Mock

import httpx
import pytest
from fastapi import HTTPException

from biq_onboard_server.team_authority import HttpTeamAuthority


PATCH = {"id": "one", "club_id": "club", "name": "Authored <name>"}
RESULT = {"club_id": "club", "limit": 5, "active_count": 1, "revision": 2,
          "created_team_ids": ["one"], "teams": [PATCH]}


def test_missing_credentials_fail_before_network(monkeypatch):
    monkeypatch.setenv("BIQ_APP_URL", "https://app.example.test")
    monkeypatch.delenv("BIQ_INTERNAL_TOKEN", raising=False)
    post = Mock(side_effect=AssertionError("network without credentials"))
    monkeypatch.setattr(httpx, "post", post)
    with pytest.raises(HTTPException) as error:
        HttpTeamAuthority().upsert("derived-actor", "club", [PATCH])
    assert error.value.status_code == 503
    post.assert_not_called()


def test_bound_actor_partial_payload_and_no_redirects(monkeypatch):
    monkeypatch.setenv("BIQ_APP_URL", "https://app.example.test")
    monkeypatch.setenv("BIQ_INTERNAL_TOKEN", "fake-team-authority-token")
    post = Mock(return_value=httpx.Response(200, json=RESULT))
    monkeypatch.setattr(httpx, "post", post)
    assert HttpTeamAuthority().upsert("derived-actor", "club", [PATCH], create_only=True) == RESULT
    args, kwargs = post.call_args
    assert args == ("https://app.example.test/api/ops/club-teams/v1",)
    assert kwargs["json"] == {
        "actor_user_id": "derived-actor", "club_id": "club", "teams": [PATCH], "create_only": True,
    }
    assert kwargs["follow_redirects"] is False


@pytest.mark.parametrize("response,status", [
    (httpx.Response(302, headers={"location": "https://foreign.example.test"}), 503),
    (httpx.Response(409, json={"detail": "club_team_limit_reached"}), 409),
    (httpx.Response(401, json={"detail": "unauthorized"}), 503),
    (httpx.Response(200, json={**RESULT, "club_id": "foreign"}), 503),
    (httpx.Response(200, json={**RESULT, "revision": True}), 503),
    (httpx.Response(200, json={**RESULT, "teams": [{**PATCH, "id": []}]}), 503),
])
def test_denials_and_malformed_scope_never_fall_back(monkeypatch, response, status):
    monkeypatch.setenv("BIQ_APP_URL", "https://app.example.test")
    monkeypatch.setenv("BIQ_INTERNAL_TOKEN", "fake-team-authority-token")
    post = Mock(return_value=response)
    monkeypatch.setattr(httpx, "post", post)
    with pytest.raises(HTTPException) as error:
        HttpTeamAuthority().upsert("derived-actor", "club", [PATCH])
    assert error.value.status_code == status
    assert post.call_count == 1
