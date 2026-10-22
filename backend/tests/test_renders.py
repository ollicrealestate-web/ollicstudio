"""Phase 2: concept renders (brief tests 2, 3, 13, 14, 15 and 18, as far as this phase covers them)."""

from __future__ import annotations

import io
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.auth import TokenVerifier
from app.imaging import CONCEPT_LABEL
from app.jobs import InlineRunner
from app.main import create_app
from app.openai_images import ProviderError
from app.pricing import cost_usd
from app.renders import build_edit_prompt, build_prompt

from . import samples
from .conftest import SECRET, jpeg_bytes, make_token


@pytest.fixture(autouse=True)
def paid_plans(repo, alice, bob):
    """Most tests here exercise Premium render (OpenAI), so both users are on the paid plan."""
    repo.plans.update({alice["id"]: "premium", bob["id"]: "premium"})


@pytest.fixture
def project(rclient, alice):
    return rclient.post("/api/projects", json={"name": "Lekki duplex"}, headers=alice["headers"]).json()


def upload(client, user, project, name, data):
    r = client.post(f"/api/projects/{project['id']}/uploads", files={"file": (name, data)}, headers=user["headers"])
    assert r.status_code == 201, r.text
    return r.json()


def render(client, user, project, **body):
    body = {"prompt": "Modern two-storey house, white render and timber", "tier": "premium", **body}
    return client.post(f"/api/projects/{project['id']}/architectural-render", json=body, headers=user["headers"])


# ---------------------------------------------------------------- generate and edit
def test_prompt_only_render_runs_on_the_server_and_is_labelled(rclient, alice, project, fake_images, storage, repo):
    r = render(rclient, alice, project, time_of_day="golden hour", materials="white render, iroko timber", quality="high", aspect="portrait")
    assert r.status_code == 202, r.text
    job = r.json()
    assert job["type"] == "concept_render" and job["project_id"] == project["id"]

    done = rclient.get(f"/api/jobs/{job['id']}", headers=alice["headers"]).json()
    assert done["status"] == "succeeded", done
    render_id = done["result"]["render_id"]

    (call,) = fake_images.calls
    assert call["kind"] == "generate" and call["model"] == "gpt-image-2.5-sunburst"
    assert call["size"] == "1024x1536" and call["quality"] == "high" and call["user_id"] == alice["id"]
    assert "golden-hour" in call["prompt"] and "iroko timber" in call["prompt"] and "Do not add any text" in call["prompt"]

    out = rclient.get(f"/api/projects/{project['id']}/outputs", headers=alice["headers"]).json()
    (img,) = out["images"]
    assert img["id"] == render_id and img["kind"] == "concept" and img["label"] == CONCEPT_LABEL == "AI concept — not to scale"
    assert img["url"].startswith("https://example.supabase.co/storage/v1/object/sign/renders/")
    assert "AI-concept-not-to-scale" in img["download_url"]

    # two private copies: the labelled one people see, and an unlabelled base for revisions
    row = repo.images[render_id]
    shown, base = storage.buckets["renders"][row["storage_path"]][0], storage.buckets["renders"][row["base_path"]][0]
    assert row["storage_path"].startswith(f"{alice['id']}/{project['id']}/") and shown != base
    a, b = Image.open(io.BytesIO(shown)), Image.open(io.BytesIO(base))
    assert a.size == b.size == (150, 100) and a.tobytes() != b.tobytes()  # the label is burned into the shown copy


def test_render_from_a_reference_image_sends_that_image_as_the_base(rclient, alice, project, fake_images, storage):
    ref = upload(rclient, alice, project, "sketch.png", samples.png(32, 24))
    r = render(rclient, alice, project, reference_file_id=ref["id"])
    assert r.status_code == 202
    (call,) = fake_images.calls
    assert call["kind"] == "edit" and call["images"] == [(storage.objects[ref["storage_path"]][0], "image/png")]
    assert "Image 1 is the design to render. Keep the building's form" in call["prompt"]
    img = rclient.get(f"/api/projects/{project['id']}/outputs", headers=alice["headers"]).json()["images"][0]
    assert img["source_file_id"] == ref["id"]


