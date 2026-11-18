"""Reviewed club additions, with row-level outcomes and durable replay."""
import hashlib
import json
from typing import Annotated, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import clients, entry_ops, invitations, org, team_authority
from .models import TeamCreate


class Row(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    type: Literal["team", "coach"]
    name: str = Field(min_length=1, max_length=120)
    category: str | None = Field(default=None, max_length=80)
    gender: str | None = Field(default=None, max_length=60)
    level: str | None = Field(default=None, max_length=100)
    email: str | None = Field(default=None, max_length=254)
    role: str | None = Field(default=None, max_length=60)
    teams: list[Annotated[str, Field(min_length=1, max_length=120)]] = Field(default_factory=list, max_length=20)


class Commit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    contract: Literal["document-import/1.0"]
    operation_id: str = Field(pattern=r"^[A-Za-z0-9_-]{12,128}$")
    locale: Literal["es-ES", "en"]
    rows: list[Row] = Field(min_length=1, max_length=50)


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                        ensure_ascii=False).encode()).hexdigest()


def _reject(index, code):
    return {"row": index, "status": "rejected", "reason": code}


def _team(registry, club, issuer, row, index, batch):
    team_id = "team_imp_" + _hash([club.id, batch, index])[:32]
    try:
        payload = TeamCreate(id=team_id, club_id=club.id, name=row.name,
                             category=row.category or None, gender=row.gender or None, competitive_level=row.level)
    except ValidationError:
        return _reject(index, "invalid_team")
    existing = registry.get_team(club.id, team_id)
    if existing and (existing.archived or existing.name != payload.name):
        return _reject(index, "team_changed")
    if not existing:
        if any(team.name.casefold() == row.name.casefold() and team.category == payload.category
               and team.gender == payload.gender for team in registry.list_teams(club.id) if not team.archived):
            return _reject(index, "duplicate_team")
        try:
            team_authority.upsert(issuer, club.id, [payload.model_dump(exclude_none=True)], create_only=True)
        except HTTPException as exc:
            if exc.detail in ("club_team_limit_reached", "duplicate_team"):
                return _reject(index, exc.detail)
            raise
    return {"row": index, "status": "created", "team_id": team_id}


def _coach(registry, store, club, issuer, row, index, batch, locale, blocked_aliases):
    from pydantic import EmailStr, TypeAdapter
    from biq_core.roles import can_assign_role, effective_capabilities

    try:
        recipient = str(TypeAdapter(EmailStr).validate_python(row.email or "")).casefold()
    except ValidationError:
        return _reject(index, "invalid_email")
    if row.role and row.role.casefold() not in {"coach", "entrenador", "entrenadora"}:
        return _reject(index, "invalid_role")
    key = "in_" + _hash([club.id, batch, recipient])[:16]
    inv = store.get(key)
    if inv is None:
        if any(member.club_id == club.id for member in registry.find_users_by_email(recipient)):
            return _reject(index, "already_member")
        if any(old.club_id == club.id and old.is_live(entry_ops._now_iso())
               for old in store.list_for_recipient(recipient)):
            return _reject(index, "already_invited")
        caps = effective_capabilities(issuer, "club:" + club.id, org.get_roles())
        if not can_assign_role(caps, "coach"):
            raise HTTPException(403, "proposed role not assignable")
        teams = registry.list_teams(club.id)
        ids = []
        for reference in row.teams:
            wanted = reference.casefold()
            if wanted in blocked_aliases:
                return _reject(index, "team_not_imported")
            matches = [team.id for team in teams if not team.archived
                       and wanted in {team.id.casefold(), team.name.casefold()}]
            if len(matches) != 1:
                return _reject(index, "unknown_or_ambiguous_team")
            ids.extend(matches)
        inv = store.create_once(invitations.Invitation(
            invitation_id=key, club_id=club.id, token_digest=invitations.token_digest(invitations.new_token()),
            proposed_roles=["coach"], recipient_email=recipient, issuer_membership_id=issuer,
            created_at=entry_ops._now_iso(), expires_at=invitations.default_expiry(), discoverable=True,
            staff_team_ids=list(dict.fromkeys(ids)), display_name=row.name,
        ))
    if not inv or inv.club_id != club.id or inv.recipient_email != recipient or inv.issuer_membership_id != issuer:
        raise HTTPException(409, "operation_conflict")
    if inv.status == "revoked" or (inv.status != "redeemed" and not inv.is_live(entry_ops._now_iso())):
        return _reject(index, "invitation_unavailable")
    if inv.status != "redeemed":
        try:
            sent = clients.send_invite(recipient, club.name, club.id, idempotency_key=key, locale=locale)
        except clients.UpstreamServiceError as exc:
            raise HTTPException(503, "invitation_delivery_pending") from exc
    else:
        sent = {"skipped": False}
    return {"row": index, "status": "invited", "invitation_id": key, "team_ids": inv.staff_team_ids,
            "email_skipped": bool(sent.get("skipped"))}


def apply(command, club_id, issuer):
    registry = org.get_registry()
    club = registry.get_club(club_id)
    if not club or club.status != "active":
        raise HTTPException(404, "club_not_found")
    store = invitations.get_invitation_store()
    batch = _hash([club_id, issuer, command.operation_id])
    signature = _hash(command.model_dump())
    claim = store.import_record(batch, {"signature": signature})
    if not claim or claim["signature"] != signature:
        raise HTTPException(409, "operation_conflict")
    completed = store.import_record(batch + "-result")
    if completed:
        return completed
    rows = {}
    rejected_aliases = set()
    seen_emails = set()
    for kind in ("team", "coach"):
        for index, row in enumerate(command.rows, 1):
            if row.type != kind:
                continue
            key = f"{batch}-row-{index}"
            result = store.import_record(key)
            email = (row.email or "").casefold()
            if result is None:
                if kind == "team":
                    result = _team(registry, club, issuer, row, index, batch)
                elif email and email in seen_emails:
                    result = _reject(index, "duplicate_email")
                else:
                    result = _coach(registry, store, club, issuer, row, index, batch, command.locale, rejected_aliases)
                result = store.import_record(key, result)
            if kind == "team" and result["status"] == "rejected":
                rejected_aliases.add(row.name.casefold())
            if email:
                seen_emails.add(email)
            rows[index] = result
    result = {"contract": command.contract, "operation_id": command.operation_id,
              "rows": [rows[index] for index in sorted(rows)]}
    return store.import_record(batch + "-result", result)
