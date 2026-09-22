from src.reader import read
from src.schema import Column, Schema, coerce, infer_schema, validate

TEXT = """name,qty,score,active,joined,note
ann,2,1.5,true,2026-01-05,hi
bob,3,2,false,2026-02-01,
"""

SCHEMA = Schema([Column("name", "str", False), Column("qty", "int", False), Column("score", "float", True)])


def test_schema_lists_its_names_and_kinds():
    assert SCHEMA.names() == ["name", "qty", "score"]
    assert SCHEMA.kinds() == ["str", "int", "float"]


def test_infer_schema_names_the_columns():
    header, rows = read(TEXT)
    assert infer_schema(header, rows).names() == ["name", "qty", "score", "active", "joined", "note"]


def test_infer_schema_types_each_column():
    header, rows = read(TEXT)
    assert infer_schema(header, rows).kinds() == ["str", "int", "float", "bool", "date", "str"]


def test_infer_schema_marks_the_column_with_a_blank():
    header, rows = read(TEXT)
    assert [column.nullable for column in infer_schema(header, rows).columns] == [False, False, False, False, False, True]


def test_validate_accepts_a_good_row():
    assert validate(SCHEMA, ["ann", "2", "1.5"]) == []


def test_validate_reports_a_short_row():
    assert validate(SCHEMA, ["ann", "2"]) == ["row of 2, want 3"]
    assert validate(SCHEMA, []) == ["row of 0, want 3"]


def test_validate_reports_a_row_with_a_spare_cell():
    assert validate(SCHEMA, ["ann", "2", "1.5", "x"]) == ["row of 4, want 3"]


def test_a_cell_count_problem_hides_the_rest():
    # the columns do not line up, so nothing per-column is reported
    assert validate(SCHEMA, ["", "x", "y", "z"]) == ["row of 4, want 3"]


def test_validate_reports_a_blank_in_a_required_column():
    assert validate(SCHEMA, ["", "2", "1.5"]) == ["name: blank"]


def test_validate_allows_a_blank_in_a_nullable_column():
    assert validate(SCHEMA, ["ann", "2", " "]) == []


def test_validate_reports_a_value_of_the_wrong_kind():
    assert validate(SCHEMA, ["ann", "x", "y"]) == ["qty: not int", "score: not float"]


def test_validate_reports_every_problem_in_column_order():
    assert validate(SCHEMA, ["", "x", "z"]) == ["name: blank", "qty: not int", "score: not float"]


def test_coerce_casts_every_cell():
    assert coerce(SCHEMA, ["ann", "2", "1.5"]) == ["ann", 2, 1.5]


def test_coerce_turns_blanks_into_none():
    assert coerce(SCHEMA, ["ann", "2", " "]) == ["ann", 2, None]
