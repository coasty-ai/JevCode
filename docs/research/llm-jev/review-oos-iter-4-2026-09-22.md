# Adversarial review — `oos-iter-4` @ 822be5b, re-checked against the fix pass b3c28a0

Reviewer: an independent read-only review, 2026-09-22, read-only in detached probe worktrees (822be5b, b3c28a0, main 5ac0042). Branch NOT merged on this report: fix pass 2 ordered on the branch (rulings in the merge record).

Read-only. Probe worktrees `/tmp/review-iter4` (822be5b), `/tmp/review-iter4b` (b3c28a0),
`/tmp/review-main` (5ac0042); all three removed after the run, no branch touched.
Reviewed under the ordered configuration `POOL_SUSPECT_SIGNALS = {mutates_new_argument,
guards_derived_local}` — which is what b3c28a0 actually ships.

Targeted suites at b3c28a0 (`--maxWorkers=2`): `code-order`, `signal-sweeps`, `sites`,
`guard`, `late-guard`, `gold-free-pool` → **6 files / 199 passed**. At 822be5b, 193 passed.
No `src/core/types.ts` or `src/bench/types.ts` change in either commit; `SuspicionSignal`
does not escape `guard.ts`; no `StepsSummary` consumer touched. **Item 7: clean.**

---

## Defects, most severe first

### 1. CONFIRMED — `guards_derived_local` still fires on a large class of correct fixes, and it is now the ONLY signal carrying the gold-free-pool rule
`src/synth/py/structure.ts:1792` (`guardsDerivedLocal`), `src/synth/search/guard.ts:746`
(`newlyDerivedLocalGuards`), pool set at `guard.ts:215`.

b3c28a0 fixed 7 of the 8 false positives I found at 822be5b (`log(result)`, `len(items)`,
`visited.add(node)`, re-bind, comprehension, two-parameter derivation, `assert`). **Six
correct shapes still fire at b3c28a0**, run through `newlyDerivedLocalGuards` exactly as
`signal-sweeps.test.ts` does:

| input (before → after adds the guard) | b3c28a0 |
|---|---|
| `items = list(xs); items.sort(); if not items: return None; return items[0]` | **FIRES** |
| `s = text.strip(); t = s.lower(); if not s: return ""; return t[0]` | **FIRES** |
| `cfg = dict(opts); v = cfg.get("k"); if not cfg: raise ValueError(...)` | **FIRES** |
| `rows = list(src); rows.append(1); if not rows: raise ValueError(...)` | **FIRES** |
| `ys = sorted(xs); if xs: first = ys[0] else: first = None; if not ys: return None` | **FIRES** |
| `ys = list(xs); try: first = ys[0] except IndexError: first = None; if not ys: return None` | **FIRES** |
| `ys = sorted(xs); def g(): return ys[0]; if not ys: return None` | silent |

Two distinct mechanisms, both the `late_guard` lesson at one remove:

**(a) `dereferencesPath` conflates None-ness with emptiness.** The rule's stated
justification (`structure.ts:1754`) is "a use the value the guard rejects would have made
fail". For a `X is None` guard an attribute access is such a use. For a `not X` (emptiness)
guard it is **not**: `items.sort()`, `s.lower()`, `cfg.get(k)`, `rows.append(1)` all succeed
on an empty container/string. `dereferencesPath` accepts `R.` / `R[` / `R(` regardless of
what the clause tests, so every "add an emptiness guard in front of the indexing that
crashed, after a harmless method call" fix — the single most common shape of a real
`IndexError` patch — is called an overfit. Fix: when the clause is a truthiness test
(`not X` / `if X:` / `len(X) == 0`), require an indexing/`.pop()`/iteration-consuming use,
not a bare attribute or method call; when it is `is None`, `R.`/`R[`/`R(` is right.

**(b) `before` ignores nesting and branch reachability.** `structure.ts:1790`:
`mod.statements.filter(s => s.blockIndex === block.index && s.startLine < g.line)` — and
`blockIndex` is the enclosing **def**, so a dereference inside an unrelated `if` branch, an
`else`, a `try` whose `except` already handles the empty case, or a `while` body all count as
"in front of" the guard. Rows 5 and 6 above are that. (This is also why `detect_cycle` fires
at all, so it cannot simply be tightened to same-suite without re-checking the record.)

