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


def _mint(
    account_id: str = "acc_test",
    scope: str = "",
    verified_email: str = "",
) -> str:
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
    claims: dict = {
        "sub": account_id,
        "aud": "biq:onboard:entry-v1",
        "iss": "biq-app-context-v1",
        "iat": now,
        "exp": now + 120,
        "jti": "jt_test",
    }
    if scope:
        claims["scope"] = scope
    if verified_email:
        claims["vemail"] = verified_email
    payload = b64(json.dumps(claims).encode())
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


def _ops_headers(
    account_id: str = "acc_test",
    scope: str = "",
    verified_email: str = "",
) -> dict:
    return {
        **_S2S,
        "X-BIQ-Entry-Token": _mint(account_id, scope, verified_email),
    }


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
        assert client.post(
            "/api/ops/invitations/preview",
            json={"token": issued["token"]},
            headers=_S2S,
        ).status_code == 401

    def test_preview_returns_club_name(self, client: TestClient) -> None:
        issued = _issue(client)
        resp = client.post(
            "/api/ops/invitations/preview",
            json={"token": issued["token"]},
            headers=_ops_headers(),
        )
        assert resp.status_code == 200
        assert resp.json()["club_name"] == "Club Uno"

    def test_unknown_token_is_404(self, client: TestClient) -> None:
        resp = client.post(
            "/api/ops/invitations/preview",
            json={"token": "inv_ghost"},
            headers=_ops_headers(),
        )
        assert resp.status_code == 404

    def test_token_not_accepted_in_url(self, client: TestClient) -> None:
        """R5: the token must not travel in the URL path — the old
        path-parameter route is gone; a GET on it must never reach the
        preview handler or answer data."""
        issued = _issue(client)
        no_raise = TestClient(create_app(), raise_server_exceptions=False)
        resp = no_raise.get(
            f"/api/ops/invitations/{issued['token']}/preview",
            headers=_ops_headers(),
        )
        assert resp.status_code != 200
        assert "club_name" not in resp.text


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


