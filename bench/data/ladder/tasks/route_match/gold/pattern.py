"""A route pattern: static segments and <name> placeholders."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence

from .segments import split

OPEN = "<"
CLOSE = ">"


def is_parameter(segment: str) -> bool:
    """True for a placeholder segment, which is written <name>."""
    return len(segment) > 2 and segment.startswith(OPEN) and segment.endswith(CLOSE)


def parameter_name(segment: str) -> str:
    """The name inside a placeholder segment."""
    if not is_parameter(segment):
        raise ValueError(segment)
    return segment[1:-1]


@dataclass(frozen=True)
class Pattern:
    text: str

    def segments(self) -> List[str]:
        return split(self.text)

    def names(self) -> List[str]:
        """The placeholder names, in the order they appear."""
        return [parameter_name(s) for s in self.segments() if is_parameter(s)]

    def width(self) -> int:
        return len(self.segments())


def specificity(pattern: Pattern) -> int:
    """How much of a path the pattern pins down; the higher, the more specific.

    A static segment pins one segment of the path down. A placeholder pins nothing: it
    takes whatever is there.
    """
    return sum(1 for segment in pattern.segments() if not is_parameter(segment))


def more_specific(left: Pattern, right: Pattern) -> bool:
    """True when `left` pins down strictly more than `right`."""
    return specificity(left) > specificity(right)


def rank(patterns: Sequence[Pattern]) -> List[Pattern]:
    """The patterns most specific first; ties keep the order they came in."""
    return sorted(patterns, key=specificity, reverse=True)


def captures(pattern: Pattern, path: str) -> Optional[Dict[str, str]]:
    """What the placeholders capture from `path`, or None when the pattern does not match."""
    want = pattern.segments()
    have = split(path)
    if len(want) != len(have):
        return None
    out: Dict[str, str] = {}
    for expected, actual in zip(want, have):
        if is_parameter(expected):
            out[parameter_name(expected)] = actual
        elif expected != actual:
            return None
    return out
