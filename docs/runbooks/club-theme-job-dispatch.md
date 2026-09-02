# Club Theme Job Dispatch — Cross-Repo Coupling & Known Gotchas

`biq-onboard` (this repo, the API) and `biq-app` (`jobs/club-theme`, the Cloud Run Job worker)
deploy **independently** via separate GitHub Actions workflows
(`biq-onboard/.github/workflows/deploy.yml` and `biq-app/.github/workflows/deploy-club-theme-job.yml`).
Anyone touching the dispatch path (`_enqueue_generation_task()` in
`server/src/biq_onboard_server/routers/theme.py`, or the Job's callback handling in
`biq-app/jobs/club-theme/src/entry.mjs`) should be aware of two coupling points:

## 1. `RunJobRequest` body shape (fixed 2026-09-02)

`_enqueue_generation_task()` targets `POST run.googleapis.com/v2/{job}:run` directly via a Cloud
Tasks HTTP-target task (not the `google-cloud-run` client library). The Cloud Run Admin API v2
[`RunJobRequest`](https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/run)
only recognizes `{validateOnly, etag, overrides}` at the top level — `containerOverrides` **must**
be nested under `overrides`. A top-level `containerOverrides` key is silently rejected with
`INVALID_ARGUMENT`; Cloud Tasks retries and exhausts within seconds, and the Job never runs, with
no error surfaced anywhere in `biq-onboard` (`theme_job.status` just freezes at `"pending"`
forever). This shipped broken from the initial implementation (`f7b513f2`, 2026-08-27) because the
existing test mocked `create_task()` without ever decoding the actual JSON body. Fixed and
regression-tested in `test_enqueue_production_calls_cloud_tasks`
(`server/tests/test_theme.py`) — any future change to this payload should keep asserting the
decoded body shape, not just that `create_task()` was called.

If a similar "task creates fine but the Job never runs" symptom recurs, check first via:

```bash
gcloud logging read 'resource.type="cloud_tasks_queue"' --project <project> --limit 50
```

looking for `attemptResponseLog.status` on the queue — `INVALID_ARGUMENT` means the dispatch body
itself is rejected before it ever reaches the Job container (`gcloud run jobs executions list`
will show no matching execution around the request time).

## 2. `BIQ_THEME_JOB_RESULT_TOKEN` — duplicated secret, not shared

Both this repo and `biq-app` bake `BIQ_THEME_JOB_RESULT_TOKEN` into their respective Cloud Run
env vars from a **same-named but separately-stored** GitHub Actions environment secret
(`biq-onboard`'s `staging` environment and `biq-app`'s `staging` environment). There is no shared
source of truth and no sync mechanism — if the value is ever rotated in one repo without the
matching update in the other, every Job → API callback (`POST .../theme/result`) will 401
(`_require_job_result_auth` fail-closed) with no automatic retry from the Job side, again freezing
`theme_job.status` at `"pending"` (this time *after* a `"running"` post that also fails).

This was investigated as the leading hypothesis for the 2026-09-02 incident and **ruled out** by
checking `gh secret list -R <repo> --env staging` update timestamps on both sides (they were
last touched within one second of each other and unchanged since) — but the coupling itself is
still real and will drift again on the next unilateral rotation. Not yet remediated; the
architect-level design options on the table (ranked by preference) are:

1. Single Secret Manager entry, referenced by both deploys via `--set-secrets` instead of
   `--set-env-vars` — no baked copies, no duplication, no possible drift.
2. An org-level GitHub Actions secret instead of two repo/environment-scoped copies.
3. A post-deploy smoke test on both `deploy.yml` (this repo) and
   `deploy-club-theme-job.yml` (`biq-app`) that round-trips a synthetic
   `generate → poll until terminal (or timeout)` against a known-good URL.

See `handoff/inbox/2026-09-02-club-theme-job-stuck-pending-regression-analysis-from-onboarding-architect.md`
(local-only, not versioned) for the full incident writeup.
