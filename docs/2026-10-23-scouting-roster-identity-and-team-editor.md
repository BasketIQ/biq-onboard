# Scouting — roster identity (player_id) and team editor fields (S6 + S10a)

Mission `2026-10-23-scouting-team-player`, slices S6 + S10a. Branch `mission/2026-10-23-scouting-team-player` on `biq-onboard`, base `origin/main` `65408cd`. Depends on `biq-core[org]==0.25.0` (`TeamPlayer.player_id`, `ensure_player_ids`, `scouting.*` capabilities — see `biq-core/docs/2026-10-23-biq-core-0.25.0-scouting-roster-identity.md`).

## Why

F-CL-3 (MISSION §Analysis 2): the Scouting player/team sheets need a **stable club-roster identity**. Before this change a roster row was `{name, number}` only — a rename or a number change broke the link between a row and its scouting data. `player_id` (`pl_<16 lowercase hex>`) is the durable key; `biq-player` reads it from the Org Registry (`players` without an id are excluded from Scouting and counted as `missing_ids` until backfilled).

## API contract

- `RosterPlayer` (create/update payloads and `_players_json` responses) carries optional `player_id`, validated `^pl_[0-9a-f]{16}$`.
- `update_team`'s PUT response echoes the canonical roster including `player_id`, so the editor adopts server-assigned ids.
- `TeamUpdate.category` / `.gender` are validated: category must be a canonical `biq-core` `CATEGORIES` slug, gender one of `F`/`M`/`X`; `""` clears the field, `null`/omitted preserves it. Invalid values → 422.

## Write rules (the link rule, PD-2)

`create_team` / `update_team` resolve incoming roster rows through `_resolve_roster_players`:

- an incoming `player_id` is accepted **only if it already exists in a roster of the same club** — same team = preserve, another team of the club = link (PD-2);
- any other id → 422 `unknown_player_id` (foreign club or invented);
- duplicate ids within one roster → 422 `duplicate_player_id`;
- rows without an id receive a fresh `pl_<16 hex>` — legacy rows are identified lazily on their next write.

Partial writes preserve untouched fields: `players` omitted → existing roster kept (ids included); category/gender changes never touch `label`, `staff_user_ids`, `competitive_level`, `timezone` or players.

### Writers inventory (all preserve ids)

Every `players` write path was audited — all preserve existing ids:

- `teams.py` `update_team` — resolves or keeps `existing.players` when omitted;
- `teams.py` `archive_team` / `unarchive_team` — pass `existing.players` verbatim;
- `teams.py` `create_team` — resolves via `ensure_player_ids`;
- `teams.py` `migrate-player-ids` — partial write (`players` only, `exclude_unset` merge);
- `onboarding.py` seed (`bulk_upsert_teams`) — `Team` built **without** `players`, so the merge leaves an existing roster untouched;
- `migrate_staff.py` — partial `Team` write (`staff_user_ids` only), roster untouched;
- `entry_ops.py` redeem/activate paths — never write `players`.

## Backfill procedure

`POST /api/admin/clubs/{club_id}/teams/migrate-player-ids` (same `require_admin` gate as `migrate-staff`):

1. **Always dry-run first** (default): `POST …/migrate-player-ids` returns `{teams_scanned, teams_changed, rows_assigned, rows_already_identified}` without writing.
2. Apply with `?dry_run=false`; each write touches only `players`.
3. Idempotent: a second apply reports zero changes.
4. Logs carry counts only — never player names.
5. **Staging execution only with the Director's explicit go** — pending product validation.

## Rollout constraint

`player_id` written by a ≥0.25.0 writer must never be dropped by an older writer. **No other writer of club rosters may remain on `biq-core < 0.25.0`** once identified rows exist: a writer that rebuilds `TeamPlayer` rows without the field (or reserializes rosters through an old model) would silently strip ids and orphan scouting data. The onboard editor already resends ids after adopting them; biq-app's personal roster API is the remaining gap (below).

## Personal teams — Phase B gap

biq-app's own-workspace roster endpoint (`PUT /api/context/v1/personal-teams/{id}/roster`) **rejects unknown row keys today**. The onboard frontend therefore sends roster rows narrowed to `{name, number}` for personal rosters — `player_id` is never sent (explicit branch + TODO in `_personalTeamEditorPort().save`, pinned by `app/tests/scouting-team-editor.test.mjs`). Personal-roster `player_id` support is deferred to Phase B, when biq-app accepts the key.

## Team editor — Categoría + Género (F-CL-3, PD-5)

The club team editor gained two fields before «Nombre del equipo», matching the prototype order: Categoría, Nombre, Género, Nivel de competición, Plantilla.

- **Categoría** — select over the canonical `CATEGORIES` vocabulary (same slugs/labels as `PERSONAL_CATEGORIES`).
- **Género** — Femenino `F` / Masculino `M` / Mixto `X`.
- Both join the existing autosave chain (`_scheduleEditorSave` → serial queue → dirty/pending → saving → saved, stale-response fencing) exactly like name and level; there is no Guardar/Cancelar.
- A stored value outside the vocabulary is preserved as an extra selected option — the same rule `competitiveLevelOptionsHtml` uses; nothing is silently dropped.
- Read-only (non-manager) renders both disabled.
- A draft `''` («Selecciona…») maps to clearing the field server-side; the snapshot comparison normalizes `''`/`null`/`undefined` so the lost-ACK detector and dirty checks never see a phantom diff.
- Personal teams keep the previous field set — the personal roster contract has no category/gender.

## References

- biq-core 0.25.0: release `600a7ae`, feature `bc92e38`, doc `biq-core/docs/2026-10-23-biq-core-0.25.0-scouting-roster-identity.md`.
- Editor autosave contract: `docs/2026-10-23-team-editor-autosave-contract.md` (unchanged — this slice rides it).
- biq-player consumer: `server/src/biq_player_server/roster.py` (S1) excludes id-less rows and counts `missing_ids`.
