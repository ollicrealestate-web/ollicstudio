"""The project look (approved materials from the model, the hero render), the material check, and
Ollic Exact (renders drawn on the model's own depth map)."""

from __future__ import annotations

import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app.auth import TokenVerifier
from app.jobs import InlineRunner
from app.look import Look, Material, colour_name, material_check, merge_groups
from app.main import create_app

from .conftest import FakeImages
from .test_studio import new_project, upload

WALL, PANEL = "#e6194b", "#3cb44b"        # map colours (as the viewer draws them)
GROUPS = [{"key": "paint|#f2f2f2", "cls": "paint", "hex": "#f2f2f2", "map": WALL},
          {"key": "paint|#d9c39a", "cls": "paint", "hex": "#d9c39a", "map": PANEL},
          {"key": "glass|#9fb4c4", "cls": "glass", "hex": "#9fb4c4", "map": "#4363d8"}]


def picture(wall, panel, size=(600, 400), shade=1.0) -> Image.Image:
    """A facade: a wall with a panel in it, in the given colours (and lit a little differently)."""
    im = Image.new("RGB", size, (150, 190, 230)); d = ImageDraw.Draw(im)
    def lit(h): return tuple(min(255, int(int(h[i:i + 2], 16) * shade)) for i in (1, 3, 5))
    d.rectangle([100, 60, 500, 380], fill=lit(wall)); d.rectangle([340, 80, 480, 360], fill=lit(panel))
    return im


def png(im: Image.Image) -> bytes:
    b = io.BytesIO(); im.save(b, "PNG"); return b.getvalue()


def jpg(im: Image.Image) -> bytes:
    b = io.BytesIO(); im.convert("RGB").save(b, "JPEG", quality=92); return b.getvalue()


def test_materials_come_from_the_model_and_keep_the_architects_names():
    look = merge_groups(Look(), GROUPS)
    assert [m.name for m in look.materials] == ["White painted finish", "Beige painted finish", "Blue glass"]
    look.materials[1].name, look.materials[1].finish, look.materials[1].hex = "Sandstone cladding", "honed, 600 x 300 panels", "#c8a876"
    again = merge_groups(look, [g | {"map": "#000075"} if g["cls"] == "glass" else g for g in GROUPS])
    assert again.materials[1].name == "Sandstone cladding" and again.materials[1].hex == "#c8a876" and again.materials[2].map == "#000075"
    assert colour_name("#ffffff") == "white" and colour_name("#5a3a22") == "brown"


def test_the_material_check_finds_a_wrong_colour_but_allows_light_and_shade():
    m = merge_groups(Look(), GROUPS).materials
    the_map = picture(WALL, PANEL)
    good = material_check(the_map, picture("#f2f2f2", "#d9c39a", shade=0.88), m)       # same materials in softer light
    assert good["score"] == 1.0 and all(x["ok"] for x in good["materials"])
    bad = material_check(the_map, picture("#f2f2f2", "#3a5f8a"), m)                     # the panels came out blue
    panel = next(x for x in bad["materials"] if x["key"] == "paint|#d9c39a")
    assert not panel["ok"] and bad["score"] < 0.8 and panel["seen"] == "#3a5f8a"


@pytest.fixture
def look_app(render_settings, repo, storage):
    def make(images=None, exact=None, writer=None):
        images = images or FakeImages()
        app = create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=images, runner=InlineRunner(),
                         fal={"images": images, "exact": exact} if exact else {}, kling=None, gemini=None, runway=None, aps=None, prompt_writer=writer)
        return TestClient(app), images
    return make


def captured(c, user, pid):
    """A captured model view with its guides, as the browser uploads them."""
    view = upload(c, user, pid, "3D view 1.jpg", jpg(picture("#f2f2f2", "#d9c39a")))
    lines = upload(c, user, pid, "Guide - 3D view 1 - lines.png", png(picture("#000000", "#ffffff")))
    depth = upload(c, user, pid, "Guide - 3D view 1 - depth.png", png(picture("#808080", "#c0c0c0")))
    mats = upload(c, user, pid, "Guide - 3D view 1 - materials.png", png(picture(WALL, PANEL)))
    return view, lines, depth, mats


