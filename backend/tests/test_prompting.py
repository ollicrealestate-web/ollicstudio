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
    kind, kw = writer.calls[0]
    assert kind == "write" and kw["roles"] == ["plan", "style"] and len(kw["images"]) == 2 and kw["choices"]["storeys"] == 6
    assert images.calls[0]["prompt"].startswith(WRITTEN) and images.calls[0]["prompt"].endswith("Do not add any text, labels, logos or watermarks.")
    ev = [e for e in repo.usage if e["operation"] == "prompt_write"]
    assert len(ev) == 1 and ev[0]["provider"] == "anthropic" and ev[0]["cost_usd"] == "0.034000"
    img = c.get(f"/api/projects/{pid}/outputs", headers=alice["headers"]).json()["images"][0]
    assert img["options"]["premium_prompting"] is True and img["options"]["prompt_notes"].startswith("Read two")
    assert {e["service"] for e in c.get("/api/usage", headers=alice["headers"]).json()["events"]} == {"Premium render", "Premium prompting"}

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
