Two things are wrong with the router under `src/`.

`pattern.specificity` is meant to say how much of a path a pattern pins down — a static
segment pins one segment down, a placeholder pins nothing — and `more_specific` and `rank` are
wrong with it. Be careful: `router.match` is the other reader of that score and it picks the
right route for every path today, so the score and the pick have to end up agreeing.

Separately, `router.reverse` only complains about a placeholder you gave no value for. It has
to complain about a value you gave for a placeholder the route does not have, too.

Make everything under `tests/` pass without editing the tests.