def test_a_revision_keeps_the_previous_render_as_its_base(rclient, alice, project, fake_images, storage, repo):
    render(rclient, alice, project)
    first = rclient.get(f"/api/projects/{project['id']}/outputs", headers=alice["headers"]).json()["images"][0]
    r = rclient.post(f"/api/renders/{first['id']}/edit", json={"instruction": "Make the roof dark grey"}, headers=alice["headers"])
    assert r.status_code == 202, r.text
    job = rclient.get(f"/api/jobs/{r.json()['id']}", headers=alice["headers"]).json()
    assert job["status"] == "succeeded" and job["type"] == "concept_edit"

    call = fake_images.calls[-1]
    base_bytes = storage.buckets["renders"][repo.images[first["id"]]["base_path"]][0]
    assert call["kind"] == "edit" and call["model"] == "gpt-image-2.5-sunburst" and call["images"] == [(base_bytes, "image/jpeg")]
    assert call["size"] == "1536x1024" and "Make the roof dark grey" in call["prompt"] and "Keep everything else the same" in call["prompt"]

    images = rclient.get(f"/api/projects/{project['id']}/outputs", headers=alice["headers"]).json()["images"]
    newest = images[0]
    assert len(images) == 2 and newest["parent_image_id"] == first["id"] and newest["label"] == CONCEPT_LABEL


# ---------------------------------------------------------------- inputs and refusals
def test_without_an_openai_key_the_endpoints_say_so(client, alice):
    p = client.post("/api/projects", json={"name": "x"}, headers=alice["headers"]).json()
    r = client.post(f"/api/projects/{p['id']}/architectural-render", json={"prompt": "a house"}, headers=alice["headers"])
    assert r.status_code == 503 and r.json()["detail"]["code"] == "not_configured"
    out = client.get(f"/api/projects/{p['id']}/outputs", headers=alice["headers"]).json()
    assert out["renders_enabled"] is False and out["images"] == [] and out["jobs"] == []
    assert not out["tiers"]["standard"]["available"] and not out["tiers"]["premium"]["available"]


def test_the_openai_key_never_reaches_the_browser(rclient):
    body = rclient.get("/assets/config.js").text + rclient.get("/health").text
    assert "not-a-real" not in body
    assert "not-a-real" not in repr(rclient.app.state.settings)


def test_pdf_and_ifc_cannot_be_used_as_a_reference(rclient, alice, project, fake_images):
    for name, data in (("plan.pdf", samples.pdf()), ("house.ifc", samples.ifc())):
        f = upload(rclient, alice, project, name, data)
        r = render(rclient, alice, project, reference_file_id=f["id"])
        assert r.status_code == 422 and r.json()["detail"]["code"] == "unsupported_reference"
    assert fake_images.calls == []


@pytest.mark.parametrize("body", [
    {"prompt": "  "}, {"prompt": "x" * 2501}, {"prompt": "a house", "view": "underwater"},
    {"prompt": "a house", "quality": "ultra"}, {"prompt": "a house", "aspect": "panorama"}, {"prompt": "a house", "materials": "m" * 401},
])
def test_render_options_are_validated(rclient, alice, project, fake_images, body):
    r = rclient.post(f"/api/projects/{project['id']}/architectural-render", json={"tier": "premium", **body}, headers=alice["headers"])
    assert r.status_code == 422 and fake_images.calls == []


def test_a_token_about_to_expire_is_refused_before_the_model_is_called(rclient, alice, project, fake_images):
    short = {"Authorization": f"Bearer {make_token(alice['id'], exp_in=120)}"}
    r = rclient.post(f"/api/projects/{project['id']}/architectural-render", json={"prompt": "a house", "tier": "premium"}, headers=short)
    assert r.status_code == 401 and fake_images.calls == []


