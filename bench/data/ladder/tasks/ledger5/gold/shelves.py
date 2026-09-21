"""Shelf layout: call numbers to sections, slot addressing and labels."""

from __future__ import annotations

from typing import List, Tuple

SECTIONS = [
    (0, "Computer science"), (100, "Philosophy"), (200, "Religion"), (300, "Social sciences"),
    (400, "Language"), (500, "Science"), (600, "Technology"), (700, "Arts"),
    (800, "Literature"), (900, "History"),
]
PER_SHELF = 20


def section_for(call_number: float) -> str:
    """The Dewey section whose hundred contains `call_number`."""
    if not 0 <= call_number < 1000:
        raise ValueError("call number out of range")
    name = SECTIONS[0][1]
    for start, section in SECTIONS:
        if call_number >= start:
            name = section
    return name


def slot(index: int, per_shelf: int = PER_SHELF) -> Tuple[int, int]:
    """(shelf, position) of the `index`-th book, both zero-based."""
    if index < 0:
        raise ValueError("index must be non-negative")
    return index // per_shelf, index % per_shelf


def label(shelf: int, position: int) -> str:
    """Shelves are lettered A, B, ...; positions are numbered from 1 ('A1', 'C20')."""
    number = position + 1
    return f"{chr(ord('A') + shelf)}{number}"


def labels(count: int, per_shelf: int = PER_SHELF) -> List[str]:
    return [label(*slot(i, per_shelf)) for i in range(count)]
