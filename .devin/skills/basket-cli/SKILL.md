---
name: basket-cli
description: The `basket` workspace CLI — diagnostics, sync/materialization, Google Cloud re-authentication, agent delegation and remote-job commands. Use before improvising auth fixes or hand-running operations the CLI covers.
---

# `basket` — the BasketIQ workspace CLI

`basket` is the canonical workspace CLI (`basketiq-wow/src/basket_cli`). Use it instead of hand-rolling equivalents. Running `basket` with no arguments opens an interactive prompt.

## Diagnostics (read-only, safe)

```bash
basket env doctor          # local environment diagnostics
basket config doctor       # config location drift (canonical: basketiq-wow/cfg)
basket governance doctor   # rules/workflows/skills location + drift audit
basket repo doctor --owner BasketIQ --repo <repo> [--strict]  # origin/worktree health
basket sandbox doctor <agent_id>                              # Agent Card validation
```

## Sync / materialization

`basketiq-wow/rules/`, `basketiq-wow/skills/` and `basketiq-wow/.devin/workflows/` are the **authored source of truth**. Everything under `.devin/`, `.windsurf/`, `.cursor/`, `AGENTS.md`, `CLAUDE.md` in every repo is generated — never hand-edit.

```bash
basket setup --ide devin --root <repo>   # materialize into a repo
basket sync                              # regenerate canonical outputs
basket sync --check                      # report drift without writing
```

## Google Cloud authentication — the recurring one

When `gcloud` fails on expired credentials, **do not stop and do not ask the user to run anything manually**:

```bash
basket gcloud-auth --local   # on this machine — Playwright-driven OAuth, no browser window
```

- Canonical credential file: `basketiq-wow/cfg/basketiq/gcloud-auth.config.json` (gitignored).
- Never write the password in chat or versioned files; use `--password-env` / `--password-file` / `--password-stdin` if the config file is missing and a user is present.
- For ADC errors in non-interactive contexts, prefer `gcloud auth print-access-token`.
- After re-authenticating, re-run the original failing command.

## Agent delegation

```bash
basket ai --type kimi --model kimi-k3 --handoff <file.md> --response-handoff <out.md> [--notify]
```

See rule `08-basket-ai-delegation` for model aliases and safety (`--auto`/`--yolo` enable tool use; default is prompt-only).

## GitHub Actions helpers

```bash
basket gh-run latest|status|watch ...   # wrapper around `gh run` for workspace conventions
```

## Remote jobs (legacy)

`basket job launch|status|logs|kill` and `basket static serve` target the retired remote-job model (SSH to integration hosts). They still exist for compatibility but are **not** the current operating model — CI runs on self-hosted runners via `pick-runner` (rule 06). Prefer `gh`/`gcloud` on Local.

## Session helpers

`basket session open|close`, `basket clean start|stop|status`, `basket start|stop` (keep-awake), `basket open|close` (proxy+tunnel) — see `basket --help` for the current surface.
