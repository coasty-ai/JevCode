"""Calendar events and agenda formatting (times are minutes since midnight)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, List, Optional, Tuple


@dataclass
class Event:
    title: str
    starts_at: int
    ends_at: int
    location: Optional[str] = None
    attendees: List[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not 0 <= self.starts_at <= self.ends_at <= 24 * 60:
            raise ValueError(f"invalid time span for {self.title!r}")


def duration_minutes(event: Event) -> int:
    return event.ends_at - event.starts_at


def overlaps(a: Event, b: Event) -> bool:
    """True when the two events share at least one minute."""
    return a.starts_at < b.ends_at and b.starts_at < a.ends_at


def fmt_time(minutes: int) -> str:
    """90 -> '01:30'."""
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def agenda_line(event: Event) -> str:
    """'09:00-10:30  Standup @ Room 1 (3)'; location and attendee count are optional."""
    span = f"{fmt_time(event.starts_at)}-{fmt_time(event.end_at)}"
    line = f"{span}  {event.title}"
    if event.location:
        line += f" @ {event.location}"
    if event.attendees:
        line += f" ({len(event.attendees)})"
    return line


def agenda(events: Iterable[Event]) -> List[str]:
    """One agenda line per event, ordered by start time and then title."""
    ordered = sorted(events, key=lambda e: (e.starts_at, e.title))
    return [agenda_line(e) for e in ordered]


def free_slots(events: Iterable[Event], day_start: int, day_end: int) -> List[Tuple[int, int]]:
    """Gaps between `day_start` and `day_end` that no event covers."""
    slots: List[Tuple[int, int]] = []
    cursor = day_start
    for e in sorted(events, key=lambda e: e.starts_at):
        if e.starts_at > cursor:
            slots.append((cursor, min(e.starts_at, day_end)))
        cursor = max(cursor, e.ends_at)
        if cursor >= day_end:
            break
    if cursor < day_end:
        slots.append((cursor, day_end))
    return slots


def busiest_hour(events: Iterable[Event]) -> int:
    """The hour (0-23) during which the most events are in progress; earliest on ties."""
    load = [0] * 24
    for e in events:
        for hour in range(e.starts_at // 60, min(23, (e.ends_at - 1) // 60) + 1):
            load[hour] += 1
    return load.index(max(load))
