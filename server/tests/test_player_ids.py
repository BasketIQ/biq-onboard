"""Scouting roster identity — stable player_id (biq-core 0.25.0, PD-2).

Covers:
- lazy ``pl_<16 hex>`` assignment on roster writes and serialization;
- preservation across update/archive/unarchive;
- the same-club link rule vs. foreign/unknown rejection;
- duplicate-id rejection;
- the bulk backfill endpoint (dry-run first, apply, idempotent re-run);
- category/gender validation and partial-write preservation.
"""

import re

import pytest
from fastapi.testclient import TestClient

from biq_onboard_server.app import create_app

PLAYER_ID_RE = re.compile(r"^pl_[0-9a-f]{16}$")


@pytest.fixture
def client():
    return TestClient(create_app())


@pytest.fixture
def admin_client(client):
    client.post("/api/auth/login", json={"username": "admin", "password": "T3st1ng!"})
    return client


def _club(admin_client, club_id):
    admin_client.post("/api/admin/clubs", json={"id": club_id, "name": "Club"})


def _team(admin_client, club_id, team_id, **extra):
    admin_client.post(
        f"/api/admin/clubs/{club_id}/teams",
        json={"id": team_id, "club_id": club_id, "name": "Team", **extra},
    )


def _get_team(admin_client, club_id, team_id):
    teams = admin_client.get(f"/api/admin/clubs/{club_id}/teams").json()["teams"]
    return next(t for t in teams if t["id"] == team_id)


def _legacy_players(club_id, team_id, rows):
    """Seed a roster the pre-0.25 way: TeamPlayer rows without player_id."""
    from biq_core.org import Team, TeamPlayer

    from biq_onboard_server import org

    org.get_registry().upsert_team(
        Team(
            id=team_id,
            club_id=club_id,
            name="Legacy Team",
            players=[TeamPlayer(name=n, number=num) for n, num in rows],
        )
    )


# ─── Assignment + serialization ─────────────────────────────────────────────


def test_player_ids_assigned_on_roster_write(admin_client):
    _club(admin_client, "club_pid")
    _team(admin_client, "club_pid", "team_pid_1")
    r = admin_client.put(
        "/api/admin/clubs/club_pid/teams/team_pid_1",
        json={"players": [{"name": "Ana García", "number": 7}, {"name": "Luis Pérez"}]},
    )
    assert r.status_code == 200
    players = r.json()["team"]["players"]
    assert [p["name"] for p in players] == ["Ana García", "Luis Pérez"]
    for p in players:
        assert PLAYER_ID_RE.match(p["player_id"]), p
    listed = _get_team(admin_client, "club_pid", "team_pid_1")
    assert [p["player_id"] for p in listed["players"]] == [
        p["player_id"] for p in players
    ]


def test_update_team_preserves_existing_player_ids(admin_client):
    _club(admin_client, "club_pres")
    _team(admin_client, "club_pres", "team_pres_1")
    first = admin_client.put(
        "/api/admin/clubs/club_pres/teams/team_pres_1",
        json={"players": [{"name": "Ana García", "number": 7}, {"name": "Luis Pérez"}]},
    ).json()["team"]["players"]
    r = admin_client.put(
        "/api/admin/clubs/club_pres/teams/team_pres_1",
        json={
            "players": [
                {"name": "Ana García", "number": 7, "player_id": first[0]["player_id"]},
                {"name": "Luis Pérez", "number": 9, "player_id": first[1]["player_id"]},
            ]
        },
    )
    assert r.status_code == 200
    assert [p["player_id"] for p in r.json()["team"]["players"]] == [
        first[0]["player_id"],
        first[1]["player_id"],
    ]


def test_new_row_gets_id_while_existing_keep_theirs(admin_client):
    _club(admin_client, "club_mix")
    _team(admin_client, "club_mix", "team_mix_1")
    first = admin_client.put(
        "/api/admin/clubs/club_mix/teams/team_mix_1",
        json={"players": [{"name": "Ana García", "number": 7}]},
    ).json()["team"]["players"]
    r = admin_client.put(
        "/api/admin/clubs/club_mix/teams/team_mix_1",
        json={
            "players": [
                {"name": "Ana García", "number": 7, "player_id": first[0]["player_id"]},
                {"name": "Nueva Jugadora", "number": 3},
            ]
        },
    )
    assert r.status_code == 200
    players = r.json()["team"]["players"]
    assert players[0]["player_id"] == first[0]["player_id"]
    assert PLAYER_ID_RE.match(players[1]["player_id"])
    assert players[1]["player_id"] != first[0]["player_id"]


