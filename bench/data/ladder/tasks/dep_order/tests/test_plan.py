import pytest

from src.graph import Graph, UnknownPackage
from src.plan import check, needed, plan

GRAPH = Graph.of(
    {
        "app": ["web", "db"],
        "web": ["http", "json"],
        "db": ["json"],
        "http": ["socket"],
        "json": [],
        "socket": [],
        "tool": [],
    }
)


def test_check_accepts_a_known_wish_list():
    assert check(GRAPH, ["app", "tool"], ["json"]) == []
    assert check(GRAPH, []) == []


def test_check_reports_an_unknown_wanted_package():
    assert check(GRAPH, ["app", "ghost"]) == ["unknown: ghost"]


def test_check_reports_an_unknown_installed_package():
    assert check(GRAPH, ["app"], ["phantom"]) == ["unknown: phantom"]


def test_check_reports_the_wanted_ones_before_the_installed_ones():
    assert check(GRAPH, ["ghost"], ["phantom"]) == ["unknown: ghost", "unknown: phantom"]


def test_needed_is_the_closure_of_the_wish_list():
    assert needed(GRAPH, ["db"]) == ["db", "json"]
    assert needed(GRAPH, ["app"]) == ["app", "db", "http", "json", "socket", "web"]


def test_needed_drops_what_is_already_installed():
    assert needed(GRAPH, ["app"], ["json", "socket", "http"]) == ["app", "db", "web"]
    assert needed(GRAPH, ["db"], ["db", "json"]) == []


def test_plan_puts_the_wish_list_into_rounds():
    assert plan(GRAPH, ["app"]) == [["json", "socket"], ["db", "http"], ["web"], ["app"]]


def test_plan_of_a_partly_installed_tree():
    assert plan(GRAPH, ["app"], ["json", "socket", "http"]) == [["db"], ["web"], ["app"]]


def test_plan_of_an_unknown_package_is_refused():
    with pytest.raises(UnknownPackage):
        plan(GRAPH, ["ghost"])
