"""End-to-end in a real browser with WebGL: an architect walks through the rooms of an
uploaded IFC, saves a shot in each room, renders all shots in one go, and makes an MP4
walkthrough. Supabase Auth and the image model are stand-ins; IFC processing and FFmpeg
are real."""

from __future__ import annotations

import base64
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
from ..fixtures.builder import build_ifc
from ..fixtures.layout import sample_house
from .test_model_flow import GL_ARGS
from .test_render_flow import InlineLinkStorage
from .test_web_flow import WEB, _free_port, fake_supabase_auth

playwright = pytest.importorskip("playwright.sync_api")
pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is not installed")


class MediaLinkStorage(InlineLinkStorage):
    def signed_urls(self, user, paths, bucket=None, expires_in=3600):
        if bucket != "videos":
            return super().signed_urls(user, paths, bucket, expires_in)
        b = self.buckets[bucket]
        return {p: "data:video/mp4;base64," + base64.b64encode(b[p][0]).decode() + "#" for p in paths if p in b and p.split("/")[0] == user.id}


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    web = tmp_path_factory.mktemp("web4")
    for p in WEB.rglob("*"):
        if p.is_file():
            dest = web / p.relative_to(WEB); dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes(p.read_bytes())
    auth_port, api_port = _free_port(), _free_port()
    (web / "assets" / "config.js").write_text(f'window.OLLIC_CONFIG = {{ supabaseUrl: "http://127.0.0.1:{auth_port}", supabaseAnonKey: "anon", apiUrl: "" }};')
    settings = Settings(supabase_url=f"http://127.0.0.1:{auth_port}", supabase_anon_key="anon", supabase_jwt_secret=SECRET, web_dir=str(web),
                        cloudflare_account_id="acct", cloudflare_api_token="cf")
    repo, storage, images = FakeRepo(), MediaLinkStorage(), FakeImages()
    api = create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings), runner=ThreadRunner(),
                     image_clients={"standard": images, "premium": None}, vision=None, prompt_writer=None)
    auth = fake_supabase_auth()
    from fastapi.middleware.cors import CORSMiddleware
    auth.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    servers = [uvicorn.Server(uvicorn.Config(a, host="127.0.0.1", port=p, log_level="warning")) for a, p in ((auth, auth_port), (api, api_port))]
    for s in servers:
        threading.Thread(target=s.run, daemon=True).start()
    for s in servers:
        while not s.started:
            time.sleep(0.05)
    yield {"url": f"http://127.0.0.1:{api_port}", "repo": repo, "storage": storage, "images": images, "dir": web}
    for s in servers:
        s.should_exit = True


