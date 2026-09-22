"""One token bucket: tokens accrue at a fixed rate and are capped at the capacity."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

PRECISION = 6


@dataclass
class TokenBucket:
    capacity: float
    refill_per_second: float
    tokens: float
    updated_at: float

    def sync(self, now: float) -> None:
        """Accrue the tokens earned since the last sync; never above the capacity."""
        if now < self.updated_at:
            raise ValueError("a bucket cannot be synced into the past")
        earned = (now - self.updated_at) * self.refill_per_second
        self.tokens = min(self.capacity, self.tokens + earned)
        self.updated_at = now

    def level(self, now: float) -> float:
        """How many tokens the bucket holds at `now`."""
        self.sync(now)
        return round(self.tokens, PRECISION)

    def wait_for(self, cost: float, now: float) -> Optional[float]:
        """Seconds until `cost` tokens are available.

        0.0 when they already are, and None when the wait would never end: either the
        bucket is too small to ever hold `cost`, or it does not refill and holds too few.
        """
        if cost > self.capacity:
            return None
        self.sync(now)
        if self.tokens >= cost:
            return 0.0
        if self.refill_per_second <= 0.0:
            return None
        return round((cost - self.tokens) / self.refill_per_second, PRECISION)

    def spend(self, cost: float) -> None:
        self.tokens -= cost
