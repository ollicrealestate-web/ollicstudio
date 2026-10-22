"""Construction animation settings, and the AI "director" that changes them from plain words.

The animation itself runs in the customer's browser (web/assets/construction.js) from the
IFC model: site, foundation, each floor's structure and walls, doors and windows, roof, a
fly-around, furniture, then the rooms, then the AI renders of the rooms. These settings say
how long each part lasts, what is shown and how it looks. The same rules are written out in
construction.js; tests check the two agree.

The director never touches the model or the video: it only returns new settings, which are
validated here before the browser sees them. Customers never see which AI model it is.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Literal

import httpx
from pydantic import BaseModel, Field, field_validator, model_validator

from .prompt_writer import API_VERSION, cost_usd

log = logging.getLogger("ollic.animation")

PHASES = ("site", "foundation", "structure", "walls", "openings", "roof", "orbit", "furnish", "interior")
PHASE_NAMES = {"site": "Site", "foundation": "Foundation", "structure": "Columns, beams and slabs (per floor)", "walls": "Walls (per floor)",
               "openings": "Doors and windows", "roof": "Roof", "orbit": "Fly-around of the finished building", "furnish": "Furniture",
               "interior": "Inside the rooms (per room)"}
DEFAULT_SECONDS = {"site": 3, "foundation": 4, "structure": 4, "walls": 3, "openings": 3, "roof": 4, "orbit": 8, "furnish": 4, "interior": 4}
LIMITS = {"site": (1, 12), "foundation": (1, 15), "structure": (1, 15), "walls": (1, 15), "openings": (1, 12), "roof": (1, 15),
          "orbit": (2, 30), "furnish": (1, 15), "interior": (2, 15)}
HIDEABLE = ("furniture", "stairs", "beams", "columns", "footings", "doors", "windows", "railings")
TIMES = ("morning", "midday", "golden hour", "dusk")
FORMATS = ("16:9", "9:16", "1:1")
MAX_SECONDS = 300


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


class Phase(BaseModel):
    on: bool = True
    seconds: float = 3


class Script(BaseModel):
    """Everything the customer (or the director) can change. Out-of-range numbers are brought into range, not refused."""
    version: Literal[1] = 1
    phases: dict[str, Phase] = Field(default_factory=dict)
    rooms: list[str] = Field(default_factory=list, max_length=40, description="rooms to visit inside, in order; empty means all")
    time_of_day: Literal["morning", "midday", "golden hour", "dusk"] = "midday"
    direction: Literal["clockwise", "anticlockwise"] = "anticlockwise"
    hide: list[Literal["furniture", "stairs", "beams", "columns", "footings", "doors", "windows", "railings"]] = Field(default_factory=list)
    renders: bool = True
    render_seconds: float = 4
    captions: bool = True
    title: str = Field(default="", max_length=80)
    subtitle: str = Field(default="", max_length=120)
    format: Literal["16:9", "9:16", "1:1"] = "16:9"

    @field_validator("phases", mode="before")
    @classmethod
    def known_phases(cls, v):
        v = v or {}
        if not isinstance(v, dict):
            raise ValueError("phases must be an object")
        out = {}
        for k, p in v.items():
            if k not in PHASES:
                continue
            if isinstance(p, dict) and p.get("seconds") is None:
                p = {**p, "seconds": DEFAULT_SECONDS[k]}   # a phase given only "on" keeps its own length
            out[k] = p
        return out

    @field_validator("rooms")
    @classmethod
    def tidy_rooms(cls, v):
        out = []
        for r in v:
            r = " ".join(str(r).split())[:120]
            if r and r.lower() not in (x.lower() for x in out):
                out.append(r)
        return out

    @field_validator("hide")
    @classmethod
    def unique(cls, v):
        return list(dict.fromkeys(v))

    @field_validator("title", "subtitle")
    @classmethod
    def one_line(cls, v):
        return " ".join(v.split())

    @model_validator(mode="after")
    def fill_and_clamp(self):
        for k in PHASES:
            p = self.phases.get(k) or Phase(seconds=DEFAULT_SECONDS[k])
            lo, hi = LIMITS[k]
            self.phases[k] = Phase(on=p.on, seconds=round(_clamp(float(p.seconds), lo, hi), 2))
        self.phases = {k: self.phases[k] for k in PHASES}
        self.render_seconds = round(_clamp(float(self.render_seconds), 2.5, 10), 2)
        return self


def default_script() -> Script:
    return Script()


def restrict_rooms(script: Script, known: list[str]) -> Script:
    """Keeps only rooms the model has, matched without regard to case, in the model's spelling."""
    if not known:
        return script.model_copy(update={"rooms": []})
    by_lower = {k.lower(): k for k in known}
    return script.model_copy(update={"rooms": [by_lower[r.lower()] for r in script.rooms if r.lower() in by_lower]})


