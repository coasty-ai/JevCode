# Iterations 1–4

After the [out-of-sample measurement](out-of-sample.md) showed where the wall and the dollars actually went,
four iterations of changes followed. Each one is recorded here with what it changed and what it measured.

Two of the four measured nothing about the mode's pass rate, wall or cost, and say so in their own entries. That
is deliberate: a change that ships without a measurement is recorded as unmeasured rather than credited with the
next number that happens to move.

| iteration | what it targeted | what it measured | verdict |
| --- | --- | --- | --- |
| 1 | the eight changes the out-of-sample analysis ranked | a fresh 18-task slice and the in-sample 28 | measured; mixed |
| 2 | the repository stop rule, the generator timeouts, the warm plane A/B | the same 18 + 28 tasks, paired to iteration 1 | measured; the first win outside the one-line regime |
| 3 | four structural-signal items, plus three localiser holes | **only** an offline gate; no pass, wall or cost number claimed | implemented, unmeasured |
| 4 | the replace-site order with no ranking, and three unswept signals | **nothing about the mode**; corpus sweeps and offline replays only | implemented, unmeasured |

Source: the dated entries in [`docs/LLM-JEV.md`](../LLM-JEV.md). Reports:
[`experiments/results/llm-jev-iter1.md`](../../experiments/results/llm-jev-iter1.md),
[`experiments/results/llm-jev-iter2.md`](../../experiments/results/llm-jev-iter2.md). Adversarial reviews:
[`docs/research/llm-jev/`](../research/llm-jev/).

## Iteration 1 — measured

Eight changes, none keyed to a task name, each traceable to a finding in the out-of-sample analysis: gate the
ranking requests on "the pool has a passer inside the run budget"; a per-run request-hash cache; generator
deadline back-off after zero-token timeouts; goal clustering by shared file or call chain; two new guard rules;
drop the question families that produced one distinct answer; break the context-gathering replan loop by forcing
a phase escalation; refuse a completion claim that rests on the issue-oracle reproduction alone. Plus a bench
flag that archives a run's records into the results directory.

**Build `751e3bf`. Total spend $0.5798 of a $6 cap. Every arm ran with the warm plane switched off.**

### The shipped default could not run the search at all

At this build an `llm-jev` run never completed a synthesis step. The candidate batch reached the lanes, the sieve
reported "0 tested on 8 lanes (nothing ran)", and the wall cap took the run in step 1. Three runs sat wedged at
0 % CPU with no child processes for 59 minutes.

A five-point offline A/B on one task pinned it on the warm verification plane, not on this iteration's work. With
the plane forced off the same build does 6 steps and 2,180 candidates tested in 80.8 s. Everything below therefore
ran with the plane off. See [The warm plane A/B](warm-plane.md).

### Fresh 18-task slice

Eight remaining eligible QuixBugs programs, a whole new ladder long-2 tier authored blind, and the first four
non-sympy repository instances that are neither oracle-valid nor ever passed.

| metric | `llm-jev` | `jev-off-tuned` |
| --- | --- | --- |
| pass | **12/18** ([44 %, 84 %]) | 9/18 ([29 %, 71 %]) |
| discordance | b = 4 / c = 1; sign p = 0.1875 | — |
| correct by verdict | 11 | 9 |
| cost | $0.2517 | $0.2435 (1.03×) |
| decision requests | 1,086 | 0 |

The four wins are the whole of the ladder long-2 tier the candidate solves — `deadline_queue`, `dep_order`,
`hunk_merge`, `token_bucket` — a tier in which no single edit of any gold diff helps on its own and seven of
eighteen edits leave a strictly worse tree. The control is 0/6 there, every task at its step cap.

QuixBugs is 8/8 both ways with zero overfits. The repository suite is 0/4 against 1/4: all four candidate runs
stop at a replan after **5 steps and 60–100 s** having tested **5 candidates while pricing 6,960** — a faster
failure than before, not a better one.

`token_bucket` is committed as a strong overfit.

### In-sample 28

