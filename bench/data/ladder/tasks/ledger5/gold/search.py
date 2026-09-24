"""A very small full-text ranking over book titles."""

from __future__ import annotations

import re
from typing import Iterable, List, Tuple

WORD = re.compile(r"[a-z0-9]+")


def tokenize(text: str) -> List[str]:
    return WORD.findall(text.lower())


def score(title: str, query: str) -> int:
    """Number of distinct query words that occur in the title."""
    words = set(tokenize(title))
    return sum(1 for q in set(tokenize(query)) if q in words)


def rank(titles: Iterable[str], query: str) -> List[Tuple[str, int]]:
    """Titles with a positive score, best first; ties keep the input order."""
    scored = [(t, score(t, query)) for t in titles]
    hits = [(t, s) for t, s in scored if s > 0]
    return sorted(hits, key=lambda ts: ts[1], reverse=True)


def highlight(title: str, query: str, mark: str = "*") -> str:
    """Wrap every query word of the title in `mark` characters, preserving its case."""
    words = set(tokenize(query))
    out = []
    for part in re.split(r"(\W+)", title):
        out.append(f"{mark}{part}{mark}" if part.lower() in words else part)
    return "".join(out)
