# jev-only ladder run 4: where the 58 blocked/declined steps went, and why `account` missed

Bench `20260920-213752-508a51` (`bench/results/jev-only-ladder-4/`), 12 ladder tasks, jev-only, decider
`typesafe/jev-1.13-20260917`, max 20 steps. Result 11/12, steps-to-solve mean 10.64 / median 9,
137 steps used, 58 proposals not executed (28 blocked + 30 declined; the bench's `blocked` column is
their sum), 16 loop trips, 13 replans, $0.137. Runs read from `~/.jevcode/runs/<runId>/{transcript.log,
steps.jsonl,decisions.jsonl}`. No source was changed for this analysis.

| task | pass | steps | stop | blocked+declined | patches executed | hunks | what the non-executed steps were |
| --- | --- | --- | --- | --- | --- | --- | --- |
| account | **miss** | 20 | max_steps | 14 (11+3) | **0** | 3 | 4 subset `run`, 5 partial `done`, 5 `read` |
| calendar_utils | pass | 20 | max_steps | 11 (2+9) | 3 | 3 | 5 post-patch full `run`, 1 subset `run`, 5 `read` |
| inventory | pass | 20 | max_steps | 6 (1+5) | 3 | 2 | 4 post-patch full `run`, 2 subset `run` |
| units | pass | 20 | max_steps | 10 (8+2) | 3 | 1 | 9 green `done`, 1 `patch` |
| shipping | pass | 10 | replan_stop | 6 (4+2) | 1 | 1 | 3 green `done`, 2 subset `run`, 1 `patch` |
| table | pass | 9 | replan_stop | 5 (2+3) | 1 | 3 | 3 green `done`, 2 subset `run` |
| textstats | pass | 13 | complete | 5 (0+5) | 2 | 2 | 1 post-patch `run`, 1 subset `run`, 3 `read` |
| grades | pass | 9 | complete | 1 (0+1) | 2 | 2 | 1 `patch` |
| events, profiles, stats, tagcloud | pass | 4 each | complete | 0 | 1 each | 1 | – |

Headline: **every solved task that ran to `max_steps` or `replan_stop` had its last hunk fixed and the
synthesizer's own baseline green well before the end** (calendar_utils step 11, inventory 16, units 9,
shipping 7, table 6). The tail steps were the engine refusing either the verifying `run` (calendar_utils,
inventory) or the `done` (units, shipping, table). `account` is the one genuine search miss and it never
proposed a patch at all.

## 1. `account` (3 hunks, miss, 20 steps, 14 not executed)

**Hunks fixed: 0 of 3. Patches proposed: 0.** `model_patch.diff` is 0 bytes; no step in `steps.jsonl` has a
`patch` action. The 14 non-executed proposals were 4 goal-subset `run`s (steps 3 declined, 4/5/6 blocked),
5 partial `done`s (9, 12, 15, 19, 20, all blocked) and 5 `read`s (11, 13 declined; 14, 16, 17 blocked).
So the failure class is **not** `engine_rejected`: nothing the engine refused would have changed the
workspace. It is a search failure with two distinct causes, one per goal, plus 11 steps of churn.

### 1.1 The ledger split the three bugs into two goals

Step 1 baseline: `synth baseline: 7/10 pass, 3 failed` → `synth ledger: fixed 0, open 2, parked 0`.
`plan.remaining` (steps.jsonl step 1):

```
fix tests/test_account.py::test_withdraw_exact_balance_is_allowed, +1 more in src/account.py
fix tests/test_account.py::test_statement_numbering_starts_at_one in tests/test_account.py
verify the full test suite passes
```

`g1` = {`test_withdraw_exact_balance_is_allowed`, `test_transfer_moves_money`}: both tests raise
`InsufficientFunds` at `src/account.py:37` inside `withdraw`, so `clusterByFrames`
(`src/synth/search/goals.ts:301`, key = frame kind|path|function) puts them in one goal although they need
two different fixes (`>=`→`>` at line 36; `dst.withdraw`→`dst.deposit` at line 53).
`g2` = {`test_statement_numbering_starts_at_one`}, whose only frame is the assertion in the test file
(hence "in tests/test_account.py").

### 1.2 g1: the gold lines were enumerated, ranked first by Jev, and tested — as partials (partial trap)

Steps 3 and 4 searched g1 (`attempt 1`, `attempt 2`, "picked by jev"):

