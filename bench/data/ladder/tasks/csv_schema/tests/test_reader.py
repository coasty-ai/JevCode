from src.reader import read, split_line

TEXT = """# an export
name, qty , price

ann,2,1.50
bob,3,2.25
"""


def test_split_line_strips_every_cell():
    assert split_line(" a , b,c ") == ["a", "b", "c"]
    assert split_line("") == [""]


def test_read_splits_the_header_from_the_rows():
    header, rows = read(TEXT)
    assert header == ["name", "qty", "price"]
    assert rows == [["ann", "2", "1.50"], ["bob", "3", "2.25"]]


def test_read_drops_blank_and_commented_lines():
    header, rows = read("# c\n\na,b\n  # c2\n1,2\n")
    assert header == ["a", "b"]
    assert rows == [["1", "2"]]


def test_a_ragged_row_keeps_every_cell():
    # lining rows up with the header is the schema's job, never the reader's
    _, rows = read("a,b\n1,2,3\n4\n")
    assert rows == [["1", "2", "3"], ["4"]]


def test_read_of_nothing():
    assert read("") == ([], [])
    assert read("\n# only a comment\n") == ([], [])
