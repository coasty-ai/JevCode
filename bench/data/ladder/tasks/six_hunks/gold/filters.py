"""Task filters."""

from __future__ import annotations

from datetime import date, timedelta
from typing import List

from .model import Task


def pending(tasks: List[Task]) -> List[Task]:
    return [t for t in tasks if not t.done]


def completed(tasks: List[Task]) -> List[Task]:
    return [t for t in tasks if t.done]


def with_tag(tasks: List[Task], tag: str) -> List[Task]:
    return [t for t in tasks if tag in t.tags]


def overdue(tasks: List[Task], today: date) -> List[Task]:
    return [t for t in pending(tasks) if t.is_overdue(today)]


def due_within(tasks: List[Task], today: date, days: int) -> List[Task]:
    """Pending tasks due from today through today + days, both ends included."""
    last = today + timedelta(days=days)
    return [t for t in pending(tasks) if t.due is not None and today <= t.due <= last]


def attention(tasks: List[Task], today: date, days: int = 7) -> List[str]:
    """Titles needing attention: overdue tasks first, then the ones due within `days`."""
    late = overdue(tasks, today)
    soon = [t for t in due_within(tasks, today, days) if t not in late]
    return [t.title for t in late + soon]
