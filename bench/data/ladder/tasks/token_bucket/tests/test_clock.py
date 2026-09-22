import pytest

from src.clock import SECONDS_PER_MINUTE, Clock, per_second


def test_per_second_converts_a_per_minute_rate():
    assert per_second(60.0) == 1.0
    assert per_second(30.0) == 0.5
    assert SECONDS_PER_MINUTE == 60.0


def test_clock_advances():
    clock = Clock()
    assert clock.now() == 0.0
    assert clock.advance(2.5) == 2.5
    assert clock.now() == 2.5


def test_clock_starts_where_it_is_told():
    assert Clock(7.5).now() == 7.5


def test_clock_refuses_to_run_backwards():
    with pytest.raises(ValueError):
        Clock().advance(-1.0)
