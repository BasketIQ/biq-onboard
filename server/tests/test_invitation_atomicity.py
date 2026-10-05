"""Invitation redeem atomicity — strict Firestore-semantics concurrency tests.

``transact_redeem`` commits the invitation claim + member upsert + role
grants inside ONE ``@firestore.transactional`` boundary. These tests drive
the real endpoint through the real ``FirestoreInvitationStore`` /
``FirestoreOrgRegistry`` / ``FirestoreRoleRegistry`` against a strict
in-memory Firestore modelling optimistic concurrency: a transaction's
read-set (documents AND query results) is validated at commit and a
competing write aborts it with ``google.api_core.exceptions.Aborted`` —
the real retry wrapper re-runs the decision with fresh state, exactly
like production Firestore.

``commit_hooks`` injects the competitor's commit between our read and our
commit — deterministic true-concurrency simulation, not timing luck.

Backend: all three stores on ``firestore`` + a monkeypatched
``_get_firestore_client`` — no emulator, no project, no credentials.
"""

from __future__ import annotations

import os
import threading
from typing import Any

import pytest

os.environ.setdefault("BIQ_ONBOARD_HTTPS_ONLY", "0")
os.environ.setdefault("BIQ_ONBOARD_SESSION_SECRET", "test-secret")
os.environ.setdefault("BIQ_ONBOARD_S2S_SECRET", "test-s2s-secret")
os.environ.setdefault("BIQ_EMBED_JWT_SECRET", "test-embed-secret")

from google.api_core import exceptions as gexc  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from biq_core.org import FirestoreOrgRegistry  # noqa: E402
from biq_core.org.models import User  # noqa: E402
from biq_core.roles import FirestoreRoleRegistry  # noqa: E402
from biq_core.roles.models import RoleAssignment  # noqa: E402
from biq_onboard_server import invitations, org  # noqa: E402
from biq_onboard_server.app import create_app  # noqa: E402
from biq_onboard_server.invitations import FirestoreInvitationStore  # noqa: E402

from test_entry_ops import _ops_headers, _S2S  # noqa: E402


# ── strict Firestore fake ────────────────────────────────────────────────


class _Snap:
    def __init__(self, doc_id: str, data: dict | None) -> None:
        self.id = doc_id
        self._data = dict(data) if data is not None else None

    @property
    def exists(self) -> bool:
        return self._data is not None

    def to_dict(self) -> dict | None:
        return dict(self._data) if self._data is not None else None


class _DocRef:
    def __init__(self, client: "_FakeFirestore", path: str) -> None:
        self._client = client
        self._path = path

    def get(self, transaction: "_FakeTransaction | None" = None) -> _Snap:
        data = self._client._docs.get(self._path)
        snap = _Snap(self._path.rsplit("/", 1)[-1], data)
        if transaction is not None:
            transaction._record_doc(self._path, data)
        return snap

    def set(self, data: dict, merge: bool = False) -> None:
        with self._client._lock:
            if merge and self._path in self._client._docs:
                merged = dict(self._client._docs[self._path])
                merged.update(data)
                self._client._docs[self._path] = merged
            else:
                self._client._docs[self._path] = dict(data)

    def delete(self) -> None:
        with self._client._lock:
            self._client._docs.pop(self._path, None)

    def collection(self, name: str) -> "_FakeCollection":
        return _FakeCollection(self._client, f"{self._path}/{name}")


class _FakeQuery:
    def __init__(
        self,
        client: "_FakeFirestore",
        path: str,
        filters: list[tuple[str, str]] | None = None,
        limit: int | None = None,
    ) -> None:
        self._client = client
        self._path = path
        self._filters = filters or []
        self._limit = limit

    def where(self, field: str, op: str, value: Any) -> "_FakeQuery":
        assert op == "==", "test fake supports equality filters only"
        return _FakeQuery(
            self._client, self._path, self._filters + [(field, value)], self._limit
        )

    def limit(self, n: int) -> "_FakeQuery":
        return _FakeQuery(self._client, self._path, self._filters, n)

    def _run(self) -> list[_Snap]:
        prefix = self._path + "/"
        items = [
            (k[len(prefix):], v)
            for k, v in self._client._docs.items()
            if k.startswith(prefix) and "/" not in k[len(prefix):]
        ]
        for field, value in self._filters:
            items = [(k, v) for k, v in items if v.get(field) == value]
        if self._limit is not None:
            items = items[: self._limit]
        return [_Snap(k, v) for k, v in items]

    def stream(self):
        return iter(self._run())


class _FakeCollection(_FakeQuery):
    def document(self, doc_id: str) -> _DocRef:
        return _DocRef(self._client, f"{self._path}/{doc_id}")


