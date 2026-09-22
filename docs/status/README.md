# Status — 0.5.0 (2026-09-22)

What ships, what sits behind a switch that is off, what has been measured, and what has not.
Short on purpose. The long record is [`STATUS.md`](../STATUS.md) and the dated measurement logs it
names.

## Release state

The version is **0.5.0** and it is **not published**. Nothing is on the npm registry, and the
Homebrew formula still carries a placeholder URL and a deliberately invalid checksum. Install
from source — see [Install](../getting-started/install.md).

Platform support is macOS and Linux. Windows is not supported; use WSL2.

## What ships

| Area | State |
| --- | --- |
| Four engine modes | `llm-jev` (default), `jev-on`, `jev-only`, `jev-off` — [modes](../getting-started/modes.md) |
| Interactive session | Ink terminal UI, a plain readline renderer, and an NDJSON event stream |
| Checkpoints and resume | every step written to the run directory; `--resume <id\|title>`, `-c` |
| Sandbox | every proposed command runs confined; `--sandbox auto\|seatbelt\|none` |
| Budgets | run and session spend caps, wall time, step and replan caps, all enforced in code |
| Human review | a diff-bearing review card at risk 0.3 and above; blocked at 0.7 and above |
| The synthesizer | Ledger + Sieve, shadow lanes, the guard — [the synthesizer](../concepts/the-synthesizer.md) |
| The issue oracle | builds a failing reproduction for repositories that have none |
| Inspection | `jevcode why`, `jevcode calibration`, `jevcode report` |
| Benchmarks | `jevcode bench` over the bundled suites, with per-arm records |
| Performance gates | `jevcode perf` |

## Behind a switch that is off

Everything in this table is **off by default**. If you turn one on, say so next to any number
you report from a run that used it.

| Mechanism | Default | Switch | Why it is off |
| --- | --- | --- | --- |
| Router table | `off` **in every mode**, and gated to `jev-on` before the switch is even read | `JEVCODE_ROUTERS=on` | it carries three polarity changes — the risk verdict, the replan stop, and completion — and none may reach a user run before the head-to-head decides |
| Warm verification plane | off | `JEVCODE_WARM=on` | a recorded run never completed a synthesis step with it on: lanes ran nothing and the process sat at 0 % CPU for 59 minutes. It stays off until a real-lane test and a full smoke pass with it on |
| Delegating a step to sub-agents | `split: 'off'` | the `orchestrate.split` setting | the gate short-circuits before it gathers a single fact, so a shut gate makes zero Jev requests |
| Synth fast path | `auto` under `jev-on`, `off` in every other mode — so off in the default mode | `JEVCODE_FASTPATH=off\|auto` | purely additive where it is on: it can only propose, and it degrades to "the code model proposes as usual" |
| Coordination claims | `advisory` | the `coordination.claims` setting | under `advisory` a conflict is a recorded fact and nothing a peer writes delays a step |

Where a switch and an environment variable disagree, **the explicit option wins** and the
environment variable fills only an absent option.

## What is measured

Two head-to-heads, both from one frozen build, both recorded in [`LLM-JEV.md`](../LLM-JEV.md)
under its 2026-09-22 entries.

| Slice | Result |
| --- | --- |
| Same build, 28 tasks | `llm-jev` **28/28** against plain `jev-off` **21/28**; Wilson [88 %, 100 %] against [57 %, 87 %]; discordance b = 7 / c = 0, exact sign p = 0.0078; median wall 63.0 s against 246.3 s pooled and 39.5 s against 175.3 s on the 21 both solved; $0.1441 against $0.5875 |
| Out of sample, 22 tasks | `llm-jev` **13/22** [39 %, 77 %] against tuned `jev-off` **12/22** [35 %, 73 %]; discordance b = 2 / c = 1, p = 0.500; pooled median wall **1.385× against**; **2.68×** the cost |

Both rows carry the same caveats, and the caveats are not decoration:

- **one run per arm**, and the baseline's own run-to-run noise on a re-run of the same arm was
  about ±2 tasks;
- the 28-task slice is **in-sample** — it includes tasks some thresholds were tuned on, so it
  is a measurement and not a capability claim;
- the 22-task slice was chosen by fixed rules that exclude every tuned name;
- the SWE-bench evaluator is a **local-virtualenv replica**, not the official container;
- the warm plane was **off** for every number;
- **the cost basis is asymmetric**: 78 % of `llm-jev`'s dollars are an estimate or a rate card
  (88.4 % on the out-of-sample slice), while the baseline's are 100 % provider-reported. Any
  dollar comparison has to carry that sentence.
