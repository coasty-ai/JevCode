"""Turning a wish list into rounds of installs."""

from __future__ import annotations

from typing import List, Sequence

from .graph import Graph
from .layers import layers


def check(graph: Graph, wanted: Sequence[str], installed: Sequence[str] = ()) -> List[str]:
    """Every name the graph has never heard of, the wanted ones before the installed ones."""
    known = set(graph.names())
    return ["unknown: %s" % name for name in wanted if name not in known]


def needed(graph: Graph, wanted: Sequence[str], installed: Sequence[str] = ()) -> List[str]:
    """Everything `wanted` needs that is not installed yet, sorted."""
    return sorted(graph.closure(wanted) - set(installed))


def plan(graph: Graph, wanted: Sequence[str], installed: Sequence[str] = ()) -> List[List[str]]:
    """The install rounds for `wanted`; everything inside a round can go in parallel."""
    return layers(graph, needed(graph, wanted, installed))