def test_a_model_render_uses_the_approved_materials_and_hero(look_app, alice, bob, repo):
    c, images = look_app()
    repo.plans[alice["id"]] = "premium"
    pid = new_project(c, alice)
    view, lines, depth, mats = captured(c, alice, pid)
    look = c.post(f"/api/projects/{pid}/look/materials", json={"groups": GROUPS}, headers=alice["headers"]).json()
    look["materials"][1] |= {"name": "Sandstone cladding", "finish": "honed, 600 x 300 panels", "hex": "#c8a876"}
    look["setting"] = "Lekki street, palm trees, late afternoon"
    assert c.put(f"/api/projects/{pid}/look", json=look, headers=alice["headers"]).status_code == 200
    body = {"prompt": "photoreal render of the villa", "prompt_ready": True, "references": [{"file_id": view["id"], "role": "model"}],
            "guide_file_id": lines["id"], "material_file_id": mats["id"], "depth_file_id": depth["id"]}
    r = c.post(f"/api/projects/{pid}/architectural-render", json=body, headers=alice["headers"])
    assert r.status_code == 202 and repo.jobs[r.json()["id"]]["status"] == "succeeded"
    call = images.calls[0]
    assert len(call["images"]) == 2 and "Image 2 is the MATERIAL MAP" in call["prompt"]
    assert "red (#e6194b) in the map = White painted finish" in call["prompt"] and "Sandstone cladding: honed, 600 x 300 panels; colour #c8a876" in call["prompt"]
    assert "Setting for every view: Lekki street, palm trees, late afternoon." in call["prompt"] and call["prompt"].rstrip().endswith("watermarks.")
    (img,) = repo.images.values()
    assert "materials" in img["options"]["check"]          # the stand-in picture is checked material by material

    # the architect approves that render as the hero: the next view is sent with it
    look["hero_render_id"] = img["id"]
    assert c.put(f"/api/projects/{pid}/look", json=look, headers=alice["headers"]).json()["hero_render_id"] == img["id"]
    c.post(f"/api/projects/{pid}/architectural-render", json=body, headers=alice["headers"])
    later = images.calls[-1]
    assert len(later["images"]) == 3 and "Image 3 is the APPROVED LOOK" in later["prompt"] and "camera only from Image 1" in later["prompt"]
    # someone else's render cannot be the hero; someone else cannot read the look
    other = new_project(c, bob)
    assert c.put(f"/api/projects/{other}/look", json={"hero_render_id": img["id"]}, headers=bob["headers"]).status_code == 404
    assert c.get(f"/api/projects/{pid}/look", headers=bob["headers"]).status_code == 404