# ---------------------------------------------------------------- isolation (test 14)
def test_another_user_cannot_render_into_read_or_revise_a_project(rclient, alice, bob, project, fake_images):
    ref = upload(rclient, alice, project, "sketch.png", samples.png())
    render(rclient, alice, project)
    out = rclient.get(f"/api/projects/{project['id']}/outputs", headers=alice["headers"]).json()
    img, job = out["images"][0], out["jobs"][0]
    calls = len(fake_images.calls)

    assert render(rclient, bob, project).status_code == 404
    assert rclient.get(f"/api/projects/{project['id']}/outputs", headers=bob["headers"]).status_code == 404
    assert rclient.get(f"/api/jobs/{job['id']}", headers=bob["headers"]).status_code == 404
    assert rclient.post(f"/api/jobs/{job['id']}/cancel", headers=bob["headers"]).status_code == 404
    assert rclient.post(f"/api/renders/{img['id']}/edit", json={"instruction": "make it blue"}, headers=bob["headers"]).status_code == 404
    # bob cannot point his own project at alice's reference image
    bobs = rclient.post("/api/projects", json={"name": "mine"}, headers=bob["headers"]).json()
    assert render(rclient, bob, bobs, reference_file_id=ref["id"]).status_code == 404
    assert len(fake_images.calls) == calls
    assert rclient.get("/api/usage", headers=bob["headers"]).json()["calls"] == 0


# ---------------------------------------------------------------- failures, cancellation, restarts (test 13)
def test_a_provider_refusal_fails_the_job_with_the_reason_and_records_no_cost(rclient, alice, project, fake_images, repo):
    fake_images.fail_with = ProviderError("The image model declined this request under its content rules. Reword the description and try again.", status=400, code="moderation_blocked")
    job = render(rclient, alice, project).json()
    job = rclient.get(f"/api/jobs/{job['id']}", headers=alice["headers"]).json()
    assert job["status"] == "failed" and "content rules" in job["error"] and job["result"] is None
    assert repo.images == {} and repo.usage == []


def test_cancelling_while_the_model_runs_keeps_the_cost_but_saves_nothing(rclient, alice, project, fake_images, repo, storage):
    def cancel_mid_call():
        jid = next(iter(repo.jobs))
        assert rclient.post(f"/api/jobs/{jid}/cancel", headers=alice["headers"]).json()["status"] == "cancelled"
    fake_images.on_call = cancel_mid_call
    job = render(rclient, alice, project).json()
    job = rclient.get(f"/api/jobs/{job['id']}", headers=alice["headers"]).json()
    assert job["status"] == "cancelled" and "charged" in job["stage"]
    assert repo.images == {} and storage.buckets["renders"] == {}
    assert len(repo.usage) == 1  # the model call happened, so its cost is on record


def test_finished_jobs_cannot_be_cancelled(rclient, alice, project):
    job = render(rclient, alice, project).json()
    r = rclient.post(f"/api/jobs/{job['id']}/cancel", headers=alice["headers"])
    assert r.status_code == 409 and r.json()["detail"]["code"] == "already_finished"


def test_a_job_cut_off_by_a_restart_is_reported_as_failed_not_left_running(render_settings, repo, storage, fake_images, alice):
    class Never:  # a server that dies before the job runs
        def submit(self, *a):
            pass
    app = create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=fake_images, runner=Never())
    c = TestClient(app)
    p = c.post("/api/projects", json={"name": "x"}, headers=alice["headers"]).json()
    job = render(c, alice, p).json()
    assert c.get(f"/api/jobs/{job['id']}", headers=alice["headers"]).json()["status"] == "queued"  # recent: still honestly queued

    repo.jobs[job["id"]]["updated_at"] = (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat()
    later = c.get(f"/api/jobs/{job['id']}", headers=alice["headers"]).json()
    assert later["status"] == "failed" and "interrupted" in later["error"]
    assert fake_images.calls == []


def test_the_same_idempotency_key_never_starts_a_second_render(rclient, alice, project, fake_images):
    h = {**alice["headers"], "Idempotency-Key": "render-0001-abcdef"}
    body = {"prompt": "a bungalow", "tier": "premium"}
    first = rclient.post(f"/api/projects/{project['id']}/architectural-render", json=body, headers=h)
    again = rclient.post(f"/api/projects/{project['id']}/architectural-render", json=body, headers=h)
    assert first.status_code == 202 and again.status_code == 200 and again.json()["id"] == first.json()["id"]
    assert len(fake_images.calls) == 1
    assert rclient.get("/api/usage", headers=alice["headers"]).json()["calls"] == 1


def test_too_many_renders_at_once_are_refused(render_settings, repo, storage, fake_images, alice):
    class Never:
        def submit(self, *a):
            pass
    c = TestClient(create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=fake_images, runner=Never()))
    p = c.post("/api/projects", json={"name": "x"}, headers=alice["headers"]).json()
    assert [render(c, alice, p).status_code for _ in range(4)] == [202, 202, 202, 429]


