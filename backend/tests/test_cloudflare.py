"""Cloudflare Workers AI provider, provider choice and the per-user daily limit."""

from __future__ import annotations

import base64
import io
from decimal import Decimal

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.auth import TokenVerifier
from app.cloudflare_images import CloudflareImages, estimate_neurons
from app.config import Settings
from app.jobs import InlineRunner
from app.main import create_app
from app.openai_images import ProviderError

from .conftest import SECRET, FakeImages, jpeg_bytes

MODEL = "@cf/black-forest-labs/flux-2-klein-4b"


def cf_client(handler):
    calls = []
    http = httpx.Client(base_url="https://api.cloudflare.com", transport=httpx.MockTransport(lambda r: calls.append(r) or handler(r)))
    return CloudflareImages("acct123", "cf-token", client=http), calls


def ok(_r):
    return httpx.Response(200, json={"result": {"image": base64.b64encode(jpeg_bytes(64, 48)).decode()}, "success": True, "errors": [], "messages": []}, headers={"cf-ray": "ray-1"})


def parts(req: httpx.Request) -> dict[str, bytes]:
    """Splits a multipart body into {field name: value bytes}."""
    boundary = req.headers["content-type"].split("boundary=")[1].encode()
    out = {}
    for chunk in req.content.split(b"--" + boundary)[1:-1]:
        head, _, body = chunk.partition(b"\r\n\r\n")
        name = head.split(b'name="')[1].split(b'"')[0].decode()
        out[name] = body[:-2]
    return out


def test_prompt_only_request_is_multipart_with_size_and_token_in_header():
    c, calls = cf_client(ok)
    res = c.generate(model=MODEL, prompt="a bungalow", size="1536x1024", quality="medium", user_id="u")
    (req,) = calls
    assert req.url.path == f"/client/v4/accounts/acct123/ai/run/{MODEL}"
    assert req.headers["authorization"] == "Bearer cf-token" and req.headers["content-type"].startswith("multipart/form-data")
    assert parts(req) == {"prompt": b"a bungalow", "width": b"1536", "height": b"1024"}
    assert Image.open(io.BytesIO(res.data)).size == (64, 48)
    assert res.usage["estimated_neurons"] == estimate_neurons(1536, 1024, []) == round(6 * 26.05, 2)
    assert res.request_id == "ray-1"


def test_reference_images_are_shrunk_below_512_and_sent_as_input_image_0():
    c, calls = cf_client(ok)
    big = jpeg_bytes(1600, 1200)
    res = c.edit(model=MODEL, prompt="p", images=[(big, "image/jpeg")], size="1024x1024", quality="high", user_id="u")
    sent = parts(calls[0])["input_image_0"]
    img = Image.open(io.BytesIO(sent))
    assert img.format == "PNG" and max(img.size) < 512 and img.size == (504, 378)
    assert res.usage["input_images"] == ["504x378"]


@pytest.mark.parametrize("status,body,code,words", [
    (429, {"success": False, "errors": [{"code": 4006, "message": "you have used up your daily free allocation of 10,000 neurons, please upgrade"}]}, "daily_allowance_used", "resets at 01:00"),
    (403, {"success": False, "errors": [{"code": 10000, "message": "Authentication error"}]}, "auth", "Standard render is unavailable"),
    (400, {"success": False, "errors": [{"code": 3030, "message": "Input flagged as NSFW"}]}, "moderation_blocked", "content rules"),
    (500, {"success": False, "errors": [{"code": 3043, "message": "internal"}]}, "server_error", "on its side"),
])
def test_cloudflare_errors_become_plain_messages(status, body, code, words):
    c, _ = cf_client(lambda r: httpx.Response(status, json=body))
    with pytest.raises(ProviderError) as e:
        c.generate(model=MODEL, prompt="p", size="1024x1024", quality="medium", user_id="u")
    assert e.value.code == code and words in e.value.message and "cf-token" not in e.value.message


def test_both_tiers_are_offered_side_by_side():
    base = dict(supabase_url="https://x.supabase.co", supabase_anon_key="a")
    both = Settings(**base, openai_api_key="sk", cloudflare_account_id="a", cloudflare_api_token="t")
    assert both.standard_available and both.premium_available
    assert both.model_for("standard", "create") == MODEL == both.model_for("standard", "revise")
    assert both.model_for("premium", "create") == "gpt-image-2.5-sunburst" == both.model_for("premium", "revise")
    assert Settings(**base, openai_api_key="sk").standard_available is False
    assert Settings(**base).renders_enabled is False
    assert Settings(**base).daily_limit_for("standard") == 3 and Settings(**base).daily_limit_for("premium") == 20
    secret = Settings(**base, openai_api_key="sk-SECRET1", cloudflare_account_id="a", cloudflare_api_token="cf-SECRET2")
    assert "SECRET1" not in repr(secret) and "SECRET2" not in repr(secret)


@pytest.fixture
def cf_app(repo, storage):
    settings = Settings(supabase_url="https://example.supabase.co", supabase_anon_key="anon", supabase_jwt_secret=SECRET,
                        cloudflare_account_id="acct", cloudflare_api_token="cf-secret", daily_renders_per_user=2)
    images = FakeImages()
    app = create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings), image_client=images, runner=InlineRunner())
    return TestClient(app), images


