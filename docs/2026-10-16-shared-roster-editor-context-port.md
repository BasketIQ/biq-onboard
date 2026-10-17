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
