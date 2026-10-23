"""Cinematic clips (Kling, direct) and Nano Banana line drawings (Gemini, direct). The providers are
stand-ins; their request and response shapes follow the vendors' documentation."""

from __future__ import annotations

import base64
import io
import json
import shutil
import subprocess

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.auth import TokenVerifier
from app.cinematic import construction_prompt, gold_frame
from app.gemini_images import GeminiImages
from app.jobs import InlineRunner
from app.kling import ClipStatus, KlingVideo, VideoProviderError, estimate_cost
from app.main import create_app
from app.openai_images import ImageResult, ProviderError

from . import samples
from .conftest import FakeImages, jpeg_bytes
from .test_studio import new_project, upload

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is not installed")


def mp4(seconds=2, size="640x360") -> bytes:
    import tempfile, os
    with tempfile.TemporaryDirectory() as d:
        f = os.path.join(d, "v.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=s={size}:d={seconds}:r=24", "-c:v", "libx264", "-preset", "ultrafast",
                        "-pix_fmt", "yuv420p", f], check=True)
        return open(f, "rb").read()


class FakeKling:
    def __init__(self, fail=False):
        self.created, self.polls, self.fail = [], 0, fail

    def create(self, **kw):
        self.created.append(kw)
        return "task-123"

    def status(self, task):
        self.polls += 1
        if self.polls < 2:
            return ClipStatus(status="processing")
        if self.fail:
            return ClipStatus(status="failed", message="content risk")
        return ClipStatus(status="succeeded", video_url="https://cdn.kling.test/v.mp4", duration=2.0,
                          billing=[{"charge_type": "unit", "amount": "6", "package_type": "video"}])

    def download(self, url):
        return mp4()


class FakeGemini:
    provider = "google"

    def __init__(self):
        self.calls = []

    def edit(self, **kw):
        self.calls.append(kw)
        return ImageResult(data=jpeg_bytes(150, 100, (0, 0, 0)), output_format="jpeg", model=kw["model"], usage=None)

    def generate(self, **kw):
        return self.edit(**kw)


@pytest.fixture
def clip_app(render_settings, repo, storage):
    def make(kling="fake", gemini=None, fal=None):
        k = FakeKling() if kling == "fake" else kling
        app = create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=FakeImages(), runner=InlineRunner(),
                         kling=k, gemini=gemini, fal=fal)
        app.state.clip_poll_seconds = 0
        return TestClient(app), k
    return make


def photo_and_lines(c, user, pid):
    pic = upload(c, user, pid, "front.png", samples.png(300, 200))
    key = f"img-{pic['id']}"
    c.post(f"/api/projects/{pid}/architectural-render", json={"prompt": "night render", "references": [{"file_id": pic["id"], "role": "model"}],
                                                          "anim_hero": {"index": 0, "key": key}}, headers={**user["headers"], "Idempotency-Key": f"cin-{pid[:8]}-1"})
    (photo,) = c.get(f"/api/projects/{pid}/outputs", headers=user["headers"]).json()["images"]
    c.post(f"/api/renders/{photo['id']}/edit", json={"instruction": "white line drawing on black", "anim_line": {"index": 0, "key": key}},
           headers={**user["headers"], "Idempotency-Key": f"cin-{pid[:8]}-2"})
    line = next(i for i in c.get(f"/api/projects/{pid}/outputs", headers=user["headers"]).json()["images"] if i["options"].get("anim_line"))
    return photo, line


