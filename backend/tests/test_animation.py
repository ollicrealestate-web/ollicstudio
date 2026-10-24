"""The golden animation's export: upload of the browser-made video, then the job that makes it
phone-friendly. Video tests use real FFmpeg."""

from __future__ import annotations

import json
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from app.animation import Script
from app.animation_jobs import UPLOAD_DIR
from app.auth import TokenVerifier
from app.jobs import InlineRunner
from app.main import create_app

from .conftest import FakeImages
from .test_studio import new_project

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is not installed")


@pytest.fixture
def anim(render_settings, repo, storage):
    app = create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=FakeImages(), runner=InlineRunner())
    return TestClient(app), None, None


# ---------------------------------------------------------------- settings
def test_settings_are_tidied_and_brought_into_range():
    s = Script.model_validate({"render_seconds": 1, "title": "  Villa \n A ", "look": " white   render ", "phases": {"roof": {"seconds": 3}}, "schedule": []})
    assert s.render_seconds == 2.5 and s.title == "Villa A" and s.look == "white render" and s.format == "16:9"
    assert "phases" not in s.model_dump()          # settings of the old model animation are ignored
    with pytest.raises(ValueError):
        Script.model_validate({"format": "4:3"})


def test_old_model_animation_endpoints_are_gone(anim, alice):
    c, _, _ = anim
    pid = new_project(c, alice)
    for method, path in (("get", "/api/animation/defaults"), ("post", f"/api/projects/{pid}/animation/direct"), ("post", f"/api/projects/{pid}/schedule/read"),
                         ("get", f"/api/projects/{pid}/shots")):
        assert getattr(c, method)(path, headers=alice["headers"]).status_code in (404, 405), path


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
    r = c.post(f"/api/projects/{pid}/animations", files={"file": ("animation.mp4", clip, "video/mp4")}, data={"meta": meta()}, headers=alice["headers"])
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
    c.post(f"/api/projects/{other}/architectural-render", json={"prompt": "warm interiors"}, headers={**alice["headers"], "Idempotency-Key": "other-project-0001"})
    rid = c.get(f"/api/projects/{other}/outputs", headers=alice["headers"]).json()["images"][0]["id"]
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


def test_line_drawings_of_views_are_tagged(anim, alice, repo):
    c, _, _ = anim
    pid = new_project(c, alice)
    from .test_studio import upload
    from . import samples
    pic = upload(c, alice, pid, "elevation.png", samples.png(150, 100))
    c.post(f"/api/projects/{pid}/architectural-render", json={"prompt": "Night render", "references": [{"file_id": pic["id"], "role": "model"}],
                                                          "anim_hero": {"index": 0, "key": f"img-{pic['id']}"}}, headers={**alice["headers"], "Idempotency-Key": "line-test-0001"})
    (photo,) = c.get(f"/api/projects/{pid}/outputs", headers=alice["headers"]).json()["images"]
    r = c.post(f"/api/renders/{photo['id']}/edit", json={"instruction": "Clean white line drawing on black", "anim_line": {"index": 0, "key": f"img-{pic['id']}"}},
               headers={**alice["headers"], "Idempotency-Key": "line-test-0002"})
    assert r.status_code == 202, r.text
    line, photo2 = c.get(f"/api/projects/{pid}/outputs", headers=alice["headers"]).json()["images"]
    assert line["options"]["anim_line"]["key"] == f"img-{pic['id']}" and "anim_hero" not in line["options"]
    assert photo2["options"]["anim_hero"]["key"] == f"img-{pic['id']}" and line["parent_image_id"] == photo2["id"]
