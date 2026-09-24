"""Time slots in minutes since midnight, as half-open intervals."""

from __future__ import annotations

from typing import List

from .intervals import Interval, contains, length, overlaps


def minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def slot(start: str, end: str) -> Interval:
    return minutes(start), minutes(end)


def is_busy(slots: List[Interval], minute: int) -> bool:
    """True while a slot is running; a slot's end minute is already free."""
    return any(contains(s, minute) for s in slots)


def free_minutes(slots: List[Interval], day: Interval = (0, 1440)) -> int:
    busy = sum(length(s) for s in slots)
    return length(day) - busy


def can_book(slots: List[Interval], wanted: Interval) -> bool:
    """A slot may start exactly when another ends."""
    return not any(overlaps(s, wanted) for s in slots)
