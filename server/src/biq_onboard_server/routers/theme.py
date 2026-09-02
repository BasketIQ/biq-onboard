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
from ..auth import require_admin, session_user, _is_break_glass_admin
from ..routers.onboarding_flow import _resolve_acting_identity

router = APIRouter(prefix="/clubs/{club_id}/theme")


# ─── S2S-aware admin authorization (C2) ─────────────────────────────────


def _s2s_secret() -> str | None:
    """Return the configured S2S secret, or None when S2S is disabled."""
    return os.environ.get("BIQ_ONBOARD_S2S_SECRET") or None


def _require_theme_member(request: Request, club_id: str) -> str:
    """Authorize a read for any active member of the requested club."""
    secret = _s2s_secret()
    if secret:
        user_id, _email = _resolve_acting_identity(request)
    else:
        user_id = session_user(request)
    if _is_break_glass_admin(user_id):
        return user_id
    user = org.get_registry().get_user(user_id)
    if user is None or user.club_id != club_id or getattr(user, "status", "active") != "active":
        raise HTTPException(status_code=403, detail=f"club membership required for club {club_id}")
    return user_id


def _require_theme_admin(request: Request, club_id: str) -> str:
    """Authorize a theme mutation, resolving identity from S2S or session.

    C2: When a valid S2S bearer token is present, identity comes from the
    asserted headers (X-BIQ-Acting-User-Id / X-BIQ-Acting-Email). The
    resolved user must have club-admin scope for the requested club.

    When no S2S secret is configured, falls back to local-session
    require_admin() (standalone mode).

    Returns the acting user_id.
    """
    secret = _s2s_secret()
    if secret:
        # S2S mode: resolve identity from headers (fail-closed on bad token)
        user_id, _email = _resolve_acting_identity(request)
        # Break-glass admin has full access
        if _is_break_glass_admin(user_id):
            return user_id
        # Check club-admin scope via roles registry
        from biq_core.roles import effective_capabilities
        caps = effective_capabilities(user_id, f"club:{club_id}", org.get_roles())
        if "club.admin" not in caps and "roles.manage" not in caps:
            raise HTTPException(
                status_code=403,
                detail=f"administrator role required for club {club_id}",
            )
        return user_id

    # Standalone mode — local session
    return require_admin(request, club_id)


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

