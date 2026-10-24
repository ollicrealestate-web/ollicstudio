"""AI walkthroughs from the architect's model: the Runway client (request shapes from Runway's docs and
official SDK types), the geometry check, Claude's shot plan, and the shot job end to end with stand-ins."""

from __future__ import annotations

import base64
import json
import shutil

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageOps

from app.auth import TokenVerifier
from app.geometry import band, match
from app.jobs import InlineRunner
from app.kling import ClipStatus, VideoProviderError
from app.main import create_app
from app.runway import RunwayVideo, cost

from . import samples
from .conftest import FakeImages, jpeg_bytes
from .test_cinematic import mp4
from .test_studio import new_project, upload

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is not installed")


# ---------------------------------------------------------------- the Runway client
def runway_with(handler):
    return RunwayVideo("rw-key", client=httpx.Client(base_url="https://api.dev.runwayml.com/v1", transport=httpx.MockTransport(handler)))


def test_aleph_and_kling_requests_follow_the_docs():
    seen = []

    def handler(req):
        seen.append(req)
        if req.method == "POST":
            return httpx.Response(200, json={"id": "task-1"})
        return httpx.Response(200, json={"id": "task-1", "status": "SUCCEEDED", "output": ["https://dnznrvs05pmza.cloudfront.net/out.mp4"]})

    rw = runway_with(handler)
    assert rw.video_to_video(model="aleph2", video_url="https://x.supabase.co/guide.mp4", prompt="keep it", first_frame=b"\xff\xd8jpeg") == "task-1"
    body = json.loads(seen[0].content)
    assert seen[0].url.path == "/v1/video_to_video" and seen[0].headers["X-Runway-Version"] == "2024-11-06" and seen[0].headers["Authorization"] == "Bearer rw-key"
    assert body["model"] == "aleph2" and body["videoUri"] == "https://x.supabase.co/guide.mp4" and body["promptText"] == "keep it"
    assert body["keyframes"][0]["seconds"] == 0 and body["keyframes"][0]["uri"].startswith("data:image/jpeg;base64,")
    rw.video_to_video(model="klingO3_pro", video_url="https://x/g.mp4", prompt="p", first_frame=b"jpg")
    body = json.loads(seen[1].content)
    assert body["promptVideo"] == "https://x/g.mp4" and body["references"] == [{"uri": "data:image/jpeg;base64," + base64.b64encode(b"jpg").decode(), "position": "first"}]
    st = rw.status("task-1")
    assert seen[2].url.path == "/v1/tasks/task-1" and st.status == "succeeded" and st.video_url.endswith("out.mp4")


@pytest.mark.parametrize("payload,status", [({"status": "PENDING"}, "processing"), ({"status": "THROTTLED"}, "processing"), ({"status": "RUNNING"}, "processing"),
                                            ({"status": "FAILED", "failure": "bad input", "failureCode": "INPUT_PREPROCESSING.SAFETY"}, "failed"), ({"status": "CANCELLED"}, "failed")])
def test_task_states(payload, status):
    assert runway_with(lambda r: httpx.Response(200, json={"id": "t", **payload})).status("t").status == status


@pytest.mark.parametrize("code,retry,words", [(401, False, "not set up"), (429, True, "busy"), (503, True, "problem"), (400, False, "camera move")])
def test_errors_are_neutral(code, retry, words):
    rw = runway_with(lambda r: httpx.Response(code, json={"error": "Runway internal detail"}))
    with pytest.raises(VideoProviderError) as e:
        rw.video_to_video(model="aleph2", video_url="https://x/g.mp4", prompt="p")
    assert e.value.retry is retry and words in e.value.message and "Runway" not in e.value.message


def test_costs():
    assert str(cost("aleph2", 8)) == "2.24" and str(cost("aleph2", 1)) == "0.56" and str(cost("klingO3_pro", 10)) == "1.70"


# ---------------------------------------------------------------- the geometry check
def building(shift=0, floors=4):
    im = Image.new("RGB", (640, 400), (210, 220, 230)); d = ImageDraw.Draw(im)
    x0, x1 = 180 + shift, 460 + shift
    d.rectangle([x0, 80, x1, 360], fill=(235, 232, 225), outline=(40, 40, 40), width=3)
    for f in range(floors):
        y = 90 + f * 270 // floors
        for k in range(4):
            d.rectangle([x0 + 20 + k * 65, y + 10, x0 + 60 + k * 65, y + 45], fill=(70, 90, 110))
    return im


def lines_of(img):
    from app.geometry import edge_map
    return Image.fromarray((edge_map(img, img.width) * 255).astype("uint8"))


