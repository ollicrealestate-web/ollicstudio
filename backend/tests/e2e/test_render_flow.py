"""End-to-end, Phase 2: a customer makes a concept render in the browser and revises it.

Real website, real API, real background thread runner. Supabase Auth and the OpenAI
image model are stand-ins; the stand-in model returns a genuine JPEG after a short
delay so the in-progress state is exercised too. Skipped when Playwright is missing.
"""

from __future__ import annotations

import base64
import threading
import time
from pathlib import Path

import pytest
import uvicorn

from app.auth import TokenVerifier
from app.config import Settings
from app.jobs import ThreadRunner
from app.main import create_app

from .. import samples
from ..conftest import SECRET, FakeImages, FakeRepo, FakeStorage
from .test_web_flow import WEB, _free_port, fake_supabase_auth

playwright = pytest.importorskip("playwright.sync_api")


class SlowImages(FakeImages):
    def _go(self, kind, **kw):
        time.sleep(1.5)
        return super()._go(kind, **kw)


class InlineLinkStorage(FakeStorage):
    """Signed links become data URLs, so the browser can show the stored bytes without a storage server."""

    def signed_urls(self, user, paths, bucket=None, expires_in=3600):
        b = self.buckets[bucket or "source-files"]
        return {p: "data:image/jpeg;base64," + base64.b64encode(b[p][0]).decode() + "#" for p in paths if p in b and p.split("/")[0] == user.id}


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    web = tmp_path_factory.mktemp("web2")
    for p in WEB.rglob("*"):
        if p.is_file():
            dest = web / p.relative_to(WEB); dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes(p.read_bytes())
    auth_port, api_port = _free_port(), _free_port()
    (web / "assets" / "config.js").write_text(f'window.OLLIC_CONFIG = {{ supabaseUrl: "http://127.0.0.1:{auth_port}", supabaseAnonKey: "anon", apiUrl: "" }};')
    settings = Settings(supabase_url=f"http://127.0.0.1:{auth_port}", supabase_anon_key="anon", supabase_jwt_secret=SECRET, web_dir=str(web), openai_api_key="sk-test",
                        cloudflare_account_id="acct", cloudflare_api_token="cf-test")
    repo, storage, images, premium = FakeRepo(), InlineLinkStorage(), SlowImages(), SlowImages()
    api = create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings),
                     image_clients={"standard": images, "premium": premium}, runner=ThreadRunner())
    auth = fake_supabase_auth()
    from fastapi.middleware.cors import CORSMiddleware
    auth.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    servers = [uvicorn.Server(uvicorn.Config(a, host="127.0.0.1", port=p, log_level="warning")) for a, p in ((auth, auth_port), (api, api_port))]
    for s in servers:
        threading.Thread(target=s.run, daemon=True).start()
    for s in servers:
        while not s.started:
            time.sleep(0.05)
    yield {"url": f"http://127.0.0.1:{api_port}", "repo": repo, "storage": storage, "images": images, "premium": premium, "dir": web}
    for s in servers:
        s.should_exit = True


def test_concept_render_and_revision_in_the_browser(stack, tmp_path):
    sketch = tmp_path / "front-elevation.png"; sketch.write_bytes(samples.png(64, 48))
    shots = Path(stack["dir"]).parent
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.route("**/fonts.googleapis.com/**", lambda r: r.abort()); page.route("**/fonts.gstatic.com/**", lambda r: r.abort())
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(stack["url"] + "/app.html#sign-up")
        page.fill("#upName", "Ada"); page.fill("#upEmail", "ada@render.test"); page.fill("#upPassword", "correct-horse-1")
        page.click("#signUpForm button[type=submit]"); page.wait_for_selector("#projectsView:not([hidden])")
        page.fill("#newProjectName", "Ikoyi villa"); page.click("#newProjectForm button[type=submit]")
        page.wait_for_selector("#renderForm:not([hidden])")
        assert page.is_visible("#galleryEmpty") and not page.is_visible("#studioOff")

        # the uploaded sketch becomes a choice in "Keep the shape from"
        page.set_input_files("#fileInput", str(sketch)); page.wait_for_selector("#fileRows tr")
        page.wait_for_function("document.querySelectorAll('#rBase option').length === 2")
        page.select_option("#rBase", label="front-elevation.png")
        page.fill("#rPrompt", "Two-storey villa, white render, bronze window frames")
        page.select_option("#rLight", "golden hour"); page.fill("#rMaterials", "white render, bronze frames")
        page.click("#renderBtn")

        page.wait_for_selector(".job .spinner")            # a real in-progress state from the job record
        assert "New concept" in page.inner_text("#jobList")
        page.wait_for_selector(".shot img", timeout=20000)
        page.wait_for_function("document.querySelectorAll('#jobList .job').length === 0")
        card = page.inner_text(".shot")
        assert "AI CONCEPT — NOT TO SCALE" in card.upper() and "Two-storey villa" in card and "GOLDEN HOUR" in card.upper()
        (call,) = stack["images"].calls
        assert call["kind"] == "edit" and "golden-hour" in call["prompt"] and "Image 1 is the design to render" in call["prompt"]   # the sketch was sent as the base
        page.screenshot(path=str(shots / "e2e-render.png"), full_page=True)

        # revise it: a second image appears and the original stays
        page.fill(".shot .revise input", "Make the roof dark grey"); page.click(".shot .revise button")
        page.wait_for_function("document.querySelectorAll('.shot').length === 2", timeout=20000)
        assert "Revision: Make the roof dark grey" in page.inner_text(".shot >> nth=0")
        assert stack["images"].calls[-1]["model"] == "@cf/black-forest-labs/flux-2-klein-4b"   # a Standard revision stays Standard
        assert len(stack["repo"].usage) == 2

        # Premium render is visible but locked for a free customer
        assert page.is_disabled("#tierPick input[value=premium]") and "Paid plans only" in page.inner_text("#premiumTier")
        assert not page.is_visible("#qualityField")
        # once the customer is on the paid plan, they can choose it
        uid = next(iter(stack["repo"].projects.values()))["owner_id"]
        stack["repo"].plans[uid] = "premium"
        page.reload(); page.wait_for_selector("#renderForm:not([hidden])")
        page.check("#tierPick input[value=premium]", force=True)
        assert page.is_visible("#qualityField")
        page.fill("#rPrompt", "Same villa, evening"); page.click("#renderBtn")
        page.wait_for_function("document.querySelectorAll('.shot').length === 3", timeout=20000)
        assert "PREMIUM RENDER" in page.inner_text(".shot >> nth=0").upper()
        assert stack["premium"].calls[0]["model"] == "gpt-image-2.5-sunburst"

        # phone width: no sideways scrolling
        page.set_viewport_size({"width": 390, "height": 844})
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.screenshot(path=str(shots / "e2e-render-phone.png"), full_page=True)
        assert errors == []
        browser.close()
