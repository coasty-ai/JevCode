# Adversarial review — `oos-iter-3` @ c469c9e (8 commits from main d86c385)

Reviewer: an independent read-only review, 2026-09-22, read-only in a detached probe worktree; 26 of the branch's assertions fail on main's src (failing-first re-checked). Branch NOT merged on this report: fix pass ordered on the same branch (owner decisions in the merge record).

Read-only. Probes run in a throwaway detached worktree (`/tmp/review-iter3`, removed) with
`--maxWorkers=2`, offline, no network. Branch gates re-verified on that tree: `tsc --noEmit` clean,
`scripts/jev-contract.mjs` ok (32 sites), `test/unit/synth/search` + `test/unit/bench` +
`test/unit/synth/llm` = 59 files / 792 passed, and the six new/changed files 14 files / 211 passed.
Failing-first re-checked by `git checkout d86c385 -- src/`: 26 of the new assertions fail on main's
src (several only because the new exports do not exist — see §16).

---

## Defects, most severe first

### 1. CONFIRMED — `late_guard` refuses a whole class of correct real-world fixes, and the repo's own SWE-bench corpus contains one
`src/synth/py/structure.ts:1562` (`isLateGuard`), `:1411` (`readsName`), `src/synth/search/guard.ts:686`
(`newlyLateGuards`).

The rule is `position > 0 AND (some prior sibling READS an operand ROOT, OR — for an insertion —
no prior sibling BINDS one)`. Both disjuncts misfire.

**Input (a real gold, in this repo): `bench/data/swebench-verified-30.gold.json` → `sympy__sympy-17139`**,
`sympy/simplify/fu.py` `_f`. Before/after reconstructed verbatim from the hunk:

```python
def _f(rv):
    # ... comments ...
    if not (rv.is_Pow and rv.base.func == f):
        return rv
+   if not rv.exp.is_real:
+       return rv

    if (rv.exp < 0) == True:
        return rv
```

`newlyLateGuards` → **`LATE  _f:not rv.exp.is_real reads=1 binds=0`**. The guard *cannot* be hoisted:
`rv.exp` is only meaningful once `rv.is_Pow` holds. The rule calls the gold an overfit signal.

Other confirmed false positives, each minimal Python run through `newlyLateGuards` on this branch:

| shape | verdict | why it is wrong |
|---|---|---|
| `self.logger.debug(...)` then `if self.handler is None: return None` | LATE (reads=1) | operand ROOT is `self`; *any* prior statement touching `self` counts as "already reads the operand". Kills essentially every attribute guard in OO code (Django/SWE-bench shapes). |
| `n = len(xs)` then `if not xs: raise` | LATE (reads=1) | the prior read cannot fail; the guard is equivalent to a hoisted one. |
| `if not isinstance(v, Mapping): return None` then `if "key" not in v: raise` | LATE (reads=1) | the guard is only *valid* after the narrowing guard. |
| `xs = list(xs); xs.sort()` then `if not xs: return None` | LATE (reads=2, **binds=2**) | shape (a) ignores `binds` entirely, so a guard the code *proves* cannot be hoisted is still flagged. The doc's rationale ("hoisting would change nothing") is false here. |
| `if a is None: raise` then `if b == 0: raise` | LATE (reads=0 binds=0) | shape (b) makes **every inserted guard on a parameter at position > 0 late, unconditionally** — nothing binds a parameter, so `binds == 0` always. The rule degenerates to "not the first statement". |
| loop body: `seen(item)` then `if item is None: continue` | LATE | the `for` target is the *parent*, not a sibling, so `binds == 0`. |
| `try: st = os.stat(path) / except OSError: st = None` then `if path is None: raise` | LATE | prior subtree reads `path`. |
| comprehension `names = [r.name for r in rows]` then `if not rows: return []` | LATE | comprehension counts as a read. |

**Sweep power.** I re-ran the corpus the sweep uses: 106 gold files, of which **17 add any guard
clause at all and only 7 add one at position > 0** (`possible_change`, `account/withdraw`,
`csv_schema/infer.column_type`, `csv_schema/schema.validate`, `import_and_guard/settings.get`,
`token_bucket/limiter.allow`, `route_match/router.reverse`). "0 of 41 / 0 of 65" is therefore a
7-sample negative, all in single-function toy files. The only real-world corpus in the repo
(`swebench-verified-30.gold.json`) has exactly one gold that adds a non-first guard, and the rule
**fires on it** — i.e. 1/1 false positive where it was never swept.

