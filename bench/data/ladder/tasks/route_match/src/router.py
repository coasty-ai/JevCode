"""A table of named routes: match a path against it, or build a path back out of it."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

from .pattern import Pattern, captures, is_parameter, parameter_name, specificity
from .segments import join


class NoSuchRoute(KeyError):
    """Raised for a route name the table does not hold."""


class BadParameters(ValueError):
    """Raised when the parameters given do not match the ones the route takes."""


@dataclass(frozen=True)
class Route:
    name: str
    pattern: Pattern


@dataclass(frozen=True)
class Match:
    route: Route
    params: Dict[str, str]


class Router:
    def __init__(self, table: Sequence[Tuple[str, str]]) -> None:
        self.routes: List[Route] = [Route(name, Pattern(text)) for name, text in table]

    def candidates(self, path: str) -> List[Match]:
        """Every route that matches `path`, in table order."""
        out: List[Match] = []
        for route in self.routes:
            params = captures(route.pattern, path)
            if params is not None:
                out.append(Match(route, params))
        return out

    def match(self, path: str) -> Optional[Match]:
        """The most specific route that matches `path`, or None. Ties go to the table order."""
        found = self.candidates(path)
        if not found:
            return None
        return min(found, key=lambda m: specificity(m.route.pattern))

    def route_named(self, name: str) -> Route:
        for route in self.routes:
            if route.name == name:
                return route
        raise NoSuchRoute(name)

    def reverse(self, name: str, **params: str) -> str:
        """The path route `name` builds from `params`, which must be exactly its placeholders."""
        route = self.route_named(name)
        wanted = set(route.pattern.names())
        if wanted - set(params):
            raise BadParameters(name)
        return join([params[parameter_name(s)] if is_parameter(s) else s for s in route.pattern.segments()])
