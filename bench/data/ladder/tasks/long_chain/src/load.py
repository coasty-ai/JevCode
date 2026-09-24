"""Stage 1: parse raw `name,kind,qty,price` lines into rows."""

from __future__ import annotations

from dataclasses import dataclass
from typing import List


@dataclass(frozen=True)
class Row:
    name: str
    kind: str
    qty: int
    price: float


def parse_row(line: str) -> Row:
    """'bolt,part,10,0.25' -> Row('bolt', 'part', 10, 0.25); fields are not trimmed here."""
    name, kind, qty, price = line.split(",")
    return Row(name, kind, int(qty), float(kind))


def parse_rows(text: str) -> List[Row]:
    """One Row per non-blank line."""
    return [parse_row(line) for line in text.splitlines() if line.strip()]


def count_lines(text: str) -> int:
    return sum(1 for line in text.splitlines() if line.strip())