- censoring is one-sided in both directions: on the same-build slice 8 of 28 baseline runs hit
  the wall cap against 0 of 28 for the candidate; on the out-of-sample slice 14 of 22 tuned-arm
  records end at the step cap and none at the wall cap.

Other measured things:

- **`jev-only` with zero generating-model calls.** On a 40-program suite, all 40 records carry
  `generatorCalls: 0`, zero generator tokens and zero generator cost. Repaired 39/40 on the
  cases the workspace exposes; **37/40 correct** by a separate verdict script, with 2 overfits
  named. Recorded in [`JEV-ONLY.md`](../JEV-ONLY.md); the line-by-line parse of every
  `jev-only` record is `experiments/results/jev-only-audit.md` §2.2.
- **The issue oracle**: valid on 9 of 30 SWE-bench Verified instances — 7 strong, 2 weak — at
  $0.0096.
- **The contract lint**: 34 Jev call sites, 10 carrying a four-clause block, 24 allow-listed.
  Reproduce with `npm run jev-contract`.
- **Build and package**, from `npm run build` and `node scripts/check-pack.mjs` on this tree:
  bundle 2,854,413 B; unpacked 2,991,973 B; tarball 1,009,511 B; 10 files; 0 runtime
  dependencies. Byte counts move with the bundler's version and with the size of `README.md`,
  which is in the tarball.

## What is not measured

Stated as such rather than left to inference:

- the router table end to end — no live run has been taken with it on;
- a bench-wide report of the wall a router adds to a step;
- the warm plane on real lanes;
- the delegating gate, beyond its shut-gate behaviour;
- any **repeat** run of either head-to-head;
- the `llm-sieve` arm, which is not wired and refuses rather than running as another arm;
- the fast path's effect on a live `jev-on` run.

## Named open items

**Deferred by design**, with reasons, in [`LLM-LOOP-DESIGN.md`](../LLM-LOOP-DESIGN.md) §9.1: a
persistent decision cache and its off-switch; a single-round search API; a repository-class
fast path; five further routers the design names but does not build; the warm plane; two
screening counters on the evidence record; a hard per-round Jev cap as an option; replay; and a
known gap in the judge.

**Owed from the most recent merges**, recorded in the commit log:

- the context stage was never converted to a router, so an outage there can still end a run in
  the routers-on arm;
- a changelog line for the completion router;
- a bench-wide row for the wall a router adds.

**Open in the synthesizer**, recorded in [`LLM-JEV.md`](../LLM-JEV.md):

- one recorded overfit class the guard's perturbation probe does not separate;
- one task whose loss is a generation failure rather than a selection failure;
- replay evidence for one proposed pool signal, which is why that signal was **not** added;
- a full smoke pass on the merged tip.

**Known red performance rows**, named rather than loosened: 7 of 50 gates are red, all of them
targets of recent interface work that never had a green baseline. Three concern the
**opt-in** full-screen renderer — including 368 frames that were not exactly the expected
height, a real post-condition defect of that renderer. The other four are one composer probe
and three panes that timed out on their anchors. The default renderer's own gates pass: first
frame p95 133 ms against a 300 ms budget, harness overhead per step p95 42.6 ms against 50 ms.

## Where the history lives

The design documents are normative and stay where they are:
[`DESIGN.md`](../DESIGN.md), [`JEV-ONLY-DESIGN.md`](../JEV-ONLY-DESIGN.md),
[`LLM-JEV-DESIGN.md`](../LLM-JEV-DESIGN.md), [`LLM-LOOP-DESIGN.md`](../LLM-LOOP-DESIGN.md),
[`HARNESS-NEXT-DESIGN.md`](../HARNESS-NEXT-DESIGN.md),
[`COORDINATION-DESIGN.md`](../COORDINATION-DESIGN.md),
[`ORCHESTRATION-DESIGN.md`](../ORCHESTRATION-DESIGN.md), [`IMPORT-DESIGN.md`](../IMPORT-DESIGN.md)
and the interface design documents. The dated logs are [`JEV-ONLY.md`](../JEV-ONLY.md),
[`LLM-JEV.md`](../LLM-JEV.md) and [`STATUS.md`](../STATUS.md). Ratified decisions are
[`DECISIONS.md`](../DECISIONS.md). The release-by-release summary is
[`CHANGELOG.md`](../../CHANGELOG.md).
