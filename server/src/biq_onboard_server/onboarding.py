"""Onboarding orchestration: one-shot club + teams + users + roles.

Ported from biq-mcp's ``org_tools.py`` so biq-onboard owns the business logic
server-side. biq-mcp will call the HTTP API instead of running this directly.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from biq_core.org import Club, Team, User
from biq_core.org.catalog import build_team_catalog
from biq_core.org.passwords import hash_password
from biq_core.roles import RoleAssignment
from biq_core.roles.models import ROLES

from . import org

_DEFAULT_STAFF = [
    {"username": "admin", "display_name": "Administrator", "role": "administrator"},
    {"username": "director", "display_name": "Sports Director", "role": "sports_director"},
    {"username": "coord1", "display_name": "Coordinator 1", "role": "coordinator"},
    {"username": "coord2", "display_name": "Coordinator 2", "role": "coordinator"},
    {"username": "coach1", "display_name": "Coach 1", "role": "coach"},
    {"username": "coach2", "display_name": "Coach 2", "role": "coach"},
    {"username": "coach3", "display_name": "Coach 3", "role": "coach"},
    {"username": "prepa1", "display_name": "Physical Coach 1", "role": "coach"},
    {"username": "prepa2", "display_name": "Physical Coach 2", "role": "coach"},
]

_CLUB_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_]*$")
_USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9_]*$")


def _validate_club_id(club_id: str) -> None:
    if not _CLUB_ID_RE.match(club_id):
        raise ValueError(f"invalid club_id: {club_id}")


def _validate_username(username: str) -> None:
    if not _USERNAME_RE.match(username):
        raise ValueError(f"invalid username: {username}")


def _make_user_id(username: str, club_id: str) -> str:
    return f"{username}_{club_id}"


def _resolve_staff(staff: list[dict] | None) -> list[dict]:
    raw = staff if staff is not None else _DEFAULT_STAFF
    resolved = []
    seen = set()
    for entry in raw:
        username = entry["username"]
        _validate_username(username)
        if username in seen:
            raise ValueError(f"duplicate username: {username}")
        seen.add(username)
        roles = entry.get("roles", entry.get("role", "coach"))
        if isinstance(roles, str):
            roles = [roles]
        for r in roles:
            if r not in ROLES:
                raise ValueError(f"Unknown role: {r}")
        resolved.append({**entry, "roles": roles})
    return resolved


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def seed_club_team_catalog(
    registry, club_id: str, catalog_slug: str, season_year: int
) -> int:
    """Seed the default team catalog as one bulk write, tracked on the club.

    ``Club.team_seeding_job`` is an opaque map owned here (biq_core stores it
    unvalidated): ``pending`` is persisted BEFORE the write (same ordering
    discipline as the theme job — a crash mid-seed must never look like "no
    seeding ran"), then ``done``/``failed`` after. ``catalog_slug`` is the
    team-id namespace (``team_<slug>_...``) — ``club_id`` for self-service
    clubs, a distinct slug for admin-onboarded ones. Raises on write failure
    after persisting ``failed`` so callers keep today's failure semantics.
    """
    catalog_dicts = build_team_catalog(catalog_slug, season_year)
    job = {
        "status": "pending",
        "requestedAt": _now_iso(),
        "finishedAt": None,
        "teams_expected": len(catalog_dicts),
        "teams_written": 0,
        "reason": None,
        # Recorded so a reseed can rebuild the same team-id namespace even
        # when the club has zero teams left to parse the slug from.
        "catalog_slug": catalog_slug,
    }
    registry.merge_club_fields(club_id, {"team_seeding_job": job})
    try:
        registry.bulk_upsert_teams(
            club_id,
            [
                Team(
                    id=t["id"],
                    club_id=club_id,
                    name=t["name"],
                    category=t.get("category"),
                    gender=t.get("gender"),
                    label=t.get("label"),
                )
                for t in catalog_dicts
            ],
        )
    except Exception as exc:
        job.update(
            {"status": "failed", "finishedAt": _now_iso(), "reason": str(exc)}
        )
        registry.merge_club_fields(club_id, {"team_seeding_job": job})
        raise
    job.update(
        {
            "status": "done",
            "finishedAt": _now_iso(),
            "teams_written": len(catalog_dicts),
        }
    )
    registry.merge_club_fields(club_id, {"team_seeding_job": job})
    return len(catalog_dicts)


def _find_senior_team(teams: list[Team], slug: str) -> str | None:
    for t in teams:
        if t.id == f"team_{slug}_senior_m":
            return t.id
    for t in teams:
        if "senior" in t.id and t.id.endswith("_m"):
            return t.id
    return teams[0].id if teams else None


def onboard_club(
    club_id: str,
    name: str,
    slug: str,
    short_name: str | None = None,
    season: str | None = None,
    staff: list[dict] | None = None,
    password: str = "b4sk3t.26",
    reset_passwords: bool = False,
) -> dict:
    _validate_club_id(club_id)
    registry = org.get_registry()
    roles = org.get_roles()

    # 1. Club
    club = Club(id=club_id, name=name, short_name=short_name)
    registry.upsert_club(club)

    # 2. Teams — one bulk write (was: 28 sequential upsert_team calls)
    season_year_str = season.split("/")[0] if season else "2026"
    season_year = int(season_year_str)
    teams_created = seed_club_team_catalog(registry, club_id, slug, season_year)
    teams = registry.list_teams(club_id)
    teams_verified = len(teams)
    default_team_id = _find_senior_team(teams, slug)

    # 3. Users + roles
    resolved = _resolve_staff(staff)
    scope = f"club:{club_id}"
    staff_results = []
    users_created = 0
    roles_assigned = 0

    for entry in resolved:
        username = entry["username"]
        user_id = _make_user_id(username, club_id)
        display_name = entry.get("display_name", username)
        user_role = entry["roles"][0]
        entry_team_id = entry.get("default_team_id", default_team_id)
        pw = entry.get("password", password)

        existing = registry.get_user(user_id)
        pw_hash = hash_password(pw)
        if existing and existing.password_hash and not reset_passwords:
            pw_hash = existing.password_hash

        user = User(
            id=user_id,
            club_id=club_id,
            role=user_role,
            display_name=display_name,
            default_team_id=entry_team_id,
            password_hash=pw_hash,
        )
        registry.upsert_user(user)
        users_created += 1

        for r in entry["roles"]:
            assignment = RoleAssignment(
                id=f"{user_id}__{r}__{scope}",
                user_id=user_id,
                role=r,
                scope=scope,
            )
            roles.put_assignment(assignment)
            roles_assigned += 1

        staff_results.append({
            "user_id": user_id,
            "display_name": display_name,
            "roles": entry["roles"],
        })

    return {
        "ok": True,
        "club": {"id": club_id, "name": name},
        "teams_created": teams_created,
        "teams_verified": teams_verified,
        "users_created": users_created,
        "users_verified": len(registry.list_members(club_id)),
        "roles_assigned": roles_assigned,
        "roles_verified": len(roles.list_assignments_for_scope(scope)),
        "scope": scope,
        "season": season,
        "staff": staff_results,
    }


def offboard_club(club_id: str) -> dict:
    """Delete a club and all its teams, users, and role assignments."""
    _validate_club_id(club_id)
    registry = org.get_registry()
    roles = org.get_roles()
    scope = f"club:{club_id}"

    # Delete role assignments
    assignments = roles.list_assignments_for_scope(scope)
    for a in assignments:
        roles.remove_assignment(a.id)

    # Delete users belonging to this club
    members = registry.list_members(club_id)
    for m in members:
        # We don't have a delete_user in the registry; use Firestore directly
        # if available, or skip in memory mode.
        _delete_user_safe(registry, m.id)

    # Delete teams
    teams = registry.list_teams(club_id)
    for t in teams:
        _delete_team_safe(registry, club_id, t.id)

    # Delete club
    _delete_club_safe(registry, club_id)

    return {
        "ok": True,
        "club_id": club_id,
        "roles_removed": len(assignments),
        "users_removed": len(members),
        "teams_removed": len(teams),
    }


def _delete_user_safe(registry, user_id: str) -> None:
    """Best-effort user deletion (registry may not expose delete)."""
    try:
        from biq_core.org import FirestoreOrgRegistry, MemoryOrgRegistry

        if isinstance(registry, MemoryOrgRegistry):
            registry._users.pop(user_id, None)  # type: ignore[attr-defined]
        elif isinstance(registry, FirestoreOrgRegistry):
            registry._db.collection("orgs_users").document(user_id).delete()  # type: ignore[attr-defined]
    except Exception:
        pass


def _delete_team_safe(registry, club_id: str, team_id: str) -> None:
    try:
        from biq_core.org import FirestoreOrgRegistry, MemoryOrgRegistry

        if isinstance(registry, MemoryOrgRegistry):
            registry._teams.pop(team_id, None)  # type: ignore[attr-defined]
        elif isinstance(registry, FirestoreOrgRegistry):
            registry._db.collection("orgs_clubs").document(club_id).collection("teams").document(team_id).delete()  # type: ignore[attr-defined]
    except Exception:
        pass


def _delete_club_safe(registry, club_id: str) -> None:
    try:
        from biq_core.org import FirestoreOrgRegistry, MemoryOrgRegistry

        if isinstance(registry, MemoryOrgRegistry):
            registry._clubs.pop(club_id, None)  # type: ignore[attr-defined]
        elif isinstance(registry, FirestoreOrgRegistry):
            registry._db.collection("orgs_clubs").document(club_id).delete()  # type: ignore[attr-defined]
    except Exception:
        pass
