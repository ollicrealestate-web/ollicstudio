"""Ollic AI for Sketch ("Complete my design"): the server end of the assistant.

The model lives in the browser, so the browser runs the commands (add_cladding, add_railing ...), each checked there
in code. The server holds the key and the instructions: each step, the browser sends the conversation so far and the
command definitions; the server adds its own instructions and the questions-and-plan tools, asks Claude once, logs
the cost, and returns Claude's answer (text and tool calls) for the browser to carry out. The customer never sees
which model does this; the interface calls it Ollic AI.

Messages API with tool use and images; model set by CLAUDE_MODEL. Prices from prompt_writer.PRICES.
"""

from __future__ import annotations

import json
import logging
from decimal import Decimal
from pathlib import Path

import httpx

from .prompt_writer import API_VERSION, PRICES, cost_usd

log = logging.getLogger("ollic.sketch_ai")


class SketchAIFailed(Exception):
    pass


# ---------------------------------------------------------------- what Ollic AI is told, and its tools
# Kept in sketch_ai_prompts.json so the live check (tests/sketch/live_check.mjs) sends exactly the same.
_P = json.loads((Path(__file__).with_name("sketch_ai_prompts.json")).read_text(encoding="utf-8"))
RULES: str = _P["rules"]
STAGES: dict[str, str] = _P["stages"]
META_TOOLS: dict[str, dict] = _P["meta_tools"]
STAGE_META: dict[str, list[str]] = _P["stage_meta"]
MODEL_TOOLS = set(_P["model_tools"])  # model commands the browser may offer; anything else it sends is dropped
READ_TOOLS = set(_P["read_tools"])
STAGE_MODEL_TOOLS = {k: {"all": MODEL_TOOLS, "read": READ_TOOLS, "none": set()}[v] for k, v in _P["stage_model_tools"].items()}


def tools_for(stage: str, offered: list[dict]) -> list[dict]:
    """The stage's own tools plus the model commands the browser offered that this stage may use."""
    allowed = STAGE_MODEL_TOOLS[stage]
    out = [{"name": n, **META_TOOLS[n]} for n in STAGE_META[stage]]
    for t in offered:
        name = t.get("name")
        if name in allowed and isinstance(t.get("input_schema"), dict):
            out.append({"name": name, "description": str(t.get("description", ""))[:1500], "input_schema": t["input_schema"]})
    return out


def system_for(stage: str) -> list[dict]:
    # the rules are the same in every call, so they are cached; the stage note follows
    return [{"type": "text", "text": RULES, "cache_control": {"type": "ephemeral"}}, {"type": "text", "text": STAGES[stage]}]


# ---------------------------------------------------------------- cost
IMAGE_TOKENS = 1100      # a 1024 x 768 picture is about 1,050 tokens
SUMMARY_TOKENS_PER_KB = 300


def estimate_usd(model: str, *, pictures: int, references: int, summary_kb: float, items: int = 8, rounds: int = 3) -> dict:
    """A range for the whole session: questions, plan, build, up to `rounds` checks, report."""
    pin, pout = (Decimal(p) for p in PRICES.get(model, PRICES["claude-opus-5-5"]))
    base = 4500 + int(summary_kb * SUMMARY_TOKENS_PER_KB)               # instructions, commands, summary
    look = (pictures + references) * IMAGE_TOKENS
    calls = [base + look, base + look, base + 2000]                     # describe/ask, ask again, plan
    calls += [base + 3000 + 900 * k for k in range(items * 2)]          # build: about two calls per item, history growing
    calls += [base + 7 * IMAGE_TOKENS + 4000 for _ in range(rounds * 2)]  # checks with fresh pictures
    calls += [base + 3000]                                              # report
    tin, tout = sum(calls), len(calls) * 700
    low = (Decimal(tin) * Decimal("0.55") * pin + Decimal(tout) * Decimal("0.6") * pout) / 1_000_000  # with caching, fewer checks
    high = (Decimal(tin) * pin + Decimal(tout) * pout) / 1_000_000
    return {"low_usd": float(round(low, 2)), "high_usd": float(round(high, 2)), "model": model, "calls": len(calls)}


# ---------------------------------------------------------------- the client
class ClaudeSketchAI:
    def __init__(self, api_key: str, model: str, client: httpx.Client | None = None):
        self.model = model
        self._http = client or httpx.Client(base_url="https://api.anthropic.com", timeout=httpx.Timeout(240, connect=15))
        self._headers = {"x-api-key": api_key, "anthropic-version": API_VERSION, "content-type": "application/json"}

    def step(self, *, stage: str, messages: list[dict], tools: list[dict], max_tokens: int = 8000) -> dict:
        body = {"model": self.model, "max_tokens": max_tokens, "system": system_for(stage), "messages": messages}
        if tools:
            tools = [dict(t) for t in tools]
            tools[-1]["cache_control"] = {"type": "ephemeral"}
            body["tools"] = tools
        try:
            res = self._http.post("/v1/messages", json=body, headers=self._headers)
        except httpx.HTTPError as exc:
            raise SketchAIFailed(f"could not reach the assistant: {exc.__class__.__name__}") from exc
        if res.status_code >= 400:
            try:
                why = (res.json().get("error") or {}).get("message", "")[:200]
            except ValueError:
                why = ""
            log.warning("assistant error %s: %s", res.status_code, why)
            raise SketchAIFailed(f"assistant error {res.status_code}: {why}")
        p = res.json()
        usage = p.get("usage") or {}
        return {"content": p.get("content", []), "stop_reason": p.get("stop_reason"), "usage": usage, "cost_usd": cost_usd(self.model, usage), "model": self.model}