def test_ollic_exact_draws_on_the_models_depth(look_app, alice, repo):
    exact = FakeImages()
    c, images = look_app(exact=exact, writer=FakeChecker())        # Claude finds a floor missing in the Exact picture
    repo.roles[alice["id"]] = "admin"
    pid = new_project(c, alice)
    view, lines, depth, mats = captured(c, alice, pid)
    c.post(f"/api/projects/{pid}/look/materials", json={"groups": GROUPS}, headers=alice["headers"])
    base = {"prompt": "photoreal render", "prompt_ready": True, "tier": "exact", "references": [{"file_id": view["id"], "role": "model"}]}
    r = c.post(f"/api/projects/{pid}/architectural-render", json=base, headers=alice["headers"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "exact_needs_model"      # no guide from the model
    base["guide_file_id"] = lines["id"]
    r = c.post(f"/api/projects/{pid}/architectural-render", json=base | {"depth_file_id": depth["id"], "material_file_id": mats["id"]}, headers=alice["headers"])
    assert repo.jobs[r.json()["id"]]["status"] == "succeeded", repo.jobs[r.json()["id"]]["error"]
    call = exact.calls[0]
    assert len(exact.calls) == 1
    # the stand-in picture fails the check: the finishing pass (Ollic VS) corrects that picture instead of drawing a new one
    (fix,) = [x for x in images.calls if x["prompt"].startswith("Image 1 is a photorealistic architectural render")]
    assert len(fix["images"]) == 3 and fix["images"][1][1] == "image/jpeg" and fix["images"][2][1] == "image/png"
    assert "Correct only these differences" in fix["prompt"] and "Image 3 is the MATERIAL MAP" in fix["prompt"]
    assert "- the model has 7 floors above the ground floor; the result shows 6: add the missing floor" in fix["prompt"]
    assert len(call["images"]) == 1 and call["images"][0][1] == "image/png"
    assert Image.open(io.BytesIO(call["images"][0][0])).convert("RGB").getpixel((200, 200)) == (128, 128, 128)   # the depth map (the default guide)
    assert "Use exactly these approved materials" in call["prompt"] and "MATERIAL MAP" not in call["prompt"]
    (img,) = repo.images.values()
    assert img["options"]["tier"] == "exact" and "check" in img["options"]
    # a revision of an Exact render is made with the editing option (Exact draws only from the model)
    e = c.post(f"/api/renders/{img['id']}/edit", json={"instruction": "make the panels darker"}, headers=alice["headers"])
    assert repo.jobs[e.json()["id"]]["input"]["tier"] == "vs"


class FakeChecker:
    """Claude as the checker: finds a missing floor in the first try, nothing in the second."""
    model = "claude-test"

    def __init__(self):
        self.calls = []

    def ask_json(self, system, content, max_tokens=1800, **kw):
        self.calls.append(content)
        first = len(self.calls) == 1
        answer = {"ok": not first, "issues": ["the model has 7 floors above the ground floor; the result shows 6: add the missing floor"] if first else []}
        return {"answer": answer, "usage": {"input_tokens": 900, "output_tokens": 40}, "cost_usd": "0.004", "model": self.model}


def test_claude_corrects_a_render_it_finds_wrong(render_settings, repo, storage, alice):
    images, checker = FakeImages(), FakeChecker()
    app = create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=images, runner=InlineRunner(),
                     fal={}, kling=None, gemini=None, runway=None, aps=None, prompt_writer=checker)
    c = TestClient(app)
    pid = new_project(c, alice)
    view, lines, depth, mats = captured(c, alice, pid)
    owner = type("U", (), {"id": alice["id"]})()
    model = repo.create_model(owner, {"id": "11111111-1111-1111-1111-111111111111", "project_id": pid, "source_file_id": view["id"], "job_id": None,
                                      "glb_path": f"{alice['id']}/{pid}/m.glb",
                                      "report": {"storeys": ["Ground", "1", "2", "3", "4", "5", "6", "7"], "counts": {"IfcWindow": 112}}})
    body = {"prompt": "photoreal render", "prompt_ready": True, "references": [{"file_id": view["id"], "role": "model"}],
            "guide_file_id": lines["id"], "model_id": model["id"]}
    r = c.post(f"/api/projects/{pid}/architectural-render", json=body, headers=alice["headers"])
    assert repo.jobs[r.json()["id"]]["status"] == "succeeded"
    first, second = images.calls
    assert "add the missing floor" not in first["prompt"]
    assert second["prompt"].startswith("Most important: the previous attempt differed") and "- the model has 7 floors above the ground floor" in second["prompt"]
    facts = [b["text"] for b in checker.calls[0] if b.get("type") == "text" and "Facts from the architect's model" in b.get("text", "")]
    assert facts and "Storeys in the model (8" in facts[0] and "112 windows" in facts[0]
    (img,) = repo.images.values()
    chk = img["options"]["check"]
    assert chk["retried"] and chk["claude"]["ok"] is True          # the corrected try is kept
    assert sum(1 for e in repo.usage if e["operation"] == "geometry_check") == 2


class FakeReader:
    """Claude reading the materials of a captured view."""
    model = "claude-test"

    def __init__(self):
        self.calls = []

    def ask_json(self, system, content, max_tokens=1800, **kw):
        self.calls.append((system, content))
        return {"answer": {"materials": [
                    {"key": "paint|#f2f2f2", "name": "White render", "finish": "smooth acrylic render, matt", "hex": "#f4f2ec"},
                    {"key": "paint|#d9c39a", "name": "Tan aluminium cladding", "finish": "vertical panels, satin", "hex": "#c9a46b"},
                    {"key": "nope", "name": "ignored"}],
                "extra": [{"name": "Roof terrace decking", "finish": "composite boards, warm grey", "hex": "#8a8178", "where": "roof terrace under the pergola"}],
                "setting": "Lekki street, palm trees, late afternoon", "notes": "Three materials named from the model."},
                "usage": {"input_tokens": 2000, "output_tokens": 300}, "cost_usd": "0.01", "model": self.model}


def test_claude_reads_the_materials_and_the_architect_confirms(render_settings, repo, storage, alice):
    reader = FakeReader()
    app = create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=FakeImages(), runner=InlineRunner(),
                     fal={}, kling=None, gemini=None, runway=None, aps=None, prompt_writer=reader)
    c = TestClient(app)
    pid = new_project(c, alice)
    view, lines, depth, mats = captured(c, alice, pid)
    groups = [g | {"types": ["IfcWall", "IfcSlab"] if g["cls"] == "paint" else ["IfcWindow"]} for g in GROUPS]
    c.post(f"/api/projects/{pid}/look/materials", json={"groups": groups}, headers=alice["headers"])
    r = c.post(f"/api/projects/{pid}/look/suggest", json={"view_file_id": view["id"], "material_file_id": mats["id"], "description": "luxury flats"},
               headers=alice["headers"])
    assert r.status_code == 202 and r.json()["reading"]          # it runs in the background; the look says when it is done
    out = c.get(f"/api/projects/{pid}/look", headers=alice["headers"]).json()
    assert out["reading"] is None
    system, content = reader.calls[0]
    text = content[-1]["text"]
    assert sum(1 for b in content if b["type"] == "image") == 2 and "used on Wall, Slab" in text and "luxury flats" in text
    by = {m["key"]: m for m in out["materials"]}
    assert by["paint|#d9c39a"]["name"] == "Tan aluminium cladding" and by["paint|#d9c39a"]["hex"] == "#c9a46b" and by["paint|#d9c39a"]["source"] == "ai"
    assert not by["paint|#d9c39a"]["confirmed"] and by["glass|#9fb4c4"]["source"] == "model"
    deck = next(m for m in out["materials"] if m["extra"])
    assert deck["name"] == "Roof terrace decking" and deck["note"] == "roof terrace under the pergola"
    assert out["setting"] == "Lekki street, palm trees, late afternoon" and out["read_notes"].startswith("Three materials")
    # the architect changes one and confirms all; reading again keeps what the architect wrote
    by["paint|#f2f2f2"] |= {"name": "Sandtex white", "source": "architect", "confirmed": True}
    for m in out["materials"]:
        m["confirmed"] = True
    c.put(f"/api/projects/{pid}/look", json=out, headers=alice["headers"])
    c.post(f"/api/projects/{pid}/look/suggest", json={"view_file_id": view["id"], "material_file_id": mats["id"]}, headers=alice["headers"])
    again = c.get(f"/api/projects/{pid}/look", headers=alice["headers"]).json()
    names = [m["name"] for m in again["materials"]]
    assert "Sandtex white" in names and names.count("Roof terrace decking") == 1      # confirmed extras stay, once
    # the render is told about the extras too
    images = app.state.image_clients["standard"]
    c.post(f"/api/projects/{pid}/architectural-render", json={"prompt": "photoreal", "prompt_ready": True, "references": [{"file_id": view["id"], "role": "model"}],
                                                             "guide_file_id": lines["id"], "material_file_id": mats["id"]}, headers=alice["headers"])
    p = images.calls[0]["prompt"]
    assert "Also in this project:" in p and "Roof terrace decking: composite boards, warm grey; colour #8a8178 (roof terrace under the pergola)" in p
    assert "= Sandtex white" in p and "= Tan aluminium cladding: vertical panels, satin; colour #c9a46b" in p
    assert any(e["operation"] == "vision_read" for e in repo.usage)


