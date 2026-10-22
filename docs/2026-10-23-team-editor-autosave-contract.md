# Team editor — autosave, serial queue and exit contract (UX/UI V2, on main 2026-10-22)

Mission `2026-10-23-uxui-v2-integration`. Integrated by biq-onboard #65 (merge `a23d198`), from branch `uxui/2026-10-18-dev3-onboard-v2-staging` @ `31420f6`: `9dc1f17`, `4d8f551`, `eb8a6d8` (R1), `73c4b95` + `bbefc7a` (R2), `4c1efdd` (R3). App-common milestone: `biq-app/docs/2026-10-23-uxui-v2-integration-milestone.md`.

**This document is the current contract of the team editor**, for both the club team and the personal team. It **supersedes** the save-serialization paragraph of `2026-10-16-shared-roster-editor-context-port.md` §Review corrections: "inputs and the save control are disabled while a payload is in flight, and a second submission is dropped". There is no Guardar control any more, inputs stay editable during a save, and edits made while a save is in flight are not dropped: the queue sends them next. The rest of that document still applies, in particular authoritative reads, generation and full-scope fencing, personal `toModel` echo-validation, and read-only outside the working set.

Code: `app/src/onboard-app.ts`. Line numbers are as of `a23d198`.

## Context

V2 removed «Guardar»/«Cancelar» from the team editor (TEAM-AUTOSAVE). Every edit must persist on its own without losing typing, without a blind overwrite of concurrent changes, and without the shell abandoning an unsaved draft when the user navigates.

## Decision — the contract

### Autosave and the serial queue
- Typing schedules a save with a ~600 ms debounce. `change` on a field (the level select, for example), `focusout` with a dirty draft, and removing a player skip the debounce (`_scheduleEditorSave(accelerated)`). Adding a player marks the draft pending immediately: an incomplete new row never shows «Guardado».
- **Inputs are not disabled during a save**: `_renderTeamEditScreen` applies `disabled` only when `permissions.edit === false`. Typing while a save is in flight is the central case.
- `_queueEditorSave` / `_editSaveChain` form one serial chain:
  - there is never more than one PUT in flight and at most one queued pass;
  - while a pass is queued, new edits only set the dirty flag;
  - the queued pass reads the DOM when it runs.
- After a `saved` response, only the CAS handle of the model (`_editModel`) is updated. If the DOM now differs from the snapshot that was sent, the next pass is queued: edits typed during the flight are never dropped.
- The owner of each job (team id + `_editSeq` + `_editFence`) is captured when it is queued. A job or response born under another editor, generation or principal is ignored: it neither mutates nor releases anything.
- Validation runs on the full snapshot: a blank name, a new row that is empty or only has a number, or an invalid number keeps the status `pending` with a message and **no write**. Rows are never dropped silently, because the roster persists by full replacement.
- Status chip: `idle | pending | saving | saved | error | conflict`. «Reintentar» is shown on `error`. «Mantener mis cambios» / «Cargar versión actual» are shown on a decided conflict.

### Transport and CAS
- **Personal team:** `PUT /api/context/v1/personal-teams/{id}/roster` with `expected_revision` (`team_revision` CAS). A 409 is a conflict.
- **Club team:** `PUT /api/clubs/{club}/teams/{id}` with no revision; the model is rebuilt from the sent draft with `version: null`. **Declared limitation:** club reconciliation compares content, not revision. It first re-fetches the management feed (`loadTeams`).

### Reconciliation after a non-confirmed result (R2-D3-1, R3-D3-1/3)
- Any `conflict`, `error`, `denied`, `not-found` or uncertain transport result sets `_editNeedsReconcile`. No later PUT (autosave, flush, back or retry) goes out until a reconciliation read (`_reconcileEditor`) decides:
  - `already-persisted`: the server already holds exactly the sent snapshot (lost ACK). The new revision is adopted with no extra PUT.
  - `resolved`: a three-way per-field merge (base = last confirmed model, server, draft). Fields only the server changed are adopted into the draft and the DOM; fields the user edited are kept.
  - `conflict`: the same field diverged on both sides. The server roster is shown. `_editConflictServer` is **sticky** until «Mantener mis cambios» (adopt the server CAS handle, resend the user draft) or «Cargar versión actual» (discard the draft, adopt the server version). There is zero PUT until that explicit choice. A conflict that is still open is never re-analysed against a moved base.
  - `failed`: an invalid draft keeps the confirmed base and the obligation to reconcile (`_editModel` does not move to the server version), so fixing the field triggers a fresh three-way merge before any PUT.

### Exit contract with the App shell (`requestLeave` / `commitLeave`)
- `requestLeave(grant)` is the **admit** phase. It flushes the queue (`_flushEditorQueue`, at most 8 passes) and returns `false` while work is unpersisted (pending validation, error, conflict). It never retires the editor. On `true` it binds the grant, the admitted generation (`_admittedSeq`) and the admitted draft snapshot.
- `commitLeave(grant)` is the **commit** phase and is awaitable (R3-D3-2):
  - it retires the editor only for the same grant and generation;
  - if the draft changed after admission, it flushes again first and retires only if the server confirms;
  - otherwise it returns `false` and the editor keeps its state and controls.
- The shell side (`biq-app/app/shell.js`, `mayLeaveActiveModule` / `commitModuleLeave`) is described in the biq-app milestone. It awaits both phases with a 30 s fail-closed ceiling and revalidates `navGuardSeq` and `authorityFence()` after each await.

## Discarded alternatives

- *Keep the 16-Oct "disable and drop" serialization:* incompatible with autosave, because typing during a save is the normal case. Dropping a second submission would lose edits.
- *Blind retry after 409 or an uncertain result:* would overwrite concurrent changes or duplicate a write whose ACK was lost.

## Consequences

- Restoring the "disable inputs while saving" behaviour would be a regression of this contract. The R1/R2/R3 suites `app/tests/r{1,2,3}-editor-corrections.test.mjs` pin it (183/183 on the merged tree).
- Debt: there is no club-side CAS (content comparison only), as documented above.
- Product acceptance of autosave/CAS for club and personal teams on staging is pending with the Director (product validation request of the mission).

## References

- biq-onboard #65 `a23d198`; R3 return `handoff/processed/2026-10-18-uxui-v2-dev3-rebase-staging-return-for-arch-ux-ui.md` (local).
- Superseded paragraph: `docs/2026-10-16-shared-roster-editor-context-port.md` §Review corrections, "Saves serialize".
