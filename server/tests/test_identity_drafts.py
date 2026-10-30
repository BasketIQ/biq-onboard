"""Identity proposal isolation; no cloud or AI credentials needed."""
import copy
from types import SimpleNamespace
from biq_onboard_server.routers.theme import _editable_theme, _save_draft

class Registry:
    def __init__(self):
        self.saved = None
    def merge_club_fields(self, club_id, fields):
        self.saved = copy.deepcopy(fields)


def test_editing_active_logo_does_not_mutate_live_theme():
    club = SimpleNamespace(theme={"status": "active", "logo": {"onLight": "old"}}, theme_job={})
    draft = _editable_theme(club)
    draft["logo"]["onLight"] = "new"
    registry = Registry()
    _save_draft(registry, "club", club, draft)
    assert club.theme["logo"]["onLight"] == "old"
    assert "theme" not in registry.saved
    assert registry.saved["theme_job"]["draftTheme"]["logo"]["onLight"] == "new"


def test_gate_cannot_be_promoted_by_draft_writer():
    registry = Registry()
    club = SimpleNamespace(theme=None, theme_job={"previousTheme": {"status": "active"}})
    _save_draft(registry, "club", club, {"status": "active", "gate": {"passed": False}})
    job = registry.saved["theme_job"]
    assert job["draftTheme"]["status"] == "uncertain"
    assert job["previousTheme"] == {"status": "active"}


def test_editing_existing_proposal_copies_it_and_prefers_it_over_active():
    club = SimpleNamespace(theme={"seed": {"brand": "active"}}, theme_job={"draftTheme": {"seed": {"brand": "draft"}}})
    proposal = _editable_theme(club)
    assert proposal["seed"]["brand"] == "draft"
    proposal["seed"]["brand"] = "edit"
    assert club.theme_job["draftTheme"]["seed"]["brand"] == "draft"
