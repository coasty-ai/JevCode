"""How deep each package sits, and the groups that can be installed together."""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence

from .graph import Graph


def depth(graph: Graph, name: str, memo: Optional[Dict[str, int]] = None) -> int:
    """How many packages deep `name` sits.

    A package that requires nothing is at depth 0; anything else is one deeper than the
    deepest thing it requires.
    """
    if memo is None:
        memo = {}
    if name in memo:
        return memo[name]
    requirements = graph.requires(name)
    memo[name] = 1 + max((depth(graph, r, memo) for r in requirements), default=0)
    return memo[name]


def layers(graph: Graph, names: Optional[Sequence[str]] = None) -> List[List[str]]:
    """The chosen packages grouped by depth, shallowest group first.

    Everything inside a group can be installed at the same time; each group needs the
    groups before it to be done.
    """
    chosen = graph.names() if names is None else sorted(set(names))
    memo: Dict[str, int] = {}
    buckets: Dict[int, List[str]] = {}
    for name in chosen:
        buckets.setdefault(depth(graph, name, memo), []).append(name)
    return [sorted(buckets[key]) for key in sorted(buckets)]
