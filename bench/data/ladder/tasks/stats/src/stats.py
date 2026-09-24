"""Descriptive statistics on sequences of numbers, standard library only."""

from __future__ import annotations

import math
from collections import Counter
from typing import Dict, List, Sequence


def mean(values: Sequence[float]) -> float:
    if not values:
        raise ValueError("mean of empty sequence")
    return sum(values) / len(values)


def median(values: Sequence[float]) -> float:
    """The middle value, or the mean of the two middle values for even lengths."""
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[mid])
    return (ordered[mid - 1] + ordered[mid]) / 2


def mode(values: Sequence[float]) -> float:
    """The most frequent value; the smallest one when several tie."""
    if not values:
        raise ValueError("mode of empty sequence")
    counts = Counter(values)
    best = max(counts.values())
    return min(v for v, c in counts.items() if c == best)


def variance(values: Sequence[float]) -> float:
    """Population variance."""
    if not values:
        raise ValueError("variance of empty sequence")
    m = mean(values)
    return sum((v - m) ** 2 for v in values) / len(values)


def stdev(values: Sequence[float]) -> float:
    return math.sqrt(variance(values))


def percentile(values: Sequence[float], p: float) -> float:
    """Linearly interpolated percentile for p in [0, 100]."""
    if not values:
        raise ValueError("percentile of empty sequence")
    if not 0 <= p <= 100:
        raise ValueError("p must be between 0 and 100")
    ordered = sorted(values)
    pos = (len(ordered) - 1) * p / 100
    lo = math.floor(pos)
    hi = math.ceil(pos)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (pos - lo)


def zscores(values: Sequence[float]) -> List[float]:
    """Standard scores; all zero when every value is the same."""
    sd = stdev(values)
    if sd == 0:
        return [0.0 for _ in values]
    m = mean(values)
    return [(v - m) / sd for v in values]


def summary(values: Sequence[float]) -> Dict[str, float]:
    """Headline statistics; raises ValueError on an empty sequence."""
    return {
        "median": median(values),
        "mean": mean(values),
        "min": min(values),
        "max": max(values),
        "stdev": stdev(values),
    }
