"""BasketIQ Club Onboarding & Org Management service."""

__version__ = "0.1.0"

# Bootstrap before application imports can construct HTTP/database clients.
import os as _os

if _os.environ.get("BIQ_OBSERVABILITY_ENABLED") == "1" or (
    _os.environ.get("BIQ_OBSERVABILITY_ENABLED") != "0"
    and _os.environ.get("K_SERVICE", "").endswith("-staging")
):
    from biq_observability.runtime import configure_runtime as _configure_runtime

    _configure_runtime()
