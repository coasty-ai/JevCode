"""Log levels and their ordering."""

from __future__ import annotations

from typing import Iterable, List

LEVELS = ("DEBUG", "INFO", "WARN", "ERROR")


def rank(level: str) -> int:
    """0 for DEBUG .. 3 for ERROR; unknown levels rank below DEBUG."""
    try:
        return LEVELS.index(level)
    except ValueError:
        return -1


def at_least(level: str, floor: str) -> bool:
    return rank(level) >= rank(floor)


def highest(levels: Iterable[str]) -> str:
    best = "DEBUG"
    for level in levels:
        if rank(level) > rank(best):
            best = level
    return best


def sort_levels(levels: Iterable[str]) -> List[str]:
    return sorted(levels, key=rank)
