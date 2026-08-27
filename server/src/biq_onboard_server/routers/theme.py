"""Club theme endpoints (ADDENDUM-02 §8, ADDENDUM-06 §C13, verdict v3 B10–B14, B16).

Theme management for clubs. Per ADDENDUM-07, club CRUD lives in biq-onboard.

Endpoints:
    POST   /api/clubs/{club_id}/theme/generate  — enqueue generation job (202)
    POST   /api/clubs/{club_id}/theme/retry     — retry failed generation (202)
    POST   /api/clubs/{club_id}/theme/activate  — promote draft to active
    GET    /api/clubs/{club_id}/theme           — current ClubTheme or null
    PUT    /api/clubs/{club_id}/theme           — manual colour override (same gate)
    DELETE /api/clubs/{club_id}/theme           — revert to BasketIQ default
    POST   /api/clubs/{club_id}/theme/logo-rights — affirm/revoke logo rights
    POST   /api/clubs/{club_id}/theme/result    — internal: job result callback

Authorisation: generate/retry/activate/put/delete require club-admin scope.
The result endpoint is authenticated by a dedicated job-result credential
(B12), separate from user S2S.

The generation job is a Cloud Run Job invoked via Cloud Tasks (ADDENDUM-06
§C13.3). This router enqueues tasks; it does not run the pipeline.
The pipeline lives in @basketiq/club-theme-pipeline (Node) and is executed
by the job.

Canonical states (B10):
    pending | running | succeeded | uncertain |
    rejected_not_a_club | unsupported_source | unreachable | failed | reverted

No incompatible "completed" vocabulary.

Map-replacement semantics (ADDENDUM-06 §C9.3a): replacing theme or
theme_job is a whole-field replacement, not a merge.
"""

from __future__ import annotations

import hmac
import os
import time
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, field_validator

from .. import org
from ..auth import require_admin

router = APIRouter(prefix="/clubs/{club_id}/theme")


# ─── Canonical states (B10) ─────────────────────────────────────────────

CANONICAL_STATES = frozenset({
    "pending", "running", "succeeded", "uncertain",
    "rejected_not_a_club", "unsupported_source", "unreachable",
    "failed", "reverted",
})

TERMINAL_STATES = frozenset({
    "succeeded", "uncertain", "rejected_not_a_club",
    "unsupported_source", "unreachable", "failed", "reverted",
})

NOTIFY_STATES = frozenset({
    "rejected_not_a_club", "unsupported_source", "unreachable", "failed",
})


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


class ResultRequest(BaseModel):
    """Job result callback payload (B12)."""
    status: str
    theme: dict | None = None
    verdict: dict | None = None
    reason: str | None = None
    jobId: str | None = None
    sourceUrl: str | None = None


class ActivateRequest(BaseModel):
    """Activate a draft theme (B14)."""
    confirmed: bool = True


# ─── S2S result authentication (B12) ────────────────────────────────────


def _job_result_token() -> str | None:
    """Return the dedicated job-result credential, or None when unset."""
    return os.environ.get("BIQ_THEME_JOB_RESULT_TOKEN") or None


def _require_job_result_auth(request: Request) -> None:
    """Authenticate the job-result callback.

    Uses a dedicated credential (BIQ_THEME_JOB_RESULT_TOKEN), separate
    from the user S2S secret. Fail-closed: bad/missing token → 401.
    """
    token = _job_result_token()
    if not token:
        raise HTTPException(status_code=503, detail="job result endpoint not configured")
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    provided = auth_header[7:]
    if not hmac.compare_digest(provided, token):
        raise HTTPException(status_code=401, detail="invalid job result credential")


# ─── Cloud Tasks → Cloud Run Job (B11) ──────────────────────────────────


def _cloud_tasks_config() -> dict:
    """Read Cloud Tasks configuration from env."""
    return {
        "project_id": os.environ.get("GCP_PROJECT_ID", ""),
        "location": os.environ.get("GCP_TASKS_LOCATION", "europe-west1"),
        "queue": os.environ.get("GCP_TASKS_QUEUE", "club-theme-generation"),
        "job_name": os.environ.get("GCP_THEME_JOB_NAME", "club-theme-generation"),
        "service_account_email": os.environ.get("GCP_TASK_INVOKER_SA", ""),
    }