**Fix.** (i) drop shape (b) entirely, or restrict it to guards whose operands are *all* parameters
*and* no statement before it can raise; (ii) for shape (a), require the prior read to be a
*dereference* of the operand (subscript/attribute/call/iteration) rather than any occurrence, and
suppress it when `binds > 0` for that root; (iii) do not collapse `x.y` to root `x` when the root is
`self`/`cls` — key on the full dotted path for attribute operands; (iv) re-sweep on
`swebench-verified-30.gold.json` before `late_guard` may be a `POOL_SUSPECT_SIGNAL`.

### 2. CONFIRMED — the pool rule DROPS where the lone-passer rule it claims to copy HOLDS and commits
`src/synth/search/guard.ts:1674-1697`. The comment says it applies "exactly the rule it already
applies to a lone passer carrying the same signals (rule (b))" and "a batch of suspects is weaker
evidence than one suspect alone, never stronger". It is strictly harsher.

Reproduced on the `stats` fixture: the **same** candidate (`if not values: raise …` inserted at the
L22 gap, signals `adds_special_case, late_guard`) at general **0.49**:

```
ALONE   0.49 -> continue  held=suspect  | step-end commitSuspect -> commit
IN POOL 0.49 -> continue  dropped=2     | step-end commitSuspect -> null
```

Alone it is held and released at step end as "possible overfit" (guard.ts:1526-1540 + `commitSuspect`).
In a pool of two it is dropped, `clearHeld` is called, and nothing can revive it. A correct fix that
happens to arrive with a sibling is refused where the identical fix arriving alone is committed.

**Fix.** On `p < bound`, hold the pick (`st.suspect`) instead of returning `dropped`, so step-end
`commitSuspect` and the budget-reserve release apply exactly as on the lone path.

### 3. CONFIRMED — `readsName` counts a *binder's own target* as a read
`src/synth/py/structure.ts:1411-1433`. The skip-set is built only for `assign`, `augassign` and
`for`. Every other binding form leaves its target in the token scan, so the statement that *creates*
the operand is scored as a statement that *reads* it, and the only possible placement of the guard
is "late":

| prior statement | reads | binds | verdict |
|---|---|---|---|
| `with open(p) as x:` | 1 | 1 | **LATE** |
| `except Error as x:` | 1 | 1 | **LATE** |
| `import mod as x` | 1 | 1 | **LATE** |
| `if (x := next(src)) is None:` | 1 | 1 | **LATE** |
| `x.append(1)` | 1 | 1 | **LATE** |
| `global x` | 1 | 1 | **LATE** |
| `x[0] = 1` | 0 | 0 | **LATE** (item assignment is neither a read nor a bind → "hoistable") |
| `x += 1` / `for x in …` / `a, b = …` / `x.f = 1` | 0 | 1 | ok |

Concrete: `def f(p): head(); with open(p) as x: pass; if not x: return None` → LATE. There is no
earlier position for that guard.

**Fix.** Extend the skip-set in `readsName` to `with`/`except`/`import`/`from_import` `as`-targets,
walrus targets and `global`/`nonlocal` names; add subscript-assignment receivers and `del` targets
to `bindsName`.

### 4. CONFIRMED — the new Q16 `true`/`false` examples read as *false* on the `stats` gold
`src/synth/search/guard.ts:943-968`. New `true` example: *"a missing guard added in front of the code
that uses the value, **naming the variable the failure names**"*. New `false` example: *"a guard
naming a different variable than the one the failure dereferences"*.

`bench/data/ladder/tasks/stats/gold/stats.py:18` inserts `if not values:` at the top of `median`,
while the failure is an `IndexError` on **`ordered`** (`ordered[mid - 1]`, `src/stats.py:22`). The
gold therefore *fails* the new `true` example and *matches* the new `false` example. The same holds
for any gold that guards the parameter while the traceback dereferences a derived local — which is
the majority shape (`median(values)` → `ordered`, `possible_change(total, coins)` → the recursion's
locals). The rewording was meant to separate `detect_cycle`; it also teaches Jev to mark the correct
`stats` fix down, which is consistent with the branch's own observation that `stats` now answers 0.49.

