"""Outbound service-to-service clients (Mi Club Phase 3).

Presence checks for the club profile summary — mirrors
``biq_season_plan_server.methodology_client``: canonical
``BIQ_INTERNAL_TOKEN`` auth, short timeouts, and a tri-state result so a
transient upstream failure reads as "unknown", never as "absent".
"""

from __future__ import annotations

import logging
import os

import httpx

logger = logging.getLogger(__name__)


class UpstreamServiceError(Exception):
    """An outbound S2S call failed or the upstream reported failure."""


def _internal_token() -> str:
    return os.environ.get("BIQ_INTERNAL_TOKEN", "")


def _get(url: str, params: dict[str, str]) -> httpx.Response:
    return httpx.get(
        url,
        params=params,
        headers={"X-Internal-Token": _internal_token()},
        timeout=5.0,
    )


def methodology_present(club_id: str) -> bool | None:
    """Whether the club has a published methodology.

    ``True`` on 200, ``False`` on 404, ``None`` on any other failure
    (missing URL/token, connection error, unexpected status) — the profile
    renders "Desconocido" rather than a wrong "No".
    """
    base = os.environ.get("BIQ_METHODOLOGY_URL", "").rstrip("/")
    if not base:
        logger.warning("BIQ_METHODOLOGY_URL not configured — methodology presence unknown")
        return None
    try:
        resp = _get(
            f"{base}/api/ops/methodology/active-revision",
            {"club_id": club_id},
        )
    except Exception as exc:
        logger.warning("methodology presence check failed: %s", exc)
        return None
    if resp.status_code == 200:
        return True
    if resp.status_code == 404:
        return False
    logger.warning("methodology presence check: unexpected %s", resp.status_code)
    return None


def season_plan_present(team_ids: list[str]) -> bool | None:
    """Whether any of the club's teams has a season plan.

    Same tri-state contract as :func:`methodology_present`. The season-plan
    ops endpoint takes the club's team ids because plans are stored per
    coach/team with no club concept.
    """
    base = os.environ.get("BIQ_SEASON_PLAN_URL", "").rstrip("/")
    if not base:
        logger.warning("BIQ_SEASON_PLAN_URL not configured — season-plan presence unknown")
        return None
    if not team_ids:
        return False
    try:
        resp = _get(
            f"{base}/api/ops/team-plan-presence",
            {"team_ids": ",".join(team_ids)},
        )
    except Exception as exc:
        logger.warning("season-plan presence check failed: %s", exc)
        return None
    if resp.status_code != 200:
        logger.warning("season-plan presence check: unexpected %s", resp.status_code)
        return None
    try:
        return bool(resp.json().get("has_plan"))
    except Exception as exc:
        logger.warning("season-plan presence check: malformed body: %s", exc)
        return None


def send_invite(to: str, club_name: str, club_id: str) -> dict:
    """Ask biq-app to send a club invite email (Mi Club Phase 5).

    ``POST {BIQ_APP_URL}/internal/email/invite`` with the canonical
    ``X-Internal-Token``. Raises ``UpstreamServiceError`` when the app URL is
    unconfigured, the call fails, or the send did not succeed — the endpoint
    maps that to 502 rather than pretending the email went out.
    """
    base = os.environ.get("BIQ_APP_URL", "").rstrip("/")
    if not base:
        raise UpstreamServiceError("BIQ_APP_URL not configured")
    try:
        resp = httpx.post(
            f"{base}/internal/email/invite",
            json={"to": to, "club_name": club_name, "club_id": club_id},
            headers={"X-Internal-Token": _internal_token()},
            timeout=10.0,
        )
    except Exception as exc:
        raise UpstreamServiceError(f"invite request failed: {exc}") from exc
    if resp.status_code != 200:
        raise UpstreamServiceError(f"invite endpoint returned {resp.status_code}")
    data = resp.json()
    if not data.get("ok"):
        raise UpstreamServiceError(f"invite send failed: {data.get('error', 'unknown')}")
    return data
