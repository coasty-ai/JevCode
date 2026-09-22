import pytest

from src.graph import Graph, UnknownPackage

TABLE = {
    "app": ["web", "db"],
    "web": ["http", "json"],
    "db": ["json"],
    "http": ["socket"],
    "json": [],
    "socket": [],
    "tool": [],
}
GRAPH = Graph.of(TABLE)


def test_names_are_sorted():
    assert GRAPH.names() == ["app", "db", "http", "json", "socket", "tool", "web"]


def test_requires_keeps_the_declared_order():
    assert GRAPH.requires("app") == ["web", "db"]
    assert GRAPH.requires("json") == []


def test_an_unknown_package_is_refused():
    with pytest.raises(UnknownPackage):
        GRAPH.requires("ghost")
    with pytest.raises(UnknownPackage):
        GRAPH.dependents("ghost")


def test_dependents_are_the_reverse_edges():
    assert GRAPH.dependents("json") == ["db", "web"]
    assert GRAPH.dependents("socket") == ["http"]
    assert GRAPH.dependents("app") == []


def test_closure_holds_the_roots_as_well():
    assert GRAPH.closure(["json"]) == {"json"}
    assert GRAPH.closure(["db"]) == {"db", "json"}


def test_closure_of_a_whole_tree():
    assert GRAPH.closure(["app"]) == {"app", "web", "db", "http", "json", "socket"}


def test_closure_of_several_roots_and_of_none():
    assert GRAPH.closure(["db", "tool"]) == {"db", "json", "tool"}
    assert GRAPH.closure([]) == set()


def test_package_carries_its_requirements():
    assert GRAPH.package("web").requires == ("http", "json")
