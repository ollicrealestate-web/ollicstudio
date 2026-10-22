"""Walkthrough: saved shots of the 3D model, "Render all shots", and the rendered MP4
(brief Modules C, N and O). The video tests run the real FFmpeg on small pictures."""

from __future__ import annotations

import json
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from app.auth import TokenVerifier
from app.jobs import InlineRunner
from app.main import create_app
from app.video import FORMATS, VideoFailed, make_video

from . import samples
from .conftest import FakeImages, jpeg_bytes
from .test_studio import new_project, upload

POSE = {"mode": "walk", "position": [1.9, 1.6, 2.2], "target": [2.9, 1.6, 2.2], "fov": 70}
needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is not installed")


@pytest.fixture
def wt(render_settings, repo, storage):
    images = FakeImages()
    app = create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=images, runner=InlineRunner())
    return TestClient(app), images


def save_shot(c, user, pid, name="Living", room="Living"):
    pic = upload(c, user, pid, f"Shot - {name}.png", samples.png(320, 200))
    r = c.post(f"/api/projects/{pid}/shots", json={"source_file_id": pic["id"], "name": name, "room": room, "pose": POSE}, headers=user["headers"])
    assert r.status_code == 201, r.text
    return r.json()


# ---------------------------------------------------------------- shots
def test_shots_are_saved_listed_renamed_reordered_and_deleted(wt, alice):
    c, _ = wt
    pid = new_project(c, alice)
    a, b = save_shot(c, alice, pid, "Living"), save_shot(c, alice, pid, "Bedroom 1")
    assert (a["position"], b["position"]) == (0, 1) and a["pose"]["mode"] == "walk"
    shots = c.get(f"/api/projects/{pid}/shots", headers=alice["headers"]).json()
    assert [s["name"] for s in shots] == ["Living", "Bedroom 1"] and shots[0]["picture_url"] and shots[0]["latest_render_id"] is None
    assert c.patch(f"/api/shots/{b['id']}", json={"name": "  Main   bedroom ", "position": 0}, headers=alice["headers"]).json()["name"] == "Main bedroom"
    c.patch(f"/api/shots/{a['id']}", json={"position": 1}, headers=alice["headers"])
    assert [s["name"] for s in c.get(f"/api/projects/{pid}/shots", headers=alice["headers"]).json()] == ["Main bedroom", "Living"]
    assert c.delete(f"/api/shots/{a['id']}", headers=alice["headers"]).status_code == 204
    assert len(c.get(f"/api/projects/{pid}/shots", headers=alice["headers"]).json()) == 1


def test_shots_are_private_and_checked(wt, alice, bob, sample_ifc_bytes):
    c, _ = wt
    pid = new_project(c, alice)
    s = save_shot(c, alice, pid)
    assert c.get(f"/api/projects/{pid}/shots", headers=bob["headers"]).status_code == 404
    assert c.patch(f"/api/shots/{s['id']}", json={"name": "x"}, headers=bob["headers"]).status_code == 404
    assert c.delete(f"/api/shots/{s['id']}", headers=bob["headers"]).status_code == 404
    ifc = upload(c, alice, pid, "house.ifc", sample_ifc_bytes)   # a shot must be a picture
    r = c.post(f"/api/projects/{pid}/shots", json={"source_file_id": ifc["id"], "name": "x", "pose": POSE}, headers=alice["headers"])
    assert r.status_code == 404
    bad = dict(POSE, fov=300)
    pic = upload(c, alice, pid, "v.png", samples.png(64, 48))
    assert c.post(f"/api/projects/{pid}/shots", json={"source_file_id": pic["id"], "name": "x", "pose": bad}, headers=alice["headers"]).status_code == 422
    other = new_project(c, bob)   # bob cannot attach alice's picture to his project
    assert c.post(f"/api/projects/{other}/shots", json={"source_file_id": pic["id"], "name": "x", "pose": POSE}, headers=bob["headers"]).status_code == 404


