Two things are wrong with the hunk merger under `src/`.

A `Hunk` carries `start` as a 1-based diff line number, and `Hunk.index()` is supposed to turn
that into an offset into a plain 0-based list of lines — it does not, and `last_index()` and
`replaced_lines()` are wrong with it. Be careful: `apply.apply` is the only caller of `index()`
and every one of its tests passes today, so whatever you do to `index()` has to leave `apply`
landing hunks on exactly the lines it lands them on now.

Separately, `merge.merge` only looks for conflicts across the two sides; a set of hunks handed
in on one side that overlaps *itself* has to be refused just the same.

Make everything under `tests/` pass without editing the tests.