27/28, one regression (`django__django-15128`), correctness unchanged at 26/28. Cost falls hard: **$0.0783 against
$0.1441**, 394 decision requests against 482.

### Predictions held and failed

Held: the ranking gate on QuixBugs and the ladder; the request-hash cache; the goal clustering; the removal of the
degenerate question families; the replan-loop break.

Failed: the ranking gate **on repositories** (6,960 priced, 20 tested); the deadline back-off — zero-token timeouts
were 135 of 290 samples, worse than the 34–39 % it was written to fix; the two new guard rules — 2 refusals and 1
firing over 58 runs, and neither of the two named correctness losses caught.

## Iteration 2 — measured

**Build `d86c385`. Total spend $1.0413 of a $4 cap. The same 18 + 28 tasks and the same limits as iteration 1, so
the two are paired task for task.**

### Read every wall number next to its load

Fifteen cores, shared all day with other work. The recorded one-minute load average per record ranges **2.9 to
175** (iteration 1: 2.4 to 45). Pass, cost and every counter are unaffected by that. Wall is not, and two task
losses are budget casualties that pass in a quieter arm of the same build.

One window is load-matched and is the only timing result quoted from this iteration: a back-to-back QuixBugs
triple over eight tasks each, run inside seven minutes.

That window also **corrects iteration 1**. The mode generates its own machine load — eight verification lanes at
concurrency 4 — so iteration 1's QuixBugs arm ran at load 4.2 rising to 23.2 against a control pinned at 3.1–3.4.
Its reported "26.0 s against 19.7 s, ratio median 1.406" is a five-to-sevenfold load gap as much as a program
difference. At matched load the per-task median is **1.163** (slower on 6 of 8, at 0.28× the cost).

### Fresh 18

| metric | iteration 2 | iteration 1 |
| --- | --- | --- |
| pass | **14/18** ([54.8 %, 91.0 %]) | 12/18 |
| discordance against `jev-off-tuned` 9/18 | **b = 5 / c = 0, sign p = 0.0312** | b = 4 / c = 1, p = 0.1875 |
| correct by verdict | 13 (control 9) | 11 |
| cost | $0.2489 (control $0.2435) | $0.2517 |

**The repository suite moves off zero: 2/4.** The five-step replan stop that ended all four iteration-1
repository runs is gone; the three that still stop by replan do so at 14, 17 and 14 steps having tested **1,060
candidates against 751 priced** (iteration 1: 20 tested against 6,960 priced).

QuixBugs is 8/8, zero overfits. Ladder long-2 is 4/6 again but a *different* four, and a third run of the tier at
the same build scores 5/6. Across three samples the tier reads **three stable tasks and two coin-flips** —
neither iteration's 4/6 is a level, and the page does not quote one.

### In-sample 28

27/28 pass, 25/28 correct. Iteration 1's only regression is recovered and completes at 6 steps. The single loss is
ladder `account` at the replan cap under load 99–175, which passes at load 13 in another arm forty minutes later.

**`detect_cycle` is gold-identical** — the overfit iteration 1 named. `stats` is still weakly overfit and `wrap`
picks up a fresh one that is gold-identical in the other arm the same evening.

### Predictions

The escalation rule fires 8 times on the fresh slice and 3 in-sample, and is what buys the repository instances
and the recovered regression (held). The pool cap turns 6,960 priced / 20 tested into 751 / 1,060 (held). The
per-goal deadline high-water mark is exact — **no goal's deadline shrank after a zero-token timeout in any of six
arms**, 0 of 45 events — and zero-token timeouts fall 46.6 % → **27.2 %** of fresh samples and 33.6 % → **6.9 %**
in-sample (held; the residual 27 % is not fixed).

The localiser fallback half-holds. The offline replay gate's QuixBugs half now passes; its ladder half still fails
on one task, so the gate is red.

### The warm plane

Faster, sound as a transport, and it loses tasks. It stays off. Full detail: [The warm plane A/B](warm-plane.md).

## Iteration 3 — implemented, unmeasured

