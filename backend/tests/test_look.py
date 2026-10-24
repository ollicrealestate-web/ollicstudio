"""The project look (approved materials from the model, the hero render), the material check, and
Ollic Exact (renders drawn on the model's own depth map)."""

from __future__ import annotations

import io

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
    def make(images=None, exact=None):
        images = images or FakeImages()
        app = create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=images, runner=InlineRunner(),
                         fal={"images": images, "exact": exact} if exact else {}, kling=None, gemini=None, runway=None, aps=None, prompt_writer=None)
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
    c, images = look_app(exact=exact)
    repo.roles[alice["id"]] = "admin"
    pid = new_project(c, alice)
    view, lines, depth, mats = captured(c, alice, pid)
    c.post(f"/api/projects/{pid}/look/materials", json={"groups": GROUPS}, headers=alice["headers"])
    base = {"prompt": "photoreal render", "prompt_ready": True, "tier": "exact", "references": [{"file_id": view["id"], "role": "model"}], "guide_file_id": lines["id"]}
    r = c.post(f"/api/projects/{pid}/architectural-render", json=base, headers=alice["headers"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "exact_needs_model"
    r = c.post(f"/api/projects/{pid}/architectural-render", json=base | {"depth_file_id": depth["id"], "material_file_id": mats["id"]}, headers=alice["headers"])
    assert repo.jobs[r.json()["id"]]["status"] == "succeeded", repo.jobs[r.json()["id"]]["error"]
    call = exact.calls[0]          # (the stand-in picture fails the check, so it is made once more, also on the depth)
    assert all(len(x["images"]) == 1 for x in exact.calls) and len(exact.calls) == 2
    assert len(call["images"]) == 1 and call["images"][0][1] == "image/png" and call["model"] == "fal-ai/flux-control-lora-depth"
    assert "Use exactly these approved materials" in call["prompt"] and "MATERIAL MAP" not in call["prompt"]
    (img,) = repo.images.values()
    assert img["options"]["tier"] == "exact" and "check" in img["options"]
    # a revision of an Exact render is made with the editing option (Exact draws only from the model)
    e = c.post(f"/api/renders/{img['id']}/edit", json={"instruction": "make the panels darker"}, headers=alice["headers"])
    assert repo.jobs[e.json()["id"]]["input"]["tier"] == "vs"