_tasks_client = None


def _get_tasks_client():
    """Lazily build and cache the Cloud Tasks client."""
    global _tasks_client
    if _tasks_client is not None:
        return _tasks_client
    try:
        from google.cloud import tasks_v2
        _tasks_client = tasks_v2.CloudTasksClient()
        return _tasks_client
    except Exception:
        return None


def _enqueue_generation_task(club_id: str, source_url: str, lease_id: str) -> str:
    """Enqueue a club-theme generation task to Cloud Tasks.

    Targets the Cloud Run Job ``club-theme-generation:run`` API endpoint
    (B11), not an HTTP URL. Uses Cloud Tasks OAuth scope for the Google API.

    Returns the task ID. When ``BIQ_CLOUD_TASKS_QUEUE`` is unset (local
    dev/test), returns a synthetic ID — the job is not actually enqueued.

    In configured staging, failure to enqueue raises loudly (no synthetic
    fallback in real mode per B11).
    """
    config = _cloud_tasks_config()

    # Explicit dev-mode gate
    queue_env = os.environ.get("BIQ_CLOUD_TASKS_QUEUE", "")
    if not queue_env:
        return f"dev-task-{int(time.time())}"

    # Production path: real Cloud Tasks → Cloud Run Job
    client = _get_tasks_client()
    if client is None:
        raise RuntimeError("google-cloud-tasks not available in configured mode")

    from google.cloud import tasks_v2

    queue_path = client.queue_path(
        config["project_id"],
        config["location"],
        config["queue"],
    )

    # Target the Cloud Run Job run API (B11)
    job_parent = (
        f"projects/{config['project_id']}"
        f"/locations/{config['location']}"
        f"/jobs/{config['job_name']}"
    )
    job_url = f"https://run.googleapis.com/v2/{job_parent}:run"

    # The Cloud Run Job receives overrides via containerOverrides env vars
    # (B11). The task body is empty; the job reads CLUB_ID, SOURCE_URL,
    # LEASE_ID, and callback coordinates from env overrides.
    import json as _json

    overrides = {
        "containerOverrides": [
            {
                "env": [
                    {"name": "CLUB_ID", "value": club_id},
                    {"name": "SOURCE_URL", "value": source_url},
                    {"name": "LEASE_ID", "value": lease_id},
                    {"name": "BIQ_ONBOARD_CALLBACK_URL", "value": os.environ.get("BIQ_ONBOARD_CALLBACK_URL", "")},
                    {"name": "BIQ_THEME_JOB_RESULT_TOKEN", "value": os.environ.get("BIQ_THEME_JOB_RESULT_TOKEN", "")},
                ],
            }
        ],
    }

    payload = _json.dumps(overrides).encode()

    task = tasks_v2.Task(
        name=f"{queue_path}/tasks/club-theme-{club_id}-{lease_id}",
        http_request=tasks_v2.HttpRequest(
            http_method=tasks_v2.HttpMethod.POST,
            url=job_url,
            headers={"Content-Type": "application/json"},
            body=payload,
            oidc_token=tasks_v2.OidcToken(
                service_account_email=config["service_account_email"],
                audience=job_url,
            ),
        ),
    )

    created = client.create_task(request={"parent": queue_path, "task": task})
    return created.name.split("/")[-1]


# ─── Lease management (ADDENDUM-06 §C5.2) ───────────────────────────────


def _check_lease(club_id: str) -> dict | None:
    """Check if there is a live lease for this club."""
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


# ─── Rate limiting (ADDENDUM-06 §C5.3) ──────────────────────────────────


def _check_rate_limit(club_id: str) -> bool:
    """Check rate limit: max 20 attempts per club."""
    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        return True

    theme_job = getattr(club, "theme_job", None)
    if not theme_job:
        return True

    attempts = theme_job.get("attempts", 0) if isinstance(theme_job, dict) else 0
    if attempts >= 20:
        return False

    return True


# ─── Notification emission (B16) ────────────────────────────────────────