def test_reading_materials_needs_claude(look_app, alice):
    c, _ = look_app()
    pid = new_project(c, alice)
    view, lines, depth, mats = captured(c, alice, pid)
    r = c.post(f"/api/projects/{pid}/look/suggest", json={"view_file_id": view["id"], "material_file_id": mats["id"]}, headers=alice["headers"])
    assert r.status_code == 503 and "Name them yourself" in r.json()["detail"]["reason"]


def test_claudes_check_looks_at_materials_when_there_is_a_map():
    from app.geometry import claude_check
    seen = []

    class W:
        def ask_json(self, system, content, max_tokens=1800, **kw):
            seen.append((system, content))
            return {"answer": {"ok": False, "issues": ["the three tall bays are glazing in the map: make them glass, not timber slats"]}, "usage": {}, "cost_usd": None}

    view, res = jpg(picture("#f2f2f2", "#d9c39a")), jpg(picture("#f2f2f2", "#6b4a2a"))
    plain = claude_check(W(), view, res)
    with_map = claude_check(W(), view, res, material_map=png(picture(WALL, PANEL)), materials_text="Image 3 is the MATERIAL MAP ... = Clear glazing")
    assert "Ignore materials" in seen[0][0] and sum(b["type"] == "image" for b in seen[0][1]) == 2
    assert "Ignore materials" not in seen[1][0] and "glazing must be glass" in seen[1][0] and sum(b["type"] == "image" for b in seen[1][1]) == 3
    assert with_map["ok"] is False and "not timber" in with_map["issues"][0] and plain["ok"] is False


