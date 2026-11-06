import asyncio
import hashlib
import json
from pathlib import Path

import httpx


def test_observability_distribution_matches_published_checksum():
    root = Path(__file__).resolve().parents[2]
    manifest = json.loads((root / "vendor/observability.json").read_text())
    wheel = root / "vendor" / manifest["wheel"]
    assert hashlib.sha256(wheel.read_bytes()).hexdigest() == manifest["sha256"]
    assert manifest["source_commit"] == "a4f1d7dae20e5a66754a4f36164e8d6cc1911159"


def test_staging_trace_header_and_existing_response_are_preserved(monkeypatch, tmp_path):
    monkeypatch.setenv("BIQ_ONBOARD_STATIC_DIR", str(tmp_path))
    from biq_onboard_server.app import create_app
    monkeypatch.setenv("BIQ_OBSERVABILITY_ENABLED", "0")
    baseline = create_app()
    monkeypatch.setenv("BIQ_OBSERVABILITY_ENABLED", "1")
    observed = create_app()
    async def read(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.get("/__diagnostic_missing_route__", headers={
                "traceparent": "00-" + "a" * 32 + "-" + "b" * 16 + "-01",
                "x-biq-operation-id": "c" * 32,
            })
    original = asyncio.run(read(baseline))
    response = asyncio.run(read(observed))
    assert response.status_code == original.status_code
    assert response.content == original.content
    assert response.headers["x-biq-operation-id"] == "c" * 32
    assert response.headers["x-biq-trace-id"] == "a" * 32