**Fix.** Drop the "naming the variable the failure names" clause from the `true` example (keep
"in front of the code that uses the value"), and reword the `false` counter-example to *"a guard on a
variable that is not on the path from the failing input to the failure"* rather than a name match.

### 5. CONFIRMED — `evidenced` in `q5Anchors` is a GLOBAL predicate, so the fallback dies the moment any one Choice answered
`src/synth/search/sites.ts:576`. `localized.sites.some(...)` is computed over the whole localisation,
not per function/file group. Direct probe on a two-file localisation (`a.py` fa, `b.py` fb, five
replace sites each):

```
all escaped                                  -> 10 anchors (a.py:2..6, b.py:2..6)
MIXED: a.py:3 answered 0.8, b.py all escaped ->  1 anchor  (a.py:3)
```

b.py's five code-order replace sites are dropped — the exact "no replace site at all" bug the commit
claims to fix, still live in the mixed case, which is the *normal* Jev-on case (one function ranked,
another escaped or unasked). Item 4(c) therefore only repairs the total-escape (`--jev off`) case.

**Fix.** Move `evidenced` inside the grouping: build the `groups` map first, then per group decide
whether that group carries any `jevProbability`, and apply the `minP` filter + `perFunction` cut only
to groups that do.

### 6. CONFIRMED — the pool path asks Jev with no `jevRequestsLeft` check
`src/synth/search/guard.ts:1600` / `:1618` / `:1670`. The lone-passer advisory is gated
(`guard.ts:1513`: `opts.budget === undefined || opts.budget.jevRequestsLeft >= 1`). The new path is
not: when `poolSuspect` is true the three code ranking rules are skipped unconditionally and
`arbitrate(...)` is called. Probe with `budget = { exhausted: () => true, jevRequestsLeft: 0, … }`
and `throwingAsk`:

```
PROBE-A threw = "Jev must not be asked on this branch"
```

Before this change the same batch committed by `probe_majority`/`fewest_special_cases` with
`requests: 0` — `test/unit/synth/search/guard.test.ts:1464` used to assert `expect(ask.calls).toHaveLength(0)`
and now asserts `1`. So a step that has exhausted its Jev budget now either overspends it or (if the
router refuses) errors out of `decide`.

**Fix.** `if (poolSuspect && canAsk)` — when no request is left, fall through to the code rules and
note that the pool was suspect but unarbitratable.

### 7. CONFIRMED — the Jev-ON trajectory is not unchanged; only the fully-answered case is pinned
`src/synth/localize/index.ts:394-430`. The claim "the last assertion here pins that [Jev-on untouched]"
(`test/unit/synth/localize/jev-off-fallback.test.ts`) only covers a Jev that answers **every**
function. The starved case is not covered. Same call (`review.test.ts` budget-1 / SBFL case), main
src vs branch src:

```
main   : sites=11  geometry replace order = 17,16,15,14
branch : sites=14  geometry replace order = 17,14,15,16
```

Jev is ON, the budget is spent mid-beam, and the localisation grows and re-orders. `res.sites[0]` is
still the Jev anchor (the pinned assertion), but `loc.sites` feeds `localisationOf` (top
`PROMPT_LIMITS_FIX.jevLines = 5`, `src/synth/search/llm.ts:395`), `listingsFor`'s anchor list
(`llm.ts:386`, unsliced) and `orderSites` visiting order — so a Jev-on trajectory *does* move.

**Fix.** State the claim as "Jev-on with every Choice answered is unchanged", and add a pin for the
starved case (site count and the first *k* sites) so the drift is measured rather than assumed.

### 8. CONFIRMED (by reading) — the pool's vouch bound is compared against a Noul that was primed by the very signals it gates on
`arbitrateState(ctx, reps, extras.signals)` (guard.ts:1101-1110) puts `signals` + `signals_note` into
the state shared by the Q15 Choice **and** every `general_cand_XX` Noul. `adviseLonePasser`
(guard.ts:1217) calls `arbitrateState(ctx, reps)` with **no** signals. So:

