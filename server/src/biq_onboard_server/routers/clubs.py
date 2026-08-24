"""Club CRUD endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Request

from .. import org
from ..auth import require_admin
from ..models import ClubCreate, ClubUpdate

router = APIRouter(prefix="/clubs")


@router.post("")
def create_club(payload: ClubCreate, request: Request) -> dict:
    require_admin(request, payload.id)
    from biq_core.org import Club

    registry = org.get_registry()
    club = Club(id=payload.id, name=payload.name, short_name=payload.short_name)
    registry.upsert_club(club)
    return {"ok": True, "club": {"id": club.id, "name": club.name}}


@router.get("")
def list_clubs(request: Request) -> dict:
    require_admin(request)
    registry = org.get_registry()
    # OrgRegistry doesn't have list_all_clubs; use Firestore directly if available.
    try:
        from biq_core.org import FirestoreOrgRegistry

        if isinstance(registry, FirestoreOrgRegistry):
            docs = registry._db.collection("orgs_clubs").stream()  # type: ignore[attr-defined]
            clubs = [{"id": d.id, "name": d.get("name", d.id)} for d in docs]
            return {"clubs": clubs, "total": len(clubs)}
    except Exception:
        pass
    # Memory mode: return what we have
    if hasattr(registry, "_clubs"):
        clubs = [{"id": cid, "name": c.name} for cid, c in registry._clubs.items()]  # type: ignore[attr-defined]
        return {"clubs": clubs, "total": len(clubs)}
    return {"clubs": [], "total": 0}


@router.get("/{club_id}")
def get_club(club_id: str, request: Request) -> dict:
    require_admin(request, club_id)
    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="club not found")
    return {"id": club.id, "name": club.name, "short_name": club.short_name}


@router.put("/{club_id}")
def update_club(club_id: str, payload: ClubUpdate, request: Request) -> dict:
    require_admin(request, club_id)
    from biq_core.org import Club

    registry = org.get_registry()
    existing = registry.get_club(club_id)
    if existing is None:
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="club not found")
    # Carry every field we do not intend to change. biq-core 0.11.0 made
    # upsert_club partial-write (model_dump(exclude_unset=True) + merge), so
    # omitting a field would now preserve it rather than destroy it — but we
    # carry explicitly anyway so the write does not depend on which biq-core
    # is installed. Getting this wrong is severe: `status` defaults to
    # "active" on the Club model, so a dropped field would silently reactivate
    # a deactivated club on rename.
    club = Club(
        id=club_id,
        name=payload.name or existing.name,
        short_name=payload.short_name or existing.short_name,
        status=existing.status,
        created_by=existing.created_by,
        deactivated_at=existing.deactivated_at,
        deactivated_by=existing.deactivated_by,
    )
    registry.upsert_club(club)
    return {"ok": True, "club": {"id": club.id, "name": club.name}}


@router.delete("/{club_id}")
def delete_club(club_id: str, request: Request) -> dict:
    require_admin(request, club_id)
    from ..onboarding import offboard_club

    return offboard_club(club_id)