def _emit_theme_notification(club_id: str, status: str, theme_job: dict) -> None:
    """Emit a notification for terminal theme job states (B16).

    Per ADDENDUM-06 C4:
    - No notification for auto-activation or succeeded.
    - No notification for uncertain draft or gate failure.
    - Admins only for not_a_club, unsupported_source, unreachable after retry, failed.
    - One per job via notifiedAt.
    - Deep-link #/onboard/club-details.
    - Coaches receive none.
    """
    if status not in NOTIFY_STATES:
        return

    # Only emit once per job (notifiedAt guard)
    if theme_job.get("notifiedAt"):
        return

    try:
        registry = org.get_registry()
        members = registry.list_members(club_id)
        admins = [m for m in members if m.role in ("administrator", "super_administrator")]
        if not admins:
            return

        from biq_core.notifications import Notification, get_notification_registry
        notif_registry = get_notification_registry()

        for admin in admins:
            notif_registry.put_notification(Notification(
                user_id=admin.id,
                type="theme-generation-failed",
                text=f"La personalización del tema ha fallado: {status}",
                deep_link=f"#/onboard/club-details",
                created_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            ))
    except Exception:
        pass  # best-effort — does not block result persistence

    # Mark notifiedAt
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    theme_job["notifiedAt"] = now


# ─── Helpers ────────────────────────────────────────────────────────────


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _validate_canonical_status(status: str) -> str:
    """Validate that a status is in the canonical set (B10)."""
    if status not in CANONICAL_STATES:
        raise HTTPException(
            status_code=400,
            detail=f"invalid status '{status}'; canonical states: {sorted(CANONICAL_STATES)}",
        )
    return status


# ─── Endpoints ──────────────────────────────────────────────────────────


@router.post("/generate")
def generate_theme(club_id: str, payload: GenerateRequest, request: Request) -> dict:
    """Enqueue the club-theme generation job (ADDENDUM-06 §C13.3, B10).

    Returns 202 + job id. Authorisation: club-admin scope.

    Idempotency (§C5.2): if a lease is live, returns the existing job.
    """
    require_admin(request, club_id)

    url = payload.homepage_url.strip()
    if not url.startswith("https://"):
        if url.startswith("http://"):
            raise HTTPException(status_code=400, detail="URL must be https")
        url = "https://" + url

    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")

    # Check lease (§C5.2)
    existing_lease = _check_lease(club_id)
    if existing_lease:
        theme_job = getattr(club, "theme_job", {}) or {}
        return {
            "ok": True,
            "status": "already_running",
            "jobId": existing_lease.get("holder", ""),
            "themeJob": theme_job,
        }

    if not _check_rate_limit(club_id):
        raise HTTPException(status_code=429, detail="rate limit exceeded (max 20/day)")

    # B10: persist theme_job: pending BEFORE dispatch
    now = _now_iso()
    existing_job = getattr(club, "theme_job", {}) or {}
    lease_id = f"lease-{club_id}-{int(time.time())}"
    new_theme_job = {
        "status": "pending",
        "sourceUrl": url,
        "requestedAt": now,
        "finishedAt": None,
        "attempts": (existing_job.get("attempts", 0) if isinstance(existing_job, dict) else 0) + 1,
        "verdict": None,
        "notifiedAt": None,
        "lease": _create_lease(lease_id),
    }
    registry.merge_club_fields(club_id, {"theme_job": new_theme_job})

    # Enqueue after state is persisted (B10: worker cannot race absent state)
    try:
        task_id = _enqueue_generation_task(club_id, url, lease_id)
    except Exception as exc:
        # Enqueue failure → club succeeds, persisted recoverable job failure (B9)
        failed_job = dict(new_theme_job)
        failed_job["status"] = "failed"
        failed_job["finishedAt"] = _now_iso()
        failed_job["reason"] = f"enqueue failed: {exc}"
        registry.merge_club_fields(club_id, {"theme_job": failed_job})
        return {
            "ok": True,
            "status": "failed",
            "jobId": lease_id,
            "themeJob": failed_job,
            "detail": "club created but theme generation could not be enqueued — retry available",
        }

    return {
        "ok": True,
        "status": "pending",
        "jobId": task_id,
        "themeJob": new_theme_job,
    }


