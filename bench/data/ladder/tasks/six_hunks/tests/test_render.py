from src.model import Task
from src.render import header, line


def test_line_undone_and_done():
    assert line(Task("Write tests", 1)) == "[ ] Write tests (high)"
    assert line(Task("Ship", 3, done=True)) == "[x] Ship (low)"


def test_line_keeps_title_that_fits_exactly():
    assert line(Task("abcdef"), width=6) == "[ ] abcdef (medium)"


def test_header():
    assert header("Todo") == "Todo\n===="
    assert header("A long heading", width=6) == "A long heading\n======"
