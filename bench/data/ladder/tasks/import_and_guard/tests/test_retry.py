import pytest

from src.retry import backoff, schedule, should_retry, total_wait


def test_backoff_doubles_and_caps():
    assert [backoff(n) for n in (1, 2, 3, 4, 5, 6)] == [0.5, 1.0, 2.0, 4.0, 8.0, 8.0]


def test_backoff_rejects_attempt_zero():
    with pytest.raises(ValueError):
        backoff(0)


def test_schedule_has_one_delay_between_attempts():
    assert schedule(4) == [0.5, 1.0, 2.0]


def test_schedule_single_attempt_has_no_delay():
    assert schedule(1) == []


def test_total_wait():
    assert total_wait(4) == 3.5
    assert total_wait(3, base=1.0, cap=1.5) == 2.5


def test_should_retry():
    assert should_retry(503, 1)
    assert should_retry(429, 2)
    assert not should_retry(404, 1)
    assert not should_retry(503, 3)