def test_walk_through_rooms_render_all_and_make_a_video(stack, tmp_path):
    ifc = tmp_path / "bungalow.ifc"; ifc.write_bytes(build_ifc(sample_house(), seed="walk"))
    shots_dir = Path(stack["dir"]).parent
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(args=GL_ARGS)
        page = browser.new_page(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
        page.route("**/fonts.googleapis.com/**", lambda r: r.abort()); page.route("**/fonts.gstatic.com/**", lambda r: r.abort())
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(stack["url"] + "/app.html#sign-up")
        page.fill("#upName", "Ada"); page.fill("#upEmail", "ada@walk.test"); page.fill("#upPassword", "correct-horse-1")
        page.click("#signUpForm button[type=submit]"); page.wait_for_selector("#projectsView:not([hidden])")
        page.fill("#newProjectName", "Lekki bungalow"); page.click("#newProjectForm button[type=submit]")
        page.click(".svc-card:has-text('Walkthrough video')"); page.wait_for_selector("#svcStart:not([hidden])")

        page.set_input_files("#fileInput", str(ifc))
        page.wait_for_selector("#viewerWrap:not([hidden]) canvas", timeout=60000)
        page.wait_for_function("document.querySelector('#reportCard h3')?.textContent.includes('ready to use')", timeout=30000)
        assert page.is_visible("#shotsEmpty") and not page.is_visible("#videoForm") and not page.is_visible("#viewBuild")

        # 1. walk through the rooms
        page.click("#viewWalk")
        page.wait_for_selector("#walkPanel:not([hidden])")
        rooms = page.locator("#roomList button")
        assert rooms.count() == 5 and page.get_attribute("#viewWalk", "aria-pressed") == "true"
        page.click("#roomList button:has-text('Living')")
        fwd = page.locator(".walk-pad [aria-label='Walk forward']")
        fwd.dispatch_event("pointerdown"); page.wait_for_timeout(400); fwd.dispatch_event("pointerup")
        page.screenshot(path=str(shots_dir / "e2e-walk-living.png"), clip=(page.locator("#viewer").scroll_into_view_if_needed() or page.locator("#viewer").bounding_box()), timeout=120000)
        page.click("#saveShot")
        page.wait_for_selector("#shotStrip li")
        page.click("#roomList button:has-text('Kitchen')")
        page.click("#saveShot")
        page.wait_for_function("document.querySelectorAll('#shotStrip li').length === 2")
        assert [page.input_value(f"#shotStrip li >> nth={i} >> input[type=text]") for i in range(2)] == ["Living", "Kitchen"]
        shot_rows = list(stack["repo"].shots.values())
        assert all(s["pose"]["mode"] == "walk" for s in shot_rows) and {s["room"] for s in shot_rows} == {"Living", "Kitchen"}
        lift = [s for s in shot_rows if s["room"] == "Living"][0]["pose"]["position"]
        assert 1.5 < lift[1] < 1.9   # eye height

        # an outside view can be a shot too
        page.click("#viewOutside"); page.wait_for_selector("#walkPanel", state="hidden")
        page.click("#saveShot"); page.wait_for_function("document.querySelectorAll('#shotStrip li').length === 3")
        assert page.input_value("#shotStrip li >> nth=2 >> input[type=text]") == "Outside view"
        page.click("#shotStrip li >> nth=2 >> button:has-text('Delete')")
        page.wait_for_function("document.querySelectorAll('#shotStrip li').length === 2")

        # reorder: Kitchen first
        page.click("#shotStrip li >> nth=1 >> button[aria-label='Move Kitchen earlier']")
        page.wait_for_function("document.querySelector('#shotStrip li input[type=text]').value === 'Kitchen'")

        # 2. render all shots with one brief
        page.fill("#rPrompt", "Warm minimal interiors, oak floors, linen sofa, brass pendant lights")
        page.click("#renderAllBtn")
        page.wait_for_function("document.querySelectorAll('#gallery .shot').length === 2", timeout=30000)
        page.wait_for_function("[...document.querySelectorAll('#shotStrip .badge')].every(b => b.textContent === 'Rendered')", timeout=15000)
        prompts = [c["prompt"] for c in stack["images"].calls]
        assert any("This shot is: Kitchen" in x for x in prompts) and any("This shot is: Living" in x for x in prompts)
        assert all("oak floors" in x for x in prompts)

        # 3. the video
        page.wait_for_selector("#videoForm:not([hidden])")
        assert page.locator("#videoPicks li").count() == 2
        page.fill("#videoPicks li >> nth=0 >> input[type=text]", "Open kitchen")
        page.select_option("#vFormat", "9:16"); page.fill("#vSeconds", "2.5"); page.fill("#vSubtitle", "Concept walkthrough")
        page.screenshot(path=str(shots_dir / "e2e-walkthrough.png"), full_page=True)
        page.click("#videoBtn")
        page.wait_for_selector(".video-card video", timeout=240000)
        (vid,) = stack["repo"].videos.values()
        assert (vid["width"], vid["height"]) == (1080, 1920) and [i["caption"] for i in vid["items"]] == ["Open kitchen", "Living"]
        assert vid["title"] == "Lekki bungalow"
        assert "9:16" in page.inner_text(".video-card") and page.is_visible(".video-card a:has-text('Download MP4')")

        page.set_viewport_size({"width": 390, "height": 844}); page.wait_for_timeout(300)
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.screenshot(path=str(shots_dir / "e2e-walkthrough-phone.png"), full_page=True)
        assert errors == [], errors
        browser.close()
