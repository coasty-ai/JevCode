Synthetic two-task Ladder fixture for test/unit/bench/ladder.test.ts, same layout as bench/data/ladder
(tasks/<name>/{src,tests,gold,task.md,meta.json,pytest.ini}, index.json). `ratio` has two independent
one-line bugs (2 hunks), `greet` a missing guard (1 hunk). meta.json descriptions carry the marker
FIXTURE_SECRET, which the tests assert never reaches the task text or the workspace.
