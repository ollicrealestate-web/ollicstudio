"""Premium prompting: Claude studies the images and writes the image model's prompt."""

from __future__ import annotations

import base64
import io
import json
from decimal import Decimal

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.auth import TokenVerifier
from app.jobs import InlineRunner
from app.main import create_app
from app.prompt_writer import ClaudePromptWriter, PromptWriterFailed, cost_usd

from . import samples
from .conftest import FakeImages, jpeg_bytes

WRITTEN = "Photorealistic street-level render of a six-storey apartment block following Image 1's footprint, glass balconies from Image 2, cantilevered penthouse, dusk light."


class FakeWriter:
    model = "claude-opus-5-5"

    def __init__(self, fail=False):
        self.fail, self.calls = fail, []

    def _out(self):
        if self.fail:
            raise PromptWriterFailed("prompt writer error 529")
        return {"prompt": WRITTEN, "notes": "Read two mirrored flats around a core.", "model": self.model,
                "usage": {"input_tokens": 6000, "output_tokens": 500}, "cost_usd": Decimal("0.034000")}

    def write(self, **kw):
        self.calls.append(("write", kw))
        return self._out()

    def ask_json(self, system, content, max_tokens=1800, timeout=180):
        self.calls.append(("ask", {"system": system, "content": content}))
        return {"answer": {"scene": "Wet street at blue hour, deep blue sky with soft clouds, warm glowing windows, palms along the pavement.",
                           "notes": "Blue hour, wet ground, palms."}, "usage": {"input_tokens": 900, "output_tokens": 80}, "cost_usd": Decimal("0.005"), "model": self.model}

    def write_edit(self, **kw):
        self.calls.append(("edit", kw))
        return self._out()


def make(render_settings, repo, storage, writer):
    images = FakeImages()
    app = create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=images,
                     runner=InlineRunner(), vision=None, prompt_writer=writer)
    return TestClient(app), images


def setup_project(c, user, repo):
    repo.plans[user["id"]] = "premium"
    pid = c.post("/api/projects", json={"name": "x"}, headers=user["headers"]).json()["id"]
    plan = c.post(f"/api/projects/{pid}/uploads", files={"file": ("plan.png", samples.png(80, 60))}, headers=user["headers"]).json()
    look = c.post(f"/api/projects/{pid}/uploads", files={"file": ("look.jpg", jpeg_bytes(90, 60))}, headers=user["headers"]).json()
    return pid, plan, look


def test_premium_renders_use_the_written_prompt_and_record_its_cost(render_settings, repo, storage, alice):
    writer = FakeWriter()
    c, images = make(render_settings, repo, storage, writer)
    pid, plan, look = setup_project(c, alice, repo)
    body = {"prompt": "Luxury block, glass balconies", "tier": "premium", "storeys": 6, "style": "luxury contemporary",
            "references": [{"file_id": plan["id"], "role": "plan"}, {"file_id": look["id"], "role": "style"}]}
    c.post(f"/api/projects/{pid}/architectural-render", json=body, headers=alice["headers"])
    # the reference picture is read first, on its own: only it is shown, and only its scene is asked for
    kind, ask = writer.calls[0]
    assert kind == "ask" and sum(1 for b in ask["content"] if b["type"] == "image") == 1 and "NEVER describe the building" in ask["system"]
    # the building's prompt is written from the building's pictures alone, with the scene in words
    kind, kw = writer.calls[1]
    assert kind == "write" and kw["roles"] == ["plan"] and len(kw["images"]) == 1 and kw["choices"]["storeys"] == 6
    assert "SCENE FROM THE REFERENCE PICTURES" in kw["brief"] and "Wet street at blue hour" in kw["brief"]
    assert images.calls[0]["prompt"].startswith(WRITTEN) and images.calls[0]["prompt"].endswith("Do not add any text, labels, logos or watermarks.")
    assert len(images.calls[0]["images"]) == 1          # the image model gets the plan only, never the reference picture
    ev = [e for e in repo.usage if e["operation"] == "prompt_write"]
    assert len(ev) == 1 and ev[0]["provider"] == "anthropic" and ev[0]["cost_usd"] == "0.034000"
    assert [e["cost_usd"] for e in repo.usage if e["operation"] == "vision_read"] == ["0.005"]
    img = c.get(f"/api/projects/{pid}/outputs", headers=alice["headers"]).json()["images"][0]
    assert img["options"]["premium_prompting"] is True and img["options"]["prompt_notes"].startswith("Read two")
    assert {"Premium render", "AI prompt writing"} <= {e["service"] for e in c.get("/api/usage", headers=alice["headers"]).json()["events"]}

    # a plain-words revision is turned into a precise edit too
    c.post(f"/api/renders/{img['id']}/edit", json={"instruction": "make the balconies bronze"}, headers=alice["headers"])
    kind, kw = writer.calls[-1]
    assert kind == "edit" and kw["instruction"] == "make the balconies bronze" and kw["current"]
    assert images.calls[-1]["prompt"].startswith(WRITTEN)


