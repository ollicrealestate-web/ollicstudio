"""Ollic AI for Sketch: the server end. A stand-in assistant (no cost) and a check of the real request shape."""

from __future__ import annotations

import base64
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import TokenVerifier
from app.config import Settings
from app.jobs import InlineRunner
from app.main import create_app
from app.sketch_ai import RULES, ClaudeSketchAI, estimate_usd, tools_for
from tests.conftest import SECRET, jpeg_bytes


class StandInAI:
    """Answers each step from a script; records what it was given."""

    model = "claude-opus-5-5"

    def __init__(self):
        self.calls = []
        self.replies = []

    def step(self, *, stage, messages, tools):
        self.calls.append({"stage": stage, "messages": messages, "tools": [t["name"] for t in tools]})
        content = self.replies.pop(0) if self.replies else [{"type": "text", "text": "Done."}]
        return {"content": content, "stop_reason": "tool_use" if any(b["type"] == "tool_use" for b in content) else "end_turn",
                "usage": {"input_tokens": 12000, "output_tokens": 800, "cache_read_input_tokens": 4000}, "cost_usd": __import__("decimal").Decimal("0.081"), "model": self.model}


OFFERED = [{"name": "add_cladding", "description": "Cladding", "input_schema": {"type": "object", "properties": {}}},
           {"name": "list_materials", "description": "Materials", "input_schema": {"type": "object", "properties": {}}},
           {"name": "rm_rf", "description": "not a command", "input_schema": {"type": "object"}}]


@pytest.fixture
def ai():
    return StandInAI()


@pytest.fixture
def aclient(settings, repo, storage, ai):
    app = create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings), runner=InlineRunner(), sketch_ai=ai)
    return TestClient(app)


def _session(c, user, **kw):
    r = c.post("/api/sketch-ai/sessions", json={"detail": "medium", "pictures": 7, "references": 2, **kw}, headers=user["headers"])
    assert r.status_code == 201, r.text
    return r.json()


def test_not_set_up_says_so_plainly(client, alice):
    assert client.get("/api/sketch-ai/config", headers=alice["headers"]).json()["available"] is False
    r = client.post("/api/sketch-ai/sessions", json={}, headers=alice["headers"])
    assert r.status_code == 503 and "not set up" in r.json()["detail"]


def test_session_has_an_estimate_and_steps_log_their_cost(aclient, alice, ai, repo):
    s = _session(aclient, alice)
    assert 0 < s["estimate"]["low_usd"] < s["estimate"]["high_usd"] and s["status"] == "open"
    ai.replies = [[{"type": "text", "text": "I see a two-storey house."}, {"type": "tool_use", "id": "t1", "name": "ask_questions", "input": {"questions": []}}]]
    r = aclient.post(f"/api/sketch-ai/sessions/{s['id']}/step", json={"stage": "interview", "messages": [{"role": "user", "content": "hello"}], "tools": OFFERED}, headers=alice["headers"])
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["content"][1]["name"] == "ask_questions" and out["stop_reason"] == "tool_use"
    assert out["usage"] == {"input_tokens": 16000, "output_tokens": 800} and out["cost_usd"] == pytest.approx(0.081)
    aclient.post(f"/api/sketch-ai/sessions/{s['id']}/step", json={"stage": "plan", "messages": [{"role": "user", "content": "go"}]}, headers=alice["headers"])
    row = repo.ai_sessions[s["id"]]
    assert float(row["cost_usd"]) == pytest.approx(0.162) and row["input_tokens"] == 32000 and len(repo.ai_calls) == 2
    assert {c["stage"] for c in repo.ai_calls} == {"interview", "plan"}


def test_each_stage_gets_only_its_tools(aclient, alice, ai):
    s = _session(aclient, alice)
    for stage in ("interview", "build", "report"):
        aclient.post(f"/api/sketch-ai/sessions/{s['id']}/step", json={"stage": stage, "messages": [{"role": "user", "content": "x"}], "tools": OFFERED}, headers=alice["headers"])
    interview, build, report = (c["tools"] for c in ai.calls)
    assert "add_cladding" not in interview and "list_materials" in interview and "ask_questions" in interview
    assert "add_cladding" in build and "item_done" in build
    assert report == ["final_report"]
    assert all("rm_rf" not in t for t in (interview, build, report)), "anything that is not a command is dropped"


def test_sessions_are_private(aclient, alice, bob, ai):
    s = _session(aclient, alice)
    for r in (aclient.get(f"/api/sketch-ai/sessions/{s['id']}", headers=bob["headers"]),
              aclient.post(f"/api/sketch-ai/sessions/{s['id']}/step", json={"stage": "plan", "messages": [{"role": "user", "content": "x"}]}, headers=bob["headers"]),
              aclient.patch(f"/api/sketch-ai/sessions/{s['id']}", json={"status": "stopped"}, headers=bob["headers"])):
        assert r.status_code == 404
    assert not ai.calls and aclient.get("/api/sketch-ai/sessions", headers=bob["headers"]).json() == []