**The only thing measured on this build is an offline gate: $0, no network, a mock provider.** Every other number
in the entry comes from replaying the recorded iteration-1 runs offline or from a code sweep of the benchmark
corpus. **No pass, wall or cost number for the mode is claimed.**

Four items landed, and the most interesting result is a signal that was *withdrawn*.

### A structural signal reaches the pool rule only with a corpus sweep behind it

The iteration shipped a signal called `late_guard` — a guard clause placed behind a use of the value it guards.
An adversarial review killed the shipped version: one of its two shape tests degenerated to "not the first
statement", because nothing ever binds a function parameter; the other counted any occurrence of the operand's
*root*, so an unrelated attribute access on the same object read as evidence. It fired on a real gold patch and on
seven other correct shapes.

After the fix, the sweep is what settled its role:

| corpus | patches | `late_guard` fires |
| --- | --- | --- |
| QuixBugs golds | 41 | **0** |
| ladder golds | 65 files, 26 tasks | **0** |
| SWE-bench Verified golds | 92 Python edits / 30 instances | **0** |
| the three recorded overfits from iteration 1 | 3 | **0** |

The last row is the finding. A signal with no positive evidence on the records cannot be the evidence that a
candidate pool holds no correct fix. So the pool-suspicion set was cut back to a single member, and `late_guard`
only ever raises an advisory that drops nothing.

### The structural signals are not shown to the decision model

The probability bounds the code compares against were calibrated on a state that carried no signals. Gating them
on an answer computed over a state that names a candidate's suspicious properties would compare against a number
nobody measured. And an annotation present on some options and absent on others reads as "not computed" rather
than "clean". The signals stay code-side.

### A flag that did not do what it said

`JEVCODE_DEADLINE_GROWTH` had a `served` setting that could not raise a deadline at all — it was "no timeout
back-off" wearing the name "served evidence", and the test that appeared to show growth pinned an override the
bench never uses. Measured through the real path, in milliseconds:

| provider behaviour | `served` | `always` (the default) |
| --- | --- | --- |
| never answers | 20, 20, 20, 20 | 20, 30, 45, 68 |
| answers once, then times out | 20, 30, 45 after the served round | identical |

`always` is byte-identical to iteration 2's behaviour, which is why it is the default.

### What the offline gate caught in this iteration's own work

The gate's first ladder arm read "every passer of the batch is structurally suspect … dropping the 3 passers" and
stopped a task **with the decision model on**. The signal that fired does so on a gold-shaped rewrite — and that
task's gold *is* a rewrite. Membership of the pool-suspicion set became "swept against the golds and found on none
of them", which is the whole reason to run the gate.

### Honest corrections recorded

A trajectory with the decision model on is **not** unchanged when the request budget is spent mid-search. The
entry withdraws that claim, pins the changed ordering in a test, and accepts it: the decision model routes, it
never gates, and a function it could not afford an opinion about must still be searchable.

## Iteration 4 — implemented, unmeasured

**Nothing here is a pass, wall or cost measurement of the mode.** Every number comes from a code sweep of 198 gold
patches, from an offline replay of recorded runs, or from offline gate arms that ran while the machine was at load
79–118 and are therefore reported rather than gated.

### The replace-site order when there is no ranking

The mechanism, exactly. With no line question answered — the decision model switched off, the request budget spent
mid-search, or every line answer escaping — every candidate site's rank is `+Infinity`, so the tail comparator
evaluates `Infinity - Infinity` = `NaN`. A JavaScript engine reads a `NaN` comparator as "equal" and the sort is
stable, so the six sites kept were **the first six lines of the file**. One task's gold fix is on the tenth code
line of its only function; the site the previous iteration had finally made available was thrown away one layer
down.

A second defect compounded it: with the decision model switched off, one question type still answers with an inert
0.5 on every line. The site builder read that as evidence and ordered the first three lines of the file ahead of
everything the code had to say. A flat answer whose every line carries one value ranks nothing, whoever produced
it, so a flat answer is now ignored with a note.

The replacement order is built only from evidence already in reach: the failing call's own function first, then
its callees; then overlap with the failure's own words; then a statement-kind prior measured over the corpus; then
line order; then round-robin across function groups so one function cannot take all six sites; and a continuation
physical line is ranked last, because the statement-span site already covers it.

