"""Identity queue admission; provider calls have separate worker receipts."""
import hashlib
import json
import logging
import os
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from fastapi import HTTPException

_LOG = logging.getLogger(__name__)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class IdentitySmart:
    def __init__(self):
        self.fake = (os.environ.get("CI", "").lower() == "true"
                     or os.environ.get("BIQ_ENV", "local") not in {"staging", "prod", "production"})
        self.base = os.environ.get("BIQ_APP_BASE_URL", os.environ.get("BIQ_APP_URL", "")).rstrip("/")
        self.token = os.environ.get("BIQ_APP_INTERNAL_TOKEN", os.environ.get("BIQ_INTERNAL_TOKEN", ""))
        url = urlsplit(self.base)
        if not self.fake and (url.scheme != "https" or not url.hostname or url.username
                              or url.password or url.path or url.query or url.fragment or not self.token):
            raise HTTPException(503, "identity_smart_not_configured")

    def post(self, path, body):
        request = Request(self.base + "/api/ops/ai-consumption/v1/identity/" + path,
                          data=json.dumps(body).encode(), method="POST",
                          headers={"Content-Type": "application/json", "X-Internal-Token": self.token})
        try:
            with build_opener(_NoRedirect()).open(request, timeout=30 if path == "begin" else 8) as response:
                return json.loads(response.read())
        except HTTPError as exc:
            code = "smart_required" if exc.code in {401, 403, 404} else "identity_smart_unavailable"
            raise HTTPException(403 if code == "smart_required" else 503, code) from None
        except (URLError, TimeoutError, ValueError):
            raise HTTPException(503, "identity_smart_unavailable") from None

    def begin(self, club_id, actor_id, lease_id, requested_at, source_url):
        identifier = hashlib.sha256(json.dumps([club_id, lease_id, "request"]).encode()).hexdigest()
        if self.fake:
            return identifier
        body = {"operation_id": identifier,
                "subject": club_id if club_id.startswith("club:") else "club:" + club_id,
                "membership_subject_id": actor_id, "team_id": None, "model": "none",
                "service": "orchestration-identity-request",
                "started_at": datetime.fromisoformat(requested_at.replace("Z", "+00:00")).timestamp(),
                "token_bounds": {"input": 0, "output": 0, "thinking": 0, "cache": 0},
                "request_json": json.dumps({"contract": "smart-operation/1.0",
                    "provider_invoked": False,
                    "source_url_sha256": hashlib.sha256(source_url.encode()).hexdigest()})}
        reply = self.post("begin", body)
        if not isinstance(reply, dict) or reply.get("state") != "started" or reply.get("newly_admitted") is not True:
            raise HTTPException(409, "identity_smart_attempt_unconfirmed")
        return identifier

    def finish(self, identifier, outcome):
        if self.fake:
            return
        usage = {"outcome": outcome, "usage_known": True}
        try:
            self.post(identifier + "/finish", usage)
        except HTTPException:
            # No model runs here; keep this control receipt out of model retries.
            _LOG.warning("Identity queue receipt pending operation=%s", identifier)
