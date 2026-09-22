"""The named rate policies and the buckets they build."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

from .bucket import TokenBucket
from .clock import per_second


@dataclass(frozen=True)
class Policy:
    """A sustained rate in requests per minute plus how many may arrive at once."""

    name: str
    per_minute: float
    burst: float

    @property
    def refill_rate(self) -> float:
        """The sustained rate in requests per second, the unit a bucket refills in."""
        return per_second(self.per_minute)


POLICIES: Dict[str, Policy] = {
    "free": Policy("free", per_minute=60.0, burst=5.0),
    "pro": Policy("pro", per_minute=600.0, burst=20.0),
    "batch": Policy("batch", per_minute=0.0, burst=3.0),
}


def bucket_for(policy: Policy, now: float) -> TokenBucket:
    """A bucket sized to the policy's burst, full, refilling at the sustained rate."""
    return TokenBucket(capacity=policy.burst, refill_per_second=policy.per_minute, tokens=policy.burst, updated_at=now)


def policy_named(name: str) -> Policy:
    if name not in POLICIES:
        raise KeyError(name)
    return POLICIES[name]