def test_without_claudes_findings_an_exact_picture_is_kept_as_it_is(look_app, alice, repo):
    exact = FakeImages()
    c, images = look_app(exact=exact)
    repo.roles[alice["id"]] = "admin"
    pid = new_project(c, alice)
    view, lines, depth, mats = captured(c, alice, pid)
    c.post(f"/api/projects/{pid}/architectural-render", json={"prompt": "photoreal render", "prompt_ready": True, "tier": "exact", "references": [{"file_id": view["id"], "role": "model"}],
                                                             "guide_file_id": lines["id"], "depth_file_id": depth["id"]}, headers=alice["headers"])
    assert len(exact.calls) == 1 and images.calls == []            # no vague "make it match" pass


def test_claude_answers_through_a_tool_so_the_json_is_clean():
    import httpx
    from app.prompt_writer import ClaudePromptWriter
    sent = []

    def handler(req):
        sent.append(json.loads(req.content))
        return httpx.Response(200, json={"content": [{"type": "text", "text": "Here is my check."},
                                                     {"type": "tool_use", "id": "t1", "name": "answer", "input": {"ok": False, "issues": ["make the bays glass"]}}],
                                         "stop_reason": "tool_use", "usage": {"input_tokens": 10, "output_tokens": 5}})
    w = ClaudePromptWriter("k", client=httpx.Client(base_url="https://api.anthropic.com", transport=httpx.MockTransport(handler)))
    out = w.ask_json("system", [{"type": "text", "text": "q"}])
    assert out["answer"] == {"ok": False, "issues": ["make the bays glass"]}
    assert sent[0]["tools"][0]["name"] == "answer" and sent[0]["tool_choice"] == {"type": "auto"} and sent[0]["max_tokens"] >= 6000


def test_the_exact_engine_sends_the_line_drawing_to_the_line_guided_model():
    import httpx
    from app.fal import FalExact
    seen = []

    def handler(req):
        seen.append(req)
        if req.method == "POST":
            return httpx.Response(200, json={"request_id": "r1", "status_url": "https://queue.fal.run/fal-ai/flux-control-lora-canny/requests/r1/status",
                                             "response_url": "https://queue.fal.run/fal-ai/flux-control-lora-canny/requests/r1"})
        if req.url.path.endswith("/status"):
            return httpx.Response(200, json={"status": "COMPLETED"})
        return httpx.Response(200, json={"images": [{"url": "data:image/jpeg;base64," + __import__("base64").b64encode(jpg(picture("#ffffff", "#cccccc"))).decode()}]})
    ex = FalExact("k", client=httpx.Client(transport=httpx.MockTransport(handler)))
    ex.poll_seconds, ex.guide = 0, "lines"
    out = ex.edit(model="m", prompt="photoreal", images=[(png(picture("#000000", "#ffffff")), "image/png")], size="1536x1024")
    body = json.loads(seen[0].content)
    assert seen[0].url.path == "/fal-ai/flux-control-lora-canny" and body["control_lora_image_url"].startswith("data:image/")
    assert body["image_size"] == {"width": 1536, "height": 1024} and "preprocess_depth" not in body and out.model == "fal-ai/flux-control-lora-canny"
    ex.guide = "depth"; seen.clear()
    ex.edit(model="m", prompt="p", images=[(png(picture("#000000", "#ffffff")), "image/png")])
    assert seen[0].url.path == "/fal-ai/flux-control-lora-depth" and json.loads(seen[0].content)["preprocess_depth"] is False


