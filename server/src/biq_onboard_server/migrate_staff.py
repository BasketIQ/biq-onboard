"""One-shot membership migration (OEE-1c · A4).

Seeds ``Team.staff_user_ids`` once from the current per-coach ``team_ids``
selections. After this migration, membership and selection diverge:
membership is admin-governed (D9), selection stays a per-coach display
filter (D14).

Idempotent: running it twice produces the same membership — a user already
in ``staff_user_ids`` is not re-added, and a user who was removed after the
first migration is not re-seeded (the script only adds, never removes).

Usage — per club, via the admin API:

    POST /api/admin/clubs/{club_id}/teams/migrate-staff

This is the only supported path. The Org Registry exposes no
``list_clubs`` primitive, so there is no way to enumerate clubs against
Firestore; a batch entry point was removed rather than ship untested code
that refused to run in production.
"""

from __future__ import annotations

from . import org


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
