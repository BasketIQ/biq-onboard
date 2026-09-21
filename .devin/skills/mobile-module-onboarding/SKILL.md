---
name: mobile-module-onboarding
description: Homologate a BasketIQ Mobile module repo — module contract v1, reproducible build, workflow-only deploys, shell registration
---

# Mobile module onboarding — homologate a `biq-*` module

Use when adding or homologating a repo of the BasketIQ Mobile suite (shell or module). Contract source of truth: `biq-app/docs/architecture/module-contract-v1.md`. Run `repo-onboarding` first for the generic SDLC part; this skill adds the mobile-specific requirements.

## 1. Module contract v1 (modules only, not the shell)

- [ ] Defines `<biq-<id>-app>` idempotent (Web Component, Shadow DOM).
- [ ] CSS inlined (`?inline`); **no** service worker or own manifest.
- [ ] Uses the injected `el.coach` capability; degrades to text when absent.
- [ ] Real data **only via the shell's BFF** (never internal tokens/services from the browser). `window.__BIQ_COACH_API__` as base override.

## 2. Reproducible build

- [ ] `.npmrc` with `registry=https://registry.npmjs.org/`.
- [ ] `.nvmrc` with `20` (aligned with the Dockerfile's `node:20-slim`).
- [ ] **No** `package-lock.json` resolving against internal registries.
- [ ] `npm install && npm run typecheck && npm run build && npm run build:lib` all green.

## 3. Deploy (workflows only)

- [ ] Multi-stage `Dockerfile` (Vite build → FastAPI with cookie login).
- [ ] `.github/workflows/deploy-staging.yml` (WIF → Cloud Build → Cloud Run) with health check (root 302 · login 200 · `/embed/<repo>.js` 200), triggered by PR per rule 07.
- [ ] `.github/workflows/build-bundle.yml` validating the bundle contract.
- [ ] `staging` environment vars/secrets declared: `GCP_PROJECT_ID`, `GCP_BIQ_WIF_PROVIDER`, `GCP_DEPLOYER_SA`, `GCP_AR_REPO`, `GCP_RUN_SERVICE`, `STAGING_BASIC_AUTH_USER`/`PASSWORD`.

## 4. Shell registration (safe order)

- [ ] Deploy the module.
- [ ] Verify `/embed/<repo>.js` → 200 + CORS + `text/javascript` (or `python biq-app/scripts/check-modules.py --file <entry>`).
- [ ] Add/update the entry in `biq-app/app/modules.json`.
- [ ] Deploy the shell; the smoke asserts the module mounts (deploy fails otherwise).

## 5. Onboarding

- [ ] `CONTRIBUTING.md` present and homogeneous (local build, deploy via Actions UI, module contract, repo's local port).
