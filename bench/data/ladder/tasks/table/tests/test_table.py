from src.table import column_widths, csv_line, render, render_dicts


def test_column_widths_and_basic_render():
    assert column_widths([["a", "bb"], ["ccc"]]) == [3, 2]
    assert render([["a", "bb"], ["ccc", "d"]]) == "a   | bb\nccc | d "


def test_render_header_rule():
    assert render([["x", "1"]], header=["name", "n"]) == "name | n\n---- | -\nx    | 1"


def test_render_right_align():
    assert render([["a", "1"], ["b", "22"]], right=(1,)) == "a |  1\nb | 22"


def test_render_fill_character():
    assert render([["a", "bb"], ["ccc", "d"]], fill=".") == "a.. | bb\nccc | d."


def test_render_dicts_with_fill_and_csv_line():
    out = render_dicts([{"name": "ab", "n": "1"}], ["name", "n"], fill="_")
    assert out == "name | n\n---- | -\nab__ | 1"
    assert csv_line(["a", "b,c", 'say "hi"']) == 'a,"b,c","say ""hi"""'
