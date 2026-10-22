"""End-to-end in a real browser with WebGL and WebCodecs: an architect uploads a two-storey
IFC, opens the construction animation (luxury style: gold wireframe, photoreal reveal), makes
the photoreal views, scrubs through it, changes it in plain words, and exports an MP4 that the
server checks, converts and saves. Supabase Auth and the AI director
are stand-ins; IFC processing, the animation, the browser's video encoder and FFmpeg are real."""

from __future__ import annotations

import json
import shutil
import threading
import time
from pathlib import Path

import pytest
import uvicorn

from app.auth import TokenVerifier
from app.config import Settings
from app.jobs import ThreadRunner
from app.main import create_app

from ..conftest import SECRET, FakeImages, FakeRepo
from ..fixtures.villa import build_villa_ifc
from ..test_animation import FakeDirector
from .test_model_flow import GL_ARGS
from .test_walkthrough_flow import MediaLinkStorage
from .test_web_flow import WEB, _free_port, fake_supabase_auth

playwright = pytest.importorskip("playwright.sync_api")
pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is not installed")


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
    director = FakeDirector(settings={"format": "1:1", "phases": {"roof": {"seconds": 2}}, "rooms": ["Kitchen", "Attic"]})
    repo, storage, images = FakeRepo(), MediaLinkStorage(), FakeImages()
    api = create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings), runner=ThreadRunner(),
                     image_clients={"standard": images, "premium": None}, vision=None, prompt_writer=None, directors={"standard": director})
    auth = fake_supabase_auth()
    from fastapi.middleware.cors import CORSMiddleware
    auth.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    servers = [uvicorn.Server(uvicorn.Config(a, host="127.0.0.1", port=p, log_level="warning")) for a, p in ((auth, auth_port), (api, api_port))]
    for s in servers:
        threading.Thread(target=s.run, daemon=True).start()
    for s in servers:
        while not s.started:
            time.sleep(0.05)
    yield {"url": f"http://127.0.0.1:{api_port}", "repo": repo, "storage": storage, "director": director, "dir": web, "images": images}
    for s in servers:
        s.should_exit = True


# A short animation, so the test exports in a few minutes on a machine without a graphics card.
SHORT = {"phases": {"site": {"seconds": 1}, "foundation": {"seconds": 1}, "structure": {"seconds": 1}, "walls": {"seconds": 1}, "openings": {"seconds": 1},
                    "roof": {"seconds": 1}, "orbit": {"seconds": 2}, "furnish": {"on": False}, "interior": {"on": False}}, "renders": False, "title": "Villa build",
         "style": "luxury", "heroes": 1}