def test_archive_and_unarchive_preserve_player_ids(admin_client):
    _club(admin_client, "club_arch_id")
    _team(admin_client, "club_arch_id", "team_arch_id_1")
    players = admin_client.put(
        "/api/admin/clubs/club_arch_id/teams/team_arch_id_1",
        json={"players": [{"name": "Ana García", "number": 7}]},
    ).json()["team"]["players"]

    admin_client.put("/api/admin/clubs/club_arch_id/teams/team_arch_id_1/archive")
    archived = _get_team(admin_client, "club_arch_id", "team_arch_id_1")
    assert [p["player_id"] for p in archived["players"]] == [players[0]["player_id"]]

    admin_client.put("/api/admin/clubs/club_arch_id/teams/team_arch_id_1/unarchive")
    back = _get_team(admin_client, "club_arch_id", "team_arch_id_1")
    assert [p["player_id"] for p in back["players"]] == [players[0]["player_id"]]


def test_legacy_rows_get_ids_lazily_on_next_roster_write(admin_client):
    """Rows written before 0.25.0 have no id. A metadata-only write does
    not touch them; the next roster write assigns ids."""
    _club(admin_client, "club_lazy")
    _legacy_players("club_lazy", "team_lazy_1", [("Ana García", 7)])

    r = admin_client.put(
        "/api/admin/clubs/club_lazy/teams/team_lazy_1",
        json={"name": "Renamed Only"},
    )
    assert r.status_code == 200
    assert r.json()["team"]["players"] == [
        {"name": "Ana García", "number": 7, "player_id": None}
    ]

    r = admin_client.put(
        "/api/admin/clubs/club_lazy/teams/team_lazy_1",
        json={"players": [{"name": "Ana García", "number": 7}]},
    )
    assert r.status_code == 200
    assert PLAYER_ID_RE.match(r.json()["team"]["players"][0]["player_id"])


# ─── Same-club link vs. foreign/unknown/duplicate rejection ─────────────────


def test_same_club_player_id_link_accepted(admin_client):
    """PD-2: an id already in another roster of the same club is a link."""
    _club(admin_client, "club_link")
    _team(admin_client, "club_link", "team_link_1")
    _team(admin_client, "club_link", "team_link_2")
    pid = admin_client.put(
        "/api/admin/clubs/club_link/teams/team_link_1",
        json={"players": [{"name": "Ana García", "number": 7}]},
    ).json()["team"]["players"][0]["player_id"]

    r = admin_client.put(
        "/api/admin/clubs/club_link/teams/team_link_2",
        json={"players": [{"name": "Ana García", "number": 7, "player_id": pid}]},
    )
    assert r.status_code == 200
    assert r.json()["team"]["players"][0]["player_id"] == pid


def test_foreign_club_player_id_rejected(admin_client):
    _club(admin_client, "club_a")
    _club(admin_client, "club_b")
    _team(admin_client, "club_a", "team_a_1")
    _team(admin_client, "club_b", "team_b_1")
    pid = admin_client.put(
        "/api/admin/clubs/club_a/teams/team_a_1",
        json={"players": [{"name": "Ana García"}]},
    ).json()["team"]["players"][0]["player_id"]

    r = admin_client.put(
        "/api/admin/clubs/club_b/teams/team_b_1",
        json={"players": [{"name": "Otra", "player_id": pid}]},
    )
    assert r.status_code == 422
    assert r.json()["detail"] == "unknown_player_id"


def test_unknown_player_id_rejected(admin_client):
    _club(admin_client, "club_unk")
    _team(admin_client, "club_unk", "team_unk_1")
    r = admin_client.put(
        "/api/admin/clubs/club_unk/teams/team_unk_1",
        json={"players": [{"name": "Inventado", "player_id": "pl_0123456789abcdef"}]},
    )
    assert r.status_code == 422
    assert r.json()["detail"] == "unknown_player_id"


def test_create_team_rejects_unknown_player_id(admin_client):
    _club(admin_client, "club_cunk")
    r = admin_client.post(
        "/api/admin/clubs/club_cunk/teams",
        json={
            "id": "team_cunk_1",
            "club_id": "club_cunk",
            "name": "T",
            "players": [{"name": "X", "player_id": "pl_0123456789abcdef"}],
        },
    )
    assert r.status_code == 422
    assert r.json()["detail"] == "unknown_player_id"


