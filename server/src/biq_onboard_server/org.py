"""Org + Role Registry accessor for biq-onboard (ADR-009 pattern).

Mirrors biq-app's ``org.py``: lazily builds ``OrgRegistry`` and ``RoleRegistry``
from ``BIQ_ORG_STORE`` / ``BIQ_ROLES_STORE`` env vars. Firestore in production,
``MemoryOrgRegistry`` / ``MemoryRoleRegistry`` for tests.
"""

from __future__ import annotations

import os

from biq_core.org import MemoryOrgRegistry, OrgRegistry
from biq_core.roles import MemoryRoleRegistry, RoleRegistry

_registry: OrgRegistry | None = None
_roles: RoleRegistry | None = None


def get_registry() -> OrgRegistry:
    global _registry
    if _registry is None:
        kind = os.environ.get("BIQ_ORG_STORE", "firestore").strip().lower()
        if kind == "memory":
            _registry = MemoryOrgRegistry()
        else:
            from google.cloud import firestore

            from biq_core.org import FirestoreOrgRegistry

            _registry = FirestoreOrgRegistry(firestore.Client())
    return _registry


def get_roles() -> RoleRegistry:
    global _roles
    if _roles is None:
        kind = os.environ.get("BIQ_ROLES_STORE", "firestore").strip().lower()
        if kind == "memory":
            _roles = MemoryRoleRegistry()
        else:
            from google.cloud import firestore

            from biq_core.roles import FirestoreRoleRegistry

            _roles = FirestoreRoleRegistry(firestore.Client())
    return _roles


def reset_for_tests() -> None:
    global _registry, _roles
    _registry = None
    _roles = None
