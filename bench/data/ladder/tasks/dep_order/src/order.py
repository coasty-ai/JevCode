"""Install rounds, numbered from one, and the flat order they imply."""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence

from .graph import Graph
from .layers import depth, layers

#: rounds are what an operator reads off a console, so they are counted from one
FIRST_ROUND = 1


def round_number(graph: Graph, name: str) -> int:
    """Which install round `name` goes in. The shallowest packages go in round 1."""
    return depth(graph, name)


def schedule(graph: Graph) -> Dict[str, int]:
    """Every package mapped to its round."""
    return {name: round_number(graph, name) for name in graph.names()}


def max_rounds(graph: Graph) -> int:
    """How many rounds installing the whole graph takes."""
    return max((round_number(graph, name) for name in graph.names()), default=0)


def install_order(graph: Graph, names: Optional[Sequence[str]] = None) -> List[str]:
    """A flat order in which nothing comes before something it requires."""
    return [name for layer in layers(graph, names) for name in layer]


def parallel_width(graph: Graph) -> int:
    """The largest number of packages any one round installs."""
    return max((len(layer) for layer in layers(graph)), default=0)