def test_reference_images_are_stored_privately_and_limited(aclient, alice, storage):
    s = _session(aclient, alice)
    data = "data:image/jpeg;base64," + base64.b64encode(jpeg_bytes(2400, 1600)).decode()
    r = aclient.post(f"/api/sketch-ai/sessions/{s['id']}/references", json={"data_url": data, "name": "duplex.jpg"}, headers=alice["headers"])
    assert r.status_code == 201, r.text
    ref = r.json()
    assert ref["n"] == 1 and ref["path"].startswith(f"{alice['id']}/{s['id']}/") and max(ref["width"], ref["height"]) == 1568
    assert ref["path"] in storage.buckets["sketch-ai"]
    got = aclient.get(f"/api/sketch-ai/sessions/{s['id']}", headers=alice["headers"]).json()
    assert got["refs"][0]["url"].startswith("https://") and got["refs"][0]["name"] == "duplex.jpg"
    bad = aclient.post(f"/api/sketch-ai/sessions/{s['id']}/references", json={"data_url": "data:image/png;base64," + base64.b64encode(b"not a picture").decode()}, headers=alice["headers"])
    assert bad.status_code == 422 and "not a picture" in bad.json()["detail"]
    for _ in range(5):
        aclient.post(f"/api/sketch-ai/sessions/{s['id']}/references", json={"data_url": data}, headers=alice["headers"])
    seventh = aclient.post(f"/api/sketch-ai/sessions/{s['id']}/references", json={"data_url": data}, headers=alice["headers"])
    assert seventh.status_code == 422 and "Up to 6" in seventh.json()["detail"]


def test_saving_the_record_and_finishing(aclient, alice, repo):
    s = _session(aclient, alice)
    r = aclient.patch(f"/api/sketch-ai/sessions/{s['id']}", json={"chat": [{"from": "ai", "text": "Hi"}], "plan": [{"n": 1, "title": "Cladding"}], "stage": "plan"}, headers=alice["headers"])
    assert r.status_code == 200 and r.json()["plan"][0]["title"] == "Cladding"
    aclient.patch(f"/api/sketch-ai/sessions/{s['id']}", json={"status": "accepted"}, headers=alice["headers"])
    late = aclient.post(f"/api/sketch-ai/sessions/{s['id']}/step", json={"stage": "build", "messages": [{"role": "user", "content": "x"}]}, headers=alice["headers"])
    assert late.status_code == 409


def test_the_real_request_shape(monkeypatch):
    """What goes to the Messages API: the model from CLAUDE_MODEL, cached rules, the stage note, tools, images."""
    monkeypatch.setenv("CLAUDE_MODEL", "claude-sonnet-5-5")
    monkeypatch.setenv("SUPABASE_URL", "https://x.supabase.co"); monkeypatch.setenv("SUPABASE_ANON_KEY", "anon")
    assert Settings.from_env().claude_model == "claude-sonnet-5-5"
    seen = {}

    def handler(req: httpx.Request):
        seen["body"] = json.loads(req.content); seen["headers"] = req.headers
        return httpx.Response(200, json={"content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn", "usage": {"input_tokens": 1000, "output_tokens": 100}})

    ai = ClaudeSketchAI("sk-test", "claude-sonnet-5-5", client=httpx.Client(base_url="https://api.anthropic.com", transport=httpx.MockTransport(handler)))
    img = {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(jpeg_bytes()).decode()}}
    out = ai.step(stage="build", messages=[{"role": "user", "content": [{"type": "text", "text": "build"}, img]}], tools=tools_for("build", OFFERED))
    b = seen["body"]
    assert b["model"] == "claude-sonnet-5-5" and seen["headers"]["x-api-key"] == "sk-test"
    assert b["system"][0]["text"] == RULES and b["system"][0]["cache_control"] == {"type": "ephemeral"} and "Stage: build" in b["system"][1]["text"]
    assert [t["name"] for t in b["tools"]] == ["item_done", "add_cladding", "list_materials"] and b["tools"][-1]["cache_control"]
    assert out["cost_usd"] is not None and out["content"][0]["text"] == "ok"


def test_estimate_grows_with_pictures_and_items():
    a = estimate_usd("claude-opus-5-5", pictures=7, references=0, summary_kb=8)
    b = estimate_usd("claude-opus-5-5", pictures=7, references=6, summary_kb=8, items=12)
    assert b["high_usd"] > a["high_usd"] > a["low_usd"] > 0
    assert "Never name the company" in RULES and "Ollic AI" in RULES


def test_cost_limit_stops_a_session(aclient, alice, repo):
    s = _session(aclient, alice)
    repo.ai_sessions[s["id"]]["cost_usd"] = "15.01"
    r = aclient.post(f"/api/sketch-ai/sessions/{s['id']}/step", json={"stage": "build", "messages": [{"role": "user", "content": "x"}]}, headers=alice["headers"])
    assert r.status_code == 402 and "cost limit" in r.json()["detail"]


def test_busy_assistant_is_retried_and_cache_is_priced_right():
    from app.sketch_ai import step_cost
    answers = [httpx.Response(529, json={"error": {"message": "Overloaded"}}), httpx.Response(200, json={"content": [], "stop_reason": "end_turn", "usage": {"input_tokens": 1000, "cache_read_input_tokens": 10000, "output_tokens": 100}})]
    waits = []
    ai = ClaudeSketchAI("k", "claude-opus-5-5", client=httpx.Client(base_url="https://api.anthropic.com", transport=httpx.MockTransport(lambda req: answers.pop(0))), sleep=waits.append)
    out = ai.step(stage="plan", messages=[{"role": "user", "content": "x"}], tools=[])
    assert waits == [4] and out["stop_reason"] == "end_turn"
    # 1,000 new + 10,000 cached (at a tenth) input at $4/M, 100 output at $20/M
    assert float(out["cost_usd"]) == pytest.approx((1000 + 1000) * 4 / 1e6 + 100 * 20 / 1e6)
    assert float(step_cost("claude-opus-5-5", {"input_tokens": 0, "cache_creation_input_tokens": 1000, "output_tokens": 0})) == pytest.approx(1250 * 4 / 1e6)
