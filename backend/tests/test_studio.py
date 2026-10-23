"""The render studio: "Read my plan", and renders from a floor plan, a 3D model view and
style references, each with its role (brief Module C, rebuilt around architects' use)."""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.auth import TokenVerifier
from app.jobs import InlineRunner
from app.main import create_app
from app.renders import build_prompt
from app.vision import VisionUnavailable, parse_reading, summary_text

from . import samples
from .conftest import FakeImages, jpeg_bytes
from .fixtures.layout import sample_house
from .plan_drawing import draw_plan

READING = {"building_type": "6-storey residential apartment block", "drawing_title": "Typical 1st - 6th Floor Plan", "storeys": 6,
           "units_per_floor": 2, "layout": "Two mirrored flats either side of a central stair and lift core.",
           "rooms": ["Living Room", "Master Bedroom"], "features": ["balconies on both long sides", "curved terrace corners"],
           "overall_width_m": 30.7, "overall_depth_m": 17.1, "model": "fake-vision", "usage": {"prompt_tokens": 1200}}


class FakeReader:
    def __init__(self, fail=False):
        self.fail, self.calls = fail, []

    def read_plan(self, img):
        self.calls.append(img.size)
        if self.fail:
            raise VisionUnavailable("vision model error 500")
        return dict(READING)


@pytest.fixture
def studio(render_settings, repo, storage):
    images, reader = FakeImages(), FakeReader()
    app = create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=images, runner=InlineRunner(), vision=reader)
    return TestClient(app), images, reader


def upload(c, user, pid, name, data):
    r = c.post(f"/api/projects/{pid}/uploads", files={"file": (name, data)}, headers=user["headers"])
    assert r.status_code == 201, r.text
    return r.json()


def new_project(c, user):
    return c.post("/api/projects", json={"name": "Maitama block"}, headers=user["headers"]).json()["id"]


# ---------------------------------------------------------------- read my plan
def test_read_my_plan_gives_an_editable_brief(studio, alice, repo):
    c, _, reader = studio
    pid = new_project(c, alice)
    f = upload(c, alice, pid, "A103.png", draw_plan(sample_house())[0])
    r = c.post(f"/api/projects/{pid}/plan/read", json={"source_file_id": f["id"]}, headers=alice["headers"]).json()
    assert r["reading"]["storeys"] == 6 and "usage" not in r["reading"]
    assert r["summary"].startswith("6-storey residential apartment block. Two mirrored flats") and "balconies on both long sides" in r["summary"]
    assert repo.usage[-1]["operation"] == "vision_read" and reader.calls


def test_read_my_plan_refusals(studio, render_settings, repo, storage, alice, bob):
    c, _, _ = studio
    pid = new_project(c, alice)
    f = upload(c, alice, pid, "plan.png", samples.png(400, 300))
    assert c.post(f"/api/projects/{pid}/plan/read", json={"source_file_id": f["id"]}, headers=bob["headers"]).status_code == 404
    off = TestClient(create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=FakeImages(), runner=InlineRunner(), vision=None))
    assert off.post(f"/api/projects/{pid}/plan/read", json={"source_file_id": f["id"]}, headers=alice["headers"]).status_code == 503
    broken = TestClient(create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=FakeImages(), runner=InlineRunner(), vision=FakeReader(fail=True)))
    r = broken.post(f"/api/projects/{pid}/plan/read", json={"source_file_id": f["id"]}, headers=alice["headers"])
    assert r.status_code == 502 and "write the brief yourself" in r.json()["detail"]["reason"]


def test_plan_readings_are_parsed_defensively():
    r = parse_reading('Sure!\n```json\n{"building_type":"Apartment block","storeys":"6","units_per_floor":"two","layout":null,'
                      '"rooms":["Kitchen",""],"features":"not a list","overall_width_m":"30,695"}\n```')
    assert r["storeys"] == 6 and r["units_per_floor"] is None and r["layout"] is None and r["rooms"] == ["Kitchen"] and r["features"] == []
    assert r["overall_width_m"] == 30695.0
    assert summary_text({"building_type": "house", "features": ["a porch"], "overall_width_m": 48, "overall_depth_m": 21}) == "House. Show: a porch."   # no guessed sizes
    with pytest.raises(VisionUnavailable):
        parse_reading("I cannot read this image.")