class TestR5InvitationHardening:
    """R5: verified recipient binding, live issuer checks, bounded expiry,
    absolute revocation, atomic claim semantics."""

    def _issue_targeted(
        self, client: TestClient, email: str, roles=None
    ) -> dict:
        headers = {
            **_S2S,
            "X-BIQ-Acting-User-Id": "admin1",
            "X-BIQ-Acting-Email": "admin@example.com",
        }
        resp = client.post(
            "/api/admin/clubs/c1/invitations",
            json={
                "proposed_roles": roles or ["coach"],
                "recipient_email": email,
            },
            headers=headers,
        )
        assert resp.status_code == 201, resp.text
        return resp.json()

    def test_email_targeted_requires_verified_mailbox(
        self, client: TestClient
    ) -> None:
        """A recipient-targeted invitation binds to the cryptographically
        proven mailbox — membership scope and wrong-mailbox proofs fail."""
        issued = self._issue_targeted(client, "newco@example.com")
        # Membership-scope proof (no vemail) → denied.
        member = client.post(
            "/api/ops/invitations/redeem",
            json={"token": issued["token"]},
            headers=_ops_headers("acc_m", scope="membership"),
        )
        assert member.status_code == 403
        # Verified proof for a *different* mailbox → denied.
        wrong = client.post(
            "/api/ops/invitations/redeem",
            json={"token": issued["token"]},
            headers=_ops_headers(
                "acc_w", scope="verified", verified_email="other@example.com"
            ),
        )
        assert wrong.status_code == 403
        # Verified proof for the targeted mailbox → claim succeeds.
        ok = client.post(
            "/api/ops/invitations/redeem",
            json={"token": issued["token"]},
            headers=_ops_headers(
                "acc_ok", scope="verified", verified_email="newco@example.com"
            ),
        )
        assert ok.status_code == 200, ok.text

    def test_untargeted_invitation_stays_claim_by_possession(
        self, client: TestClient
    ) -> None:
        issued = _issue(client)
        resp = client.post(
            "/api/ops/invitations/redeem",
            json={"token": issued["token"]},
            headers=_ops_headers("acc_any", scope="membership"),
        )
        assert resp.status_code == 200

    def test_issuer_demotion_kills_invitation(self, client: TestClient) -> None:
        """The invitation dies when the issuer's live authority no longer
        covers the proposed grant — removing the administrator role
        assignment between issue and redeem must deny."""
        issued = _issue(client, roles=["coach"])
        # Demote the issuer: drop the assignment, drop the membership.
        org.get_roles().remove_assignment(
            "admin1__administrator__club:c1"
        )
        resp = client.post(
            "/api/ops/invitations/redeem",
            json={"token": issued["token"]},
            headers=_ops_headers("acc_v", scope="verified"),
        )
        assert resp.status_code in (404, 409)

    def test_issuer_membership_loss_kills_invitation(
        self, client: TestClient
    ) -> None:
        issued = _issue(client)
        user = org.get_registry().get_user("admin1")
        user.status = "deactivated"
        org.get_registry().upsert_user(user)
        resp = client.post(
            "/api/ops/invitations/redeem",
            json={"token": issued["token"]},
            headers=_ops_headers("acc_v", scope="verified"),
        )
        assert resp.status_code in (404, 409)

    def test_bounded_expiry(self, client: TestClient) -> None:
        headers = {
            **_S2S,
            "X-BIQ-Acting-User-Id": "admin1",
            "X-BIQ-Acting-Email": "admin@example.com",
        }
        # Beyond the 14-day ceiling → 422.
        far = client.post(
            "/api/admin/clubs/c1/invitations",
            json={"proposed_roles": ["coach"], "expires_at": "2999-01-01T00:00:00+00:00"},
            headers=headers,
        )
        assert far.status_code == 422
        # Malformed → 422.
        bad = client.post(
            "/api/admin/clubs/c1/invitations",
            json={"proposed_roles": ["coach"], "expires_at": "next-week"},
            headers=headers,
        )
        assert bad.status_code == 422
        # Within the bound → 201.
        from datetime import UTC, datetime, timedelta

        inside = (datetime.now(UTC) + timedelta(days=7)).isoformat()
        ok = client.post(
            "/api/admin/clubs/c1/invitations",
            json={"proposed_roles": ["coach"], "expires_at": inside},
            headers=headers,
        )
        assert ok.status_code == 201, ok.text

    def test_revoke_then_replay_denied_for_everyone(
        self, client: TestClient
    ) -> None:
        """Revocation is absolute — even the original claimer cannot
        replay a revoked token back into a live membership."""
        issued = _issue(client)
        headers = {
            **_S2S,
            "X-BIQ-Acting-User-Id": "admin1",
            "X-BIQ-Acting-Email": "admin@example.com",
        }
        revoked = client.delete(
            f"/api/admin/clubs/c1/invitations/{issued['invitation_id']}",
            headers=headers,
        )
        assert revoked.status_code == 200
        assert revoked.json()["status"] == "revoked"
        resp = client.post(
            "/api/ops/invitations/redeem",
            json={"token": issued["token"]},
            headers=_ops_headers("acc_r", scope="verified"),
        )
        assert resp.status_code == 409

    def test_same_account_replay_is_idempotent(self, client: TestClient) -> None:
        """The atomic claim's single-use gate names the winning account —
        that account replaying its own redemption re-answers, a different
        account is denied."""
        issued = _issue(client)
        first = client.post(
            "/api/ops/invitations/redeem",
            json={"token": issued["token"]},
            headers=_ops_headers("acc_win", scope="verified"),
        )
        assert first.status_code == 200
        replay = client.post(
            "/api/ops/invitations/redeem",
            json={"token": issued["token"]},
            headers=_ops_headers("acc_win", scope="verified"),
        )
        assert replay.status_code == 200
        assert (
            replay.json()["membership_subject_id"]
            == first.json()["membership_subject_id"]
        )
        foreign = client.post(
            "/api/ops/invitations/redeem",
            json={"token": issued["token"]},
            headers=_ops_headers("acc_loser", scope="verified"),
        )
        assert foreign.status_code == 409

    def test_sports_director_cannot_mint_admin_invite(
        self, client: TestClient
    ) -> None:
        """Per-role live check at issue: roles.manage.sporting may propose
        sporting roles only — an administrator invite needs roles.manage."""
        org.get_registry().upsert_user(
            __import__("biq_core.org.models", fromlist=["User"]).User(
                id="sd1", club_id="c1", role="sports_director", status="active"
            )
        )
        org.get_roles().put_assignment(
            RoleAssignment(
                user_id="sd1",
                role="sports_director",
                scope="club:c1",
                id="sd1__sports_director__club:c1",
            )
        )
        headers = {
            **_S2S,
            "X-BIQ-Acting-User-Id": "sd1",
            "X-BIQ-Acting-Email": "",
        }
        admin_invite = client.post(
            "/api/admin/clubs/c1/invitations",
            json={"proposed_roles": ["administrator"]},
            headers=headers,
        )
        assert admin_invite.status_code == 403
        coach_invite = client.post(
            "/api/admin/clubs/c1/invitations",
            json={"proposed_roles": ["coach"]},
            headers=headers,
        )
        assert coach_invite.status_code == 201, coach_invite.text


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

    def test_actor_bound_idempotency(self, client: TestClient) -> None:
        """R5: the deterministic ids derive from (account, key) — a second
        account replaying the same key creates its own club, never a
        collision or silent overwrite of the first."""
        first = client.post(
            "/api/ops/clubs",
            json={"name": "Club X", "idempotency_key": "shared-key"},
            headers=_ops_headers("acc_a"),
        ).json()
        second = client.post(
            "/api/ops/clubs",
            json={"name": "Club X", "idempotency_key": "shared-key"},
            headers=_ops_headers("acc_b"),
        ).json()
        assert first["club"]["id"] != second["club"]["id"]
        assert (
            first["membership_subject_id"] != second["membership_subject_id"]
        )

    def test_payload_conflict_is_409(self, client: TestClient) -> None:
        """R5: same actor + same key + different payload is a caller
        bug — 409, never a silent overwrite of the club document."""
        first = client.post(
            "/api/ops/clubs",
            json={"name": "Club X", "idempotency_key": "k1"},
            headers=_ops_headers("acc_a"),
        )
        assert first.status_code == 201
        conflict = client.post(
            "/api/ops/clubs",
            json={"name": "Different Name", "idempotency_key": "k1"},
            headers=_ops_headers("acc_a"),
        )
        assert conflict.status_code == 409
        # Same payload replay is the idempotent re-answer.
        same = client.post(
            "/api/ops/clubs",
            json={"name": "Club X", "idempotency_key": "k1"},
            headers=_ops_headers("acc_a"),
        )
        assert same.status_code in (200, 201)
        assert same.json()["club"]["id"] == first.json()["club"]["id"]

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
