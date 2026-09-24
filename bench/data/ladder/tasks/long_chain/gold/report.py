"""Stage 6: the sales report text."""

from __future__ import annotations

from typing import List, Tuple

from .layout import LABEL_WIDTH, amount, rows, rule

SEP = "\n"
TITLE = "Sales by category"


def report(ranked: List[Tuple[str, float]], grand: float) -> str:
    """Title, a double rule, one row per label, a rule and the grand total."""
    lines = [TITLE, rule("=")] + rows(ranked) + [rule(), "Total".ljust(LABEL_WIDTH) + amount(grand)]
    return SEP.join(lines)


def line_count(text: str) -> int:
    return len(text.split(SEP)) if text else 0
