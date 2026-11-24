"""Ollic AI for Sketch ("Complete my design"): the server end of the assistant.

The model lives in the browser, so the browser runs the commands (add_cladding, add_railing ...), each checked there
in code. The server holds the key and the instructions: each step, the browser sends the conversation so far and the
command definitions; the server adds its own instructions and the questions-and-plan tools, asks Claude once, logs
the cost, and returns Claude's answer (text and tool calls) for the browser to carry out. The customer never sees
which model does this; the interface calls it Ollic AI.

Messages API with tool use and images; model set by CLAUDE_MODEL. Prices from prompt_writer.PRICES.
"""

from __future__ import annotations

import logging
from decimal import Decimal

import httpx

from .prompt_writer import API_VERSION, PRICES, cost_usd

log = logging.getLogger("ollic.sketch_ai")


class SketchAIFailed(Exception):
    pass


# ---------------------------------------------------------------- what Ollic AI is told
RULES = """You are Ollic AI, the design assistant inside Ollic Sketch, working for an architect or builder in Nigeria.
Your job is to COMPLETE their design, not redesign it: their levels, walls, rooms and openings stay exactly where they drew them.
You add finishing: cladding, fins and louvres, balcony edges and glass railings, fascias (flat or curved), soffits, canopies, pergolas,
parapets and copings, bands and cornices, planters, steps, screens, and materials and colours.

Rules (the app also enforces them in code and will refuse a command that breaks them):
1. Their elements are locked. You may only ADD elements, or SET MATERIALS on theirs. Never try to move, resize or delete their elements;
   if one should change, say so in your message and let them decide.
2. Nothing may block a door or window opening, cut through a floor, roof, wall or another part, or float: everything must touch a wall,
   floor, roof, the ground or another part.
3. Levels and heights stay within the Sketch limits (10 levels, 40 m).
4. Use normal building sizes: railings 1000-1100 mm high, coping overhang 25-50 mm, fins 100-600 mm deep, steps 120-180 mm risers and
   250-400 mm treads. Outside the normal range, give a reason (the commands take a `reason`).
5. Use only element ids, edge refs, profiles and materials that exist (the model summary, get_edges, list_profiles, list_materials).
   If something is not in a library, say so and use the closest one.
6. Be honest: say what you could not build with the commands available, and anything they should check.

Units: millimetres. Plan coordinates: x east, y north (+y is north). Walls run from `start` to `end`; positions along a wall are measured
from its start. A wall's `outer_face_faces` is the compass direction its outside looks. Floor and roof edges are numbered "<id>:e<k>";
`wall_on_or_under: false` marks a free edge (a balcony edge). Speak plain, short English: they are a builder, not a developer.
Never name the company or model behind you; you are Ollic AI."""

STAGES = {
    "interview": (
        "Stage: understand and ask. You have the model summary and pictures (clay views and plans with ids) and maybe their reference images "
        "and a description. If there are reference images, call describe_references first: for each image, what you see and what you plan to take "
        "from it, in plain words. Then, if you need answers, call ask_questions: at most 6 short, specific questions, each with 2-7 tap-to-choose "
        "answers (they can also type their own). Ask only what you actually need: if the references or their words already answer it, do not ask. "
        "If you have enough, say so in one sentence and call ask_questions with an empty list."
    ),
    "plan": (
        "Stage: the plan. Using their answers and corrections, call write_plan with a numbered plan. Each item: what you will add, where (element "
        "ids and edge refs, and in words such as 'front balconies, Levels 2-3'), the sizes, the material (library id), which reference image it "
        "comes from, and the commands you will use. Respect the level of detail they chose (light: materials, railings, copings; medium: also bands, "
        "fins, canopies, soffits, planters; full: everything the references show) and the scope. Keep items buildable with the commands."
    ),
    "build": (
        "Stage: build. Build the plan items you are given, in order, with the model commands, each with its plan_item number. Check sizes and ids "
        "before each call (get_element, get_edges if unsure). If a command is refused, read the reason, fix the input and try again (at most 3 "
        "tries per item). When an item is done (or you give up on it), call item_done with its number, the new element ids, ok true/false and a "
        "short note. When all items are done, stop."
    ),
    "check": (
        "Stage: check your work. You have fresh clay views and a material view of the model with your additions, the plan and the references. "
        "Look for floating parts, parts cutting through windows or doors, parts on the wrong side or wrong face, gaps at corners, items missing "
        "or not matching the plan. Call check_result with ok and the problems (plan item and what is wrong). Then fix the problems with the "
        "commands (edit_element, delete_element, or new adds; only elements you added), and call item_done for each item you changed."
    ),
    "revise": (
        "Stage: change one item. They asked for a change to one plan item, in their words. Change only that item's elements (edit_element, "
        "delete_element, or new adds with the same plan_item), then call item_done for it."
    ),
    "report": (
        "Stage: the honest report. Call final_report: what you built (by plan item), what you could not build with the commands available or "
        "simplified (for example 'the decorative screen in image 3 is simplified to vertical slats'), and anything they should check."
    ),
}