def test_standard_renders_do_not_use_premium_prompting(render_settings, repo, storage, alice):
    writer = FakeWriter()
    c, images = make(render_settings, repo, storage, writer)
    pid, plan, _ = setup_project(c, alice, repo)
    c.post(f"/api/projects/{pid}/architectural-render", json={"prompt": "A house", "references": [{"file_id": plan["id"], "role": "plan"}]}, headers=alice["headers"])
    assert writer.calls == [] and "Image 1 is the architect's floor plan" in images.calls[0]["prompt"]


def test_if_premium_prompting_fails_the_render_still_happens(render_settings, repo, storage, alice):
    c, images = make(render_settings, repo, storage, FakeWriter(fail=True))
    pid, plan, _ = setup_project(c, alice, repo)
    job = c.post(f"/api/projects/{pid}/architectural-render", json={"prompt": "A house", "tier": "premium"}, headers=alice["headers"]).json()
    assert c.get(f"/api/jobs/{job['id']}", headers=alice["headers"]).json()["status"] == "succeeded"
    assert "Architect's brief: A house" in images.calls[0]["prompt"] and not [e for e in repo.usage if e["operation"] == "prompt_write"]


def test_the_request_sent_to_claude():
    calls = []
    answer = {"content": [{"type": "text", "text": 'Here: {"prompt": "' + WRITTEN + '", "notes": "ok"}'}], "usage": {"input_tokens": 5000, "output_tokens": 400}}
    http = httpx.Client(base_url="https://api.anthropic.com", transport=httpx.MockTransport(lambda r: calls.append(r) or httpx.Response(200, json=answer)))
    w = ClaudePromptWriter("sk-ant-test", client=http)
    out = w.write(brief="Six storeys", choices={"storeys": 6, "style": ""}, images=[(jpeg_bytes(3000, 2000), "image/jpeg")], roles=["plan"])
    req = calls[0]
    body = json.loads(req.content)
    assert req.url.path == "/v1/messages" and req.headers["x-api-key"] == "sk-ant-test" and req.headers["anthropic-version"] == "2023-06-01"
    assert body["model"] == "claude-opus-5-5"
    blocks = body["messages"][0]["content"]
    assert blocks[0]["text"] == "Image 1: architect's floor plan of a typical floor."
    sent = Image.open(io.BytesIO(base64.b64decode(blocks[1]["source"]["data"])))
    assert max(sent.size) == 1568                      # resized to the size Claude reads best
    assert "storeys: 6" in blocks[-1]["text"] and "style" not in blocks[-1]["text"].split("Choices:")[1]
    assert out["prompt"] == WRITTEN and out["cost_usd"] == Decimal("0.028000")   # 5000 x $4 + 400 x $20 per million


def test_claude_failures_are_clean():
    for resp in (httpx.Response(529, json={"error": {"message": "overloaded"}}), httpx.Response(200, json={"content": [{"type": "text", "text": "Sorry, no."}]})):
        http = httpx.Client(base_url="https://api.anthropic.com", transport=httpx.MockTransport(lambda r, resp=resp: resp))
        with pytest.raises(PromptWriterFailed):
            ClaudePromptWriter("k", client=http).write_edit(instruction="x", current=jpeg_bytes(10, 10))
    assert cost_usd("claude-fable-5-1", {"input_tokens": 1_000_000, "output_tokens": 0}) == Decimal("10.000000")
    assert cost_usd("some-other-model", {"input_tokens": 10}) is None


