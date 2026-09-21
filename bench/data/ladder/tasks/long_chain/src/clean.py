"""Stage 2: normalise names and kinds."""

from __future__ import annotations

from typing import List

from .load import Row


def clean_row(row: Row) -> Row:
    """Trim and title-case the name, trim and lower-case the kind."""
    return Row(row.label.strip().title(), row.kind.strip().lower(), row.qty, row.price)


def clean(rows: List[Row]) -> List[Row]:
    return [clean_row(row) for row in rows]


def names(rows: List[Row]) -> List[str]:
    return [row.name for row in rows]
