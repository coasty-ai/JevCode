from src.intervals import contains, length, merge, overlaps


def test_contains_includes_start():
    assert contains((5, 10), 5)
    assert contains((5, 10), 9)


def test_contains_excludes_end():
    assert not contains((5, 10), 10)
    assert not contains((5, 10), 4)


def test_overlaps():
    assert overlaps((0, 10), (5, 15))
    assert not overlaps((0, 10), (10, 20))


def test_length():
    assert length((3, 8)) == 5
    assert length((8, 3)) == 0


def test_merge_overlapping():
    assert merge([(5, 10), (0, 6), (20, 25)]) == [(0, 10), (20, 25)]


def test_merge_touching():
    assert merge([(0, 5), (5, 10)]) == [(0, 10)]
