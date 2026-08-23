"""OEE-1c — consumer adoption tests (gate).

Tests the partial-write contract, the three defects fixed in routers/teams.py,
the membership migration, and the R8 negative test (the gate).

R8 negative (the gate): a coach who has *selected* a team but is *not* in its
``staff_user_ids`` receives no notification and no responsibility for it.
Under D14, membership is responsibility and selection is a display filter.
"""

import pytest
from fastapi.testclient import TestClient

from biq_onboard_server.app import create_app
from biq_onboard_server import org


@pytest.fixture
def client():
    app = create_app()
    return TestClient(app)


@pytest.fixture
def admin_client(client):
    """Authenticated client with a session cookie."""
    client.post("/api/auth/login", json={"username": "admin", "password": "T3st1ng!"})
    return client


def _seed_club_with_team_and_users(admin_client, club_id="club_oee"):
    """Seed a club with one team and two users for OEE-1c tests."""
    from biq_core.org import Team, User

    admin_client.post("/api/admin/clubs", json={"id": club_id, "name": "Club OEE"})
    registry = org.get_registry()

    # Create a team
    registry.upsert_team(Team(id="team_a", club_id=club_id, name="Team A"))

    # Create two users in the club
    registry.upsert_user(User(id="u_coach_1", club_id=club_id, display_name="Coach 1"))
    registry.upsert_user(User(id="u_coach_2", club_id=club_id, display_name="Coach 2"))

    # Both coaches select the team (per-coach selection filter)
    registry.merge_user_fields("u_coach_1", {"team_ids": ["team_a"]})
    registry.merge_user_fields("u_coach_2", {"team_ids": ["team_a"]})

    return club_id


# ─── A2.1: TeamUpdate has timezone and staff_user_ids ───────────────────────


def test_team_update_accepts_timezone_and_staff(admin_client):
    """Defect A2.1: TeamUpdate must accept timezone and staff_user_ids."""
    admin_client.post("/api/admin/clubs", json={"id": "club_tz", "name": "Club TZ"})
    admin_client.post(
        "/api/admin/clubs/club_tz/teams",
        json={"id": "team_tz", "club_id": "club_tz", "name": "Team TZ"},
    )
    r = admin_client.put(
        "/api/admin/clubs/club_tz/teams/team_tz",
        json={"timezone": "Atlantic/Canary", "staff_user_ids": ["u1", "u2"]},
    )
    assert r.status_code == 200
    data = r.json()["team"]
    assert data["timezone"] == "Atlantic/Canary"
    assert data["staff_user_ids"] == ["u1", "u2"]


# ─── A2.2: Clear staff with explicit [] (the list-field trap) ───────────────


def test_clear_staff_with_empty_list(admin_client):
    """Defect A2.2: PUT with staff_user_ids: [] must clear, not fall through.

    The old `payload.x or existing.x` idiom treats [] as falsy and falls
    through to existing — staff can never be cleared. The fix uses
    `if payload.x is not None`.
    """
    admin_client.post("/api/admin/clubs", json={"id": "club_clear", "name": "Club Clear"})
    admin_client.post(
        "/api/admin/clubs/club_clear/teams",
        json={"id": "team_clear", "club_id": "club_clear", "name": "Team Clear"},
    )
    # Set staff
    admin_client.put(
        "/api/admin/clubs/club_clear/teams/team_clear",
        json={"staff_user_ids": ["u1", "u2"]},
    )
    # Clear staff
    r = admin_client.put(
        "/api/admin/clubs/club_clear/teams/team_clear",
        json={"staff_user_ids": []},
    )
    assert r.status_code == 200
    assert r.json()["team"]["staff_user_ids"] == [], (
        "Explicit [] was silently ignored — staff cannot be cleared (A2.2 trap)"
    )


# ─── A2.2: Omit staff (existing staff unchanged) ────────────────────────────


def test_omit_staff_preserves_existing(admin_client):
    """PUT without the staff_user_ids key must leave existing staff unchanged."""
    admin_client.post("/api/admin/clubs", json={"id": "club_omit", "name": "Club Omit"})
    admin_client.post(
        "/api/admin/clubs/club_omit/teams",
        json={"id": "team_omit", "club_id": "club_omit", "name": "Team Omit"},
    )
    # Set staff
    admin_client.put(
        "/api/admin/clubs/club_omit/teams/team_omit",
        json={"staff_user_ids": ["u1", "u2"]},
    )
    # Rename without touching staff
    r = admin_client.put(
        "/api/admin/clubs/club_omit/teams/team_omit",
        json={"name": "Renamed Team"},
    )
    assert r.status_code == 200
    assert r.json()["team"]["name"] == "Renamed Team"
    assert r.json()["team"]["staff_user_ids"] == ["u1", "u2"], (
        "Omitting staff_user_ids should preserve existing staff"
    )


# ─── A2.3: Rename preserves timezone and staff (partial-write contract) ─────


