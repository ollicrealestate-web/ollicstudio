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
    def make(runway="fake", writer=None, exact=None):
        app = create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=FakeImages(), runner=InlineRunner(),
                         runway=FakeRunway() if runway == "fake" else runway, prompt_writer=writer, kling=None, gemini=None,
                         fal={"film_exact": exact} if exact else {})
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
               data={"meta": json.dumps({"engine": "path", "clay_file_id": clay["id"], "lines_file_id": lines["id"]})}, headers=alice["headers"])
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

    def ask_json(self, system, content, max_tokens=1800, **kw):
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


def test_a_reframed_render_is_put_back_in_the_model_camera():
    from app.geometry import assess
    view = building()
    # the AI drew the right building 20% smaller and lower, in its own colours
    small = ImageOps.autocontrast(building()).resize((512, 320))
    reframed = Image.new("RGB", (640, 400), (120, 160, 110)); reframed.paste(small, (64, 60))
    check, fixed = assess(view, reframed)
    assert check["framing"] == "corrected" and fixed is not None and fixed.size == reframed.size
    assert 1.2 <= check["frame"]["scale"] <= 1.3 and check["score"] >= 0.8 and check["band"] == "good"
    # a different building, or the view turned over, is not rescued by reframing
    # (floor and opening counts are Claude's part of the check: see geometry.claude_check)
    for wrong in (view.transpose(Image.Transpose.ROTATE_90).resize(view.size), view.transpose(Image.Transpose.FLIP_TOP_BOTTOM)):
        other, _ = assess(view, wrong)
        assert other["score"] < 0.65 and other["band"] == "poor", other
    same, none = assess(view, view)
    assert same["framing"] == "kept" and none is None and same["score"] == 1.0



# ---------------------------------------------------------------- Ollic Path Exact (depth-guided, on fal)
class FakeDepthVideo(FakeRunway):
    provider = "fal"

    def film(self, **kw):
        self.calls.append(kw)
        return "req|https://queue.fal.run/x/status|https://queue.fal.run/x"


class FilmChecker:
    model = "claude-test"

    def __init__(self):
        self.calls = []

    def ask_json(self, system, content, max_tokens=1800, **kw):
        self.calls.append((system, content))
        if "walkthrough video" in system:
            return {"answer": {"ok": True, "issues": []}, "usage": {"input_tokens": 3000, "output_tokens": 20}, "cost_usd": "0.02", "model": self.model}
        return {"answer": {"ok": True, "issues": []}, "usage": {}, "cost_usd": None, "model": self.model}


def exact_views(c, user, pid):
    ids = {}
    for end in ("start", "end"):
        ids[f"{end}_view_id"] = upload(c, user, pid, f"Guide - Arrival {end} - view.jpg", jpeg_bytes(640, 360, (210, 210, 210)))["id"]
        for k in ("lines", "depth", "materials"):
            ids[f"{end}_{k}_id"] = upload(c, user, pid, f"Guide - Arrival {end} - {k}.png", samples.png(640, 360))["id"]
    return ids


@needs_ffmpeg
def test_an_exact_shot_has_approved_ends_and_follows_the_models_depth(film_app, alice, repo, storage):
    video, checker = FakeDepthVideo(), FilmChecker()
    c, app = film_app(runway=None, writer=checker, exact=video)
    repo.roles[alice["id"]] = "admin"
    pid = new_project(c, alice)
    assert c.get("/api/film/engines").json()["exact"]["available"] is True and c.get("/api/film/engines").json()["path"]["available"] is False
    meta = {"name": "Arrival", "kind": "approach", "engine": "exact", "format": "16:9", "description": "white render, palm trees", "life": True,
            "frame_prompt": "photoreal Lekki apartment block"} | exact_views(c, alice, pid)
    send = lambda m, v: c.post(f"/api/projects/{pid}/films", files={"file": ("guide.mp4", v, "video/mp4")}, data={"meta": json.dumps(m)}, headers=alice["headers"])  # noqa: E731
    assert send(meta, mp4(3, "1280x720")).json()["detail"]["reason"] == "A shot is 4 to 10 seconds long."
    assert send({k: v for k, v in meta.items() if k != "end_depth_id"}, mp4(4, "1280x720")).json()["detail"]["code"] == "bad_settings"
    r = send(meta, mp4(4, "1280x720"))
    assert r.status_code == 202, r.text
    job = repo.jobs[r.json()["id"]]
    assert job["status"] == "succeeded", job["error"]
    # both ends went through the still pipeline; the end frame copies the start frame's look
    renders = sorted((j for j in repo.jobs.values() if j["type"] == "concept_render"), key=lambda j: j["created_at"])
    assert [j["input"]["film_shot"] for j in renders] == ["Arrival (start)", "Arrival (end)"]
    assert renders[0]["input"]["depth_file_id"] == meta["start_depth_id"] and renders[1]["input"]["guide_file_id"] == meta["end_lines_id"]
    assert renders[1]["input"]["hero_render_id"] == job["result"]["first_frame"] and all(j["input"]["rounds"] == 2 for j in renders)
    # the video follows the depth guide, pinned to both frames
    (call,) = video.calls
    assert "the forecourt and its paving" in call["prompt"] and "Only the camera moves." in call["prompt"]
    assert call["depth_video_url"] and call["first_frame"][:2] == b"\xff\xd8" and call["last_frame"][:2] == b"\xff\xd8" and call["aspect"] == "16:9"
    (vid,) = repo.videos.values()
    assert vid["script"]["engine"] == "exact" and vid["script"]["check"]["claude"]["ok"] is True and vid["script"]["check"]["band"] == "good"
    assert set(vid["script"]["check"]["frames_checked"]) == {"start", "end"}
    assert any(e["provider"] == "fal" and e["model"] == "fal-ai/wan-22-vace-fun-a14b/depth" and e["cost_usd"] == "0.40" for e in repo.usage)
    film_q = [cnt for s_, cnt in checker.calls if "walkthrough video" in s_]
    assert film_q and sum(b["type"] == "image" for b in film_q[0]) == 5          # the model at both ends and three frames of the shot
    assert not [p for p in storage.buckets["videos"] if "/guides/" in p]