# ---------------------------------------------------------------- the clip
@needs_ffmpeg
def test_cinematic_clip_from_gold_lines_to_photoreal(clip_app, alice, repo, storage, tmp_path):
    c, kling = clip_app()
    repo.roles[alice["id"]] = "admin"
    pid = new_project(c, alice)
    photo, line = photo_and_lines(c, alice, pid)
    body = {"start": {"kind": "lines", "id": line["id"]}, "end": {"kind": "render", "id": photo["id"]}, "seconds": 10, "format": "16:9", "title": "Tower"}
    r = c.post(f"/api/projects/{pid}/cinematic", json=body, headers=alice["headers"])
    assert r.status_code == 202, r.text
    assert r.json()["estimate_usd"] == "0.840"                     # 10 s, 720p, silent: $0.084 a second
    job = repo.jobs[r.json()["id"]]
    assert job["status"] == "succeeded", job["error"]
    (call,) = kling.created
    first, last = Image.open(io.BytesIO(call["first_frame"])), Image.open(io.BytesIO(call["last_frame"]))
    assert first.size == last.size == (1280, 720)                  # both cropped the same way
    assert call["seconds"] == 10 and call["resolution"] == "720p" and call["audio"] is False and call["external_id"] == job["id"]
    assert "One continuous cinematic camera take" in call["prompt"]
    (vid,) = c.get(f"/api/projects/{pid}/videos", headers=alice["headers"]).json()
    assert vid["kind"] == "cinematic" and vid["title"] == "Tower" and "not to scale" in vid["label"]
    data = storage.buckets["videos"][repo.videos[vid["id"]]["storage_path"]][0]
    f = tmp_path / "c.mp4"; f.write_bytes(data)
    streams = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(f)], capture_output=True, check=True).stdout)["streams"]
    assert {s["codec_type"] for s in streams} == {"video", "audio"}  # a silent track is added for phones
    e = repo.usage[-1]
    assert e["provider"] == "kling" and e["operation"] == "video_generate" and e["cost_usd"] == "0.840"   # 6 units x $0.14
    usage = json.dumps(c.get("/api/usage", headers=alice["headers"]).json())
    assert "Cinematic clip" in usage and "kling" not in usage.lower()


def test_cinematic_clip_is_for_paid_plans_and_checked(clip_app, alice, bob, repo):
    c, _ = clip_app()
    pid = new_project(c, alice)
    photo, line = photo_and_lines(c, alice, pid)
    body = {"start": {"kind": "lines", "id": line["id"]}, "end": {"kind": "render", "id": photo["id"]}}
    r = c.post(f"/api/projects/{pid}/cinematic", json=body, headers=alice["headers"])
    assert r.status_code == 403 and "paid plans" in r.json()["detail"]["reason"]
    repo.plans[alice["id"]] = "premium"
    assert c.post(f"/api/projects/{pid}/cinematic", json={**body, "end": {"kind": "lines", "id": line["id"]}}, headers=alice["headers"]).status_code == 422
    assert c.post(f"/api/projects/{pid}/cinematic", json=body, headers=bob["headers"]).status_code == 404
    other = new_project(c, bob)
    repo.plans[bob["id"]] = "premium"
    assert c.post(f"/api/projects/{other}/cinematic", json=body, headers=bob["headers"]).status_code == 404     # someone else's pictures
    off, _ = clip_app(kling=None)
    assert off.post(f"/api/projects/{pid}/cinematic", json=body, headers=alice["headers"]).status_code == 503


@needs_ffmpeg
def test_cinematic_daily_limit_and_provider_failure(clip_app, render_settings, alice, repo):
    c, kling = clip_app(kling=FakeKling(fail=True))
    repo.plans[alice["id"]] = "premium"
    pid = new_project(c, alice)
    photo, line = photo_and_lines(c, alice, pid)
    body = {"start": {"kind": "lines", "id": line["id"]}, "end": {"kind": "render", "id": photo["id"]}, "seconds": 5}
    r = c.post(f"/api/projects/{pid}/cinematic", json=body, headers=alice["headers"])
    job = repo.jobs[r.json()["id"]]
    assert job["status"] == "failed" and "could not make this clip" in job["error"] and not repo.videos
    assert not any(e["provider"] == "kling" for e in repo.usage)        # a failed clip is not charged
    for _ in range(render_settings.daily_clips_per_user):
        c.post(f"/api/projects/{pid}/cinematic", json=body, headers=alice["headers"])
    assert c.post(f"/api/projects/{pid}/cinematic", json=body, headers=alice["headers"]).status_code in (202, 429)


def test_gold_frame_and_prompt():
    lines = Image.new("L", (300, 200), 0); lines.paste(255, (100, 50, 104, 150))
    g = gold_frame(lines)
    assert g.size == (300, 200) and g.getpixel((102, 100))[0] > 200 and g.getpixel((10, 10))[0] < 40
    p = construction_prompt(10)
    assert "0-3s" in p and "3-8s" in p and "8-10s" in p and "no cuts" in p
    assert estimate_cost("1080p", 10, True) == estimate_cost("1080p", 5, True) * 2


