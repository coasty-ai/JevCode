"""Stage 3: rows -> records with a category label and a line total."""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from .load import Row

LABELS = {"gadget": "Gadgets", "part": "Parts", "tool": "Tools"}


@dataclass(frozen=True)
class Record:
    name: str
    label: str
    total: float


def to_record(row: Row) -> Record:
    """The label comes from the row's kind; the total is qty * price in cents."""
    return Record(row.name, LABELS[row.name], round(row.qty * row.price, 2))


def enrich(rows: List[Row]) -> List[Record]:
    return [to_record(row) for row in rows]


def is_known(row: Row) -> bool:
    """True when the row's kind has a label."""
    return row.kind in LABELS


def known_kinds() -> List[str]:
    return sorted(LABELS)
