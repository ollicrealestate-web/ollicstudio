"""Construction animation: settings, the plain-language director, and export (upload of the
browser-made video, then the job that makes it phone-friendly). Video tests use real FFmpeg."""

from __future__ import annotations

import json
import shutil
import subprocess

import httpx
import pytest
from fastapi.testclient import TestClient

from app.animation import (DEFAULT_SECONDS, LIMITS, PHASES, ClaudeDirector, CloudflareDirector, DirectorFailed, Script, apply_reply, parse_reply,
                           restrict_rooms)
from app.animation_jobs import UPLOAD_DIR
from app.auth import TokenVerifier
from app.jobs import InlineRunner
from app.main import create_app

from .conftest import FakeImages
from .test_studio import new_project
from .test_walkthrough import save_shot

WEB = __import__("pathlib").Path(__file__).resolve().parents[2] / "web"
needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is not installed")


class FakeDirector:
    def __init__(self, provider="cloudflare", settings=None, fail=False):
        self.provider, self.settings, self.fail, self.calls = provider, settings or {}, fail, []

    def direct(self, instruction, script, context):
        self.calls.append((instruction, script, context))
        if self.fail:
            raise DirectorFailed("down")
        return {"settings": self.settings, "notes": "Slowed the roof.", "model": f"fake-{self.provider}", "usage": {"tokens": 10}, "cost_usd": None}


@pytest.fixture
def anim(render_settings, repo, storage):
    std, prem = FakeDirector(settings={"phases": {"roof": {"seconds": 6}}, "time_of_day": "golden hour"}), FakeDirector("anthropic", {"format": "9:16"})
    app = create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=FakeImages(), runner=InlineRunner(),
                     directors={"standard": std, "premium": prem})
    return TestClient(app), std, prem


# ---------------------------------------------------------------- settings
def test_settings_are_filled_and_brought_into_range():
    s = Script.model_validate({"phases": {"roof": {"seconds": 99}, "orbit": {"on": False}, "rocket": {"seconds": 3}}, "rooms": ["Kitchen", " kitchen ", "Living  room"],
                               "render_seconds": 1, "title": "  Villa \n A "})
    assert list(s.phases) == list(PHASES) and s.phases["roof"].seconds == LIMITS["roof"][1]
    assert s.phases["orbit"].on is False and s.phases["orbit"].seconds == DEFAULT_SECONDS["orbit"]
    assert s.rooms == ["Kitchen", "Living room"] and s.render_seconds == 2.5 and s.title == "Villa A"
    with pytest.raises(ValueError):
        Script.model_validate({"format": "4:3"})
    assert restrict_rooms(s, ["KITCHEN", "Bath"]).rooms == ["KITCHEN"]


def test_browser_and_server_share_the_same_rules():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    src = (WEB / "assets" / "construction.js").as_uri()
    out = subprocess.run([node, "--input-type=module", "-e", f"import * as c from '{src}'; console.log(JSON.stringify({{p: c.PHASES, d: c.DEFAULT_SECONDS, l: c.LIMITS, n: c.normalise({{phases: {{roof: {{seconds: 99}}}}}})}}))"],
                         capture_output=True, text=True, check=True)
    js = json.loads(out.stdout)
    assert js["p"] == list(PHASES) and js["d"] == DEFAULT_SECONDS and {k: tuple(v) for k, v in js["l"].items()} == LIMITS
    py = Script.model_validate({"phases": {"roof": {"seconds": 99}}}).model_dump()
    assert js["n"]["phases"] == py["phases"] and js["n"]["render_seconds"] == py["render_seconds"]
    out = subprocess.run([node, "--input-type=module", "-e", f"import * as c from '{src}'; console.log(JSON.stringify(c.defaultScript()))"], capture_output=True, text=True, check=True)
    assert json.loads(out.stdout) == Script().model_dump()     # the same starting settings everywhere


def test_director_replies_are_parsed_and_checked():
    settings, notes = parse_reply('Sure! {"settings": {"time_of_day": "dusk"}, "notes": "Evening light."} done')
    assert settings == {"time_of_day": "dusk"} and notes == "Evening light."
    with pytest.raises(DirectorFailed):
        parse_reply("I cannot do that")
    cur = Script(title="Villa")
    out = apply_reply(cur, {"time_of_day": "midnight", "phases": {"roof": {"seconds": 8}, "walls": {"on": False}}, "format": "9:16", "hide": ["stairs"]})
    assert out.time_of_day == "midday" and out.format == "9:16" and out.hide == ["stairs"]   # the one invalid value keeps the current one
    assert out.phases["roof"].seconds == 8 and out.phases["walls"].on is False and out.title == "Villa"


