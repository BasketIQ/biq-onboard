#!/usr/bin/env bash
# Each job owns its venv; never install/uninstall in the shared runner Python.
set -euo pipefail
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
case "${1:-create}" in
  create)
    : "${GITHUB_PATH:?GITHUB_PATH is required}"
    : "${GITHUB_ENV:?GITHUB_ENV is required}"
    job_venv=$(mktemp -d "${RUNNER_TEMP%/}/onboard-python.XXXXXX")
    trap 'rm -rf -- "$job_venv"' ERR
    python3 -m venv "$job_venv"
    "$job_venv/bin/python" -I - <<'CHECK'
import importlib.util
import site
import sys
assert sys.prefix != sys.base_prefix, "expected an isolated venv"
assert not site.ENABLE_USER_SITE, "user site must be disabled"
assert importlib.util.find_spec("biq_onboard_server") is None, "foreign editable leaked into venv"
CHECK
    echo "$job_venv/bin" >> "$GITHUB_PATH"
    echo "BIQ_ONBOARD_TEST_VENV=$job_venv" >> "$GITHUB_ENV"
    echo "VIRTUAL_ENV=$job_venv" >> "$GITHUB_ENV"
    ;;
  cleanup)
    job_venv="${BIQ_ONBOARD_TEST_VENV:-}"
    [ -n "$job_venv" ] || exit 0
    if [ "$(dirname "$job_venv")" != "${RUNNER_TEMP%/}" ]; then
      echo "Refusing cleanup outside job temp" >&2; exit 1
    fi
    case "$(basename "$job_venv")" in
      onboard-python.?*) rm -rf -- "$job_venv" ;;
      *) echo "Refusing cleanup of unowned path" >&2; exit 1 ;;
    esac
    ;;
  *) echo "Unknown venv action" >&2; exit 1 ;;
esac
