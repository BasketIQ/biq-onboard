"""Club invitation records — single-use, expiry-bound, tokenized.

An invitation is an opaque-token claim on club membership proposed by an
authorized issuer. The raw token is returned to the issuer exactly once;
the store keeps only ``sha256(token)`` so a leaked record cannot be
replayed. Claims are atomic (single-use + expiry + revocation enforced in
one transaction) and the redeemed membership row is written in the same
commit when the store backend supports it.

Backend selection via ``BIQ_INVITATION_STORE`` (``firestore`` default,
``memory`` for tests), mirroring the module's registry accessor pattern.
"""

from __future__ import annotations

import hashlib
import os
import secrets
import threading
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Callable

COLLECTION = "club_invitations"
DEFAULT_TTL_DAYS = 14


class InvitationStoreUnavailable(RuntimeError):
    """The durable invitation store failed — mapped to 503."""


class InvitationConflict(RuntimeError):
    """The invitation cannot be claimed in its current state."""


@dataclass
class Invitation:
    invitation_id: str
    club_id: str
    token_digest: str
    proposed_roles: list[str] = field(default_factory=list)
    recipient_email: str = ""
    issuer_membership_id: str = ""
    status: str = "pending"  # pending | redeemed | revoked | expired
    expires_at: str = ""
    created_at: str = ""
    redeemed_at: str = ""
    redeemed_account_id: str = ""
    membership_subject_id: str = ""

    def is_live(self, now_iso: str) -> bool:
        return self.status == "pending" and (not self.expires_at or self.expires_at > now_iso)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_token() -> str:
    return f"inv_{secrets.token_urlsafe(32)}"


def new_id() -> str:
    return f"in_{secrets.token_hex(8)}"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def default_expiry() -> str:
    return (datetime.now(UTC) + timedelta(days=DEFAULT_TTL_DAYS)).isoformat()


def _to_dict(inv: Invitation) -> dict[str, Any]:
    return asdict(inv)


def _from_dict(inv_id: str, data: dict[str, Any]) -> Invitation:
    return Invitation(
        invitation_id=inv_id,
        club_id=str(data.get("club_id", "")),
        token_digest=str(data.get("token_digest", "")),
        proposed_roles=list(data.get("proposed_roles") or []),
        recipient_email=str(data.get("recipient_email", "")),
        issuer_membership_id=str(data.get("issuer_membership_id", "")),
        status=str(data.get("status", "pending")),
        expires_at=str(data.get("expires_at", "")),
        created_at=str(data.get("created_at", "")),
        redeemed_at=str(data.get("redeemed_at", "")),
        redeemed_account_id=str(data.get("redeemed_account_id", "")),
        membership_subject_id=str(data.get("membership_subject_id", "")),
    )


class MemoryInvitationStore:
    """Process-local store — test backend, same transaction semantics."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._docs: dict[str, dict[str, Any]] = {}

    def put(self, inv: Invitation) -> None:
        with self._lock:
            self._docs[inv.invitation_id] = _to_dict(inv)

    def get(self, invitation_id: str) -> Invitation | None:
        with self._lock:
            doc = self._docs.get(invitation_id)
            return _from_dict(invitation_id, doc) if doc else None

    def get_by_digest(self, digest: str) -> Invitation | None:
        with self._lock:
            for inv_id, doc in self._docs.items():
                if doc.get("token_digest") == digest:
                    return _from_dict(inv_id, doc)
            return None

    def transact(
        self, invitation_id: str, fn: Callable[[Invitation | None], Invitation | None]
    ) -> Invitation | None:
        with self._lock:
            doc = self._docs.get(invitation_id)
            current = _from_dict(invitation_id, doc) if doc else None
            result = fn(current)
            if result is not None:
                self._docs[invitation_id] = _to_dict(result)
            return result if result is not None else current


class FirestoreInvitationStore:
    """Firestore-backed store — claim transaction is atomic single-use."""

    def __init__(self, client: Any) -> None:
        self._client = client

    def _ref(self, invitation_id: str):
        return self._client.collection(COLLECTION).document(invitation_id)

    @staticmethod
    def _snap_dict(snap: Any) -> dict[str, Any] | None:
        return snap.to_dict() if getattr(snap, "exists", False) else None

    def put(self, inv: Invitation) -> None:
        self._ref(inv.invitation_id).set(_to_dict(inv))

    def get(self, invitation_id: str) -> Invitation | None:
        doc = self._snap_dict(self._ref(inv.invitation_id).get())
        return _from_dict(invitation_id, doc) if doc else None

    def get_by_digest(self, digest: str) -> Invitation | None:
        snaps = (
            self._client.collection(COLLECTION)
            .where("token_digest", "==", digest)
            .limit(1)
            .stream()
        )
        for snap in snaps:
            return _from_dict(snap.id, snap.to_dict())
        return None

    def transact(
        self, invitation_id: str, fn: Callable[[Invitation | None], Invitation | None]
    ) -> Invitation | None:
        from google.cloud import firestore  # lazy import

        ref = self._ref(invitation_id)

        @firestore.transactional
        def _run(transaction: Any) -> Invitation | None:
            snap = ref.get(transaction=transaction)
            doc = self._snap_dict(snap)
            current = _from_dict(invitation_id, doc) if doc else None
            result = fn(current)
            if result is not None:
                transaction.set(ref, _to_dict(result))
            return result if result is not None else current

        return _run(self._client.transaction())


_store: Any = None


def get_invitation_store():
    """Lazily build and cache the configured invitation store."""
    global _store
    if _store is None:
        kind = os.environ.get("BIQ_INVITATION_STORE", "firestore").strip().lower()
        if kind == "memory":
            _store = MemoryInvitationStore()
        else:
            from .org import _get_firestore_client

            _store = FirestoreInvitationStore(_get_firestore_client())
    return _store


def reset_invitation_store() -> None:
    """Test helper: drop the cached singleton."""
    global _store
    _store = None