**Consequence under the ordered set.** `guards_derived_local` is one of two pool signals, so a
false positive here is exactly the failure ruling 1 forbids: a pool the gold is in gets called
gold-free. On the lone path it is worse and immediate — measured, the `items.sort()` fix
yields `['adds_special_case','guards_derived_local']`, i.e. 2 signals ≥ `STRONG_SIGNALS_MIN`,
so **every one of these correct fixes faces the 0.7 vouch bound and is held**.

**Status at b3c28a0: OPEN** (improved, not closed).

### 2. CONFIRMED — the 198-gold sweep that licenses `guards_derived_local` has power over 11 patches
`test/unit/synth/search/gold-corpus.helpers.ts`, `signal-sweeps.test.ts:93`.

Counted directly (patches where a `def` pair exists AND the patch adds a guard clause AND the
def has a non-empty `parameterDerivedLocals`, i.e. where the rule can return true at all):

| corpus | patches | parse | have a `def` | have derived locals | add a new guard clause | **can fire** |
|---|---|---|---|---|---|---|
| QuixBugs | 41 | 41 | 41 | 34 | 3 | **3** |
| ladder | 65 | 65 | 65 | 53 | 14 | **8** |
| SWE-bench Verified | 92 | 49 | **12** | **1** | 1 | **0** |

"0 fires on all 198 golds" is therefore "0 fires on the 11 golds that could have fired", and
the SWE-bench corpus — the only real-world one — contributes **zero** evidence, because 43 of
the 92 hunk images do not parse and only 12 of the survivors contain a `def` header at all.
This is precisely how `late_guard` passed its sweep in iteration 3. Ruling 1's "a sweep of
every gold patch … shows zero fires" is being met in letter, not in force. Fix: the sweep
should report **power** (how many patches could fire) alongside fires, and a signal should not
join the pool set on a sweep whose power is in single digits. Unchanged at b3c28a0.

### 3. CONFIRMED — "Jev-ON with a real ranking is byte-identical" is false; the six kept sites change
`src/synth/search/sites.ts:1136` (step-4 tail split). Unchanged by b3c28a0.

The NaN comparison is not "the no-Jev case". `Infinity - Infinity` arises whenever **two tail
sites both lack a spectrum row**, which is routine with full coverage and full Jev answers:
`statementSiteFor` spans start at the statement's first line, which usually has no SBFL row of
its own, so span sites carry `sbflRank = +Infinity` and `jev = 0`.

Reproduced with one file, identical probe run in both worktrees (real localiser, real Q5
Choice favouring L9, real non-flat Q5n, real spectrum):

```
def solve(xs, k):          # spectrum ranks L3 (rank 1) and L6 (rank 2) — both continuation lines
    total = sum(
        v for v in xs
    )
    limit = max(
        k, 1
    )
    if total > limit:
        return total - limit
    return limit - total
```

* `localized.sites.some(s => s.evidence.jevProbability !== undefined)` → **true** (a real Q5 ranking)
* 5ac0042 → `replace order: 9,10,8,3,6,2,5`; ordered `r9,i10,i9,r10,r8,r3,r6,r2,r5,…`
* 822be5b and b3c28a0 → `replace order: 9,10,8,3,6,5,2`; ordered `r9,i10,i9,r10,r8,r3,r6,r5,r2,…`

