"""Tests for biq-onboard admin API."""

import pytest
from fastapi.testclient import TestClient

from biq_onboard_server.app import create_app


@pytest.fixture
def client():
    app = create_app()
    return TestClient(app)


@pytest.fixture
def admin_client(client):
    """Authenticated client with a session cookie."""
    client.post("/api/auth/login", json={"username": "admin", "password": "T3st1ng!"})
    return client


# ─── Health ──────────────────────────────────────────────────────────────────


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["service"] == "biq-onboard"


# ─── Auth ────────────────────────────────────────────────────────────────────


def test_login_success(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": "T3st1ng!"})
    assert r.status_code == 200
    assert r.json()["user"] == "admin"


def test_login_fail(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
    assert r.status_code == 401


def test_admin_requires_auth(client):
    r = client.get("/api/admin/clubs")
    assert r.status_code == 401


# ─── Onboarding ──────────────────────────────────────────────────────────────


def test_onboard_club_default_staff(admin_client):
    r = admin_client.post(
        "/api/admin/clubs/club_test/onboard",
        json={"club_id": "club_test", "name": "Club Test", "slug": "test", "season": "2026/27"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["users_created"] == 9
    assert data["roles_assigned"] == 9
    assert data["teams_created"] > 0
    staff_ids = [s["user_id"] for s in data["staff"]]
    assert "admin_club_test" in staff_ids
    assert "director_club_test" in staff_ids
    assert "prepa1_club_test" in staff_ids


def test_onboard_club_custom_staff(admin_client):
    r = admin_client.post(
        "/api/admin/clubs/club_custom/onboard",
        json={
            "club_id": "club_custom",
            "name": "Club Custom",
            "slug": "custom",
            "season": "2026/27",
            "staff": [
                {"username": "juanjo", "display_name": "Juanjo", "roles": ["sports_director", "administrator"]},
                {"username": "koldo", "display_name": "Koldo", "roles": "coach"},
            ],
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["users_created"] == 2
    assert data["roles_assigned"] == 3
    juanjo = next(s for s in data["staff"] if "juanjo" in s["user_id"])
    assert sorted(juanjo["roles"]) == ["administrator", "sports_director"]


def test_onboard_rejects_unknown_role(admin_client):
    r = admin_client.post(
        "/api/admin/clubs/club_bad/onboard",
        json={
            "club_id": "club_bad",
            "name": "Club Bad",
            "slug": "bad",
            "season": "2026/27",
            "staff": [{"username": "x", "roles": ["superadmin"]}],
        },
    )
    assert r.status_code == 400  # ValueError → 400


def test_onboard_idempotent(admin_client):
    payload = {"club_id": "club_idem", "name": "Club Idem", "slug": "idem", "season": "2026/27"}
    r1 = admin_client.post("/api/admin/clubs/club_idem/onboard", json=payload)
    r2 = admin_client.post("/api/admin/clubs/club_idem/onboard", json=payload)
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r2.json()["users_verified"] == r1.json()["users_verified"]


# ─── Staff listing ───────────────────────────────────────────────────────────


def test_list_staff(admin_client):
    admin_client.post(
        "/api/admin/clubs/club_staff/onboard",
        json={"club_id": "club_staff", "name": "Club Staff", "slug": "staff", "season": "2026/27"},
    )
    r = admin_client.get("/api/admin/clubs/club_staff/staff")
    assert r.status_code == 200
    data = r.json()
    assert data["total_members"] == 9
    admin = next(m for m in data["members"] if "admin" in m["user_id"])
    assert "administrator" in admin["methodology_roles"]
    # Staff entries should include the email field (may be None for seed users)
    assert "email" in data["members"][0]


def test_list_all_users(admin_client):
    """GET /api/admin/users lists users across all clubs."""
    admin_client.post(
        "/api/admin/clubs/club_au1/onboard",
        json={"club_id": "club_au1", "name": "Club AU1", "slug": "au1", "season": "2026/27"},
    )
    admin_client.post(
        "/api/admin/clubs/club_au2/onboard",
        json={"club_id": "club_au2", "name": "Club AU2", "slug": "au2", "season": "2026/27"},
    )
    r = admin_client.get("/api/admin/users")
    assert r.status_code == 200
    data = r.json()
    # Two clubs × 9 default staff = 18 users
    assert data["total"] == 18
    # Each user should have the email field
    assert "email" in data["users"][0]


def test_list_all_users_by_email(admin_client):
    """GET /api/admin/users?email=... filters by email across all clubs."""
    admin_client.post(
        "/api/admin/clubs/club_email/onboard",
        json={
            "club_id": "club_email",
            "name": "Club Email",
            "slug": "email",
            "season": "2026/27",
            "staff": [
                {
                    "username": "jjdelcampo",
                    "display_name": "Juanjo",
                    "roles": ["administrator"],
                    "password": "test123",
                }
            ],
        },
    )
    # Search by a non-existent email
    r = admin_client.get("/api/admin/users", params={"email": "nobody@basketiq.io"})
    assert r.status_code == 200
    assert r.json()["total"] == 0


# ─── Roles ───────────────────────────────────────────────────────────────────


def test_assign_and_remove_role(admin_client):
    admin_client.post(
        "/api/admin/clubs/club_roles/onboard",
        json={"club_id": "club_roles", "name": "Club Roles", "slug": "roles", "season": "2026/27"},
    )
    # Assign
    r = admin_client.post(
        "/api/admin/clubs/club_roles/roles",
        json={"user_id": "admin_club_roles", "role": "sports_director"},
    )
    assert r.status_code == 200
    aid = r.json()["assignment_id"]
    assert "sports_director" in aid

    # List
    r = admin_client.get("/api/admin/clubs/club_roles/roles")
    assert r.status_code == 200
    assert r.json()["total"] == 10  # 9 default + 1 new

    # Remove
    r = admin_client.delete(f"/api/admin/clubs/club_roles/roles/{aid}")
    assert r.status_code == 200
    r = admin_client.get("/api/admin/clubs/club_roles/roles")
    assert r.json()["total"] == 9


def test_assign_role_rejects_unknown(admin_client):
    admin_client.post(
        "/api/admin/clubs/club_unk/onboard",
        json={"club_id": "club_unk", "name": "Club UNK", "slug": "unk", "season": "2026/27"},
    )
    r = admin_client.post(
        "/api/admin/clubs/club_unk/roles",
        json={"user_id": "admin_club_unk", "role": "superadmin"},
    )
    assert r.status_code == 400


# ─── Season ──────────────────────────────────────────────────────────────────


def test_season_get_set(admin_client):
    r = admin_client.get("/api/admin/season")
    assert r.status_code == 200
    r = admin_client.put("/api/admin/season", json={"season": "2027/28"})
    assert r.status_code == 200
    assert r.json()["season"] == "2027/28"
    r = admin_client.get("/api/admin/season")
    assert r.json()["season"] == "2027/28"


# ─── Clubs ───────────────────────────────────────────────────────────────────


def test_create_and_get_club(admin_client):
    r = admin_client.post("/api/admin/clubs", json={"id": "club_new", "name": "Club New"})
    assert r.status_code == 200
    r = admin_client.get("/api/admin/clubs/club_new")
    assert r.status_code == 200
    assert r.json()["name"] == "Club New"


def test_list_clubs(admin_client):
    admin_client.post("/api/admin/clubs", json={"id": "club_a", "name": "Club A"})
    admin_client.post("/api/admin/clubs", json={"id": "club_b", "name": "Club B"})
    r = admin_client.get("/api/admin/clubs")
    assert r.status_code == 200
    assert r.json()["total"] >= 2


def test_update_club_preserves_deactivated_status(admin_client):
    """W2.0b regression: renaming a deactivated club must not reactivate it
    or erase audit provenance (created_by, deactivated_at, deactivated_by).

    update_club now uses merge_club_fields (biq-core 0.12.0), which writes
    only the fields the caller sent. status defaults to "active" on the Club
    model, so a full-overwrite upsert would silently reactivate a deactivated
    club on a back-office rename.
    """
    from biq_core.org import Club

    from biq_onboard_server import org

    registry = org.get_registry()

    # Create a club, then deactivate it directly via the registry.
    registry.upsert_club(
        Club(
            id="club_deact",
            name="Old Name",
            status="active",
            created_by="founder@test.es",
        )
    )
    registry.upsert_club(
        Club(
            id="club_deact",
            name="Old Name",
            status="deactivated",
            created_by="founder@test.es",
            deactivated_at="2026-08-01T00:00:00Z",
            deactivated_by="admin@basketiq.io",
        )
    )

    # Rename via the API — this used to drop status/created_by/deactivated_*.
    r = admin_client.put("/api/admin/clubs/club_deact", json={"name": "New Name"})
    assert r.status_code == 200
    assert r.json()["club"]["name"] == "New Name"

    # Verify the club is still deactivated and audit fields survived.
    club = registry.get_club("club_deact")
    assert club is not None
    assert club.name == "New Name"
    assert club.status == "deactivated", (
        f"rename reactivated a deactivated club: status={club.status!r}"
    )
    assert club.created_by == "founder@test.es", (
        f"created_by was erased by rename: {club.created_by!r}"
    )
    assert club.deactivated_at == "2026-08-01T00:00:00Z"
    assert club.deactivated_by == "admin@basketiq.io"


def test_update_club_website_preserves_status_and_created_by(admin_client):
    """W2.0b+ regression: writing website via merge_club_fields must not
    disturb status or created_by.

    merge_club_fields (biq-core 0.12.0) writes only the fields the caller
    sent. This test proves the helper does not clobber unrelated fields when
    a future admin path writes website alone.
    """
    from biq_core.org import Club

    from biq_onboard_server import org

    registry = org.get_registry()
    registry.upsert_club(
        Club(
            id="club_web",
            name="Web Club",
            status="deactivated",
            created_by="founder@test.es",
        )
    )

    # Write website directly via merge_club_fields — the path a future admin
    # endpoint or W2.1a-ii would use.
    registry.merge_club_fields("club_web", {"website": "https://example.es/"})

    club = registry.get_club("club_web")
    assert club is not None
    assert club.website == "https://example.es/"
    assert club.status == "deactivated", (
        f"website write reactivated a deactivated club: status={club.status!r}"
    )
    assert club.created_by == "founder@test.es", (
        f"website write erased created_by: {club.created_by!r}"
    )


# ─── Users ───────────────────────────────────────────────────────────────────


def test_create_and_list_users(admin_client):
    admin_client.post("/api/admin/clubs", json={"id": "club_u", "name": "Club U"})
    admin_client.post(
        "/api/admin/clubs/club_u/users",
        json={"id": "testuser_club_u", "club_id": "club_u", "display_name": "Test User", "password": "secret"},
    )
    r = admin_client.get("/api/admin/clubs/club_u/users")
    assert r.status_code == 200
    assert r.json()["total"] == 1


def test_create_user_assigns_methodology_role(admin_client):
    """create_user must also create a RoleAssignment so the user gets capabilities."""
    admin_client.post("/api/admin/clubs", json={"id": "club_cr", "name": "Club CR"})
    r = admin_client.post(
        "/api/admin/clubs/club_cr/users",
        json={
            "id": "director_cr",
            "club_id": "club_cr",
            "display_name": "Director",
            "role": "sports_director",
            "email": "director@example.com",
            "password": "secret",
        },
    )
    assert r.status_code == 200
    assert r.json()["role_assigned"] == "sports_director"

    # Verify the RoleAssignment exists via the staff endpoint
    r = admin_client.get("/api/admin/clubs/club_cr/staff")
    assert r.status_code == 200
    director = next(m for m in r.json()["members"] if m["user_id"] == "director_cr")
    assert "sports_director" in director["methodology_roles"]
    assert "methodology.create" in director["capabilities"]


def test_update_user_role_syncs_assignment(admin_client):
    """update_user must remove the old RoleAssignment and create a new one."""
    admin_client.post("/api/admin/clubs", json={"id": "club_ur", "name": "Club UR"})
    admin_client.post(
        "/api/admin/clubs/club_ur/users",
        json={"id": "user_ur", "club_id": "club_ur", "role": "coach", "password": "secret"},
    )
    # Verify coach role assigned
    r = admin_client.get("/api/admin/clubs/club_ur/staff")
    user = next(m for m in r.json()["members"] if m["user_id"] == "user_ur")
    assert "coach" in user["methodology_roles"]

    # Update to sports_director
    r = admin_client.put(
        "/api/admin/clubs/club_ur/users/user_ur",
        json={"role": "sports_director"},
    )
    assert r.status_code == 200

    # Verify role was synced
    r = admin_client.get("/api/admin/clubs/club_ur/staff")
    user = next(m for m in r.json()["members"] if m["user_id"] == "user_ur")
    assert "sports_director" in user["methodology_roles"]
    assert "coach" not in user["methodology_roles"]
    assert "methodology.create" in user["capabilities"]


def test_reset_password(admin_client):
    admin_client.post("/api/admin/clubs", json={"id": "club_pw", "name": "Club PW"})
    admin_client.post(
        "/api/admin/clubs/club_pw/users",
        json={"id": "user_pw", "club_id": "club_pw", "password": "old_pw"},
    )
    r = admin_client.post("/api/admin/users/user_pw/reset-password", json={"password": "new_pw"})
    assert r.status_code == 200


# ─── Teams ───────────────────────────────────────────────────────────────────


def test_create_and_list_teams(admin_client):
    admin_client.post("/api/admin/clubs", json={"id": "club_t", "name": "Club T"})
    admin_client.post(
        "/api/admin/clubs/club_t/teams",
        json={"id": "team_t_1", "club_id": "club_t", "name": "Team 1"},
    )
    r = admin_client.get("/api/admin/clubs/club_t/teams")
    assert r.status_code == 200
    assert r.json()["total"] == 1


# ─── Team competitive_level (Item 28 Phase 1) ────────────────────────────────


def test_create_team_with_competitive_level_roundtrips(admin_client):
    admin_client.post("/api/admin/clubs", json={"id": "club_lvl", "name": "Club Lvl"})
    admin_client.post(
        "/api/admin/clubs/club_lvl/teams",
        json={
            "id": "team_lvl_1",
            "club_id": "club_lvl",
            "name": "Senior A",
            "competitive_level": "Liga EBA",
        },
    )
    r = admin_client.get("/api/admin/clubs/club_lvl/teams")
    assert r.status_code == 200
    team = r.json()["teams"][0]
    assert team["competitive_level"] == "Liga EBA"


def test_team_competitive_level_defaults_empty(admin_client):
    admin_client.post("/api/admin/clubs", json={"id": "club_le", "name": "Club LE"})
    admin_client.post(
        "/api/admin/clubs/club_le/teams",
        json={"id": "team_le_1", "club_id": "club_le", "name": "Senior B"},
    )
    r = admin_client.get("/api/admin/clubs/club_le/teams")
    assert r.json()["teams"][0]["competitive_level"] == ""


def test_update_team_competitive_level(admin_client):
    admin_client.post("/api/admin/clubs", json={"id": "club_lu", "name": "Club LU"})
    admin_client.post(
        "/api/admin/clubs/club_lu/teams",
        json={"id": "team_lu_1", "club_id": "club_lu", "name": "Cadete A"},
    )
    r = admin_client.put(
        "/api/admin/clubs/club_lu/teams/team_lu_1",
        json={"competitive_level": "Primera Nacional"},
    )
    assert r.status_code == 200
    assert r.json()["team"]["competitive_level"] == "Primera Nacional"


def test_update_team_omitting_level_preserves_stored_value(admin_client):
    """Partial update: a PUT that doesn't resend competitive_level must not
    clear it (is-not-None merge in update_team)."""
    admin_client.post("/api/admin/clubs", json={"id": "club_lp", "name": "Club LP"})
    admin_client.post(
        "/api/admin/clubs/club_lp/teams",
        json={
            "id": "team_lp_1",
            "club_id": "club_lp",
            "name": "Junior A",
            "competitive_level": "Liga EBA",
        },
    )
    # Rename only — no competitive_level in the body.
    r = admin_client.put(
        "/api/admin/clubs/club_lp/teams/team_lp_1",
        json={"name": "Junior A Renamed"},
    )
    assert r.status_code == 200
    assert r.json()["team"]["competitive_level"] == "Liga EBA"


def test_update_team_competitive_level_can_be_cleared(admin_client):
    """Explicit empty string clears — falsy-but-intended writes must work."""
    admin_client.post("/api/admin/clubs", json={"id": "club_lc", "name": "Club LC"})
    admin_client.post(
        "/api/admin/clubs/club_lc/teams",
        json={
            "id": "team_lc_1",
            "club_id": "club_lc",
            "name": "Junior B",
            "competitive_level": "Liga EBA",
        },
    )
    r = admin_client.put(
        "/api/admin/clubs/club_lc/teams/team_lc_1",
        json={"competitive_level": ""},
    )
    assert r.status_code == 200
    assert r.json()["team"]["competitive_level"] == ""


# ─── Team archive / unarchive (business remediation B) ───────────────────────


def _make_team(admin_client, club_id="club_arch", team_id="team_arch_1"):
    admin_client.post("/api/admin/clubs", json={"id": club_id, "name": "Club Arch"})
    admin_client.post(
        f"/api/admin/clubs/{club_id}/teams",
        json={"id": team_id, "club_id": club_id, "name": "Arch Team"},
    )
    return club_id, team_id


def test_archive_team_sets_archived_true(admin_client):
    from biq_onboard_server import org

    club_id, team_id = _make_team(admin_client)
    r = admin_client.put(f"/api/admin/clubs/{club_id}/teams/{team_id}/archive")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "team_id": team_id, "archived": True}

    team = org.get_registry().get_team(club_id, team_id)
    assert team is not None
    assert team.archived is True


def test_unarchive_team_sets_archived_false(admin_client):
    from biq_onboard_server import org

    club_id, team_id = _make_team(admin_client)
    # Archive first, then unarchive.
    admin_client.put(f"/api/admin/clubs/{club_id}/teams/{team_id}/archive")
    r = admin_client.put(f"/api/admin/clubs/{club_id}/teams/{team_id}/unarchive")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "team_id": team_id, "archived": False}

    team = org.get_registry().get_team(club_id, team_id)
    assert team is not None
    assert team.archived is False


def test_archive_unarchive_preserves_competitive_level(admin_client):
    """Archive→unarchive rebuilds Team(...) explicitly — the stored
    competitive_level must survive the round-trip."""
    from biq_onboard_server import org

    club_id, team_id = _make_team(admin_client, club_id="club_cl", team_id="team_cl_1")
    admin_client.put(
        f"/api/admin/clubs/{club_id}/teams/{team_id}",
        json={"competitive_level": "Liga EBA"},
    )

    r = admin_client.put(f"/api/admin/clubs/{club_id}/teams/{team_id}/archive")
    assert r.status_code == 200
    team = org.get_registry().get_team(club_id, team_id)
    assert team.competitive_level == "Liga EBA"

    r = admin_client.put(f"/api/admin/clubs/{club_id}/teams/{team_id}/unarchive")
    assert r.status_code == 200
    team = org.get_registry().get_team(club_id, team_id)
    assert team.competitive_level == "Liga EBA"


def test_archive_nonexistent_team_404(admin_client):
    admin_client.post("/api/admin/clubs", json={"id": "club_404", "name": "Club 404"})
    r = admin_client.put("/api/admin/clubs/club_404/teams/no_such_team/archive")
    assert r.status_code == 404


def test_archive_team_requires_admin(client, admin_client):
    """A non-admin authenticated user gets 403."""
    club_id, team_id = _make_team(admin_client, club_id="club_403", team_id="team_403_1")
    # Create a plain (no roles) user that can log in but is not an admin.
    admin_client.post(
        f"/api/admin/clubs/{club_id}/users",
        json={"id": "plain_" + club_id, "club_id": club_id, "password": "secret123"},
    )
    client.post("/api/auth/login", json={"username": "plain_" + club_id, "password": "secret123"})
    r = client.put(f"/api/admin/clubs/{club_id}/teams/{team_id}/archive")
    assert r.status_code == 403


# ─── F12: Team-catalog authorization (admin + sports_director, not coach) ──


@pytest.fixture
def f12_client(monkeypatch):
    """Client with memory stores and a shared role registry for F12 tests."""
    monkeypatch.setenv("BIQ_ORG_STORE", "memory")
    monkeypatch.setenv("BIQ_ROLES_STORE", "memory")
    from biq_onboard_server import org
    org.reset_for_tests()
    app = create_app()
    c = TestClient(app)
    # Login as break-glass admin to seed data
    c.post("/api/auth/login", json={"username": "admin", "password": "T3st1ng!"})
    return c


def _f12_seed_club_and_users(client, club_id="club_f12"):
    """Seed a club with admin, sports_director, and coach users + role assignments."""
    from biq_onboard_server import org
    from biq_core.org import Club, User
    from biq_core.roles import RoleAssignment

    reg = org.get_registry()
    roles_reg = org.get_roles()
    scope = f"club:{club_id}"

    reg.upsert_club(Club(id=club_id, name="Club F12"))
    # Seed a team so list/update/archive have something to operate on
    from biq_core.org import Team
    reg.upsert_team(Team(id=f"team_{club_id}_senior_m", club_id=club_id, name="Senior M", category="senior", gender="M"))

    for uid, role in [("u_admin", "administrator"), ("u_sd", "sports_director"), ("u_coach", "coach")]:
        reg.upsert_user(User(
            id=uid, club_id=club_id, email=f"{uid}@basketiq.io",
            display_name=uid, role=role, status="active",
            password_hash=__import__("biq_core.org.passwords", fromlist=["hash_password"]).hash_password("secret123"),
        ))
        roles_reg.put_assignment(RoleAssignment(
            id=f"{uid}__{role}__{scope}", user_id=uid, role=role, scope=scope,
        ))


def test_f12_administrator_can_list_and_archive_teams(f12_client):
    """F12: administrator (club.admin) can manage team catalog."""
    _f12_seed_club_and_users(f12_client)
    f12_client.post("/api/auth/login", json={"username": "u_admin", "password": "secret123"})

    r = f12_client.get("/api/admin/clubs/club_f12/teams")
    assert r.status_code == 200
    assert r.json()["total"] >= 1

    r = f12_client.put("/api/admin/clubs/club_f12/teams/team_club_f12_senior_m/archive")
    assert r.status_code == 200
    assert r.json()["archived"] is True


def test_f12_sports_director_can_list_and_archive_teams(f12_client):
    """F12: Sports Director (club.teams.manage) can manage team catalog."""
    _f12_seed_club_and_users(f12_client)
    f12_client.post("/api/auth/login", json={"username": "u_sd", "password": "secret123"})

    r = f12_client.get("/api/admin/clubs/club_f12/teams")
    assert r.status_code == 200

    r = f12_client.put("/api/admin/clubs/club_f12/teams/team_club_f12_senior_m/archive")
    assert r.status_code == 200
    assert r.json()["archived"] is True


def test_f12_coach_denied_team_catalog_management(f12_client):
    """F12: coach (no club.admin, no club.teams.manage) gets 403."""
    _f12_seed_club_and_users(f12_client)
    f12_client.post("/api/auth/login", json={"username": "u_coach", "password": "secret123"})

    r = f12_client.get("/api/admin/clubs/club_f12/teams")
    assert r.status_code == 403

    r = f12_client.put("/api/admin/clubs/club_f12/teams/team_club_f12_senior_m/archive")
    assert r.status_code == 403


def test_f12_s2s_admin_can_list_teams_via_bearer_headers(f12_client, monkeypatch):
    """F12: S2S mode — admin identity via bearer + headers succeeds.

    This is the exact path the BFF proxy uses: biq-app forwards the request
    with Authorization: Bearer <secret> + X-BIQ-Acting-User-Id headers,
    not a session cookie. Without S2S-aware authorization, this 401s.
    """
    monkeypatch.setenv("BIQ_ONBOARD_S2S_SECRET", "test-s2s-secret")
    _f12_seed_club_and_users(f12_client)

    r = f12_client.get(
        "/api/admin/clubs/club_f12/teams",
        headers={
            "Authorization": "Bearer test-s2s-secret",
            "X-BIQ-Acting-User-Id": "u_admin",
            "X-BIQ-Acting-Email": "u_admin@basketiq.io",
        },
    )
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
    assert r.json()["total"] >= 1


def test_f12_s2s_sports_director_can_list_teams_via_bearer_headers(f12_client, monkeypatch):
    """F12: S2S mode — Sports Director identity via bearer + headers succeeds."""
    monkeypatch.setenv("BIQ_ONBOARD_S2S_SECRET", "test-s2s-secret")
    _f12_seed_club_and_users(f12_client)

    r = f12_client.get(
        "/api/admin/clubs/club_f12/teams",
        headers={
            "Authorization": "Bearer test-s2s-secret",
            "X-BIQ-Acting-User-Id": "u_sd",
            "X-BIQ-Acting-Email": "u_sd@basketiq.io",
        },
    )
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"


def test_f12_s2s_bad_token_returns_401(f12_client, monkeypatch):
    """F12: S2S mode — wrong token returns 401 (fail-closed)."""
    monkeypatch.setenv("BIQ_ONBOARD_S2S_SECRET", "test-s2s-secret")
    _f12_seed_club_and_users(f12_client)

    r = f12_client.get(
        "/api/admin/clubs/club_f12/teams",
        headers={
            "Authorization": "Bearer wrong-token",
            "X-BIQ-Acting-User-Id": "u_admin",
            "X-BIQ-Acting-Email": "u_admin@basketiq.io",
        },
    )
    assert r.status_code == 401


# ─── Team seeding status + reseed ──────────────────────────────────────────────


def test_team_seeding_job_done_after_onboard(admin_client):
    admin_client.post(
        "/api/admin/clubs/club_seed/onboard",
        json={"club_id": "club_seed", "name": "Club Seed", "slug": "seed", "season": "2026/27"},
    )
    r = admin_client.get("/api/admin/clubs/club_seed/team-seeding")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    job = data["team_seeding_job"]
    assert job["status"] == "done"
    assert job["teams_expected"] == 30
    assert job["teams_written"] == 30
    assert job["catalog_slug"] == "seed"


def test_team_seeding_null_before_any_seed(admin_client):
    admin_client.post("/api/admin/clubs", json={"id": "club_noseed", "name": "No Seed"})
    r = admin_client.get("/api/admin/clubs/club_noseed/team-seeding")
    assert r.status_code == 200
    assert r.json()["team_seeding_job"] is None


def test_team_seeding_404_missing_club(admin_client):
    assert admin_client.get("/api/admin/clubs/ghost/team-seeding").status_code == 404


def test_team_seeding_requires_auth(client):
    assert client.get("/api/admin/clubs/x/team-seeding").status_code == 401


def test_reseed_recovers_zero_team_club(admin_client):
    """The reported incident shape: a club at zero teams reseeds back to the
    full catalog in place — under the ORIGINAL slug namespace, recovered from
    the recorded job even with no teams left to parse."""
    admin_client.post(
        "/api/admin/clubs/club_zero/onboard",
        json={"club_id": "club_zero", "name": "Club Zero", "slug": "zero", "season": "2026/27"},
    )
    from biq_onboard_server import org

    reg = org.get_registry()
    # Drive the club to the zero-team failure state (memory backend).
    reg._teams["club_zero"] = {}
    assert reg.list_teams("club_zero") == []

    r = admin_client.post("/api/admin/clubs/club_zero/teams/reseed")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["teams_written"] == 30
    assert data["team_seeding_job"]["status"] == "done"
    teams = reg.list_teams("club_zero")
    assert len(teams) == 30
    assert all(t.id.startswith("team_zero_") for t in teams)


def test_reseed_recovers_zero_team_pretracking_club(admin_client):
    """A club seeded before job tracking (no team_seeding_job) with zero teams
    falls back to the club_id namespace — the create_my_club convention."""
    admin_client.post("/api/admin/clubs", json={"id": "club_pre", "name": "Club Pre"})
    r = admin_client.post("/api/admin/clubs/club_pre/teams/reseed")
    assert r.status_code == 200
    data = r.json()
    assert data["teams_written"] == 30
    from biq_onboard_server import org

    teams = org.get_registry().list_teams("club_pre")
    assert len(teams) == 30
    assert all(t.id.startswith("team_club_pre_") for t in teams)


def test_reseed_twice_is_idempotent(admin_client):
    """Reseeding a fully-seeded club relabels in place — no duplicates."""
    admin_client.post(
        "/api/admin/clubs/club_r2/onboard",
        json={"club_id": "club_r2", "name": "Club R2", "slug": "r2", "season": "2026/27"},
    )
    from biq_onboard_server import org

    for _ in range(2):
        r = admin_client.post("/api/admin/clubs/club_r2/teams/reseed")
        assert r.status_code == 200
        assert r.json()["teams_written"] == 30
    assert len(org.get_registry().list_teams("club_r2")) == 30


def test_reseed_failure_persists_failed_job(admin_client, monkeypatch):
    admin_client.post(
        "/api/admin/clubs/club_rf/onboard",
        json={"club_id": "club_rf", "name": "Club RF", "slug": "rf", "season": "2026/27"},
    )
    from biq_onboard_server import org

    reg = org.get_registry()

    def _boom(*_a, **_k):
        raise RuntimeError("simulated write failure")

    monkeypatch.setattr(reg, "bulk_upsert_teams", _boom)

    r = admin_client.post("/api/admin/clubs/club_rf/teams/reseed")
    assert r.status_code == 500
    job = reg.get_club("club_rf").team_seeding_job
    assert job["status"] == "failed"
    assert "simulated write failure" in job["reason"]


def test_reseed_404_missing_club(admin_client):
    assert admin_client.post("/api/admin/clubs/ghost/teams/reseed").status_code == 404


def test_reseed_requires_auth(client):
    assert client.post("/api/admin/clubs/x/teams/reseed").status_code == 401
