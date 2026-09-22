from src.text import numbered, to_lines, to_text


def test_to_lines_drops_only_the_final_newline():
    assert to_lines("a\nb\n") == ["a", "b"]
    assert to_lines("a\nb") == ["a", "b"]
    assert to_lines("a\n\n") == ["a", ""]


def test_to_lines_of_nothing():
    assert to_lines("") == []


def test_to_text_ends_a_file_with_a_newline():
    assert to_text(["a", "b"]) == "a\nb\n"
    assert to_text([]) == ""


def test_numbered_counts_from_one():
    assert numbered(["a", "b"]) == [(1, "a"), (2, "b")]
    assert numbered([]) == []
