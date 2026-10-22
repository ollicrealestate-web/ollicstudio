"""Cost of each image-model call, from the token usage the provider reports (brief test 15).

Prices are US dollars per million tokens, standard processing, copied from
developers.openai.com/api/docs/pricing and the model pages on 22 Oct 2026.
Update PRICE_SOURCE whenever these change. A model missing from the table, or a
response without usage, is recorded with a null cost rather than a guess.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

PRICE_SOURCE = "developers.openai.com/api/docs/pricing, standard tier, checked 2026-10-22"

# text_in, image_in, image_out (USD per 1M tokens)
_PRICES: dict[str, tuple[str, str, str]] = {
    "gpt-image-2.5-flare": ("5.00", "8.00", "30.00"),
    "gpt-image-2.5-sunburst": ("5.00", "8.00", "30.00"),
}
_MILLION = Decimal(1_000_000)


def _price_for(model: str) -> tuple[Decimal, Decimal, Decimal] | None:
    for name, prices in _PRICES.items():
        if model == name or model.startswith(name + "-"):  # dated snapshots share the alias price
            return tuple(Decimal(p) for p in prices)  # type: ignore[return-value]
    return None


def token_counts(usage: dict | None) -> tuple[int, int, int]:
    """(input text tokens, input image tokens, output tokens) from an Image API usage object."""
    if not usage:
        return 0, 0, 0
    details = usage.get("input_tokens_details") or {}
    total_in = int(usage.get("input_tokens") or 0)
    image_in = int(details.get("image_tokens") or 0)
    text_in = int(details.get("text_tokens") if details.get("text_tokens") is not None else max(total_in - image_in, 0))
    return text_in, image_in, int(usage.get("output_tokens") or 0)


def cost_usd(model: str, usage: dict | None) -> Decimal | None:
    prices = _price_for(model)
    if prices is None or not usage:
        return None
    text_in, image_in, out = token_counts(usage)
    p_text, p_image, p_out = prices
    total = (text_in * p_text + image_in * p_image + out * p_out) / _MILLION
    return total.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
