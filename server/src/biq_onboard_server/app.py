"""biq-onboard FastAPI application.

Admin service for club/user/role/team/season management.
All endpoints under ``/api/admin/*`` require an authenticated session
with the ``administrator`` role.
"""

from __future__ import annotations

import os

from fastapi import FastAPI
from starlette.middleware.sessions import SessionMiddleware

from . import auth
from .routers import clubs, onboarding, roles, season, teams, users


def create_app() -> FastAPI:
    app = FastAPI(
        title="biq-onboard",
        description="BasketIQ Club Onboarding & Org Management service.",
        version="0.1.0",
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

    # Admin routes
    app.include_router(clubs.router, prefix="/api/admin", tags=["admin-clubs"])
    app.include_router(teams.router, prefix="/api/admin", tags=["admin-teams"])
    app.include_router(users.router, prefix="/api/admin", tags=["admin-users"])
    app.include_router(roles.router, prefix="/api/admin", tags=["admin-roles"])
    app.include_router(onboarding.router, prefix="/api/admin", tags=["admin-onboarding"])
    app.include_router(season.router, prefix="/api/admin", tags=["admin-season"])

    return app


app = create_app()
