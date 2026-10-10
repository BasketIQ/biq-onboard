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


# ── Atomic redeem: claim + membership + roles in one commit ─────────────
#
# The redeem path used to claim the invitation in one transaction and then
# write the member + role assignments in separate commits — a failure in
# between left a consumed invitation with no member, and a replay re-ran
# the member/role writes, silently reactivating a disabled membership or
# regranting a removed role. ``transact_redeem`` is the single fence:
# every validation read (invitation liveness, issuer user, issuer role
# assignments) happens inside the transaction and every staged write
# (invitation claim, member upsert, role grants) commits with it.


@dataclass
class RedeemRead:
    """Read view handed to ``decide`` inside the redeem fence.

    ``get_user`` returns the raw user document dict (``model_dump`` shape);
    ``list_assignments`` returns ``RoleAssignment`` models for the user at
    the scope. Both read through the transaction — never cached snapshots.
    """

    invitation: Invitation | None
    get_user: Callable[[str], dict[str, Any] | None]
    list_assignments: Callable[[str, str], list[Any]]


@dataclass
class RedeemPlan:
    """Outcome of ``decide`` — either an error or the staged writes."""

    invitation: Invitation | None = None  # staged invitation write
    member: Any = None  # org ``User`` model to upsert
    assignments: list[Any] = field(default_factory=list)
    response: dict[str, Any] | None = None
    error: tuple[int, str] | None = None


def transact_redeem(
    invitation_id: str,
    decide: Callable[[RedeemRead], RedeemPlan],
    *,
    store: Any = None,
    registry: Any = None,
    role_registry: Any = None,
) -> RedeemPlan:
    """Run ``decide`` under one atomic fence and commit its staged writes.

    Backends must be homogeneous — all memory, or all Firestore sharing
    the one cached client. A mixed deployment cannot honour the atomicity
    contract and fails closed with ``InvitationStoreUnavailable``.
    """
    if store is None:
        store = get_invitation_store()
    if registry is None or role_registry is None:
        from .org import get_registry, get_roles

        registry = registry if registry is not None else get_registry()
        role_registry = role_registry if role_registry is not None else get_roles()

    if isinstance(store, MemoryInvitationStore):
        from biq_core.org import MemoryOrgRegistry
        from biq_core.roles import MemoryRoleRegistry

        if not isinstance(registry, MemoryOrgRegistry) or not isinstance(
            role_registry, MemoryRoleRegistry
        ):
            raise InvitationStoreUnavailable(
                "mixed store backends cannot commit atomically"
            )

        def _get_user(user_id: str) -> dict[str, Any] | None:
            user = registry.get_user(user_id)
            return user.model_dump() if user is not None else None

        # The store's own lock is the fence — transact()/revoke serialize
        # against the whole decide+commit, so a revocation can never land
        # mid-redeem. The memory backend has no write batch: stage with a
        # snapshot so a mid-commit failure restores the pre-write state,
        # matching the Firestore abort contract.
        with store._lock:
            plan = decide(
                RedeemRead(
                    invitation=store.get(invitation_id),
                    get_user=_get_user,
                    list_assignments=role_registry.list_assignments,
                )
            )
            if plan.error:
                return plan
            prior_inv_doc = store._docs.get(invitation_id)
            prior_member = (
                registry.get_user(plan.member.id) if plan.member is not None else None
            )
            prior_assignments = {
                (a.scope, a.id): role_registry._assignments.get((a.scope, a.id))
                for a in plan.assignments
            }
            try:
                if plan.invitation is not None:
                    store.put(plan.invitation)
                if plan.member is not None:
                    registry.upsert_user(plan.member)
                for assignment in plan.assignments:
                    role_registry.put_assignment(assignment)
            except Exception:
                if prior_inv_doc is None:
                    store._docs.pop(invitation_id, None)
                else:
                    store._docs[invitation_id] = prior_inv_doc
                if plan.member is not None:
                    if prior_member is None:
                        registry._users.pop(plan.member.id, None)
                    else:
                        registry._users[plan.member.id] = prior_member
                for key, prior in prior_assignments.items():
                    if prior is None:
                        role_registry._assignments.pop(key, None)
                    else:
                        role_registry._assignments[key] = prior
                raise
            return plan

    if isinstance(store, FirestoreInvitationStore):
        from biq_core.org import FirestoreOrgRegistry
        from biq_core.roles import FirestoreRoleRegistry, RoleAssignment

        if not isinstance(registry, FirestoreOrgRegistry) or not isinstance(
            role_registry, FirestoreRoleRegistry
        ):
            raise InvitationStoreUnavailable(
                "mixed store backends cannot commit atomically"
            )
        client = store._client
        if getattr(registry, "_db", None) is not client or getattr(
            role_registry, "_db", None
        ) is not client:
            raise InvitationStoreUnavailable(
                "stores must share one Firestore client"
            )
        from google.cloud import firestore  # lazy import

        users_col = client.collection("orgs_users")
        clubs_col = client.collection("orgs_clubs")
        inv_ref = client.collection(COLLECTION).document(invitation_id)

        @firestore.transactional
        def _run(transaction: Any) -> RedeemPlan:
            snap = inv_ref.get(transaction=transaction)
            doc = FirestoreInvitationStore._snap_dict(snap)
            inv = _from_dict(invitation_id, doc) if doc else None

            def _get_user(user_id: str) -> dict[str, Any] | None:
                user_snap = users_col.document(user_id).get(transaction=transaction)
                return user_snap.to_dict() if getattr(user_snap, "exists", False) else None

            def _list_assignments(user_id: str, scope: str) -> list[Any]:
                query = (
                    clubs_col.document(scope)
                    .collection("roles")
                    .where("user_id", "==", user_id)
                )
                return [
                    RoleAssignment(**(d.to_dict() or {}))
                    for d in transaction.get(query)
                ]

            plan = decide(RedeemRead(inv, _get_user, _list_assignments))
            if plan.error:
                return plan
            if plan.invitation is not None:
                transaction.set(inv_ref, _to_dict(plan.invitation))
            if plan.member is not None:
                # Same merge contract as OrgRegistry.upsert_user.
                transaction.set(
                    users_col.document(plan.member.id),
                    plan.member.model_dump(exclude_none=True),
                    merge=True,
                )
            for assignment in plan.assignments:
                transaction.set(
                    clubs_col.document(assignment.scope)
                    .collection("roles")
                    .document(assignment.id),
                    assignment.model_dump(),
                )
            return plan

        return _run(client.transaction())

    raise InvitationStoreUnavailable("unknown invitation store backend")


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
