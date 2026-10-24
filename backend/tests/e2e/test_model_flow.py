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
    from ..test_prompting import FakeRenderPrompter
    writer = FakeRenderPrompter()
    api = create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings), runner=ThreadRunner(),
                     image_clients={"standard": images, "premium": None}, vision=FakeReader(), prompt_writer=writer)
    auth = fake_supabase_auth()
    from fastapi.middleware.cors import CORSMiddleware
    auth.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    servers = [uvicorn.Server(uvicorn.Config(a, host="127.0.0.1", port=p, log_level="warning")) for a, p in ((auth, auth_port), (api, api_port))]
    for s in servers:
        threading.Thread(target=s.run, daemon=True).start()
    for s in servers:
        while not s.started:
            time.sleep(0.05)
    yield {"url": f"http://127.0.0.1:{api_port}", "repo": repo, "storage": storage, "images": images, "dir": web, "writer": writer}
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
        page.click(".svc-card:has-text('Render your model')"); page.wait_for_selector("#svcStart:not([hidden])")
        assert page.get_attribute("#fileInput", "accept") == ".ifc,.rvt"
        assert "Make 3D model" not in page.content()   # the plan-to-model tools are gone

        # 1. Revit IFC: imported automatically, shown in 3D, report
        page.set_input_files("#fileInput", str(ifc))
        page.wait_for_selector("#viewerWrap:not([hidden]) canvas", timeout=60000)
        page.wait_for_function("document.querySelector('#reportCard h3')?.textContent.includes('ready to use')", timeout=30000)
        # the model check is one small badge; the details open only when asked for
        assert not page.is_visible("#modelDetails") and "Ready" in page.inner_text("#modelBadge") and "parts" in page.inner_text("#modelBadge")
        page.click("#modelBadge"); assert "26 elements" in page.inner_text("#reportCard") and page.is_visible("#dlGlb")
        page.click("#modelBadge"); assert not page.is_visible("#modelDetails")
        (model,) = stack["repo"].models.values()
        assert model["report"]["read_on"] == "browser" and model["job_id"] is None      # read on this computer, not by the server
        assert not any(j["type"] == "ifc_import" for j in stack["repo"].jobs.values())
        # this service's views: outside, inside and walk; Capture view, not the walkthrough's shot button
        assert page.is_visible("#viewInside") and page.is_visible("#viewWalk") and page.is_visible("#studio")
        assert page.is_visible("#useView") and not page.is_visible("#addShotView") and not page.is_visible("#filmSection")
        page.click("#viewInside"); page.wait_for_timeout(500)
        assert page.locator(".viewer-labels span").count() == 5
        page.click("#viewOutside"); page.wait_for_timeout(500)
        page.screenshot(path=str(shots / "e2e-3d-outside.png"), clip=(page.locator("#viewer").scroll_into_view_if_needed() or page.locator("#viewer").bounding_box()), timeout=120000)

        # 2. "Capture view": the view goes into the render box; the AI reads it (and the model) and writes the prompt
        page.click("#useView")
        page.wait_for_selector("#rPics .rpic.on", timeout=30000)
        assert "Captured view" in page.inner_text("#rPics .rpic.on") and "3D view" in page.inner_text("#rPicHint")
        page.fill("#rDesc", "luxury bungalow, white render, bronze glazing, timber soffits")
        page.click("#writePromptBtn")
        page.wait_for_function("document.querySelector('#rPrompt').value.includes('eight-storey')", timeout=20000)
        assert "AI:" in page.inner_text("#planNote")
        system, content = stack["writer"].calls[-1]
        texts = " ".join(b["text"] for b in content if b["type"] == "text")
        assert "VIEW TO RENDER: a plain, untextured view captured from the architect's BIM model" in texts and "Storeys in the model" in texts and "luxury bungalow" in texts
        page.click("#renderBtn")
        page.wait_for_selector(".shot img", timeout=30000)
        first, retry = stack["images"].calls[-2:]
        assert first["prompt"].startswith("Photorealistic render of the eight-storey block") and len(first["images"]) == 2
        # the capture saved the model's material map too: it goes second, with what each colour stands for
        assert "Image 2 is the MATERIAL MAP" in first["prompt"] and "in the map = " in first["prompt"]
        # the stand-in image service returns a picture unlike the model: the check finds the drift and renders once more, geometry first
        assert retry["prompt"].startswith("Most important: Image 1 is an exact view of the architect's model")
        # the capture saved the model's exact line drawing too, and the render was checked against it
        guide = next(f for f in stack["repo"].files.values() if f["original_name"].startswith("Guide - 3D view") and f["original_name"].endswith("lines.png"))
        (job,) = [j for j in stack["repo"].jobs.values() if j["type"] == "concept_render"]
        assert job["input"]["guide_file_id"] == guide["id"]
        (img,) = stack["repo"].images.values()
        assert img["options"]["check"]["band"] == "poor" and img["options"]["check"]["retried"] is True
        page.wait_for_selector(".shot .chip[class*=check-]")
        assert "model" in page.inner_text(".shot .chip[class*=check-]").lower()
        assert not page.locator("#rPics .rpic-name:has-text('Guide')").count()       # guides are not offered as pictures
        names = {f["original_name"].rsplit(" - ", 1)[-1] for f in stack["repo"].files.values() if f["original_name"].startswith("Guide - ")}
        assert names == {"lines.png", "depth.png", "materials.png"} and job["input"]["material_file_id"] and job["input"]["depth_file_id"]

        # the project look: the model's materials are listed; the architect names one and approves the render as the hero
        page.click("#lookCard summary")
        assert page.locator("#lookMats .look-mat").count() >= 2
        page.fill("#lookMats .look-mat >> nth=0 >> input[aria-label='Material name']", "Sandtex white render")
        page.fill("#lookSetting", "Maitama avenue, palm trees, late afternoon sun")
        page.click("#lookSave"); page.wait_for_function("document.querySelector('#lookMsg').textContent.includes('Saved')")
        page.click(".shot button:has-text('Use as project look')")
        page.wait_for_selector(".shot .chip:has-text('Project look')")
        (pr,) = stack["repo"].projects.values()
        assert pr["look"]["materials"][0]["name"] == "Sandtex white render" and pr["look"]["hero_render_id"] == img["id"]
        assert page.is_visible(".shot .chip:has-text('Materials')")

        # 3. a reference image: uploaded in the render box, ticked, and sent second
        page.set_input_files("#rRefUpload", str(look))
        page.wait_for_selector("#rRefs .rpic.on")
        page.click("#writePromptBtn")
        page.wait_for_function("document.querySelector('#planNote').textContent.includes('AI:')", timeout=20000)
        system, content = stack["writer"].calls[-1]
        assert sum(1 for b in content if b["type"] == "image") == 2 and any("Image 2 is a REFERENCE" in b.get("text", "") for b in content)
        page.screenshot(path=str(shots / "e2e-studio.png"), full_page=True)
        page.click("#renderBtn")
        page.wait_for_function("document.querySelectorAll('.shot').length === 2", timeout=30000)
        call = stack["images"].calls[-1]
        # the model view, its material map, the approved hero render and the reference
        assert len(call["images"]) == 4 and len(stack["images"].calls) >= 4
        assert "Image 3 is the APPROVED LOOK" in call["prompt"] and "Sandtex white render" in call["prompt"] and "Maitama avenue" in call["prompt"]
        card = page.inner_text(".shot >> nth=0").upper()
        assert "STANDARD RENDER" in card and "AI CONCEPT" in card

        page.set_viewport_size({"width": 390, "height": 844}); page.wait_for_timeout(300)
        page.screenshot(path=str(shots / "e2e-studio-phone.png"), full_page=True)
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        assert errors == [], errors
        browser.close()
