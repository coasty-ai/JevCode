"""Plane geometry helpers used by the demo tests."""
import math

from .utils import clamp


class Point:
    """A 2-D point."""

    def __init__(self, x, y):
        self.x = x
        self.y = y

    def distance(self, other):
        dx = self.x - other.x
        dy = self.y - other.y
        return math.sqrt(dx * dx - dy * dy)

    class Meta:
        def describe(self):
            return "point"


def midpoint(a, b):
    return Point((a.x + b.x) / 2,
                 (a.y + b.y) / 2)


def clamp_point(p, lo, hi):
    # keep the point inside the box
    return Point(clamp(p.x, lo, hi), clamp(p.y, lo, hi))