# ---------------------------------------------------------------- the director
SYSTEM = (
    "You direct construction animations of buildings for architects. The animation is generated from the architect's BIM model in this order: "
    "site (empty plot, setting-out lines), foundation (footings and ground slab rise), then for each floor in turn: structure (columns grow, beams and slabs drop in) "
    "and walls (walls rise), then openings (doors and windows), roof (comes down), orbit (camera flies around the finished building), "
    "furnish (roof lifts off and furniture drops into the rooms), interior (camera stands in each room and pans slowly), then still AI renders of the rooms. "
    "You receive the current settings as JSON, facts about the model, and the architect's request in plain words. Change only what the request asks; keep everything else exactly. "
    "Settings: phases.<name>.on (true/false) and phases.<name>.seconds. Phase names: " + ", ".join(PHASES) + ". "
    "structure and walls seconds are PER FLOOR; interior seconds are PER ROOM. Ranges in seconds: "
    + ", ".join(f"{k} {lo}-{hi}" for k, (lo, hi) in LIMITS.items()) + ". "
    "'slower' means more seconds (about 1.5x unless a number is given), 'faster' means fewer. "
    "rooms: names of rooms to visit inside, in order, using ONLY names from the model facts; an empty list means all rooms. "
    "time_of_day: one of " + ", ".join(TIMES) + " (sunset means golden hour; evening means dusk). "
    "direction: clockwise or anticlockwise (the fly-around). hide: groups not to show, from: " + ", ".join(HIDEABLE) + ". "
    "renders: true to end with the AI renders of the rooms; render_seconds 2.5-10 each. captions: true to show stage names. "
    "title, subtitle: text on the opening card. format: 16:9, 9:16 or 1:1 (portrait for Instagram Reels, TikTok and WhatsApp Status is 9:16). "
    "If the request asks for something these settings cannot do (people, cranes, weather, sound, changing the design), do what you can and say plainly in notes what is not possible. "
    'Answer with JSON only, no prose: {"settings": {...all settings...}, "notes": "one or two short sentences for the architect on what changed"}'
)


class DirectorFailed(Exception):
    pass


def _context_text(context: dict) -> str:
    rooms = context.get("rooms") or []
    return (f"Model facts: {context.get('floors') or 1} floor(s); rooms: {', '.join(rooms) if rooms else 'none named'}; "
            f"has: {', '.join(context.get('has') or []) or 'walls and slabs only'}.")


def _user_text(instruction: str, script: Script, context: dict) -> str:
    return f"Current settings: {script.model_dump_json()}\n{_context_text(context)}\nArchitect's request: {instruction}"


def parse_reply(text) -> tuple[dict, str]:
    if isinstance(text, dict):
        out = text
    else:
        m = re.search(r"\{.*\}", str(text or ""), re.S)
        try:
            out = json.loads(m.group(0)) if m else {}
        except ValueError:
            out = {}
    settings = out.get("settings") if isinstance(out.get("settings"), dict) else None
    if settings is None:
        raise DirectorFailed("the director returned no settings")
    return settings, " ".join(str(out.get("notes") or "").split())[:400]