# ---------------------------------------------------------------- renders from plan, model view and style references
def test_render_from_plan_and_style_references(studio, alice, storage):
    c, images, _ = studio
    pid = new_project(c, alice)
    plan = upload(c, alice, pid, "A103.png", draw_plan(sample_house())[0])
    look1 = upload(c, alice, pid, "glass-facade.jpg", jpeg_bytes(300, 200, (90, 120, 160)))
    look2 = upload(c, alice, pid, "cantilever.jpg", jpeg_bytes(300, 200, (160, 120, 90)))
    body = {"prompt": "Luxury block with glass balconies and a cantilevered top floor", "tier": "premium",
            "references": [{"file_id": look1["id"], "role": "style"}, {"file_id": plan["id"], "role": "plan"}, {"file_id": look2["id"], "role": "style"}],
            "storeys": 6, "ground_floor": "car park", "style": "luxury contemporary", "view": "exterior"}
    c.app.state.repo.plans[alice["id"]] = "premium"
    r = c.post(f"/api/projects/{pid}/architectural-render", json=body, headers=alice["headers"])
    assert r.status_code == 202, r.text
    assert c.get(f"/api/jobs/{r.json()['id']}", headers=alice["headers"]).json()["status"] == "succeeded"
    (call,) = images.calls
    sent = [d for d, _ in call["images"]]
    assert sent == [storage.objects[plan["storage_path"]][0], storage.objects[look1["storage_path"]][0], storage.objects[look2["storage_path"]][0]]  # plan first
    p = call["prompt"]
    assert "Image 1 is the architect's floor plan" in p and "Image 2 is a reference for the look" in p and "Image 3 is a reference for the look" in p
    assert "6 floors above a ground-floor car park" in p and "glass balconies, stone and timber" in p and "cantilevered top floor" in p
    assert "Exterior view of the whole building" in p
    img = c.get(f"/api/projects/{pid}/outputs", headers=alice["headers"]).json()["images"][0]
    assert img["source_file_id"] == plan["id"] and img["options"]["storeys"] == 6 and len(img["options"]["references"]) == 3


def test_a_model_view_keeps_the_shape_and_camera(studio, alice):
    c, images, _ = studio
    pid = new_project(c, alice)
    shot = upload(c, alice, pid, "3D view.png", samples.png(64, 48))
    body = {"prompt": "Render the architect's model in white render and bronze glass", "references": [{"file_id": shot["id"], "role": "model"}], "view": "aerial"}
    assert c.post(f"/api/projects/{pid}/architectural-render", json=body, headers=alice["headers"]).status_code == 202
    p = images.calls[0]["prompt"]
    assert "Image 1 is a plain 3D view of the architect's model. Keep its exact shape" in p
    assert "Aerial three-quarter view" not in p     # the model view decides the camera


@pytest.mark.parametrize("refs,code", [
    ([("plan", "plan.png"), ("plan", "plan2.png")], 422),            # one plan
    ([("base", "a.png"), ("model", "b.png")], 422),                  # keep a design or a model view, not both
    ([("style", "1.png"), ("style", "2.png"), ("style", "3.png"), ("style", "4.png")], 422),
])
def test_reference_rules(studio, alice, refs, code):
    c, images, _ = studio
    pid = new_project(c, alice)
    files = [upload(c, alice, pid, name, samples.png(8 + i, 8)) for i, (_, name) in enumerate(refs)]
    body = {"prompt": "A house", "references": [{"file_id": f["id"], "role": role} for f, (role, _) in zip(files, refs)]}
    assert c.post(f"/api/projects/{pid}/architectural-render", json=body, headers=alice["headers"]).status_code == code
    assert images.calls == []


def test_someone_elses_reference_is_not_found(studio, alice, bob):
    c, images, _ = studio
    theirs = upload(c, alice, new_project(c, alice), "plan.png", samples.png())
    mine = new_project(c, bob)
    body = {"prompt": "A house", "references": [{"file_id": theirs["id"], "role": "plan"}]}
    assert c.post(f"/api/projects/{mine}/architectural-render", json=body, headers=bob["headers"]).status_code == 404
    assert images.calls == []


def test_prompt_roles_and_options_without_images():
    p = build_prompt({"prompt": "A villa", "view": "cutaway", "storeys": 2, "ground_floor": "flats", "style": "tropical modern", "time_of_day": "dusk"})
    assert "cutaway view with the front facade removed" in p and "The building has 2 floors." in p and "deep overhangs" in p and "Image 1" not in p
