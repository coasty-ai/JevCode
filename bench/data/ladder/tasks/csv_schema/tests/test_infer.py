from src.infer import column_is_nullable, column_type


def test_an_int_column():
    assert column_type(["1", "2", "-30"]) == "int"


def test_a_float_column():
    assert column_type(["1.5", "2.5"]) == "float"


def test_a_text_column():
    assert column_type(["ann", "bob"]) == "str"


def test_a_bool_column():
    assert column_type(["true", "no", "YES"]) == "bool"


def test_a_date_column():
    assert column_type(["2026-01-05", "2026-02-01"]) == "date"


def test_ints_beside_decimals_make_the_column_float():
    assert column_type(["1", "2", "2.5"]) == "float"
    assert column_type(["2.5", "1"]) == "float"


def test_one_word_makes_the_whole_column_text():
    assert column_type(["1", "2", "x"]) == "str"
    assert column_type(["true", "1"]) == "str"


def test_blanks_are_ignored_when_typing():
    assert column_type(["1", "", "  ", "2"]) == "int"


def test_a_column_of_nothing_but_blanks_is_text():
    assert column_type(["", "   "]) == "str"
    assert column_type([]) == "str"


def test_column_is_nullable():
    assert column_is_nullable(["1", "", "2"]) is True
    assert column_is_nullable(["1", "2"]) is False
    assert column_is_nullable([]) is False
