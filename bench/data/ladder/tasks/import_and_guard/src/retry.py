"""Retry schedules: exponential backoff with a cap and a bounded attempt count."""

from __future__ import annotations

from typing import List


def backoff(attempt: int, base: float = 0.5, factor: float = 2.0, cap: float = 8.0) -> float:
    """Delay before `attempt` (1-based): base * factor ** (attempt - 1), never above cap."""
    if attempt < 1:
        raise ValueError("attempt starts at 1")
    return min(base * factor ** (attempt - 1), cap)


def schedule(attempts: int, **kwargs: float) -> List[float]:
    """The delays between consecutive attempts: one fewer than `attempts` (the first is immediate)."""
    return [backoff(n, **kwargs) for n in range(1, attempts + 1)]


def total_wait(attempts: int, **kwargs: float) -> float:
    return round(sum(schedule(attempts, **kwargs)), 3)


def should_retry(status: int, attempt: int, max_attempts: int = 3) -> bool:
    """Retry server errors and 429 while attempts remain."""
    return attempt < max_attempts and (status == 429 or 500 <= status < 600)
