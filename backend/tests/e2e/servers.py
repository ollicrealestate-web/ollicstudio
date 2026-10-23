"""The test servers for the golden animation's browser test: the real API and website, with
Supabase Auth, the image model and the video model as stand-ins."""

from __future__ import annotations

import base64
import threading
import time

import pytest
import uvicorn

from app.auth import TokenVerifier
from app.config import Settings
from app.jobs import ThreadRunner
from app.main import create_app

from ..conftest import SECRET, FakeImages, FakeRepo
from ..test_cinematic import FakeKling
from .test_render_flow import InlineLinkStorage
from .test_web_flow import WEB, _free_port, fake_supabase_auth


class MediaLinkStorage(InlineLinkStorage):
    """Videos come back as data links, so the browser can play them without a storage server."""
    def signed_urls(self, user, paths, bucket=None, expires_in=3600):
        if bucket != "videos":
            return super().signed_urls(user, paths, bucket, expires_in)
        b = self.buckets[bucket]
        return {p: "data:video/mp4;base64," + base64.b64encode(b[p][0]).decode() + "#" for p in paths if p in b and p.split("/")[0] == user.id}


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    web = tmp_path_factory.mktemp("web5")
    for p in WEB.rglob("*"):
        if p.is_file():
            dest = web / p.relative_to(WEB); dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes(p.read_bytes())
    auth_port, api_port = _free_port(), _free_port()
    (web / "assets" / "config.js").write_text(f'window.OLLIC_CONFIG = {{ supabaseUrl: "http://127.0.0.1:{auth_port}", supabaseAnonKey: "anon", apiUrl: "" }};')
    settings = Settings(supabase_url=f"http://127.0.0.1:{auth_port}", supabase_anon_key="anon", supabase_jwt_secret=SECRET, web_dir=str(web),
                        cloudflare_account_id="acct", cloudflare_api_token="cf")
    repo, storage, images = FakeRepo(), MediaLinkStorage(), FakeImages()
    api = create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings), runner=ThreadRunner(),
                     image_clients={"standard": images, "premium": None}, vision=None, prompt_writer=None, kling=FakeKling(), gemini=None)
    api.state.clip_poll_seconds = 0
    auth = fake_supabase_auth()
    from fastapi.middleware.cors import CORSMiddleware
    auth.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    servers = [uvicorn.Server(uvicorn.Config(a, host="127.0.0.1", port=p, log_level="warning")) for a, p in ((auth, auth_port), (api, api_port))]
    for s in servers:
        threading.Thread(target=s.run, daemon=True).start()
    for s in servers:
        while not s.started:
            time.sleep(0.05)
    yield {"url": f"http://127.0.0.1:{api_port}", "repo": repo, "storage": storage, "dir": web, "images": images}
    for s in servers:
        s.should_exit = True
