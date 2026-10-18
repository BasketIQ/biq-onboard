# Member-scope personal-feed gate (D2) — 2026-10-16

Staging browser validation (Test Dev) reported a deterministic
`GET /api/context/v1/personal-teams → 403` console error on every
club-context login. Root cause: `loadBootstrap()` prefetched the personal
feed unconditionally — and member-credential sessions are denied that
endpoint outright (`identity_scope: "membership"` → `_personal_allowed`
false → 403, the R1 privacy wall in biq-app `context/api.py`).

The bootstrap already advertises the verdict before any fetch is needed:
`entry_actions['personal.team.read'].allowed === false` and the personal
context candidate carries `requires_verification: true`. The module was
reading neither.

## Change

- `app/src/onboard-app.ts`
  - `_personalReadAllowed()` — single funnel gate used by
    `loadPersonalTeams()`: prefers the authoritative
    `entry_actions['personal.team.read'].allowed`, falls back to the
    personal candidate's `requires_verification`, and defaults to allowed
    when no bootstrap is loaded (the `#/onboard` personal panel only runs
    under an active personal context — authority already proven).
    Callers (bootstrap prefetch, `wirePersonalEvents` self-load, retry,
    post-mutation reloads) inherit the gate.
  - `renderEntryStep()` — the Mi equipo tab renders an honest
    verified-session note for denied sessions instead of an infinite
    "Cargando equipos…" spinner or a retry that can never succeed.
  - `BootstrapPayload.identity_scope` declared (server already sends it).
- `app/tests/entry-selector.test.mjs` — member-scope regression test:
  zero `personal-teams` GETs on bootstrap and on the tab click; the
  denied note renders with no loading/error/retry/CTA.

## Contract reminder

`personal.team.*` entry actions are `allowed:false /
requires_verification:true` under `membership` scope. UI must gate on the
advertised authority — never probe a denied endpoint and treat the 403 as
data.
