from types import SimpleNamespace

from fastapi import HTTPException

from biq_onboard_server import club_import


def test_reviewed_batch_obeys_team_limit_and_replays(monkeypatch):
    club = SimpleNamespace(id='club', name='Club', status='active')
    teams = {str(i): SimpleNamespace(id=str(i), name=f'Team {i}', category=None, gender=None, archived=False)
             for i in range(4)}
    registry = SimpleNamespace(get_club=lambda _: club, get_team=lambda _, key: teams.get(key),
                               list_teams=lambda _: list(teams.values()))
    records = {}
    store = SimpleNamespace(import_record=lambda key, value=None: records.get(key) if value is None
                            else records.setdefault(key, value))
    def create(issuer, club_id, rows, *, create_only):
        assert create_only
        if len(teams) >= 5:
            raise HTTPException(409, 'club_team_limit_reached')
        row = rows[0]
        teams[row['id']] = SimpleNamespace(category=None, gender=None, archived=False, **row)
    monkeypatch.setattr(club_import.org, 'get_registry', lambda: registry)
    monkeypatch.setattr(club_import.invitations, 'get_invitation_store', lambda: store)
    monkeypatch.setattr(club_import.team_authority, 'upsert', create)
    command = club_import.Commit(contract='document-import/1.0', operation_id='club-import-01', locale='en', rows=[
        {'type': 'team', 'name': f'New {i}'} for i in range(3)
    ] + [{'type': 'coach', 'name': 'Invalid', 'email': 'invalid'}])
    first = club_import.apply(command, 'club', 'director')
    assert len(teams) == 5
    assert [row.get('reason') for row in first['rows']] == [
        None, 'club_team_limit_reached', 'club_team_limit_reached', 'invalid_email']
    assert club_import.apply(command, 'club', 'director') == first
