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

## 2. `BIQ_THEME_JOB_RESULT_TOKEN` — canonical numeric Secret Manager binding

F1 staging reuses the existing callback value as the single Secret Manager
`BIQ_THEME_JOB_RESULT_TOKEN`, mounted by Onboard and the worker with a numeric
version. The worker's outgoing App admission credential is a separate numeric
mount from `BIQ_INTERNAL_TOKEN`; it is not the callback credential. The desired
references and runtime identity are registered in
`biq-app-cfg/cfg/basketiq/club-identity-runtime.config.json`.

The September deployment used same-named, separately stored GitHub secrets;
that historical coupling could leave jobs pending when callback authentication
failed. Do not restore the old pattern or copy values into deployment commands.
Verify the numeric references and scoped accessor grants on both deployed
templates, then qualify the real callback path. A successful deploy or matching
reference alone does not prove a generation completed.

## 3. Admission and terminal-delivery deadlines

Identity admission waits at most 30 seconds, while terminal delivery retains
eight seconds. The previous eight-second admission timeout was shorter than
the downstream control-plane request budget and could turn an authoritative
late `403 smart_required` into `503 identity_smart_unavailable`. The regression
test injects the late-denial boundary without sleeps and checks that admission
still fails closed. This is a bounded request, not a retry or an execution
permission. Manual colours/logo do not acquire a Smart admission.

The worker's configured CPU, memory and 120-second task limit are unchanged.
Rollback uses the prior main image through the governed deployment workflow.
Do not lengthen timeouts manually on Cloud Run or use a warm-cache rerun as
proof. The App technical memory describes the staging-only controlled provider
and its zero-use receipts; no real model invocation is required to qualify
that composition.

ES: La admisión espera una respuesta autoritativa hasta 30 segundos; una
denegación o una confirmación ambigua nunca permite encolar. El callback usa
una versión numérica del secreto canónico, distinta del token saliente de App.
Logo y colores manuales siguen funcionando sin Smart. La propuesta requiere
revisión y activación explícita; el despliegue por sí solo no acredita el flujo.

## 4. Live locale changes on identity screens

The `biq-locale:changed` host event must rerender Mi Club as well as guided
onboarding. Do not return early when `.guided-entry` is absent: that leaves
identity in Spanish after the shell has switched to English. Preserve the
unsaved website, logo URL and primary/secondary colour controls while
rerendering, alongside the existing guided-form drafts. The browser regression
switches ES → EN → ES without remounting the component or posting those drafts.
Deployed verification must use the normal shell language picker, not a forced
reload as a substitute for the live-switch contract.

See `handoff/inbox/2026-09-02-club-theme-job-stuck-pending-regression-analysis-from-onboarding-architect.md`
(local-only, not versioned) for the full incident writeup.
