# Shared roster editor — context port (SF1-A) — 2026-10-16

The Equipos «Plantilla» editor is now one renderer driven by a
context-scoped port, not two editor surfaces. Personal teams and club
teams open the same `[data-edit-modal]` subscreen; the difference is
which backend the port talks to.

## Change

- `app/src/onboard-app.ts`
  - `TeamEditorPort` (`load` / `save`) with typed results
    (`ok` / `not_found` / `denied` / `conflict` / `unavailable`) so the
    UI fails closed instead of guessing from HTTP codes.
  - `_teamEditorPort()` — chosen once per context scope; the personal
    adapter calls `GET/PUT
    /api/context/v1/personal-teams/{id}/roster`, the club adapter keeps
    the existing org/team endpoints. The port is invalidated when the
    context scope changes so a stale adapter can never write to the
    wrong authority.
  - `_openEditModal` is async through the port: `_editLoading` first,
    then `_loadEditorModel`. Denied/malformed roster reads close the
    intent with an error — never an empty phantom draft.
  - Canonical edit deep-link is `#/onboard/teams?edit=<id>`; legacy
    `spaces?edit=<id>` forwards under an active personal context
    (other query params preserved), holds while the context is
    unknown, and consumes foreign/archived ids once.
  - `_maybeFocusRoster` keeps the focus intent across the loading
    render — the modal shell exists before the roster model, so the
    flag is consumed only once rows exist.
  - Personal «Plantilla» row action sets the canonical `teams` route
    state before opening (the editor subscreen requires
    `_subRoute === 'teams'`).
- `app/tests/personal-roster-shared-editor.test.mjs` — NEW: personal
  roster display/edit, canonical route, denied-read fail-closed,
  stale-load fencing, 409 draft preservation, pending/deep-link.
- `app/tests/entry-selector.test.mjs` — OB60-3 cases updated to the
  forward contract: `spaces?edit` intent is held until a personal
  context arrives, then drains once into `teams?edit`.

## Contract reminder

The editor must never open on anything but a successful authorized
roster read. `unavailable`/`denied`/`not_found` surface an error in the
host (`_entryError` personal, `_teamsError` club); `conflict` keeps the
draft and reports inside the modal.

## Review corrections (2026-10-17)

- Club adapter reads are authoritative: a model is built only from a
  confirmed roster-bearing management row (`players` present). The
  `_mergedCatalog()` self-scoped metadata projection is never a roster;
  a delayed/failed management read leaves the intent pending or
  unavailable — a metadata row can never open as an empty draft.
- Fencing is generation + full scope identity: `_openEditModal` and
  `_saveEditModel` capture `editor generation` and a fingerprint of
  context id/epoch, owner union, principal, org, working team ids and
  active team before awaiting; every completion is dropped unless the
  fingerprint and generation still match. A same-team reopen is a new
  generation, so a late save can never close or repaint the fresh
  editor. Context setter retires the editor whenever the fingerprint
  changes (including same-epoch working-set/principal transitions).
- Saves serialize: inputs and the save control are disabled while a
  payload is in flight, and a second submission is dropped — a stale
  completion can never discard newer typed edits.
- Personal `toModel` echo-validates the served envelope before any
  model exists: `team_id` echo, `schema_version: "1.0"`, context
  id/epoch match, complete `owner_scope` union against the active
  context, positive `team_revision`. A readable own team outside the
  working set opens read-only (`permissions.edit === false`) — the GET
  proves visibility, not edit authority.
- `app/package.json` — the test script is capped to a single
  concurrency slot (`--test-concurrency=1`); the default parallel file
  launch could starve concurrent `chromium.launch()` calls and leave
  later files `cancelledByParent` (environment flake, not a code
  defect). Sequential runs deterministically pass 149/149.
