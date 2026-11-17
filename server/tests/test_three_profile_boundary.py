from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request
from biq_onboard_server import auth


def request(*, user=None, delegated=None):
    headers = [] if delegated is None else [(b"authorization", b"Bearer test-service"),
        (b"x-biq-acting-user-id", delegated.encode())]
    return Request({"type": "http", "headers": headers, "session": {"user": user} if user else {}})


@pytest.mark.parametrize("locale", ["es", "en"])
def test_s2s_cannot_turn_environment_username_into_platform_admin(monkeypatch, locale):
    monkeypatch.setenv("BIQ_ENV", "staging")
    monkeypatch.setenv("BIQ_ONBOARD_S2S_SECRET", "test-service")
    monkeypatch.setattr(auth.org, "get_registry", lambda: SimpleNamespace(get_user=lambda _: None))
    with pytest.raises(HTTPException) as denial:
        auth.require_roles_admin_acting(request(delegated="admin"), "club")
    assert denial.value.status_code == 403
    assert not auth._authenticate("admin", "T3st1ng!")


def test_global_admin_route_requires_live_platform_grant(monkeypatch):
    monkeypatch.setenv("BIQ_ENV", "staging")
    record = SimpleNamespace(status="active", club_id="club")
    monkeypatch.setattr(auth.org, "get_registry", lambda: SimpleNamespace(get_user=lambda _: record))
    monkeypatch.setattr(auth.org, "get_roles", lambda: object())
    monkeypatch.setattr(auth, "effective_capabilities", lambda *args: ["roles.manage.sporting"])
    with pytest.raises(HTTPException) as denial:
        auth.require_admin(request(user="director"))
    assert denial.value.status_code == 403
    monkeypatch.setattr(auth, "effective_capabilities", lambda *args: ["platform.admin"])
    assert auth.require_admin(request(user="administrator")) == "administrator"
    record.status = "deactivated"
    with pytest.raises(HTTPException):
        auth.require_admin(request(user="administrator"))