def test_match_rewards_the_same_building_and_flags_drift():
    guide = lines_of(building())
    same = match(guide, ImageOps.autocontrast(building()))
    moved, fewer, empty = match(guide, building(shift=60)), match(guide, building(floors=2)), match(guide, Image.new("RGB", (640, 400), (200, 210, 220)))
    assert same > 0.9 and band(same) == "good"
    assert moved < same and fewer < same and empty == 0.0 and band(empty) == "poor"


# ---------------------------------------------------------------- shots, end to end with stand-ins
class FakeRunway:
    provider = "runway"

    def __init__(self, fail=False):
        self.calls, self.polls, self.fail, self.cancelled = [], 0, fail, []

    def video_to_video(self, **kw):
        self.calls.append(kw)
        return "task-9"

    def status(self, task):
        self.polls += 1
        if self.polls < 2:
            return ClipStatus("processing")
        return ClipStatus("failed", message="SAFETY") if self.fail else ClipStatus("succeeded", video_url="https://cdn.runway.test/out.mp4")

    def cancel(self, task):
        self.cancelled.append(task)

    def download(self, url):
        return mp4(3, "1280x720")


@pytest.fixture
def film_app(render_settings, repo, storage):
    def make(runway="fake", writer=None):
        app = create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=FakeImages(), runner=InlineRunner(),
                         runway=FakeRunway() if runway == "fake" else runway, prompt_writer=writer, kling=None, gemini=None, fal={})
        app.state.clip_poll_seconds = 0
        return TestClient(app), app
    return make


def guides(c, user, pid):
    clay = upload(c, user, pid, "Guide - Arrival - clay.jpg", jpeg_bytes(640, 360, (200, 200, 200)))
    lines = upload(c, user, pid, "Guide - Arrival - lines.png", samples.png(640, 360))
    return clay, lines


def shot(c, user, pid, video, **meta):
    clay, lines = guides(c, user, pid)
    m = {"name": "Arrival", "kind": "approach", "engine": "path", "format": "16:9", "description": "white render, palm trees", "life": True,
         "clay_file_id": clay["id"], "lines_file_id": lines["id"], **meta}
    return c.post(f"/api/projects/{pid}/films", files={"file": ("guide.mp4", video, "video/mp4")}, data={"meta": json.dumps(m)}, headers=user["headers"])


@needs_ffmpeg
def test_a_shot_is_rendered_filmed_checked_and_saved(film_app, alice, bob, repo, storage):
    c, app = film_app()
    repo.roles[alice["id"]] = "admin"
    pid = new_project(c, alice)
    r = shot(c, alice, pid, mp4(3, "1280x720"))
    assert r.status_code == 202, r.text
    job = repo.jobs[r.json()["id"]]
    assert job["type"] == "film_shot" and job["status"] == "succeeded", job["error"]
    # 1. the first frame was rendered from the clay view, checked against the lines
    (first,) = repo.images.values()
    assert first["options"]["film_shot"] == "Arrival" and "check" in first["options"] and first["options"]["references"][0]["role"] == "model"
    # 2. the guide went to the video service with the first frame as the look, and the prompt keeps the geometry and adds life
    (call,) = app.state.runway.calls
    assert call["model"] == "aleph2" and call["first_frame"][:2] == b"\xff\xd8" and "never change" in call["prompt"] and "people walking" in call["prompt"]
    assert call["video_url"]
    # 3. saved with its check and cost; the guide video is removed afterwards
    (vid,) = repo.videos.values()
    assert vid["kind"] == "film" and vid["title"] == "Arrival" and set(vid["script"]["check"]) >= {"score", "band", "frames"}
    assert any(e["provider"] == "runway" and e["operation"] == "video_to_video" and e["cost_usd"] == "0.84" for e in repo.usage)
    assert not [p for p in storage.buckets["videos"] if "/guides/" in p]
    listed = c.get(f"/api/projects/{pid}/videos", headers=alice["headers"]).json()
    assert listed[0]["kind"] == "film" and listed[0]["download_url"]
    assert c.get(f"/api/projects/{pid}/videos", headers=bob["headers"]).status_code == 404


@needs_ffmpeg
def test_shot_refusals(film_app, alice, bob, repo, storage):
    c, app = film_app()
    pid = new_project(c, alice)
    assert shot(c, alice, pid, mp4(3, "1280x720")).json()["detail"]["code"] == "premium_only"    # free plan
    repo.roles[alice["id"]] = "admin"
    assert shot(c, alice, pid, mp4(3, "640x360")).json()["detail"]["code"] == "bad_video"       # not the 16:9 guide size
    assert shot(c, alice, pid, mp4(12, "1280x720")).json()["detail"]["code"] == "bad_video"     # longer than a shot
    assert shot(c, alice, pid, b"not a video").json()["detail"]["code"] == "bad_video"
    other = new_project(c, bob)
    clay, lines = guides(c, bob, other)
    r = c.post(f"/api/projects/{pid}/films", files={"file": ("g.mp4", mp4(3, "1280x720"), "video/mp4")},
               data={"meta": json.dumps({"clay_file_id": clay["id"], "lines_file_id": lines["id"]})}, headers=alice["headers"])
    assert r.status_code == 404          # someone else's guide pictures
    off, _ = film_app(runway=None)
    assert shot(off, alice, pid, mp4(3, "1280x720")).status_code == 503
    assert not [j for j in repo.jobs.values() if j["type"] == "film_shot"]
    assert not [p for p in storage.buckets.get("videos", {}) if "/guides/" in p]   # refused guides are not kept


