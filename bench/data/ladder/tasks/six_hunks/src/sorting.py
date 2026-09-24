"""Task orderings."""

from __future__ import annotations

from datetime import date
from typing import List

from .model import Task


def by_priority(tasks: List[Task]) -> List[Task]:
    """Highest priority (1) first; ties keep the input order."""
    return sorted(tasks, key=lambda t: t.priority)


def by_due(tasks: List[Task]) -> List[Task]:
    """Earliest due date first; undated tasks go last, keeping their input order."""
    return sorted(tasks, key=lambda t: (t.due is not None, t.due or date.min))


def by_title(tasks: List[Task]) -> List[Task]:
    return sorted(tasks, key=lambda t: t.title.casefold())
