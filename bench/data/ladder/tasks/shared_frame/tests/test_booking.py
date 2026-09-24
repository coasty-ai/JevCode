import pytest

from src.booking import Event, is_sold_out, release, reserve
from src.checks import InvalidValue


def test_reserve_some_seats():
    ev = Event("Gala", 10)
    assert reserve(ev, "ann", 4) == 6
    assert ev.reserved == 4 and ev.holders == ["ann"]


def test_reserve_last_seats():
    ev = Event("Gala", 10, reserved=7)
    assert reserve(ev, "bob", 3) == 0
    assert ev.available == 0


def test_sold_out_after_full_reservation():
    ev = Event("Gala", 2)
    reserve(ev, "ann", 2)
    assert is_sold_out(ev)


def test_reserve_too_many_raises_and_leaves_event_unchanged():
    ev = Event("Gala", 3, reserved=1)
    with pytest.raises(InvalidValue):
        reserve(ev, "ann", 3)
    assert ev.reserved == 1 and ev.holders == []


def test_reserve_zero_raises():
    with pytest.raises(InvalidValue):
        reserve(Event("Gala", 3), "ann", 0)


def test_release():
    ev = Event("Gala", 5, reserved=4, holders=["ann"])
    assert release(ev, "ann", 2) == 3
    assert ev.holders == []


def test_release_more_than_reserved_raises():
    with pytest.raises(InvalidValue):
        release(Event("Gala", 5, reserved=1), "ann", 2)


def test_not_sold_out():
    assert not is_sold_out(Event("Gala", 1))
