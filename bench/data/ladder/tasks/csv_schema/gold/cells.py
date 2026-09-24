"""What a single CSV cell reads as, and how two readings combine."""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, Optional

BOOLS = {"true": True, "false": False, "yes": True, "no": False}

#: the widening order of the numeric-to-text chain; the kinds outside it (bool, date)
#: combine with anything unlike themselves as the widest kind of all
NARROWEST = "int"
WIDEST = "str"
RANK: Dict[str, int] = {"int": 0, "float": 1, "str": 2}


def is_blank(text: str) -> bool:
    return text.strip() == ""


def _as_int(body: str) -> Optional[int]:
    try:
        return int(body)
    except ValueError:
        return None


def _as_float(body: str) -> Optional[float]:
    try:
        return float(body)
    except ValueError:
        return None


def _as_bool(body: str) -> Optional[bool]:
    return BOOLS.get(body.lower())


def _as_date(body: str) -> Optional[date]:
    try:
        return date.fromisoformat(body)
    except ValueError:
        return None


CASTS = {"int": _as_int, "float": _as_float, "bool": _as_bool, "date": _as_date, "str": lambda body: body}


def cell_type(text: str) -> str:
    """The narrowest of int / float / bool / date / str that `text` reads as."""
    body = text.strip()
    if _as_int(body) is not None:
        return "int"
    if _as_float(body) is not None:
        return "float"
    if _as_bool(body) is not None:
        return "bool"
    if _as_date(body) is not None:
        return "date"
    return "str"


def cast(kind: str, text: str) -> Any:
    """`text` read as `kind`, or None when it does not read as one."""
    if kind not in CASTS:
        raise KeyError(kind)
    return CASTS[kind](text.strip())


def widen(left: str, right: str) -> str:
    """The narrowest kind that holds both readings."""
    if left == right:
        return left
    if left in RANK and right in RANK:
        return left if RANK[left] > RANK[right] else right
    return WIDEST
