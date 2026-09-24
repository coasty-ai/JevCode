from src.levels import LEVELS, at_least, highest, rank, sort_levels


def test_rank_order():
    assert [rank(level) for level in LEVELS] == [0, 1, 2, 3]


def test_rank_unknown_is_below_debug():
    assert rank("TRACE") == -1


def test_at_least():
    assert at_least("ERROR", "WARN")
    assert at_least("WARN", "WARN")
    assert not at_least("INFO", "WARN")


def test_highest():
    assert highest(["INFO", "ERROR", "WARN"]) == "ERROR"
    assert highest([]) == "DEBUG"


def test_sort_levels():
    assert sort_levels(["ERROR", "DEBUG", "WARN"]) == ["DEBUG", "WARN", "ERROR"]
