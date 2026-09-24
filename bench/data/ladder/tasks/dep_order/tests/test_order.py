from src.graph import Graph
from src.order import install_order, max_rounds, parallel_width, round_number, schedule

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


def test_the_shallowest_packages_go_in_round_one():
    assert round_number(GRAPH, "json") == 1
    assert round_number(GRAPH, "socket") == 1
    assert round_number(GRAPH, "tool") == 1


def test_a_round_per_step_down_the_chain():
    assert round_number(GRAPH, "http") == 2
    assert round_number(GRAPH, "web") == 3
    assert round_number(GRAPH, "app") == 4


def test_the_schedule_numbers_every_package():
    assert schedule(GRAPH) == {"app": 4, "db": 2, "http": 2, "json": 1, "socket": 1, "tool": 1, "web": 3}


def test_max_rounds_counts_the_rounds():
    assert max_rounds(GRAPH) == 4
    assert max_rounds(Graph.of({"a": []})) == 1
    assert max_rounds(Graph.of({})) == 0


def test_install_order_never_puts_a_package_before_what_it_requires():
    order = install_order(GRAPH)
    assert order == ["json", "socket", "tool", "db", "http", "web", "app"]
    for name in GRAPH.names():
        for requirement in GRAPH.requires(name):
            assert order.index(requirement) < order.index(name)


def test_install_order_of_a_subset():
    assert install_order(GRAPH, ["app", "web", "json"]) == ["json", "web", "app"]


def test_parallel_width_is_the_widest_round():
    assert parallel_width(GRAPH) == 3
    assert parallel_width(Graph.of({"a": ["b"], "b": []})) == 1