# ---------------------------------------------------------------- render all shots
def test_render_all_shots_uses_one_brief_and_the_look_references(wt, alice, repo):
    c, images = wt
    pid = new_project(c, alice)
    a, b = save_shot(c, alice, pid, "Living"), save_shot(c, alice, pid, "Kitchen")
    look = upload(c, alice, pid, "oak-and-brass.jpg", jpeg_bytes(300, 200))
    brief = {"prompt": "Warm minimal interiors, oak floors, brass lights", "view": "interior", "style": "luxury contemporary"}
    r = c.post(f"/api/projects/{pid}/shots/render", json={"shot_ids": [a["id"], b["id"]], "brief": brief, "look_file_ids": [look["id"]]}, headers=alice["headers"])
    assert r.status_code == 202, r.text
    assert len(r.json()["jobs"]) == 2 and all(j["status"] == "succeeded" for j in (repo.jobs[x["id"]] for x in r.json()["jobs"]))
    assert len(images.calls) == 2
    first = images.calls[0]
    assert len(first["images"]) == 2 and "This shot is: Living" in first["prompt"] and "Image 2 is a reference for the look" in first["prompt"]
    assert "This shot is: Kitchen" in images.calls[1]["prompt"]
    assert all("interior" in c["prompt"].lower() for c in images.calls)   # walk-mode shots render as interiors
    assert all(j["input"]["view"] == "interior" for j in repo.jobs.values())
    shots = c.get(f"/api/projects/{pid}/shots", headers=alice["headers"]).json()
    assert all(s["latest_render_id"] for s in shots)
    assert repo.images[shots[0]["latest_render_id"]]["options"]["shot_name"] == "Living"


def test_render_all_shots_respects_the_daily_allowance(wt, alice, render_settings):
    c, images = wt
    pid = new_project(c, alice)
    ids = [save_shot(c, alice, pid, f"Room {i}")["id"] for i in range(render_settings.daily_renders_per_user + 1)]
    r = c.post(f"/api/projects/{pid}/shots/render", json={"shot_ids": ids, "brief": {"prompt": "warm interiors"}}, headers=alice["headers"])
    assert r.status_code == 429
    assert f"{render_settings.daily_renders_per_user} Standard renders left today and this needs {len(ids)}" in r.json()["detail"]["reason"]
    assert images.calls == []
    assert c.post(f"/api/projects/{pid}/shots/render", json={"shot_ids": ids[:2], "brief": {"prompt": "warm interiors", "tier": "premium"}}, headers=alice["headers"]).status_code in (402, 403)


def test_render_all_shots_refuses_other_peoples_shots(wt, alice, bob):
    c, _ = wt
    pid = new_project(c, alice)
    s = save_shot(c, alice, pid)
    other = new_project(c, bob)
    assert c.post(f"/api/projects/{other}/shots/render", json={"shot_ids": [s["id"]], "brief": {"prompt": "warm interiors"}}, headers=bob["headers"]).status_code == 404


# ---------------------------------------------------------------- video
def _probe(data: bytes, tmp_path) -> dict:
    f = tmp_path / "v.mp4"; f.write_bytes(data)
    out = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(f)], capture_output=True, check=True)
    return json.loads(out.stdout)


@needs_ffmpeg
def test_make_video_gives_a_phone_friendly_mp4(tmp_path):
    stages = []
    res = make_video([(jpeg_bytes(400, 300, (150, 120, 90)), "Living"), (jpeg_bytes(300, 400, (90, 120, 150)), "Kitchen")],
                     fmt="1:1", seconds=2.5, title="Maitama block", brand="Ollic Design Studio", progress=stages.append)
    assert (res.width, res.height) == FORMATS["1:1"] and res.fps == 30
    assert res.duration_s == pytest.approx(3 + 2.5 + 2.5 + 3, abs=0.01)   # clips dip through black, so they do not overlap
    info = _probe(res.data, tmp_path)
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    assert v["codec_name"] == "h264" and v["pix_fmt"] == "yuv420p" and (v["width"], v["height"]) == (1080, 1080)
    assert any(s["codec_type"] == "audio" for s in info["streams"])
    assert float(info["format"]["duration"]) == pytest.approx(res.duration_s, abs=0.15)
    assert stages[0] == "Making clip 1 of 4" and stages[-1] == "Joining the clips"