def test_ultra_runs_on_fal_with_several_pictures_and_its_own_price():
    import httpx
    from app.fal import FalGemini
    seen = []

    def handler(req):
        seen.append(req)
        if req.method == "POST":
            return httpx.Response(200, json={"request_id": "r", "status_url": "https://queue.fal.run/fal-ai/nano-banana-pro/requests/r/status", "response_url": "https://queue.fal.run/fal-ai/nano-banana-pro/requests/r"})
        if req.url.path.endswith("/status"):
            return httpx.Response(200, json={"status": "COMPLETED"})
        return httpx.Response(200, json={"images": [{"url": "data:image/jpeg;base64," + __import__("base64").b64encode(jpg(picture("#ffffff", "#cccccc"))).decode()}]})
    u = FalGemini("k", "fal-ai/nano-banana-pro/edit", "0.15", client=httpx.Client(transport=httpx.MockTransport(handler)))
    u.poll_seconds = 0
    out = u.edit(model="x", prompt="photoreal", images=[(jpg(picture("#fff", "#ccc") if False else picture("#ffffff", "#cccccc")), "image/jpeg"), (png(picture(WALL, PANEL)), "image/png")], size="1536x1024")
    body = json.loads(seen[0].content)
    assert seen[0].url.path == "/fal-ai/nano-banana-pro/edit" and len(body["image_urls"]) == 2 and body["aspect_ratio"] == "3:2" and body["resolution"] == "2K"
    assert out.extra["cost_usd"] == "0.15" and u.model_name == "fal-ai/nano-banana-pro/edit"
    seen.clear(); u.generate(model="x", prompt="p")
    assert seen[0].url.path == "/fal-ai/nano-banana-pro"


def test_with_a_fal_key_ultra_and_swift_are_connected(render_settings, repo, storage):
    from dataclasses import replace
    app = create_app(replace(render_settings, fal_key="fk", gemini_api_key=None), repo=repo, storage=storage, verifier=TokenVerifier(render_settings),
                     image_client=FakeImages(), runner=InlineRunner(), kling=None, runway=None, aps=None, prompt_writer=None, gemini=None)
    assert app.state.image_clients["ultra"].endpoint == "fal-ai/nano-banana-pro/edit" and app.state.image_clients["swift"].endpoint == "fal-ai/nano-banana-2/edit"
    assert app.state.image_clients["exact"].guide == "depth"



class StubbornChecker:
    """Claude still sees the beige piers after the re-render; the finishing pass fixes them."""
    model = "claude-test"

    def __init__(self):
        self.n = 0

    def ask_json(self, system, content, max_tokens=1800, **kw):
        self.n += 1
        issues = [] if self.n >= 3 else ["the front piers are white render in the map: make them white, not beige stone"]
        return {"answer": {"ok": not issues, "issues": issues}, "usage": {}, "cost_usd": None, "model": self.model}


def test_a_walkthrough_frame_gets_a_second_round_that_fixes_what_claude_still_sees(look_app, alice, repo):
    vs = FakeImages()
    c, images = look_app(exact=FakeImages(), writer=StubbornChecker(), images=vs)
    repo.roles[alice["id"]] = "admin"
    pid = new_project(c, alice)
    view, lines, depth, mats = captured(c, alice, pid)
    body = {"prompt": "photoreal", "prompt_ready": True, "references": [{"file_id": view["id"], "role": "model"}], "guide_file_id": lines["id"]}
    c.post(f"/api/projects/{pid}/architectural-render", json=body | {"rounds": 2}, headers=alice["headers"])
    fix = [x for x in vs.calls if x["prompt"].startswith("Image 1 is a photorealistic architectural render")]
    assert len(fix) == 1 and "make them white, not beige stone" in fix[0]["prompt"]
    img = list(repo.images.values())[-1]
    assert img["options"]["check"]["rounds"] == 2 and img["options"]["check"]["claude"]["ok"] is True


