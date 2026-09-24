import pytest

from src.grades import class_average, letter_grade, passing, report, top_students, weighted_average

BOOK = {"ann": [96, 86], "bob": [70, 72], "cid": [55, 50], "dee": [88, 84]}


def test_letter_grade_interior_scores():
    assert [letter_grade(s) for s in (95, 85, 75, 65, 30)] == ["A", "B", "C", "D", "F"]


def test_letter_grade_boundaries_are_inclusive():
    assert [letter_grade(s) for s in (90, 80, 70, 60)] == ["A", "B", "C", "D"]


def test_letter_grade_out_of_range_raises():
    with pytest.raises(ValueError):
        letter_grade(101)


def test_weighted_average_unit_weights():
    assert weighted_average([80, 90], [1, 1]) == 85.0


def test_weighted_average_unequal_weights():
    assert weighted_average([100, 50], [3, 1]) == 87.5


def test_weighted_average_fractional_weights():
    assert weighted_average([80, 90], [0.25, 0.75]) == 87.5


def test_weighted_average_length_mismatch_raises():
    with pytest.raises(ValueError):
        weighted_average([1, 2], [1])


def test_class_average():
    assert class_average(BOOK) == pytest.approx(75.125)


def test_top_students_and_passing():
    assert top_students(BOOK, 2) == ["ann", "dee"]
    assert passing(BOOK) == ["ann", "bob", "dee"]


def test_report():
    assert report(BOOK) == {"ann": "A", "bob": "C", "cid": "F", "dee": "B"}
