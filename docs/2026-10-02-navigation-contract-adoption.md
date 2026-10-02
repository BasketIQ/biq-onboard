# Global navigation contract — biq-onboard adoption

**Date:** 2026-10-02 · **Owner:** Developer 33 · **Contract:** `handoff/inbox/2026-10-02-global-navigation-and-section-submenu-contract-from-architect-3.md`

## What changed

- **§A no-club state** — the club-selection flow emits no module-owned
  replacement chrome (no header/nav/footer) and no longer reserves a top
  gap for absent shell chrome (`.onboard-clubstep` `padding-top: 32px`
  removed). The flow fills the safe viewport edge to edge.
- **§C section submenu** — team edit/Plantilla and member edit are now
  in-page **subscreens** that replace the section Home list, headed by the
  canonical sticky orange subheader (`.onboard-subhead`):
  - back chevron (`data-section-back`, ≥44×44, visible focus);
  - bold title `Club – <team name>` / `Club – <member context>`,
    truncating safely via ellipsis.
  - The sibling tab bar (`.onboard-nav`) is hidden while a subscreen is
    active — the subheader is the subscreen's only navigation.
- **Back semantics** — the section back control is wired to the same
  deterministic close paths as the in-form buttons:
  - team edit → `_closeEditModal()` → Equipos list; clears `?edit=` from
    the hash via `history.replaceState` (no-reopen preserved, #57);
  - member edit → clears `_editingMemberId` → Miembros list.
  - Neither path uses `history.back()` nor navigates to app Home (`#/`).
- **No submenu footer** — no module-owned bottom chrome is emitted.

## Sticky-offset seam (backward compatibility)

`position: sticky` on `.onboard-subhead` resolves its top offset from:

1. `--biq-shell-chrome-height` (published by the shell provider once
   Developer 3's PR lands — chrome height while shown, `0` collapsed);
2. `body[data-shell-chrome="collapsed"]` → `0px` (MutationObserver on the
   contract attribute, read-only);
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

`app/tests/navigation-contract.test.mjs` — 5 Playwright-driven tests:
no-club zero-chrome + no reserved spacing; team-edit subhead title/color/
sticky/back-size/back-→list + `?edit=` cleanup; Plantilla entry + roster
focus; member-edit subhead + back → Miembros; `--biq-subhead-top` /
`data-shell-chrome` seam.
