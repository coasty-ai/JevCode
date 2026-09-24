import pytest

from src.limiter import Limiter


def test_a_fresh_key_is_allowed():
    assert Limiter("free").allow("a", 0.0) is True


def test_the_burst_is_spent_then_denied():
    lim = Limiter("free")
    assert [lim.allow("a", 0.0) for _ in range(5)] == [True, True, True, True, True]
    assert lim.allow("a", 0.0) is False


def test_keys_are_limited_separately():
    lim = Limiter("free")
    for _ in range(5):
        lim.allow("a", 0.0)
    assert lim.allow("b", 0.0) is True
    assert lim.keys() == ["a", "b"]


def test_a_request_above_the_burst_is_denied():
    # nine at once will never fit a burst of five, however long the caller waits
    assert Limiter("free").allow("a", 0.0, cost=9.0) is False


def test_retry_after_above_the_burst_never_ends():
    assert Limiter("free").retry_after("a", 0.0, cost=9.0) is None


def test_a_batch_quota_is_denied_once_it_is_spent():
    lim = Limiter("batch")
    assert [lim.allow("a", 0.0) for _ in range(3)] == [True, True, True]
    assert lim.allow("a", 0.0) is False
    assert lim.allow("a", 600.0) is False


def test_a_batch_quota_has_no_retry_time():
    lim = Limiter("batch")
    for _ in range(3):
        lim.allow("a", 0.0)
    assert lim.retry_after("a", 0.0) is None


def test_the_bucket_refills_over_a_minute():
    lim = Limiter("free")
    for _ in range(5):
        lim.allow("a", 0.0)
    assert lim.allow("a", 0.5) is False
    assert lim.allow("a", 2.0) is True
    assert lim.allow("a", 2.0) is True
    assert lim.allow("a", 2.0) is False


def test_retry_after_is_the_shortfall_in_seconds():
    lim = Limiter("free")
    for _ in range(5):
        lim.allow("a", 0.0)
    assert lim.retry_after("a", 0.0) == 1.0
    assert lim.retry_after("a", 0.0, cost=3.0) == 3.0


def test_a_later_start_delays_the_first_refill():
    lim = Limiter("free", start=10.0)
    for _ in range(5):
        lim.allow("a", 10.0)
    assert lim.allow("a", 10.5) is False
    assert lim.allow("a", 11.0) is True


def test_level_reports_what_is_left():
    lim = Limiter("pro")
    lim.allow("a", 0.0, cost=4.0)
    assert lim.level("a", 0.0) == 16.0


def test_an_unknown_policy_is_refused():
    with pytest.raises(KeyError):
        Limiter("enterprise")
