"""How much room, or how little, a job has against its deadline."""

from __future__ import annotations


def lateness(finish_at: int, due_at: int) -> int:
    """How many minutes past its deadline a job finishing at `finish_at` lands.

    Negative when the job lands early and zero when it lands exactly on the deadline.
    """
    return finish_at - due_at


def is_late(finish_at: int, due_at: int) -> bool:
    return lateness(finish_at, due_at) > 0


def headroom(finish_at: int, due_at: int) -> int:
    """Minutes to spare before the deadline, never below zero."""
    return max(0, -lateness(finish_at, due_at))
