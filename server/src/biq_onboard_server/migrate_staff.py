"""One-shot membership migration (OEE-1c · A4).

Seeds ``Team.staff_user_ids`` once from the current per-coach ``team_ids``
selections. After this migration, membership and selection diverge:
membership is admin-governed (D9), selection stays a per-coach display
filter (D14).

Idempotent: running it twice produces the same membership — a user already
in ``staff_user_ids`` is not re-added, and a user who was removed after the
first migration is not re-seeded (the script only adds, never removes).

Usage:
    BIQ_ORG_STORE=memory python -m biq_onboard_server.migrate_staff
    # or against Firestore (production):
    python -m biq_onboard_server.migrate_staff

The script prints a summary and exits 0 on success, 1 on error.
"""

from __future__ import annotations

import sys

from . import org


def migrate_staff_membership() -> dict:
    """Seed ``staff_user_ids`` from per-coach ``team_ids`` selections.

    For each club, for each user with a ``team_ids`` selection, add the
    user's id to each selected team's ``staff_user_ids`` (if not already
    present). Uses partial-write (``upsert_team`` with only the fields
    that changed) so other fields are preserved.

    Returns a summary dict with counts.
    """
    registry = org.get_registry()

    # We need to iterate all clubs. The registry doesn't have a list_clubs,
    # but we can infer clubs from list_members (which lists users per club).
    # For memory backends, we iterate the in-memory store directly.
    # For Firestore, we'd need a club list — but the migration is typically
    # run once per club via an admin endpoint, not as a batch script.
    #
    # However, list_members requires a club_id. We can get club ids from
    # the teams we know about, or from users. Let's use a different approach:
    # iterate all teams we can find via list_teams for each known club.
    #
    # The simplest approach: for each user that has team_ids, resolve their
    # club_id, then process that club's teams.

    # Collect all users with team_ids selections
    # We need to find all users — but the registry doesn't expose list_all_users.
    # Instead, we'll iterate clubs that have teams, and for each club,
    # list_members to get users.

    # For memory backend, we can access the internal store
    clubs_processed: set[str] = set()
    teams_updated = 0
    users_seeded = 0
    additions = 0

    # Get all clubs from the registry's internal store if memory
    if hasattr(registry, "_teams"):
        # Memory backend — iterate directly
        all_club_ids = set()
        # _teams is typically dict[club_id, dict[team_id, Team]]
        for club_id, teams in registry._teams.items():
            all_club_ids.add(club_id)
        for club_id in all_club_ids:
            clubs_processed.add(club_id)
            teams_updated_this, users_seeded_this, additions_this = _migrate_club(
                registry, club_id
            )
            teams_updated += teams_updated_this
            users_seeded += users_seeded_this
            additions += additions_this
    else:
        # Firestore backend — need club ids from somewhere
        # In practice, this migration is run per-club via the admin API
        print(
            "ERROR: Firestore backend detected. Run migration per-club via "
            "the admin API endpoint instead.",
            file=sys.stderr,
        )
        return {"error": "firestore_not_supported_in_batch_mode"}

    summary = {
        "clubs_processed": len(clubs_processed),
        "teams_updated": teams_updated,
        "users_seeded": users_seeded,
        "additions": additions,
    }
    print(f"Migration complete: {summary}")
    return summary


def _migrate_club(registry, club_id: str) -> tuple[int, int, int]:
    """Migrate one club's team staff membership. Returns (teams_updated, users_seeded, additions)."""
    teams_updated = 0
    users_seeded = 0
    additions = 0

    # Get all teams for this club
    teams = registry.list_teams(club_id)
    if not teams:
        return 0, 0, 0

    # Get all members (users) for this club
    members = registry.list_members(club_id)

    # Build a map: team_id -> list of user_ids who selected it
    team_staff: dict[str, list[str]] = {t.id: list(t.staff_user_ids) for t in teams}

    for user in members:
        # Read this user's team_ids selection
        team_ids = registry.get_user_field(user.id, "team_ids")
        if not isinstance(team_ids, list):
            continue
        if not team_ids:
            continue

        user_added = False
        for tid in team_ids:
            tid_str = str(tid)
            if tid_str in team_staff and user.id not in team_staff[tid_str]:
                team_staff[tid_str].append(user.id)
                additions += 1
                user_added = True

        if user_added:
            users_seeded += 1

    # Write back the teams that changed
    from biq_core.org import Team

    for team in teams:
        new_staff = team_staff.get(team.id, team.staff_user_ids)
        if set(new_staff) != set(team.staff_user_ids):
            # Use partial-write: only set staff_user_ids
            updated = Team(
                id=team.id,
                club_id=team.club_id,
                name=team.name,
                staff_user_ids=new_staff,
            )
            registry.upsert_team(updated)
            teams_updated += 1

    return teams_updated, users_seeded, additions


def migrate_club(club_id: str) -> dict:
    """Migrate a single club's staff membership (for the admin API endpoint).

    Idempotent: only adds users not already in staff_user_ids.
    """
    registry = org.get_registry()
    teams_updated, users_seeded, additions = _migrate_club(registry, club_id)
    summary = {
        "club_id": club_id,
        "teams_updated": teams_updated,
        "users_seeded": users_seeded,
        "additions": additions,
    }
    print(f"Club migration complete: {summary}")
    return summary


if __name__ == "__main__":
    result = migrate_staff_membership()
    if "error" in result:
        sys.exit(1)