# ---------------------------------------------------------------- the vendors' formats
def test_kling_requests_follow_the_documented_format():
    seen = []

    def handler(req: httpx.Request):
        seen.append(req)
        assert req.headers["authorization"] == "Bearer kling-key"
        if req.method == "POST":
            body = json.loads(req.content)
            assert req.url.path == "/image-to-video/kling-3.0"
            types = [x["type"] for x in body["contents"]]
            assert types == ["prompt", "first_frame", "last_frame"]
            assert not body["contents"][1]["url"].startswith("data:") and base64.b64decode(body["contents"][1]["url"]) == b"\xff\xd8first"
            assert body["settings"] == {"resolution": "1080p", "duration": 10, "audio": "native", "multi_shot": False}
            return httpx.Response(200, json={"code": 0, "message": "ok", "request_id": "r1", "data": {"id": "893605946402811985", "status": "submitted"}})
        assert req.url.path == "/tasks" and req.url.params["task_ids"] == "893605946402811985"
        return httpx.Response(200, json={"code": 0, "data": [{"id": "893605946402811985", "status": "succeeded",
                                         "outputs": [{"type": "video", "url": "https://x/v.mp4", "duration": "10.0"}], "billing": [{"charge_type": "unit", "amount": "12"}]}]})
    k = KlingVideo("kling-key", client=httpx.Client(base_url="https://api-singapore.klingai.com", transport=httpx.MockTransport(handler)))
    task = k.create(first_frame=b"\xff\xd8first", last_frame=b"\xff\xd8last", prompt="p", seconds=10, resolution="1080p", audio=True)
    st = k.status(task)
    assert task == "893605946402811985" and st.status == "succeeded" and st.video_url == "https://x/v.mp4" and st.duration == 10.0

    def broke(req):
        return httpx.Response(429, json={"code": 1102, "message": "Resource pack exhausted"})
    k2 = KlingVideo("k", client=httpx.Client(base_url="https://api-singapore.klingai.com", transport=httpx.MockTransport(broke)))
    with pytest.raises(VideoProviderError) as e:
        k2.create(first_frame=b"x", last_frame=None, prompt="p")
    assert "run out of credit" in e.value.message and "Kling" not in e.value.message


def test_gemini_requests_follow_the_documented_format():
    img = base64.b64encode(jpeg_bytes(80, 60)).decode()

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        assert req.url.path == "/v1beta/interactions" and req.headers["x-goog-api-key"] == "g-key"
        assert body["model"] == "gemini-nano-banana-2.1" and body["input"][0] == {"type": "text", "text": "draw lines"}
        assert body["input"][1]["type"] == "image" and body["input"][1]["mime_type"] == "image/jpeg"
        assert body["response_format"]["type"] == "image" and body["response_format"]["aspect_ratio"] == "3:2" and body["response_format"]["image_size"] == "2K"
        return httpx.Response(200, json={"id": "i1", "steps": [{"type": "thought"}, {"type": "model_output", "content": [{"type": "text", "text": "ok"}, {"type": "image", "mime_type": "image/jpeg", "data": img}]}]})
    g = GeminiImages("g-key", client=httpx.Client(base_url="https://generativelanguage.googleapis.com", transport=httpx.MockTransport(handler)))
    out = g.edit(model="gemini-nano-banana-2.1", prompt="draw lines", images=[(jpeg_bytes(80, 60), "image/jpeg")], size="1536x1024")
    assert Image.open(io.BytesIO(out.data)).size == (80, 60)
    # the older generateContent shape is read too
    legacy = GeminiImages("g", client=httpx.Client(base_url="https://x", transport=httpx.MockTransport(
        lambda r: httpx.Response(200, json={"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": img}}]}}]}))))
    assert legacy.generate(model="m", prompt="p").data[:2] == b"\xff\xd8"
    empty = GeminiImages("g", client=httpx.Client(base_url="https://x", transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"steps": []}))))
    with pytest.raises(ProviderError):
        empty.generate(model="m", prompt="p")


