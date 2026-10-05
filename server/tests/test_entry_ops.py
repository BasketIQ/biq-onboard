"""Entry-ops contract tests — invitations + gated club create (RC1 §4)."""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("BIQ_ORG_STORE", "memory")
os.environ.setdefault("BIQ_ROLES_STORE", "memory")
os.environ.setdefault("BIQ_ONBOARD_HTTPS_ONLY", "0")
os.environ.setdefault("BIQ_ONBOARD_SESSION_SECRET", "test-secret")

from fastapi.testclient import TestClient  # noqa: E402

from biq_onboard_server.app import create_app  # noqa: E402
from biq_onboard_server import entry_proof, invitations, org  # noqa: E402
from biq_core.org import seed_registry  # noqa: E402
from biq_core.roles import RoleAssignment  # noqa: E402

_S2S = {"Authorization": "Bearer test-s2s-secret"}

_MANIFEST = {
    "clubs": [
        {
            "id": "c1",
            "name": "Club Uno",
            "teams": [{"id": "t1", "name": "Cadete", "staff_user_ids": []}],
        }
    ],
    "users": [
        {
            "id": "admin1",
            "club_id": "c1",
            "role": "administrator",
            "email": "admin@example.com",
            "status": "active",
        }
    ],
}


@pytest.fixture()
def client(monkeypatch) -> TestClient:
    # Scoped env: S2S/embed secrets must not leak into other test modules —
    # a configured S2S secret switches every endpoint to fail-closed S2S auth.
    monkeypatch.setenv("BIQ_ORG_STORE", "memory")
    monkeypatch.setenv("BIQ_INVITATION_STORE", "memory")
    monkeypatch.setenv("BIQ_ONBOARD_S2S_SECRET", "test-s2s-secret")
    monkeypatch.setenv("BIQ_EMBED_JWT_SECRET", "test-embed-secret")
    org.reset_for_tests()
    invitations.reset_invitation_store()
    seed_registry(org.get_registry(), _MANIFEST)
    org.get_roles().put_assignment(
        RoleAssignment(
            user_id="admin1",
            role="administrator",
            scope="club:c1",
            id="admin1__administrator__club:c1",
        )
    )
    return TestClient(create_app())


    """Mint an entry proof the way App does (same HS256 contract)."""
    import base64
    import hashlib
    import hmac
    import json
    import time

    key = "test-embed-secret"

    def b64(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    now = int(time.time())
    payload = b64(
        json.dumps(
            {
                "sub": account_id,
                "aud": "biq:onboard:entry-v1",
                "iss": "biq-app-context-v1",
                "iat": now,
                "exp": now + 120,
                "jti": "jt_test",
            }
        ).encode()
    )
    signing_input = f"{header}.{payload}"
    sig = b64(hmac.new(key.encode(), signing_input.encode(), hashlib.sha256).digest())
    return f"{signing_input}.{sig}"


def _mint(account_id: str = "acc_test") -> str:
    """Mint an entry proof the way App does (same HS256 contract)."""
    import base64
    import hashlib
    import hmac
    import json
    import time

    key = "test-embed-secret"

    def b64(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    now = int(time.time())
    payload = b64(
        json.dumps(
            {
                "sub": account_id,
                "aud": "biq:onboard:entry-v1",
                "iss": "biq-app-context-v1",
                "iat": now,
                "exp": now + 120,
                "jti": "jt_test",
            }
        ).encode()
    )
    signing_input = f"{header}.{payload}"
    sig = b64(hmac.new(key.encode(), signing_input.encode(), hashlib.sha256).digest())
    return f"{signing_input}.{sig}"


def _issue(client: TestClient, club_id: str = "c1", roles=None) -> dict:
    headers = {
        **_S2S,
        "X-BIQ-Acting-User-Id": "admin1",
        "X-BIQ-Acting-Email": "admin@example.com",
    }
    resp = client.post(
        f"/api/admin/clubs/{club_id}/invitations",
        json={"proposed_roles": roles or ["coach"]},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _ops_headers(account_id: str = "acc_test") -> dict:
    return {**_S2S, "X-BIQ-Entry-Token": _mint(account_id)}


class TestIssue:
    def test_issue_requires_s2s(self, client: TestClient) -> None:
        resp = client.post(
            "/api/admin/clubs/c1/invitations", json={"proposed_roles": ["coach"]}
        )
        assert resp.status_code in (401, 403)

    def test_issue_requires_capability(self, client: TestClient) -> None:
        headers = {
            **_S2S,
            "X-BIQ-Acting-User-Id": "ghost",
            "X-BIQ-Acting-Email": "",
        }
        resp = client.post(
            "/api/admin/clubs/c1/invitations",
            json={"proposed_roles": ["coach"]},
            headers=headers,
        )
        assert resp.status_code == 403

    def test_issue_returns_token_once(self, client: TestClient) -> None:
        body = _issue(client, roles=["coach", "assistant"])
        assert body["token"].startswith("inv_")
        assert body["club_id"] == "c1"
        # Stored record keeps only the digest.
        stored = invitations.get_invitation_store().get(body["invitation_id"])
        assert stored is not None
        assert stored.token_digest != body["token"]
        assert stored.proposed_roles == ["coach", "assistant"]


class TestPreview:
    def test_preview_requires_proof(self, client: TestClient) -> None:
        issued = _issue(client)
        assert client.get(
            f"/api/ops/invitations/{issued['token']}/preview", headers=_S2S
        ).status_code == 401

    def test_preview_returns_club_name(self, client: TestClient) -> None:
        issued = _issue(client)
        resp = client.get(
            f"/api/ops/invitations/{issued['token']}/preview",
            headers=_ops_headers(),
        )
        assert resp.status_code == 200
        assert resp.json()["club_name"] == "Club Uno"

    def test_unknown_token_is_404(self, client: TestClient) -> None:
        resp = client.get(
            "/api/ops/invitations/inv_ghost/preview", headers=_ops_headers()
        )
        assert resp.status_code == 404


class TestRedeem:
    def test_redeem_creates_membership_and_consumes(self, client: TestClient) -> None:
        issued = _issue(client, roles=["coach"])
        resp = client.post(
            "/api/ops/invitations/redeem",
            json={"token": issued["token"]},
            headers=_ops_headers("acc_1"),
        )
        assert resp.status_code == 200, resp.text
        d = resp.json()
        assert d["club_id"] == "c1"
        assert d["membership_subject_id"].startswith("f1f2m_")
        assert d["roles"] == ["coach"]
        membership = org.get_registry().get_user(d["membership_subject_id"])
        assert membership is not None
        assert membership.club_id == "c1"
        # Single-use: replay is 409.
        replay = client.post(
            "/api/ops/invitations/redeem",
            json={"token": issued["token"]},
            headers=_ops_headers("acc_2"),
        )
        assert replay.status_code in (404, 409)

    def test_bad_proof_is_401(self, client: TestClient) -> None:
        issued = _issue(client)
        resp = client.post(
            "/api/ops/invitations/redeem",
            json={"token": issued["token"]},
            headers={**_S2S, "X-BIQ-Entry-Token": "bad"},
        )
        assert resp.status_code == 401

    def test_no_s2s_is_401(self, client: TestClient) -> None:
        issued = _issue(client)
        resp = client.post(
            "/api/ops/invitations/redeem",
            json={"token": issued["token"]},
            headers={"X-BIQ-Entry-Token": _mint()},
        )
        assert resp.status_code == 401

    def test_expired_invitation_cannot_redeem(self, client: TestClient) -> None:
        issued = _issue(client)
        store = invitations.get_invitation_store()
        inv = store.get(issued["invitation_id"])
        inv.expires_at = "2000-01-01T00:00:00+00:00"
        store.put(inv)
        resp = client.post(
            "/api/ops/invitations/redeem",
            json={"token": issued["token"]},
            headers=_ops_headers(),
        )
        assert resp.status_code in (404, 409)


class TestOpsClubCreate:
    def test_create_club_returns_membership(self, client: TestClient) -> None:
        resp = client.post(
            "/api/ops/clubs",
            json={"name": "Nuevo Club", "idempotency_key": "k-1", "email": "new@example.com"},
            headers=_ops_headers("acc_new"),
        )
        assert resp.status_code == 201, resp.text
        d = resp.json()
        assert d["club"]["name"] == "Nuevo Club"
        assert d["membership_subject_id"].startswith("f1f2m_")
        membership = org.get_registry().get_user(d["membership_subject_id"])
        assert membership.club_id == d["club"]["id"]
        assert membership.email == "new@example.com"

    def test_idempotent_replay_same_ids(self, client: TestClient) -> None:
        first = client.post(
            "/api/ops/clubs",
            json={"name": "Club X", "idempotency_key": "same"},
            headers=_ops_headers(),
        ).json()
        second = client.post(
            "/api/ops/clubs",
            json={"name": "Club X", "idempotency_key": "same"},
            headers=_ops_headers(),
        ).json()
        assert first["club"]["id"] == second["club"]["id"]
        assert first["membership_subject_id"] == second["membership_subject_id"]

    def test_requires_proof(self, client: TestClient) -> None:
        resp = client.post("/api/ops/clubs", json={"name": "X"}, headers=_S2S)
        assert resp.status_code == 401

    def test_bad_website_scheme_is_422(self, client: TestClient) -> None:
        resp = client.post(
            "/api/ops/clubs",
            json={"name": "Club", "website": "http://x.com"},
            headers=_ops_headers(),
        )
        assert resp.status_code == 422