# ---------------------------------------------------------------- the AI writes the rendering prompt from the pictures
class FakeRenderPrompter:
    model = "claude-opus-5-5"

    def __init__(self):
        self.calls = []

    def ask_json(self, system, content, max_tokens=1800, timeout=180):
        self.calls.append((system, content))
        return {"answer": {"scene": "A landscaped forecourt with mature trees, clipped hedges and warm evening light under a clear sky.", "notes": "Forecourt and evening light."},
                "usage": {"input_tokens": 800, "output_tokens": 60}, "cost_usd": Decimal("0.004"), "model": self.model}

    def _call(self, system, content):
        self.calls.append((system, content))
        return {"prompt": "Photorealistic render of the eight-storey block in Image 1, keep every opening and the camera exactly; bronze glass, white stone, "
                          "landscaped forecourt as in Image 2, warm evening light.", "notes": "An eight-storey block with a glazed corner.", "model": self.model,
                "usage": {"input_tokens": 3000, "output_tokens": 300}, "cost_usd": Decimal("0.018")}


def test_the_ai_writes_the_prompt_from_the_captured_view_and_references(render_settings, repo, storage, alice, bob):
    from app.main import create_app
    from app.jobs import InlineRunner
    from app.auth import TokenVerifier
    from fastapi.testclient import TestClient
    from .test_studio import new_project, upload
    writer, images = FakeRenderPrompter(), FakeImages()
    c = TestClient(create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=images, runner=InlineRunner(),
                              vision=None, prompt_writer=writer))
    pid = new_project(c, alice)
    view = upload(c, alice, pid, "3D view Oct 23, 12-52 PM.png", samples.png(400, 300))
    ref = upload(c, alice, pid, "forecourt.jpg", jpeg_bytes(300, 200, (90, 120, 80)))
    body = {"references": [{"file_id": ref["id"], "role": "style"}, {"file_id": view["id"], "role": "model"}], "description": "luxury office complex, landscaped"}
    r = c.post(f"/api/projects/{pid}/render-prompt", json=body, headers=alice["headers"])
    assert r.status_code == 200, r.text
    out = r.json()
    assert "eight-storey" in out["prompt"] and out["order"] == [view["id"]]          # only the building's pictures, as the render sends them
    assert out["scene"].startswith("A landscaped forecourt") and "Forecourt" in out["notes"]
    # 1. the reference alone, read for its scene: one picture (the reference), never the view
    (s1, c1), (s2, c2) = writer.calls[-2:]
    assert "NEVER describe the building" in s1 and "camera" in s1 and sum(1 for b in c1 if b["type"] == "image") == 1
    assert c1[1]["source"]["data"] != c2[1]["source"]["data"]                        # the reference, not the view
    # 2. the building's prompt: the view alone, with the scene in words
    texts = [b["text"] for b in c2 if b["type"] == "text"]
    assert texts[0].startswith("Image 1 is the VIEW TO RENDER") and not any(t.startswith("Image 2") for t in texts)
    assert "luxury office complex" in texts[-1] and "SCENE FROM THE REFERENCE PICTURES" in texts[-1] and "landscaped forecourt" in texts[-1]
    assert sum(1 for b in c2 if b["type"] == "image") == 1 and "keep the view to render exactly" in s2
    assert repo.usage[-1]["operation"] == "prompt_write" and repo.usage[-1]["provider"] == "anthropic"
    assert repo.usage[-2]["operation"] == "vision_read"
    # the render uses the prompt as written (the scene is in it already: no second reading), and only the view goes to the image model
    n = len(writer.calls)
    rb = {"prompt": out["prompt"], "prompt_ready": True, "references": body["references"], "tier": "standard"}
    assert c.post(f"/api/projects/{pid}/architectural-render", json=rb, headers={**alice["headers"], "Idempotency-Key": "ready-0001"}).status_code == 202
    call = images.calls[-1]
    assert call["prompt"].startswith(out["prompt"]) and "Architect's brief" not in call["prompt"] and len(call["images"]) == 1
    assert len(writer.calls) == n
    # checked: another customer's pictures, nothing to read
    assert c.post(f"/api/projects/{pid}/render-prompt", json=body, headers=bob["headers"]).status_code == 404
    assert c.post(f"/api/projects/{pid}/render-prompt", json={}, headers=alice["headers"]).status_code == 422
    proj = c.get(f"/api/projects/{pid}", headers=alice["headers"]).json()
    assert all(f["preview_url"] for f in proj["source_files"])     # thumbnails for the render box


