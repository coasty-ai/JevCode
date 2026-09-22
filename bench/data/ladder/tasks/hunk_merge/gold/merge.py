"""Combining two independently written sets of hunks against the same base."""

from __future__ import annotations

from typing import List, Sequence, Tuple

from .hunks import Hunk, by_position


class Conflict(Exception):
    """Raised when two hunks of the merged set lay claim to the same lines."""


def clashes(hunks: Sequence[Hunk]) -> List[Tuple[Hunk, Hunk]]:
    """Every pair inside one set of hunks that touches, in position order."""
    ordered = by_position(hunks)
    return [(a, b) for i, a in enumerate(ordered) for b in ordered[i + 1:] if a.touches(b)]


def conflicts(left: Sequence[Hunk], right: Sequence[Hunk]) -> List[Tuple[Hunk, Hunk]]:
    """Every (left, right) pair that touches, in position order on each side."""
    return [(a, b) for a in by_position(left) for b in by_position(right) if a.touches(b)]


def merge(left: Sequence[Hunk], right: Sequence[Hunk]) -> List[Hunk]:
    """The two sides as one set of hunks in position order.

    Raises Conflict when any two hunks of the merged set touch, whether they came from
    different sides or from the same one.
    """
    if clashes(list(left) + list(right)):
        raise Conflict("the two sides lay claim to the same lines")
    return by_position(list(left) + list(right))
