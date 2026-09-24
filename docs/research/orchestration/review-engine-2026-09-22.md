# Adversarial review — orchestration ENGINE wave (`orchestrate-engine` @ 72253a6, merged at 2400a0c)

Reviewer: an independent read-only review, 2026-09-22, in a detached worktree, probes executed (bounded vitest;
real git and `sandbox-exec` in scratch repos). In-scope suites: `test/unit/{loop,orchestrate,spend,checkpoint,core,sandbox,provider}`
— 101 files / 1,528 tests green. Scope: `docs/ORCHESTRATION-DESIGN.md` §2.5, §3.1, §3.6, §3.7, §5.7 [D1], §6 [D6], §8.2 D0–D3
items 1–6, 15, 17–21, 25, plus the three TUI-DESIGN-4 engine hunks.

## Defects

1. **CONFIRMED — a failed `git status` turns `/land` into "stash your entire working tree".** `src/loop/engine.ts:3837-3851` +
   `src/loop/launch.ts:196-205` (`seedFor`). `launchOverlap` returns `{overlap: [], ok: false}` when `statusEntries` fails
   (`src/orchestrate/worktree.ts:118-125`); `land()` takes `if (ok && overlap.length === 0)` → false → the offer branch with an
   EMPTY overlap; `seedFor` does not guard the empty list, seeding `git stash push -u -- ` (empty pathspec) which, verified against
   real git, stashes the whole working tree — tracked modifications and untracked files — and `git add -- && git commit …` which
   commits whatever the index already held. Fix: `!ok` is its own case (refuse, or offer with "could not read your checkout");
   `seedFor` returns `null` on an empty overlap.
2. **CONFIRMED — `[c]` commits more than the overlapping files.** `src/loop/launch.ts:~160` (`wipCommitAction`):
   `git add -- <overlap> && git commit -m …` — `git commit` with no pathspec commits the WHOLE index, so a file the user had
   separately staged is swept into a harness commit they did not review (verified). Fix: `git commit --only -m <msg> -- <overlap>`.
3. **CONFIRMED — seatbelt [G3] leaves the MAIN worktree's `HEAD` and `index` writable.** `src/sandbox/seatbelt.ts:176-189` denies
   `<common>/refs`, `packed-refs`, `logs` and `<common>/worktrees/[^/]+/HEAD` (linked worktrees only); `<common>/HEAD` and
   `<common>/index` sit inside the `gitRoots` write allow. Probed under `sandbox-exec` from a linked agent worktree: writes to
   `<common>/HEAD` and `<common>/index` exit 0 while the four denied paths are refused. Under `orchestrate.land: 'step'` the user's own
   checkout is the merge target. Fix: add `(literal <common>/HEAD)`, `(literal <common>/index)`, and cheaply `ORIG_HEAD`,
   `MERGE_HEAD`, `sequencer` to the depth-1 rule. Ordinals, rule order and the `run.ts` profile-hash forwarding are correct.
4. **CONFIRMED — belt 2 fails OPEN on an empty `own`.** `src/loop/stages/risk.ts` `ownershipRefusal`: `if (own.length === 0)
   return null` after the research-role check; `OrchestrationOptions.own` is optional, so a `role: 'code'` depth-1 child launched
   without `own` has no ownership enforcement, and `noteEscaped` returns early on the same condition. Everywhere else an
   absent/unparsable `own` owns nothing. Fix: at `depth === 1` an empty `own` refuses every write target.
5. **CONFIRMED (placeholder-induced) — `fold: false` and `existingBranches: []` hardcoded.** `src/loop/engine.ts:3207-3209`
   (`decomposeFacts`). `normalizeSplit` uses `fold` for every disjointness and token-resolution comparison; on APFS
   (case-insensitive by default) `src/Foo/**` and `src/foo/**` pass rule 4 and two agents own the same files. `existingBranches: []`
   makes `slugTaken` in-split-only, so rule 1's collision rename never fires and a manifest can name an existing `jevcode/<slug>`.
   Both are one cheap measurement (`git config core.ignorecase` / a probe write; `git for-each-ref --format='%(refname:short)'
   refs/heads`). A placeholder that widens safety is the wrong default.
