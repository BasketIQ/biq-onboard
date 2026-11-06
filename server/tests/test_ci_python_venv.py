"""Exercise owned, isolated job environments without modifying system Python."""
import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "ci_python_venv.sh"


def env_for(tmp_path):
    env = dict(os.environ, RUNNER_TEMP=str(tmp_path),
               GITHUB_ENV=str(tmp_path / "github_env"), GITHUB_PATH=str(tmp_path / "github_path"))
    env.pop("BIQ_ONBOARD_TEST_VENV", None)
    return env


def test_parallel_jobs_have_distinct_isolated_envs_and_clean_their_own(tmp_path):
    env = env_for(tmp_path)
    for _ in range(2):
        subprocess.run(["bash", str(SCRIPT), "create"], env=env, check=True)
    dirs = [Path(line).parent for line in Path(env["GITHUB_PATH"]).read_text().splitlines()]
    assert len(set(dirs)) == 2
    for path in dirs:
        subprocess.run([str(path / "bin/python"), "-I", "-c",
                        "import sys,site;assert sys.prefix != sys.base_prefix;assert not site.ENABLE_USER_SITE"], check=True)
        subprocess.run(["bash", str(SCRIPT), "cleanup"],
                       env=dict(env, BIQ_ONBOARD_TEST_VENV=str(path)), check=True)
        assert not path.exists()
    assert tmp_path.exists()


@pytest.mark.parametrize("target", ["other", ".", ".."])
def test_cleanup_refuses_unowned_paths(tmp_path, target):
    env = env_for(tmp_path)
    sentinel = tmp_path / "keep.txt"
    sentinel.write_text("preserve")
    result = subprocess.run(["bash", str(SCRIPT), "cleanup"],
                            env=dict(env, BIQ_ONBOARD_TEST_VENV=str(tmp_path / target)))
    assert result.returncode != 0
    assert sentinel.read_text() == "preserve"
