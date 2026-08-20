"""Shared test fixtures."""

import os
import pytest

os.environ.setdefault("BIQ_ORG_STORE", "memory")
os.environ.setdefault("BIQ_ROLES_STORE", "memory")
os.environ.setdefault("BIQ_ONBOARD_USER", "admin")
os.environ.setdefault("BIQ_ONBOARD_PASSWORD", "T3st1ng!")
os.environ.setdefault("BIQ_ONBOARD_SESSION_SECRET", "test-secret")
os.environ.setdefault("BIQ_ONBOARD_HTTPS_ONLY", "0")


@pytest.fixture(autouse=True)
def reset_registries():
    from biq_onboard_server import org

    org.reset_for_tests()
    yield
    org.reset_for_tests()
