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
