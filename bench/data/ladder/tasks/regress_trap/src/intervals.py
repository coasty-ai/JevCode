"""Half-open integer intervals [start, end)."""

from __future__ import annotations

from typing import List, Tuple

Interval = Tuple[int, int]


def contains(interval: Interval, x: int) -> bool:
    """True when start <= x < end (the end is exclusive)."""
    start, end = interval
    return start <= x < end


def overlaps(a: Interval, b: Interval) -> bool:
    """True when the intervals share at least one point; touching ends do not overlap."""
    return a[0] < b[1] and b[0] < a[1]


def length(interval: Interval) -> int:
    return max(0, interval[1] - interval[0])


def merge(intervals: List[Interval]) -> List[Interval]:
    """The union as sorted, non-overlapping intervals; touching intervals merge too."""
    out: List[Interval] = []
    for start, end in sorted(intervals):
        if out and start < out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], end))
        else:
            out.append((start, end))
    return out
