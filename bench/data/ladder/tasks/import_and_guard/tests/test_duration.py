from src.duration import format_duration, parse_duration


def test_parse_bare_seconds():
    assert parse_duration("45") == 45
    assert parse_duration(" 0 ") == 0


def test_parse_units():
    assert parse_duration("2m") == 120
    assert parse_duration("1h30m") == 5400
    assert parse_duration("1d 2h") == 93600


def test_parse_is_case_insensitive():
    assert parse_duration("1H") == 3600


def test_format_duration():
    assert format_duration(5400) == "1h30m"
    assert format_duration(0) == "0s"
    assert format_duration(86401) == "1d1s"


def test_round_trip():
    for text in ("3d", "4h5m6s", "1m30s"):
        assert format_duration(parse_duration(text)) == text
