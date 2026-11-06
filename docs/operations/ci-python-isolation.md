# Python isolation on persistent runners

Onboard CI and Deploy Staging/test must never install into the shared runner interpreter. The failed main run42268513171 attempted to uninstall a missing global editablepth and reported conflicting versions from other services. A concurrent writer was not conclusively identified; the shared mutable site-packages was proven by the log paths. Retrying the old workflow does not remove that failure mode.

After setup-python, scripts/ci_python_venv.sh creates a unique empty venv under RUNNER_TEMP. It checks prefix isolation, disabled user site and absence of a foreign editable Onboard import. Subsequent Python/pip/pytest steps use that interpreter via GITHUB_PATH. Dependencies, vendor telemetry and the canonical core pin are installed there, then pip check validates consistency. Existing WIF/scoped permissions, test checks, AI guard and staging deploy gates remain in place. The always cleanup step refuses unowned paths and removes only its own venv. Runner job-temp cleanup remains a fallback if the process is hard-killed.

The reused deploy workflow's pip download writes only its wheelhouse; it does not install into shared site-packages and is outside this repair. No system Python cleanup/reinstall, new credentials or dependency-pin change is needed. Container product code is unchanged.

Validation: server/tests/test_ci_python_venv.py creates two distinct environments, checks isolation and owned cleanup, and rejects outside/unowned paths. Full CI and DeployStaging/test validate fresh installs, pipcheck and the existing server suite.
