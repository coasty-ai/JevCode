"""Folding a column of cells down to the one kind that holds all of them."""

from __future__ import annotations

from typing import Iterable, List

from .cells import WIDEST, cell_type, is_blank, widen


def column_type(values: Iterable[str]) -> str:
    """The narrowest kind every non-blank cell of the column reads as.

    A column with nothing but blanks (or no cells at all) is text.
    """
    kinds: List[str] = [cell_type(value) for value in values if not is_blank(value)]
    if not kinds:
        return WIDEST
    kind = kinds[0]
    for other in kinds:
        kind = widen(kind, other)
    return kind


def column_is_nullable(values: Iterable[str]) -> bool:
    return any(is_blank(value) for value in values)
