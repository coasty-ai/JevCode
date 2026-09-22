"""Putting jobs in the order they should be run."""

from __future__ import annotations

from typing import List, Optional, Sequence

from .job import Job


def order(jobs: Sequence[Job]) -> List[Job]:
    """Every job, most urgent first. Nothing is dropped: that is the scheduler's call."""
    return sorted(jobs, key=lambda job: job.key())


def by_deadline(jobs: Sequence[Job]) -> List[Job]:
    """Every job in deadline order, ties broken by name."""
    return sorted(jobs, key=lambda job: (job.due_at, job.name))


def most_urgent(jobs: Sequence[Job]) -> Optional[Job]:
    ordered = order(jobs)
    return ordered[0] if ordered else None
