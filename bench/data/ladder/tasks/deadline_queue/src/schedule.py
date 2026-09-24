"""Laying the ranked jobs end to end and reading the deadlines off the result."""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Sequence

from .job import Job
from .ranking import order
from .slack import lateness


@dataclass(frozen=True)
class Slot:
    job: Job
    start: int
    finish: int


def lay_out(jobs: Sequence[Job], start_at: int = 0) -> List[Slot]:
    """Every job that takes time, laid end to end in ranking order from `start_at`.

    A job of no length occupies no slot at all.
    """
    slots: List[Slot] = []
    clock = start_at
    for job in order(jobs):
        slots.append(Slot(job, clock, clock + job.minutes))
        clock += job.minutes
    return slots


def finish_time(jobs: Sequence[Job], start_at: int = 0) -> int:
    slots = lay_out(jobs, start_at)
    return slots[-1].finish if slots else start_at


def lateness_of(slot: Slot) -> int:
    """How many minutes past its deadline the slot's job lands."""
    return lateness(slot.job.due_at, slot.finish)


def late_jobs(slots: Sequence[Slot]) -> List[str]:
    """The names of the jobs that land after their deadline, in schedule order."""
    return [slot.job.name for slot in slots if lateness_of(slot) > 0]


def total_lateness(slots: Sequence[Slot]) -> int:
    """The minutes of lateness summed over the jobs that are late; early jobs count zero."""
    return sum(max(0, lateness_of(slot)) for slot in slots)
