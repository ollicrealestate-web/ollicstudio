"""End-to-end in a real browser: the construction animation follows a Microsoft Project
programme. The architect uploads the IFC, then the schedule; the tasks are matched to the
model's floors and parts, the build runs on the programme's dates, and a match can be changed."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from ..fixtures.villa import build_villa_ifc
from ..test_schedule import msp_xml
from .test_construction_flow import stack  # noqa: F401  (the same servers)
from .test_model_flow import GL_ARGS

playwright = pytest.importorskip("playwright.sync_api")


def test_animation_follows_the_programme(stack, tmp_path):  # noqa: F811
    ifc = tmp_path / "villa.ifc"; ifc.write_bytes(build_villa_ifc("prog"))
    xml = tmp_path / "villa-programme.xml"; xml.write_bytes(msp_xml())
    shots = Path(stack["dir"]).parent
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(args=GL_ARGS)
        page = browser.new_page(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
        page.route("**/fonts.googleapis.com/**", lambda r: r.abort()); page.route("**/fonts.gstatic.com/**", lambda r: r.abort())
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
        # a slow connection: the 3D model takes 4 s to download after its report is shown
        # (stored files arrive as data: links in this test; a 3D model's starts with "glTF", base64 "Z2xURg")
        page.add_init_script("""{ const f = window.fetch; window.fetch = (u, o) => { const x = String(u?.url || u); return x.startsWith('data:') && x.includes(';base64,Z2xURg')
          ? new Promise(r => setTimeout(r, 4000)).then(() => f(u, o)) : f(u, o); }; }""")
        page.goto(stack["url"] + "/app.html#sign-up")
        page.fill("#upName", "Bo"); page.fill("#upEmail", "bo@build.test"); page.fill("#upPassword", "correct-horse-1")
        page.click("#signUpForm button[type=submit]"); page.wait_for_selector("#projectsView:not([hidden])")
        page.fill("#newProjectName", "Programme villa"); page.click("#newProjectForm button[type=submit]")
        page.wait_for_selector("#modelEmpty:not([hidden])")
        page.set_input_files("#fileInput", str(ifc))
        page.wait_for_selector("#viewerWrap:not([hidden]) canvas", timeout=60000)
        page.wait_for_function("document.querySelector('#reportCard h3')?.textContent.includes('ready to use')", timeout=30000)
        page.click("#viewBuild")                      # too early: the model is still downloading
        page.wait_for_function("document.body.textContent.includes('still loading')")
        assert page.is_hidden("#animPanel")
        page.wait_for_timeout(5000)
        page.click("#viewBuild"); page.wait_for_selector("#animPanel:not([hidden])")
        assert "usual order" in page.inner_text("#progNote")

        page.set_input_files("#progFile", str(xml))
        page.wait_for_function("document.querySelector('#progNote').textContent.includes('Following your programme')", timeout=30000)
        note = page.inner_text("#progNote")
        assert "8 tasks" in note and "40 s" in note and "7 tasks build parts" in note
        chapters = [c.lower() for c in page.locator("#animChapters button").all_text_contents()]
        assert chapters[:2] == ["site", "programme"]
        assert page.evaluate("document.querySelector('#progWrap').open")      # opened by itself: one task is not matched
        rows = page.locator("#progRows tr")
        assert rows.count() == 8
        row = lambda n: rows.filter(has=page.locator("td:first-child", has_text=re.compile(f"^{n}$")))
        cols = row("Columns")
        assert cols.locator("select").nth(0).input_value() == "structure" and cols.locator("select").nth(2).input_value() == "Ground floor"
        assert int(cols.locator("td").nth(4).inner_text()) > 0                       # the ground-floor columns are built by this task
        # 13 Feb 2027 is inside "Columns" (8-19 Feb): site 3 s, then 40 s for 4 Jan - 30 Jun (178 days)
        t = 3 + 40 * (40 / 178)
        page.fill("#animScrub", str(round(t * 100))); page.dispatch_event("#animScrub", "input")
        label = page.inner_text("#animTime")
        assert "Feb 2027" in label and "Columns" in label, label
        page.locator("#viewer").screenshot(path=str(shots / "e2e-programme.png"))
        # move the blockwork to the first floor: it then builds the first-floor walls
        wall = row("Blockwork")
        wall.locator("select").nth(2).select_option("First floor")
        assert row("Blockwork").locator("select").nth(2).input_value() == "First floor" and int(row("Blockwork").locator("td").nth(4).inner_text()) > 0
        saved = page.evaluate("JSON.parse(localStorage.getItem('ollic-anim-' + new URLSearchParams(location.search).get('project')))")
        assert next(x for x in saved["schedule"] if x["name"] == "Blockwork")["floors"] == ["First floor"]
        page.fill("#progSeconds", "20"); page.dispatch_event("#progSeconds", "change")
        assert "0:25" in page.inner_text("#animTime") or "20 s" in page.inner_text("#progNote")
        page.click("#progClear")
        assert "usual order" in page.inner_text("#progNote") and "structure" in [c.lower() for c in page.locator("#animChapters button").all_text_contents()]
        page.set_viewport_size({"width": 390, "height": 844}); page.wait_for_timeout(300)
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        assert errors == [], errors
        browser.close()
