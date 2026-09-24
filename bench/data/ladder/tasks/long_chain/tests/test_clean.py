from src.clean import clean, names
from src.load import parse_rows

from tests.test_load import RAW


def cleaned():
    return clean(parse_rows(RAW))


def test_clean_names_title_cased():
    assert names(cleaned()) == ["Widget", "Gizmo", "Bolt", "Hammer"]


def test_clean_kinds_lower():
    assert [row.kind for row in cleaned()] == ["gadget", "gadget", "part", "tool"]


def test_clean_keeps_numbers():
    assert [(row.qty, row.price) for row in cleaned()] == [(2, 9.99), (1, 24.5), (10, 0.25), (1, 12.0)]


def test_clean_empty():
    assert clean([]) == []
    assert names([]) == []
