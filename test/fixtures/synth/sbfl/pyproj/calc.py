"""Arithmetic helpers for the SBFL fixtures. median() has a one-line bug on the even branch."""


def mean(xs):
    if not xs:
        raise ValueError("mean of an empty list")
    return sum(xs) / len(xs)


def median(xs):
    if not xs:
        raise ValueError("median of an empty list")
    s = sorted(xs)
    n = len(s)
    mid = n // 2
    if n % 2 == 1:
        return s[mid]
    return (s[mid] + s[mid + 1]) / 2  # BUG: should average s[mid - 1] and s[mid]


def clamp(x, lo, hi):
    if x < lo:
        return lo
    if x > hi:
        return hi
    return x


def running_max(xs):
    out = []
    best = None
    for x in xs:
        if best is None or x > best:
            best = x
        out.append(best)
    return out