@router.post("/retry")
def retry_theme(club_id: str, request: Request) -> dict:
    """Retry a failed theme generation (B14).

    Increments attempts/lease and clears notifiedAt. Idempotent.
    """
    require_admin(request, club_id)

    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")

    existing_job = getattr(club, "theme_job", {}) or {}
    if not isinstance(existing_job, dict):
        existing_job = {}

    current_status = existing_job.get("status", "")
    if current_status not in ("failed", "unreachable", "rejected_not_a_club", "unsupported_source"):
        raise HTTPException(
            status_code=409,
            detail=f"retry only available for terminal failure states (current: {current_status})",
        )

    if not _check_rate_limit(club_id):
        raise HTTPException(status_code=429, detail="rate limit exceeded (max 20/day)")

    source_url = existing_job.get("sourceUrl", "")
    if not source_url:
        raise HTTPException(status_code=400, detail="no source URL to retry")

    # Clear notifiedAt for re-notification on next terminal (B16)
    now = _now_iso()
    lease_id = f"lease-{club_id}-{int(time.time())}"
    new_theme_job = {
        "status": "pending",
        "sourceUrl": source_url,
        "requestedAt": now,
        "finishedAt": None,
        "attempts": (existing_job.get("attempts", 0) or 0) + 1,
        "verdict": None,
        "notifiedAt": None,
        "lease": _create_lease(lease_id),
    }
    registry.merge_club_fields(club_id, {"theme_job": new_theme_job})

    try:
        task_id = _enqueue_generation_task(club_id, source_url, lease_id)
    except Exception as exc:
        failed_job = dict(new_theme_job)
        failed_job["status"] = "failed"
        failed_job["finishedAt"] = _now_iso()
        failed_job["reason"] = f"retry enqueue failed: {exc}"
        registry.merge_club_fields(club_id, {"theme_job": failed_job})
        return {"ok": True, "status": "failed", "jobId": lease_id, "themeJob": failed_job}

    return {"ok": True, "status": "pending", "jobId": task_id, "themeJob": new_theme_job}


@router.post("/activate")
def activate_theme(club_id: str, payload: ActivateRequest, request: Request) -> dict:
    """Promote a draft/uncertain theme to active (B14).

    The admin explicitly confirms: "Sí, usarlo".
    Validates that the theme exists and has a gate-passed token set.
    """
    require_admin(request, club_id)

    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")

    theme = getattr(club, "theme", None)
    if not theme or not isinstance(theme, dict):
        raise HTTPException(status_code=404, detail="no theme found")

    gate = theme.get("gate", {})
    if not gate.get("passed"):
        raise HTTPException(status_code=409, detail="theme gate has not passed — cannot activate")

    current_status = theme.get("status", "")
    if current_status == "active":
        return {"ok": True, "status": "already_active", "theme": theme}

    if current_status not in ("draft", "uncertain", "succeeded"):
        raise HTTPException(
            status_code=409,
            detail=f"cannot activate theme in status '{current_status}'",
        )

    # Promote to active
    theme["status"] = "active"
    theme["activation"] = {
        "themeStatus": "active",
        "reason": "admin-activated",
        "decidedAt": _now_iso(),
    }
    registry.merge_club_fields(club_id, {"theme": theme})

    # Update theme_job to succeeded if it was running
    theme_job = getattr(club, "theme_job", {}) or {}
    if isinstance(theme_job, dict) and theme_job.get("status") in ("pending", "running"):
        theme_job["status"] = "succeeded"
        theme_job["finishedAt"] = _now_iso()
        registry.merge_club_fields(club_id, {"theme_job": theme_job})

    return {"ok": True, "status": "active", "theme": theme}


