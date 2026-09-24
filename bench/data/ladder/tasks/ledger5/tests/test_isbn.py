import pytest

from src.isbn import is_valid_isbn10, is_valid_isbn13, isbn10_check_digit, isbn13_check_digit, normalize, to_isbn13


def test_normalize_strips_separators_and_uppercases():
    assert normalize("0-8044-2957-x") == "080442957X"
    assert normalize("978 0 306 40615 7") == "9780306406157"


def test_isbn10_check_digit():
    assert isbn10_check_digit("030640615") == "2"
    assert isbn10_check_digit("080442957") == "X"


def test_isbn10_check_digit_rejects_bad_body():
    with pytest.raises(ValueError):
        isbn10_check_digit("12345")


def test_valid_isbn10():
    assert is_valid_isbn10("0-306-40615-2")
    assert is_valid_isbn10("0-8044-2957-X")


def test_invalid_isbn10():
    assert not is_valid_isbn10("0-306-40615-3")
    assert not is_valid_isbn10("030640615")
    assert not is_valid_isbn10("03064O6152")


def test_isbn13():
    assert isbn13_check_digit("978030640615") == "7"
    assert is_valid_isbn13("978-0-306-40615-7")
    assert not is_valid_isbn13("978-0-306-40615-8")


def test_to_isbn13():
    assert to_isbn13("0-306-40615-2") == "9780306406157"
    with pytest.raises(ValueError):
        to_isbn13("0-306-40615-3")
