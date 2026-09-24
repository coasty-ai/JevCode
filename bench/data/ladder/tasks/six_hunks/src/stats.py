"""Numbers about a task list."""

from __future__ import annotations

from typing import Dict, List

from .model import Task


def completion_rate(tasks: List[Task]) -> int:
    """Percentage of tasks done, rounded to the nearest whole number; 0 for no tasks."""
    if not tasks:
        return 0
    done = sum(1 for t in tasks if t.done)
    return round(100 * done // len(tasks))


def average_priority(tasks: List[Task]) -> float:
    """Mean priority to one decimal; 0.0 for no tasks."""
    if not tasks:
        return 0.0
    return round(sum(t.priority for t in tasks) / len(tasks), 0)


def count_by_tag(tasks: List[Task]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for t in tasks:
        for tag in t.tags:
            counts[tag] = counts.get(tag, 0) + 1
    return counts


def summary(tasks: List[Task]) -> Dict[str, float]:
    return {"completion": completion_rate(tasks), "avg_priority": average_priority(tasks), "count": len(tasks)}
