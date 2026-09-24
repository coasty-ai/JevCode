"""Tasks and priorities."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Optional, Tuple

PRIORITIES = {"high": 1, "medium": 2, "low": 3}
PRIORITY_NAMES = {1: "high", 2: "medium", 3: "low"}


def parse_priority(text: str) -> int:
    """'High' -> 1; unknown words are medium."""
    return PRIORITIES.get(text.strip().lower(), 2)


@dataclass(frozen=True)
class Task:
    title: str
    priority: int = 2
    due: Optional[date] = None
    done: bool = False
    tags: Tuple[str, ...] = ()

    def is_overdue(self, today: date) -> bool:
        """Past its due date and not done; a task due today is not overdue yet."""
        return not self.done and self.due is not None and self.due < today

    def with_done(self) -> "Task":
        return Task(self.title, self.priority, self.due, True, self.tags)
