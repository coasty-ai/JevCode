import pytest

from src.fmt import center, human_bytes, pad, pad_left, plural, truncate


def test_pad_default_and_no_truncation():
    assert pad("ab", 5) == "ab   "
    assert pad("abcdef", 3) == "abcdef"


def test_pad_custom_fill():
    assert pad("ab", 5, "-") == "ab---"


def test_pad_fill_keyword():
    assert pad("7", 3, fill="0") == "700"


def test_pad_left_and_center():
    assert pad_left("7", 3) == "  7"
    assert pad_left("7", 3, "0") == "007"
    assert center("ab", 5) == " ab  "
    assert center("ab", 6, ".") == "..ab.."


def test_truncate_human_bytes_plural():
    assert truncate("abcdefgh", 6) == "abc..."
    assert truncate("abc", 6) == "abc"
    assert human_bytes(1536) == "1.5 KiB"
    assert human_bytes(2 * 1024 * 1024) == "2 MiB"
    with pytest.raises(ValueError):
        human_bytes(-1)
    assert plural(1, "file") == "1 file"
    assert plural(3, "box", "boxes") == "3 boxes"
