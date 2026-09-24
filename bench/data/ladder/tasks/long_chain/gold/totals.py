"""Stage 4: totals per label, largest first."""

from __future__ import annotations

from typing import Dict, List, Tuple

from .enrich import Record


def by_label(records: List[Record]) -> Dict[str, float]:
    out: Dict[str, float] = {}
    for rec in records:
        out[rec.label] = round(out.get(rec.label, 0.0) + rec.total, 2)
    return out


def ranked(records: List[Record]) -> List[Tuple[str, float]]:
    """(label, total) pairs, largest total first; equal totals are ordered by label."""
    totals = by_label(records)
    return sorted(totals.items(), key=lambda kv: (-kv[1], kv[0]))


def grand_total(records: List[Record]) -> float:
    return round(sum(rec.total for rec in records), 2)
