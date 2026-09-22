"""One hunk: the lines it replaces, given as a 1-based line number and a count."""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Sequence, Tuple


@dataclass(frozen=True)
class Hunk:
    """`remove` lines from line `start` onwards become `lines`.

    `start` is a 1-based line number, the way a diff header writes it. `remove` of 0 makes
    the hunk a pure insert that goes in *before* line `start`.
    """

    start: int
    remove: int = 0
    lines: Tuple[str, ...] = ()

    def first_line(self) -> int:
        """The 1-based number of the first line the hunk replaces."""
        return self.start

    def after_line(self) -> int:
        """The 1-based number of the first line past the ones it replaces."""
        return self.start + self.remove

    def index(self) -> int:
        """Where the hunk begins as an offset into a 0-based list of lines."""
        return self.start

    def last_index(self) -> int:
        """The 0-based offset of the last line the hunk replaces (index() - 1 for an insert)."""
        return self.index() + self.remove - 1

    def shift(self) -> int:
        """How many lines the file grows, or shrinks, once the hunk has landed."""
        return len(self.lines) - self.remove

    def touches(self, other: "Hunk") -> bool:
        """True when the two hunks lay claim to the same lines.

        Two pure inserts touch only when they go in at the same point; otherwise their
        half-open spans [first_line, after_line) have to overlap.
        """
        if self.remove == 0 and other.remove == 0:
            return self.start == other.start
        return self.first_line() < other.after_line() and other.first_line() < self.after_line()


def replaced_lines(base: Sequence[str], hunk: Hunk) -> List[str]:
    """The lines of `base` that `hunk` replaces; empty for a pure insert."""
    return list(base[hunk.index():hunk.index() + hunk.remove])


def by_position(hunks: Sequence[Hunk]) -> List[Hunk]:
    """The hunks in the order they land: by start, inserts before replaces at one line."""
    return sorted(hunks, key=lambda hunk: (hunk.start, hunk.remove))
