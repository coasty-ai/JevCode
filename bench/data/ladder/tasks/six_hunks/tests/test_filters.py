from datetime import date

from src.filters import completed, due_within, overdue, pending, with_tag
from src.model import Task

TODAY = date(2026, 5, 10)
TASKS = [Task("a", due=date(2026, 5, 1)), Task("b", due=date(2026, 5, 12), tags=("home",)), Task("c", done=True), Task("d", due=date(2026, 5, 30))]


def test_pending_and_completed():
    assert [t.title for t in pending(TASKS)] == ["a", "b", "d"]
    assert [t.title for t in completed(TASKS)] == ["c"]


def test_with_tag():
    assert [t.title for t in with_tag(TASKS, "home")] == ["b"]
    assert with_tag(TASKS, "work") == []


def test_overdue():
    assert [t.title for t in overdue(TASKS, TODAY)] == ["a"]


def test_due_within_inside_window():
    assert [t.title for t in due_within(TASKS, TODAY, 7)] == ["b"]
    assert [t.title for t in due_within(TASKS, TODAY, 30)] == ["b", "d"]