```
[step 3] synth search: g1 budget (phase SEEDS, RANK, sites 8, requests 29, runs 906, plausible 0) (candidates=2119, tested=906)
[step 4] synth verify: g1: 5 tested on 8 lanes (2 partial, 1 regressed, 2 unchanged); runs left 697, test wall left 2 s
[step 4] synth verify: g1: 5 tested on 8 lanes (1 partial, 4 unchanged); runs left 692, test wall left 1 s
[step 4] synth search: g1 budget (phase SEEDS, SIEVE, sites 8, requests 9, runs 821, plausible 0) (candidates=1075, tested=821)
[step 4] synth ledger: fixed 0, open 1, parked 1
```

Jev localised both hunks exactly (decisions.jsonl, stage `propose`): `where` → `account_withdraw` 0.92;
`buggy_line` → `line_36` p=1.00 (withdraw) and `line_53` p=0.88 (transfer). The `fix` Choice ranked the
gold first at both sites:

| step | `fix` candidate ranked first | p | conf |
| --- | --- | --- | --- |
| 3 | `        if amount > self.balance:` | 0.97 | 0.96 |
| 4 | `        if amount > self.balance:` | 0.97 | 0.96 |
| 4 | `    dst.deposit(amount)` | 0.98 | 0.97 |

Neither can be `plausible` under §2.6 (`plausible = passes every test of the goal subset`): each fixes one
of g1's two tests and leaves the other failing, so each is a `partial` (the "2 partial" / "1 partial" of the
step-4 batches, found with 1–2 s of test wall left). The designed escape is `pairsOfPartials`
(`src/synth/search/bases.ts:360`: two partials at different sites with disjoint `newlyPassing`, exactly
this case), but it never ran:

1. both steps ended on the step budget (`outcome: budget`, ~80 s test wall per step, 8 lanes, run median
   0.45–0.9 s), so `visitPairs` (`src/synth/search/subgoal.ts:547`) was not reached;
2. the second budget hit parked g1 (`noteBudgetHit`, `goals.ts:549`; `MAX_CONSECUTIVE_BUDGET_HITS`), and
   `index.ts:513` calls `forgetGoal(mem, goal)` on park, which drops the remembered partials
   (`bases.ts:402-404`);
3. g1 was never reopened: `change_approach` reopens only the newest parked goal
   (`directive.ts:168`, `.at(-1)` → g2 at step 18).

Class for g1: **partial trap** (goal clustering merged two bugs; the acceptance rule then rejected each
correct half; the pairing hatch was starved by the budget and its inputs discarded on park).

### 1.3 g2: the gold line was not enumerated until step 18, then ranked p=1.00 but the step ran out (budget/timeout miss)

Steps 5–6 (SIEVE, 10 sites, 807 + 735 tested, `plausible 0`): `where` → `account_statement` 0.83,
`buggy_line` → `line_44` 0.67 (the gold line), but the string `enumerate(self.history, 1)` appears in no
step-5/6 decision — the seed sources did not produce it at that site; the three `fix` questions of step 5
answered `none_of_these` 0.91–1.00. g2 was parked at step 6 ("2 consecutive budget-hit steps").

