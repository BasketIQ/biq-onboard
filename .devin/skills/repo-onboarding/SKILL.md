---
name: repo-onboarding
description: Create a new BasketIQ repo or bring an existing one into the canonical standard — org secrets/vars, generated agent config, pick-runner wiring, repos-mapping registration
---

# Repo onboarding — bring a repo into the BasketIQ standard

Use when creating a new repo under `BasketIQ/` or homologating an existing clone. The governing rule is `05-repo-standard-structure.md`; this skill is the executable checklist.

## Steps

1. **Create / locate the repo**
   - New: `gh repo create BasketIQ/<repo> --private` from Local, then `git clone` into `/Users/jjdelcampo/projects/basketiq/<repo>`.
   - Existing: clone under the same workspace root. One clone per repo — no sandboxes.

2. **Register it** — add a row in `basketiq-wow/docs/sdlc/repos-mapping.md`: repo, owning agent card, purpose, local port (if it serves), staging URL (if deployed). Check the port does not collide with the assigned ones (8090 app-shell E2E, 8092 shell dev, 8093 season-plan, 8094 playbook, 8095 chronicle, 8083 training, 8096 methodology, 8097 knowledge, 8098 cycle, 8099 onboard, 8100 social).

3. **Materialize agent config** — `basket setup --ide devin --root <repo>` then `basket sync`. Generates `.devin/rules/`, `.devin/skills/`, `AGENTS.md`, `CLAUDE.md`. Never hand-edit generated files.

4. **Index hygiene** — copy `basketiq-wow/templates/.codeiumignore` to `<repo>/.codeiumignore`.

5. **CI wiring (only if the repo has workflows)**
   - Vendor `.github/actions/{pick-runner,setup-self-hosted-env}` byte-identical from `basketiq-wow/.github/actions/`.
   - Every `runs-on` job routes through the `pick` job + inline `runs-on` expression (rule 06).
   - `concurrency: { group: '${{ github.workflow }}-${{ github.ref }}', cancel-in-progress: true }` on PR-triggered workflows.
   - Hermetic CI validates in the PR (`selected=development` + green jobs); deploy workflows are migrated but **not** triggered.

6. **Deploy config (only if it deploys)** — declare the `staging` environment vars/secrets the workflow expects: `GCP_PROJECT_ID`, `GCP_BIQ_WIF_PROVIDER`, `GCP_DEPLOYER_SA`, `GCP_AR_REPO`, `GCP_RUN_SERVICE`, `STAGING_BASIC_AUTH_USER`/`PASSWORD`. WIF trusts the whole `BasketIQ` org — no SA keys.

7. **Close out** — technical memory in the repo's `docs/` (rule 04), and record paths/remotes/follow-ups in the handoff.

## Verify

```bash
basket repo doctor --owner BasketIQ --repo <repo> --strict
basket governance doctor
```

## Forbidden

- Repo-level runner PATs (the org `RUNNER_PICK_PAT` covers it).
- `runs-on: self-hosted` bare or `ubuntu-latest` on real jobs.
- Service-account JSON keys when WIF exists.
