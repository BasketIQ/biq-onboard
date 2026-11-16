import os
from pathlib import Path
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "identity_runtime_secrets.sh"


def operands(**changes):
    env = {**os.environ, "TARGET_ENV": "staging", "PROJECT_ID": "spain-nextgen-staging",
           "CALLBACK_SECRET_VERSION": "1", "EMBED_SECRET_VERSION": "2", **changes}
    return subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True)


def test_staging_callback_uses_only_numeric_secret_references():
    result = operands()
    assert result.returncode == 0
    assert result.stdout == (
        "CALLBACK_SECRET_MAPPING=,BIQ_THEME_JOB_RESULT_TOKEN=BIQ_THEME_JOB_RESULT_TOKEN:1\n"
        "PINNED_EMBED_VERSION=2\n")


@pytest.mark.parametrize("name", ["CALLBACK_SECRET_VERSION", "EMBED_SECRET_VERSION"])
@pytest.mark.parametrize("invalid", ["", "latest", "0", "-1", "1;echo unsafe"])
def test_staging_reference_rejects_unpinned_versions(name, invalid):
    result = operands(**{name: invalid})
    assert result.returncode != 0
    assert result.stdout == ""


def test_staging_reference_rejects_other_projects():
    assert operands(PROJECT_ID="basketiq-platform-prod").returncode != 0


def test_production_reference_preserves_the_existing_legacy_contract():
    result = operands(TARGET_ENV="production", PROJECT_ID="untouched")
    assert result.returncode == 0
    assert result.stdout == "CALLBACK_SECRET_MAPPING=\nPINNED_EMBED_VERSION=latest\n"


def test_backend_deployment_requires_main_and_exact_main_ci():
    caller = (ROOT / ".github/workflows/deploy-staging.yml").read_text()
    workflow = (ROOT / ".github/workflows/deploy.yml").read_text()
    assert "if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'" in caller
    assert "head_sha=${CHECKED_OUT_SHA}" in workflow
    assert 'gh run watch "$RUN_ID" --repo "$GH_REPO" --exit-status' in workflow
    assert "actions: read" in workflow and "actions: read" in caller
    assert "${CHECKED_OUT_SHA}" in workflow.split("IMAGE_URI=", 1)[1].splitlines()[0]
    assert "${PINNED_EMBED_VERSION}${CALLBACK_SECRET_MAPPING}" in workflow
    assert '--image "${DEPLOY_IMAGE}"' in workflow
    assert 'DEPLOY_IMAGE=${IMAGE_URI%:*}@${IMAGE_DIGEST}' in workflow