6. **CONFIRMED (minor) — the [D1] card warning is unreachable.** Same function: `syncedDirty: []` and `dirtyOverlap: []` hardcoded
   while `dirtyEntries` is real, so `decomposeHeadline`'s first row (what `/land` will do about the user's dirty files) can never
   render; the card is silently reassuring.
7. **PLAUSIBLE (low) — the [G3] deny evaporates without a git probe.** `seatbelt.ts:184` `commonDir ?? join(ws, '.git')`; in an
   agent worktree `<ws>/.git` is a file, so with no `gitCommonDir` all four denies point at non-existent paths (mitigated: the
   common dir is then not a write root). Refuse rather than degrade at depth 1.
8. **PLAUSIBLE (low) — reftable repos**: with `extensions.refStorage = reftable` refs live in `<common>/reftable/`; the
   `refs`/`packed-refs`/`logs` denies are inert. Add `<common>/reftable/`.
9. **Notes.** `writeCache`'s error path keys an `orchestrate/` disk degrade against `CHECKPOINT_FILES.cache`. `[c]`/`[s]` never seed
   the merge — nothing re-invokes `land()` after the pre-flight step, and no `src/**` caller calls `Engine.land` yet; `restoreDock`
   is exported and called by nobody, so "clean floor honoured" is not yet answerable in-tree. Depth is self-reported (theoretical;
   a child cannot authenticate — config dirs are read-denied).

## M2 verdict: holds for the orchestration branch; not for the wave as a whole

Holds: `decomposeShortCircuit` (`engine.ts:2975`) reads `opts.splitPolicy` / `orchestration.depth` / `hasLedger` only and
returns before the clock, any probe, any Jev ask or emit; every new state/record field is a conditional spread; `agentsSection`
returns `null` on an empty list; `proposeActionToolFor` returns `PROPOSE_ACTION_TOOL` by referential identity for the full kind
list; `takeSeeded` is null with no seed; `cacheTarget` traversal is contained (`orchestrate/../state.json` → `cache/state.json`,
`../../etc/passwd` → null). The repo's `decompose-m2.test.ts` is weaker than it reads: its baseline is the same tree without
options, so it proves the branch is inert, not that bytes match pre-change code. Does not hold literally: two contract-1.7 hunks
change every run — `stopTranscriptLine` returns `''` (`src/loop/stop.ts:67`; both `finish()` guards correct, no bare `[run]`) and
`noteDisk` emits `disk.sentence` plus an `attachDegradeListener` registration. Both intended; the claim should be scoped.

## Verified as holding

Meter [D6]: keyed holds, idempotent `release`, `nonNegative` maps NaN/negative/+Infinity to 0, `restore` clears then re-seeds
`RESTORED_HOLD_ID`, `exceeded()` untouched; `hold`/`release` have no caller in `src/**` yet. Contract 1.5: headers contiguous
1.1, 1.2, 1.2, 1.3, 1.4, 1.5, 1.7; no required member added; `BlockingAnswer 'commit'|'stash'` reach no exhaustive switch or
`Record<BlockingAnswer,…>`; `land()` maps every other answer, a missing `ask` and a throwing `ask` to `'stop'`. Preflight:
unmeasurable denominators are `Infinity`; `LIMIT_ORDER` deterministic; no NaN/negative/fractional agent count escapes.
Decompose: gate reasons pure over facts; `parseSplitDraft` total; `jev-only` never calls the generator, `jev-off` never the
decider; `--no-input` with no blocker is `no_split`, never auto-approve; headline capped with the [D1] row first; P9 writes the
manifest before `state.json`. `contract-stages.test.ts` honest about the four TUI tables.

## Design deviation judged wrong

The `decomposeFacts` placeholders (5, 6) are the wrong kind: `fold: false`, `existingBranches: []`, `dirtyOverlap: []` each make
the planner MORE permissive than the truth, in a module whose every other unknown resolves against the split. Measure them (one
cheap call each) or make the gate refuse while they are placeholders.
