from src.clean import clean
from src.enrich import enrich
from src.load import parse_rows
from src.totals import by_label, grand_total, ranked

from tests.test_load import RAW


def records():
    return enrich(clean(parse_rows(RAW)))


def test_by_label():
    assert by_label(records()) == {"Gadgets": 44.48, "Parts": 2.5, "Tools": 12.0}


def test_ranked_order():
    assert [label for label, _ in ranked(records())] == ["Gadgets", "Tools", "Parts"]


def test_ranked_values():
    assert ranked(records()) == [("Gadgets", 44.48), ("Tools", 12.0), ("Parts", 2.5)]


def test_grand_total():
    assert grand_total(records()) == 58.98


def test_ranked_empty():
    assert ranked([]) == []
    assert grand_total([]) == 0.0
