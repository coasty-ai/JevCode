from src.clean import clean
from src.enrich import enrich, is_known, known_kinds
from src.load import Row, parse_rows

from tests.test_load import RAW


def records():
    return enrich(clean(parse_rows(RAW)))


def test_enrich_labels():
    assert [rec.label for rec in records()] == ["Gadgets", "Gadgets", "Parts", "Tools"]


def test_enrich_totals():
    assert [rec.total for rec in records()] == [19.98, 24.5, 2.5, 12.0]


def test_known_kinds():
    assert known_kinds() == ["gadget", "part", "tool"]


def test_enrich_empty():
    assert enrich([]) == []


def test_is_known():
    assert is_known(Row("bolt", "part", 1, 0.25))
    assert not is_known(Row("odd", "misc", 1, 0.25))