At the default `REPLACE_SITES_MAX = 6` the **kept set differs**: main keeps L2, the branch
keeps L5. So the sentence in the commit message, in `docs/LLM-JEV.md` ("a Jev-ON trajectory
with a real ranking is byte-identical") and in the `sites.ts:1136` comment ("the only order
this changes is the one that was NaN") is wrong, and the pins that are said to establish it
(`sites.test.ts`'s `[9, 7, 15, 8, 2, 4]`) only happen to have no two infinite-rank tail sites.
Fix: either state the real scope of the change ("the relative order of tail sites the spectrum
did not rank, in every run"), or pin a Jev-ON mixed finite/infinite case and accept it as a
deliberate behaviour change; do not carry an identity claim the code does not honour.

### 4. CONFIRMED — `widenedReachable` fires on Jev-ON goals that carry a real Jev ranking
`src/synth/search/subgoal.ts:439`, call at `:1503`. Unchanged by b3c28a0.

`sites.some(s => s.evidence.jevProbability !== undefined)` is the proxy for "a Jev ranking
exists", but `evidence.jevProbability` is written **only** by Q5 anchors. The Q5n Noul ranking
— the one the single-file path actually uses — lives in `GoalSites.lineNouls` and never
reaches site evidence unless the same line was also a Q5 anchor. So a Jev-ON goal whose line
Choice escaped (`line Choice escaped` appears in the branch's own `kth` record four times)
but whose Q5n answered strongly has **no `jevProbability` anywhere** and takes the new clause.

Reproduced at b3c28a0 (Jev ON, every Choice escaped at 0.9, Q5n = 0.11/0.14/0.20/**0.90**/0.16,
one SBFL row):

```
sites: r5,r4,r6,r3,i5,i6,i4,i3,i2
any jevProbability: false
q5n probabilities: s.py:2=0.11 … s.py:5=0.90 …
shortCircuit: L5                      <-- Jev was confident enough to short-circuit
main gate (every site exhausted): false
branch gate widenedReachable:     true
```

A goal Jev short-circuited is being treated as "no Jev evidence anywhere, so the six are a
guess". WIDENED now runs with five insert gaps still open, reordering the rest of the step.
Fix: gate on the evidence that actually exists — `goal`'s `lineNouls`/`q5Escape`, or a flag set
by `buildGoalSites` when no Jev ranking of any kind was obtained — not on `jevProbability`.

### 5. CONFIRMED — the flat-Q5n rule silently discards a genuine single-line answer and loses the short-circuit
`src/synth/search/sites.ts:1044`.

```ts
const flat = new Set(r.probs.values()).size <= 1;
if (flat && r.probs.size > 1) notes.push(...);
const ranked = flat ? [] : byDesc(...);
```

The `r.probs.size > 1` guard is on the **note**, not on the rule. A function with exactly one
code line produces `probs.size === 1`, so any answer at all is "flat" and is dropped with no
note. Reproduced with the real localiser on `def scale(v, k): return v * k`, Jev answering
0.95:

| | 5ac0042 | 822be5b / b3c28a0 |
|---|---|---|
| `shortCircuit` | **L2** | **null** |
| notes | `q5n short-circuit on L2` | *(nothing)* |

Fix: `const flat = r.probs.size > 1 && new Set(r.probs.values()).size <= 1;`.

On the empirical question the brief asked: I scanned every `decisions.jsonl` in
`bench/results/iter1-*/runs/*` and `~/.jevcode/runs/2026092*` (1,180 runs, 903 Q5n request
groups). **401 groups are flat and every one of them is exactly 0.5**; no run mixes a flat
group with a non-flat one, and 102 runs have `0.5` as their only Noul value — i.e. every flat
Q5n on record is the `--jev off` inert answer, and a real Jev never returned one. The rule is
sound on the records; only the `size === 1` edge and the missing note are defects.

### 6. CONFIRMED — the `continuation` prior ranks a fragment of a statement above the statement
`src/synth/search/sites.ts:626` table, `statementKindPrior` at `:~610`.

`continuation` = 1.71 > `return` = 1.68, so on

```
def total(rows, rate):
    return (
        sum(r.amount for r in rows)
        * rate
    )
```

`orderByCodeEvidence` returns `3,4,2` — it offers `* rate` as a replace site ahead of
`return (`. Replacing one physical line of a multi-line statement with a generated line is a
syntax error in almost every case, and the harness already builds a whole-statement span site
for exactly this reason. The number is a measurement artefact: the corpus credits **every**
physical line of a multi-line statement the gold rewrote as a `continuation` gold (16 of the 20
`continuation` golds are SWE-bench hunks), while a replace site means "rewrite this one line".
Fix: either drop `continuation` from the table (score it at the base rate) or count a rewritten
multi-line statement once, at its first line.

### 7. CONFIRMED — the 43 unparsed SWE hunks are recoverable, the doc reports them as 30, and the table moves when they are included
`docs/LLM-JEV.md:428` says 43; the item-B table at `:511` and the item-C table at `:531` say
**30**; `signal-sweeps.test.ts:93` pins **43**. The sweeps therefore cover 155 of 198 patches
(78 %), and two of the three tables in the doc overstate it.

The 43 are not unanalysable data, they are a harness limitation: the failures are 19
`unindent does not match any outer indentation level`, 18 `EOF in multi-line string`, 6 `EOF in
multi-line statement` — all consequences of `hunkPatches` cutting a window out of the middle of
a file. Prepending a nested `if True:` prologue matching the fragment's starting indent and
closing an open triple-quote **recovers all 43** (`recovered=43 stillUnparsed=0`). Recomputing
the prior over all 198:

* gold lines 161 → **209**, background 2,171 → **2,444**, `r0` 0.0742 → **0.0855**
* `continuation` 1.71 → **1.43**, `return` 1.68 → **1.71** (they swap; `return` becomes the top
  non-`while` kind), `assert` 0.93 → 0.92 moves ahead of `for` 0.95 → 0.91, `raise` 0.21 → 0.18
* everything else moves ≤ 0.07 and the rank order is otherwise unchanged

So the table is broadly robust — but `continuation` 1.71, the one value that misbehaves
(defect 6), is exactly the value the 43 exclusions inflate. `GOLD_KIND_BASE_RATE` is also
corpus-dependent and would have to move.

### 8. CONFIRMED — the doc's `5ac0042` `kth` number is wrong
`docs/LLM-JEV.md:466` and `:673`, and the commit message: "On `5ac0042` the same inputs give
`[2, 3, 4, 10, 12, 14]` with the inert-0.5 Q5n in front". Measured, with the identical probe
(real localiser, `jevOffAnswer` for every question, no SBFL) in `/tmp/review-main`:

* 5ac0042 → `six: 2,3,4,6,7,9` (no L12), `lineNouls` all 0.5
* b3c28a0 → `six: 10,12,14,9,2,3`, note `q5n ignored: one value (0.50) on all 11 lines ranks nothing`

`code-order.test.ts:84` states the correct number (`[2, 3, 4, 6, 7, 9]`). The doc's
`[2, 3, 4, 10, 12, 14]` — which has the gold L12 inside it — contradicts both the measurement
and the branch's own test, and it is the number the "failing-first by mechanism" label at
`:673` cites. Fix the two doc lines.

### 9. CONFIRMED — the `dead_guard` narrowing blinds it on the shape it was written for
`src/synth/search/guard.ts:1038` (`subjects.some(s => occursIn(s, fnText))`).

```
def f(node):
    total = 0
    total += node.successor
    return total
```
patched with `flag = None` + `if flag is None: return 0` (a guard on a name the patch itself
introduces and never uses — a textbook dead guard) now yields `['adds_special_case']`; the same
guard over `total` still yields `['dead_guard','adds_special_case']`. The narrowing is
defensible (it is what `pytest-dev__pytest-10081`'s gold needed), but it is a loss of coverage
on the overfit side and neither the doc nor the comment records it. At b3c28a0
`dead_guard` is lone-passer-only, so the blast radius is one Q16 question — LOW, but worth a
line in the doc.

### 10. CONFIRMED — the `duplicates_block` growth rule lets a MOVED block escape
`src/synth/search/guard.ts:988` (`normalisedLineGrowth`).

A candidate that inserts two lines already present in the function **and** deletes the
originals has growth 0 for both keys and no longer fires:
`copied: ["duplicates_block","adds_special_case"]` vs
`moved: ["deletes_statement","adds_special_case"]`. Growth is also computed over the whole
**file**, so a duplication in one function cancels against a deletion of a normalised-equal
line in another. `wrap`'s copied loop still fires (pinned, passes). Exposure on the records:
about 10 of the 104 parsed lone-passer decisions in the replay window carry `duplicates_block`
or `dead_guard`; I could not re-derive which of them flip without the per-decision patch
images, so this is a **PLAUSIBLE** loss, not a measured one. Lone-passer-only at b3c28a0.

### 11. CONFIRMED (LOW) — `failureVocabulary` is unbounded on the failure text and admits traceback noise
`src/synth/search/sites.ts:~600`. `testLiterals` is capped at 40 and `taskIdentifiers` at 60,
but the third loop (identifiers of `call`/`expected`/`actual`) has no cap. One ordinary
five-frame pytest traceback yields **55 vocabulary entries**, including `Traceback`, `most`,
`recent`, `last`, `tests`, `test_x`, `py`, and every path component (`home`, `user`, `project`,
`src`, `pkg`, `util`). Overlap on real code lines was 6/3/2/1 in the probe, so step 2 still
discriminated — but the failure text is the one input with no bound, and a long assertion diff
would saturate it. Fix: cap the third loop like the other two, and drop tokens that appear only
inside a `File "…", line N, in …` frame.

### 12. CONFIRMED (LOW) — the round-robin caps the failing function at one of the six
`src/synth/search/sites.ts:~700`. With ≥ 6 function groups in the tail, the six kept sites are
the heads of the six best groups, so the failing call's own function contributes exactly one.
Measured on a 5,200-line / 200-function file with 400 sites: first eight are
`fn_7:187, fn_2:57, fn_3:82, fn_4:107, fn_8:212, fn_9:237, fn_12:317, fn_13:342` — one site in
`fn_7` (the failing call) and five elsewhere. That is still better than main's "first six lines
of the file", and on a single-function localisation it degenerates correctly (`single-fn
order=2,3,4`), but the test only covers two functions. Cost is fine: 5.0 ms first call, 2.8 ms
second, deterministic across runs and across reversed input.

### 13. CONFIRMED (LOW) — `code-order.test.ts` makes a src constant hostage to `bench/data`
Adding one new ladder task (`bench/data/ladder/tasks/zzprobe/{src,gold}/z.py`, a two-line file)
breaks two unit tests at b3c28a0:
`signal-sweeps.test.ts` "sweeps … 198 patches" (a hard-coded count) and `code-order.test.ts`
"matches `GOLD_STATEMENT_KIND_PRIOR` to two decimals" (exact 2-dp equality against a table
hard-coded in `src/synth/search/sites.ts`). So adding a ladder task is now a **src** change.
The doc frames this as a feature ("fails if the corpus moves"); the practical effect is that
the next ladder task added breaks the build until someone edits a constant. Fix: assert the
rank ORDER and a tolerance, or key the assertion on a corpus fingerprint so it skips (loudly)
when the corpus changes.

### 14. PLAUSIBLE (method) — item D's "held site's file in the final `model_patch.diff`" is mostly vacuous
I reproduced item D independently by parsing the `decide` note texts over
`bench/results/iter1-*/runs/*` plus `~/.jevcode/runs/20260922-00…18…`:

* **591 records**, **104** parsed lone-passer decisions with a `general` (+35 with none, +3
  unparsed = the doc's 142) — matches
* **28** rows at bound 0.7, over 27 distinct runs — matches
* the 0.7 signal-combination table matches the doc exactly (24 / 1 / 1 / 1 / 1)
* **0 of 28 with `general < 0.3`** — matches
* **28 of 28** have the held site's file in the final `model_patch.diff` — matches

Two caveats on the method rather than the arithmetic:
1. **20 of the 28** come from runs whose final patch touches exactly **one** file, so for those
   the check can only ever come out positive. It is evidence that the run eventually edited the
   same file, not that the held candidate was committed and not that the hold was free.
2. The `units` case: I count **15** distinct runs, not 13, and **3** of the 28 rows are
   commit-with-reserve-spent notes rather than holds, not 1. Spot-checking three
   (`20260922-042515-xeeqx57y`, `-070741-psnkldj7`, `-080839-acsmk3cx`) the final patch is
   byte-identical in all three and is the gold **algorithm** (`for number in
   sorted(DURATION_UNITS, key=len, reverse=True)`), but it is not the gold: the gold is
   `text.strip().lower().replace(" ", "")` and the committed patch is `text.lower()`. It happens
   to be behaviourally equivalent on these inputs only because `float()` tolerates surrounding
   whitespace. "Gold-equivalent" is defensible; "finish with the `units` gold algorithm" would
   be the accurate phrasing, plus the dropped normalisation.

The conclusion item D draws (leave the lone path counting every signal) is not undermined by
any of this.

---

## Verified as holding (tried, did not break)

* **The two-signal pool set keeps the `detect_cycle` class A′ result.** Patching
  `POOL_SUSPECT_SIGNALS` down to `{mutates_new_argument, guards_derived_local}` on the 822be5b
  worktree left both class A′ tests green; only the two assertions that name the five-member
  set failed. At b3c28a0 the survivors are `dc_return`, `dc_return_alt`, `dc_overfit`, each
  carrying `guards_derived_local`, and the pick's bound is 0.3 (one swept signal), as the fix
  pass states. The branch's headline claim ("`detect_cycle`'s guard pools are gold-free pools
  now") **is true under the ordered configuration**.
* **`guardSubjectsIn`'s keyword-head filter is tight.** `not in` → `[]`; `not y` → `["y"]`;
  `y is None` → `["y"]`; `y is not None` → `[]`; `not node.successor` → `["node.successor"]`;
  `not y and not node` → `["y","node"]`; `y not in xs and not node` → `["node"]`;
  `while not y` → `["y"]`; `lambda_name` survives (not a keyword). `PY_KEYWORDS` has no soft
  keywords (`match`, `case`, `type`), so no legitimate subject is dropped.
* **`orderByCodeEvidence` is deterministic and cheap.** Same order from the same input and from
  the reversed input; Map iteration is insertion order and `a.i - b.i` is a total final
  tiebreak; no two tail sites can share a key (the `replace` Map dedupes). 5.0 ms / 2.8 ms on
  400 sites over a 5,200-line file. `sites.length <= 1` returns as-is; the round-robin
  terminates (each group is dense).
* **`callDistance` handles methods, nested defs and absent functions.** `repo.fetch("k")` →
  `fetch:4 _decode:8 …` (the callee found through `self._decode`); `top([1])` →
  `top:15 inner:12 …`; `not_here(1)` and a bare pytest node id fall back to "everything is
  distance 2" without error; a lambda bound to a name is simply not a function and gets no
  group of its own. `block.name` is unqualified on both sides, so the `.split('.').pop()`
  asymmetry is harmless.
* **A real Jev never returned a flat Q5n** on any record (401 flat groups, all 0.5, all in
  runs whose every Noul is 0.5).
* **`wrap`'s copied loop and `detect_cycle`'s `tortoise.successor`** still fire after the item-C
  narrowings (pins pass); `dead_guard` on a subject the pre-patch function holds still fires.
* **No records/contract change**: nothing in `src/core/types.ts` or `src/bench/types.ts`,
  `SuspicionSignal` never leaves `guard.ts`, no `StepsSummary` consumer touched.
* **Item D's arithmetic** reproduces independently (see 14).

---

## Likely to lose solves

* **Dev 28 / fresh 18 — any task whose fix is an emptiness guard.** Defect 1(a). `if not X:`
  added in front of the indexing that crashed, behind a harmless `X.sort()` / `X.lower()` /
  `X.get()` / `X.append()`, gets `guards_derived_local` + `adds_special_case` = 2 signals = the
  0.7 lone bound, and in a pool makes the pool gold-free. Ladder `stats` and `inventory` are the
  shapes in-sample; on SWE-bench Verified the `sympy` and `pytest` list/dict-normalisation
  patches are the same family. This is the single largest regression risk in the branch.
* **Ring 1 `kth`** — unchanged by iteration 4 (the branch says so itself): the localisation half
  is fixed, the `k - num_lessoreq` generation half is not. Also note defect 8: on 5ac0042 the
  six were `[2,3,4,6,7,9]`, so the gold was never "barely inside by accident" — iteration 4's
  gain here is real and larger than the doc's own narrative suggests.
* **Ring 1 `gcd` / `tagcloud` / `units` and every Jev-ON bench arm** — defects 3 and 4 mean the
  Jev-ON arms are **not** a no-op re-run of 5ac0042: the replace-site set changes whenever two
  tail sites share `rank = +Infinity` (multi-line statements, weight-0 anchors), and WIDENED
  now opens early on any goal whose Q5 escaped. Whatever the next measurement shows for Jev-ON,
  it is measuring a changed mode, so the iteration-3 Jev-ON baseline is not comparable.
* **`mergesort` (the one recorded Ring-1 gain)** — it is a `--jev off` gain and rests entirely
  on the code order; nothing here threatens it.
* **Multi-line-statement tasks in SWE-bench Verified** — defect 6 spends replace-site budget on
  continuation fragments ahead of the statement span. SWE-bench golds are where multi-line
  statements live (16 of the 20 `continuation` golds), so this costs exactly where it was
  measured to help.
* **Next ladder task added** — defect 13 breaks the unit suite until a src constant is edited.

## Ordered fix list for the fix pass (everything still open at b3c28a0)

1. Defect 1(a): make the dereference test depend on what the clause tests (None vs emptiness).
2. Defect 1(b): restrict `before` to the guard's own suite, or require the dereference to be
   unconditionally reachable; re-check `detect_cycle` after.
3. Defect 3: withdraw the byte-identity claim (commit message, `docs/LLM-JEV.md`,
   `sites.ts:1136` comment) and pin a Jev-ON mixed finite/infinite case.
4. Defect 4: gate `widenedReachable` on `lineNouls`/Q5-escape, not on `evidence.jevProbability`.
5. Defect 5: `const flat = r.probs.size > 1 && new Set(...).size <= 1;`.
6. Defect 6: drop or re-measure `continuation`.
7. Defect 2: report sweep power beside sweep fires; defect 7: fix 30 → 43 in the two tables
   (and, if the prior is re-measured, recover the 43 — it is a 10-line change to `dedent`).
8. Defect 8: fix the `[2, 3, 4, 10, 12, 14]` lines.
9. Defects 9, 10, 11, 12, 13, 14: record them; none needs to block the merge.
