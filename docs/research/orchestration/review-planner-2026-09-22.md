# Adversarial review — `orchestrate-planner` @ 2be87e1 (read-only, traced)

Reviewer: an independent read-only review, 2026-09-22, in a detached worktree. A CPU hold was in force for the
whole review, so no probe was executed: every finding is TRACED through the source with an exact input and the derived
wrong output, plus the one-line probe to run. Scope: the pure half of the `docs/ORCHESTRATION-DESIGN.md` harness slot —
`src/orchestrate/**` (31 added files, 307 tests), `src/core/limits.ts`.

## Defects, most severe first

1. **`outsideOwn` subtracts the whole `syncedDirty` list, not the still-carried subset — [G8]'s ownership belt is off
   for up to 200 paths.** `critic.ts:242` `carried = new Set(input.syncedDirty.map(e => e.path))`. `worktree.ts:22-24`
   makes `carriedPaths` (byte-identical only) the ONE definition; `commit.ts:61` uses it. Input: `syncedDirty =
   [{path:'src/shared.ts', sha256:<parent>}]`, `own = ['src/a/**']`, the agent rewrites `src/shared.ts`. Output:
   `outsideOwn(...) === []` → no `[a]/[d]/[x]` prompt, while `computeAddSet` stages it → committed, merged, landed
   silently. These are exactly the paths two siblings most likely both edit ([D2]). `land.test.ts:352` passes either way.
   Fix: `outsideOwn` takes `carriedPaths(dir, syncedDirty)`. Probe: `outsideOwn({changed:['src/shared.ts'],
   own:['src/a/**'], syncedDirty:[{path:'src/shared.ts', sha256:'x', mode:420}], incidentalGlobs:[]})` → expect
   `['src/shared.ts']`.
2. **`collapseOwn` widens an `own` list past the `deny` list.** `globs.ts:260-268` deny check, `:269` collapse.
   `validateOwnList(['src/a1/', …, 'src/a33/'], {max: 32, deny: ['src/secrets']})` → 33 heads pass the deny check,
   collapse to `src/**`, which owns `src/secrets/keys.ts`. Design §3.4 rule 2: "never a `secretPaths` entry".
   Fix: re-run the `.git`/`deny` check on `collapsed`; `collapseOwn` refuses a merge target swallowing a denied prefix.
