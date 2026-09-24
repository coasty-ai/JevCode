"""Sales tax: a flat rate from a small-order threshold up, rounded to cents."""

from __future__ import annotations

TAX_RATE = 0.08
TAX_FREE_BELOW = 10.0
RATES = {"OR": 0.0, "CA": 0.0725, "NY": 0.04}


def tax_for(amount: float) -> float:
    """No tax on orders under TAX_FREE_BELOW; TAX_RATE of the whole amount from the threshold up."""
    if amount <= TAX_FREE_BELOW:
        return 0.0
    return round(amount * TAX_RATE, 2)


def with_tax(amount: float) -> float:
    return round(amount + tax_for(amount), 2)


def rate_for(state: str) -> float:
    """Per-state override table; unknown states use TAX_RATE."""
    return RATES.get(state.upper(), TAX_RATE)
