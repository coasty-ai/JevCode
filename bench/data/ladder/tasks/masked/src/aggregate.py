"""Aggregates over parsed log entries."""

from __future__ import annotations

from typing import Dict, List

from .levels import rank
from .parse import Entry


def count_by_level(entries: List[Entry]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for e in entries:
        counts[e.level] = counts.get(e.level, 0) + 1
    return counts


def total_ms(entries: List[Entry]) -> int:
    return sum(e.took for e in entries)


def slowest(entries: List[Entry], n: int = 3) -> List[Entry]:
    """The `n` entries with the longest durations, longest first; ties keep the input order."""
    return sorted(entries, key=lambda e: -e.ms)[:n]


def worst_level(entries: List[Entry]) -> str:
    best = "DEBUG"
    for e in entries:
        if rank(e.level) > rank(best):
            best = e.level
    return best
