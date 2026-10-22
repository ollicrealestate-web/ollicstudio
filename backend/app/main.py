"""Ollic Design Studio API (Phase 1: foundation)."""

from __future__ import annotations

import json
import logging
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .auth import TokenVerifier
from .config import Settings
from .routes import projects
from .supabase import BackendUnavailable, SupabaseRepository, SupabaseStorage

log = logging.getLogger("ollic")


def create_app(settings: Settings | None = None, *, repo=None, storage=None, verifier=None) -> FastAPI:
    settings = settings or Settings.from_env()
    app = FastAPI(title="Ollic Design Studio API", version="0.1.0")
    app.state.settings = settings
    app.state.verifier = verifier or TokenVerifier(settings)
    app.state.repo = repo or SupabaseRepository(settings)
    app.state.storage = storage or SupabaseStorage(settings)

    if settings.web_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.web_origins),
            allow_methods=["GET", "POST", "PATCH", "DELETE"],
            allow_headers=["Authorization", "Content-Type"],
        )

    @app.exception_handler(BackendUnavailable)
    async def backend_unavailable(_: Request, exc: BackendUnavailable):
        log.error("backend unavailable: %s", exc)
        return JSONResponse(status_code=503, content={"detail": "The service is temporarily unavailable. Try again in a moment."})

    @app.get("/health")
    def health():
        return {"status": "ok"}

    app.include_router(projects.router, prefix="/api")

    # The website's public settings come from the server's environment, so keys are
    # entered once (e.g. in Railway's variables). Only public values are sent: the
    # project URL and the anon key, which row-level security already constrains.
    @app.get("/assets/config.js", include_in_schema=False)
    def web_config():
        public = {"supabaseUrl": settings.supabase_url, "supabaseAnonKey": settings.supabase_anon_key, "apiUrl": ""}
        return Response(f"window.OLLIC_CONFIG = {json.dumps(public)};\n", media_type="application/javascript", headers={"Cache-Control": "no-store"})

    # The backend also serves the website, so one service hosts both.
    if settings.web_dir and os.path.isdir(settings.web_dir):
        app.mount("/", StaticFiles(directory=settings.web_dir, html=True), name="web")
    return app