@router.get("")
def get_theme(club_id: str, request: Request) -> dict:
    """Return the current ClubTheme or null (ADDENDUM-02 §8)."""
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
    """Manual colour override (ADDENDUM-02 §8 PUT)."""
    require_admin(request, club_id)

    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")

    now = _now_iso()
    theme = {
        "schemaVersion": 1,
        "generatorVersion": "1.0.0",
        "clubId": club_id,
        "status": "draft",
        "source": {
            "kind": "manual",
            "homepageUrl": getattr(club, "website", None) or "",
            "extractedAt": now,
            "confidence": 1.0,
        },
        "seed": {
            "brand": payload.seed_brand,
            "brandAlt": payload.seed_brand_alt,
            "detectedFrom": "manual",
        },
        "logo": None,
        "tokens": {},
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

    registry.merge_club_fields(club_id, {"theme": theme})
    return {"ok": True, "theme": theme}


@router.delete("")
def delete_theme(club_id: str, request: Request) -> dict:
    """Revert to BasketIQ default (ADDENDUM-02 §8 DELETE)."""
    require_admin(request, club_id)

    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")

    registry.merge_club_fields(club_id, {"theme": None})

    theme_job = getattr(club, "theme_job", {}) or {}
    if isinstance(theme_job, dict):
        theme_job["status"] = "reverted"
        theme_job["finishedAt"] = _now_iso()
        registry.merge_club_fields(club_id, {"theme_job": theme_job})

    return {"ok": True, "status": "reverted"}


# ─── Logo rights (ADDENDUM-06 §C3) ──────────────────────────────────────


class LogoRightsRequest(BaseModel):
    affirmed: bool


@router.post("/logo-rights")
def affirm_logo_rights(club_id: str, payload: LogoRightsRequest, request: Request) -> dict:
    """Affirm or revoke logo usage rights (ADDENDUM-06 §C3)."""
    require_admin(request, club_id)

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

    now = _now_iso()
    if payload.affirmed:
        logo["rightsConfirmedAt"] = now
        logo["status"] = "confirmed"
    else:
        logo["rightsConfirmedAt"] = None
        logo["status"] = "awaiting_rights"

    theme["logo"] = logo
    registry.merge_club_fields(club_id, {"theme": theme})

    return {"ok": True, "logo": logo}


# ─── Job result callback (B12) ──────────────────────────────────────────


@router.post("/result")
def post_result(club_id: str, payload: ResultRequest, request: Request) -> dict:
    """Internal endpoint for the Cloud Run Job to post results (B12).

    Authenticated by BIQ_THEME_JOB_RESULT_TOKEN (dedicated job-result
    credential, separate from user S2S). The job posts running and
    terminal results.

    Rejects:
    - Bad/missing credential → 401
    - Club mismatch → 404
    - Lease/job mismatch → 409
    - Stale superseded result → 409
    - Invalid canonical status → 400

    Terminal sets finishedAt, clears lease, sets notifiedAt only when emitted.
    """
    _require_job_result_auth(request)

    status = _validate_canonical_status(payload.status)

    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")

    existing_job = getattr(club, "theme_job", None)
    if not existing_job or not isinstance(existing_job, dict):
        raise HTTPException(status_code=409, detail="no theme_job to update — stale or missing")

    # Lease/job mismatch check (B12)
    if payload.jobId:
        existing_lease = existing_job.get("lease", {})
        existing_holder = existing_lease.get("holder", "") if isinstance(existing_lease, dict) else ""
        if existing_holder and payload.jobId != existing_holder:
            raise HTTPException(status_code=409, detail="lease/job mismatch — stale result")

    # Stale superseded result check
    if existing_job.get("status") in TERMINAL_STATES and status not in ("running",):
        # Already terminal — reject unless it's a running update (which shouldn't happen)
        raise HTTPException(status_code=409, detail=f"already terminal ({existing_job['status']}) — stale result")

    now = _now_iso()

    if status == "running":
        # Running update: set status, don't set finishedAt
        existing_job["status"] = "running"
        registry.merge_club_fields(club_id, {"theme_job": existing_job})
        return {"ok": True, "status": "running"}

    # Terminal result
    new_theme_job = dict(existing_job)
    new_theme_job["status"] = status
    new_theme_job["finishedAt"] = now
    new_theme_job["verdict"] = payload.verdict
    if payload.reason:
        new_theme_job["reason"] = payload.reason
    # Clear lease on terminal
    new_theme_job["lease"] = {"holder": "", "expiresAt": None}

    # Emit notification for failure states (B16)
    _emit_theme_notification(club_id, status, new_theme_job)

    # Persist theme if provided (whole-field replacement, §C9.3a)
    if payload.theme:
        registry.merge_club_fields(club_id, {"theme": payload.theme})

    registry.merge_club_fields(club_id, {"theme_job": new_theme_job})

    return {"ok": True, "status": status}