def test_duplicate_player_id_in_roster_rejected(admin_client):
    _club(admin_client, "club_dup")
    _team(admin_client, "club_dup", "team_dup_1")
    pid = admin_client.put(
        "/api/admin/clubs/club_dup/teams/team_dup_1",
        json={"players": [{"name": "Ana García"}]},
    ).json()["team"]["players"][0]["player_id"]

    r = admin_client.put(
        "/api/admin/clubs/club_dup/teams/team_dup_1",
        json={
            "players": [
                {"name": "Ana García", "player_id": pid},
                {"name": "Ana Twin", "player_id": pid},
            ]
        },
    )
    assert r.status_code == 422
    assert r.json()["detail"] == "duplicate_player_id"


def test_malformed_player_id_rejected_by_schema(admin_client):
    _club(admin_client, "club_fmt")
    _team(admin_client, "club_fmt", "team_fmt_1")
    for bad in ("pl_ABCDEF0123456789", "pl_1234", "abc", "pl_" + "0" * 17):
        r = admin_client.put(
            "/api/admin/clubs/club_fmt/teams/team_fmt_1",
            json={"players": [{"name": "X", "player_id": bad}]},
        )
        assert r.status_code == 422, bad


# ─── Bulk backfill ───────────────────────────────────────────────────────────


def test_migrate_player_ids_dry_run_then_apply_then_idempotent(admin_client):
    _club(admin_client, "club_mig")
    _team(admin_client, "club_mig", "team_mig_1")  # identified via API
    admin_client.put(
        "/api/admin/clubs/club_mig/teams/team_mig_1",
        json={"players": [{"name": "Identificada"}]},
    )
    _legacy_players("club_mig", "team_mig_2", [("Leg A", 1), ("Leg B", 2)])

    # Default (no param) is dry_run=true — reports but writes nothing.
    r = admin_client.post("/api/admin/clubs/club_mig/teams/migrate-player-ids")
    assert r.status_code == 200
    data = r.json()
    assert data["dry_run"] is True
    assert data["teams_scanned"] == 2
    assert data["teams_changed"] == 1
    assert data["rows_assigned"] == 2
    assert data["rows_already_identified"] == 1
    team2 = _get_team(admin_client, "club_mig", "team_mig_2")
    assert all(p["player_id"] is None for p in team2["players"])

    r = admin_client.post(
        "/api/admin/clubs/club_mig/teams/migrate-player-ids?dry_run=false"
    )
    assert r.status_code == 200
    assert r.json()["rows_assigned"] == 2
    team2 = _get_team(admin_client, "club_mig", "team_mig_2")
    assert all(PLAYER_ID_RE.match(p["player_id"]) for p in team2["players"])

    r = admin_client.post(
        "/api/admin/clubs/club_mig/teams/migrate-player-ids?dry_run=false"
    )
    assert r.status_code == 200
    data = r.json()
    assert data["teams_changed"] == 0
    assert data["rows_assigned"] == 0
    assert data["rows_already_identified"] == 3


def test_migrate_player_ids_preserves_other_team_fields(admin_client):
    from biq_core.org import Team, TeamPlayer

    from biq_onboard_server import org

    _club(admin_client, "club_migp")
    org.get_registry().upsert_team(
        Team(
            id="team_migp_1",
            club_id="club_migp",
            name="Legacy",
            label="2011",
            timezone="Atlantic/Canary",
            staff_user_ids=["u_1", "u_2"],
            competitive_level="Liga EBA",
            players=[TeamPlayer(name="Leg", number=8)],
        )
    )
    r = admin_client.post(
        "/api/admin/clubs/club_migp/teams/migrate-player-ids?dry_run=false"
    )
    assert r.status_code == 200
    team = _get_team(admin_client, "club_migp", "team_migp_1")
    assert team["label"] == "2011"
    assert team["timezone"] == "Atlantic/Canary"
    assert team["staff_user_ids"] == ["u_1", "u_2"]
    assert team["competitive_level"] == "Liga EBA"
    assert PLAYER_ID_RE.match(team["players"][0]["player_id"])


def test_migrate_player_ids_requires_admin(client):
    _legacy_players("club_nologin", "team_n_1", [("Leg", 1)])
    r = client.post("/api/admin/clubs/club_nologin/teams/migrate-player-ids")
    assert r.status_code == 401


# ─── Categoría / Género validation (F-CL-3) ──────────────────────────────────


