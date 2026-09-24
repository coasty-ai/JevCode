"""Argument validation shared by the booking and pricing modules."""

from __future__ import annotations

from typing import Sized, Tuple


class InvalidValue(ValueError):
    """Raised when a caller passes a value outside its allowed range."""


def ensure_at_least(value: int, minimum: int, name: str) -> int:
    """Return `value` when it is at least `minimum`, else raise InvalidValue."""
    if value < minimum:
        raise InvalidValue(f"{name} must be at least {minimum}, got {value}")
    return value


def ensure_at_most(value: int, maximum: int, name: str) -> int:
    """Return `value` when it is at most `maximum`, else raise InvalidValue."""
    if value > maximum:
        raise InvalidValue(f"{name} must be at most {maximum}, got {value}")
    return value


def ensure_non_empty(items: Sized, name: str) -> Sized:
    if len(items) == 0:
        raise InvalidValue(f"{name} must not be empty")
    return items


def ensure_one_of(value: str, allowed: Tuple[str, ...], name: str) -> str:
    if value not in allowed:
        raise InvalidValue(f"{name} must be one of {', '.join(allowed)}, got {value!r}")
    return value
