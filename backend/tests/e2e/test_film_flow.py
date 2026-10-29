"""End to end in a real browser with WebGL: an architect opens their IFC model, has the walkthrough
planned, and films a shot. The browser records the exact clay guide of the camera move (WebCodecs),
the server renders the first frame, sends the guide to the video service (a stand-in) and checks the
result against the model. Auth, the image model and the video service are stand-ins."""

from __future__ import annotations

import shutil
import threading
import time

import pytest
import uvicorn

from app.auth import TokenVerifier
from app.config import Settings
from app.jobs import ThreadRunner
from app.main import create_app
from app.video import probe

from ..conftest import SECRET, FakeImages, FakeRepo
from ..fixtures.builder import build_ifc
from ..fixtures.layout import sample_house
from ..test_film import FakeDepthVideo, FakeRunway
from ..test_revit import APS, RVT, client_for
from .test_model_flow import GL_ARGS
from .test_render_flow import InlineLinkStorage
from .test_web_flow import WEB, _free_port, fake_supabase_auth

playwright = pytest.importorskip("playwright.sync_api")
pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is not installed")


class EveryoneAdmin(dict):
    def get(self, key, default=None):
        return "admin"


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
    repo, storage, images, runway, depth = FakeRepo(), InlineLinkStorage(), FakeImages(), FakeRunway(), FakeDepthVideo()
    repo.roles = EveryoneAdmin()
    uploads = []
    real = storage.upload
    storage.upload = lambda user, path, data, *a, **k: (uploads.append((path, data)), real(user, path, data, *a, **k))[1]
    api = create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings), runner=ThreadRunner(),
                     image_clients={"standard": images, "premium": None}, runway=runway, aps=client_for(APS()), fal={"film_exact": depth})
    api.state.clip_poll_seconds = 0; api.state.aps_poll_seconds = 0
    auth = fake_supabase_auth()
    from fastapi.middleware.cors import CORSMiddleware
    auth.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    servers = [uvicorn.Server(uvicorn.Config(a, host="127.0.0.1", port=p, log_level="warning")) for a, p in ((auth, auth_port), (api, api_port))]
    for s in servers:
        threading.Thread(target=s.run, daemon=True).start()
    for s in servers:
        while not s.started:
            time.sleep(0.05)
    yield {"url": f"http://127.0.0.1:{api_port}", "repo": repo, "runway": runway, "depth": depth, "uploads": uploads, "dir": web, "storage": storage}
    for s in servers:
        s.should_exit = True