class SceneReader:
    model = "claude-test"

    def ask_json(self, system, content, max_tokens=1800, **kw):
        assert "Never describe the building" in system
        return {"answer": {"name": "Dusk by the Pool", "type": "exterior",
                           "recipe": "Blue hour after sunset, warm interior glow, lit planters and a still pool in front, low symmetrical camera with a 24 mm lens."},
                "usage": {}, "cost_usd": "0.01", "model": self.model}


def test_scene_presets_and_a_scene_copied_from_a_picture(render_settings, repo, storage, alice):
    images = FakeImages()
    app = create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=images, runner=InlineRunner(),
                     fal={}, kling=None, gemini=None, runway=None, aps=None, prompt_writer=SceneReader())
    c = TestClient(app)
    lst = c.get("/api/scenes").json()
    ids = {s["id"]: s for s in lst["scenes"]}
    assert ids["golden_driveway"]["name"] == "Golden Hour Driveway" and ids["interior_morning"]["type"] == "interior"
    assert lst["types"] == {"exterior": "Exterior", "interior": "Interior", "site_plan": "Site plan", "estate": "Estate layout"}
    pid = new_project(c, alice)
    view, lines, depth, mats = captured(c, alice, pid)
    assert c.put(f"/api/projects/{pid}/look", json={"scene_id": "nope"}, headers=alice["headers"]).status_code == 422
    c.put(f"/api/projects/{pid}/look", json={"scene_id": "golden_driveway"}, headers=alice["headers"])
    body = {"prompt": "photoreal render", "prompt_ready": True, "references": [{"file_id": view["id"], "role": "model"}], "guide_file_id": lines["id"]}
    c.post(f"/api/projects/{pid}/architectural-render", json=body, headers=alice["headers"])
    p = images.calls[0]["prompt"]
    assert "SCENE for every view of this project (Golden Hour Driveway): Late-afternoon golden-hour sun" in p and "RENDER TYPE: An exterior view" in p
    assert p.rstrip().endswith("watermarks.")
    # an interior render is told the interior rules
    c.post(f"/api/projects/{pid}/architectural-render", json=body | {"view": "interior"}, headers=alice["headers"])
    assert "RENDER TYPE: An interior view: keep every wall" in images.calls[-1]["prompt"]
    # a scene copied from the architect's own picture: named and written by Claude, the picture sent as the scene reference
    ref = upload(c, alice, pid, "my-scene.jpg", jpg(picture("#203060", "#ffcc88")))
    out = c.post(f"/api/projects/{pid}/look/scene-from-image", json={"file_id": ref["id"]}, headers=alice["headers"]).json()
    assert out["scene_name"] == "Dusk by the Pool" and out["scene_id"] is None and out["scene_ref_file_id"] == ref["id"]
    n = len(images.calls)
    c.post(f"/api/projects/{pid}/architectural-render", json=body, headers=alice["headers"])
    call = images.calls[n]
    assert "SCENE for every view of this project (Dusk by the Pool): Blue hour after sunset" in call["prompt"]
    assert len(call["images"]) == 2 and "Image 2 is the project's SCENE REFERENCE" in call["prompt"]


def test_aerial_scenes_and_the_planting_rule():
    from app.scenes import SCENES, type_rule
    for sid in ("valley_misty", "rooftop_gardens", "urban_drone_sunset", "parkland_pines", "green_campus",
                "hillside_forest", "waterfront_topdown", "suburb_sunset", "terraced_green_city"):
        assert sid in SCENES and len(SCENES[sid][3]) > 200
    assert "PLANTING" in type_rule("front") and "PLANTING" in type_rule("estate") and "PLANTING" not in type_rule("interior")
