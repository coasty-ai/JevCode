"""Needs real pytest (fixtures, parametrize, skip, raises); the stdlib fallback cannot run it."""
import pytest

from calc import median


@pytest.mark.parametrize("xs,expected", [([1], 1), ([1, 2], 1.5)])
def test_median_param(xs, expected):
    assert median(xs) == expected


def test_skipped():
    pytest.skip("not today")


def test_raises():
    with pytest.raises(ValueError):
        median([])
