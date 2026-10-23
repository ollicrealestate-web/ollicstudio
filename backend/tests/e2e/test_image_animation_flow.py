"""End-to-end: an architect animates 3D images: the AI makes one photoreal,
another is used as it is, the gold-line-to-photoreal animation previews, and a 1:1 MP4 is exported,
checked, converted and saved. Supabase Auth and the image model are stand-ins; the browser's
drawing and video encoder and FFmpeg are real."""

from __future__ import annotations

import io
import shutil
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from .servers import stack  # noqa: F401  (the test servers)

playwright = pytest.importorskip("playwright.sync_api")
pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is not installed")


def building_png(w=900, h=600, seed=0) -> bytes:
    """A simple 3D-style view of a block: facade, floors, windows, roof."""
    im = Image.new("RGB", (w, h), (205, 214, 226)); d = ImageDraw.Draw(im)
    d.rectangle([0, int(h * 0.78), w, h], fill=(120, 124, 118))
    x0, x1, y0, y1 = int(w * 0.25), int(w * 0.75), int(h * 0.2), int(h * 0.8)
    d.rectangle([x0, y0, x1, y1], fill=(236, 233, 226), outline=(70, 70, 70), width=3)
    d.polygon([(x0 - 20, y0), ((x0 + x1) // 2, y0 - 70), (x1 + 20, y0)], fill=(90, 84, 80), outline=(50, 50, 50))
    for fl in range(4):
        y = y0 + 20 + fl * (y1 - y0 - 40) // 4
        d.line([x0, y - 10, x1, y - 10], fill=(110, 110, 110), width=2)
        for k in range(5):
            wx = x0 + 25 + k * (x1 - x0 - 50) // 5
            d.rectangle([wx, y, wx + 40, y + 50], fill=(70, 100, 140), outline=(40, 40, 40), width=2)
    b = io.BytesIO(); im.save(b, "PNG"); return b.getvalue()


def test_animation_from_3d_images(stack, tmp_path):  # noqa: F811
    a = tmp_path / "front view.png"; a.write_bytes(building_png())
    b2 = tmp_path / "lumion render.png"; b2.write_bytes(building_png(seed=1))
    shots = Path(stack["dir"]).parent
    calls_before = len(stack["images"].calls)
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
        page.route("**/fonts.googleapis.com/**", lambda r: r.abort()); page.route("**/fonts.gstatic.com/**", lambda r: r.abort())
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(stack["url"] + "/app.html#sign-up")
        page.fill("#upName", "Ada"); page.fill("#upEmail", "ada@image.test"); page.fill("#upPassword", "correct-horse-1")
        page.click("#signUpForm button[type=submit]"); page.wait_for_selector("#projectsView:not([hidden])")
        page.fill("#newProjectName", "Lekki tower"); page.click("#newProjectForm button[type=submit]")
        page.click(".svc-card:has-text('Animation from a 3D image')"); page.wait_for_selector("#svcStart:not([hidden])")
        page.set_input_files("#fileInput", [str(a), str(b2)])
        page.wait_for_selector("#imgAnimSection:not([hidden])")
        page.wait_for_function("document.querySelectorAll('#iaPick .ia-item').length === 2", timeout=30000)
        assert page.is_visible("#tierSlotIA #tierPick") and not page.is_visible("#studio")    # the AI version choice is on this screen
        page.uncheck("#iaPick .ia-item >> nth=1 >> text=Animate this")      # both uploads were ticked; start with the first

        # tick the first: it needs a photoreal view
        page.check("#iaPick .ia-item >> nth=0 >> text=Animate this")
        page.wait_for_function("document.querySelector('#iaEst').textContent.includes('Make the photoreal views first')")
        assert page.is_disabled("#iaExport")
        page.fill("#iaLook", "white render, bronze glass, palm trees")
        page.click("#iaMake")
        # the photoreal view, then (automatically) its clean line drawing, made from it
        page.wait_for_function("document.querySelector('#iaPick .ia-item').textContent.includes('Photoreal + lines ready')", timeout=60000)
        photo, line = stack["images"].calls[-2:]
        assert len(stack["images"].calls) == calls_before + 2 and "Keep the building's exact shape" in photo["prompt"] and "bronze glass" in photo["prompt"]
        assert line["kind"] == "edit" and "line drawing" in line["prompt"]
        tags = [i["options"].get("anim_line") for i in stack["repo"].images.values() if i["options"].get("anim_line")]
        assert len(tags) == 1 and tags[0]["key"].startswith("img-")
        page.wait_for_selector("#iaStage:not([hidden])")
        # a cinematic clip (paid plans; this is an owner/test account): gold lines -> photoreal, made by the video service
        uid = next(p["owner_id"] for p in stack["repo"].projects.values() if p["name"] == "Lekki tower")
        stack["repo"].roles[uid] = "admin"
        assert "$0.84" in page.inner_text("#iaClipOpts")
        page.click("#iaPick .ia-item >> nth=0 >> button:has-text('Cinematic clip')")
        page.wait_for_function("[...document.querySelectorAll('#iaVideos .video-card')].some(c => c.textContent.toUpperCase().includes('AI VIDEO'))", timeout=60000)
        clip = next(v for v in stack["repo"].videos.values() if v["kind"] == "cinematic")
        assert clip["title"] == "Lekki tower" and clip["items"][0]["kind"] == "lines"
        # the second is a finished render already: used as it is, no AI call
        page.check("#iaPick .ia-item >> nth=1 >> text=Already photoreal")
        page.check("#iaPick .ia-item >> nth=1 >> text=Animate this")
        page.wait_for_function("document.querySelector('#iaTime').textContent.includes('0:20')")    # 2 images x 10 s
        assert len(stack["images"].calls) == calls_before + 2
        page.fill("#iaScrub", "1300"); page.dispatch_event("#iaScrub", "input")     # image 2, lines drawing (first 42% of its 10 s)
        assert "Drawing" in page.inner_text("#iaTime")
        page.locator("#iaFrame").screenshot(path=str(shots / "e2e-image-anim-lines.png"))
        page.fill("#iaScrub", "1620"); page.dispatch_event("#iaScrub", "input")     # the light line mid-sweep
        assert "Completed building" in page.inner_text("#iaTime")
        page.locator("#iaFrame").screenshot(path=str(shots / "e2e-image-anim-sweep.png"))

        # export: one image, square, 6 s
        page.uncheck("#iaPick .ia-item >> nth=0 >> text=Animate this")
        page.select_option("#iaFormat", "1:1"); page.fill("#iaSeconds", "6"); page.dispatch_event("#iaSeconds", "change")
        page.wait_for_function("document.querySelector('#iaTime').textContent.includes('0:06')")
        page.fill("#iaTitle2", "Lekki tower")
        page.screenshot(path=str(shots / "e2e-image-anim.png"), full_page=True)
        before = len(stack["repo"].videos)
        page.click("#iaExport")
        page.wait_for_function(f"document.querySelectorAll('#iaVideos .video-card').length > {before}", timeout=900000)
        vid = max(stack["repo"].videos.values(), key=lambda v: v["created_at"])
        assert vid["kind"] == "construction" and (vid["width"], vid["height"]) == (1080, 1080) and vid["title"] == "Lekki tower"
        assert abs(float(vid["duration_s"]) - 12) < 0.2              # 3 s card + 6 s + 3 s card
        (shots / "e2e-image-anim.mp4").write_bytes(stack["storage"].buckets["videos"][vid["storage_path"]][0])
        page.set_viewport_size({"width": 390, "height": 844}); page.wait_for_timeout(300)
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        assert errors == [], errors
        browser.close()
