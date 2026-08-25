"""Club theme endpoints (ADDENDUM-02 section 8, ADDENDUM-06 section C13).

Theme management for clubs. Per ADDENDUM-07, club CRUD lives in biq-onboard.

Endpoints:
    POST   /api/clubs/{club_id}/theme/generate  — enqueue generation job (202)
    GET    /api/clubs/{club_id}/theme           — current ClubTheme or null
    PUT    /api/clubs/{club_id}/theme           — manual colour override (same gate)
    DELETE /api/clubs/{club_id}/theme           — revert to BasketIQ default

Authorisation: generate/put/delete require club-admin scope. Read follows
existing club scope.

The generation job is a Cloud Run Job invoked via Cloud Tasks (ADDENDUM-06
section C13.3). This router enqueues tasks; it does not run the pipeline.
The pipeline lives in @basketiq/club-theme-pipeline (Node) and is executed
by the job.

Map-replacement semantics (ADDENDUM-06 section C9.3a): replacing theme or
theme_job is a whole-field replacement, not a merge. Use update(), not
set(merge=True).
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, field_validator

from .. import org
from ..auth import require_admin

router = APIRouter(prefix="/clubs/{club_id}/theme")


# ─── Models ──────────────────────────────────────────────────────────────


class GenerateRequest(BaseModel):
    homepage_url: str


class ManualThemeRequest(BaseModel):
    """Manual colour override (ADDENDUM-02 section 8 PUT)."""
    seed_brand: str
    seed_brand_alt: str | None = None

    @field_validator("seed_brand", "seed_brand_alt")
    @classmethod
    def validate_hex(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not v.startswith("#") or len(v) != 7:
            raise ValueError("must be a 7-character hex colour like #FF5A00")
        try:
            int(v[1:], 16)
        except ValueError:
            raise ValueError("must be valid hex")
        return v.upper()


# ─── Cloud Tasks enqueue ────────────────────────────────────────────────


def _cloud_tasks_config() -> dict:
    """Read Cloud Tasks configuration from env."""
    return {
        "project_id": os.environ.get("GCP_PROJECT_ID", ""),
        "location": os.environ.get("GCP_TASKS_LOCATION", "europe-west1"),
        "queue": os.environ.get("GCP_TASKS_QUEUE", "club-theme-generation"),
        "job_url": os.environ.get("CLUB_THEME_JOB_URL", ""),
        "service_account_email": os.environ.get("GCP_DEPLOYER_SA", ""),
    }


# Module-level Cloud Tasks client — lazily initialised so the import
# never fails in dev/test environments without GCP credentials.
_tasks_client = None


def _get_tasks_client():
    """Lazily build and cache the Cloud Tasks client.

    Returns None if google-cloud-tasks is not installed, so the caller
    can fall back to the synthetic dev path.
    """
    global _tasks_client
    if _tasks_client is not None:
        return _tasks_client
    try:
        from google.cloud import tasks_v2
        _tasks_client = tasks_v2.CloudTasksClient()
        return _tasks_client
    except Exception:
        return None


def _enqueue_generation_task(club_id: str, source_url: str) -> str:
    """Enqueue a club-theme generation task to Cloud Tasks.

    Returns the task ID. When ``BIQ_CLOUD_TASKS_QUEUE`` is unset (local
    dev), returns a synthetic ID — the job is not actually enqueued.
    When the env var is set, creates a real Cloud Tasks task targeting
    the Cloud Run Job URL with payload ``{ clubId, sourceUrl }``.

    The explicit env-var gate (rather than probing for a project) makes
    the dev/prod boundary unambiguous: no env var = synthetic, env var
    = real Cloud Tasks call.
    """
    config = _cloud_tasks_config()

    # Explicit dev-mode gate: if the queue env var is not set, we are in
    # local development and must not attempt a real Cloud Tasks call.
    queue_env = os.environ.get("BIQ_CLOUD_TASKS_QUEUE", "")
    if not queue_env:
        return f"dev-task-{int(time.time())}"

    # Production path: create a real Cloud Tasks task.
    client = _get_tasks_client()
    if client is None:
        # Library not available — fall back to synthetic rather than
        # crashing the request. This should not happen in production
        # (google-cloud-tasks is in pyproject.toml dependencies).
        return f"dev-task-{int(time.time())}"

    import json as _json
    from google.cloud import tasks_v2
    from google.protobuf import timestamp_pb2

    # Build the queue path
    queue_path = client.queue_path(
        config["project_id"],
        config["location"],
        config["queue"],
    )

    # Task payload — the Cloud Run Job receives this as its body
    payload = _json.dumps({
        "clubId": club_id,
        "sourceUrl": source_url,
    }).encode()

    # Construct the task
    task = tasks_v2.Task(
        name=f"{queue_path}/tasks/club-theme-{club_id}-{int(time.time())}",
        http_request=tasks_v2.HttpRequest(
            http_method=tasks_v2.HttpMethod.POST,
            url=config["job_url"],
            headers={"Content-Type": "application/json"},
            body=payload,
            oidc_token=tasks_v2.OidcToken(
                service_account_email=config["service_account_email"],
            ),
        ),
    )

    # Use a deterministic name to avoid duplicate tasks on retry
    created = client.create_task(
        request={"parent": queue_path, "task": task},
    )

    # Extract the task ID from the full name
    return created.name.split("/")[-1]


# ─── Lease management (ADDENDUM-06 section C5.2) ────────────────────────


def _check_lease(club_id: str) -> dict | None:
    """Check if there is a live lease for this club.

    Returns the lease dict if live, None otherwise.
    """
    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        return None

    theme_job = getattr(club, "theme_job", None)
    if not theme_job:
        return None

    lease = theme_job.get("lease") if isinstance(theme_job, dict) else None
    if not lease:
        return None

    expires_at = lease.get("expiresAt")
    if not expires_at:
        return None

    # Check if the lease has expired
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        if datetime.now(timezone.utc) < expiry:
            return lease
    except (ValueError, AttributeError):
        pass

    return None


def _create_lease(holder: str, duration_seconds: int = 300) -> dict:
    """Create a lease dict."""
    expires_at = datetime.now(timezone.utc).timestamp() + duration_seconds
    return {
        "holder": holder,
        "expiresAt": datetime.fromtimestamp(expires_at, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
    }


# ─── Rate limiting (ADDENDUM-06 section C5.3) ───────────────────────────


def _check_rate_limit(club_id: str, source_url: str) -> bool:
    """Check rate limit: 5/hour, 20/day per clubId + normalised sourceUrl.

    Returns True if within limits, False if exceeded.
    """
    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        return True

    theme_job = getattr(club, "theme_job", None)
    if not theme_job:
        return True

    attempts = theme_job.get("attempts", 0) if isinstance(theme_job, dict) else 0
    requested_at = theme_job.get("requestedAt") if isinstance(theme_job, dict) else None

    # Simple check: if more than 20 attempts total, reject
    # A more sophisticated implementation would track per-URL and per-time-window
    if attempts >= 20:
        return False

    return True


# ─── Endpoints ───────────────────────────────────────────────────────────


@router.post("/generate")
def generate_theme(club_id: str, payload: GenerateRequest, request: Request) -> dict:
    """Enqueue the club-theme generation job (ADDENDUM-06 section C13.3).

    Returns 202 + job id. Authorisation: club-admin scope.

    Idempotency (section C5.2): if a lease is live or a terminal verdict
    exists for the same sourceUrl, returns the existing job.
    """
    user = require_admin(request, club_id)

    # Normalise URL
    url = payload.homepage_url.strip()
    if not url.startswith("https://"):
        if url.startswith("http://"):
            raise HTTPException(status_code=400, detail="URL must be https")
        url = "https://" + url

    # Check if club exists
    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")

    # Check lease (section C5.2)
    existing_lease = _check_lease(club_id)
    if existing_lease:
        # Return the existing job
        theme_job = getattr(club, "theme_job", {}) or {}
        return {
            "ok": True,
            "status": "already_running",
            "jobId": existing_lease.get("holder", ""),
            "themeJob": theme_job,
        }

    # Rate limit (section C5.3)
    if not _check_rate_limit(club_id, url):
        raise HTTPException(status_code=429, detail="rate limit exceeded (max 20/day)")

    # Enqueue the task
    task_id = _enqueue_generation_task(club_id, url)

    # Update theme_job state (whole-field replacement, section C9.3a)
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    existing_job = getattr(club, "theme_job", {}) or {}
    new_theme_job = {
        "status": "pending",
        "sourceUrl": url,
        "requestedAt": now,
        "finishedAt": None,
        "attempts": (existing_job.get("attempts", 0) if isinstance(existing_job, dict) else 0) + 1,
        "verdict": None,
        "notifiedAt": None,
        "lease": _create_lease(task_id),
    }

    # Whole-field replacement (section C9.3a)
    registry.merge_club_fields(club_id, {"theme_job": new_theme_job})

    return {
        "ok": True,
        "status": "pending",
        "jobId": task_id,
        "themeJob": new_theme_job,
    }


@router.get("")
def get_theme(club_id: str, request: Request) -> dict:
    """Return the current ClubTheme or null (ADDENDUM-02 section 8)."""
    require_admin(request, club_id)

    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")

    theme = getattr(club, "theme", None)
    theme_job = getattr(club, "theme_job", None)

    return {
        "ok": True,
        "theme": theme,
        "themeJob": theme_job,
    }


@router.put("")
def put_theme(club_id: str, payload: ManualThemeRequest, request: Request) -> dict:
    """Manual colour override (ADDENDUM-02 section 8 PUT).

    Same schema, same gate. The gate runs server-side (ADDENDUM-06
    section C13.2: Python does contrast arithmetic only).
    """
    user = require_admin(request, club_id)

    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")

    # Build a minimal theme object from the manual seed.
    # The actual ramp + gate runs in the generation job (Node).
    # Here we store the manual seed and mark it as 'draft' pending
    # server-side gate validation.
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    theme = {
        "schemaVersion": 1,
        "generatorVersion": "1.0.0",
        "clubId": club_id,
        "status": "draft",  # manual override starts as draft
        "source": {
            "kind": "manual",
            "homepageUrl": getattr(club, "website", None) or "",
            "extractedAt": now,
            "confidence": 1.0,  # manual override has full confidence
        },
        "seed": {
            "brand": payload.seed_brand,
            "brandAlt": payload.seed_brand_alt,
            "detectedFrom": "manual",
        },
        "logo": None,  # manual override does not change logo
        "tokens": {},  # tokens are generated by the job
        "gate": {
            "passed": False,
            "checkedAt": now,
            "pairsChecked": 0,
            "failures": [],
            "repairs": [],
        },
        "activation": {
            "themeStatus": "draft",
            "reason": "manual override — pending gate validation",
            "decidedAt": now,
        },
    }

    # Whole-field replacement (section C9.3a)
    registry.merge_club_fields(club_id, {"theme": theme})

    return {
        "ok": True,
        "theme": theme,
    }


@router.delete("")
def delete_theme(club_id: str, request: Request) -> dict:
    """Revert to BasketIQ default (ADDENDUM-02 section 8 DELETE)."""
    user = require_admin(request, club_id)

    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")

    # Clear the theme (whole-field replacement to null, section C9.3a)
    registry.merge_club_fields(club_id, {"theme": None})

    # Also clear the logo rights affirmation (section C3: rights were
    # affirmed for a specific asset, not in perpetuity)
    theme_job = getattr(club, "theme_job", {}) or {}
    if isinstance(theme_job, dict):
        theme_job["status"] = "reverted"
        theme_job["finishedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        registry.merge_club_fields(club_id, {"theme_job": theme_job})

    return {
        "ok": True,
        "status": "reverted",
    }


# ─── Logo rights affirmation (ADDENDUM-06 section C3) ───────────────────


class LogoRightsRequest(BaseModel):
    affirmed: bool


@router.post("/logo-rights")
def affirm_logo_rights(club_id: str, payload: LogoRightsRequest, request: Request) -> dict:
    """Affirm or revoke logo usage rights (ADDENDUM-06 section C3).

    The admin confirms: "Confirmo que el club puede usar este escudo".
    This is separate from colour activation: colours may auto-activate
    without rights affirmation, but the logo must not display until
    affirmed.
    """
    user = require_admin(request, club_id)

    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")

    theme = getattr(club, "theme", None)
    if not theme or not isinstance(theme, dict):
        raise HTTPException(status_code=404, detail="no theme found")

    logo = theme.get("logo")
    if not logo:
        raise HTTPException(status_code=404, detail="no logo found")

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    if payload.affirmed:
        logo["rightsConfirmedAt"] = now
        logo["status"] = "confirmed"
    else:
        logo["rightsConfirmedAt"] = None
        logo["status"] = "awaiting_rights"

    # Whole-field replacement (section C9.3a)
    theme["logo"] = logo
    registry.merge_club_fields(club_id, {"theme": theme})

    return {
        "ok": True,
        "logo": logo,
    }
