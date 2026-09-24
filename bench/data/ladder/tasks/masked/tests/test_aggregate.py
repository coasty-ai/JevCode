from src.aggregate import count_by_level, slowest, total_ms, worst_level
from src.parse import Entry

E = [Entry("INFO", "a", 5), Entry("WARN", "b", 50), Entry("INFO", "c", 20), Entry("ERROR", "d", 7)]


def test_count_by_level():
    assert count_by_level(E) == {"INFO": 2, "WARN": 1, "ERROR": 1}
    assert count_by_level([]) == {}


def test_total_ms_empty():
    assert total_ms([]) == 0


def test_slowest_order_and_limit():
    assert [e.msg for e in slowest(E, 2)] == ["b", "c"]
    assert [e.msg for e in slowest(E)] == ["b", "c", "d"]


def test_slowest_ties_keep_input_order():
    ties = [Entry("INFO", "x", 3), Entry("INFO", "y", 3)]
    assert [e.msg for e in slowest(ties)] == ["x", "y"]


def test_worst_level():
    assert worst_level(E) == "ERROR"
    assert worst_level([]) == "DEBUG"