def test_new_options_sit_beside_the_existing_renders(clip_app, alice, repo):
    gem = FakeGemini()
    c, _ = clip_app(gemini=gem)
    pid = new_project(c, alice)
    photo, line = photo_and_lines(c, alice, pid)            # Standard, as before: the added option is not used on its own
    assert gem.calls == [] and photo["tier"] == "standard"
    tiers = c.get(f"/api/projects/{pid}/outputs", headers=alice["headers"]).json()["tiers"]
    assert set(tiers) == {"standard", "premium", "swift", "ultra", "studio", "vs"}
    assert tiers["vs"]["name"] == "Ollic VS" and tiers["vs"]["available"] is False      # listed, not connected here
    assert tiers["swift"]["name"] == "Ollic Swift" and tiers["swift"]["available"] and not tiers["swift"]["allowed"]   # paid plans
    assert tiers["studio"]["available"] is False and tiers["studio"]["soon"] is True
    assert "gemini" not in json.dumps(tiers).lower() and "banana" not in json.dumps(tiers).lower()     # Ollic names only
    body = {"prompt": "white render villa at night", "tier": "swift"}
    r = c.post(f"/api/projects/{pid}/architectural-render", json=body, headers={**alice["headers"], "Idempotency-Key": "swift-0001"})
    assert r.status_code == 403 and "Ollic Swift is for paid plans" in r.json()["detail"]["reason"]
    repo.plans[alice["id"]] = "premium"
    r = c.post(f"/api/projects/{pid}/architectural-render", json=body, headers={**alice["headers"], "Idempotency-Key": "swift-0002"})
    assert r.status_code == 202, r.text
    assert gem.calls and gem.calls[-1]["model"] == "gemini-nano-banana-2.1"
    out = c.get(f"/api/projects/{pid}/outputs", headers=alice["headers"]).json()
    assert out["images"][0]["tier_name"] == "Ollic Swift"
    assert any(e["provider"] == "google" and e["cost_usd"] == "0.0504" for e in repo.usage)
    assert "Ollic Swift" in json.dumps(c.get("/api/usage", headers=alice["headers"]).json())
    vid = out["video_engines"]
    assert vid["motion"]["name"] == "Ollic Motion" and vid["cinema"]["available"] is False and vid["reel"]["soon"] is True
    # Ollic Ultra uses the other model; Studio is listed but not connected
    c.post(f"/api/projects/{pid}/architectural-render", json={**body, "tier": "ultra"}, headers={**alice["headers"], "Idempotency-Key": "ultra-0001"})
    assert gem.calls[-1]["model"] == "gemini-3-pro-image"
    r = c.post(f"/api/projects/{pid}/architectural-render", json={**body, "tier": "studio"}, headers={**alice["headers"], "Idempotency-Key": "studio-0001"})
    assert r.status_code == 503 and "Ollic Studio is not connected yet" in r.json()["detail"]["reason"]
    clip = {"engine": "cinema", "start": {"kind": "lines", "id": line["id"]}, "end": {"kind": "render", "id": photo["id"]}}
    r = c.post(f"/api/projects/{pid}/cinematic", json=clip, headers=alice["headers"])
    assert r.status_code == 503 and "Ollic Cinema is not connected yet" in r.json()["detail"]["reason"]


# ---------------------------------------------------------------- Ollic VS (fal.ai)
class FakeFalVideo(FakeKling):
    provider = "fal"
    model = "bytedance/seedance-2.0/image-to-video"


