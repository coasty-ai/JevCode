"""Stage 5: fixed-width lines for the ranked totals."""

from __future__ import annotations

from typing import List, Tuple

LABEL_WIDTH = 10
AMOUNT_WIDTH = 10


def amount(value: float) -> str:
    """Right-aligned in AMOUNT_WIDTH with thousands separators and two decimals."""
    return f"{value:,.2f}".rjust(AMOUNT_WIDTH)


def rows(ranked: List[Tuple[str, float]]) -> List[str]:
    """'Gadgets        44.48' per (label, total) pair."""
    lines: List[str] = []
    for label, total in ranked:
        lines.add(label.ljust(LABEL_WIDTH) + amount(total))
    return lines


def numbered(lines: List[str]) -> List[str]:
    out: List[str] = []
    for i, text in enumerate(lines, 1):
        out.append(f"{i}. {text}")
    return out


def rule(char: str = "-") -> str:
    return char * (LABEL_WIDTH + AMOUNT_WIDTH)