**The scope of that change, corrected.** The first write-up claimed a trajectory with a real ranking was
byte-identical. **That was withdrawn as false.** Two tail sites share an infinite rank whenever the coverage
spectrum ranked neither, which is routine even with full coverage and a full answer. The true claim is narrower: a
finite rank still sorts exactly as it did and still beats an infinite one, so **the only order that changes is the
relative order of tail sites the spectrum did not rank — in every run**. A test pins that as a deliberate
behaviour change rather than denying it.

**Consequence for the next measurement:** the arms with the decision model on are not a no-op re-run of the
previous build, so the iteration-3 reference is not comparable.

### The statement-kind prior, re-measured over all 198 patches

Two corrections from review. First, 43 repository patch images did not tokenize after a plain dedent, because the
patch window is cut out of the middle of a file; a recovery prologue at every indent width the fragment uses
recovers **43 of 43**, so the only real-world corpus now carries 47 % of the measurement instead of 35 %. Second,
a rewritten multi-line statement counts **once**, at its first line, on both sides — counting every physical line
gave continuation lines a prior above `return`, which would have offered a fragment of an expression as a replace
site ahead of the statement that owns it.

195 gold statements against 2,335 background statements, base rate 0.0835. The smoothing is fixed by the
measurement, so a statement kind the corpus never showed lands on exactly 1.00.

| statement kind | gold | background | prior | was |
| --- | --- | --- | --- | --- |
| `while` | 3 | 15 | **1.78** | 1.89 |
| `return` | 70 | 473 | **1.75** | 1.68 |
| `break` | 1 | 5 | **1.41** | 1.46 |
| `assign` | 53 | 502 | **1.26** | 1.14 |
| `augassign` | 3 | 33 | **1.06** | 0.95 |
| `for` | 7 | 91 | **0.93** | 0.95 |
| `expr` | 33 | 473 | **0.84** | 0.45 |
| `if` | 22 | 333 | **0.80** | 1.28 |
| `try` | 0 | 7 | **0.63** | 0.73 |
| `import` | 0 | 9 | **0.57** | 0.60 |
| `other` | 2 | 91 | **0.35** | 0.42 |
| `raise` | 0 | 52 | **0.19** | 0.21 |
| `from_import` | 1 | 203 | **0.11** | 0.12 |

The two movements that matter are `if` 1.28 → 0.80 and `expr` 0.45 → 0.84, both driven by the recovered repository
patches. `while` (3 golds) and `break` (1) are thin cells that the smoothing holds near the base rate. A test
re-derives the whole table from the corpus and checks **rank order plus a ±0.15 tolerance** rather than exact
equality, so adding a ladder task is no longer a source change.

### The three signals nobody had ever swept

`duplicates_block`, `guards_other_variable` and `dead_guard` had been in the signal set from the start with no
sweep behind them. The sweep found four fires on gold patches, each a concrete false positive:

| signal | fires as it stood | after the fix | sweep power (patches that could fire) |
| --- | --- | --- | --- |
| `guards_other_variable` | 0 | **0** | 51 of 198 |
| `dead_guard` | 3 | **0** | 51 of 198 |
| `duplicates_block` | 1 | **0** | 198 |

Each fix has a gold patch that forced it. One read the `in` of `x not in y` as a guarded name, because a negation
pattern matched and `in` is a name — a subject whose head is a language keyword is not a subject. One asked only
"is this name dereferenced anywhere in the function", which fires on a guard over a predicate attribute that the
function never names; it now requires the subject to *occur* in the pre-patch function and never be dereferenced
there. One asked only "is this added line, with identifiers abstracted, a line the function already has" — which
is true of every in-place rename; "duplicates" now means the count went **up**.

**None of the three joined the pool-suspicion set.** The bar is a clean 198-gold sweep **and** positive evidence
on the records — a replay in which the signal separates a recorded overfit from its gold patch. These three have
the first half and not the second. A clean sweep says only "no gold carries this"; it does not say the signal ever
marks an overfit, and a signal that marks nothing cannot be the evidence that a pool holds no correct fix.

