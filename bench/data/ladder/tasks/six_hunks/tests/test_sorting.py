from datetime import date

from src.model import Task
from src.sorting import by_due, by_priority, by_title

A, B, C = Task("beta", 3, date(2026, 5, 3)), Task("Alpha", 1, date(2026, 5, 1)), Task("gamma", 2, date(2026, 5, 2))


def test_by_priority_stable():
    assert [t.title for t in by_priority([A, B, C, Task("delta", 1)])] == ["Alpha", "delta", "gamma", "beta"]


def test_by_due_all_dated():
    assert [t.title for t in by_due([A, B, C])] == ["Alpha", "gamma", "beta"]


def test_by_title_case_insensitive():
    assert [t.title for t in by_title([A, B, C])] == ["Alpha", "beta", "gamma"]
