import pytest

from src.checks import InvalidValue, ensure_at_least, ensure_at_most, ensure_non_empty, ensure_one_of


def test_ensure_at_least_returns_value():
    assert ensure_at_least(3, 1, "n") == 3
    assert ensure_at_least(0, 0, "n") == 0


def test_ensure_at_least_raises_below_minimum():
    with pytest.raises(InvalidValue, match="n must be at least 1, got 0"):
        ensure_at_least(0, 1, "n")


def test_ensure_at_most():
    assert ensure_at_most(5, 5, "n") == 5
    with pytest.raises(InvalidValue):
        ensure_at_most(6, 5, "n")


def test_ensure_non_empty():
    assert ensure_non_empty([1], "items") == [1]
    with pytest.raises(InvalidValue):
        ensure_non_empty("", "name")


def test_ensure_one_of():
    assert ensure_one_of("a", ("a", "b"), "k") == "a"
    with pytest.raises(InvalidValue):
        ensure_one_of("c", ("a", "b"), "k")
