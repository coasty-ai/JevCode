import pytest

from src.apply import OverlappingHunks, apply
from src.hunks import Hunk
from src.text import to_lines, to_text

BASE = ["a", "b", "c", "d"]


def test_applying_nothing_leaves_the_file_alone():
    assert apply(BASE, []) == BASE


def test_replacing_the_first_line():
    assert apply(BASE, [Hunk(1, 1, ("A",))]) == ["A", "b", "c", "d"]


def test_replacing_a_line_in_the_middle():
    assert apply(BASE, [Hunk(3, 1, ("C",))]) == ["a", "b", "C", "d"]


def test_replacing_the_last_line():
    assert apply(BASE, [Hunk(4, 1, ("D",))]) == ["a", "b", "c", "D"]


def test_replacing_a_run_of_lines_with_a_different_count():
    assert apply(BASE, [Hunk(2, 2, ("X",))]) == ["a", "X", "d"]
    assert apply(BASE, [Hunk(2, 1, ("X", "Y"))]) == ["a", "X", "Y", "c", "d"]


def test_inserting_before_a_line():
    assert apply(BASE, [Hunk(1, 0, ("first",))]) == ["first", "a", "b", "c", "d"]
    assert apply(BASE, [Hunk(3, 0, ("mid",))]) == ["a", "b", "mid", "c", "d"]


def test_inserting_past_the_last_line():
    assert apply(BASE, [Hunk(5, 0, ("last",))]) == ["a", "b", "c", "d", "last"]


def test_deleting_lines():
    assert apply(BASE, [Hunk(2, 2)]) == ["a", "d"]


def test_several_hunks_land_in_one_pass():
    hunks = [Hunk(1, 1, ("A",)), Hunk(3, 2, ("CD",))]
    assert apply(BASE, hunks) == ["A", "b", "CD"]


def test_hunks_are_applied_in_position_order_however_they_are_given():
    hunks = [Hunk(4, 1, ("D",)), Hunk(1, 0, ("zero",)), Hunk(2, 1, ("B",))]
    assert apply(BASE, hunks) == ["zero", "a", "B", "c", "D"]


def test_overlapping_hunks_are_refused():
    with pytest.raises(OverlappingHunks):
        apply(BASE, [Hunk(1, 2, ("X",)), Hunk(2, 1, ("Y",))])


def test_apply_round_trips_through_text():
    lines = to_lines("one\ntwo\nthree\n")
    assert to_text(apply(lines, [Hunk(2, 1, ("TWO",))])) == "one\nTWO\nthree\n"