- the lone-passer bound (0.3 / 0.7) was calibrated on a signal-free state;
- the pool applies the same numeric bound to a Noul asked on a state that names the candidate's
  suspicious properties, which mechanically depresses it;
- the branch's replay tests feed the *recorded* nouls (0.44, 0.49, 0.39) — measured on the old,
  signal-free state — into the new gate, so the "the recorded 0.44 refuses it" evidence does not
  hold: the same request under the new state would not return 0.44.

**Fix.** Either show the signals to the lone-passer advisory too (so the bound is calibrated on the
same state), or gate the pool on a bound derived from a signal-primed measurement.

### 9. CONFIRMED — the bound picks `LONE_PASSER_VOUCH_MIN_NOUL` for virtually every guard pool
`src/synth/search/guard.ts:1685` counts **all** signals, not just `POOL_SUSPECT_SIGNALS`. Any inserted
guard also carries `adds_special_case` (`specialCaseScore > 0` on an `if`), so `pickSignals.length >= 2`
is essentially always true and the effective bound is 0.7, never 0.3. Observed on the `detect_cycle`
and `stats` pools (`adds_special_case, late_guard`, and `dead_guard, adds_special_case, late_guard`).
The "one signal → 0.3" branch is dead for the case the feature was built for.

### 10. CONFIRMED — `JEVCODE_DEADLINE_GROWTH=served` cannot raise a deadline; it only disables backoff
`src/synth/llm/source.ts:831/836/863-871`. Under `served`, `growths` never increments, so
`goalDeadlineMs = min(ceiling, max(floorMs, baseMs))` with `backedOffDeadlineMs(·,·,0) = baseMs`.
`floorMs` only moves in `noteServedLatency`, which is called from the `end.kind === 'result'` branch —
a sample that finished *before* its `setTimeout` abort (`source.ts:344`). Therefore
`served_ms < current deadline`, and `floorMs` can never push the deadline above `baseMs`; it can only
prevent a later p90-driven drop. Probes (deadlines scaled to ms via `sampleDeadline`):

```
slow-but-working provider, 95 % of the deadline every round:
  served : 20,20,38,38,72,72   floorMs=68     (growth comes from the served p90, not the mark)
  always : 20,20,38,38,72,72   floorMs=0

provider that never answers:
  served : 20,20,20,20   growths=0 floorMs=0   <- permanently starved at the class default
  always : 20,30,45,68   growths=4 floorMs=68
```

The branch's own test ("a SERVED sample past the current mark raises it") only shows `floorMs=37`
because it pins `deadlineMs: 1_000` on `fire` — a caller override that the bench never uses. The
`llm:deadline` emit string under `served` is also wrong: it prints `goalDeadlineMs(...)` and calls it
*"the longest a sample of this goal was actually SERVED at"*, which it is not (it is
`max(floorMs, baseMs)`, normally `baseMs`).

**Fix.** Either accept and rename the arm ("no timeout backoff"), or let a *grace-window* arrival
(`graceMs`) be the growth evidence so the mark can legitimately exceed the deadline; and correct the
emit string.

### 11. CONFIRMED — a missing/non-Noul answer for the pick drops the whole pool
`src/synth/search/guard.ts:1683-1684`: `const p = picked === undefined ? 0 : (arb.noul[picked.key] ?? 0)`,
and `arbitrate` already maps a non-`noul` answer to 0 (`guard.ts:1189`). So a Jev that escapes the
Noul (or answers with the wrong shape) on a `poolSuspect` batch yields `p = 0 < bound` → all
contenders dropped, where the same batch previously committed by code. Combined with §1 this is the
main mechanism by which correct pools now die.

### 12. PLAUSIBLE — `escapedAnchors = 40` mostly buys work that `REPLACE_SITES_MAX` throws away, and grows `loc.sites` ~40×
`src/synth/localize/types.ts:69`, `src/synth/search/sites.ts:742/814`. `buildGoalSites` cuts at
`maxReplace = REPLACE_SITES_MAX = 6`, and with no Jev evidence every site scores `jev = 0`, so the six
are chosen by `sbflRank` (all `+Infinity` → `a.sbflRank - b.sbflRank` is `NaN`, comparator treated as
"equal", stable order = insertion order = file order). That is precisely why `kth` still fails, as the
branch notes. Meanwhile the escaped path produces up to `40 × (2·window+1) = 280` sites per beam
function (×5 beam functions), which flows unsliced into `listingsFor`'s `anchors`
(`src/synth/search/llm.ts:386`) and hence into `listingSet`'s choice of the 4 `## Code` listings. A
second beam function can now be crowded out of the listings by the first function's 280 anchors.
Worth a pin on the listing *set* (not just the count) for the escaped path.

