from src.clean import clean
from src.enrich import enrich
from src.load import parse_rows
from src.report import line_count, report
from src.totals import grand_total, ranked

from tests.test_load import RAW

EXPECTED = """Sales by category
====================
Gadgets        44.48
Tools          12.00
Parts           2.50
--------------------
Total          58.98"""


def text():
    records = enrich(clean(parse_rows(RAW)))
    return report(ranked(records), grand_total(records))


def test_report_text():
    assert text() == EXPECTED


def test_report_lines():
    lines = text().split("\n")
    assert lines[0] == "Sales by category"
    assert lines[-1] == "Total          58.98"
    assert len(lines) == 7


def test_line_count():
    assert line_count("a\nb\nc") == 3
    assert line_count("") == 0
