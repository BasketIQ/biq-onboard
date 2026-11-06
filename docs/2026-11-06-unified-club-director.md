# Unified club director — 2026-11-06

Director decision: Administrator and Sports Director are one club profile, displayed as Director deportivo. biq-core 0.26.0 unites the club capabilities and retains administrator as a compatible legacy alias. Platform superadministrator and Knowledge Engineer remain separate; club boundaries and active-member gates remain enforced. No bulk data migration or real invitation was performed.

Core PR: https://github.com/BasketIQ/biq-core/pull/3
Core publication: https://github.com/BasketIQ/biq-core/actions/runs/42172167118 (success).

## Navigation and compatibility
Selecting Equipos now renders even when its catalogue is cached. Previously it only changed the internal route, leaving Miembros visible until another action (such as Invitar) rendered it. New memberships, role requests and redeemed invitations canonicalize the legacy alias to sports_director. Existing assignment identifiers remain usable. The editor deduplicates aliases and removes both legacy secondary grants when removing the unified role.

## Validation
322 server tests passed, 3 skipped. Typecheck and library build passed. Members/profile browser suites: 30 passed; additional dual-alias removal regression: 1 passed. Full UI run before final test additions: 222/224 passed; old profile-label expectation fixed and verified in the focused suite. Remaining entry-selector scrollHeight-null failure reproduces on unmodified main 6528a46 (48 passed, 1 failed). No staging acceptance yet.