### 13. PLAUSIBLE — `signals` is an asymmetric evidence block in a Choice state
`src/synth/search/guard.ts:1101-1110` emits a row only for candidates with ≥ 1 signal. In a
non-`poolSuspect` arbitration some options get an annotation and others get silence; `SIGNALS_NOTE`
does not say that an unlisted option was checked and found clean, so absence can read as "not
computed" rather than "clean". Either emit an explicit empty row per option or say so in the note.

### 14. Records — `always` is behaviour-identical but not record-identical
`src/synth/search/index.ts:899`, `src/synth/search/subgoal.ts:1330`. `L.deps.deadlineGrowth` is always
defined, so `LlmTrace.deadlineGrowth` → `StepRecord.verify.deadlineGrowth` is present on **every**
llm-jev step under the default arm too. The key is optional in `StepVerifySummary`
(`src/core/types.ts:544`) and in `StepsSummary` (`src/bench/types.ts:117`), added at the end of an
existing block, and `emptyStepsSummary()`/`mergeStepsSummaries` handle `undefined` — so the TUI
readers the peer session owns are safe. The only consumers of `StepsSummary` are
`src/bench/step-records.ts`, `src/bench/metrics.ts:137` and `src/bench/runner.ts:649`;
`src/bench/headtohead.ts` and `experiments/llm-jev/headtohead.mts` do not read it. No fixture pins the
old `StepVerifySummary` shape (the only guard-criteria fixture,
`test/unit/synth/search/__snapshots__/guard.test.ts.snap`, was updated in-branch and no other file in
`test/` contains the old Q16 wording). Verdict: additive and safe, but "byte-identical today" is true
of behaviour only, not of the records.

### 15. LOW — `suspicionSignals` now runs for every contender on every ≥ 2-passer decision
`src/synth/search/guard.ts:1593-1598`. `newlyLateGuards` re-derives `guardClauses` per contender
(the `ParseCache` caches the `PyModule`, not the clause list), and `collectGuards` rebuilds
`priors = siblings.slice(0, i).map(subtreeStatements)` per guard (O(n²) per suite). Measured on this
branch: 5,801-line / 200-function module → `analyse` 35 ms, `guardClauses` 9 ms, `newlyLateGuards`
59 ms. At 8 contenders that is ~0.5 s of new work per decision on a repository-class file, where it
was 0 before. Cache the clause list per (module, block).

### 16. LOW — several "failing-first" assertions fail on main only because the symbol does not exist
Re-running the new files against `d86c385 -- src/`: `late-guard.test.ts` fails 11/12 at *import*
(`guardClauses`/`isLateGuard` unexported), including the sweep `adds ZERO late guards` — that one
asserts a fixture property, not the mechanism, and is vacuous as a failing-first record.
`gold-free-pool.test.ts` change-1 tests are wording assertions (fixture, not mechanism). The
genuinely mechanism-level failing-first records are: `sites.test.ts` "no Jev probability anywhere
still yields replace sites", `jev-off-fallback.test.ts` kth-L12/mergesort-L17 and the spent-budget
case, the three `deadline-growth.test.ts` `served` cases, and `gold-free-pool.test.ts` "the pool is no
longer committed by a code rule". Note `sites.test.ts` "a Jev that DID answer keeps the top-3
per-function cut" **passes on main** — it is a regression pin, not failing-first.

---

## Verified as holding (tried, did not break)

- `tsc --noEmit`, `scripts/no-any.mjs`-adjacent lint not run, `scripts/jev-contract.mjs` ok
  (32 sites, 2 four-clause blocks, 30 allow-listed) — the new `signals` state does not add a call site.
