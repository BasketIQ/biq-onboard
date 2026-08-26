"""Pydantic request/response models for the admin API."""

from __future__ import annotations

from pydantic import BaseModel


# ─── Club ───────────────────────────────────────────────────────────────────


class ClubCreate(BaseModel):
    id: str
    name: str
    short_name: str | None = None


class ClubSelfCreate(BaseModel):
    """Self-service club creation (ADDENDUM-07 §6): the id is assigned by the
    registry and the caller becomes administrator; only name (+ optional
    website) is client-supplied."""

    name: str
    website: str | None = None


class ClubUpdate(BaseModel):
    name: str | None = None
    short_name: str | None = None


# ─── Team ───────────────────────────────────────────────────────────────────


class TeamCreate(BaseModel):
    id: str
    club_id: str
    name: str
    category: str | None = None
    gender: str | None = None
    label: str | None = None


class TeamUpdate(BaseModel):
    name: str | None = None
    category: str | None = None
    gender: str | None = None
    label: str | None = None
    timezone: str | None = None
    staff_user_ids: list[str] | None = None


# ─── User ───────────────────────────────────────────────────────────────────


class UserCreate(BaseModel):
    id: str
    club_id: str
    display_name: str | None = None
    role: str = "coach"
    default_team_id: str | None = None
    password: str | None = None


class UserUpdate(BaseModel):
    display_name: str | None = None
    role: str | None = None
    default_team_id: str | None = None


class PasswordReset(BaseModel):
    password: str


# ─── Role ───────────────────────────────────────────────────────────────────


class RoleAssign(BaseModel):
    user_id: str
    role: str
    scope: str | None = None  # defaults to club:{club_id}


# ─── Onboarding ─────────────────────────────────────────────────────────────


class StaffEntry(BaseModel):
    username: str
    display_name: str | None = None
    roles: list[str] | str = "coach"
    password: str | None = None
    default_team_id: str | None = None


class OnboardRequest(BaseModel):
    club_id: str
    name: str
    slug: str
    short_name: str | None = None
    season: str | None = None
    staff: list[dict] | None = None
    password: str = "b4sk3t.26"
    reset_passwords: bool = False


# ─── Season ─────────────────────────────────────────────────────────────────


class SeasonUpdate(BaseModel):
    season: str