# C13: Frozen notification policy — only not_a_club, unsupported_source,
# and unreachable (after retry). NO notification for success, uncertain,
# gate failure, or generic technical failure (failed).
NOTIFY_STATES = frozenset({
    "rejected_not_a_club", "unsupported_source", "unreachable",
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
    """Job result callback payload (B12).

    C9: jobId and sourceUrl are required (not optional). Omitting job ID
    must not bypass lease matching. Source URL must be enforced.
    """
    status: str
    theme: dict | None = None
    verdict: dict | None = None
    reason: str | None = None
    jobId: str  # C9: required, not optional
    sourceUrl: str  # C9: required, not optional


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


def _enqueue_generation_task(
    club_id: str, source_url: str, lease_id: str,
    schedule_delay_seconds: int = 0,
    manual_seed_brand: str = "",
    manual_seed_alt: str = "",
) -> str:
    """Enqueue a club-theme generation task to Cloud Tasks.

    Targets the Cloud Run Job ``club-theme-generation:run`` API endpoint
    (B11), not an HTTP URL. Uses Cloud Tasks OAuth scope for the Google API.

    R5: When ``schedule_delay_seconds`` > 0, the task is scheduled for
    future execution via Cloud Tasks ``schedule_time``. This provides
    durable delayed retry without in-process threads.

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
    # (B11). C4: Task overrides carry ONLY per-execution non-secret
    # coordinates (club/source/job/lease). The deployed job already owns
    # the result token and callback URL from its own deployment config —
    # do NOT pass BIQ_THEME_JOB_RESULT_TOKEN as a plain env override.
    import json as _json

    env_vars = [
        {"name": "CLUB_ID", "value": club_id},
        {"name": "SOURCE_URL", "value": source_url},
        {"name": "LEASE_ID", "value": lease_id},
    ]
    # V4: Manual seed overrides — when set, the JS worker skips website
    # extraction and uses these seeds directly for ramp/gate generation.
    if manual_seed_brand:
        env_vars.append({"name": "MANUAL_SEED_BRAND", "value": manual_seed_brand})
    if manual_seed_alt:
        env_vars.append({"name": "MANUAL_SEED_BRAND_ALT", "value": manual_seed_alt})

    # The Cloud Run Admin API v2 RunJobRequest only recognizes
    # {validateOnly, etag, overrides} at the top level — containerOverrides
    # must be nested under "overrides" (see RunJobRequest.Overrides in
    # google/cloud/run/v2/job.proto). A top-level "containerOverrides" key
    # is an unrecognized field and the API rejects it with INVALID_ARGUMENT,
    # which Cloud Tasks then retries and exhausts silently (root cause of
    # the 2026-09-02 stuck-at-"pending" regression — see handoff).
    run_job_request = {
        "overrides": {
            "containerOverrides": [
                {
                    "env": env_vars,
                }
            ],
        },
    }

    payload = _json.dumps(run_job_request).encode()

    # C4: Use OAuthToken (not OidcToken) for the run.googleapis.com API.
    # The Cloud Run Jobs :run endpoint is a Google API requiring OAuth
    # authentication with the cloud-platform scope.
    task_kwargs = dict(
        name=f"{queue_path}/tasks/club-theme-{club_id}-{lease_id}",
        http_request=tasks_v2.HttpRequest(
            http_method=tasks_v2.HttpMethod.POST,
            url=job_url,
            headers={"Content-Type": "application/json"},
            body=payload,
            oauth_token=tasks_v2.OAuthToken(
                service_account_email=config["service_account_email"],
                scope="https://www.googleapis.com/auth/cloud-platform",
            ),
        ),
    )

    # R5: Durable delayed scheduling via Cloud Tasks schedule_time
    if schedule_delay_seconds > 0:
        from datetime import datetime, timedelta, timezone
        task_kwargs["schedule_time"] = datetime.now(timezone.utc) + timedelta(
            seconds=schedule_delay_seconds
        )

    task = tasks_v2.Task(**task_kwargs)

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


# ─── Rate limiting (ADDENDUM-06 §C5.3, C16) ─────────────────────────────


def _normalize_url(url: str) -> str:
    """Normalize a URL for rate-limit keying (C16).

    Strips trailing slashes, lowercases the host, and removes fragments.
    """
    from urllib.parse import urlparse, urlunparse

    try:
        parsed = urlparse(url)
        # Normalize: lowercase host, strip trailing slash from path, drop fragment
        path = parsed.path.rstrip("/") or ""
        return urlunparse((
            parsed.scheme.lower(),
            parsed.netloc.lower(),
            path,
            parsed.params,
            parsed.query,
            "",  # drop fragment
        ))
    except Exception:
        return url


def _check_rate_limit(club_id: str, source_url: str | None = None) -> bool:
    """Check rate limit per club + normalized URL (C16).

    Frozen policy: 5 requests/hour and 20 requests/day per club + normalized URL.
    The previous code was a lifetime attempts >= 20 check, which is incorrect.
    """
    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        return True

    theme_job = getattr(club, "theme_job", None)
    if not theme_job or not isinstance(theme_job, dict):
        return True

    now = datetime.now(timezone.utc)
    history = theme_job.get("history", [])
    if not isinstance(history, list):
        history = []

    norm_url = _normalize_url(source_url) if source_url else None

    # Filter history to this club+URL within time windows
    hour_cutoff = now.timestamp() - 3600
    day_cutoff = now.timestamp() - 86400

    hour_count = 0
    day_count = 0
    for entry in history:
        if not isinstance(entry, dict):
            continue
        entry_url = entry.get("sourceUrl", "")
        entry_norm = _normalize_url(entry_url) if entry_url else None
        if norm_url and entry_norm != norm_url:
            continue
        ts_str = entry.get("requestedAt", "")
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp()
        except (ValueError, AttributeError):
            continue
        if ts > hour_cutoff:
            hour_count += 1
        if ts > day_cutoff:
            day_count += 1

    if hour_count >= 5:
        return False
    if day_count >= 20:
        return False
    return True


def _record_attempt(theme_job: dict, source_url: str) -> dict:
    """Record an attempt in the theme_job history for rate limiting (C16)."""
    if not isinstance(theme_job, dict):
        theme_job = {}
    history = theme_job.get("history", [])
    if not isinstance(history, list):
        history = []
    history.append({
        "sourceUrl": source_url,
        "requestedAt": _now_iso(),
    })
    # Keep last 50 entries to avoid unbounded growth
    theme_job["history"] = history[-50:]
    return theme_job


# ─── Notification emission (B16) ────────────────────────────────────────


def _emit_theme_notification(club_id: str, status: str, theme_job: dict) -> bool:
    """Emit a notification for terminal theme job states (B16/C13).

    Per ADDENDUM-06 C4 (frozen policy):
    - No notification for auto-activation or succeeded.
    - No notification for uncertain draft or gate failure.
    - No notification for generic technical failure (failed).
    - Admins only for not_a_club, unsupported_source, unreachable after retry.
    - One per job via notifiedAt.
    - Deep-link #/onboard/club-details.
    - Coaches receive none.

    C13: Returns True only if notification was successfully persisted.
    notifiedAt is set by the caller ONLY when this returns True.
    """
    if status not in NOTIFY_STATES:
        return False

    # Only emit once per job (notifiedAt guard)
    if theme_job.get("notifiedAt"):
        return False

    try:
        registry = org.get_registry()
        members = registry.list_members(club_id)
        # C13: Admins and sports_director only — coaches receive none
        admins = [m for m in members if m.role in ("administrator", "super_administrator", "sports_director")]
        if not admins:
            return False

        from biq_core.notifications import Notification, get_notification_registry
        notif_registry = get_notification_registry()

        for admin in admins:
            notif_registry.put_notification(Notification(
                user_id=admin.id,
                type="theme-generation-failed",
                text=f"La personalización del tema ha fallado: {status}",
                deep_link="#/onboard/club-details",
                created_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            ))
        # C13: Only set notifiedAt after successful persistence
        return True
    except Exception:
        # C13: Do NOT set notifiedAt when persistence failed
        return False


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


@router.post("/generate", status_code=202)
def generate_theme(club_id: str, payload: GenerateRequest, request: Request) -> dict:
    """Enqueue the club-theme generation job (ADDENDUM-06 §C13.3, B10).

    Returns 202 + job id. Authorisation: club-admin scope.

    Idempotency (§C5.2): if a lease is live, returns the existing job.
    """
    _require_theme_admin(request, club_id)

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

    if not _check_rate_limit(club_id, url):
        raise HTTPException(status_code=429, detail="rate limit exceeded (5/hour, 20/day per club+URL)")

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
        # R7: Preserve prior per-URL history across whole-field replacement
        "history": list(existing_job.get("history", [])) if isinstance(existing_job, dict) else [],
    }
    # C16: Record attempt in history for rate limiting
    _record_attempt(new_theme_job, url)
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
        raise HTTPException(
            status_code=503,
            detail="theme generation could not be enqueued; retry available",
        )

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
    _require_theme_admin(request, club_id)

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

    source_url = existing_job.get("sourceUrl", "")
    if not source_url:
        raise HTTPException(status_code=400, detail="no source URL to retry")

    if not _check_rate_limit(club_id, source_url):
        raise HTTPException(status_code=429, detail="rate limit exceeded (5/hour, 20/day per club+URL)")

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
        # R7: Preserve prior per-URL history across whole-field replacement
        "history": list(existing_job.get("history", [])),
    }
    # C16: Record attempt in history for rate limiting
    _record_attempt(new_theme_job, source_url)
    registry.merge_club_fields(club_id, {"theme_job": new_theme_job})

    try:
        task_id = _enqueue_generation_task(club_id, source_url, lease_id)
    except Exception as exc:
        failed_job = dict(new_theme_job)
        failed_job["status"] = "failed"
        failed_job["finishedAt"] = _now_iso()
        failed_job["reason"] = f"retry enqueue failed: {exc}"
        registry.merge_club_fields(club_id, {"theme_job": failed_job})
        raise HTTPException(status_code=503, detail="theme retry could not be enqueued")

    return {"ok": True, "status": "pending", "jobId": task_id, "themeJob": new_theme_job}


@router.post("/activate")
def activate_theme(club_id: str, payload: ActivateRequest, request: Request) -> dict:
    """Promote a draft/uncertain theme to active (B14).

    The admin explicitly confirms: "Sí, usarlo".
    Validates that the theme exists and has a gate-passed token set.
    """
    _require_theme_admin(request, club_id)

    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")

    theme = getattr(club, "theme", None)
    if not theme or not isinstance(theme, dict):
        raise HTTPException(status_code=404, detail="no theme found")

    # R10: Revalidate the gate at activation time. Do not trust stale
    # gate.passed — check the full contract: gate must be non-pending,
    # passed, and tokens must be present and non-empty for both modes.
    gate = theme.get("gate", {})
    tokens = theme.get("tokens", {})

    # R4/R10: tokens=None means the job hasn't processed yet (manual seed)
    if tokens is None or (isinstance(tokens, dict) and not tokens):
        raise HTTPException(
            status_code=409,
            detail="theme tokens are pending generation — cannot activate until the job completes",
        )

    has_tokens = isinstance(tokens, dict) and bool(tokens.get("light")) and bool(tokens.get("dark"))
    gate_pending = gate.get("pending", False) if isinstance(gate, dict) else True
    gate_passed = gate.get("passed", False) if isinstance(gate, dict) else False

    if gate_pending:
        raise HTTPException(
            status_code=409,
            detail="theme gate is pending validation — cannot activate until the job completes",
        )
    if not gate_passed or not has_tokens:
        raise HTTPException(
            status_code=409,
            detail="theme gate has not passed or tokens are missing — cannot activate",
        )

    # R10: Validate token structure — each mode must have the required keys
    for mode in ("light", "dark"):
        mode_tokens = tokens.get(mode, {})
        if not isinstance(mode_tokens, dict) or not mode_tokens:
            raise HTTPException(
                status_code=409,
                detail=f"theme tokens for '{mode}' mode are missing or empty — cannot activate",
            )

    # V5: Gate-bound activation — verify a deterministic hash of the token
    # payload matches the hash stored at gate time. If tokens were modified
    # after gate output, the hash won't match and activation is rejected.
    #
    # F6: Use compact separators (no spaces) to match the JS-side
    # JSON.stringify canonical form. The previous code used default
    # json.dumps which adds spaces, causing a cross-language mismatch.
    import hashlib
    import json as _json_hash
    stored_hash = gate.get("payloadHash") if isinstance(gate, dict) else None
    current_payload = {"light": tokens.get("light"), "dark": tokens.get("dark")}
    current_hash = hashlib.sha256(
        _json_hash.dumps(current_payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()[:16]
    if stored_hash and current_hash != stored_hash:
        raise HTTPException(
            status_code=409,
            detail="theme token payload hash mismatch — tokens modified after gate validation",
        )

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
    """Return the current ClubTheme or null (ADDENDUM-02 §8).

    V18: member-readable; mutations remain admin/capability gated.
    """
    _require_theme_member(request, club_id)

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
    """Manual colour override (ADDENDUM-02 §8 PUT).

    R4: The canonical theme engine is JavaScript (in the Cloud Run Job).
    This endpoint stores the manual seed as a draft theme with a pending
    gate status. The actual token generation and gate validation happen
    through the same generation job pipeline — the manual seed is passed
    as an override to the job, which runs the real JS engine and posts
    the result back through the callback.

    No Python-side gate/token logic is duplicated. No empty-token fallback.
    """
    _require_theme_admin(request, club_id)

    registry = org.get_registry()
    club = registry.get_club(club_id)
    if club is None:
        raise HTTPException(status_code=404, detail="club not found")

    now = _now_iso()
    seed_brand = payload.seed_brand
    seed_brand_alt = payload.seed_brand_alt

    # R4: Store the manual seed as a draft theme. Tokens and gate are
    # pending — they will be populated by the generation job when it
    # processes the manual seed. No empty-token fallback.
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
            "brand": seed_brand,
            "brandAlt": seed_brand_alt,
            "detectedFrom": "manual",
        },
        "logo": None,
        "tokens": None,  # R4: pending job population — no empty fallback
        "gate": {
            "passed": False,
            "checkedAt": now,
            "pairsChecked": 0,
            "failures": [],
            "repairs": [],
            "pending": True,  # R4: gate will be run by the job
        },
        "activation": {
            "themeStatus": "draft",
            "reason": "manual override — gate validation applied",
            "decidedAt": now,
        },
    }

    registry.merge_club_fields(club_id, {"theme": theme})

    # V4: Enqueue the canonical JS generation job with the manual seed.
    # The worker receives MANUAL_SEED_BRAND env override and skips website
    # extraction, using the manual seed directly for ramp/gate generation.
    source_url = getattr(club, "website", None) or ""
    lease_id = f"lease-{club_id}-manual-{int(time.time())}"
    manual_job = {
        "status": "pending",
        "sourceUrl": source_url,
        "requestedAt": now,
        "finishedAt": None,
        "attempts": 1,
        "verdict": None,
        "notifiedAt": None,
        "lease": _create_lease(lease_id),
        "history": [],
        "manualSeed": {  # V4: manual seed contract for the JS worker
            "brand": seed_brand,
            "brandAlt": seed_brand_alt,
        },
    }
    _record_attempt(manual_job, source_url)
    registry.merge_club_fields(club_id, {"theme_job": manual_job})

    # V4: Enqueue with manual seed env overrides
    try:
        task_id = _enqueue_generation_task(
            club_id, source_url, lease_id,
            manual_seed_brand=seed_brand,
            manual_seed_alt=seed_brand_alt,
        )
    except Exception as exc:
        failed_job = dict(manual_job)
        failed_job["status"] = "failed"
        failed_job["finishedAt"] = _now_iso()
        failed_job["reason"] = f"manual enqueue failed: {exc}"
        registry.merge_club_fields(club_id, {"theme_job": failed_job})
        raise HTTPException(status_code=503, detail="manual theme generation could not be enqueued")

    return {"ok": True, "theme": theme, "themeJob": manual_job, "jobId": task_id}


@router.delete("")
def delete_theme(club_id: str, request: Request) -> dict:
    """Revert to BasketIQ default (ADDENDUM-02 §8 DELETE)."""
    _require_theme_admin(request, club_id)

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
    _require_theme_admin(request, club_id)

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

    # C9: Lease/job mismatch check — jobId is now required, always validate
    existing_lease = existing_job.get("lease", {})
    existing_holder = existing_lease.get("holder", "") if isinstance(existing_lease, dict) else ""
    if existing_holder and payload.jobId != existing_holder:
        raise HTTPException(status_code=409, detail="lease/job mismatch — stale result")

    # C9: Source URL must match the current intent
    existing_source = existing_job.get("sourceUrl", "")
    if existing_source and payload.sourceUrl != existing_source:
        raise HTTPException(status_code=409, detail="source URL mismatch — stale result")

    current_status = existing_job.get("status", "")

    # C9: Enforce legal state transitions
    # Legal: pending→running, running→terminal, pending→terminal (if running post failed)
    # Illegal: terminal→running (regression), terminal→terminal (stale, unless same-status idempotent)
    if current_status in TERMINAL_STATES:
        if status == "running":
            # C9: Reject terminal→running regression
            raise HTTPException(
                status_code=409,
                detail=f"cannot regress from terminal '{current_status}' to 'running'",
            )
        if status != current_status:
            # C9: Reject stale superseded terminal results
            raise HTTPException(
                status_code=409,
                detail=f"already terminal ({current_status}) — stale superseded result",
            )
        # Same-terminal idempotent re-post: accept silently
        return {"ok": True, "status": current_status, "idempotent": True}

    now = _now_iso()

    if status == "running":
        # C9: Only pending→running is legal
        if current_status not in ("pending", "running"):
            raise HTTPException(
                status_code=409,
                detail=f"cannot transition from '{current_status}' to 'running'",
            )
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

    # Emit notification for failure states (B16/C13)
    # C13: notifiedAt is set only when notification persistence succeeded
    # R6: Notification timing — notify only after the retry outcome.
    # For unreachable: if this is the first unreachable (no autoRetried yet),
    # schedule a retry WITHOUT notifying. If this is the second unreachable
    # (autoRetried already true), notify now.
    should_notify = True
    if status == "unreachable" and not new_theme_job.get("autoRetried"):
        # First unreachable — schedule retry, do NOT notify yet
        should_notify = False

    if should_notify and _emit_theme_notification(club_id, status, new_theme_job):
        new_theme_job["notifiedAt"] = _now_iso()

    # Persist theme if provided (whole-field replacement, §C9.3a)
    if payload.theme:
        registry.merge_club_fields(club_id, {"theme": payload.theme})

    registry.merge_club_fields(club_id, {"theme_job": new_theme_job})

    # R5: Unreachable auto-retry — durably scheduled through Cloud Tasks
    # with schedule_time (not an in-process daemon thread). Only retry
    # if this is the first unreachable (not autoRetried yet).
    if status == "unreachable" and not new_theme_job.get("autoRetried"):
        new_theme_job["autoRetried"] = True
        registry.merge_club_fields(club_id, {"theme_job": new_theme_job})
        # Schedule a delayed retry via Cloud Tasks schedule_time (60s).
        source = new_theme_job.get("sourceUrl", "")
        if source:
            retry_lease = f"lease-{club_id}-retry-{int(time.time())}"
            new_job = {
                "status": "pending",
                "sourceUrl": source,
                "requestedAt": _now_iso(),
                "finishedAt": None,
                "attempts": new_theme_job.get("attempts", 1) + 1,
                "verdict": None,
                "notifiedAt": None,
                "autoRetried": True,  # R5: persist retry intent
                "lease": _create_lease(retry_lease),
                "history": new_theme_job.get("history", []),  # R7: preserve history
            }
            _record_attempt(new_job, source)
            registry.merge_club_fields(club_id, {"theme_job": new_job})
            # R5: Enqueue with schedule_time for durable retry.
            # In configured mode, Cloud Tasks holds the task for 60s.
            # In dev mode, _enqueue_generation_task returns a synthetic ID
            # and the retry is immediate (acceptable for local dev).
            _enqueue_generation_task(club_id, source, retry_lease, schedule_delay_seconds=60)

    return {"ok": True, "status": status}
