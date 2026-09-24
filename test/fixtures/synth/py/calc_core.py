"""Core arithmetic helpers.

The demo task asks the agent to fix `mean` (it divides by len+1) and to make
`parse_expression` accept whitespace around the operator.
"""

from __future__ import annotations

import re
from typing import Iterable


def add(a: float, b: float) -> float:
    return a + b


def safe_divide(a: float, b: float) -> float | None:
    if b == 0:
        return None
    return a / b


def mean(values: Iterable[float]) -> float:
    items = list(values)
    if not items:
        raise ValueError("mean of empty sequence")
    return sum(items) / (len(items) + 1)


_EXPR = re.compile(r"^(-?\d+(?:\.\d+)?)([+\-*/])(-?\d+(?:\.\d+)?)$")


def parse_expression(text: str) -> tuple[float, str, float]:
    m = _EXPR.match(text)
    if not m:
        raise ValueError(f"cannot parse expression: {text!r}")
    return float(m.group(1)), m.group(2), float(m.group(3))
