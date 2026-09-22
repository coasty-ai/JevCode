import pytest

from src.apply import apply
from src.hunks import Hunk
from src.merge import Conflict, clashes, conflicts, merge

BASE = ["a", "b", "c", "d", "e"]


def test_clashes_finds_every_touching_pair_inside_one_set():
    a, b, c = Hunk(1, 2, ("X",)), Hunk(2, 1, ("Y",)), Hunk(5, 1, ("Z",))
    assert clashes([a, b, c]) == [(a, b)]


def test_clashes_of_hunks_that_keep_out_of_each_other_s_way():
    assert clashes([Hunk(1, 1), Hunk(2, 1), Hunk(3, 1)]) == []
    assert clashes([]) == []


def test_conflicts_pairs_one_side_against_the_other():
    left, right = [Hunk(1, 2, ("X",))], [Hunk(2, 1, ("Y",)), Hunk(5, 1, ("Z",))]
    assert conflicts(left, right) == [(left[0], right[0])]


def test_merge_puts_both_sides_in_position_order():
    left = [Hunk(4, 1, ("D",)), Hunk(1, 1, ("A",))]
    right = [Hunk(2, 0, ("ins",))]
    assert merge(left, right) == [Hunk(1, 1, ("A",)), Hunk(2, 0, ("ins",)), Hunk(4, 1, ("D",))]


def test_merge_of_an_empty_side():
    left = [Hunk(2, 1, ("B",))]
    assert merge(left, []) == left
    assert merge([], []) == []


def test_merge_refuses_two_sides_that_lay_claim_to_the_same_lines():
    with pytest.raises(Conflict):
        merge([Hunk(1, 2, ("X",))], [Hunk(2, 1, ("Y",))])


def test_merge_refuses_a_left_side_that_overlaps_itself():
    with pytest.raises(Conflict):
        merge([Hunk(1, 2, ("X",)), Hunk(2, 1, ("Y",))], [Hunk(5, 1, ("Z",))])


def test_merge_refuses_a_right_side_that_overlaps_itself():
    with pytest.raises(Conflict):
        merge([Hunk(5, 1, ("Z",))], [Hunk(1, 2, ("X",)), Hunk(2, 1, ("Y",))])


def test_a_merged_set_applies_cleanly():
    merged = merge([Hunk(1, 1, ("A",))], [Hunk(3, 2, ("CD",))])
    assert apply(BASE, merged) == ["A", "b", "CD", "e"]
