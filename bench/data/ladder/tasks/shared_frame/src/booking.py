"""Seat reservations for an event."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

from .checks import ensure_at_least, ensure_at_most


@dataclass
class Event:
    name: str
    capacity: int
    reserved: int = 0
    holders: List[str] = field(default_factory=list)

    @property
    def available(self) -> int:
        return self.capacity - self.reserved


def reserve(event: Event, holder: str, seats: int) -> int:
    """Reserve `seats` for `holder`: the last seats may be taken, oversubscription may not.

    Returns the number of seats left after the reservation.
    """
    ensure_at_least(seats, 1, "seats")
    remaining = ensure_at_least(event.available - seats, 1, "remaining seats")
    event.reserved += seats
    event.holders.append(holder)
    return remaining


def release(event: Event, holder: str, seats: int) -> int:
    """Give `seats` back; returns the seats available afterwards."""
    ensure_at_least(seats, 1, "seats")
    ensure_at_most(seats, event.reserved, "seats")
    event.reserved -= seats
    if holder in event.holders:
        event.holders.remove(holder)
    return event.available


def is_sold_out(event: Event) -> bool:
    return event.available == 0
