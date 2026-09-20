"""Small numeric helpers."""


def clamp(v, lo, hi):
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


def mean(values):
    return sum(values) / len(values)