def test_scripts_are_rechecked_after_an_update(render_settings, repo, storage, tmp_path):
    from dataclasses import replace
    web = tmp_path / "web"; (web / "assets").mkdir(parents=True); (web / "vendor").mkdir()
    (web / "app.html").write_text("<p>app</p>"); (web / "assets" / "app.js").write_text("1"); (web / "vendor" / "three.js").write_text("3")
    c = TestClient(create_app(replace(render_settings, web_dir=str(web)), repo=repo, storage=storage, image_client=FakeImages(), runner=InlineRunner()))
    assert c.get("/assets/app.js").headers["cache-control"] == "no-cache" and c.get("/app.html").headers["cache-control"] == "no-cache"
    assert "max-age" in c.get("/vendor/three.js").headers["cache-control"]


def test_the_full_film_plan_has_the_door_and_the_rooms(film_app, alice, repo):
    body = {"description": "white render", "storeys": ["Ground", "First"], "rooms": ["Living Room", "Kitchen", "Bedroom 1", "Store"],
            "width_m": 14, "depth_m": 10, "height_m": 8, "full": True, "seconds": 60}
    c, _ = film_app(writer=None)
    pid = new_project(c, alice)
    plan = c.post(f"/api/projects/{pid}/film-plan", json=body, headers=alice["headers"]).json()
    kinds = [s["kind"] for s in plan["shots"]]
    assert kinds[:5] == ["aerial", "orbit", "sidepass", "approach", "entry"] and kinds[-1] == "topdown"
    assert [s["room"] for s in plan["shots"] if s["kind"] == "interior"] == ["Living Room", "Kitchen", "Bedroom 1"]
    # Claude: only rooms that are in the model are kept; the full-film brief and the scene reach it
    planner = FakePlanner({"shots": [{"name": "In", "kind": "entry", "seconds": 6}, {"name": "Lounge", "kind": "interior", "room": "living room", "seconds": 6},
                                     {"name": "Cinema", "kind": "interior", "room": "Home cinema", "seconds": 6}], "notes": "ok"})
    c2, _ = film_app(writer=planner)
    plan = c2.post(f"/api/projects/{pid}/film-plan", json=body, headers=alice["headers"]).json()
    assert [(s["kind"], s["room"]) for s in plan["shots"]] == [("entry", ""), ("interior", "Living Room")]
    assert "FULL PROPERTY FILM" in planner.calls[0][1][0]["text"]


@needs_ffmpeg
def test_the_shots_are_joined_into_one_film_with_title_cards(film_app, alice, bob, repo, storage):
    from app.video import probe
    import tempfile, os
    c, app = film_app()
    pid = new_project(c, alice)
    user = app.state.verifier.verify(alice["headers"]["Authorization"].split()[1])
    ids = []
    for i, secs in enumerate((3, 2)):
        vid = f"00000000-0000-4000-8000-00000000000{i}"
        path = f"{alice['id']}/{pid}/{vid}.mp4"
        storage.upload(user, path, mp4(secs, "1280x720"), "video/mp4", bucket="videos")
        repo.create_video(user, {"id": vid, "project_id": pid, "storage_path": path, "title": f"Shot {i}", "format": "16:9", "kind": "film", "script": {}})
        ids.append(vid)
    assert c.post(f"/api/projects/{pid}/films/join", json={"video_ids": ids}, headers=bob["headers"]).status_code == 404
    r = c.post(f"/api/projects/{pid}/films/join", json={"video_ids": ids, "title": "Chief Ben Residence", "subtitle": "Lekki, Lagos"}, headers=alice["headers"])
    assert r.status_code == 202, r.text
    job = repo.jobs[r.json()["id"]]
    assert job["status"] == "succeeded", job["error"]
    v = repo.videos[job["result"]["video_id"]]
    assert v["script"]["joined"] and v["title"] == "Chief Ben Residence" and [x["video_id"] for x in v["items"]] == ids
    with tempfile.TemporaryDirectory() as d:
        f = os.path.join(d, "f.mp4"); open(f, "wb").write(storage.download(user, v["storage_path"], bucket="videos"))
        info = probe(f)
    # 3 s card + 3 s + 2 s + 3 s card, less three 0.6 s cross-fades
    assert (info.width, info.height) == (1280, 720) and abs(info.duration_s - 9.2) < 0.3