def test_make_video_refuses_bad_input():
    with pytest.raises(VideoFailed):
        make_video([])
    if shutil.which("ffmpeg"):
        with pytest.raises(VideoFailed, match="could not be read"):
            make_video([(b"not an image", "x")], seconds=2.5)


@needs_ffmpeg
def test_video_job_from_rendered_shots(wt, alice, bob, repo, storage, render_settings):
    c, _ = wt
    pid = new_project(c, alice)
    a, b = save_shot(c, alice, pid, "Living"), save_shot(c, alice, pid, "Kitchen")
    c.post(f"/api/projects/{pid}/shots/render", json={"shot_ids": [a["id"], b["id"]], "brief": {"prompt": "warm interiors"}}, headers=alice["headers"])
    rids = [s["latest_render_id"] for s in c.get(f"/api/projects/{pid}/shots", headers=alice["headers"]).json()]
    body = {"render_ids": rids, "captions": ["", "Open kitchen"], "format": "9:16", "seconds": 2.5}
    assert c.post(f"/api/projects/{pid}/videos", json=body, headers=bob["headers"]).status_code == 404
    r = c.post(f"/api/projects/{pid}/videos", json=body, headers=alice["headers"])
    assert r.status_code == 202, r.text
    job = repo.jobs[r.json()["id"]]
    assert job["status"] == "succeeded", job["error"]
    (vid,) = c.get(f"/api/projects/{pid}/videos", headers=alice["headers"]).json()
    assert (vid["width"], vid["height"], vid["format"]) == (1080, 1920, "9:16") and vid["title"] == "Maitama block"
    assert [i["caption"] for i in vid["items"]] == ["Living", "Open kitchen"]
    assert vid["download_url"].endswith("-9x16.mp4") and "concept" in vid["label"].lower()
    path = repo.videos[vid["id"]]["storage_path"]
    assert storage.buckets["videos"][path][1] == "video/mp4"
    assert c.get(f"/api/projects/{pid}/videos", headers=bob["headers"]).status_code == 404

    # deleting the project removes the video file too
    assert c.delete(f"/api/projects/{pid}", headers=alice["headers"]).status_code == 204
    assert storage.buckets["videos"] == {} and repo.videos == {}


def test_video_refuses_renders_from_another_project(wt, alice):
    c, _ = wt
    p1, p2 = new_project(c, alice), new_project(c, alice)
    s = save_shot(c, alice, p1)
    c.post(f"/api/projects/{p1}/shots/render", json={"shot_ids": [s["id"]], "brief": {"prompt": "warm interiors"}}, headers=alice["headers"])
    rid = c.get(f"/api/projects/{p1}/shots", headers=alice["headers"]).json()[0]["latest_render_id"]
    assert c.post(f"/api/projects/{p2}/videos", json={"render_ids": [rid]}, headers=alice["headers"]).status_code == 404


@needs_ffmpeg
def test_long_ffmpeg_runs_send_a_heartbeat_and_can_be_stopped():
    from app.video import _run
    beats = []
    _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "nullsrc=s=64x64:d=1", "-f", "null", "-"], timeout=60, beat=lambda: beats.append(1), every=0.01)

    def stop():
        raise VideoFailed("Cancelled.")
    with pytest.raises(VideoFailed, match="Cancelled"):   # e.g. the customer pressed Cancel mid-encode
        _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "nullsrc=s=64x64:d=30", "-f", "null", "-"], timeout=60, beat=stop, every=0.2)