# ---------------------------------------------------------------- cost recording (test 15)
def test_every_model_call_records_its_cost_from_the_reported_tokens(rclient, alice, project, repo):
    render(rclient, alice, project)
    first = rclient.get(f"/api/projects/{project['id']}/outputs", headers=alice["headers"]).json()["images"][0]
    rclient.post(f"/api/renders/{first['id']}/edit", json={"instruction": "add palm trees"}, headers=alice["headers"])

    u = rclient.get("/api/usage", headers=alice["headers"]).json()
    assert u["calls"] == 2 and u["calls_without_cost"] == 0
    # 250 text-in x $5 + 1050 image-in x $8 + 4160 out x $30, per million tokens
    each = Decimal("0.001250") + Decimal("0.008400") + Decimal("0.124800")
    assert [Decimal(e["cost_usd"]) for e in u["events"]] == [each, each]
    assert Decimal(u["total_cost_usd"]) == 2 * each
    assert {e["service"] for e in u["events"]} == {"Premium render"}
    assert "model" not in u["events"][0] and "provider" not in u["events"][0]   # the customer view names no AI provider
    assert {e["operation"] for e in repo.usage} == {"image_generate", "image_edit"} and {e["model"] for e in repo.usage} == {"gpt-image-2.5-sunburst"}


def test_missing_usage_or_an_unknown_model_is_recorded_without_a_guessed_cost(rclient, alice, project, fake_images, repo):
    fake_images.usage = None
    render(rclient, alice, project)
    (e,) = repo.usage
    assert e["cost_usd"] is None and e["price_source"] == "provider reported no usage"
    assert cost_usd("some-future-model", {"input_tokens": 10, "output_tokens": 10}) is None
    assert cost_usd("gpt-image-2.5-flare-2026-09-08", {"input_tokens": 0, "output_tokens": 1_000_000}) == Decimal("30.000000")


def test_usage_history_is_kept_after_the_project_is_deleted(rclient, alice, project, repo, storage):
    render(rclient, alice, project)
    assert storage.buckets["renders"]
    assert rclient.delete(f"/api/projects/{project['id']}", headers=alice["headers"]).status_code == 204
    assert storage.buckets["renders"] == {} and repo.images == {} and repo.jobs == {}  # files and rows gone (test 22)
    u = rclient.get("/api/usage", headers=alice["headers"]).json()
    assert u["calls"] == 1 and u["events"][0]["project_id"] is None


# ---------------------------------------------------------------- prompts
def test_prompts_carry_the_options_and_the_keep_the_design_rules():
    opts = {"prompt": "4-bed duplex", "view": "aerial", "time_of_day": "night", "materials": "brick", "landscaping": "palms"}
    p = build_prompt(opts, with_reference=False)
    assert "Aerial" in p and "night" in p and "brick" in p and "palms" in p and "4-bed duplex" in p
    ref = build_prompt(opts, with_reference=True)
    assert "positions of walls, doors and windows" in ref and "Aerial" not in ref
    assert "Change only what the instruction below asks for" in build_edit_prompt("paint it red")


def test_label_stamp_works_on_tiny_and_large_images():
    from app.imaging import open_image, stamp_label
    for size in ((40, 30), (1536, 1024)):
        img = open_image(jpeg_bytes(*size))
        assert stamp_label(img).size == size
