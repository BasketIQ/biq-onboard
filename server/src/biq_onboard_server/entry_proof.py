"""Entry-proof verification — ``biq:onboard:entry-v1`` actor proofs.

The App mints a short-lived HS256 proof (``iss=biq-app-context-v1``,
``aud=biq:onboard:entry-v1``, claims ``sub``=account id + ``jti``) and
sends it on ``X-BIQ-Entry-Token`` beside the S2S bearer on authorized
entry calls (invitation preview/redeem, gated club create). Verification
here is signature+expiry+claims only — a valid proof says *which account*
App resolved, never that the operation is authorized; each endpoint
re-checks its own policy (invitation state, expiry, single use).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

ALG = "HS256"
ISS = "biq-app-context-v1"
ENTRY_AUD = "biq:onboard:entry-v1"
SECRET_ENV = "BIQ_EMBED_JWT_SECRET"
ENTRY_TOKEN_HEADER = "X-BIQ-Entry-Token"


class EntryProofError(RuntimeError):
    """The presented entry proof failed verification."""


def _b64url_decode(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


def _sign(signing_input: bytes, key: str) -> str:
    digest = hmac.new(key.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def verify_entry_proof(
    token: str, *, key: str | None = None, now: int | None = None
) -> dict[str, Any]:
    """Verify signature + iss/aud + expiry; returns claims.

    Raises :class:`EntryProofError` on any problem — never returns a
    partial result.
    """
    verify_key = key if key is not None else os.environ.get(SECRET_ENV, "")
    if not verify_key:
        raise EntryProofError("entry proof secret not configured")
    try:
        header_seg, payload_seg, signature = token.split(".")
    except ValueError as exc:
        raise EntryProofError("malformed proof") from exc
    expected = _sign(f"{header_seg}.{payload_seg}".encode("ascii"), verify_key)
    if not hmac.compare_digest(expected, signature):
        raise EntryProofError("bad signature")
    try:
        payload = json.loads(_b64url_decode(payload_seg))
    except Exception as exc:  # noqa: BLE001
        raise EntryProofError("bad payload") from exc
    if not isinstance(payload, dict):
        raise EntryProofError("bad payload")
    if payload.get("iss") != ISS:
        raise EntryProofError("bad issuer")
    if payload.get("aud") != ENTRY_AUD:
        raise EntryProofError("bad audience")
    exp = payload.get("exp")
    if not isinstance(exp, int):
        raise EntryProofError("no expiry")
    ts = int(now if now is not None else time.time())
    if ts > exp + 60:
        raise EntryProofError("expired")
    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub:
        raise EntryProofError("no subject")
    return payload


def proof_from_request(request) -> dict[str, Any]:
    """Extract + verify the entry proof from ``X-BIQ-Entry-Token``."""
    token = request.headers.get(ENTRY_TOKEN_HEADER, "")
    if not token:
        raise EntryProofError("missing entry proof")
    return verify_entry_proof(token)
