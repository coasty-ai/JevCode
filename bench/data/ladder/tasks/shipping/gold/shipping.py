"""Shipping quotes for the web-shop checkout."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

CONFIG: Dict[str, Any] = {
    # Subtotals at or above this amount ship free with any method.
    "free_over": 50.0,
    "rates": {"standard": 4.99, "express": 9.99, "overnight": 19.99},
    # Flat surcharge for remote regions; charged even when shipping is free.
    "remote_surcharge": 7.50,
    "remote_regions": ("AK", "HI", "PR", "GU"),
    "currency": "USD",
}


def methods() -> List[str]:
    """Available shipping methods, cheapest first."""
    rates: Dict[str, float] = CONFIG["rates"]
    return sorted(rates, key=lambda m: rates[m])


def base_rate(method: str) -> float:
    rates: Dict[str, float] = CONFIG["rates"]
    if method not in rates:
        raise ValueError(f"unknown shipping method: {method!r}")
    return rates[method]


def is_remote(region: Optional[str]) -> bool:
    return region is not None and region.upper() in CONFIG["remote_regions"]


def shipping_cost(subtotal: float, method: str, region: Optional[str] = None) -> float:
    """The method's rate, waived once the subtotal reaches the free-shipping threshold,
    plus the remote surcharge when the destination region is remote."""
    if subtotal < 0:
        raise ValueError("subtotal must be non-negative")
    rate = base_rate(method)
    cost = 0.0 if subtotal >= CONFIG["free_over"] else rate
    if is_remote(region):
        cost += CONFIG["remote_surcharge"]
    return round(cost, 2)


def quote(subtotal: float, method: str, region: Optional[str] = None) -> Dict[str, float]:
    shipping = shipping_cost(subtotal, method, region)
    return {
        "subtotal": round(subtotal, 2),
        "shipping": shipping,
        "total": round(subtotal + shipping, 2),
    }


def cheapest_method(subtotal: float, region: Optional[str] = None) -> str:
    """The method with the lowest shipping cost; the slowest method on ties."""
    return min(methods(), key=lambda m: shipping_cost(subtotal, m, region))


def describe(subtotal: float, method: str, region: Optional[str] = None) -> str:
    """'Standard shipping: $4.99' or 'Express shipping: free'."""
    cost = shipping_cost(subtotal, method, region)
    label = method.capitalize() + " shipping"
    if cost == 0:
        return f"{label}: free"
    symbol = "$" if CONFIG["currency"] == "USD" else CONFIG["currency"] + " "
    return f"{label}: {symbol}{cost:.2f}"
