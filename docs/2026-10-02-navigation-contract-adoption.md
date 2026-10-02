# Global navigation contract — biq-onboard adoption

**Date:** 2026-10-02 · **Owner:** Developer 33 · **Contract:** `handoff/inbox/2026-10-02-global-navigation-and-section-submenu-contract-from-architect-3.md`

## What changed

- **§A no-club state** — the club-selection flow emits no module-owned
  replacement chrome (no header/nav/footer) and no longer reserves a top
  gap for absent shell chrome (`.onboard-clubstep` `padding-top: 32px`
  removed). The flow fills the safe viewport edge to edge.
- **§C section submenu (Product addendum 2026-10-02)** — the canonical
  sticky orange subheader (`.onboard-subhead`) renders on **every**
  club-selected Mi Club view, emitted once at `render()` level:
  - titles: `Mi Club` on the landing (bare `#/onboard`, no section-back),
    `Mi Club: Estilo` / `Mi Club: Equipos` / `Mi Club: Miembros` /
    `Mi Club: Perfil` on the section views;
  - editor subscreens (team edit/Plantilla, member edit) keep the bold
    parent title (`Mi Club: Equipos` / `Mi Club: Miembros`) — the
    team/member name rides as compact secondary context
    (`.onboard-subhead-context`), never replacing it;
  - the sibling tab bar (`.onboard-nav`) stays below the subheader on
    landing/list views and is hidden on editor subscreens.
- **Back semantics** — `_sectionBack()` resolves the destination from
  live state:
  - team edit → `_closeEditModal()` → Equipos list; clears `?edit=` from
    the hash via `history.replaceState` (no-reopen preserved, #57);
  - member edit → clears `_editingMemberId` → Miembros list;
  - list sections → `_subRoute = ''` → Mi Club landing (`#/onboard`).
  - Neither path uses `history.back()` nor navigates to app Home (`#/`).
- **No submenu footer** — no module-owned bottom chrome is emitted.

## Sticky-offset seam (backward compatibility)

`position: sticky` on `.onboard-subhead` resolves its top offset from:

1. `--biq-shell-chrome-top` (published by the shell provider on `body` —
   chrome height while shown, `0` while collapsed/hidden; the inherited
   value wins verbatim since it already carries the collapse math);
2. `body[data-shell-chrome="collapsed"|"hidden"]` → `0px` (MutationObserver
   on the contract attribute, read-only);
3. measured `#shell-header` height — today's always-visible legacy shell
   header, so the subhead sits below it until the provider ships;
4. standalone/dev fallback → `env(safe-area-inset-top)` (the only context
   where the module owns the viewport).

The module only ever **reads** shell DOM state (`#shell-header` box,
`body` dataset, inherited custom property) and publishes
`--biq-subhead-top` on its own `:host`. It never manipulates shell chrome,
so the code is backward-compatible with today's shell and forward-ready
for the provider without a follow-up change.

## Preserved contracts

- #55/#57 Plantilla: same `_openEditModal`/`_closeEditModal` state paths;
  `?edit=<id>` deep link still waits for settled catalogs and opens the
  editor with roster focus (`[data-edit-modal]` kept as the focus anchor).
- Authorization fail-closed: `_activeSubscreen()` re-checks
  `_canManageTeams()`/`_memberCanEdit()` on every render — a stale edit id
  under a downgraded role paints the plain list, never the editor.
- Focus restoration: `_maybeFocusRoster` unchanged; roster add/remove and
  draft sync (`_syncEditDraftFromDom`) work unchanged inside the subscreen.
- The team **delete** confirmation stays a true modal dialog
  (`role="dialog"`, `aria-modal`) — confirmations are not subscreens.

## Tests

`app/tests/navigation-contract.test.mjs` — 7 Playwright-driven tests:
no-club zero-chrome + no reserved spacing; team-edit subhead
(`Mi Club: Equipos` + secondary context)/color/sticky/back-size/back→list
+ `?edit=` cleanup; Plantilla entry + roster focus; member-edit subhead +
back → Miembros; addendum title matrix across all five views + list
back → landing + no submenu footer; `--biq-shell-chrome-top` /
`--biq-subhead-top` / `data-shell-chrome` seams.
