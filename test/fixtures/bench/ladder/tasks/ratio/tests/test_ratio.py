import pytest

from src.ratio import clamp, percent, ratio


def test_ratio_divides():
    assert ratio(6, 3) == 2


def test_ratio_zero_raises():
    with pytest.raises(ZeroDivisionError):
        ratio(1, 0)


def test_percent_rounds_to_one_decimal():
    assert percent(1, 3) == 33.3


def test_clamp_inside():
    assert clamp(5, 0, 10) == 5


def test_clamp_outside():
    assert clamp(-1, 0, 10) == 0
    assert clamp(11, 0, 10) == 10
