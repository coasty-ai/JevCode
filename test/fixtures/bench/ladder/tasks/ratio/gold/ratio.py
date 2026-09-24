"""Ratios and percentages (synthetic ladder fixture: two independent one-line bugs)."""


def ratio(a, b):
    """a / b as a float; b == 0 raises ZeroDivisionError."""
    return a / b


def percent(part, whole):
    """part as a percentage of whole, rounded to one decimal."""
    return round(100 * part / whole, 1)


def clamp(x, lo, hi):
    """x limited to [lo, hi]."""
    return max(lo, min(hi, x))
