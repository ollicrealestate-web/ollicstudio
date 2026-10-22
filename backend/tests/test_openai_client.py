"""Checks the exact requests sent to OpenAI's Image API, and how its errors are reported (no network)."""

import base64
import json

import httpx
import pytest

from app.openai_images import OpenAIImages, ProviderError, safety_identifier


def client_with(handler):
    calls = []
    http = httpx.Client(base_url="https://api.openai.com/v1", transport=httpx.MockTransport(lambda r: calls.append(r) or handler(r)))
    return OpenAIImages("sk-test", client=http), calls


OK = {"created": 1, "data": [{"b64_json": base64.b64encode(b"img").decode()}], "output_format": "jpeg",
      "usage": {"input_tokens": 20, "input_tokens_details": {"text_tokens": 20, "image_tokens": 0}, "output_tokens": 100, "total_tokens": 120}}


def test_generate_sends_a_json_request_with_the_key_only_in_the_header():
    c, calls = client_with(lambda r: httpx.Response(200, json=OK, headers={"x-request-id": "req_1"}))
    res = c.generate(model="gpt-image-2.5-flare", prompt="a house", size="1536x1024", quality="medium", user_id="u1")
    (req,) = calls
    body = json.loads(req.content)
    assert req.url.path == "/v1/images/generations" and req.headers["authorization"] == "Bearer sk-test"
    assert body == {"model": "gpt-image-2.5-flare", "prompt": "a house", "n": 1, "size": "1536x1024", "quality": "medium",
                    "output_format": "jpeg", "output_compression": 92, "safety_identifier": safety_identifier("u1")}
    assert "u1" not in body["safety_identifier"]
    assert res.data == b"img" and res.usage == OK["usage"] and res.request_id == "req_1"


def test_edit_sends_images_as_data_urls():
    c, calls = client_with(lambda r: httpx.Response(200, json=OK))
    c.edit(model="gpt-image-2.5-sunburst", prompt="p", images=[(b"\x89PNG", "image/png")], size="auto", quality="high", user_id="u")
    body = json.loads(calls[0].content)
    assert calls[0].url.path == "/v1/images/edits"
    assert body["images"] == [{"image_url": "data:image/png;base64," + base64.b64encode(b"\x89PNG").decode()}]


@pytest.mark.parametrize("status,error,words", [
    (400, {"code": "moderation_blocked", "message": "Your request was rejected by the safety system."}, "content rules"),
    (401, {"code": "invalid_api_key", "message": "bad key"}, "OPENAI_API_KEY"),
    (403, {"message": "Your organization must be verified"}, "permissions or the organisation"),
    (429, {"code": "insufficient_quota", "message": "quota"}, "run out of credit"),
    (429, {"code": "rate_limit_exceeded", "message": "slow down"}, "OpenAI said: slow down"),
    (404, {"code": "model_not_found", "message": "nope"}, "not available"),
    (500, {"message": "oops"}, "on its side"),
])
def test_provider_errors_become_plain_messages(status, error, words):
    c, _ = client_with(lambda r: httpx.Response(status, json={"error": error}))
    with pytest.raises(ProviderError) as e:
        c.generate(model="m", prompt="p", size="auto", quality="medium", user_id="u")
    assert words in e.value.message and "sk-test" not in e.value.message


def test_a_response_without_an_image_is_an_error_not_a_blank_result():
    c, _ = client_with(lambda r: httpx.Response(200, json={"data": []}))
    with pytest.raises(ProviderError) as e:
        c.generate(model="m", prompt="p", size="auto", quality="medium", user_id="u")
    assert e.value.code == "empty_response"
