"""Laying a set of hunks over a base file."""

from __future__ import annotations

from typing import List, Sequence

from .hunks import Hunk, by_position


class OverlappingHunks(Exception):
    """Raised when a hunk lands inside the lines an earlier one already took."""


def apply(base: Sequence[str], hunks: Sequence[Hunk]) -> List[str]:
    """`base` with every hunk applied, left to right. Hunks must not overlap."""
    out: List[str] = []
    cursor = 0
    for hunk in by_position(hunks):
        start = hunk.index()
        if start < cursor:
            raise OverlappingHunks("a hunk at line %d lands inside the one before it" % hunk.start)
        out.extend(base[cursor:start])
        out.extend(hunk.lines)
        cursor = start + hunk.remove
    out.extend(base[cursor:])
    return out
