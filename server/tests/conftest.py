"""Shared test fixtures."""

import os
import pytest

os.environ.setdefault("BIQ_ORG_STORE", "memory")
os.environ.setdefault("BIQ_ROLES_STORE", "memory")
os.environ.setdefault("BIQ_ONBOARD_USER", "admin")
os.environ.setdefault("BIQ_ONBOARD_PASSWORD", "T3st1ng!")
os.environ.setdefault("BIQ_ONBOARD_SESSION_SECRET", "test-secret")
os.environ.setdefault("BIQ_ONBOARD_HTTPS_ONLY", "0")


# basketiq-wow rule 10 (CI AI mocks): under CI=true no test may resolve
# an AI-provider host — a real AI call from a CI job is a defect.
_AI_BLOCKED_HOSTS = (
    "*.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    "*aiplatform.googleapis.com",
    "openrouter.ai",
    "*.openrouter.ai",
    "api.groq.com",
)


@pytest.fixture(autouse=True)
def _ci_ai_socket_guard(monkeypatch):
    if os.environ.get("CI") != "true":
        yield
        return
    import fnmatch
    import socket

    real_getaddrinfo = socket.getaddrinfo

    def guarded(host, port=0, *args, **kwargs):
        name = host.lower() if isinstance(host, str) else ""
        if any(fnmatch.fnmatch(name, pat) for pat in _AI_BLOCKED_HOSTS):
            raise socket.gaierror(
                f"CI AI guard (rule 10): DNS resolution of {host!r} blocked"
            )
        return real_getaddrinfo(host, port, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", guarded)
    yield


@pytest.fixture(autouse=True)
def reset_registries():
    from biq_onboard_server import org

    org.reset_for_tests()
    yield
    org.reset_for_tests()