class _FakeTransaction:
    """The surface ``firestore.transactional`` drives: begin → body → commit
    with optimistic read-set validation. A changed read doc or a query
    result that gained/lost a member or mutated content aborts the commit
    (``Aborted``), so the real retry wrapper re-runs with fresh state."""

    def __init__(self, client: "_FakeFirestore") -> None:
        self._client = client
        self._read_only = False
        self._max_attempts = 6
        self._id: str | None = None
        self._clean_up()

    def _clean_up(self) -> None:
        self._doc_reads: dict[str, dict | None] = {}
        self._query_reads: dict[int, tuple[_FakeQuery, dict[str, dict]]] = {}
        self._writes: list[tuple[str, dict, bool]] = []

    def _begin(self, retry_id: str | None = None) -> None:
        self._clean_up()
        self._id = retry_id or "txn"

    def _record_doc(self, path: str, data: dict | None) -> None:
        self._doc_reads[path] = dict(data) if data is not None else None

    def get(self, ref_or_query):
        if isinstance(ref_or_query, _FakeQuery):
            snaps = ref_or_query._run()
            self._query_reads[id(ref_or_query)] = (
                ref_or_query,
                {s.id: s.to_dict() for s in snaps},
            )
            return iter(snaps)
        data = self._client._docs.get(ref_or_query._path)
        self._record_doc(ref_or_query._path, data)
        return _Snap(ref_or_query._path.rsplit("/", 1)[-1], data)

    def set(self, ref: _DocRef, data: dict, merge: bool = False) -> None:
        self._writes.append((ref._path, dict(data), merge))

    def _commit(self) -> None:
        with self._client._lock:
            if self._client.always_fail_commits:
                raise gexc.Aborted("injected commit fault")
            # Competitor commits land between our read and our commit.
            hooks, self._client.commit_hooks = self._client.commit_hooks, []
            for hook in hooks:
                hook(self._client)
            for path, seen in self._doc_reads.items():
                now = self._client._docs.get(path)
                now = dict(now) if now is not None else None
                if now != seen:
                    raise gexc.Aborted(f"read doc changed: {path}")
            for query, seen in self._query_reads.values():
                now = {s.id: s.to_dict() for s in query._run()}
                if now != seen:
                    raise gexc.Aborted(f"query read set changed: {query._path}")
            for path, data, merge in self._writes:
                if merge and path in self._client._docs:
                    merged = dict(self._client._docs[path])
                    merged.update(data)
                    self._client._docs[path] = merged
                else:
                    self._client._docs[path] = data

    def _rollback(self) -> None:
        self._clean_up()


class _FakeFirestore:
    def __init__(self) -> None:
        self._docs: dict[str, dict] = {}
        self._lock = threading.RLock()
        self.commit_hooks: list[Any] = []
        self.always_fail_commits = False

    def collection(self, name: str) -> _FakeCollection:
        return _FakeCollection(self, name)

    def transaction(self) -> _FakeTransaction:
        return _FakeTransaction(self)


# ── fixture ──────────────────────────────────────────────────────────────


@pytest.fixture()
def fx(monkeypatch: pytest.MonkeyPatch):
    """Real app → real Firestore-backed stores → strict fake client.

    All three stores are forced to the firestore backend sharing the one
    fake client — the exact topology transact_redeem requires."""
    fake = _FakeFirestore()
    monkeypatch.setenv("BIQ_ORG_STORE", "firestore")
    monkeypatch.setenv("BIQ_ROLES_STORE", "firestore")
    monkeypatch.setenv("BIQ_INVITATION_STORE", "firestore")
    monkeypatch.setattr(org, "_get_firestore_client", lambda: fake)
    org.reset_for_tests()
    invitations.reset_invitation_store()
    # Seed an authorized issuer through the real Firestore-backed stores.
    FirestoreOrgRegistry(fake).upsert_user(
        User(
            id="admin1",
            club_id="c1",
            role="administrator",
            email="admin@example.com",
            status="active",
        )
    )
    FirestoreRoleRegistry(fake).put_assignment(
        RoleAssignment(
            user_id="admin1",
            role="administrator",
            scope="club:c1",
            id="admin1__administrator__club:c1",
        )
    )
    yield TestClient(create_app()), fake
    invitations.reset_invitation_store()
    org.reset_for_tests()