# ---------------------------------------------------------------- tools that are not model commands
_STR = {"type": "string"}
META_TOOLS = {
    "describe_references": {"description": "Say what you see in each reference image and what you plan to take from it.", "input_schema": {
        "type": "object", "properties": {"images": {"type": "array", "items": {"type": "object", "properties": {"n": {"type": "integer"}, "sees": _STR, "takes": _STR}, "required": ["n", "sees", "takes"]}}},
        "required": ["images"]}},
    "ask_questions": {"description": "Ask up to 6 short questions, each with tap-to-choose answers. An empty list means you have enough.", "input_schema": {
        "type": "object", "properties": {"questions": {"type": "array", "maxItems": 6, "items": {"type": "object", "properties": {
            "id": _STR, "text": _STR, "choices": {"type": "array", "items": _STR, "maxItems": 7}, "multiple": {"type": "boolean"}}, "required": ["id", "text", "choices"]}},
            "note": _STR}, "required": ["questions"]}},
    "write_plan": {"description": "The numbered plan of what you will add.", "input_schema": {
        "type": "object", "properties": {"items": {"type": "array", "items": {"type": "object", "properties": {
            "n": {"type": "integer"}, "title": {"type": "string", "description": "Short, e.g. 'Travertine cladding, south walls'"}, "what": _STR, "where": _STR,
            "sizes": _STR, "material": _STR, "image": {"type": "integer"}, "commands": {"type": "array", "items": _STR}}, "required": ["n", "title", "what", "where"]}},
            "summary": _STR}, "required": ["items"]}},
    "item_done": {"description": "Report one plan item finished (or given up).", "input_schema": {
        "type": "object", "properties": {"plan_item": {"type": "integer"}, "ids": {"type": "array", "items": _STR}, "ok": {"type": "boolean"}, "note": _STR}, "required": ["plan_item", "ok"]}},
    "check_result": {"description": "What you found when checking your work.", "input_schema": {
        "type": "object", "properties": {"ok": {"type": "boolean"}, "problems": {"type": "array", "items": {"type": "object", "properties": {"plan_item": {"type": "integer"}, "problem": _STR}, "required": ["problem"]}}}, "required": ["ok"]}},
    "final_report": {"description": "The honest report at the end.", "input_schema": {
        "type": "object", "properties": {"built": {"type": "array", "items": _STR}, "not_built": {"type": "array", "items": _STR}, "please_check": {"type": "array", "items": _STR}}, "required": ["built", "not_built", "please_check"]}},
}
STAGE_META = {"interview": ["describe_references", "ask_questions"], "plan": ["write_plan"], "build": ["item_done"], "check": ["check_result", "item_done"], "revise": ["item_done"], "report": ["final_report"]}
# model commands the browser may offer; anything else it sends is dropped
MODEL_TOOLS = {"add_cladding", "add_wall_sweep", "add_edge_sweep", "add_extrusion", "add_void", "add_railing", "add_fins", "add_canopy", "add_pergola",
               "add_soffit", "add_parapet", "add_planter", "add_steps", "add_screen", "set_material", "edit_element", "delete_element",
               "get_element", "get_edges", "list_materials", "list_profiles", "get_model_summary"}
READ_TOOLS = {"get_element", "get_edges", "list_materials", "list_profiles", "get_model_summary"}
STAGE_MODEL_TOOLS = {"interview": READ_TOOLS, "plan": READ_TOOLS, "build": MODEL_TOOLS, "check": MODEL_TOOLS, "revise": MODEL_TOOLS, "report": set()}


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
