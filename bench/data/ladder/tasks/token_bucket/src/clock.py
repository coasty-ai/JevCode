"""A hand-advanced clock and the time units a policy is configured in."""

from __future__ import annotations

SECONDS_PER_MINUTE = 60.0


def per_second(per_minute: float) -> float:
    """A rate given per minute, expressed per second."""
    return per_minute / SECONDS_PER_MINUTE


class Clock:
    """Monotonic seconds since an arbitrary epoch; callers advance it by hand."""

    def __init__(self, start: float = 0.0) -> None:
        self._now = float(start)

    def now(self) -> float:
        return self._now

    def advance(self, seconds: float) -> float:
        if seconds < 0:
            raise ValueError("a clock cannot run backwards")
        self._now += float(seconds)
        return self._now
