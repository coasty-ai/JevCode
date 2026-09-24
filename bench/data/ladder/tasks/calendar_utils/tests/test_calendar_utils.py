import pytest

from src.calendar_utils import (
    day_of_year,
    days_in_month,
    format_iso,
    is_leap_year,
    month_name,
    parse_iso,
    weekday,
    weekday_name,
)


def test_common_years_are_not_leap():
    assert [is_leap_year(y) for y in (2023, 1900, 2100)] == [False, False, False]


def test_leap_years():
    assert [is_leap_year(y) for y in (2024, 2000, 1996)] == [True, True, True]


def test_days_in_month_february():
    assert days_in_month(2024, 2) == 29
    assert days_in_month(2023, 2) == 28


def test_days_in_month_invalid_month_raises():
    with pytest.raises(ValueError):
        days_in_month(2023, 13)


def test_day_of_year_first_day():
    assert day_of_year(2023, 1, 1) == 1


def test_day_of_year_last_day():
    assert day_of_year(2023, 12, 31) == 365


def test_parse_iso():
    assert parse_iso("2024-03-05") == (2024, 3, 5)
    assert parse_iso(" 1999-12-31 ") == (1999, 12, 31)


def test_parse_iso_rejects_garbage():
    for bad in ("2024/03/05", "hello", "2024-3", "2024-13-01"):
        with pytest.raises(ValueError):
            parse_iso(bad)


def test_format_iso_pads():
    assert format_iso(2024, 3, 5) == "2024-03-05"


def test_weekday_and_names():
    assert weekday(2024, 1, 1) == 0
    assert weekday_name(2023, 12, 31) == "Sunday"
    assert month_name(3) == "March"
