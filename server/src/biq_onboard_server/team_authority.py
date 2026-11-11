"""Club team mutations use App's atomic beta authority, never a read/count/write."""
from __future__ import annotations

import os
import threading
from urllib.parse import urlsplit

from biq_core.org import Team
from fastapi import HTTPException
import httpx

from . import org
from .clients import _internal_token

_memory_lock = threading.RLock()
_ERRORS = {
    "club_team_limit_reached": 409, "club_subscription_required": 403,
    "sports_director_required": 403, "actor_inactive": 403,
    "club_not_found": 404, "team_not_found": 404, "invalid_team": 422,
}


class HttpTeamAuthority:
    def upsert(self, actor_user_id: str, club_id: str, patches: list[dict], *, create_only=False) -> dict:
        base = os.environ.get("BIQ_APP_URL", "").rstrip("/")
        try:
            parsed = urlsplit(base)
        except ValueError:
            raise HTTPException(503, "club_team_authority_unavailable") from None
        token = _internal_token()
        if (parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password
                or parsed.path or parsed.query or parsed.fragment or not token):
            raise HTTPException(503, "club_team_authority_unavailable")
        try:
            response = httpx.post(
                base + "/api/ops/club-teams/v1",
                json={"actor_user_id": actor_user_id, "club_id": club_id, "teams": patches,
                      "create_only": create_only},
                headers={"X-Internal-Token": token}, timeout=15.0, follow_redirects=False,
            )
            data = response.json()
        except (httpx.HTTPError, ValueError):
            raise HTTPException(503, "club_team_authority_unavailable") from None
        if response.status_code != 200:
            code = data.get("detail") if isinstance(data, dict) else None
            if isinstance(code, str) and _ERRORS.get(code) == response.status_code:
                raise HTTPException(response.status_code, code)
            raise HTTPException(503, "club_team_authority_unavailable")
        if (not isinstance(data, dict) or data.get("club_id") != club_id
                or type(data.get("limit")) is not int or data["limit"] != 5
                or type(data.get("revision")) is not int or data["revision"] < 0
                or type(data.get("active_count")) is not int or data["active_count"] < 0
                or not isinstance(data.get("teams"), list) or len(data["teams"]) != len(patches)
                or any(not isinstance(row, dict) or row.get("club_id") != club_id
                       or not isinstance(row.get("id"), str)
                       for row in data["teams"])
                or {row.get("id") for row in data["teams"]} != {row["id"] for row in patches}):
            raise HTTPException(503, "club_team_authority_unavailable")
        return data


class MemoryTeamAuthority:
    """Deterministic local port; never a fallback from a failed HTTP mutation."""

    def upsert(self, actor_user_id: str, club_id: str, patches: list[dict], *, create_only=False) -> dict:
        with _memory_lock:
            registry = org.get_registry()
            before = {team.id: team for team in registry.list_teams(club_id)}
            after = dict(before)
            try:
                for patch in patches:
                    previous = before[patch["id"]].model_dump(mode="json") if patch["id"] in before else {}
                    merged = Team.model_validate({**previous, **patch}, strict=True)
                    after[patch["id"]] = before[patch["id"]] if create_only and previous else merged
            except ValueError:
                raise HTTPException(422, "invalid_team") from None
            added = {key for key, team in after.items() if not team.archived} - {
                key for key, team in before.items() if not team.archived
            }
            count = sum(not team.archived for team in after.values())
            if added and count > 5:
                raise HTTPException(409, "club_team_limit_reached")
            for patch in patches:
                registry.upsert_team(after[patch["id"]])
            return {"club_id": club_id, "limit": 5, "active_count": count, "revision": 0,
                    "created_team_ids": sorted(set(after) - set(before)),
                    "teams": [after[patch["id"]].model_dump(mode="json") for patch in patches]}


def upsert(actor_user_id: str, club_id: str, patches: list[dict], *, create_only=False) -> dict:
    authority = (MemoryTeamAuthority() if os.environ.get("BIQ_ORG_STORE", "").lower() == "memory"
                 else HttpTeamAuthority())
    return authority.upsert(actor_user_id, club_id, patches, create_only=create_only)
