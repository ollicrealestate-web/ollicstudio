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
    openai_image_model: str = "gpt-image-2.5-flare"      # new concepts from a prompt or a reference
    openai_edit_model: str = "gpt-image-2.5-sunburst"    # revisions, where keeping the base matters most
    renders_bucket: str = "renders"

    @property
    def renders_enabled(self) -> bool:
        return bool(self.openai_api_key)

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
            openai_image_model=os.environ.get("OPENAI_IMAGE_MODEL", "").strip() or "gpt-image-2.5-flare",
            openai_edit_model=os.environ.get("OPENAI_EDIT_MODEL", "").strip() or "gpt-image-2.5-sunburst",
            renders_bucket=os.environ.get("RENDERS_BUCKET", "renders").strip() or "renders",
        )
