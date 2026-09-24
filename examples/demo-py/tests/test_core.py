import pytest

from calc import add, mean, parse_expression, safe_divide


def test_add():
    assert add(2, 3) == 5


def test_safe_divide_by_zero():
    assert safe_divide(1, 0) is None


def test_mean_simple():
    assert mean([2, 4, 6]) == 4


def test_mean_single():
    assert mean([10]) == 10


def test_mean_empty_raises():
    with pytest.raises(ValueError):
        mean([])


def test_parse_expression_plain():
    assert parse_expression("2+3") == (2.0, "+", 3.0)


def test_parse_expression_with_spaces():
    assert parse_expression("2 + 3") == (2.0, "+", 3.0)
    assert parse_expression(" 10 /  4 ") == (10.0, "/", 4.0)
