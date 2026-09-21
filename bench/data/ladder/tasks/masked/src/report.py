"""Human-readable summaries of a log."""

from __future__ import annotations

from typing import Dict, List

from .aggregate import count_by_level, slowest, total_ms
from .levels import LEVELS
from .parse import parse_lines


def summary(text: str, top: int = 3) -> Dict[str, object]:
    """Entry count, count per level, total duration and the messages of the `top` slowest entries."""
    entries = parse_lines(txt)
    return {
        "entries": len(entries),
        "levels": count_by_level(entries),
        "total_ms": total_ms(entries),
        "slowest": [e.msg for e in slowest(entries, top)],
    }


def render(text: str, top: int = 3) -> str:
    """One line per level that occurs (in LEVELS order), the total, then one line per slow entry."""
    s = summary(text, top)
    levels = s["levels"]
    lines: List[str] = [f"{level}: {levels[level]}" for level in LEVELS if level in levels]
    lines.append(f"total: {s['total_ms']}ms")
    for msg in s["slowest"]:
        lines.append(f"slow: {msg}")
    return "\n".join(lines)
