from src.graph import Graph
from src.layers import depth, layers

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


def test_a_package_that_requires_nothing_is_at_depth_zero():
    assert depth(GRAPH, "json") == 0
    assert depth(GRAPH, "socket") == 0


def test_an_isolated_package_is_at_depth_zero_too():
    assert depth(GRAPH, "tool") == 0


def test_depth_is_one_more_than_the_deepest_requirement():
    assert depth(GRAPH, "http") == 1
    assert depth(GRAPH, "db") == 1
    assert depth(GRAPH, "web") == 2


def test_depth_follows_the_longest_chain_not_the_shortest():
    # app needs db (depth 1) and web (depth 2), so app is three deep
    assert depth(GRAPH, "app") == 3


def test_layers_group_the_whole_graph_by_depth():
    assert layers(GRAPH) == [["json", "socket", "tool"], ["db", "http"], ["web"], ["app"]]


def test_layers_of_a_chosen_subset():
    assert layers(GRAPH, ["app", "json", "db"]) == [["json"], ["db"], ["app"]]


def test_layers_of_a_duplicated_subset():
    assert layers(GRAPH, ["json", "json", "socket"]) == [["json", "socket"]]


def test_layers_of_nothing():
    assert layers(GRAPH, []) == []
