"""Settings read from the environment. Every variable is listed in .env.example."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    return int(raw) if raw else default


@dataclass(frozen=True)
class Settings:
    supabase_url: str
    supabase_anon_key: str
    # Only for projects still on the legacy shared JWT secret (HS256).
    # Projects using Supabase's asymmetric signing keys leave this empty; tokens
    # are then checked against the project's public JWKS endpoint.
    supabase_jwt_secret: str | None = field(default=None, repr=False)
    jwt_audience: str = "authenticated"
    storage_bucket: str = "source-files"
    max_upload_bytes: int = 50 * 1024 * 1024
    web_origins: tuple[str, ...] = field(default_factory=tuple)
    web_dir: str | None = None
    # Phase 2: concept renders. Without a key the render endpoints say so plainly.
    openai_api_key: str | None = field(default=None, repr=False)  # server only; never sent to the browser
    openai_base_url: str = "https://api.openai.com/v1"
    openai_image_model: str = "gpt-image-2.5-sunburst"   # Premium: the most precise image model, for new concepts
    openai_edit_model: str = "gpt-image-2.5-sunburst"    # and for revisions
    # Premium prompting: Claude reads the plan, sketches and references and writes the prompt
    anthropic_api_key: str | None = field(default=None, repr=False)
    premium_prompt_model: str = "claude-opus-5-5"
    renders_bucket: str = "renders"
    models_bucket: str = "models"
    videos_bucket: str = "videos"
    # Cloudflare Workers AI: a free allowance every day (10,000 neurons).
    cloudflare_account_id: str | None = None
    cloudflare_api_token: str | None = field(default=None, repr=False)  # server only
    cloudflare_image_model: str = "@cf/black-forest-labs/flux-2-klein-4b"
    # Renders each customer may start per day (UTC). 0 means no limit.
    daily_renders_per_user: int = 3            # Standard (free, Cloudflare)
    daily_premium_renders_per_user: int = 20   # Premium render (paid plans, OpenAI)
    # Kling (direct): video clips from a start and an end frame. Paid plans only; costs money per second.
    kling_api_key: str | None = field(default=None, repr=False)
    kling_base_url: str = "https://api-singapore.klingai.com"   # Kling's endpoint for servers outside China
    kling_model: str = "kling-3.0"
    daily_clips_per_user: int = 5              # cinematic clips a paid customer may start per day
    # largest IFC the server reads; reading takes about 17x the file size in memory, so 12 MB suits
    # a 512 MB server; set IFC_MAX_MB=80 on a 2 GB one
    ifc_max_mb: int = 12
    exact_guide: str = "lines"     # what Ollic Exact draws on: "lines" (floors and openings) or "depth"
    aps_client_id: str = ""         # Autodesk Platform Services app: reads Revit files
    aps_client_secret: str = field(default="", repr=False)
    # Google Gemini API (direct): Nano Banana images, used for animation line drawings
    gemini_api_key: str | None = field(default=None, repr=False)
    fal_key: str | None = field(default=None, repr=False)          # Ollic VS (fal.ai): images and video
    runway_api_key: str | None = field(default=None, repr=False)   # Ollic Path (Runway): AI walkthroughs from the model
    gemini_image_model: str = "gemini-nano-banana-2.1"

    # Two tiers, both offered side by side:
    #   standard: Cloudflare Workers AI, free daily allowance, for everyone
    #   premium:  OpenAI, "Premium render", paid plans only
    @property
    def standard_available(self) -> bool:
        return bool(self.cloudflare_account_id and self.cloudflare_api_token)

    @property
    def premium_available(self) -> bool:
        return bool(self.openai_api_key)

    @property
    def renders_enabled(self) -> bool:
        return self.standard_available or self.premium_available

    def tier_available(self, tier: str) -> bool:
        return self.premium_available if tier == "premium" else self.standard_available

    def model_for(self, tier: str, operation: str) -> str:
        from .engines import IMAGE_ENGINES
        if tier in IMAGE_ENGINES:
            return IMAGE_ENGINES[tier]["model"]
        if tier == "premium":
            return self.openai_edit_model if operation == "revise" else self.openai_image_model
        return self.cloudflare_image_model

    def daily_limit_for(self, tier: str) -> int:
        return self.daily_renders_per_user if tier == "standard" else self.daily_premium_renders_per_user

    @property
    def jwks_url(self) -> str:
        return f"{self.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"

    @classmethod
    def from_env(cls) -> "Settings":
        url = os.environ.get("SUPABASE_URL", "").strip()
        anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
        missing = [n for n, v in (("SUPABASE_URL", url), ("SUPABASE_ANON_KEY", anon)) if not v]
        if missing:
            raise RuntimeError(
                "Missing required settings: " + ", ".join(missing) + ". Copy .env.example to .env and fill them in."
            )
        origins = tuple(o.strip() for o in os.environ.get("WEB_ORIGINS", "").split(",") if o.strip())
        return cls(
            supabase_url=url.rstrip("/"),
            supabase_anon_key=anon,
            supabase_jwt_secret=os.environ.get("SUPABASE_JWT_SECRET", "").strip() or None,
            storage_bucket=os.environ.get("STORAGE_BUCKET", "source-files").strip() or "source-files",
            max_upload_bytes=_int("MAX_UPLOAD_MB", 50) * 1024 * 1024,
            web_origins=origins,
            web_dir=os.environ.get("WEB_DIR", "").strip() or None,
            openai_api_key=os.environ.get("OPENAI_API_KEY", "").strip() or None,
            openai_base_url=(os.environ.get("OPENAI_BASE_URL", "").strip() or "https://api.openai.com/v1").rstrip("/"),
            openai_image_model=os.environ.get("OPENAI_IMAGE_MODEL", "").strip() or "gpt-image-2.5-sunburst",
            anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY", "").strip() or None,
            premium_prompt_model=os.environ.get("PREMIUM_PROMPT_MODEL", "").strip() or "claude-opus-5-5",
            openai_edit_model=os.environ.get("OPENAI_EDIT_MODEL", "").strip() or "gpt-image-2.5-sunburst",
            renders_bucket=os.environ.get("RENDERS_BUCKET", "renders").strip() or "renders",
            models_bucket=os.environ.get("MODELS_BUCKET", "models").strip() or "models",
            videos_bucket=os.environ.get("VIDEOS_BUCKET", "videos").strip() or "videos",
            cloudflare_account_id=os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip() or None,
            cloudflare_api_token=os.environ.get("CLOUDFLARE_API_TOKEN", "").strip() or None,
            cloudflare_image_model=os.environ.get("CLOUDFLARE_IMAGE_MODEL", "").strip() or "@cf/black-forest-labs/flux-2-klein-4b",
            daily_renders_per_user=_int("DAILY_RENDERS_PER_USER", 3),
            daily_premium_renders_per_user=_int("DAILY_PREMIUM_RENDERS_PER_USER", 20),
            kling_api_key=os.environ.get("KLING_API_KEY", "").strip() or None,
            kling_base_url=(os.environ.get("KLING_BASE_URL", "").strip() or "https://api-singapore.klingai.com").rstrip("/"),
            kling_model=os.environ.get("KLING_MODEL", "").strip() or "kling-3.0",
            daily_clips_per_user=_int("DAILY_CLIPS_PER_USER", 5),
            ifc_max_mb=_int("IFC_MAX_MB", 12),
            exact_guide=(os.environ.get("EXACT_GUIDE", "").strip().lower() or "lines") if os.environ.get("EXACT_GUIDE", "").strip().lower() in ("", "lines", "depth") else "lines",
            aps_client_id=os.environ.get("APS_CLIENT_ID", "").strip(),
            aps_client_secret=os.environ.get("APS_CLIENT_SECRET", "").strip(),
            gemini_api_key=os.environ.get("GEMINI_API_KEY", "").strip() or None,
            fal_key=os.environ.get("FAL_KEY", "").strip() or None,
            runway_api_key=os.environ.get("RUNWAY_API_KEY", "").strip() or None,
            gemini_image_model=os.environ.get("GEMINI_IMAGE_MODEL", "").strip() or "gemini-nano-banana-2.1",
        )