### The new data-flow signal, and why it ends the iteration advisory-only

A signal called `guards_derived_local` was added: a guard on a value the function computed for itself, placed
behind a use the guard does not protect. Two corrections came out of review, and they are the previous iteration's
lesson at one remove.

*A use that cannot fail is not evidence, and what "fail" means depends on what the clause tests.* A `None` check
is broken by any dereference. An emptiness check is not — sorting, lower-casing, a dictionary lookup and an append
all succeed on an empty container. Since "add an emptiness guard in front of the indexing that crashed, behind a
harmless method call" is the commonest shape of a real index-error fix, the first version called that whole family
an overfit.

*A branch not taken is not "in front of".* The preceding-statement test ranged over the whole enclosing function,
so a use inside an unrelated branch, an `else`, or a `try` whose handler already covers the empty case all counted.

After both fixes, the replay **reverses the iteration's headline result**:

| record | before the fixes | after | why |
| --- | --- | --- | --- |
| ladder `stats` | fired | **no** | the only preceding use sits inside a branch the empty input never takes |
| QuixBugs `detect_cycle` | fired | **no** | the clause tests one attribute chain for truthiness; what stands in front dereferences a different one |
| ladder `token_bucket` | no | **no** | unchanged: the overfit and the gold guard the same two parameters |

Zero of three. Corpus sweep: 0 fires over all 198 golds, with a power of 6. So the signal is advisory-only, and
**iteration 4 adds no pool signal**. The pool-suspicion set ends the iteration exactly where iteration 3 left it,
at one member.

### The recorded overfits and the open hole

Named and still open at the end of iteration 4:

- **`detect_cycle`'s guard pools are not free of correct fixes.** No candidate in them carries a swept signal, so
  no pool-level suspicion fires, no request is made, and a code rule commits a guard at the wrong line while the
  gold replaces another. A test asserts that the hole is open rather than claiming it is closed.
- **`kth` still fails without the decision model.** The site order fix works: the run now visits the gold line
  second of six and reaches the widened phase, where every earlier run visited no replace site at all. It still
  fails, and the record says why — 7,377 candidates tested over 20 steps and the gold's expression never appears
  anywhere in the transcript. No candidate source enumerates it. That is generation, not localisation.
- **`token_bucket`** is a strong overfit in all four ladder arms run at that build, always at the same divergence.
  Its rule was never written.

### Bound symmetry: measured, and left alone

The advisory path counts every signal; the pool path counts only swept ones. Replaying 591 readable records with
142 advisory decisions shows the stricter bound **delayed** a gold-equivalent candidate to step end and marked it
"possible overfit" — it never refused one. Of the 27 holds at the strict bound, none was below the release
threshold and all 27 had the held site's file in the run's final patch. Three method caveats are recorded with the
table, including that 20 of the 28 rows come from runs whose final patch touches exactly one file, so the "file is
in the final patch" check could only come out positive for those.

The condition for changing the advisory path is not met, so it is unchanged.

## What the four iterations add up to

- The one-line-bug regime is solid and generalises: zero overfits out of sample, three steps and a third of a
  cent per program.
- The repository regime moved from 0/4 to 2/4 on a fresh slice in iteration 2, from a mechanism (the escalation
  rule) that is named and whose prediction held.
- The multi-hunk ladder tier has **no stable level** at these builds. Three samples of the same tier at the same
  build give 4/6, 4/6, 5/6.
- The search for a structural signal that can prove a candidate pool holds no correct fix **stopped**, with one
  member in the set and the bar written down: a clean 198-gold sweep with stated power, **and** a replay record
  where the signal separates an overfit from its gold.
- Iterations 3 and 4 are shipped and unmeasured. The next measurement owes both a number.

## Related

- [Out of sample](out-of-sample.md) — the analysis these iterations were written against.
- [The warm plane A/B](warm-plane.md) — iteration 1 found it wedging runs; iteration 2 measured it properly.
- [Measurements index](README.md).
