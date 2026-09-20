"""Calendar arithmetic for the proleptic Gregorian calendar, without `datetime`."""

from __future__ import annotations

from typing import Tuple

_DAYS_IN_MONTH = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
MONTH_NAMES = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)
WEEKDAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def is_leap_year(year: int) -> bool:
    """Every 4th year is a leap year, except centuries, except every 400th year."""
    return (year % 4 == 0 and year % 100 != 0) or year % 400 == 0


def days_in_month(year: int, month: int) -> int:
    if not 1 <= month <= 12:
        raise ValueError(f"month out of range: {month}")
    if month == 2 and is_leap_year(year):
        return 29
    return _DAYS_IN_MONTH[month - 1]


def validate(year: int, month: int, day: int) -> None:
    """Raise ValueError unless (year, month, day) is a real date."""
    if not 1 <= day <= days_in_month(year, month):
        raise ValueError(f"day out of range: {year}-{month}-{day}")


def day_of_year(year: int, month: int, day: int) -> int:
    """1 for January 1st; 365 (366 in a leap year) for December 31st."""
    validate(year, month, day)
    return sum(days_in_month(year, m) for m in range(1, month)) + day


def parse_iso(text: str) -> Tuple[int, int, int]:
    """Parse 'YYYY-MM-DD' into (year, month, day)."""
    parts = text.strip().split("-")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        raise ValueError(f"not an ISO date: {text!r}")
    year, month, day = (int(p) for p in parts)
    validate(year, month, day)
    return year, month, day


def format_iso(year: int, month: int, day: int) -> str:
    validate(year, month, day)
    return f"{year:04d}-{month:02d}-{day:02d}"


def weekday(year: int, month: int, day: int) -> int:
    """0 for Monday ... 6 for Sunday (Sakamoto's method)."""
    validate(year, month, day)
    offsets = (0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4)
    y = year - 1 if month < 3 else year
    sunday_based = (y + y // 4 - y // 100 + y // 400 + offsets[month - 1] + day) % 7
    return (sunday_based + 6) % 7


def weekday_name(year: int, month: int, day: int) -> str:
    return WEEKDAY_NAMES[weekday(year, month, day)]


def month_name(month: int) -> str:
    if not 1 <= month <= 12:
        raise ValueError(f"month out of range: {month}")
    return MONTH_NAMES[month - 1]