def test_cloudflare_and_claude_directors_read_their_replies():
    def cf(req):
        body = json.loads(req.content)
        assert body["messages"][0]["role"] == "system" and "Architect's request: slower roof" in body["messages"][1]["content"]
        return httpx.Response(200, json={"success": True, "result": {"response": '{"settings": {"phases": {"roof": {"seconds": 6}}}, "notes": "ok"}', "usage": {"total_tokens": 900}}})
    d = CloudflareDirector("acct", "tok", client=httpx.Client(base_url="https://api.cloudflare.com", transport=httpx.MockTransport(cf)))
    r = d.direct("slower roof", Script(), {"rooms": ["Kitchen"], "floors": 2, "has": ["roof"]})
    assert r["settings"]["phases"]["roof"]["seconds"] == 6 and r["model"].startswith("@cf/")

    def cl(req):
        assert req.headers["x-api-key"] == "k" and json.loads(req.content)["model"] == "claude-opus-5-5"
        return httpx.Response(200, json={"content": [{"type": "text", "text": '{"settings": {"format": "1:1"}, "notes": "Square."}'}], "usage": {"input_tokens": 1000, "output_tokens": 100}})
    c = ClaudeDirector("k", client=httpx.Client(base_url="https://api.anthropic.com", transport=httpx.MockTransport(cl)))
    r = c.direct("square please", Script(), {})
    assert r["settings"] == {"format": "1:1"} and str(r["cost_usd"]) == "0.006000"
    bad = CloudflareDirector("acct", "tok", client=httpx.Client(base_url="https://api.cloudflare.com", transport=httpx.MockTransport(lambda r: httpx.Response(500, json={"success": False}))))
    with pytest.raises(DirectorFailed):
        bad.direct("x", Script(), {})


# ---------------------------------------------------------------- the director endpoint
def test_plain_words_change_the_settings(anim, alice, bob, repo):
    c, std, prem = anim
    pid = new_project(c, alice)
    body = {"instruction": "slow down on the roof and show it at sunset", "script": {"title": "Villa", "rooms": ["Kitchen", "Garage"]},
            "context": {"rooms": ["Kitchen", "Living room"], "floors": 2, "has": ["roof", "furniture"]}}
    r = c.post(f"/api/projects/{pid}/animation/direct", json=body, headers=alice["headers"])
    assert r.status_code == 200, r.text
    s = r.json()["script"]
    assert s["phases"]["roof"]["seconds"] == 6 and s["time_of_day"] == "golden hour" and s["title"] == "Villa"
    assert s["rooms"] == ["Kitchen"]                       # rooms the model does not have are dropped
    assert r.json()["notes"] == "Slowed the roof." and std.calls and not prem.calls
    assert repo.usage[-1]["operation"] == "animation_direct" and repo.usage[-1]["provider"] == "cloudflare"
    assert c.post(f"/api/projects/{pid}/animation/direct", json=body, headers=bob["headers"]).status_code == 404
    assert c.post(f"/api/projects/{pid}/animation/direct", json={"instruction": "x"}, headers=alice["headers"]).status_code == 422
    usage = c.get("/api/usage", headers=alice["headers"]).json()
    assert "Animation director" in json.dumps(usage) and "cloudflare" not in json.dumps(usage).lower()

    repo.plans[alice["id"]] = "premium"                    # paid plans get the better director
    assert c.post(f"/api/projects/{pid}/animation/direct", json=body, headers=alice["headers"]).json()["script"]["format"] == "9:16" and prem.calls


def test_director_off_failing_and_daily_limit(render_settings, repo, storage, alice):
    def app_with(directors):
        return TestClient(create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=FakeImages(),
                                     runner=InlineRunner(), directors=directors))
    off = app_with({})
    pid = new_project(off, alice)
    body = {"instruction": "faster please"}
    assert off.post(f"/api/projects/{pid}/animation/direct", json=body, headers=alice["headers"]).status_code == 503
    r = app_with({"standard": FakeDirector(fail=True)}).post(f"/api/projects/{pid}/animation/direct", json=body, headers=alice["headers"])
    assert r.status_code == 502 and "another way" in r.json()["detail"]["reason"]
    ok = app_with({"standard": FakeDirector()})
    for _ in range(40):
        assert ok.post(f"/api/projects/{pid}/animation/direct", json=body, headers=alice["headers"]).status_code == 200
    r = ok.post(f"/api/projects/{pid}/animation/direct", json=body, headers=alice["headers"])
    assert r.status_code == 429 and "40" in r.json()["detail"]["reason"]


def test_defaults_endpoint(anim):
    c, _, _ = anim
    d = c.get("/api/animation/defaults").json()
    assert [p["id"] for p in d["phases"]] == list(PHASES) and d["script"]["format"] == "16:9"


# ---------------------------------------------------------------- export
def make_clip(tmp_path, codec="vp9", size=(1080, 1080), seconds=2.5, name="clip.mp4"):
    out = tmp_path / name
    enc = {"vp9": ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "1M"], "h264": ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]}[codec]
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=s={size[0]}x{size[1]}:d={seconds}:r=30", *enc, str(out)], check=True)
    return out.read_bytes()


