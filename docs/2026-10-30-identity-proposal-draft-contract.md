# Club identity proposals — 2026-10-30

## Context
The ACB/FEB audit found wrong logos, consent/plugin colours and incomplete captures. Generation previously risked replacing the active identity; the manual path did not offer a complete review/apply/restore flow.

## Decision
Generation proposes; only an authenticated club administrator explicitly applies. `theme` remains the active payload. `theme_job.draftTheme` holds the proposal; `previousTheme` is one previous applied snapshot, and `revision` rejects stale confirmation requests from the new UI. Revisions are optimistic readback guards, not a new distributed transaction API. Existing registry whole-field writes retain their underlying concurrency semantics.

The editor exposes logo, primary and secondary, with generated light/dark previews and standard/contrast/soft variants. Secondary affects selected/tinted surfaces; orange actions and status colours remain product semantics. The shared JS engine and existing token whitelist/gate remain authoritative. Manual logo is retained through colour generation; logo-first drafting is supported. Restore revalidates the gate and uses the explicit apply endpoint. Existing clients may omit `expected_revision` for backward compatibility.

Public capture uses bounded HTTPS with pinned DNS and redirect checks. Rendered requests are fulfilled through the same transport without browser cookies, credentials, service workers or WebSockets. Candidate selection uses visible-header colours and decoded logo pixels. Model output is IDs only, validated against observed candidates and source provenance; entity judgement still requires human confirmation. AI errors or missing candidates abstain. Live AI construction is forbidden under CI; fake is the default and tests inject fixtures.

## Discarded alternatives
- Open-ended model requests: invent entities, URLs or colours and bypass provenance.
- Automatic activation: classifier/model confidence does not establish user intent.
- Replacing active theme during generation: loses a working identity on failed capture.
- Separate Python colour generator: diverges from the canonical JS contrast gate.

## Consequences and deployment boundary
No deploy, IAM/secret change, main merge or PR preview is authorized. The new code is not serving users yet. Live mode requires registered runtime configuration (`BIQ_IDENTITY_AI`, `BIQ_IDENTITY_AI_LOCATION`, `BIQ_IDENTITY_AI_MODEL`, `GOOGLE_CLOUD_PROJECT`, `BIQ_ENV`) and ADC using an authorized runtime identity. No model calls occur merely from installing the dependency. Planned configuration and runtime budget must be reviewed before enablement; current job inventory is 512 MiB/60 s. No claim of deployed UI validation or live-model acceptance is made.

## References and validation
Mission: `handoff/missions/2026-10-30-club-identity-assisted/MISSION.md` in the workspace. Audit/proposal: `handoff/outbox/2026-10-30-club-identity-feb-proposal-v1/`.
Tests: pipeline identity integration and selection, HTTP theme regression suite, and compiled-component Playwright identity flow (390/1280 px, light/dark, API mocks). Browser workflow `Identity validation (no deploy)` has read-only repository permissions and no deployment steps. Final results are recorded in the mission evidence ledger.