@needs_ffmpeg
def test_a_tester_gets_their_allowance(film_app, alice, repo):
    c, _ = film_app()
    pid = new_project(c, alice)
    repo.roles[alice["id"]] = "tester"; repo.allowances[alice["id"]] = {"film": 1}
    assert shot(c, alice, pid, mp4(3, "1280x720")).status_code == 202
    assert shot(c, alice, pid, mp4(3, "1280x720")).json()["detail"]["reason"].startswith("You have used your free")


@needs_ffmpeg
def test_a_failed_video_is_reported_and_nothing_saved(film_app, alice, repo, storage):
    c, _ = film_app(runway=FakeRunway(fail=True))
    repo.roles[alice["id"]] = "admin"
    pid = new_project(c, alice)
    job = repo.jobs[shot(c, alice, pid, mp4(3, "1280x720")).json()["id"]]
    assert job["status"] == "failed" and "shorter or slower" in job["error"] and not repo.videos
    assert not [p for p in storage.buckets["videos"] if "/guides/" in p]


class FakePlanner:
    model = "claude-test"

    def __init__(self, answer):
        self.answer, self.calls = answer, []

    def ask_json(self, system, content, max_tokens=1800):
        self.calls.append((system, content))
        return {"answer": self.answer, "usage": {"input_tokens": 10, "output_tokens": 20}, "cost_usd": None, "model": self.model}


def test_claude_plans_the_shots_and_falls_back_without_it(film_app, alice, repo):
    planner = FakePlanner({"shots": [{"name": "Arrival", "kind": "approach", "seconds": 30, "frame_prompt": "keep geometry, white render", "motion_prompt": "walk up", "life": True},
                                     {"name": "Odd", "kind": "teleport", "seconds": 2}], "notes": "Two shots."})
    c, _ = film_app(writer=planner)
    pid = new_project(c, alice)
    body = {"description": "white render", "storeys": ["Ground", "First"], "rooms": ["Living"], "width_m": 14, "depth_m": 10, "height_m": 8}
    plan = c.post(f"/api/projects/{pid}/film-plan", json=body, headers=alice["headers"]).json()
    assert plan["by"] == "claude" and plan["shots"][0]["seconds"] == 10 and plan["shots"][1]["kind"] == "push" and plan["shots"][1]["seconds"] == 4
    assert "2 storeys" in planner.calls[0][1][0]["text"] and "Living" in planner.calls[0][1][0]["text"]
    assert any(e["operation"] == "film_plan" for e in repo.usage)
    c2, _ = film_app(writer=None)
    plan = c2.post(f"/api/projects/{pid}/film-plan", json=body, headers=alice["headers"]).json()
    assert plan["by"] == "ollic" and [s["kind"] for s in plan["shots"]] == ["approach", "orbit", "aerial"]


def test_engines_are_listed_under_ollic_names(film_app):
    c, _ = film_app()
    e = c.get("/api/film/engines").json()
    assert e["path"]["name"] == "Ollic Path" and e["path"]["available"] is True and "Runway" not in json.dumps(e)
    c2, _ = film_app(runway=None)
    assert c2.get("/api/film/engines").json()["path"]["available"] is False


@needs_ffmpeg
def test_a_vp9_guide_is_converted_to_h264(film_app, alice, repo, storage, tmp_path):
    import subprocess
    from app.video import probe
    src = tmp_path / "g.mp4"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=3", "-c:v", "libvpx-vp9", "-b:v", "1M", "-deadline", "realtime", str(src)], check=True)
    assert probe(src).codec == "vp9"
    c, app = film_app()
    repo.roles[alice["id"]] = "admin"
    pid = new_project(c, alice)
    seen = []
    real = storage.upload
    storage.upload = lambda user, path, data, *a, **k: (seen.append((path, data)), real(user, path, data, *a, **k))[1]
    assert shot(c, alice, pid, src.read_bytes()).status_code == 202
    (guide,) = [d for p, d in seen if "/guides/" in p]
    out = tmp_path / "out.mp4"; out.write_bytes(guide)
    assert probe(out).codec == "h264"
