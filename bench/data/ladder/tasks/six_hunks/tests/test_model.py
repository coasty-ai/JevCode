from datetime import date

from src.model import Task, parse_priority

TODAY = date(2026, 5, 10)


def test_parse_priority():
    assert parse_priority(" High ") == 1
    assert parse_priority("low") == 3
    assert parse_priority("whenever") == 2


def test_is_overdue_yesterday_and_tomorrow():
    assert Task("a", due=date(2026, 5, 9)).is_overdue(TODAY)
    assert not Task("a", due=date(2026, 5, 11)).is_overdue(TODAY)


def test_done_and_undated_are_never_overdue():
    assert not Task("a", due=date(2026, 5, 1), done=True).is_overdue(TODAY)
    assert not Task("a").is_overdue(TODAY)


def test_with_done_keeps_fields():
    t = Task("a", 1, date(2026, 5, 1), tags=("x",)).with_done()
    assert t.done and t.priority == 1 and t.tags == ("x",)
