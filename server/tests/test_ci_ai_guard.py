"""CI AI-call guard — basketiq-wow rule 10.

Active only under ``CI=true``. biq-onboard has no AI port: its outbound
clients (``clients.py``) call non-AI ops endpoints only (methodology
active-revision presence, season-plan team-plan-presence, biq-app
invite email). The guard asserts no AI credentials reach the test env
and pins the no-SDK invariant; the autouse conftest fixture blocks
AI-provider DNS.
"""

from __future__ import annotations

import os
import socket

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("CI") != "true",
    reason="rule 10 guard is active only under CI=true",
)

FORBIDDEN_ENV_VARS = (
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUDSDK_AUTH_ACCESS_TOKEN",
    "GOOGLE_GHA_CREDS_PATH",
)


def test_no_ai_credentials_in_test_environment():
    present = [name for name in FORBIDDEN_ENV_VARS if os.environ.get(name)]
    assert not present, f"AI credentials reachable in CI test env: {present}"


def test_no_ai_sdk_in_runtime_tree():
    """Pin the invariant — a future port must land with its fake."""
    import pathlib

    src = pathlib.Path(__file__).resolve().parents[1] / "src"
    assert src.is_dir()
    for py in src.rglob("*.py"):
        text = py.read_text(encoding="utf-8")
        for marker in ("vertexai", "GenerativeModel", "google.genai"):
            assert marker not in text, f"{py}: {marker} in runtime tree"


def test_ai_provider_dns_blocked():
    with pytest.raises(socket.gaierror):
        socket.getaddrinfo("generativelanguage.googleapis.com", 443)
