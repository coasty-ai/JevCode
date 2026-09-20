# Anchor probe: Jev on QuixBugs one-line bugs (2026-09-20)

Script: `experiments/anchor-probe.mts`. Model `typesafe/jev-1.13-20260917` via OpenRouter. 14
programs (alphabetical, those with JSON test cases), 3 test cases each in the state.

| Measurement | Result |
| --- | --- |
| Localisation, Choice over all non-blank lines ("which line contains the bug"), top-1 | 13/14 |
| Localisation top-3 | 14/14 |
| Selection, Choice over mutation candidates of the buggy line (2–4 options incl. the fix), top-1 | 14/14 |
| P(correct candidate), min / typical | 0.81 / 0.96–1.00 |
| Cost, 28 requests | $0.0009 |
| Jev latency p50 | 212 ms |

Per-program rows are in the run output (`bitcount` localisation p=0.18 top-3 only; all others
top-1 with p 0.36–1.00). Candidate sets were tiny (the mutation operator list is 20 regexes);
the measurement to make next is selection quality when the correct line is one of 50–255
candidates, and how often the fix is in the candidate set at all (coverage).