def test_construction_animation_in_the_browser(stack, tmp_path):
    ifc = tmp_path / "villa.ifc"; ifc.write_bytes(build_villa_ifc("e2e"))
    shots = Path(stack["dir"]).parent
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(args=GL_ARGS)
        page = browser.new_page(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
        page.route("**/fonts.googleapis.com/**", lambda r: r.abort()); page.route("**/fonts.gstatic.com/**", lambda r: r.abort())
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(stack["url"] + "/app.html#sign-up")
        page.fill("#upName", "Ada"); page.fill("#upEmail", "ada@build.test"); page.fill("#upPassword", "correct-horse-1")
        page.click("#signUpForm button[type=submit]"); page.wait_for_selector("#projectsView:not([hidden])")
        page.fill("#newProjectName", "Two-storey villa"); page.click("#newProjectForm button[type=submit]")
        page.wait_for_selector("#modelEmpty:not([hidden])")
        page.set_input_files("#fileInput", str(ifc))
        page.wait_for_selector("#viewerWrap:not([hidden]) canvas", timeout=60000)
        page.wait_for_function("document.querySelector('#reportCard h3')?.textContent.includes('ready to use')", timeout=30000)

        # 1. the animation with its default settings: every stage of the build, then the rooms
        page.click("#viewBuild")
        page.wait_for_selector("#animPanel:not([hidden])")
        assert page.get_attribute("#viewBuild", "aria-pressed") == "true" and not page.is_visible("#useView")
        chapters = [c.title() for c in page.locator("#animChapters button").all_text_contents()]
        assert chapters == ["Site", "Foundation", "Structure", "Walls", "Structure", "Walls", "Doors And Windows", "Roof", "Completed Building"]
        assert "0:44" in page.inner_text("#animTime")       # 3+4+(4+3)*2+3+4, then 2 photoreal views of 8 s
        assert page.is_visible("#animHeroes") and page.locator("#heroList .hero-card").count() == 2
        assert "Make photoreal views (2)" in page.inner_text("#heroBtn")

        # the photoreal views: one render per hero view, of the plain finished model, tagged with its key
        page.fill("#aLook", "white render, bronze glass, palm trees")
        page.click("#heroBtn")
        page.wait_for_function("[...document.querySelectorAll('#heroList .hero-card')].every(c => c.textContent.includes('Ready'))", timeout=60000)
        heroes = [c for c in stack["images"].calls]
        assert len(heroes) == 2 and all("Photorealistic luxury architectural visualisation" in c["prompt"] and "white render, bronze glass" in c["prompt"] for c in heroes)
        tags = sorted(i["options"]["anim_hero"]["index"] for i in stack["repo"].images.values() if (i.get("options") or {}).get("anim_hero"))
        assert tags == [0, 1] and "Remake" in page.inner_text("#heroBtn")
        page.click("#animChapters button:has-text('Roof')")
        assert "Roof" in page.inner_text("#animTime")
        page.locator("#viewer").screenshot(path=str(shots / "e2e-construction-roof.png"))
        page.fill("#animScrub", "3300"); page.dispatch_event("#animScrub", "input")     # mid-sweep of view 1
        page.locator("#viewer").screenshot(path=str(shots / "e2e-construction-reveal.png"))
        page.fill("#animScrub", "1500")      # 15 s: first-floor structure (site 3, foundation 4, ground floor 4 + 3)
        page.dispatch_event("#animScrub", "input")
        assert "First floor · structure" in page.inner_text("#animTime")

        # 2. plain words
        page.fill("#animAsk", "Make it square for Instagram, slower roof, and only show the kitchen")
        page.click("#animAskBtn")
        page.wait_for_function("document.querySelector('#animNotes').textContent.includes('Slowed the roof')")
        instruction, sent, context = stack["director"].calls[-1]
        assert instruction.startswith("Make it square") and context["floors"] == 2 and "Kitchen" in context["rooms"] and "furniture" in context["has"]
        page.click("#animSettings summary")
        assert page.input_value("#aFormat") == "1:1" and page.is_checked("#aRooms input[value='Kitchen']")
        assert page.evaluate("getComputedStyle(document.querySelector('#viewer')).aspectRatio").replace(" ", "") == "1/1"
        assert page.locator("#aRooms input:checked").count() == 1      # "Attic" is not in the model, so it was dropped

        # 3. export (a short version)
        page.evaluate("s => { localStorage.setItem('ollic-anim-' + new URLSearchParams(location.search).get('project'), JSON.stringify(s)); }",
                      {**SHORT, "format": "1:1"})
        page.click("#viewOutside"); page.click("#viewBuild")
        assert "0:10" in page.inner_text("#animTime")
        page.wait_for_function("document.querySelector('#heroList')?.textContent.includes('Ready') || document.querySelector('#heroList')?.textContent.includes('Wireframe')")
        page.screenshot(path=str(shots / "e2e-construction.png"), full_page=True)
        page.click("#animExport")                 # no photoreal view for the square format yet: a warning first
        page.wait_for_function("document.querySelector('#animMsg').textContent.includes('not made yet')")
        page.click("#animExport")                 # export anyway: it ends on the gold wireframe
        page.wait_for_selector("#animProgress:not([hidden])")
        page.wait_for_selector("#animVideos .video-card video", timeout=900000)
        (vid,) = stack["repo"].videos.values()
        assert vid["kind"] == "construction" and (vid["width"], vid["height"], vid["format"]) == (1080, 1080, "1:1") and vid["title"] == "Villa build"
        assert abs(float(vid["duration_s"]) - 16) < 0.2               # 3 s card + 8 s build + 2 s photoreal view + 3 s card
        assert vid["script"]["phases"]["furnish"]["on"] is False
        assert "CONSTRUCTION" in page.inner_text("#animVideos").upper() and page.locator("#videoList .video-card").count() == 0
        data = stack["storage"].buckets["videos"][vid["storage_path"]][0]
        (shots / "e2e-construction.mp4").write_bytes(data)

        page.set_viewport_size({"width": 390, "height": 844}); page.wait_for_timeout(300)
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.screenshot(path=str(shots / "e2e-construction-phone.png"), full_page=True)
        assert errors == [], errors
        browser.close()