def meta(**kw):
    return json.dumps({"script": {"format": "1:1", "title": "Villa build", **kw.pop("script", {})}, **kw})


def _probe(data, tmp_path):
    f = tmp_path / "out.mp4"; f.write_bytes(data)
    return json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(f)], capture_output=True, check=True).stdout)


@needs_ffmpeg
@pytest.mark.parametrize("codec", ["vp9", "h264"])
def test_export_saves_a_phone_friendly_mp4(anim, alice, bob, repo, storage, tmp_path, codec):
    c, _, _ = anim
    pid = new_project(c, alice)
    clip = make_clip(tmp_path, codec)
    before = set(UPLOAD_DIR.glob("*")) if UPLOAD_DIR.exists() else set()
    r = c.post(f"/api/projects/{pid}/animations", files={"file": ("construction.mp4", clip, "video/mp4")}, data={"meta": meta()}, headers=alice["headers"])
    assert r.status_code == 202, r.text
    job = repo.jobs[r.json()["id"]]
    assert job["type"] == "animation_export" and job["status"] == "succeeded", job["error"]
    assert job["input"]["codec"] == codec
    (vid,) = c.get(f"/api/projects/{pid}/videos", headers=alice["headers"]).json()
    assert vid["kind"] == "construction" and (vid["width"], vid["height"], vid["format"]) == (1080, 1080, "1:1") and vid["title"] == "Villa build"
    assert vid["download_url"].endswith("-1x1.mp4") and "ollic-construction-" in vid["download_url"] and "not to scale" in vid["label"]
    row = repo.videos[vid["id"]]
    assert row["script"]["title"] == "Villa build"
    info = _probe(storage.buckets["videos"][row["storage_path"]][0], tmp_path)
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    assert v["codec_name"] == "h264" and v["pix_fmt"] == "yuv420p" and any(s["codec_type"] == "audio" for s in info["streams"])
    assert abs(float(info["format"]["duration"]) - 2.5) < 0.2
    assert (set(UPLOAD_DIR.glob("*")) - before) == set()   # the upload is not kept on the server
    assert c.get(f"/api/projects/{pid}/videos", headers=bob["headers"]).status_code == 404


@needs_ffmpeg
def test_export_refusals(anim, alice, bob, repo, tmp_path):
    c, _, _ = anim
    pid = new_project(c, alice)
    clip = make_clip(tmp_path, "vp9")
    post = lambda user, data, m, p=pid: c.post(f"/api/projects/{p}/animations", files={"file": ("a.mp4", data, "video/mp4")}, data={"meta": m}, headers=user["headers"])  # noqa: E731
    assert post(bob, clip, meta()).status_code == 404
    r = post(alice, clip, meta(script={"format": "16:9"}))
    assert r.status_code == 422 and "1920×1080" in r.json()["detail"]["reason"]
    assert post(alice, b"not a video at all", meta()).json()["detail"]["code"] == "bad_video"
    assert post(alice, clip, "{not json").json()["detail"]["code"] == "bad_settings"
    other = new_project(c, alice)        # a render from another project cannot be listed in this video
    s = save_shot(c, alice, other)
    c.post(f"/api/projects/{other}/shots/render", json={"shot_ids": [s["id"]], "brief": {"prompt": "warm interiors"}}, headers=alice["headers"])
    rid = c.get(f"/api/projects/{other}/shots", headers=alice["headers"]).json()[0]["latest_render_id"]
    assert post(alice, clip, meta(items=[{"caption": "Kitchen", "render_id": rid}])).status_code == 404
    assert not [j for j in repo.jobs.values() if j["type"] == "animation_export"]
    assert not any(UPLOAD_DIR.glob("*.video"))   # refused uploads are deleted


def test_photoreal_views_are_tagged_and_unlabelled_links_are_given(anim, alice, repo):
    c, _, _ = anim
    pid = new_project(c, alice)
    from .test_studio import upload
    from . import samples
    view = upload(c, alice, pid, "Photoreal view 1.png", samples.png(150, 100))
    body = {"prompt": "White render, bronze glass, at night", "view": "exterior", "time_of_day": "night", "aspect": "landscape",
            "references": [{"file_id": view["id"], "role": "model"}], "anim_hero": {"index": 0, "key": "hvabc1230"}}
    r = c.post(f"/api/projects/{pid}/architectural-render", json=body, headers={**alice["headers"], "Idempotency-Key": "hero-test-0001"})
    assert r.status_code == 202, r.text
    (img,) = c.get(f"/api/projects/{pid}/outputs", headers=alice["headers"]).json()["images"]
    assert img["options"]["anim_hero"] == {"index": 0, "key": "hvabc1230"} and img["base_url"] and img["base_url"] != img["url"]
    bad = {**body, "anim_hero": {"index": 5, "key": "x"}}
    assert c.post(f"/api/projects/{pid}/architectural-render", json=bad, headers={**alice["headers"], "Idempotency-Key": "hero-test-0002"}).status_code == 422
