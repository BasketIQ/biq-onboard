"""biq-onboard FastAPI application.

Admin service for club/user/role/team/season management.
All endpoints under ``/api/admin/*`` require an authenticated session
with the ``administrator`` role.

Serves the built front-end under / (index.html) and the embeddable library
under /embed/biq-onboard.js, plus a Cloud Run health check at /health.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.middleware.sessions import SessionMiddleware

from . import auth
from .routers import clubs, onboarding, onboarding_flow, roles, season, teams, theme, users


def create_app() -> FastAPI:
    app = FastAPI(
        title="biq-onboard",
        description="BasketIQ Club Onboarding & Org Management service.",
        version="0.1.0",
    )

    _origin = os.environ.get("BIQ_ONBOARD_EMBED_ALLOW_ORIGIN", "*")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[_origin],
        allow_credentials=_origin != "*",
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.add_middleware(
        SessionMiddleware,
        secret_key=os.environ.get("BIQ_ONBOARD_SESSION_SECRET", "dev-insecure-secret-change-me"),
        https_only=os.environ.get("BIQ_ONBOARD_HTTPS_ONLY", "1") == "1",
    )

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "service": "biq-onboard", "version": "0.1.0"}

    # Auth routes (login/logout/me)
    app.include_router(auth.router, prefix="/api/auth", tags=["auth"])

    # Self-service onboarding (ADDENDUM-07 §6 — the club step)
    app.include_router(onboarding_flow.router, prefix="/api/onboarding", tags=["onboarding-flow"])

    # Admin routes
    app.include_router(clubs.router, prefix="/api/admin", tags=["admin-clubs"])
    app.include_router(teams.router, prefix="/api/admin", tags=["admin-teams"])
    app.include_router(users.router, prefix="/api/admin", tags=["admin-users"])
    app.include_router(roles.router, prefix="/api/admin", tags=["admin-roles"])
    app.include_router(onboarding.router, prefix="/api/admin", tags=["admin-onboarding"])
    app.include_router(season.router, prefix="/api/admin", tags=["admin-season"])
    app.include_router(theme.router, prefix="/api/admin", tags=["admin-theme"])

    # Static file serving — front-end app and embeddable library.
    # API routes are registered above; the catch-all below serves
    # built Vite assets (index.html, embed/biq-onboard.js, etc.).
    static_dir = Path(os.environ.get("STATIC_DIR", "/srv/static"))

    @app.get("/{full_path:path}")
    def serve_static(full_path: str = "") -> FileResponse:
        file = (static_dir / full_path).resolve()
        if file.is_relative_to(static_dir) and file.is_file():
            return FileResponse(file)
        return FileResponse(static_dir / "index.html")

    return app


app = create_app()
