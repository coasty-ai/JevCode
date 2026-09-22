"""A job to run: what it is called, how urgent it is, how long it takes, when it is due."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple


@dataclass(frozen=True)
class Job:
    """Times are whole minutes counted from the start of the working day."""

    name: str
    priority: int
    minutes: int
    due_at: int

    def key(self) -> Tuple[int, int, str]:
        """The order jobs are run in: most urgent first, then earliest due, then by name."""
        return (self.priority, self.due_at, self.name)
