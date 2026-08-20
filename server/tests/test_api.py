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
