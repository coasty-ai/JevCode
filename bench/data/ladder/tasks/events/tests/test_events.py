import pytest

from src.events import Event, agenda, agenda_line, busiest_hour, duration_minutes, fmt_time, free_slots, overlaps

STANDUP = Event("Standup", 9 * 60, 9 * 60 + 15, location="Room 1", attendees=["a", "b", "c"])
REVIEW = Event("Review", 9 * 60 + 10, 10 * 60)
LUNCH = Event("Lunch", 12 * 60, 13 * 60)


def test_duration_minutes():
    assert duration_minutes(REVIEW) == 50


def test_overlaps():
    assert overlaps(STANDUP, REVIEW)
    assert not overlaps(STANDUP, LUNCH)


def test_fmt_time():
    assert fmt_time(90) == "01:30"
    assert fmt_time(0) == "00:00"


def test_agenda_line_minimal():
    assert agenda_line(REVIEW) == "09:10-10:00  Review"


def test_agenda_line_with_location_and_attendees():
    assert agenda_line(STANDUP) == "09:00-09:15  Standup @ Room 1 (3)"


def test_agenda_is_sorted_by_start():
    assert agenda([LUNCH, REVIEW, STANDUP]) == [
        "09:00-09:15  Standup @ Room 1 (3)",
        "09:10-10:00  Review",
        "12:00-13:00  Lunch",
    ]


def test_free_slots():
    assert free_slots([STANDUP, REVIEW, LUNCH], 8 * 60, 14 * 60) == [
        (480, 540),
        (600, 720),
        (780, 840),
    ]


def test_busiest_hour():
    assert busiest_hour([STANDUP, REVIEW, LUNCH]) == 9


def test_invalid_span_raises():
    with pytest.raises(ValueError):
        Event("Backwards", 600, 540)
