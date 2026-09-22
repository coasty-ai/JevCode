The rate limiter under `src/` is wrong in three ways and the tests under `tests/` say how.

A request larger than a policy's burst can never be served, however long the caller waits, and
both `TokenBucket.wait_for` and `Limiter.retry_after` have to say so; `Limiter.allow` must deny
exactly the requests that have a non-zero or unbounded wait, including the requests a spent
`batch` quota will never refill. Separately, the `free` and `pro` buckets drain and refill far
too quickly for the rates the policy table is written in.

Make everything under `tests/` pass. The tests are correct: do not edit them, and leave the
numbers in the policy table as they are.
