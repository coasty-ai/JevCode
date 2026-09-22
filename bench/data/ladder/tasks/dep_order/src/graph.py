"""A package graph: which package requires which. Acyclic by construction."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Mapping, Sequence, Set, Tuple


class UnknownPackage(KeyError):
    """Raised for a name the graph has never heard of."""


@dataclass(frozen=True)
class Package:
    name: str
    requires: Tuple[str, ...] = ()


class Graph:
    def __init__(self, packages: Sequence[Package]) -> None:
        self._packages: Dict[str, Package] = {p.name: p for p in packages}

    @classmethod
    def of(cls, table: Mapping[str, Sequence[str]]) -> "Graph":
        return cls([Package(name, tuple(requires)) for name, requires in table.items()])

    def names(self) -> List[str]:
        return sorted(self._packages)

    def package(self, name: str) -> Package:
        if name not in self._packages:
            raise UnknownPackage(name)
        return self._packages[name]

    def requires(self, name: str) -> List[str]:
        """What `name` directly needs, in the order it was declared."""
        return list(self.package(name).requires)

    def dependents(self, name: str) -> List[str]:
        """Every package that directly requires `name`, sorted."""
        self.package(name)
        return sorted(p.name for p in self._packages.values() if name in p.requires)

    def closure(self, roots: Sequence[str]) -> Set[str]:
        """`roots` together with everything they need, directly or through others."""
        out: Set[str] = set()
        stack = list(roots)
        while stack:
            name = stack.pop()
            if name in out:
                continue
            out.add(name)
            stack.extend(self.requires(name))
        return out
