"""Multi-day agenda items with inclusive day numbers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Tuple

from .intervals import Interval, contains, overlaps


@dataclass(frozen=True)
class Item:
    title: str
    first_day: int
    last_day: int  # inclusive

    def span(self) -> Interval:
        """The item's days as a half-open interval."""
        return (self.first_day, self.last_day)


def on_day(items: List[Item], day: int) -> List[str]:
    """Titles of the items running on `day`; first and last day both count."""
    return [item.title for item in items if contains(item.span(), day)]


def clashing(items: List[Item]) -> List[Tuple[str, str]]:
    """Pairs of items that share at least one day, in input order."""
    out: List[Tuple[str, str]] = []
    for i, a in enumerate(items):
        for b in items[i + 1:]:
            if overlaps(a.span(), b.span()):
                out.append((a.title, b.title))
    return out


def total_days(items: List[Item]) -> int:
    return sum(item.last_day - item.first_day + 1 for item in items)
