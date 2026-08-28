"""Org + Role Registry accessor for biq-onboard (ADR-009 pattern).

Mirrors biq-app's ``org.py``: lazily builds ``OrgRegistry`` and ``RoleRegistry``
from ``BIQ_ORG_STORE`` / ``BIQ_ROLES_STORE`` env vars. Firestore in production,
``MemoryOrgRegistry`` / ``MemoryRoleRegistry`` for tests.
"""

from __future__ import annotations

import os
from typing import Any

from biq_core.org import MemoryOrgRegistry, OrgRegistry
from biq_core.roles import MemoryRoleRegistry, RoleAuditLog, RoleRegistry

_registry: OrgRegistry | None = None
_roles: RoleRegistry | None = None
_fs_client: Any | None = None
_audit_log: RoleAuditLog | None = None


def _get_firestore_client() -> Any:
    """Lazily build a Firestore client (cached)."""
    global _fs_client
    if _fs_client is None:
        from google.cloud import firestore

        _fs_client = firestore.Client()
    return _fs_client


def firestore_client() -> Any | None:
    """Return the cached Firestore client, or None when using memory backends."""
    return _fs_client


def get_audit_log() -> RoleAuditLog:
    """Return the cached RoleAuditLog, sharing the same Firestore client."""
    global _audit_log
    if _audit_log is None:
        _audit_log = RoleAuditLog(client=_fs_client)
    return _audit_log


def get_registry() -> OrgRegistry:
    global _registry
    if _registry is None:
        kind = os.environ.get("BIQ_ORG_STORE", "firestore").strip().lower()
        if kind == "memory":
            _registry = MemoryOrgRegistry()
        else:
            from biq_core.org import FirestoreOrgRegistry

            _registry = FirestoreOrgRegistry(_get_firestore_client())
    return _registry


def get_roles() -> RoleRegistry:
    global _roles
    if _roles is None:
        kind = os.environ.get("BIQ_ROLES_STORE", "firestore").strip().lower()
        if kind == "memory":
            _roles = MemoryRoleRegistry()
        else:
            from biq_core.roles import FirestoreRoleRegistry

            _roles = FirestoreRoleRegistry(_get_firestore_client())
    return _roles


def reset_for_tests() -> None:
    global _registry, _roles, _fs_client, _audit_log
    _registry = None
    _roles = None
    _fs_client = None
    _audit_log = None
