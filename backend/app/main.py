"""Ollic Design Studio API (Phase 1: foundation, Phase 2: concept renders)."""

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
from .cloudflare_images import CloudflareImages
from .jobs import ThreadRunner
from .openai_images import OpenAIImages
from .gemini_images import GeminiImages
from .fal import FalExact, FalImages, FalVideo
from .kling import KlingVideo
from .aps import AutodeskModels
from .runway import RunwayVideo
from .prompt_writer import ClaudePromptWriter
from .vision import CloudflareVision
from .routes import animation, cinematic, films, look, models, projects, renders, videos
from .supabase import BackendUnavailable, SupabaseRepository, SupabaseStorage

log = logging.getLogger("ollic")


def create_app(settings: Settings | None = None, *, repo=None, storage=None, verifier=None, image_client=None, image_clients=None,
               runner=None, vision="auto", prompt_writer="auto", kling="auto", gemini="auto", fal="auto", runway="auto", aps="auto") -> FastAPI:
    settings = settings or Settings.from_env()
    app = FastAPI(title="Ollic Design Studio API", version="0.1.0")
    app.state.settings = settings
    app.state.verifier = verifier or TokenVerifier(settings)
    app.state.repo = repo or SupabaseRepository(settings)
    app.state.storage = storage or SupabaseStorage(settings)
    # One client per tier. Tests may pass a single stand-in for both (image_client).
    if image_clients is None:
        image_clients = {
            "standard": image_client or (CloudflareImages(settings.cloudflare_account_id, settings.cloudflare_api_token) if settings.standard_available else None),
            "premium": image_client or (OpenAIImages(settings.openai_api_key, settings.openai_base_url) if settings.premium_available else None),
        }
    app.state.image_clients = {t: (c if settings.tier_available(t) else None) for t, c in image_clients.items()}
    app.state.runner = runner or ThreadRunner()
    # reads room names and areas off floor plans (free Cloudflare allowance); None means plans are traced without it
    if vision == "auto":
        vision = CloudflareVision(settings.cloudflare_account_id, settings.cloudflare_api_token) if settings.standard_available else None
    app.state.vision = vision
    # Premium prompting (Claude); None means Premium uses the standard written prompt
    if prompt_writer == "auto":
        prompt_writer = ClaudePromptWriter(settings.anthropic_api_key, settings.premium_prompt_model) if settings.anthropic_api_key else None
    app.state.prompt_writer = prompt_writer
    # direct connections: Kling for cinematic clips, Google Gemini (Nano Banana) for line drawings
    if kling == "auto":
        kling = KlingVideo(settings.kling_api_key, settings.kling_base_url, settings.kling_model) if settings.kling_api_key else None
    app.state.kling = kling
    if gemini == "auto":
        gemini = GeminiImages(settings.gemini_api_key) if settings.gemini_api_key else None
    app.state.gemini = gemini
    # Runway (direct): AI walkthroughs, the model's exact guide video turned photoreal
    if runway == "auto":
        runway = RunwayVideo(settings.runway_api_key) if settings.runway_api_key else None
    app.state.runway = runway
    if aps == "auto":
        aps = AutodeskModels(settings.aps_client_id, settings.aps_client_secret) if settings.aps_client_id and settings.aps_client_secret else None
    app.state.aps = aps
    # the added options sit beside Standard and Premium (which are unchanged): Ollic Swift and Ultra
    for t in ("swift", "ultra"):
        app.state.image_clients.setdefault(t, gemini)
    # Ollic VS (fal.ai): an image option and a video option; fal may be a dict {"images", "video"} in tests
    if fal == "auto":
        fal = {"images": FalImages(settings.fal_key), "video": FalVideo(settings.fal_key), "exact": FalExact(settings.fal_key)} if settings.fal_key else {}
    fal = fal or {}
    app.state.image_clients.setdefault("vs", fal.get("images"))
    app.state.image_clients.setdefault("exact", fal.get("exact"))
    if fal.get("exact") is not None and hasattr(fal["exact"], "guide"):
        fal["exact"].guide, fal["exact"].strength = settings.exact_guide, settings.exact_strength
    # video options by id; an option with no client is listed as not connected
    app.state.video_clients = {"motion": kling, "vs": fal.get("video")}

    if settings.web_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.web_origins),
            allow_methods=["GET", "POST", "PATCH", "DELETE"],
            allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
        )

    @app.exception_handler(BackendUnavailable)
    async def backend_unavailable(_: Request, exc: BackendUnavailable):
        log.error("backend unavailable: %s", exc)
        return JSONResponse(status_code=503, content={"detail": "The service is temporarily unavailable. Try again in a moment."})

    @app.get("/health")
    def health():
        return {"status": "ok", "renders": {"standard": settings.standard_available, "premium": settings.premium_available}}

    app.include_router(projects.router, prefix="/api")
    app.include_router(renders.router, prefix="/api")
    app.include_router(models.router, prefix="/api")
    app.include_router(films.router, prefix="/api")
    app.include_router(look.router, prefix="/api")
    app.include_router(videos.router, prefix="/api")
    app.include_router(animation.router, prefix="/api")
    app.include_router(cinematic.router, prefix="/api")

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
