"""Ticket prices: per-seat price by tier, group discounts, totals."""

from __future__ import annotations

from .checks import ensure_at_least, ensure_one_of

TIERS = {"standard": 40, "premium": 75, "vip": 120}
GROUP_MIN = 6
GROUP_DISCOUNT = 0.1


def unit_price(tier: str) -> int:
    ensure_one_of(tier, tuple(TIERS), "tier")
    return TIERS[tier]


def total(tier: str, seats: int) -> float:
    """Seats times the tier price, with GROUP_DISCOUNT taken off from GROUP_MIN seats up."""
    ensure_at_least(1, seats, "seats")
    price = unit_price(tier) * seats
    if seats >= GROUP_MIN:
        price *= 1 - GROUP_DISCOUNT
    return round(price, 2)


def per_person(tier: str, seats: int) -> float:
    return round(total(tier, seats) / seats, 2)