def test_create_and_update_validate_category(admin_client):
    _club(admin_client, "club_cat")
    r = admin_client.post(
        "/api/admin/clubs/club_cat/teams",
        json={"id": "team_cat_1", "club_id": "club_cat", "name": "T",
              "category": "noexiste"},
    )
    assert r.status_code == 422
    admin_client.post(
        "/api/admin/clubs/club_cat/teams",
        json={"id": "team_cat_1", "club_id": "club_cat", "name": "T",
              "category": "cadete"},
    )
    r = admin_client.put(
        "/api/admin/clubs/club_cat/teams/team_cat_1",
        json={"category": "sub-16"},
    )
    assert r.status_code == 422
    r = admin_client.put(
        "/api/admin/clubs/club_cat/teams/team_cat_1",
        json={"category": "infantil"},
    )
    assert r.status_code == 200
    assert r.json()["team"]["category"] == "infantil"


def test_create_and_update_validate_gender(admin_client):
    _club(admin_client, "club_gen")
    r = admin_client.post(
        "/api/admin/clubs/club_gen/teams",
        json={"id": "team_gen_1", "club_id": "club_gen", "name": "T",
              "gender": "Q"},
    )
    assert r.status_code == 422
    admin_client.post(
        "/api/admin/clubs/club_gen/teams",
        json={"id": "team_gen_1", "club_id": "club_gen", "name": "T",
              "gender": "F"},
    )
    for bad in ("Z", "femenino", "f"):
        r = admin_client.put(
            "/api/admin/clubs/club_gen/teams/team_gen_1", json={"gender": bad}
        )
        assert r.status_code == 422, bad
    r = admin_client.put(
        "/api/admin/clubs/club_gen/teams/team_gen_1", json={"gender": "X"}
    )
    assert r.status_code == 200
    assert r.json()["team"]["gender"] == "X"


def test_category_and_gender_clear_with_empty_string(admin_client):
    _club(admin_client, "club_clr")
    _team(admin_client, "club_clr", "team_clr_1", category="junior", gender="M")
    r = admin_client.put(
        "/api/admin/clubs/club_clr/teams/team_clr_1",
        json={"category": "", "gender": ""},
    )
    assert r.status_code == 200
    team = r.json()["team"]
    assert team["category"] is None
    assert team["gender"] is None


def test_omitted_category_gender_preserved_on_update(admin_client):
    _club(admin_client, "club_keep")
    _team(admin_client, "club_keep", "team_keep_1", category="alevin", gender="X")
    r = admin_client.put(
        "/api/admin/clubs/club_keep/teams/team_keep_1",
        json={"name": "Renombrado"},
    )
    assert r.status_code == 200
    team = r.json()["team"]
    assert team["category"] == "alevin"
    assert team["gender"] == "X"


def test_partial_write_preserves_staff_level_timezone_and_label(admin_client):
    """A roster-only PUT must not touch unrelated fields (registry
    exclude_unset merge is the contract, and update_team mirrors it)."""
    _club(admin_client, "club_ppw")
    _team(
        admin_client, "club_ppw", "team_ppw_1",
        label="2011",
        staff_user_ids=["u_dir"],
        competitive_level="Primera Nacional",
    )
    admin_client.put(
        "/api/admin/clubs/club_ppw/teams/team_ppw_1",
        json={"timezone": "Europe/Madrid"},
    )
    r = admin_client.put(
        "/api/admin/clubs/club_ppw/teams/team_ppw_1",
        json={"players": [{"name": "Ana García", "number": 7}]},
    )
    assert r.status_code == 200
    team = _get_team(admin_client, "club_ppw", "team_ppw_1")
    assert team["staff_user_ids"] == ["u_dir"]
    assert team["competitive_level"] == "Primera Nacional"
    assert team["timezone"] == "Europe/Madrid"
    assert team["label"] == "2011"
    assert team["category"] is None  # never invented on unrelated writes


def test_category_change_does_not_touch_label_staff_or_players(admin_client):
    _club(admin_client, "club_catiso")
    _team(
        admin_client, "club_catiso", "team_catiso_1",
        category="cadete", gender="M", label="2011",
        staff_user_ids=["u_dir"], competitive_level="Liga EBA",
    )
    players = admin_client.put(
        "/api/admin/clubs/club_catiso/teams/team_catiso_1",
        json={"players": [{"name": "Ana García", "number": 7}]},
    ).json()["team"]["players"]
    r = admin_client.put(
        "/api/admin/clubs/club_catiso/teams/team_catiso_1",
        json={"category": "junior", "gender": "F"},
    )
    assert r.status_code == 200
    team = _get_team(admin_client, "club_catiso", "team_catiso_1")
    assert team["category"] == "junior"
    assert team["gender"] == "F"
    assert team["label"] == "2011"
    assert team["staff_user_ids"] == ["u_dir"]
    assert team["competitive_level"] == "Liga EBA"
    assert team["players"] == players