- `test/unit/synth/search` + `test/unit/bench` + `test/unit/synth/llm` = 59 files / 792 tests pass;
  the six new/changed files 14 / 211 pass.
- `POOL_SUSPECT_SIGNALS` really is `{late_guard, mutates_new_argument}` and `deletes_statement` /
  `adds_special_case` really are excluded (commit 6e22007 is a genuine fix of the `units` regression).
- `preferLlmInCluster` still fires *before* `poolSuspect`, so a mixed seed+LLM cluster is unaffected.
- `contenders.length === 0` short-circuits before the signals are computed; `arbitrationSignals`
  keying by `candidate.id` matches `arbitrateState`'s lookup.
- Gold sweep: I re-ran it independently — 106 gold files, 0 fire. The 7 position > 0 gold guard
  additions are silent for legitimate reasons (condition-rewrite arm, or `reads=0 & binds>0`).
- `pylint-dev__pylint-4970`, `django__django-14725` and `sympy__sympy-11618` golds do **not** fire
  (`isDeclaration` correctly ignores the docstring; the `if/else` shape is correctly not a guard clause).
- `hunk_merge`'s nested-`def` false positive really is fixed by `isDeclaration` (commit df5554f).
- `if True: return` really is silent (commit e4b2330); `x = compute(); if x is None:` really is silent.
- `mergeStepsSummaries` / `addStepRow` union logic is correct for every ordering of
  `undefined | 'served' | 'always' | 'mixed'`.
- `deadlineGrowthFrom` is strict (`'Served'`, `''` → `'always'`); `always` is behaviourally
  byte-identical (the only guarded lines are `floorMs`/`growths` and the emit string).
- A legitimate all-`mutates_new_argument` pool (three in-place `items.sort()` fixes) is **not**
  auto-refused: it is arbitrated and committed at 0.45 ≥ 0.3 because the pick carries one signal.
  The danger there is §9 (a second co-firing signal raising the bound to 0.7), not the rule itself.
- `escapedAnchors` is bounded by `maxChoiceOptions` upstream (`listingFor`), so a 5,000-line file
  cannot blow up the listing; the memory growth is ~40× the previous anchor count, not unbounded.

---

## Likely to lose solves

**Dev / in-sample ladder**
- `stats` — branch admits (0.49 refusal). Confirmed here to be over-determined: §1 (all four recorded
  candidates flagged, including the gold-shaped `if not values`), §2 (drop instead of hold), §4 (the
  new Q16 wording marks the gold's own variable choice down), §9 (bound forced to 0.7).
- `token_bucket` — branch admits (0.39).
- `units` — repaired by 6e22007, but still exposed: its pool now travels through `poolSuspect` if any
  variant inserts a guard, and the Q16 wording changed under it.
- `account`, `csv_schema` (both files), `import_and_guard`, `route_match`, `possible_change` — their
  golds add a guard at position > 0. The gold text itself is silent today, but any LLM/seed variant
  that phrases the same guard over a root a prior statement mentions (e.g. `self`, or the local the
  traceback names) fires `late_guard`, and a pool of such variants is now dropped rather than ranked.
- `detect_cycle` — the intended win; no reason to doubt it.

**Fresh / SWE-bench-verified-30**
- `sympy__sympy-17139` — the gold patch itself carries `late_guard` (§1). Any pool of candidates around
  it is `poolSuspect`, and the correct one needs general ≥ 0.7 on a state that has just told Jev the
  patch "adds a guard behind statements that already use the value it guards".
- Any Django/pylint/sympy task whose fix guards `self.<attr>` — the `self` root collapse (§1) makes
  every such guard late unless it is the literal first statement of the method. `django__django-14725`'s
  gold happens to survive only because its `if/else` shape is not classified as a guard clause.

**Ring 1 `--jev off`**
- `kth` still fails (branch admits) — §12 explains why the `escapedAnchors` widening cannot help while
  `REPLACE_SITES_MAX = 6` cuts in file order.
- Any multi-function `--jev off` or Jev-unsure task where *one* Choice answers and another escapes:
  §5 means the escaped function contributes **zero** replace sites, i.e. iteration 3's fix does not
  apply. `mergesort` (nested `merge` def, gold at L17 after it) is in this class when the module-level
  Choice answers.
