from src.report import render, summary

LOG = "INFO start 12ms\nWARN disk almost full 250ms\nINFO done 30ms"
LOG_PLAIN = "INFO start\nWARN disk almost full\n\nERROR crashed\nINFO done\n"


def test_summary_empty():
    assert summary("") == {"entries": 0, "levels": {}, "total_ms": 0, "slowest": []}


def test_summary_counts_levels():
    s = summary(LOG_PLAIN)
    assert s["entries"] == 4
    assert s["levels"] == {"INFO": 2, "WARN": 1, "ERROR": 1}


def test_summary_plain_lines_have_no_duration():
    s = summary(LOG_PLAIN, top=2)
    assert s["total_ms"] == 0
    assert s["slowest"] == ["start", "disk almost full"]


def test_summary_total_and_slowest():
    s = summary(LOG, top=2)
    assert s["total_ms"] == 292
    assert s["slowest"] == ["disk almost full", "done"]


def test_render_empty():
    assert render("") == "total: 0ms"


def test_render_full():
    assert render(LOG, top=1) == "INFO: 2\nWARN: 1\ntotal: 292ms\nslow: disk almost full"
