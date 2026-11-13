# Guided entry and session work mode

The approved two-step role carousel replaces initial workspace selection when the App workspace directory is available. Existing accounts select one team or one director club using exclusive checks and a single confirmation. Invitations retain explicit acceptance and existing assignment approval rules.

Profile nickname is saved to the existing global profile only when absent. Team and club creates retain their existing validation and single-flight intent/recovery mechanisms. Confirming a mode calls App's live context-bound work-mode API; it does not overwrite team assignments. Draft values survive returning between the role and form screens. The legacy selector remains only for older hosts without the directory contract or for an explicit recovery path.

App supplies the authorized account/owner directory; per-club director capability is not inferred from a selected UI role. Member-managed credentials retain the verification boundary for personal resources and club creation.

The single confirmation is fixed above the host footer and safe area; list padding keeps the last check reachable in long owner catalogs. Mobile browser regression covers60teams.

## Personal-team staff · mission 2026-11-07-personal-team-staff

App advertises `personal.staff.manage` in entry actions and `personal_team/1.0` in personal context descriptors. Only a supporting host selects the canonical `/api/context/v1/personal-staff/teams` create port; older hosts retain the previous private-team port. Existing single-flight entry intents, stable create keys and context activation still apply. Account, membership and storage location never come from a browser-provided owner.

`personal-staff.ts` defines the separate `biq-personal-staff` control-plane element. Entry mounts its invitation-only view before context activation; the personal panel mounts directory, invitations, owner-controlled coach permission, removal/leave, ownership proposal/recipient acceptance and archive controls. Membership mutations include the current generation; permissions also include the current revision. Transfer proposal alone never changes the owner. Free-team display counts only active free teams owned by the actor; invited teams and courtesy/Premium teams are excluded. App remains authoritative on the actual quota and on every mutation.

Each mounted panel owns an abort controller and generation fence. Unmounting retires responses; commands are single-flight, operation identities survive uncertain retries within that mount, and failed mail retains the saved invitation with an explicit resend path. A successful membership/ownership/archive action tells the parent to refresh its authoritative directories. Date formatting follows `lang`; new Spanish fallbacks and the optional `localize(key, fallback)` hook require coordination with the separate English owner, not silent translation by this mission.

The four mocked browser cases in `personal-staff.test.mjs` cover delivery failure without expiry extension, account-level invitation acceptance, generation/revision permission changes and pending ownership, and courtesy without invitation/consumption controls. Their CI lane is advisory on the development browser pool; typecheck/library build remain separate checks. Compilation is not UI acceptance: CI-served Playwright and the composed staging build at 390px/1280px are still required before this surface counts as verified.
