from src.parse import Entry, only, parse_line, parse_lines


def test_parse_line_without_duration():
    assert parse_line("ERROR crashed") == Entry("ERROR", "crashed", 0)
    assert parse_line("INFO took 5 seconds") == Entry("INFO", "took 5 seconds", 0)


def test_parse_line_strips_whitespace():
    assert parse_line("  DEBUG tick \n") == Entry("DEBUG", "tick", 0)


def test_parse_lines_one_per_line():
    text = "INFO a\nWARN b\nERROR c"
    assert [e.level for e in parse_lines(text)] == ["INFO", "WARN", "ERROR"]


def test_parse_lines_skips_blank_lines():
    assert [e.msg for e in parse_lines("INFO a\n\nWARN b\n")] == ["a", "b"]


def test_parse_lines_empty_text():
    assert parse_lines("") == []


def test_only():
    entries = parse_lines("INFO a\nWARN b\nINFO c")
    assert [e.msg for e in only(entries, "INFO")] == ["a", "c"]
