from datetime import date

import pytest

from src.cells import cast, cell_type, is_blank, widen


def test_is_blank():
    assert is_blank("") is True
    assert is_blank("   ") is True
    assert is_blank(" x ") is False


def test_cell_type_reads_numbers():
    assert cell_type("12") == "int"
    assert cell_type(" -3 ") == "int"
    assert cell_type("1.5") == "float"
    assert cell_type("1e3") == "float"


def test_cell_type_reads_bools_and_dates():
    assert cell_type("true") == "bool"
    assert cell_type("NO") == "bool"
    assert cell_type("2026-01-05") == "date"


def test_cell_type_falls_back_to_text():
    assert cell_type("ann") == "str"
    assert cell_type("2026-13-40") == "str"


def test_cast_to_each_kind():
    assert cast("int", " 7 ") == 7
    assert cast("float", "1.5") == 1.5
    assert cast("bool", "Yes") is True
    assert cast("date", "2026-01-05") == date(2026, 1, 5)
    assert cast("str", " x ") == "x"


def test_cast_of_a_value_that_does_not_read_as_the_kind():
    assert cast("int", "x") is None
    assert cast("date", "nope") is None


def test_cast_refuses_an_unknown_kind():
    with pytest.raises(KeyError):
        cast("decimal", "1")


def test_widen_of_two_equal_kinds():
    for kind in ("int", "float", "bool", "date", "str"):
        assert widen(kind, kind) == kind


def test_widen_keeps_the_kind_that_holds_the_other():
    assert widen("int", "float") == "float"
    assert widen("float", "int") == "float"
    assert widen("int", "str") == "str"
    assert widen("str", "float") == "str"


def test_widen_of_kinds_off_the_chain_is_text():
    assert widen("bool", "int") == "str"
    assert widen("date", "str") == "str"
    assert widen("bool", "date") == "str"