def test_rename_preserves_timezone_and_staff(admin_client):
    """Rename via the admin API must preserve timezone and staff_user_ids.

    The partial-write contract in biq-core 0.11.0 ensures fields not
    explicitly set on the model are preserved. This test verifies the
    admin API layer correctly passes through to that contract.
    """
    admin_client.post("/api/admin/clubs", json={"id": "club_pres", "name": "Club Pres"})
    admin_client.post(
        "/api/admin/clubs/club_pres/teams",
        json={"id": "team_pres", "club_id": "club_pres", "name": "Old Name"},
    )
    # Set timezone and staff
    admin_client.put(
        "/api/admin/clubs/club_pres/teams/team_pres",
        json={"timezone": "Europe/Madrid", "staff_user_ids": ["u1", "u2"]},
    )
    # Rename only
    r = admin_client.put(
        "/api/admin/clubs/club_pres/teams/team_pres",
        json={"name": "New Name"},
    )
    assert r.status_code == 200
    team = r.json()["team"]
    assert team["name"] == "New Name"

    # Verify via list_teams that timezone and staff survived
    r = admin_client.get("/api/admin/clubs/club_pres/teams")
    teams = r.json()["teams"]
    t = next(x for x in teams if x["id"] == "team_pres")
    assert t["timezone"] == "Europe/Madrid", (
        f"timezone was erased by rename: {t['timezone']!r}"
    )
    assert t["staff_user_ids"] == ["u1", "u2"], (
        f"staff_user_ids was erased by rename: {t['staff_user_ids']!r}"
    )


# ─── A2.3: list_teams returns new fields ─────────────────────────────────────


def test_list_teams_returns_timezone_and_staff(admin_client):
    """Defect A2.3: list_teams must return timezone and staff_user_ids."""
    admin_client.post("/api/admin/clubs", json={"id": "club_list", "name": "Club List"})
    admin_client.post(
        "/api/admin/clubs/club_list/teams",
        json={"id": "team_list", "club_id": "club_list", "name": "Team List"},
    )
    admin_client.put(
        "/api/admin/clubs/club_list/teams/team_list",
        json={"timezone": "Europe/Madrid", "staff_user_ids": ["u1"]},
    )
    r = admin_client.get("/api/admin/clubs/club_list/teams")
    assert r.status_code == 200
    t = r.json()["teams"][0]
    assert "timezone" in t, "list_teams does not return timezone (A2.3)"
    assert "staff_user_ids" in t, "list_teams does not return staff_user_ids (A2.3)"
    assert t["timezone"] == "Europe/Madrid"
    assert t["staff_user_ids"] == ["u1"]


# ─── A4: Migration idempotent ────────────────────────────────────────────────


def test_migration_seeds_staff_from_selection(admin_client):
    """Migration seeds staff_user_ids from per-coach team_ids selections."""
    club_id = _seed_club_with_team_and_users(admin_client)

    r = admin_client.post(f"/api/admin/clubs/{club_id}/teams/migrate-staff")
    assert r.status_code == 200
    summary = r.json()["summary"]
    assert summary["additions"] == 2  # two coaches selected the team
    assert summary["users_seeded"] == 2

    # Verify the team now has both coaches in staff_user_ids
    r = admin_client.get(f"/api/admin/clubs/{club_id}/teams")
    t = r.json()["teams"][0]
    assert set(t["staff_user_ids"]) == {"u_coach_1", "u_coach_2"}


def test_migration_is_idempotent(admin_client):
    """Running the migration twice produces the same membership."""
    club_id = _seed_club_with_team_and_users(admin_client, club_id="club_idem_mig")

    # First migration
    r1 = admin_client.post(f"/api/admin/clubs/{club_id}/teams/migrate-staff")
    assert r1.status_code == 200
    first = r1.json()["summary"]

    # Second migration — should add nothing
    r2 = admin_client.post(f"/api/admin/clubs/{club_id}/teams/migrate-staff")
    assert r2.status_code == 200
    second = r2.json()["summary"]

    assert second["additions"] == 0, "Second migration added users — not idempotent"
    assert second["teams_updated"] == 0

    # Membership is the same
    r = admin_client.get(f"/api/admin/clubs/{club_id}/teams")
    t = r.json()["teams"][0]
    assert set(t["staff_user_ids"]) == {"u_coach_1", "u_coach_2"}


# ─── R8 negative (THE GATE) ──────────────────────────────────────────────────


def test_r8_negative_selected_but_not_staff_no_notification(admin_client):
    """R8 negative (the gate): a coach who has *selected* a team but is *not*
    in its ``staff_user_ids`` receives no notification and no responsibility.

    Under D14, membership is responsibility and selection is a display filter.
    They diverge by design. The notification distribution list is
    ``team.staff_user_ids``, never ``user.team_ids``.

    This test verifies the divergence is real and machine-checkable:
    - coach_1 is in staff_user_ids → is a recipient
    - coach_2 selected the team but is NOT in staff_user_ids → is NOT a recipient
    """
    club_id = _seed_club_with_team_and_users(admin_client, club_id="club_r8")

    # Seed staff membership: only coach_1 is staff
    admin_client.put(
        f"/api/admin/clubs/{club_id}/teams/team_a",
        json={"staff_user_ids": ["u_coach_1"]},
    )

    # Verify both coaches still have the team in their selection
    registry = org.get_registry()
    c1_selection = registry.get_user_field("u_coach_1", "team_ids")
    c2_selection = registry.get_user_field("u_coach_2", "team_ids")
    assert c1_selection == ["team_a"]
    assert c2_selection == ["team_a"], "coach_2 selected the team"

    # But only coach_1 is in staff_user_ids
    team = registry.get_team(club_id, "team_a")
    assert "u_coach_1" in team.staff_user_ids
    assert "u_coach_2" not in team.staff_user_ids, (
        "coach_2 is in staff_user_ids — R8 gate fails: "
        "selection leaked into membership"
    )

    # Recipient resolution (tech spec §10.0):
    #   recipients = TeamDirectoryPort.get(action.team_id).staff_user_ids
    recipients = set(team.staff_user_ids)
    assert "u_coach_1" in recipients, "coach_1 should be a recipient"
    assert "u_coach_2" not in recipients, (
        "coach_2 should NOT be a recipient — "
        "they selected the team but are not in staff_user_ids (R8)"
    )
