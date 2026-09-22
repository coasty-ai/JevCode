from src.hunks import Hunk, by_position, replaced_lines

BASE = ["a", "b", "c", "d"]


def test_a_hunk_knows_its_first_and_after_line():
    assert Hunk(3, 2).first_line() == 3
    assert Hunk(3, 2).after_line() == 5
    assert Hunk(3, 0).after_line() == 3


def test_index_is_the_zero_based_offset():
    # line 1 is the first element of the list
    assert Hunk(1, 1).index() == 0
    assert Hunk(4, 2).index() == 3


def test_last_index_is_the_offset_of_the_last_replaced_line():
    assert Hunk(1, 1).last_index() == 0
    assert Hunk(2, 2).last_index() == 2


def test_last_index_of_an_insert_sits_one_before_its_index():
    assert Hunk(3, 0).last_index() == 1
    assert Hunk(1, 0).last_index() == -1


def test_shift_is_how_much_the_file_grows():
    assert Hunk(1, 1, ("x",)).shift() == 0
    assert Hunk(1, 0, ("x", "y")).shift() == 2
    assert Hunk(1, 3).shift() == -3


def test_replaced_lines_are_the_ones_the_hunk_covers():
    assert replaced_lines(BASE, Hunk(1, 1)) == ["a"]
    assert replaced_lines(BASE, Hunk(2, 2)) == ["b", "c"]
    assert replaced_lines(BASE, Hunk(4, 1)) == ["d"]


def test_replaced_lines_of_an_insert_is_empty():
    assert replaced_lines(BASE, Hunk(2, 0, ("x",))) == []


def test_hunks_that_share_a_line_touch():
    assert Hunk(1, 2).touches(Hunk(2, 1)) is True
    assert Hunk(2, 1).touches(Hunk(1, 2)) is True


def test_adjacent_hunks_do_not_touch():
    # lines 1-2 and lines 3-3 are next to each other, not on top of each other
    assert Hunk(1, 2).touches(Hunk(3, 1)) is False
    assert Hunk(3, 1).touches(Hunk(1, 2)) is False


def test_two_inserts_touch_only_at_the_same_point():
    assert Hunk(2, 0, ("x",)).touches(Hunk(2, 0, ("y",))) is True
    assert Hunk(2, 0, ("x",)).touches(Hunk(3, 0, ("y",))) is False


def test_an_insert_beside_a_replace():
    assert Hunk(2, 0, ("x",)).touches(Hunk(2, 1, ("B",))) is False
    assert Hunk(2, 0, ("x",)).touches(Hunk(1, 2, ("Z",))) is True


def test_by_position_puts_an_insert_before_a_replace_at_one_line():
    hunks = [Hunk(3, 1), Hunk(2, 1), Hunk(2, 0, ("x",))]
    assert by_position(hunks) == [Hunk(2, 0, ("x",)), Hunk(2, 1), Hunk(3, 1)]
