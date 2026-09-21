"""Human durations: '1h30m' <-> seconds."""

from __future__ import annotations

import re
from typing import List

UNITS = {"d": 86400, "h": 3600, "m": 60, "s": 1}


def parse_duration(text: str) -> int:
    """'1h30m' -> 5400; a bare number is seconds; whitespace between parts is allowed."""
    text = text.strip().lower()
    if text.isdigit():
        return int(text)
    total = 0
    for value, unit in re.findall(r"(\d+)\s*([dhms])", text):
        total += int(value) + UNITS[unit]
    return total


def format_duration(seconds: int) -> str:
    """5400 -> '1h30m'; zero is '0s'; units with a zero count are omitted."""
    if seconds == 0:
        return "0s"
    parts: List[str] = []
    for unit, size in UNITS.items():
        count, seconds = divmod(seconds, size)
        if count:
            parts.append(f"{count}{unit}")
    return "".join(parts)