def test_the_project_scene_reaches_the_writer_and_claude_writes_a_look_from_the_screen(render_settings, repo, storage, alice):
    import base64
    from app.auth import TokenVerifier
    from fastapi.testclient import TestClient
    from .test_studio import new_project

    class Writer(FakeRenderPrompter):
        def ask_json(self, system, content, max_tokens=1800, **kw):
            self.calls.append((system, content))
            return {"answer": {"look": "White render, bronze glass, palms, warm evening light.", "notes": ""}, "usage": {}, "cost_usd": None, "model": self.model}

    writer = Writer()
    c = TestClient(create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=FakeImages(), runner=InlineRunner(),
                              vision=None, prompt_writer=writer))
    pid = new_project(c, alice)
    look = c.get(f"/api/projects/{pid}/look", headers=alice["headers"]).json(); look["scene_id"] = "blue_hour"
    assert c.put(f"/api/projects/{pid}/look", json=look, headers=alice["headers"]).status_code == 200
    # a still prompt: the scene goes to Claude with the architect's words
    assert c.post(f"/api/projects/{pid}/render-prompt", json={"description": "office block"}, headers=alice["headers"]).status_code == 200
    assert "Blue Hour Glow" in writer.calls[-1][1][-1]["text"] and "office block" in writer.calls[-1][1][-1]["text"]
    # a video look, from the model view on screen (not saved as a file)
    shot = "data:image/jpeg;base64," + base64.b64encode(jpeg_bytes(320, 200)).decode()
    r = c.post(f"/api/projects/{pid}/render-prompt", json={"view_image": shot, "purpose": "look"}, headers=alice["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["prompt"].startswith("White render") and "LOOK" in writer.calls[-1][0]
    assert sum(1 for b in writer.calls[-1][1] if b["type"] == "image") == 1 and "Blue Hour Glow" in writer.calls[-1][1][-1]["text"]
    assert c.get(f"/api/projects/{pid}", headers=alice["headers"]).json()["source_files"] == []


def test_reference_pictures_alone_without_ollic_ai_are_left_out(render_settings, repo, storage, alice):
    """Without Ollic AI the reference pictures cannot be read for their scene, so they are left out (never sent with the building)."""
    from .test_studio import new_project, upload
    images = FakeImages()
    c = TestClient(create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=images, runner=InlineRunner(),
                              vision=None, prompt_writer=None))
    pid = new_project(c, alice)
    view = upload(c, alice, pid, "view.png", samples.png(400, 300))
    ref = upload(c, alice, pid, "other-house.jpg", jpeg_bytes(300, 200))
    body = {"prompt": "white villa", "references": [{"file_id": view["id"], "role": "model"}, {"file_id": ref["id"], "role": "style"}]}
    assert c.post(f"/api/projects/{pid}/architectural-render", json=body, headers=alice["headers"]).status_code == 202
    assert len(images.calls[-1]["images"]) == 1 and "reference" not in images.calls[-1]["prompt"].lower()


def test_the_scene_reader_sees_only_the_references_and_asks_for_no_building():
    from app.render_prompt import REFERENCE_SCENE_SYSTEM, PromptUnavailable, read_reference_scene, scene_paragraph
    seen = []

    class W:
        def ask_json(self, system, content, max_tokens=1800, timeout=180):
            seen.append(content)
            return {"answer": {"scene": "Soft overcast sky, wet paving, birch trees.", "notes": ""}, "usage": {}, "cost_usd": None, "model": "m"}
    out = read_reference_scene(W(), [(jpeg_bytes(200, 120), "image/jpeg"), (jpeg_bytes(200, 120), "image/jpeg")])
    assert out["scene"].startswith("Soft overcast") and sum(1 for b in seen[0] if b["type"] == "image") == 2
    for words in ("NEVER describe the building", "floors", "materials", "NEVER describe the camera"):
        assert words in REFERENCE_SCENE_SYSTEM
    assert "the building, its materials and the camera come only from the architect" in scene_paragraph("x")

    class Empty(W):
        def ask_json(self, *a, **k):
            return {"answer": {"scene": ""}, "usage": {}, "cost_usd": None, "model": "m"}
    with pytest.raises(PromptUnavailable):
        read_reference_scene(Empty(), [(jpeg_bytes(80, 60), "image/jpeg")])
