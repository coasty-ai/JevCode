import pytest

from src.clock import SECONDS_PER_MINUTE
from src.policy import POLICIES, Policy, bucket_for, policy_named


def test_the_policy_table_is_written_in_requests_per_minute():
    assert POLICIES["free"].per_minute == 60.0
    assert POLICIES["pro"].per_minute == 600.0
    assert POLICIES["batch"].per_minute == 0.0


def test_the_policy_table_bursts():
    assert [POLICIES[name].burst for name in ("batch", "free", "pro")] == [3.0, 5.0, 20.0]


def test_refill_rate_is_the_per_minute_rate_spread_over_a_minute():
    assert Policy("x", per_minute=120.0, burst=1.0).refill_rate == 120.0 / SECONDS_PER_MINUTE
    assert POLICIES["free"].refill_rate == 1.0


def test_bucket_for_starts_full_at_the_burst():
    b = bucket_for(POLICIES["pro"], 0.0)
    assert (b.capacity, b.tokens, b.updated_at) == (20.0, 20.0, 0.0)


def test_bucket_for_refills_at_the_policy_rate():
    assert bucket_for(POLICIES["free"], 0.0).refill_per_second == 1.0
    assert bucket_for(POLICIES["pro"], 0.0).refill_per_second == 10.0


def test_a_batch_bucket_never_refills():
    assert bucket_for(POLICIES["batch"], 0.0).refill_per_second == 0.0


def test_policy_named_refuses_an_unknown_name():
    assert policy_named("free") is POLICIES["free"]
    with pytest.raises(KeyError):
        policy_named("enterprise")
