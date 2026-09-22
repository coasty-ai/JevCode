"""Per-key rate limiting over the named policies."""

from __future__ import annotations

from typing import Dict, List, Optional

from .bucket import TokenBucket
from .policy import Policy, bucket_for, policy_named


class Limiter:
    """One bucket per key, all built from the same policy."""

    def __init__(self, policy_name: str, start: float = 0.0) -> None:
        self.policy: Policy = policy_named(policy_name)
        self._buckets: Dict[str, TokenBucket] = {}
        self._start = float(start)

    def bucket(self, key: str) -> TokenBucket:
        if key not in self._buckets:
            self._buckets[key] = bucket_for(self.policy, self._start)
        return self._buckets[key]

    def retry_after(self, key: str, now: float, cost: float = 1.0) -> Optional[float]:
        """Seconds until `cost` would be allowed for `key`, or None when it never will be."""
        return self.bucket(key).wait_for(cost, now)

    def allow(self, key: str, now: float, cost: float = 1.0) -> bool:
        """Charge `cost` to `key` when it is affordable right now."""
        wait = self.retry_after(key, now, cost)
        if wait == 0.0:
            self.bucket(key).spend(cost)
            return True
        return False

    def level(self, key: str, now: float) -> float:
        return self.bucket(key).level(now)

    def keys(self) -> List[str]:
        return sorted(self._buckets)
