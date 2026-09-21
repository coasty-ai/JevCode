from src.load import Row, count_lines, parse_rows

RAW = " widget ,gadget,2,9.99\nGizmo,GADGET,1,24.50\n\nbolt,part,10,0.25\nhammer , tool ,1,12.00\n"


def test_parse_rows_count():
    assert len(parse_rows(RAW)) == 4


def test_parse_row_fields():
    first = parse_rows(RAW)[0]
    assert first == Row(" widget ", "gadget", 2, 9.99)
    assert parse_rows(RAW)[2].qty == 10


def test_parse_rows_skips_blank_lines():
    assert [row.name for row in parse_rows(RAW)] == [" widget ", "Gizmo", "bolt", "hammer "]


def test_parse_rows_empty():
    assert parse_rows("") == []
    assert parse_rows("\n\n") == []


def test_count_lines():
    assert count_lines(RAW) == 4
    assert count_lines("") == 0