@needs_ffmpeg
def test_ollic_vs_is_an_image_option_and_a_video_option(clip_app, alice, repo):
    imgs, vid = FakeGemini(), FakeFalVideo()
    imgs.provider = "fal"
    c, kling = clip_app(fal={"images": imgs, "video": vid})
    repo.plans[alice["id"]] = "premium"
    pid = new_project(c, alice)
    photo, line = photo_and_lines(c, alice, pid)
    out = c.get(f"/api/projects/{pid}/outputs", headers=alice["headers"]).json()
    assert out["tiers"]["vs"]["available"] and out["tiers"]["vs"]["allowed"] and out["video_engines"]["vs"]["available"]
    shown = json.dumps(out["tiers"]).lower() + json.dumps(out["video_engines"]).lower()
    assert not any(w in shown for w in ("fal-ai", "fal.ai", "seedance", "kontext", "flux", "kling", "gemini"))      # Ollic names only
    r = c.post(f"/api/projects/{pid}/architectural-render", json={"prompt": "white render villa at dusk", "tier": "vs"},
               headers={**alice["headers"], "Idempotency-Key": "vs-img-01"})
    assert r.status_code == 202 and imgs.calls[-1]["model"] == "fal-ai/flux-pro/kontext"
    assert any(e["provider"] == "fal" and e["cost_usd"] == "0.04" for e in repo.usage)
    shown = [e["service"] for e in c.get("/api/usage", headers=alice["headers"]).json()["events"]]
    assert shown.count("Ollic VS") == 1          # the two Standard renders made earlier keep their name
    clip = {"engine": "vs", "start": {"kind": "lines", "id": line["id"]}, "end": {"kind": "render", "id": photo["id"]}, "seconds": 5, "format": "9:16"}
    r = c.post(f"/api/projects/{pid}/cinematic", json=clip, headers=alice["headers"])
    assert r.status_code == 202, r.text
    assert r.json()["estimate_usd"] == "1.517"                   # 5 s at $0.3034
    assert repo.jobs[r.json()["id"]]["status"] == "succeeded"
    assert vid.created[-1]["aspect"] == "9:16" and kling.created == []      # Ollic Motion was not used
    e = repo.usage[-1]
    assert e["provider"] == "fal" and e["model"].startswith("bytedance/") and e["cost_usd"] == "1.517"
    assert "Cinematic clip · Ollic VS" in [x["service"] for x in c.get("/api/usage", headers=alice["headers"]).json()["events"]]
    assert c.post(f"/api/projects/{pid}/cinematic", json={**clip, "seconds": 3}, headers=alice["headers"]).status_code == 422


def test_fal_requests_follow_the_documented_format():
    from app.fal import FalImages, FalVideo
    seen = []

    def handler(req: httpx.Request):
        seen.append(req)
        assert req.headers["Authorization"] == "Key fk-test"
        u = str(req.url)
        if req.method == "POST":
            return httpx.Response(200, json={"request_id": "r1", "status_url": "https://queue.fal.run/x/requests/r1/status",
                                             "response_url": "https://queue.fal.run/x/requests/r1"})
        if u.endswith("/status"):
            return httpx.Response(200, json={"status": "COMPLETED"})
        if "seedance" in seen[0].url.path:
            return httpx.Response(200, json={"video": {"url": "https://v3.fal.media/files/v.mp4"}, "seed": 1})
        return httpx.Response(200, json={"images": [{"url": "data:image/jpeg;base64," + base64.b64encode(jpeg_bytes(20, 20, (1, 2, 3))).decode()}]})

    fi = FalImages("fk-test", client=httpx.Client(transport=httpx.MockTransport(handler)))
    res = fi.edit(model="fal-ai/flux-pro/kontext", prompt="make it dusk", images=[(jpeg_bytes(40, 30, (9, 9, 9)), "image/jpeg")])
    body = json.loads(seen[0].content)
    assert seen[0].url == "https://queue.fal.run/fal-ai/flux-pro/kontext" and body["image_url"].startswith("data:image/jpeg;base64,")
    assert body["aspect_ratio"] == "3:2" and Image.open(io.BytesIO(res.data)).size == (20, 20)
    seen.clear()
    fv = FalVideo("fk-test", client=httpx.Client(transport=httpx.MockTransport(handler)))
    task = fv.create(first_frame=jpeg_bytes(64, 36, (0, 0, 0)), last_frame=jpeg_bytes(64, 36, (9, 9, 9)), prompt="p", seconds=3, resolution="720p", audio=True, aspect="16:9")
    body = json.loads(seen[0].content)
    assert seen[0].url.path == "/bytedance/seedance-2.0/image-to-video"
    assert body["duration"] == "4" and body["end_image_url"].startswith("data:") and body["generate_audio"] is True and body["aspect_ratio"] == "16:9"
    st = fv.status(task)
    assert st.status == "succeeded" and st.video_url.endswith("v.mp4")

    def refused(req):
        return httpx.Response(401, json={"detail": "bad key"})
    bad = FalImages("fk-test", client=httpx.Client(transport=httpx.MockTransport(refused)))
    with pytest.raises(ProviderError) as e:
        bad.generate(model="x", prompt="p")
    assert "fal" not in e.value.args[0].lower()
