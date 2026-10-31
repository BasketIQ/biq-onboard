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

## Consequences and deployed state (updated 2026-10-31)
The original no-deploy boundary was superseded by the Director's «Despliega, adelante» on 2026-10-31. Implementation is integrated and serving staging: biq-app `16d397c4`, biq-onboard `5e043141`, configuration receipt `13079b8c`. Production remains outside scope. Existing attached runtime ADC/Vertex permission was reused; no new secret or IAM expansion.

Live selection is explicitly configured as `BIQ_IDENTITY_AI=live`, region `europe-west1`, model `gemini-2.5-flash`. CI still uses fakes and forbids live construction. Inference disables thinking, allows 1200 output tokens and a 20-second deadline. Browser launch allows 8 seconds and fails into capture/manual fallback; validated IPv4 is preferred on dual-stack hosts. Only logo-pixel/visible-header colours are offered to the model. Runtime remains 512 MiB / 60 seconds; these sample successes are not a worst-case memory certificate or a latency SLA.

Full final staging regression: 36 sites, 30 technical drafts, 29 visually usable (80.56%); the affiliated Unicaja foundation badge is excluded. Seven unresolved portals remain in the report. No proposal was automatically applied. Real deployed UI verification covered manual draft isolation, explicit apply, return to default, Perfil round trip and light/dark 390/1280 views. Previous-active restore is covered by mocked integration tests; the live test started without an active club theme and exercised return to default instead.

Remaining limitations: human entity/logo and usage-rights confirmation; optimistic revision readback rather than distributed CAS; bounded network stages do not imply a single hard wall-clock bound for Python DNS/ADC; external sites and cold starts vary. Component reservations were released explicitly by the Director. BA compliance review is separate from product acceptance.

## References and validation
Mission: `handoff/missions/2026-10-30-club-identity-assisted/MISSION.md` in the workspace. Audit/proposal: `handoff/outbox/2026-10-30-club-identity-feb-proposal-v1/`.
Tests: pipeline identity integration and selection, HTTP theme regression suite, and compiled-component Playwright identity flow (390/1280 px, light/dark, API mocks). Browser workflow `Identity validation (no deploy)` has read-only repository permissions and no deployment steps. Final results are recorded in the mission evidence ledger.

## BA remediation evidence — 2026-10-31
F1: this dated deployment receipt supersedes the historical no-deploy paragraph. F2: recovered scripts, commands, screenshots and results live in `handoff/missions/2026-10-30-club-identity-assisted/evidence/remediation-f1-f3/`. F3: retrospective per-PR self-check is explicitly dated after merge; no pre-merge checklist is fabricated. Final report: `handoff/outbox/2026-10-31-club-identity-36-validation/index.html`.
