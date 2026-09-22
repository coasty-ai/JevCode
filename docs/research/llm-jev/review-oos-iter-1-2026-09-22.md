# Adversarial review — OOS iteration 1 (`oos-iter-1` @ eb5f55f, merged at 168a599)

Reviewer: an Opus subagent of the harness session, 2026-09-22, read-only in a detached worktree; full unit suite at
`--maxWorkers=3` 457 files / 7,629 tests green. Scope: the eight ranked changes of `docs/research/llm-jev/oos-analysis-2026-09-22.md`.

## Defects, most severe first

1. **CONFIRMED — change 5 false-rejects any patch that ADDS an unmodelled control construct around exits.**
   `src/synth/py/structure.ts:1113` (`fallsOffEnd`) via `guard.ts structuralRejection`. The "unmodelled constructs cancel in the
   difference" argument holds only when the construct is in both revisions; `try` and `for` read as "can fall through", so a
   patch that introduces `try/except` around `if x: return 1 / else: return 2` flips `fallsOffEnd` false→true →
   `'adds_implicit_none_exit'`, and the sole passer falls to `holdBestPartial`. Adding `try/except` is a large fraction of real
   SWE-bench fixes. Fix: model `try` in `suiteExits` (exits when the try-suite and every except/else suite exit) and skip the rule
   when the after revision contains a statement kind inside the function that the before revision did not.
2. **CONFIRMED — `mutatedParameters` refuses legitimate in-place APIs and item insertion.** `structure.ts:1126`
   (`MUTATING_METHODS`), `:1167` (subscript targets): `values.sort(); return values[-1]` and `if k not in d: d[k]=0` both
   → `'mutates_new_argument'`. Correctly not rejected: pre-existing mutation, `self.items.append`, a rebound parameter. Sweep of
   all 41 QuixBugs golds and 20 ladder golds: zero refusals — the exposure is the SWE class and non-gold passers.
3. **CONFIRMED — `completion` recorded as `0` for a question never asked** on the `testsUnparsed && !completeDue` path
   (`src/loop/stages/judge.ts:285`; the callback assigns unconditionally). Fix: `if (completeDue) completion = …`.
4. **CONFIRMED (mechanism) — change 4 couples unrelated failures through ANY shared helper.** `src/synth/search/goals.ts:423`:
   two independent clusters whose tracebacks both pass through `util.py|normalise` merge into one goal; on a repository
   workspace nearly every traceback shares frames (`sympify`, `Basic.__new__`, decorators), so the union-find can collapse the
   ledger into one goal. QuixBugs safe (test-kind frames excluded). Fix: require the shared node to be dominant and adjacent to
   the key frames, or refuse the merge when the node is on ≥ N clusters' chains (a shared utility, not a defect site).
5. **CONFIRMED — `rankPoolCap` prices ~1,000× more candidates than a run this step can reach.** `budget.ts rankPoolCap`, used at
   `subgoal.ts:853/:1166`: the cap is `runsLeft` (4,574) while `plan.k` is 5 at this site this visit; the stated invariant does
   not hold and ~90 % of change 1's saving is left on the table. Fix: price `plan.k` (plus a small margin for the
   `fixProbablyAbsent` signal).
6. **CONFIRMED — a zero cap silently exhausts a source with no question asked.** `subgoal.ts:853` recomputes `runsLeft` after
   `visitPairs` may have spent the step's runs; `priced = []` → `rank([])` returns `fixProbablyAbsent: true` → the source is
   marked exhausted at the site. Fix: `if (priced.length === 0) return BUDGET_EXIT` before `deps.rank`.
7. **CONFIRMED — SIEVE no longer spreads the run budget over sites.** `budget.ts:934` returns `runsAllowed = n` ignoring
   `sitesLeft`; with a 60 s oracle, 1 lane, 20 min wall, `sitesLeft` 12, pool 18 → SIEVE 18 runs at the first source of the
   first site, starving 11 sites. Fix: cap `runsAllowed` at the site's share when `sitesLeft` is given.
8. **CONFIRMED — "hits are the rows with `usage.calls === 0`" is false**: `src/bench/stub-decider.ts:76` returns `calls: 0` on
   every request, so the derived count is 100 % false-positive under the stub; and `jev.jsonl` / `draft.jevRequests.length`
   still count hits as requests, so "−454 requests" will not show in request counts, only in cost/latency. Fix: mark hits
   explicitly (a `cached: true` member on the request record) and derive from that.
9. **CONFIRMED (latent) — cache entries are aliased, not copied.** `src/jev/cache.ts:45 asHit` spreads `...served`, so
   `answers` is the same object on every hit; a mutator would poison later hits. Fix: `structuredClone(served.answers)`.
10. **PLAUSIBLE — change 3's pause costs a whole step's LLM sampling, and growth is per sample.** `noteZeroTokenTimeout` runs
    per sample (5 parallel zero-token timeouts = 5 growths straight to the ceiling and the pause armed); `fire(round:1)` is once per
    step per goal, so the pause removes ALL LLM candidates for that step — on long_chain (27/44 timeouts) roughly every other step,
    on exactly the tasks the change is meant to rescue.

## Verified as holding

`isZeroTokenTimeout` only on `kind === 'timeout'`; cancelled samples never count; partial output clears the streak. Warm
durations excluded from the medians (`runner.ts:852/:876`), pinned by dfefb75. `everythingQueued` compares against the whole
fresh set, so a truncated RANK never exhausts a source; no unpriced candidate is ever run. `splitBySiteBudget` never yields
zero-site or duplicate-site goals; one-test goals never split; QuixBugs stays one goal. Change 6(b) cannot block completion
(`completion` is record-only on llm-jev; jev-on `runJudgeStage` ungated; `null` handled at engine.ts:4506). Change 8's
independence is distinct `selection` strings; a run whose only failing→passing transitions are repro variants can never
self-terminate on `done` (continues to its step/replan budget — a permanent refusal of that path, not a deadlock). Archive:
stats first, skips missing, never throws; `generator.jsonl` carries `promptHash`, not prompt text. jev-only still makes zero
generator calls; legacy prompt goldens byte-identical.

## Operational notes

`archiveByDefault` is keyed on `join(process.cwd(), 'bench', 'results')` — cwd-relative, not repo-relative; `.gitignore`
un-ignores `bench/results/{oos,llm-jev,live,jev-only,glm}-*`, so on-by-default archiving now drops `state.json.gz` and
`model_patch.diff.gz` into git-tracked directories (~4 MB gz per 22-task slice). `runId` is interpolated into `join(dir, runId)`
with no confinement check (internal ids; low).

## Likely to lose solves on the development set

No change refuses a dev-set gold patch (swept). Watch: change 3's pause on the ladder long tasks; change 4's shared-caller merge
if any ladder/SWE traceback pair shares a helper frame. Both need the in-sample 28 re-run as a regression arm before the fresh
slice is trusted.