def test_cloudflare_renders_record_an_estimated_cost_and_the_daily_limit_applies(cf_app, alice, bob, repo):
    c, images = cf_app
    images.usage = {"estimated_neurons": 156.3}
    p = c.post("/api/projects", json={"name": "x"}, headers=alice["headers"]).json()
    go = lambda who, proj: c.post(f"/api/projects/{proj['id']}/architectural-render", json={"prompt": "a house"}, headers=who["headers"])
    assert [go(alice, p).status_code for _ in range(3)] == [202, 202, 429]
    third = go(alice, p).json()["detail"]
    assert third["code"] == "daily_limit" and "2 free renders" in third["reason"]
    assert images.calls[0]["model"] == MODEL
    e = repo.usage[0]
    assert e["provider"] == "cloudflare" and Decimal(e["cost_usd"]) == Decimal("0.001719") and "free" in e["price_source"]
    # the limit is per customer
    pb = c.post("/api/projects", json={"name": "y"}, headers=bob["headers"]).json()
    assert go(bob, pb).status_code == 202
    out = c.get(f"/api/projects/{p['id']}/outputs", headers=alice["headers"]).json()
    assert out["tiers"]["standard"] == {"name": "Standard render", "available": True, "allowed": True, "daily_limit": 2}
    assert out["tiers"]["premium"]["available"] is False and out["plan"] == "free"
    assert out["images"][0]["tier"] == "standard" and out["images"][0]["tier_name"] == "Standard render"
    assert c.get("/health").json() == {"status": "ok", "renders": {"standard": True, "premium": False}}
    assert "cf-secret" not in c.get("/assets/config.js").text


def test_failed_renders_do_not_use_up_the_daily_limit(cf_app, alice, repo):
    c, images = cf_app
    images.fail_with = ProviderError("The image model is busy.", status=429)
    p = c.post("/api/projects", json={"name": "x"}, headers=alice["headers"]).json()
    for _ in range(3):
        assert c.post(f"/api/projects/{p['id']}/architectural-render", json={"prompt": "a house"}, headers=alice["headers"]).status_code == 202
    assert all(j["status"] == "failed" for j in repo.jobs.values())


# ---------------------------------------------------------------- Premium render: paid plans only
@pytest.fixture
def both_app(repo, storage):
    settings = Settings(supabase_url="https://example.supabase.co", supabase_anon_key="anon", supabase_jwt_secret=SECRET,
                        cloudflare_account_id="acct", cloudflare_api_token="cf", openai_api_key="sk", daily_premium_renders_per_user=2)
    std, prem = FakeImages(), FakeImages()
    app = create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings),
                     image_clients={"standard": std, "premium": prem}, runner=InlineRunner())
    return TestClient(app), std, prem


def go(c, user, pid, **body):
    return c.post(f"/api/projects/{pid}/architectural-render", json={"prompt": "a house", **body}, headers=user["headers"])


def test_free_customers_get_standard_and_are_refused_premium(both_app, alice, repo):
    c, std, prem = both_app
    pid = c.post("/api/projects", json={"name": "x"}, headers=alice["headers"]).json()["id"]
    r = go(c, alice, pid, tier="premium")
    assert r.status_code == 403 and r.json()["detail"]["code"] == "premium_only" and prem.calls == []
    assert go(c, alice, pid).status_code == 202 and len(std.calls) == 1   # standard is the default
    out = c.get(f"/api/projects/{pid}/outputs", headers=alice["headers"]).json()
    assert out["plan"] == "free" and out["tiers"]["premium"] == {"name": "Premium render", "available": True, "allowed": False, "daily_limit": 2}
    # a free customer cannot revise a render as premium either
    rid = out["images"][0]["id"]
    assert c.post(f"/api/renders/{rid}/edit", json={"instruction": "make it blue", "tier": "premium"}, headers=alice["headers"]).status_code == 403


def test_paid_customers_choose_premium_and_revisions_stay_premium(both_app, alice, repo):
    c, std, prem = both_app
    repo.plans[alice["id"]] = "premium"
    pid = c.post("/api/projects", json={"name": "x"}, headers=alice["headers"]).json()["id"]
    assert go(c, alice, pid, tier="premium", quality="high").status_code == 202
    assert prem.calls[0]["model"] == "gpt-image-2.5-sunburst" and std.calls == []
    img = c.get(f"/api/projects/{pid}/outputs", headers=alice["headers"]).json()["images"][0]
    assert img["tier"] == "premium" and img["tier_name"] == "Premium render" and img["label"] == "AI concept — not to scale"
    assert c.post(f"/api/renders/{img['id']}/edit", json={"instruction": "add palms"}, headers=alice["headers"]).status_code == 202
    assert prem.calls[-1]["model"] == "gpt-image-2.5-sunburst" and std.calls == []
    # premium has its own daily limit (2 here), separate from the free one
    assert go(c, alice, pid, tier="premium").json()["detail"]["code"] == "daily_limit"
    assert go(c, alice, pid).status_code == 202


def test_customers_cannot_upgrade_themselves(both_app, alice):
    """The plan lives in profiles, where users may only update full_name and organisation (migration 1)."""
    sql = open("../supabase/migrations/20261022000001_foundation.sql").read()
    assert "grant update (full_name, organisation) on public.profiles to authenticated" in sql
    assert "revoke insert, update, delete on public.profiles from anon, authenticated" in sql