def _issue(client: TestClient, roles: list[str] | None = None) -> dict:
    resp = client.post(
        "/api/admin/clubs/c1/invitations",
        json={"proposed_roles": roles or ["coach"]},
        headers={
            **_S2S,
            "X-BIQ-Acting-User-Id": "admin1",
            "X-BIQ-Acting-Email": "admin@example.com",
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _redeem(client: TestClient, token: str, account: str) -> Any:
    return client.post(
        "/api/ops/invitations/redeem",
        json={"token": token},
        headers=_ops_headers(account, scope="verified"),
    )


def _inv_doc(fake: _FakeFirestore, invitation_id: str) -> dict:
    return dict(fake._docs[f"club_invitations/{invitation_id}"])


# ── strict-semantics tests ───────────────────────────────────────────────


class TestStrictRedeemAtomicity:
    def test_everything_commits_in_one_transaction(
        self, fx: tuple[TestClient, _FakeFirestore]
    ) -> None:
        """Invitation claim + member + roles land together — nothing is
        written outside the transaction boundary."""
        client, fake = fx
        issued = _issue(client)
        resp = _redeem(client, issued["token"], "acc_s1")
        assert resp.status_code == 200, resp.text
        member_id = resp.json()["membership_subject_id"]
        inv = _inv_doc(fake, issued["invitation_id"])
        assert inv["status"] == "redeemed"
        assert fake._docs[f"orgs_users/{member_id}"]["status"] == "active"
        role_path = f"orgs_clubs/club:c1/roles/{member_id}__coach__club:c1"
        assert fake._docs[role_path]["user_id"] == member_id

    def test_commit_failure_leaves_nothing_written(
        self, fx: tuple[TestClient, _FakeFirestore]
    ) -> None:
        """Every attempt's commit fails → 503 and the store is untouched:
        no claimed invitation, no orphan member, no role grant."""
        client, fake = fx
        issued = _issue(client)
        fake.always_fail_commits = True
        resp = _redeem(client, issued["token"], "acc_s2")
        assert resp.status_code == 503
        inv = _inv_doc(fake, issued["invitation_id"])
        assert inv["status"] == "pending", "aborted commits must not consume"
        member_paths = [p for p in fake._docs if p.startswith("orgs_users/f1f2m_")]
        assert member_paths == [], "no orphan member doc survived"
        role_paths = [
            p for p in fake._docs if p.startswith("orgs_clubs/club:c1/roles/f1f2m_")
        ]
        assert role_paths == [], "no orphan role doc survived"

    def test_revocation_racing_redeem_aborts_safely(
        self, fx: tuple[TestClient, _FakeFirestore]
    ) -> None:
        """A revocation committing between the redeem's read and its commit
        invalidates the read-set → retry sees the revoked doc → 409."""
        client, fake = fx
        issued = _issue(client)

        def revoke_competitor(fs: _FakeFirestore) -> None:
            doc = dict(fs._docs[f"club_invitations/{issued['invitation_id']}"])
            doc["status"] = "revoked"
            fs._docs[f"club_invitations/{issued['invitation_id']}"] = doc

        fake.commit_hooks.append(revoke_competitor)
        resp = _redeem(client, issued["token"], "acc_s3")
        assert resp.status_code == 409, resp.text
        assert _inv_doc(fake, issued["invitation_id"])["status"] == "revoked"
        member_paths = [p for p in fake._docs if p.startswith("orgs_users/f1f2m_")]
        assert member_paths == [], "a killed redeem writes no member"

    def test_issuer_demotion_racing_redeem_aborts_safely(
        self, fx: tuple[TestClient, _FakeFirestore]
    ) -> None:
        """Issuer losing roles.manage mid-redeem invalidates the query
        read-set → retry re-checks the issuer inside the fence → 409."""
        client, fake = fx
        issued = _issue(client)

        def demote_competitor(fs: _FakeFirestore) -> None:
            del fs._docs["orgs_clubs/club:c1/roles/admin1__administrator__club:c1"]

        fake.commit_hooks.append(demote_competitor)
        resp = _redeem(client, issued["token"], "acc_s4")
        assert resp.status_code == 409, resp.text
        assert _inv_doc(fake, issued["invitation_id"])["status"] == "pending", (
            "the claim itself must not land when the issuer check fails"
        )

    def test_replay_reanswers_without_rewriting_member_or_roles(
        self, fx: tuple[TestClient, _FakeFirestore]
    ) -> None:
        """Disabled member + removed role after redemption: a replay at the
        Firestore level re-answers 200 and writes nothing."""
        client, fake = fx
        issued = _issue(client, roles=["coach", "coordinator"])
        first = _redeem(client, issued["token"], "acc_s5")
        assert first.status_code == 200
        member_id = first.json()["membership_subject_id"]
        member_path = f"orgs_users/{member_id}"
        fake._docs[member_path]["status"] = "disabled"
        del fake._docs[f"orgs_clubs/club:c1/roles/{member_id}__coordinator__club:c1"]

        replay = _redeem(client, issued["token"], "acc_s5")
        assert replay.status_code == 200
        assert replay.json()["membership_subject_id"] == member_id
        assert fake._docs[member_path]["status"] == "disabled", (
            "replay must never reactivate a disabled membership"
        )
        coordinator_path = (
            f"orgs_clubs/club:c1/roles/{member_id}__coordinator__club:c1"
        )
        assert coordinator_path not in fake._docs, (
            "replay must never regrant a removed role"
        )