Step 18, after `change_approach` ("reopened g2; rotated source order of g2 (1); sites of g2 rebuilt;
site beam 6 → 10; WIDENED phase enabled"): `buggy_line` → `line_44` 0.77 and

```
fix: choice=candidate_as conf=1.00   candidate_as p=1.00: "        for number, entry in enumerate(self.history, 1):"   <== GOLD
```

yet `synth search: g2 budget (phase SEEDS, RANK, sites 11, requests 30, runs 442, plausible 0)
(candidates=1734, tested=442)`. The first batch of that step reads
`g2: 4 tested on 8 lanes (4 timeout); run median 11550 ms` against 0.4–0.8 s medians everywhere else in the
run (the bench ran 12 tasks × 8 lanes concurrently). RANK mode tests Jev's top picks first, so the gold was
very probably in that batch and classified `timeout` under load; the run artefacts do not record per-candidate
results, so this is inference from ordering, not proof. Step 19 parked g2 again ("3 searches without a
commit"). Note the uncommitted working-tree changes to `src/synth/search/budget.ts` and
`src/synth/sieve/runner.ts` (load-scaled per-case timeouts, `RETRY_TIMEOUTS_MAX_PER_BATCH`) target exactly
this classification.

Class for g2: **budget miss** (gold enumerated and ranked first, never accepted; probable timeout
misclassification of the top batch).

### 1.4 The other 11 steps were churn

After step 6 both goals were parked and the synthesizer alternated `read src/__init__.py, src/account.py`
(intent investigate → `investigateRead`) with partial `done`s; the engine blocked both:

```
[step 9]  risk=0.80 block: plan_mismatch ... dominant level 3 "ignores the plan's open problems, or claims completion (`done`) while `plan.remaining` is non-empty"; Jev confidence 0.44; ... matches_intent=0.09
[step 14] risk=0.89 block: plan_mismatch ... dominant level 4 "contradicts the plan, repeats a step `recent` shows already failed the same way, or claims completion with no verifying test run in `recent`"; Jev confidence 0.64
```

Three replans all said `gather_context` (p 0.52 / 0.81 / 0.84, task_impossible 0.09–0.12) and the
synthesizer answered `directive: gather_context: nothing to change` each time; only the fourth
(`change_approach`, p=0.13 — the fallback) did work (step 18). Steps 7–17 produced nothing.

## 2. Classification of every non-executed proposal (calendar_utils, inventory, units, shipping, table)

38 proposals. `ledger complete` = the transcript's `synth ledger` line at that step reads `open 0, parked 0`
and the synthesizer's own baseline was already all-pass; `engine green` = the engine had executed a
full-suite run with `allPassed` before that step. `evidence.verified` is `evidenceVerified()`
(`src/loop/state.ts:169`: no `newlyFailing` and `after.passed > before.passed`).

| kind | n | of which | dominant rubric level (plan_mismatch unless noted) |
| --- | --- | --- | --- |
| `run` | 16 | 9 = the standing post-patch full-suite verification run (`verify the suite after fixing …`), 7 = goal-subset budget-hit runs (`record the failing behaviour of …`) | post-patch: L0 "matches `intent` and the plan" ×5, L2 "skips a planned verification step" ×2, L4 ×2; **all 9 with evidence.verified = true, all declined at review 0.30–0.43 with Jev confidence 0.00–0.13**; 7 of 9 while the ledger was complete. subset: L4 "repeats a step `recent` shows already failed the same way" ×6 (p 0.43–0.88), L0 ×1; `matches_intent` 0.09–0.14 (intent `edit`) |
| `done` | 15 | 9 units + 3 shipping + 3 table, all `all N tests pass; k fix(es) committed` | first `done` of each run: declined at review 0.35–0.37, dominant L0, conf 0.00 (units: max dim `out_of_scope` tail 0.36); every later `done`: blocked, L4 "…repeats a step `recent` shows already failed…, or claims completion with no verifying test run in `recent`" p 0.45–0.97, `matches_intent` 0.06–0.19. **Ledger complete and engine green for all 15** (units engine run step 11: 10/10, completion 0.83 vs threshold 0.85; shipping step 7 10/10 completion 0.72; table step 6 10/10 completion 0.75) |
| `patch` | 2 | units 5 (`return 90`, 8→9/10), shipping 5 (`subtotal ** 2 >= …`, 6→10/10) | declined at review 0.34 / 0.32; L2 (units, p 0.44, conf 0.23) and L0 (shipping, conf 0.00); **evidence.verified = true for both**; both were re-proposed next step and executed (`scratch.rejected` re-propose path) |
| `read` | 5 | calendar_utils 12, 14, 15, 17, 19 (`read src/calendar_utils.py` under intent investigate, after the ledger was complete) | L4 "repeats a step …" ×4 (p 0.58–0.89), L0 ×1 |

Per run:

**calendar_utils** (11): post-patch `run` declined at 5 (L2, 0.40), 13 (L0, 0.43), 16 (L4, 0.43,
matches_intent 0.14), 18 (L0, 0.42), 20 (L0, 0.36) — from step 11 the ledger read `fixed 5, open 0,
parked 0` and `synth baseline: 10/10 pass`; the engine never executed a green run, so `proposeDone` never
fired (`doneReadiness` requires an engine-executed green run, §5.5) and the run ended at `max_steps` with a
passing workspace. Subset `run` 7 declined (L4, conf 0.00). Reads 12/14/17 declined, 15/19 blocked.

**inventory** (6): post-patch `run` declined at 5 (L2, 0.40), 16 (L0, 0.40), 17 (L0, **0.30** exactly the
review threshold), 20 (L4, 0.53, matches_intent 0.13); ledger complete from step 16 (`synth baseline:
10/10`). Subset `run` 11 declined (L4, conf 0.00), 12 blocked (L4, 0.89, conf 0.67).

**units** (10): `patch` 5 declined (verified 8→9). `done` ×9, steps 12–20: 12 declined
(`risk 0.36 (review) from out_of_scope: 0.36 probability of level 3 or above; dominant level 0`), 13–20
blocked at 0.96–1.00. Intent at 12 was `finish` (p 0.87, `can_finish` 0.63, verdict chosen); at 13 Jev
still answered `finish` (0.63) but `can_finish` fell to 0.31 → verdict `fallback` → effective intent
`investigate` → `matches_intent` 0.19 and `intent:unresolved` signature every step after. The `done`
loop tripped three times (14, 17, 20); replans 15 and 18 chose `gather_context` (0.73, 0.95;
`stop_and_report` 0.11 / 0.01; task_impossible 0.08 / 0.10) → `directive: gather_context: nothing to
change` → same `done` again.

**shipping** (6): subset `run` 3, 4 blocked (L4 0.79 / 0.89, matches_intent 0.09 / 0.10). `patch` 5
declined (verified, 6→10/10), executed at 6. `done` 8 declined (L0, 0.37, conf 0.00), 9 blocked (L4
0.85), 10 blocked (L4 0.95) → trip → `stop_and_report` p 0.45 → `replan_stop`, pass.

**table** (5): subset `run` 3 declined (L0 0.37, matches_intent 0.13), 4 declined (L4 0.60). `done` 7
declined (L0 0.35), 8 blocked (L4 0.75), 9 blocked (L4 0.97) → trip → `stop_and_report` 0.47 →
`replan_stop`, pass.

Two mechanisms explain 30 of the 38:

- *Review = decline in bench runs.* `engine.ts:1014-1024` sends `review` to the confirmer; the bench's
  confirmer is `no reviewer in bench runs` (`src/bench/conditions.ts:18`) and always declines. Every
  post-patch verification run and every first `done` sat in the 0.30–0.43 band with **Jev confidence
  0.00–0.13**: the probability mass was spread over levels, not concentrated on a bad one (dominant level 0
  in 8 of 12). For a full-suite test run (`destructive` and `irreversible` at level 0 with p 1.0) there is
  nothing a reviewer could object to.
- *A declined proposal becomes "a step that already failed".* `recentJson` (`state.ts:101`) shows the
  refused step as `outcome: declined|blocked` with the risk reason. The plain `plan_mismatch[4]` text
  (`risk.ts:53`) says "repeats a step `recent` shows already failed the same way"; the evidence variant
  (`risk.ts:84`) adds "a blocked or declined proposal in `recent` never ran so it did not fail", but a
  `done` carries no evidence so it gets the plain text. Hence the second `done` is judged L4 at p 0.45–0.72
  and the third at 0.84–0.97 — the block feeds itself. The intent fallback (`finish` → `investigate`)
  compounds it: the risk state's `intent.choice` becomes `investigate`, and the L4 question "How far is
  `proposal.action` from `plan` and `intent`?" is then answered about the wrong intent.

## 3. Loop detector

Signatures (`src/loop/loopdetect.ts`): `run:<sha12(cmd)>:<sha12(exitCode:output | status:reason)>`,
`done:<sha12(norm(summary))>`, `read:<sha12(paths)>`, `patch:<sha12(diff)>`, plus `intent:unresolved` when
the intent verdict was `fallback`. Trip at 3; **`observe` clears every count on any trip
(`loopdetect.ts:183`), and `onReplan` clears every count again (`:203`)**.

| run | identical refused proposal | steps | action-signatures | tripped? | why not / what happened |
| --- | --- | --- | --- | --- | --- |
| account | subset `run` | 3 (declined), 4, 5, 6 (blocked) | 2 (`…:51bb5c0586d6` vs `…:2b983186852c`) | at 6 (x3) | the `run` signature embeds the outcome: `declined:not approved (no reviewer in bench runs): risk …` ≠ `blocked:risk …` (`:45` uses `outcomeReason`). One step late |
| account | partial `done` | 9, 12, 15 | 1 (`done:348f96fcf24f`) | **no** | counts wiped by the `read` trip at 10, the `intent:unresolved` trip at 13 and replans at 11 / 14; each `done` restarted at count 1 |
| account | partial `done` | 19, 20 | new sig `done:1fa52d8d44cc` | – | summary text changed from `…: 2 consecutive budget-hit steps` to `…: 3 searches without a commit` (digits normalise, words do not) |
| calendar_utils | post-patch `run` | 5, 13, 16, 18, 20 | 3 (`80b1ac18fc86`, `a8105c55a3cb`, `a6d668c9685d`) | **no** | step 16's reason carries `; Jev judged the action does not carry out intent `investigate` (matches_intent=0.14)` (`normaliseForSignature` replaces digits but the suffix itself remains), step 5's dominant-level text differs; plus resets by `read` trips at 11 / 15, `intent` trip at 19 and replans 12 / 16 / 20 |
| inventory | post-patch `run` | 5, 16, 17, 20 | 3 | **no** | same two causes; 16 = 17 (`951766c01d69`) but 20 differs by the `matches_intent` suffix; resets at 13 / 14 and 18 / 19 |
| inventory | subset `run` | 11 (declined), 12 (blocked) | 2 | – | declined vs blocked |
| table | subset `run` | 3, 4 (both declined) | 2 | – | reasons quote different dominant-level texts (L0 vs L4) |
| units | green `done` | 12–20 | 1 | yes at 14, 17, 20 | worked as a detector; the replan (`gather_context`) could not act on a solved task and `stop_and_report` was 0.11 / 0.01 |
| shipping, table | green `done` | 8–10, 7–9 | 1 | yes | `stop_and_report` 0.45 / 0.47 → `replan_stop` (pass recorded, stop reason wrong) |

`intent:unresolved` tripped in four runs (account 13, calendar_utils 19, inventory 18, textstats 6) and
fired on 9 of account's 20 steps although the chosen intent equalled Jev's answer (e.g. step 9: `intent`
investigate 0.79, `can_investigate` 0.47 → `fallback` → effective intent investigate anyway). Each such
trip wiped the `done`/`run` counts and produced a `gather_context` replan the synthesizer answered with
"nothing to change".

Summary for Q3: 3+ identical refused `done`/`run` proposals occurred in account (done ×3, run ×4),
calendar_utils (run ×5) and inventory (run ×4) without tripping; the causes are (a) outcome text inside the
`run` signature (declined vs blocked; `matches_intent=` suffix; quoted level text), (b) the global count
reset on every trip and replan, so interleaved `read` / `intent:unresolved` trips protect the real loop,
(c) `done` summaries whose wording changes with the park reason.

## 4. Ranked fixes, code locations, expected savings

Baseline for the arithmetic: 137 steps; passed-task steps-to-solve mean 10.64. Savings are counted per run
against the recorded transcripts (a fix removes the steps after the point at which the run would have
ended).

### Fix 1 — a `done` after the engine's own green run is complete by construction (12 steps, 3 stop reasons)

Data: 15 `done`s refused while `workspace.testsCurrent` was true and `lastTestRun.allPassed` (engine run
green at units 11, shipping 7, table 6). units 12→20 (8 steps), shipping 8→10 (2), table 7→9 (2); all
three end `complete` instead of `max_steps` / `replan_stop`.

Touch points:
- Controller proposal policy / engine gate: `src/loop/engine.ts:1010-1024` — before applying
  `rk.risk.verdict`, treat a `done` whose `plan.remaining` is empty while the code-computed
  `testsCurrent(ws.lastTestRun, ws.lastChangeStep)` (`src/loop/state.ts:86`) and `lastTestRun.allPassed`
  hold as ok for `plan_mismatch`/`out_of_scope` (they are the only dimensions that can rise for a `done`;
  `destructive`/`irreversible` are 0). Equivalent synthesizer-side variant: `proposeDone` green branch
  (`src/synth/search/proposal.ts:717-723`) attaches the engine-run counts as `evidence` so the risk stage
  uses `RISK_LEVEL_TEXTS_WITH_EVIDENCE` and asks `evidence_consistent`.
- Rubric text: `src/loop/stages/risk.ts:52-53` (`RISK_LEVEL_TEXTS.plan_mismatch[3]`, `[4]`) — the plain
  texts lack the clause the evidence variant has at `:84`: "a blocked or declined proposal in `recent`
  never ran so it did not fail"; add it (and "a `done` after a green full-suite run in `recent` is not a
  claim without verification") to the plain texts, since `done` never carries evidence today.
- Intent: `src/loop/stages/intent.ts:144` (`resolveIntentWithLedger`) rescues only `edit`/`verify` from a
  `fallback`; a `finish` answer with p ≥ `LEDGER_CHOICE_FLOOR` while the ledger is empty and the last
  engine run green should be rescued too (units 13: `finish` 0.63, `can_finish` 0.31 → investigate).

### Fix 2 — the standing full-suite verification `run` is never a review item (12 steps with Fix 1, ~6 alone)

Data: 10 declines of `python3 -m pytest -q` proposed with verified evidence (calendar_utils 5, 13, 16, 18,
20; inventory 5, 16, 17, 20; textstats 8), all at risk 0.30–0.43, Jev confidence 0.00–0.13, dominant level
0 in 6 of 10. In calendar_utils and inventory the refused run was the only thing between a green
workspace and `done`. Counterfactual with Fix 1: calendar_utils step 13 executes → green → `done` 14
(≈13 steps after the step-5 shift; saves 7); inventory 16 executes → `done` 17 (≈16; saves 4);
textstats saves 1. Without Fix 1 the `done` loop of §2 follows and the saving is roughly half.

Touch points:
- `src/loop/engine.ts:1014` — for a `run` whose command equals the workspace test command
  (`common().workspace.testCommand`, or the synthesizer's `baselineCommand`) and whose `destructive` and
  `irreversible` dims are level 0, resolve `review` as approved (a test run is what a reviewer would ask
  for). Or in `src/loop/stages/risk.ts:175-211` (`assessRisk`): for such a run, bound `plan_mismatch` by
  its `expected` term instead of the tail (`:198`), since the tail at confidence 0.00 is what put these
  in the review band.
- The same rule covers the 7 subset runs (`record the failing behaviour of …`), which were blocked as
  "repeats a step `recent` shows already failed the same way" although a failing test run is their whole
  purpose; they cost no extra steps here (the step is consumed either way) but each one seeded a loop trip
  and a `gather_context` replan.

### Fix 3 — loop signatures for refused proposals, and per-signature resets (1–5 steps; makes §5.5's exit real)

Data: §3 table. Touch points, all in `src/loop/loopdetect.ts`:
- `:44-46` — for `outcome.status` `blocked` or `declined`, sign the proposal alone
  (`run:<sha12(cmd)>:refused`), not `status:reason`; today declined vs blocked and the `matches_intent=`
  / quoted-level suffixes split identical proposals (account 3 vs 4–6; calendar_utils 13/18/20 vs 16;
  inventory 16/17 vs 20; table 3 vs 4).
- `:183` and `:203` — on a trip, reset only the tripped signature's count (and on replan only the
  signatures of the tripped kind); today a `read` or `intent:unresolved` trip wipes a `done` count of 2
  (account 9/12/15 never reached 3).
- `engine.ts:1385` / `:66` — do not emit `intent:unresolved` when the fallback equals Jev's own answer
  (account step 9, 10, 11, 13; 4 of the 16 trips were `intent:unresolved` and every one produced a
  `gather_context` the synthesizer could not use).
- `src/synth/search/proposal.ts:707` — keep the partial `done` summary free of the park reason (put it in
  `openProblems`, already there) so the signature survives a reason change (account 15 → 19).

Expected: account's third partial `done` trips at 15 (saves up to 5 steps if the replan then stops; the
recorded replans chose `gather_context` at task_impossible 0.09–0.13, so the saving depends on Fix 1's
rubric text making a repeated `done` legible), the subset-run trip fires at 5 instead of 6, and the
`intent:unresolved` replans (4) disappear.

### The pass-rate item (separate: it is a synthesizer change, not one of the three asked)

`account` needs: (a) on park with remembered partials whose `newlyPassing` sets are disjoint and cover the
goal, run `pairsOfPartials` before `forgetGoal` (`src/synth/search/index.ts:499`, `:513`;
`bases.ts:360`), or split the goal per test when its partials are complementary; (b) `change_approach`
reopening all parked goals, not `.at(-1)` (`src/synth/search/directive.ts:168`); (c) the in-flight
`budget.ts`/`runner.ts` timeout retry for the step-18 `4 timeout` batch. Both g1 gold lines were ranked
first by Jev (0.97 / 0.98) and the g2 gold at 1.00; the search found the fix, the bookkeeping lost it.

### Totals

| | steps | stop reasons | steps-to-solve mean (passed) |
| --- | --- | --- | --- |
| recorded | 137 | 3 max_steps (solved), 2 replan_stop, 1 max_steps (miss), 6 complete | 10.64 (median 9) |
| Fix 1 | −12 | units, shipping, table → complete | 9.55 |
| Fix 1 + 2 | −24 | calendar_utils, inventory, textstats also shorter | ≈ 8.5 (median 8) |
| Fix 1 + 2 + 3 | −25 to −29 | account ends at its third partial `done` instead of max_steps | ≈ 8.5 |
| + pass-rate item | – | account solved (12/12) | – |
