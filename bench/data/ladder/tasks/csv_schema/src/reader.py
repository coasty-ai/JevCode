"""Splitting CSV text into a header and its rows."""

from __future__ import annotations

from typing import List, Tuple

DELIMITER = ","
COMMENT = "#"


def split_line(line: str) -> List[str]:
    return [cell.strip() for cell in line.split(DELIMITER)]


def read(text: str) -> Tuple[List[str], List[List[str]]]:
    """(header, rows). Blank and #-commented lines are dropped; every cell is stripped.

    Rows are handed on exactly as wide as they were written: making them line up with the
    header is the schema's job, not the reader's.
    """
    lines = [line for line in text.splitlines() if line.strip() and not line.lstrip().startswith(COMMENT)]
    if not lines:
        return [], []
    return split_line(lines[0]), [split_line(line) for line in lines[1:]]
