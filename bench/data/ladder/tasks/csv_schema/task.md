The schema inferrer under `src/` gets column kinds wrong and lets a malformed row through.

A column has to come out as the narrowest kind that holds *every* one of its non-blank cells:
whole numbers beside decimals are a float column, one word anywhere makes the column text, and
a column of nothing but `true`/`no` or of ISO dates keeps its own kind. Both the pairwise rule
in `cells.widen` and the fold in `infer.column_type` have a say in that, and the tests pin each
of them separately. `schema.validate` must also report a row whose cell count does not match
the schema, whichever way it does not match.

Make everything under `tests/` pass without editing the tests. `reader.read` is correct as it
stands: rows are handed on exactly as wide as they were written.
