"""End-to-end in a real browser with WebGL: an architect uploads a Revit IFC, sees it in 3D,
and renders a view of it; then uploads a floor plan, has it read, adds look references and
renders from the plan. Supabase Auth, the image model and the plan reader are stand-ins;
IFC processing is real."""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest
import uvicorn

from app.auth import TokenVerifier
from app.config import Settings
from app.jobs import ThreadRunner
from app.main import create_app

from ..conftest import SECRET, FakeImages, FakeRepo, jpeg_bytes
from ..fixtures.builder import build_ifc
from ..fixtures.layout import sample_house
from ..plan_drawing import draw_plan
from ..test_studio import FakeReader
from .test_render_flow import InlineLinkStorage
from .test_web_flow import WEB, _free_port, fake_supabase_auth

playwright = pytest.importorskip("playwright.sync_api")
GL_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    web = tmp_path_factory.mktemp("web3")
    for p in WEB.rglob("*"):
        if p.is_file():
            dest = web / p.relative_to(WEB); dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes(p.read_bytes())
    auth_port, api_port = _free_port(), _free_port()
    (web / "assets" / "config.js").write_text(f'window.OLLIC_CONFIG = {{ supabaseUrl: "http://127.0.0.1:{auth_port}", supabaseAnonKey: "anon", apiUrl: "" }};')
    settings = Settings(supabase_url=f"http://127.0.0.1:{auth_port}", supabase_anon_key="anon", supabase_jwt_secret=SECRET, web_dir=str(web),
                        cloudflare_account_id="acct", cloudflare_api_token="cf")
    repo, storage, images = FakeRepo(), InlineLinkStorage(), FakeImages()
    api = create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings), runner=ThreadRunner(),
                     image_clients={"standard": images, "premium": None}, vision=FakeReader(), prompt_writer=None)
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


def test_ifc_view_and_floor_plan_renders_in_the_browser(stack, tmp_path):
    ifc = tmp_path / "block.ifc"; ifc.write_bytes(build_ifc(sample_house(), seed="e2e"))
    plan = tmp_path / "A103.png"; plan.write_bytes(draw_plan(sample_house())[0])
    look = tmp_path / "glass-facade.jpg"; look.write_bytes(jpeg_bytes(300, 200, (80, 110, 150)))
    shots = Path(stack["dir"]).parent
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(args=GL_ARGS)
        page = browser.new_page(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
        page.route("**/fonts.googleapis.com/**", lambda r: r.abort()); page.route("**/fonts.gstatic.com/**", lambda r: r.abort())
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(stack["url"] + "/app.html#sign-up")
        page.fill("#upName", "Ada"); page.fill("#upEmail", "ada@model.test"); page.fill("#upPassword", "correct-horse-1")
        page.click("#signUpForm button[type=submit]"); page.wait_for_selector("#projectsView:not([hidden])")
        page.fill("#newProjectName", "Maitama block"); page.click("#newProjectForm button[type=submit]")
        page.click(".svc-card:has-text('Render your Revit model')"); page.wait_for_selector("#svcStart:not([hidden])")
        assert page.get_attribute("#fileInput", "accept") == ".ifc"
        assert "Make 3D model" not in page.content()   # the plan-to-model tools are gone

        # 1. Revit IFC: imported automatically, shown in 3D, report
        page.set_input_files("#fileInput", str(ifc))
        page.wait_for_selector("#viewerWrap:not([hidden]) canvas", timeout=60000)
        page.wait_for_function("document.querySelector('#reportCard h3')?.textContent.includes('ready to use')", timeout=30000)
        assert "26 elements" in page.inner_text("#reportCard")
        (model,) = stack["repo"].models.values()
        assert model["report"]["read_on"] == "browser" and model["job_id"] is None      # read on this computer, not by the server
        assert not any(j["type"] == "ifc_import" for j in stack["repo"].jobs.values())
        # only this service's views: outside and inside, no walk or construction
        assert page.is_visible("#viewInside") and not page.is_visible("#viewWalk") and not page.is_visible("#viewBuild") and page.is_visible("#studio")
        page.click("#viewInside"); page.wait_for_timeout(500)
        assert page.locator(".viewer-labels span").count() == 5
        page.click("#viewOutside"); page.wait_for_timeout(500)
        page.locator("#viewer").screenshot(path=str(shots / "e2e-3d-outside.png"))

        # 2. "Render this view": the view is saved and chosen as the shape to keep
        page.click("#useView")
        page.wait_for_function("document.querySelector('#rBase').selectedOptions[0]?.textContent.startsWith('3D view')", timeout=30000)
        page.fill("#rPrompt", "White render, bronze glazing, timber soffits"); page.click("#renderBtn")
        page.wait_for_selector(".shot img", timeout=30000)
        call = stack["images"].calls[-1]
        assert "plain 3D view of the architect's model" in call["prompt"] and len(call["images"]) == 1

        # 3. Floor plan: read by AI, look reference added, rendered from the plan
        page.set_input_files("#fileInput", str(plan)); page.wait_for_function("document.querySelectorAll('#rPlan option').length === 3")
        page.set_input_files("#fileInput", str(look)); page.wait_for_selector("#rLooks input[type=checkbox] >> nth=2")
        page.select_option("#rPlan", label="A103.png"); page.select_option("#rBase", value="")
        page.fill("#rPrompt", "")
        page.click("#readPlanBtn")
        page.wait_for_function("document.querySelector('#rPrompt').value.includes('6-storey residential apartment block')", timeout=20000)
        assert page.input_value("#rStoreys") == "6" and "Read by AI" in page.inner_text("#planNote")
        page.check("#rLooks label:has-text('glass-facade.jpg') input")
        page.select_option("#rStyle", "luxury contemporary"); page.select_option("#rGround", "car park")
        page.fill("#rPrompt", page.input_value("#rPrompt") + " Cantilevered penthouse.")
        page.screenshot(path=str(shots / "e2e-studio.png"), full_page=True)
        page.click("#renderBtn")
        page.wait_for_function("document.querySelectorAll('.shot').length === 2", timeout=30000)
        call = stack["images"].calls[-1]
        assert len(call["images"]) == 2
        p_ = call["prompt"]
        assert "Image 1 is the architect's floor plan" in p_ and "Image 2 is a reference for the look" in p_
        assert "6 floors above a ground-floor car park" in p_ and "Cantilevered penthouse" in p_
        card = page.inner_text(".shot >> nth=0").upper()
        assert "STANDARD RENDER" in card and "AI CONCEPT" in card

        page.set_viewport_size({"width": 390, "height": 844}); page.wait_for_timeout(300)
        page.screenshot(path=str(shots / "e2e-studio-phone.png"), full_page=True)
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        assert errors == [], errors
        browser.close()
