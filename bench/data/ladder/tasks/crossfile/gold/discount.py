"""Discount codes: percentage codes and flat-amount codes."""

from __future__ import annotations

from typing import List

CODES = {"WELCOME10": 0.10, "HALF": 0.50, "FLAT5": 5.0}
PERCENT_CODES = ("WELCOME10", "HALF")


def is_valid_code(code: str) -> bool:
    return code.upper() in CODES


def apply_discount(amount: float, code: str) -> float:
    """The amount after the code's percentage or flat reduction; never below zero."""
    if not code or not is_valid_code(code):
        return amount
    key = code.upper()
    value = CODES[key]
    reduced = amount * (1 - value) if key in PERCENT_CODES else amount - value
    return round(max(reduced, 0.0), 2)


def best_code(amount: float, codes: List[str]) -> str:
    """The code that lowers `amount` the most; empty string when none applies."""
    best, best_total = "", amount
    for code in codes:
        total = apply_discount(amount, code)
        if total < best_total:
            best, best_total = code, total
    return best
