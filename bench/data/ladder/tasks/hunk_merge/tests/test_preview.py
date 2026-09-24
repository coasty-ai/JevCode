from src.hunks import Hunk
from src.preview import describe, preview, summary

BASE = ["a", "b", "c", "d"]


def test_describe_reads_like_a_diff_header():
    assert describe(Hunk(3, 2, ("X",))) == "@@ -3,2 +1"
    assert describe(Hunk(1, 0, ("X", "Y"))) == "@@ -1,0 +2"


def test_summary_lists_the_hunks_in_position_order():
    assert summary([Hunk(3, 1, ("C",)), Hunk(1, 1, ("A",))]) == ["@@ -1,1 +1", "@@ -3,1 +1", "net +0 line(s)"]


def test_summary_totals_the_growth():
    assert summary([Hunk(1, 0, ("x", "y")), Hunk(3, 2)]) == ["@@ -1,0 +2", "@@ -3,2 +0", "net +0 line(s)"]
    assert summary([Hunk(2, 3, ("only",))]) == ["@@ -2,3 +1", "net -2 line(s)"]


def test_summary_of_nothing():
    assert summary([]) == ["net +0 line(s)"]


def test_preview_is_the_patched_file_as_text():
    assert preview(BASE, [Hunk(2, 1, ("B",))]) == "a\nB\nc\nd\n"
    assert preview(BASE, []) == "a\nb\nc\nd\n"
