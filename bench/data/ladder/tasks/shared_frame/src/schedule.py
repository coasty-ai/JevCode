"""Showtimes: parsing, formatting, ordering and clash detection."""

from __future__ import annotations

from dataclasses import dataclass
from typing import List


@dataclass(frozen=True)
class Show:
    name: str
    start: int  # minutes since midnight
    minutes: int

    @property
    def end(self) -> int:
        return self.start + self.minutes


def parse_time(text: str) -> int:
    hours, minutes = text.split(":")
    return int(hours) * 60 + int(minutes)


def format_time(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def clashes(a: Show, b: Show) -> bool:
    """Two shows clash when their intervals overlap; touching ends do not clash."""
    return a.start < b.end and b.start < a.end


def by_start(shows: List[Show]) -> List[Show]:
    return sorted(shows, key=lambda s: (s.start, s.name))