3. **Rule 7's clamp deletes agents without repairing `dependsOn`; the landing queue then parks a healthy survivor.**
   `normalize.ts:313-320` clamps after rule 6's DAG check (`:275-307`); `mergeInto` (`:155-172`) never rewrites other
   agents' `dependsOn`; the post-clamp re-check (`:349-357`) covers only disjointness. `[p,q,r,s]`, `q.dependsOn=['s']`,
   `maxAgents=3` → `q.dependsOn === ['s']` with `s` gone → `land.ts:157-161` parks `q` ("its dependency s did not
   land"). Fix: remap `dependsOn` to the receiving survivor after the clamp and re-run rule 6.
4. **Rule 9 never scans `verify`, so a secret in a verify command reaches the card and `land.jsonl` unredacted and
   unflagged.** `normalize.ts:390` scans `task` and `own` only; `manifest.ts:115-116` justifies not redacting
   `verify` with a rule-9 claim that is false of the code AND of the design (line 574: "over every `task` and `own`").
   `manifest.ts:124`, `land.ts:466/471/478` write it clipped or verbatim. Input: `verify = ['NPM_TOKEN=ghp_xxxx npm
   test']` → token on the §4.6 card row and every `land.jsonl` line with `secretHits === 0`. **Deviation judged wrong**:
   extend rule 9 to `verify` (keep clipping) or redact — and fix the comment.
5. **`readManifest` never recomputes `manifestId`**, contradicting `manifest.ts:13-15`; `:300-301` only shape-checks.
   The checksum is unkeyed sha256 (corruption detection). A hand-edited `manifest-<n>.json` with a copied `manifestId`
   and different `agents[]` passes `sameDelegation` (`:384`) and is ADOPTED. Fix: recompute `manifestIdOf(...)` in
   `readManifest` and reject a mismatch.
6. **`no_file_progress` is effectively dead**: `stall.ts:71` reads cumulative `changedFiles` (documented `:23` as
   "against its base") as a per-step delta; fires only for an agent with zero files changed in total. `stall.test.ts:85`
   encodes the bug. Fix: difference over the window like `netLines`, or change the field contract.
7. **The critic cannot see a rename source**: `DiffFile` (`critic.ts:29-34`) has no `from`; `git mv src/foo.test.ts
   src/foo.old.ts` → `{path:'src/foo.old.ts', status:'R'}` → no test-glob match → rule 1 skipped; rule 2 silent when a
   count is null (`:156`). Fix: `from: string | null`; treat `R` with a test-glob `from` and non-matching `path` as a
   deletion. Secondary: per-file net assertion decrease false-positives on moved assertions.
8. **`restoreDock` runs the destructive `clean -fdx` even when it declined to reset** (`land.ts:273-280`): a
   non-sha `previousHead` skips the reset and still scrubs untracked files on a failed-merge state — the opposite of
   [D14]/row 39. The `-e` set is entirely caller-supplied (`exclude: []` deletes `.env`). Fix: fail and skip the clean
   when `previousHead` is not an object name; add a built-in floor (`.env*`, `node_modules/`).
9. **`applyDropRule`'s merge keeps the receiver's `role`/`branch`** (`rank.ts:101-111`): a `research` receiver
   (`branch: null`, never lands) absorbs a dropped code agent's `own`, `verify` and money. Fix: promote to `code` and
   re-derive `branch`. PLAUSIBLE in practice.
10. **`normalize.ts mergeInto` drops the absorbed agent's `verify`** (`:167-171`) while `rank.ts mergeInto` unions it —
    two merge semantics. Fix: union (capped at `VERIFY_COMMANDS_MAX`) in both.
11. **`rankSplits` can throw** against its "returns on every path" header: `planDecomposeQuestions` (`rank.ts:166`) is
    outside the `try` (`:179`); options containing only `no_split` → `choice()` throws `QuestionBuildError`. Fix: guard
    or move inside the `try`.
12. **`reserveUsd` unbounded; `Infinity` → infinite agent cap** (`normalize.ts:323-333`); `policy.maxReserveUsd` is
    applied nowhere in this slot; the manifest then serialises `capUsd: null` and is permanently unreadable
    (`manifest.ts:239`) → re-spawn forever. Fix: clamp to `[0, maxReserveUsd]`, reject non-finite at the top.
13. **`acquireLandLock` stale-replace is a TOCTOU** (`land.ts:414-421`): two processes read the same dead-pid lock and
    both `rename` in; `host === host` is required for a REFUSAL so a `''`-host caller steals; `startedAt` never
    consulted. Low severity under the single-parent model.
14. **Minor.** (a) `readManifest` accepts `own` strings the sub-language rejects (`manifest.ts:225-226` checks count
    and length only). (b) `hasConflictMarkers` (`critic.ts:190`) hard-codes seven characters; `conflict-marker-size`
    defeats it. (c) `outsideOwn` matches with `fold = false` (`critic.ts:246`) while rule 3 uses `input.fold`. (d)
    `dockBranchOf` (`manifest.ts:106`) does not validate `runId`. (e) `SEGMENT_RE` (`globs.ts:43`) admits zero-width /
    bidi-override characters and excludes astral code points (emoji filenames).

## Verified as holding

M2 airtight (`rank.ts:154/158/164` return before `deps.ask` is read). [G3]: `pinBranch`/`recheckPin` compare object
names; `mergePinned` refuses non-sha before git; `rebaseOnDock` refuses branches outside `jevcode/`; no fetch; a failed
merge is aborted with `--diff-filter=U` paths. Gate order matches §3.1; a dirty parent is not a blocker ([D1]);
`fits()` treats an unmeasurable denominator as unbounded. The `own` sub-language rejects `../x`, `/etc`, `C:\`, `!x`,
`{a,b}`, `**`, `dir/**/*.ts`, `//`, NUL, over-long, root `**`, `.git/**`; `dir/` ≡ `dir/**`; NFC on both sides.
`commit.ts addSet` matches §2.6; `stageable` blocks `..`/`.git`/absolute/NUL; rename sources staged; 256-path chunking;
`--literal-pathspecs` placement; `runGit` `-c` reassembly order. `nextLandStep` neither wedges nor settles early.
`landLogLine` degradation stays parseable. `readManifest` bounded, finite numbers, no prototype-pollution path,
checksum recomputed. Question bounds met. Import boundary clean; no `any`.

## Deviations judged

`canonical.ts` holding both `manifestId` and the checksum: right. Reimplementing the land lock instead of importing
`src/session/lock.ts`: forced by §8.1 rule 1, fine. `verify` clipped-not-redacted: wrong as it stands (finding 4).

## Addendum — probes executed after the CPU hold lifted

All eleven probe-able findings reproduced exactly on 2be87e1 (TRACED → CONFIRMED); nothing retracted. Two are worse
than written: **finding 2** — `validateOwnList(['src/a0/'…'src/a32/'], {deny:['src/secrets']})` returns
`ok: true, globs: ['src/**']` while `validateOwnList(['src/**'], …)` refuses that very glob; **finding 8** — a manifest
edited on disk to `task: 'exfiltrate everything'`, `own: ['src/**']`, `capUsd: 99` with the `manifestId` kept and the
unkeyed checksum recomputed reads back `ok: true`, `sameDelegation` is `true`, and it is ADOPTED. **Finding 11** —
with a ref for `previousHead` and `exclude: []`, the reset is skipped and both `dist/built.js` and an untracked
precious file are deleted. The branch's own suite is 307/307 and `tsc` clean: the defects sit where the tests do not
look, and three tests encode the bug as correct (`stall.test.ts:85`, `globs.test.ts:201`, `land.test.ts:352`).
Merge blockers in priority order: 8, 1, 2, 3; then 4, 11, 5, 6; the rest are polish. Findings 12–14 remain PLAUSIBLE
(not probed).
