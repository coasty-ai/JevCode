import pytest

from src.checks import InvalidValue
from src.pricing import GROUP_MIN, per_person, total, unit_price


def test_unit_price():
    assert unit_price("standard") == 40
    assert unit_price("vip") == 120


def test_unit_price_unknown_tier():
    with pytest.raises(InvalidValue):
        unit_price("gold")


def test_total_single_seat():
    assert total("premium", 1) == 75.0


def test_total_two_seats():
    assert total("standard", 2) == 80.0


def test_total_below_group_minimum_has_no_discount():
    assert total("standard", GROUP_MIN - 1) == 200.0


def test_total_group_discount():
    assert total("standard", GROUP_MIN) == 216.0
    assert total("vip", 10) == 1080.0


def test_per_person():
    assert per_person("premium", 1) == 75.0
    assert per_person("standard", 8) == 36.0