def test_a_walkthrough_shot_is_planned_recorded_and_filmed(stack, tmp_path):
    ifc = tmp_path / "block.ifc"; ifc.write_bytes(build_ifc(sample_house(), seed="film"))
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(args=GL_ARGS)
        page = browser.new_page(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
        page.route("**/fonts.googleapis.com/**", lambda r: r.abort()); page.route("**/fonts.gstatic.com/**", lambda r: r.abort())
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(stack["url"] + "/app.html#sign-up")
        page.fill("#upName", "Ada"); page.fill("#upEmail", "ada@film.test"); page.fill("#upPassword", "correct-horse-1")
        page.click("#signUpForm button[type=submit]"); page.wait_for_selector("#projectsView:not([hidden])")
        page.fill("#newProjectName", "Maitama film"); page.click("#newProjectForm button[type=submit]")
        page.click(".svc-card:has-text('AI walkthrough')"); page.wait_for_selector("#svcStart:not([hidden])")
        page.set_input_files("#fileInput", str(ifc))
        page.wait_for_selector("#viewerWrap:not([hidden]) canvas", timeout=60000)
        page.wait_for_selector("#filmSection:not([hidden])")
        assert page.is_visible("#addShotView") and not page.is_visible("#useView")
        assert page.input_value("#filmEngine") == "exact" and "Ollic Path Exact" in page.inner_text("#filmEngine") and "Runway" not in page.content()

        # 1. the plan (no Claude key here, so the ready-made three shots), then keep one short shot
        page.fill("#filmDesc", "white render, bronze glazing, palm trees")
        page.click("#planBtn")
        page.wait_for_function("document.querySelectorAll('#filmShots .film-shot').length === 3", timeout=30000)
        for _ in range(2):
            page.click("#filmShots .film-shot >> nth=1 >> button:has-text('Remove')")
        page.select_option("#filmShots .film-shot select", "4")
        assert "4 s of film" in page.inner_text("#filmEst")

        # 2. record and send; the job renders the first frame, films and checks the shot
        page.click("#filmGo")
        page.wait_for_function("document.querySelector('#filmProgText')?.textContent.includes('sent')", timeout=180000)
        try:
            page.wait_for_selector("#filmVideos .chip[class*=check-]", timeout=60000)
        except Exception:
            print([(j["type"], j["status"], j.get("error"), j.get("progress")) for j in stack["repo"].jobs.values()], list(stack["repo"].videos.values())[:1])
            print(page.inner_text("#filmSection"))
            raise
        assert errors == [], errors
        page.screenshot(path=str(stack["dir"].parent / "e2e-film.png"), full_page=True)
        browser.close()

    repo = stack["repo"]
    (job,) = [j for j in repo.jobs.values() if j["type"] == "film_shot"]
    assert job["status"] == "succeeded" and job["input"]["kind"] == "approach" and 3.5 <= job["input"]["seconds"] <= 4.5
    # Ollic Path Exact: the model at both ends was saved; both frames were rendered; the depth video was filmed between them
    ends = {k: v for k, v in job["input"].items() if k.startswith(("start_", "end_"))}
    assert len(ends) == 8 and all(ends.values())
    names = {repo.files[ends["start_depth_id"]]["original_name"], repo.files[ends["end_view_id"]]["original_name"]}
    assert any(n.endswith("start - depth.png") for n in names) and any(n.endswith("end - view.jpg") for n in names)
    assert sum(1 for j in repo.jobs.values() if j["type"] == "concept_render") >= 2
    (call,) = stack["depth"].calls
    assert "palm trees" in call["prompt"] and call["first_frame"][:2] == b"\xff\xd8" and call["last_frame"][:2] == b"\xff\xd8"
    assert stack["runway"].calls == []
    (vid,) = repo.videos.values()
    assert vid["kind"] == "film" and vid["script"]["engine"] == "exact" and "score" in vid["script"]["check"]
    # whatever the browser recorded, the guide sent on was H.264 at the exact 16:9 size
    (guide,) = [d for path, d in stack["uploads"] if "/guides/" in path]
    g = tmp_path / "guide.mp4"; g.write_bytes(guide)
    info = probe(g)
    assert info.codec == "h264" and (info.width, info.height) == (1280, 720)


def test_a_revit_file_is_converted_and_opens_in_3d(stack, tmp_path):
    rvt = tmp_path / "Villa A.rvt"; rvt.write_bytes(RVT)
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(args=GL_ARGS)
        page = browser.new_page(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
        page.route("**/fonts.googleapis.com/**", lambda r: r.abort()); page.route("**/fonts.gstatic.com/**", lambda r: r.abort())
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(stack["url"] + "/app.html#sign-up")
        page.fill("#upName", "Ada"); page.fill("#upEmail", "ada@revit.test"); page.fill("#upPassword", "correct-horse-1")
        page.click("#signUpForm button[type=submit]"); page.wait_for_selector("#projectsView:not([hidden])")
        page.fill("#newProjectName", "Revit villa"); page.click("#newProjectForm button[type=submit]")
        page.click(".svc-card:has-text('Render your model')"); page.wait_for_selector("#svcStart:not([hidden])")
        assert ".rvt" in page.get_attribute("#fileInput", "accept")
        page.set_input_files("#fileInput", str(rvt))
        try:
            page.wait_for_selector("#viewerWrap:not([hidden]) canvas", timeout=30000)
        except Exception:
            print([(j["type"], j["status"], j.get("error"), j.get("result")) for j in stack["repo"].jobs.values()], errors)
            print(page.inner_text("main")[:1500])
            raise
        page.wait_for_function("document.querySelector('#modelBadge')?.textContent.includes('Ready')", timeout=60000)
        assert errors == [], errors
        browser.close()
    repo = stack["repo"]
    (job,) = [j for j in repo.jobs.values() if j["type"] == "revit_translate"]
    assert job["status"] == "succeeded"
    assert any(m["source_file_id"] == job["result"]["ifc_file_id"] for m in repo.models.values())


def test_full_film_moves_are_drawn_from_the_model(stack, tmp_path):
    """Every new camera move (side pass, top-down, through the door, through a room) gives a real view of the model."""
    ifc = tmp_path / "house.ifc"; ifc.write_bytes(build_ifc(sample_house(), seed="full"))
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(args=GL_ARGS)
        page = browser.new_page(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
        page.route("**/fonts.googleapis.com/**", lambda r: r.abort()); page.route("**/fonts.gstatic.com/**", lambda r: r.abort())
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(stack["url"] + "/app.html#sign-up")
        page.fill("#upName", "Ada"); page.fill("#upEmail", "ada@fullfilm.test"); page.fill("#upPassword", "correct-horse-1")
        page.click("#signUpForm button[type=submit]"); page.wait_for_selector("#projectsView:not([hidden])")
        page.fill("#newProjectName", "Full film"); page.click("#newProjectForm button[type=submit]")
        page.click(".svc-card:has-text('AI walkthrough')"); page.wait_for_selector("#svcStart:not([hidden])")
        page.set_input_files("#fileInput", str(ifc))
        page.wait_for_selector("#viewerWrap:not([hidden]) canvas", timeout=60000)
        page.wait_for_selector("#filmSection:not([hidden])")
        page.wait_for_function("document.querySelector('#modelBadge')?.textContent.includes('Ready')", timeout=60000)
        for kind in ("sidepass", "topdown", "entry", "interior"):
            page.select_option("#shotKind", kind)
            page.click("#addShot")
        page.wait_for_function("document.querySelectorAll('#filmShots .film-shot').length === 4", timeout=30000)
        # each first frame shows the model: not one flat colour
        spread = page.evaluate("""async () => Promise.all([...document.querySelectorAll('#filmShots img')].map(img => new Promise(ok => {
            const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = 64; c.height = 36; const g = c.getContext('2d');
              g.drawImage(i, 0, 0, 64, 36); const d = g.getImageData(0, 0, 64, 36).data; let lo = 255, hi = 0;
              for (let k = 0; k < d.length; k += 4) { const v = (d[k] + d[k + 1] + d[k + 2]) / 3; lo = Math.min(lo, v); hi = Math.max(hi, v); } ok(hi - lo); };
            i.src = img.src; })))""")
        names = page.eval_on_selector_all("#filmShots .film-shot .hint", "els => els.map(e => e.textContent)")
        import base64 as _b, os as _os
        if _os.environ.get("OLLIC_DUMP"):
            for i, src in enumerate(page.eval_on_selector_all("#filmShots img", "els => els.map(e => e.src)")):
                open(f"{_os.environ['OLLIC_DUMP']}/thumb{i}.jpg", "wb").write(_b.b64decode(src.split(",", 1)[1]))
        page.screenshot(path=str(stack["dir"].parent / "e2e-fullfilm.png"), full_page=True)
        assert errors == [], errors
        browser.close()
    assert all(s > 40 for s in spread[:3]) and spread[3] > 12, (spread, names)      # inside, the clay walls are close in tone
    assert names[3] == "Through a room: Living" and any("front door" in n for n in names), names


@pytest.mark.skipif(not __import__("os").environ.get("OLLIC_DUMP"), reason="a look at the construction stages, on request")
def test_cinematic_three_stage_views(stack, tmp_path):
    import os
    ifc = tmp_path / "villa3.ifc"; ifc.write_bytes(build_ifc(sample_house(), seed="cine3"))
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(args=GL_ARGS)
        page = browser.new_page(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
        page.route("**/fonts.googleapis.com/**", lambda r: r.abort()); page.route("**/fonts.gstatic.com/**", lambda r: r.abort())
        page.goto(stack["url"] + "/app.html#sign-up")
        page.fill("#upName", "Ada"); page.fill("#upEmail", "ada@cine3.test"); page.fill("#upPassword", "correct-horse-1")
        page.click("#signUpForm button[type=submit]"); page.wait_for_selector("#projectsView:not([hidden])")
        page.fill("#newProjectName", "Cine 3"); page.click("#newProjectForm button[type=submit]")
        page.click(".svc-card:has-text('AI walkthrough')"); page.wait_for_selector("#svcStart:not([hidden])")
        pid = page.evaluate("new URLSearchParams(location.search).get('project')")
        page.evaluate("""pid => sessionStorage.setItem('ollic-cine', JSON.stringify({ opt: 3, hero: null, heroName: 'x', project: pid, format: '16:9', title: 'Cine 3', look: '' }))""", pid)
        page.reload(); page.wait_for_selector("#svcStart:not([hidden])")
        page.set_input_files("#fileInput", str(ifc))
        page.wait_for_function("!document.querySelector('#cineGo').disabled", timeout=60000)
        page.click("#cineGo")
        page.wait_for_function("document.querySelector('#filmProgText')?.textContent.includes('All 4 parts sent')", timeout=900000)
        browser.close()
    for path, data in stack["uploads"]:
        if path.endswith(".jpg") and "/guides/" not in path:
            pass
    names = {f["storage_path"]: f["original_name"] for f in stack["repo"].files.values()}
    for path, data in stack["uploads"]:
        n = names.get(path, "")
        if n.endswith("view.jpg") and "Cine" not in n:
            open(os.path.join(os.environ["OLLIC_DUMP"], "stage-" + n.replace(" ", "_")), "wb").write(data)


def test_cinematic_two_gold_lines_then_the_building(stack, tmp_path):
    """Cinematic 2 from the image animation: gold lines drawn from the model, then the photoreal building, joined into one film."""
    ifc = tmp_path / "villa.ifc"; ifc.write_bytes(build_ifc(sample_house(), seed="cine"))
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(args=GL_ARGS)
        page = browser.new_page(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
        page.route("**/fonts.googleapis.com/**", lambda r: r.abort()); page.route("**/fonts.gstatic.com/**", lambda r: r.abort())
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(stack["url"] + "/app.html#sign-up")
        page.fill("#upName", "Ada"); page.fill("#upEmail", "ada@cine.test"); page.fill("#upPassword", "correct-horse-1")
        page.click("#signUpForm button[type=submit]"); page.wait_for_selector("#projectsView:not([hidden])")
        page.fill("#newProjectName", "Cine villa"); page.click("#newProjectForm button[type=submit]")
        page.click(".svc-card:has-text('AI walkthrough')"); page.wait_for_selector("#svcStart:not([hidden])")
        pid = page.evaluate("new URLSearchParams(location.search).get('project')")
        assert pid
        # what the image animation's "Cinematic" button leaves for the walkthrough (as if chosen there, then reloaded)
        page.evaluate("""pid => sessionStorage.setItem('ollic-cine', JSON.stringify({ opt: 2, hero: null, heroName: 'front.jpg', project: pid, format: '16:9', title: 'Cine villa', look: 'white render' }))""", pid)
        page.reload(); page.wait_for_selector("#svcStart:not([hidden])")
        assert "Cinematic: Lite construction" in page.inner_text("#svcTitle")
        page.set_input_files("#fileInput", str(ifc))
        page.wait_for_selector("#cinePanel:not([hidden])", timeout=60000)
        page.wait_for_function("!document.querySelector('#cineGo').disabled", timeout=60000)
        assert "Lite construction" in page.inner_text("#cineTitle") and page.inner_text("#filmTitle") == "Lite construction"
        # only the cinematic on the page: the walkthrough's planning, shots and film button step aside
        assert not page.is_visible("#planFullBtn") and not page.is_visible("#filmGo") and not page.is_visible("#addShot") and not page.is_visible("#filmEngine")
        assert page.is_visible("#rScene") and page.is_visible("#filmDesc")
        calls_before = len(stack["depth"].calls)
        page.click("#cineGo")
        page.wait_for_function("document.querySelector('#filmProgText')?.textContent.includes('All 3 parts sent')", timeout=600000)
        page.wait_for_function("document.querySelector('#filmTitle').textContent === 'Film your model'")   # sent: back to the walkthrough
        assert page.is_visible("#planFullBtn")
        assert errors == [], errors
        browser.close()
    repo = stack["repo"]
    for _ in range(120):
        joins = [j for j in repo.jobs.values() if j["type"] == "video_export"]
        if joins and joins[0]["status"] in ("succeeded", "failed"):
            break
        time.sleep(1)
    (join,) = joins
    assert join["status"] == "succeeded", (join["error"], [(j["type"], j["status"], j.get("error")) for j in repo.jobs.values()])
    film = repo.videos[join["result"]["video_id"]]
    parts = [repo.videos[x["video_id"]] for x in film["items"]]
    assert parts[0]["script"]["gold"] and [v["title"] for v in parts] == ["Gold lines from the foundations", "The finished building", "All the way around"]
    assert len(stack["depth"].calls) - calls_before == 2         # only the photoreal parts went to the video service
    import os as _os
    if _os.environ.get("OLLIC_DUMP"):
        for v in parts[:1] + [film]:
            open(f"{_os.environ['OLLIC_DUMP']}/{'gold' if v is parts[0] else 'film'}.mp4", "wb").write(stack["storage"].buckets["videos"][v["storage_path"]][0])
