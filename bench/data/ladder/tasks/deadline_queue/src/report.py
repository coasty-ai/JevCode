"""Rendering a laid-out schedule as plain text."""

from __future__ import annotations

from typing import List, Sequence

from .schedule import Slot, late_jobs, lateness_of, total_lateness

MINUTES_PER_HOUR = 60


def clock(minutes: int) -> str:
    """Minutes from the start of the working day as HH:MM."""
    return "%02d:%02d" % (minutes // MINUTES_PER_HOUR, minutes % MINUTES_PER_HOUR)


def header(slots: Sequence[Slot]) -> str:
    """'4 jobs, 00:00-03:00', or a word for an empty schedule."""
    if not slots:
        return "nothing to do"
    return "%d jobs, %s-%s" % (len(slots), clock(slots[0].start), clock(slots[-1].finish))


def line(slot: Slot) -> str:
    """One slot: when it runs, what it is, and how it sits against its deadline."""
    span = "%s-%s" % (clock(slot.start), clock(slot.finish))
    late = lateness_of(slot)
    tail = "LATE +%d" % late if late > 0 else "%d to spare" % -late
    return "%s  %-10s %s" % (span, slot.job.name, tail)


def footer(slots: Sequence[Slot]) -> str:
    """Who missed a deadline, and by how much altogether."""
    names = late_jobs(slots)
    if not names:
        return "all on time"
    return "late: %s (+%d min)" % (", ".join(names), total_lateness(slots))


def render(slots: Sequence[Slot]) -> List[str]:
    """The whole schedule: a header, a line per slot, and a footer."""
    return [header(slots)] + [line(slot) for slot in slots] + [footer(slots)]
