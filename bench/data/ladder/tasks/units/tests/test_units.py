import pytest

from src.units import format_duration, format_size, parse_duration, parse_size, total_size


def test_parse_size_units():
    assert parse_size("10KB") == 10240
    assert parse_size("1.5 mb") == 1572864


def test_parse_size_bare_number_is_bytes():
    assert parse_size("512") == 512
    assert parse_size("512B") == 512


def test_parse_size_total():
    assert total_size(["1KB", "1KB", "24"]) == 2072


def test_parse_duration_minutes():
    assert parse_duration("10m") == 600000


def test_parse_duration_millisecond_unit():
    assert parse_duration("250ms") == 250


def test_parse_duration_fractional():
    assert parse_duration("1.5s") == 1500


def test_parse_duration_bare_number_is_milliseconds():
    assert parse_duration("90") == 90


def test_parse_duration_case_and_spaces():
    assert parse_duration("2 H") == 7200000


def test_format_size():
    assert format_size(1536) == "1.5 KB"
    assert format_size(2 * 1024 ** 2) == "2 MB"
    with pytest.raises(ValueError):
        format_size(-1)


def test_format_duration():
    assert format_duration(90061001) == "1d 1h 1m 1s 1ms"
    assert format_duration(0) == "0ms"
