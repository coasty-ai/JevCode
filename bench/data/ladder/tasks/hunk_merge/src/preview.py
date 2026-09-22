"""A short, readable summary of a set of hunks, and the patched file to eyeball."""

from __future__ import annotations

from typing import List, Sequence

from .apply import apply
from .hunks import Hunk, by_position
from .text import to_text


def describe(hunk: Hunk) -> str:
    """'@@ -3,2 +1': from line 3, two lines out, one line in."""
    return "@@ -%d,%d +%d" % (hunk.start, hunk.remove, len(hunk.lines))


def summary(hunks: Sequence[Hunk]) -> List[str]:
    """One line per hunk in position order, then how much the file grows overall."""
    lines = [describe(hunk) for hunk in by_position(hunks)]
    lines.append("net %+d line(s)" % sum(hunk.shift() for hunk in hunks))
    return lines


def preview(base: Sequence[str], hunks: Sequence[Hunk]) -> str:
    """The patched file as text."""
    return to_text(apply(base, hunks))
