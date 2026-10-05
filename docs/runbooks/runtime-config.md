# Runtime config — biq-onboard

Canonical environment/secret wiring for the Cloud Run service. All values
are set by `.github/workflows/deploy.yml` — never patched by hand.

## Secret Manager mounts (`--set-secrets`)

| Env name | Secret Manager secret | Version pin |
|---|---|---|
| `BIQ_INTERNAL_TOKEN` | `BIQ_INTERNAL_TOKEN` | **numeric** — `vars.BIQ_INTERNAL_TOKEN_VERSION` per GitHub Environment (staging: `5`). Never `:latest`; a floating ref silently splits the mesh on rotation. The deploy fails closed on nonnumeric pins or non-ENABLED versions. |
| `BIQ_EMBED_JWT_SECRET` | `BIQ_EMBED_JWT_SECRET` | `latest` — shared HS256 signing secret for App-issued entry proofs (`entry_proof.py`, R5). Distributed to Secret Manager by the config owner (basketiq-wow cfg governance); the value never transits logs or `--set-env-vars`. Deploy fails closed when no enabled version exists — without it every entry proof is rejected. |

## Plain env vars (`--set-env-vars`, secrets injected from GitHub)

`BIQ_ENV=prod`, `BIQ_ORG_STORE=firestore`, `BIQ_ROLES_STORE=firestore`,
`GCP_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT`, `BIQ_ONBOARD_USER`,
`BIQ_ONBOARD_PASSWORD`, `BIQ_ONBOARD_SESSION_SECRET`,
`BIQ_ONBOARD_S2S_SECRET`, `BIQ_THEME_JOB_RESULT_TOKEN`,
`BIQ_CLOUD_TASKS_QUEUE`/`GCP_TASKS_QUEUE`, `GCP_TASKS_LOCATION`,
`GCP_THEME_JOB_NAME`, `GCP_TASK_INVOKER_SA`, `BIQ_ONBOARD_CALLBACK_URL`,
`BIQ_METHODOLOGY_URL`, `BIQ_SEASON_PLAN_URL`, `BIQ_APP_URL`.

## GitHub Environment (`staging`)

- vars: `GCP_PROJECT_ID`, `GCP_RUN_SERVICE`, `GCP_AR_REPO`,
  `GCP_BIQ_WIF_PROVIDER`, `GCP_DEPLOYER_SA`, `GCP_TASK_INVOKER_SA`,
  `BIQ_ONBOARD_CALLBACK_URL`, `BIQ_INTERNAL_TOKEN_VERSION`.
- secrets: `BIQ_ONBOARD_USER`, `BIQ_ONBOARD_PASSWORD`,
  `BIQ_ONBOARD_SESSION_SECRET`, `BIQ_ONBOARD_S2S_SECRET`,
  `BIQ_THEME_JOB_RESULT_TOKEN`.

## Forbidden

- `BIQ_INTERNAL_TOKEN` at `:latest` (2026-10-04 mesh-split incident).
- `BIQ_EMBED_JWT_SECRET` via `--set-env-vars` or a per-repo GitHub copy —
  the canonical material lives in Secret Manager only.
- Manual `gcloud run services update` env patches — next deploy replaces
  the env list wholesale and silently drops them.
