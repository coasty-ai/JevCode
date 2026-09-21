from src.clean import clean
from src.enrich import enrich
from src.layout import amount, numbered, rows, rule
from src.load import parse_rows
from src.totals import ranked

from tests.test_load import RAW


def lines():
    return rows(ranked(enrich(clean(parse_rows(RAW)))))


def test_rows():
    assert lines() == ["Gadgets        44.48", "Tools          12.00", "Parts           2.50"]


def test_rows_widths():
    assert all(len(line) == 20 for line in lines())
    assert len(lines()) == 3


def test_amount():
    assert amount(1234.5) == "  1,234.50"
    assert amount(0) == "      0.00"


def test_numbered_and_rule():
    assert numbered(["a", "b"]) == ["1. a", "2. b"]
    assert rule() == "-" * 20
    assert rule("=") == "=" * 20
