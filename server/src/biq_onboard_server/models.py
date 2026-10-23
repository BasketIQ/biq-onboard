"""Pydantic request/response models for the admin API."""

from __future__ import annotations

from biq_core.org import get_category
from pydantic import BaseModel, Field, field_validator

# Team gender values accepted by the API ("" clears the field on update).
TEAM_GENDERS = frozenset({"F", "M", "X"})


def _valid_category(value: str | None) -> str | None:
    """Category must be a canonical ``CATEGORIES`` slug or empty."""
    if value in (None, ""):
        return value
    if get_category(value) is None:
        raise ValueError("unknown category")
    return value


def _valid_gender(value: str | None) -> str | None:
    if value in (None, ""):
        return value
    if value not in TEAM_GENDERS:
        raise ValueError("invalid gender")
    return value


# ─── Club ───────────────────────────────────────────────────────────────────


class ClubCreate(BaseModel):
    id: str
    name: str
    short_name: str | None = None


class ClubSelfCreate(BaseModel):
    """Self-service club creation (ADDENDUM-07 §6): the id is assigned by the
    registry and the caller becomes administrator; only name (+ optional
    website) is client-supplied.

    ``idempotency_key`` (optional) makes retries deterministic: when present,
    the club and creator membership ids are derived from it, so replaying the
    same operation writes the same documents and never duplicates the club.
    """

    name: str
    website: str | None = None
    idempotency_key: str | None = None


class ClubUpdate(BaseModel):
    name: str | None = None
    short_name: str | None = None


# ─── Team ───────────────────────────────────────────────────────────────────


class RosterPlayer(BaseModel):
    """API-boundary shape for a plantilla entry (biq-core ``TeamPlayer``).

    Validation lives here, not in the canonical model: ``name`` is stripped
    and must be non-empty, ``number`` is the shirt number (0–99, optional —
    amateur rosters do not always assign one).

    ``player_id`` is the stable roster identity introduced by biq-core
    0.25.0 (``pl_<16 lowercase hex>``). Rows arriving without one get a
    fresh id on write (``ensure_player_ids``); rows arriving with one are
    accepted only when the id already exists in a roster of the same club
    (preserve same-team, link PD-2) — enforced in the teams router.
    """

    name: str = Field(min_length=1, max_length=120)
    number: int | None = Field(default=None, ge=0, le=99)
    player_id: str | None = Field(default=None, pattern=r"^pl_[0-9a-f]{16}$")

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        name = value.strip()
        if not name:
            raise ValueError("player name must not be blank")
        return name


class TeamCreate(BaseModel):
    id: str
    club_id: str
    name: str
    category: str | None = None
    gender: str | None = None
    label: str | None = None
    competitive_level: str | None = None
    players: list[RosterPlayer] | None = None
    staff_user_ids: list[str] | None = None

    @field_validator("category")
    @classmethod
    def _category_slug(cls, value: str | None) -> str | None:
        return _valid_category(value)

    @field_validator("gender")
    @classmethod
    def _gender_value(cls, value: str | None) -> str | None:
        return _valid_gender(value)


class TeamUpdate(BaseModel):
    name: str | None = None
    category: str | None = None
    gender: str | None = None
    label: str | None = None
    timezone: str | None = None
    staff_user_ids: list[str] | None = None
    competitive_level: str | None = None
    players: list[RosterPlayer] | None = None

    @field_validator("category")
    @classmethod
    def _category_slug(cls, value: str | None) -> str | None:
        return _valid_category(value)

    @field_validator("gender")
    @classmethod
    def _gender_value(cls, value: str | None) -> str | None:
        return _valid_gender(value)


# ─── User ───────────────────────────────────────────────────────────────────


class UserCreate(BaseModel):
    id: str
    club_id: str
    display_name: str | None = None
    email: str | None = None
    role: str = "coach"
    # F9 multi-role: additional roles granted via RoleAssignments at the club
    # scope. ``role`` stays the single primary role on the User record.
    roles: list[str] | None = None
    default_team_id: str | None = None
    password: str | None = None


class UserUpdate(BaseModel):
    display_name: str | None = None
    email: str | None = None
    role: str | None = None
    # F9 multi-role: when provided, the user's secondary club-scope roles are
    # synced to this set (adds/removes RoleAssignments, audited). The primary
    # ``role`` is always kept assigned and is never removed by the sync.
    roles: list[str] | None = None
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
