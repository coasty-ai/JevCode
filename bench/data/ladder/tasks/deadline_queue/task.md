The scheduler under `src/` reports lateness with the wrong sign and schedules one job too many.

`slack.lateness` is supposed to be positive when a job lands after its deadline and negative
when it lands early — it is the wrong way round, and `is_late` and `headroom` inherit that.
Watch the schedule side while you fix it: everything `schedule` reports about lateness comes
out right today and the tests pin those numbers, so the helper and its caller have to end up
agreeing.

Separately, a job that takes no time at all should occupy no slot in the laid-out schedule.
`ranking.order` is not the place for that — it hands on every job by design, and the tests
pin that too.

Make everything under `tests/` pass without editing the tests.