def apply_reply(current: Script, settings: dict) -> Script:
    """The director's settings over the current ones; anything invalid keeps the current value."""
    merged = current.model_dump()
    for k, v in settings.items():
        if k == "phases" and isinstance(v, dict):
            for name, p in v.items():
                if name in PHASES and isinstance(p, dict):
                    merged["phases"][name] = {**merged["phases"][name], **{x: y for x, y in p.items() if x in ("on", "seconds")}}
        elif k in merged and k != "version":
            merged[k] = v
    try:
        return Script.model_validate(merged)
    except Exception:
        # one bad field must not throw away the rest: apply field by field
        out = current
        for k, v in settings.items():
            if k in ("phases", "version") or k not in merged:
                continue
            try:
                out = Script.model_validate({**out.model_dump(), k: v})
            except Exception:
                log.info("director gave an invalid %s; kept the current value", k)
        try:
            out = Script.model_validate({**out.model_dump(), "phases": merged["phases"]})
        except Exception:
            pass
        return out


class CloudflareDirector:
    """The free text model on Cloudflare Workers AI (inside the daily free allowance)."""
    MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    provider = "cloudflare"

    def __init__(self, account_id: str, api_token: str, client: httpx.Client | None = None, model: str | None = None):
        self._http = client or httpx.Client(base_url="https://api.cloudflare.com", timeout=httpx.Timeout(60, connect=15))
        self._acct, self.model = account_id, model or self.MODEL
        self._headers = {"Authorization": f"Bearer {api_token}"}

    def direct(self, instruction: str, script: Script, context: dict) -> dict:
        body = {"messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": _user_text(instruction, script, context)}],
                "max_tokens": 1400, "temperature": 0}
        try:
            res = self._http.post(f"/client/v4/accounts/{self._acct}/ai/run/{self.model}", json=body, headers=self._headers)
        except httpx.HTTPError as exc:
            raise DirectorFailed(f"could not reach the text model: {exc.__class__.__name__}") from exc
        try:
            payload = res.json()
        except ValueError:
            payload = {}
        if res.status_code >= 400 or payload.get("success") is False:
            errs = payload.get("errors") or [{}]
            raise DirectorFailed(f"text model error {res.status_code}: {str(errs[0].get('message'))[:200]}")
        result = payload.get("result") if isinstance(payload.get("result"), dict) else payload
        text = result.get("response")
        if text is None and isinstance(result.get("choices"), list) and result["choices"]:
            text = (result["choices"][0].get("message") or {}).get("content")
        settings, notes = parse_reply(text)
        return {"settings": settings, "notes": notes, "model": self.model, "usage": result.get("usage"), "cost_usd": None}


class ClaudeDirector:
    """Premium: Claude reads the request more carefully, e.g. several changes at once."""
    provider = "anthropic"

    def __init__(self, api_key: str, model: str = "claude-opus-5-5", client: httpx.Client | None = None):
        self.model = model
        self._http = client or httpx.Client(base_url="https://api.anthropic.com", timeout=httpx.Timeout(60, connect=15))
        self._headers = {"x-api-key": api_key, "anthropic-version": API_VERSION, "content-type": "application/json"}

    def direct(self, instruction: str, script: Script, context: dict) -> dict:
        body = {"model": self.model, "max_tokens": 1500, "system": SYSTEM,
                "messages": [{"role": "user", "content": _user_text(instruction, script, context)}]}
        try:
            res = self._http.post("/v1/messages", json=body, headers=self._headers)
        except httpx.HTTPError as exc:
            raise DirectorFailed(f"could not reach the director: {exc.__class__.__name__}") from exc
        if res.status_code >= 400:
            raise DirectorFailed(f"director error {res.status_code}")
        payload = res.json()
        text = "".join(b.get("text", "") for b in payload.get("content", []) if b.get("type") == "text")
        settings, notes = parse_reply(text)
        usage = payload.get("usage")
        return {"settings": settings, "notes": notes, "model": self.model, "usage": usage, "cost_usd": cost_usd(self.model, usage)}
