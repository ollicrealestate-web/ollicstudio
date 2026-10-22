"""End-to-end, Phases 3 and 3b in a real browser with WebGL: an IFC upload becomes a 3D
model with its report; a floor plan image is read, reviewed and built into a 3D model.
Supabase Auth and the vision model are stand-ins; IFC processing and plan reading are real."""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest
import uvicorn

from app.auth import TokenVerifier
from app.bim.builder import build_ifc
from app.bim.layout import sample_house
from app.config import Settings
from app.jobs import ThreadRunner
from app.main import create_app

from ..conftest import SECRET, FakeRepo
from ..plan_drawing import draw_plan
from ..test_bim import FakeVision, labels_for
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
    settings = Settings(supabase_url=f"http://127.0.0.1:{auth_port}", supabase_anon_key="anon", supabase_jwt_secret=SECRET, web_dir=str(web))
    png, meta = draw_plan(sample_house())
    repo, storage = FakeRepo(), InlineLinkStorage()
    api = create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings), runner=ThreadRunner(), vision=FakeVision(labels_for(meta)))
    auth = fake_supabase_auth()
    from fastapi.middleware.cors import CORSMiddleware
    auth.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    servers = [uvicorn.Server(uvicorn.Config(a, host="127.0.0.1", port=p, log_level="warning")) for a, p in ((auth, auth_port), (api, api_port))]
    for s in servers:
        threading.Thread(target=s.run, daemon=True).start()
    for s in servers:
        while not s.started:
            time.sleep(0.05)
    yield {"url": f"http://127.0.0.1:{api_port}", "repo": repo, "storage": storage, "dir": web, "plan": png}
    for s in servers:
        s.should_exit = True


def test_ifc_and_floor_plan_to_3d_in_the_browser(stack, tmp_path):
    ifc = tmp_path / "bungalow.ifc"; ifc.write_bytes(build_ifc(sample_house(), seed="e2e"))
    plan = tmp_path / "ground-floor.png"; plan.write_bytes(stack["plan"])
    shots = Path(stack["dir"]).parent
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(args=GL_ARGS)
        page = browser.new_page(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
        page.route("**/fonts.googleapis.com/**", lambda r: r.abort()); page.route("**/fonts.gstatic.com/**", lambda r: r.abort())
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(stack["url"] + "/app.html#sign-up")
        page.fill("#upName", "Ada"); page.fill("#upEmail", "ada@model.test"); page.fill("#upPassword", "correct-horse-1")
        page.click("#signUpForm button[type=submit]"); page.wait_for_selector("#projectsView:not([hidden])")
        page.fill("#newProjectName", "Ikoyi bungalow"); page.click("#newProjectForm button[type=submit]")
        page.wait_for_selector("#modelEmpty:not([hidden])")

        # 1. a Revit-style IFC: uploaded, imported automatically, shown in 3D with its report
        page.set_input_files("#fileInput", str(ifc))
        page.wait_for_selector("#viewerWrap:not([hidden]) canvas", timeout=60000)
        page.wait_for_function("document.querySelector('#reportCard h3')?.textContent.includes('ready to use')", timeout=30000)
        report = page.inner_text("#reportCard")
        assert "26 elements" in report and "No MEP elements" in report and "Lengths in metres" in report
        page.wait_for_timeout(1200)
        page.locator("#viewer").screenshot(path=str(shots / "e2e-3d-outside.png"))
        page.click("#viewInside"); page.wait_for_timeout(800)
        assert page.locator(".viewer-labels span").count() == 5
        page.locator("#viewer").screenshot(path=str(shots / "e2e-3d-inside.png"))
        # tapping the building tells you what you tapped
        box = page.locator("#viewer canvas").bounding_box()
        page.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.62)
        page.wait_for_timeout(300)

        # 2. a floor plan image: read, reviewed, built
        page.set_input_files("#fileInput", str(plan))
        page.wait_for_selector("text=Make 3D model")
        page.click("#fileRows button:has-text('Make 3D model')")
        page.wait_for_selector("#planReview:not([hidden]) .pe-svg", timeout=60000)
        assert page.locator(".pe-wall").count() == 8 and page.locator(".pe-open.door").count() == 5 and page.locator(".pe-open.window").count() == 6
        assert page.locator(".pe-label").count() == 5 and "Living" in page.text_content(".pe-svg")
        # the customer corrects the scale with a wall they know: the top wall is 12 m centre to centre
        page.locator(".pe-stage").scroll_into_view_if_needed()
        wb = page.locator(".pe-wall.ext").first.bounding_box()   # the top wall; tap a stretch with no window
        page.mouse.click(wb["x"] + wb["width"] * 0.72, wb["y"] + wb["height"] / 2)
        page.fill("input[aria-label='Real length of this wall in metres']", "12")
        page.keyboard.press("Tab")
        assert "You" in page.inner_text(".pe-side")
        page.screenshot(path=str(shots / "e2e-plan-review.png"), full_page=True)
        page.click("button:has-text('Build 3D model')")
        page.wait_for_function("document.querySelector('#reportCard')?.textContent.includes('from your confirmed floor plan')", timeout=60000)
        assert "26 elements" in page.inner_text("#reportCard")
        assert "MADE BY OLLIC" in page.inner_text("#fileRows").upper()
        page.wait_for_timeout(1200)
        page.locator("#viewer").screenshot(path=str(shots / "e2e-3d-from-plan.png"))

        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(300)
        page.click("#viewReset"); page.click("#viewOutside"); page.wait_for_timeout(500)
        page.locator("#viewer").screenshot(path=str(shots / "e2e-3d-phone-viewer.png"))
        wide = page.evaluate("""[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('.table-wrap table')).map(e => e).slice(0, 12).map(e => e.tagName + '.' + (e.className.baseVal ?? e.className) + '#' + e.id + ' ' + getComputedStyle(e).position + ' ' + Math.round(e.getBoundingClientRect().right))""")
        page.screenshot(path=str(shots / "e2e-3d-phone.png"), full_page=True)
        sizes = page.evaluate("[document.documentElement.scrollWidth, window.innerWidth, document.body.scrollWidth, ...[...document.querySelectorAll('.table-wrap,.pe-stage,.pe-body,.viewer,.model,#projectView,main')].map(e => e.className + e.id + ':' + Math.round(e.getBoundingClientRect().width))]")
        hunt = page.evaluate("""(() => { const out = []; for (const e of document.querySelectorAll('*')) { const r = e.getBoundingClientRect(); if (r.right > 1000) out.push(e.tagName + '.' + (e.className.baseVal ?? e.className) + ' ' + Math.round(r.left) + '-' + Math.round(r.right) + ' ' + getComputedStyle(e).position); } return out.slice(0, 15); })()""")
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), (hunt, sizes)
        assert errors == [], errors
        browser.close()
