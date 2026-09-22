import pytest

from src.bucket import TokenBucket


def bucket(capacity=10.0, rate=2.0, tokens=10.0, at=0.0):
    return TokenBucket(capacity=capacity, refill_per_second=rate, tokens=tokens, updated_at=at)


def test_level_reports_the_current_tokens():
    assert bucket(tokens=4.0).level(0.0) == 4.0


def test_sync_accrues_at_the_rate():
    b = bucket(tokens=0.0)
    b.sync(3.0)
    assert b.tokens == 6.0
    assert b.updated_at == 3.0


def test_sync_never_exceeds_the_capacity():
    assert bucket(tokens=0.0).level(100.0) == 10.0


def test_sync_rejects_a_backwards_clock():
    b = bucket(at=5.0)
    with pytest.raises(ValueError):
        b.sync(4.0)


def test_wait_for_is_zero_when_the_tokens_are_there():
    assert bucket(tokens=3.0).wait_for(3.0, 0.0) == 0.0


def test_wait_for_counts_the_shortfall():
    assert bucket(tokens=1.0).wait_for(5.0, 0.0) == 2.0


def test_wait_for_a_whole_capacity_request_is_finite():
    # a bucket of ten can hold ten, so asking for ten is a wait, never a refusal
    assert bucket(tokens=0.0).wait_for(10.0, 0.0) == 5.0


def test_wait_for_above_the_capacity_never_ends():
    # twelve tokens will never sit in a bucket that holds ten
    assert bucket(tokens=0.0).wait_for(12.0, 0.0) is None


def test_wait_for_a_bucket_that_never_refills():
    assert bucket(rate=0.0, tokens=1.0).wait_for(2.0, 0.0) is None
    assert bucket(rate=0.0, tokens=2.0).wait_for(2.0, 0.0) == 0.0


def test_spend_takes_the_tokens():
    b = bucket(tokens=4.0)
    b.spend(1.5)
    assert b.tokens == 2.5
