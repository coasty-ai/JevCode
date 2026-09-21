"""Plain-text rendering of tasks."""

from __future__ import annotations

from typing import List

from .model import PRIORITY_NAMES, Task
from .sorting import by_due


def line(task: Task, width: int = 40) -> str:
    """'[x] Title (high)'; a title longer than `width` is cut to width - 3 characters plus '...'."""
    mark = "x" if task.done else " "
    title = task.title if len(task.title) <= width else task.title[: width - 2] + "..."
    return f"[{mark}] {title} ({PRIORITY_NAMES[task.priority]})"


def board(tasks: List[Task], width: int = 40) -> List[str]:
    """One line per task, earliest due first, undated last."""
    return [line(t, width) for t in by_due(tasks)]


def header(title: str, width: int = 40) -> str:
    return f"{title}\n{'=' * min(len(title), width)}"
