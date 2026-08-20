"""Season get/set endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Request

from .. import org
from ..auth import require_admin
from ..models import SeasonUpdate

router = APIRouter(prefix="/season")


@router.get("")
def get_season(request: Request) -> dict:
    require_admin(request)
    registry = org.get_registry()
    season = registry.get_season()
    return {"season": season}


@router.put("")
def set_season(payload: SeasonUpdate, request: Request) -> dict:
    require_admin(request)
    registry = org.get_registry()
    registry.set_season(payload.season)
    return {"ok": True, "season": payload.season}
