The install planner under `src/` reports the wrong depths and misses a bad name.

`layers.depth` must put a package that requires nothing at depth 0 and everything else one
deeper than the deepest thing it requires; right now every depth in the graph is off. Note that
`order.round_number` is written against that depth and the round numbers an operator reads are
counted from one, so the two have to be right together — the rounds, the schedule and the
round count all come out of the same pair and the tests pin every one of them. Separately,
`plan.check` has to report an unknown name wherever it appears, not just in the wish list.

Make everything under `tests/` pass. Do not edit the tests.
