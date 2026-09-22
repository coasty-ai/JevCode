# Re-review of the seven blockers — `docs/COORDINATION-DESIGN.md` revision 3 (`c3b0aad`), 2026-09-21

One adversarial reviewer (blockers only, plus the five code decisions the revision surfaced). Verdicts: **resolved 1, 3, 7**;
**partial 2, 4, 5, 6**. Text-level must-fixes for 3 (§10.7 and §12.0.5 still state the withdrawn stamp-ownership rule).

## 1 — `Ledger.setIdentity` — RESOLVED (one gap)
§3.5 makes identity mutable in place (`setIdentity(patch)` re-derives watch roots, inbox targets, lease dir, stamp seed; engine after
`run:ready`, host at `run:start` / `run:end` / `/resume`); the fold holds all messages and `inbox(fold, self, seen)` filters, so a widened
identity needs no re-read. Gaps: a patch that adds a never-walked root (`leases/*/<newRepoKey>/`) gets no one-shot walk (`fs.watch` reports
future changes only) — the first `check()` can read `clear` by ignorance until the 15 s poll; a patch landing mid-poll-pass leaves the pass's
root list and the new one disagreeing for a tick; `label` changes (`sessions label`) but is not in `IdentityPatch`.

## 2 — facade write API — PARTIAL (narrow)
The structural defect is closed (§12.0.4 "Write API" with twelve functions; P7 uses `createWorktree`; relocation stays stop+resume).
Remaining: `sessions inbox --purge <label>` has no facade function (a direct ledger delete W1 item 15 forbids); `WorktreeInfo`, `SweepReport`,
`GcReport`, `SyncStatus` are referenced once and never defined; error semantics exist only for `removeWorktree` and `syncDisable`
(`createWorktree` dirty base / existing branch / slug collision, `setDeviceLabel` > 24 chars, `writeTakeoverLease` when offline, `gc`/`sweep`
EROFS/ENOSPC undefined); `gc({device})` vs `ignoreDevice(deviceId)` label-or-id8 unstated; W1 item 15 drops §4.6's `--i-know-it-is-gone`.

## 3 — claim epochs — RESOLVED (two stale sentences)
§3.2 `claim` is the ownership fence (minted once per process, monotonic per run, identical for every observer); `compareClaim`, the fork rule
by `claim.epoch`, and the scripted A48/B50 test hold; crash interleavings hold (max+1 after a lost append; `run.lock` keeps a second live
process off the runId). Reachable tie: a mirror that lags the append lets both devices mint the same epoch — the `deviceId`/`runId` tiebreak is
deterministic but can crown the idle device. Must-fix text: **§10.7** still says "takeover / relocation / exclusive leases carry a higher stamp;
the lower-stamp engine stops with exit 2"; **§12.0.5** still says "a double resume → the fork rule (stamp, never step count)". Also
`claim.deviceId` is missing from `parseRecord`'s id-vs-path list; `claim.epoch` has no bound beyond `Number.isSafeInteger`.

## 4 — symmetric strict fence — PARTIAL
The one-sees interleaving is fixed (§4.5 "whoever sees the other yields"; `appeared` in `declare(…, 'strict', seen)`; skew irrelevant by
construction). Gaps: (i) the both-see tiebreak has no normative mechanism — §4.4's judge fact set carries no stamp/holder-order field and the
code fallback (`wait` when `sameBranch ∧ theyTouched ∧ owner live`, else `proceed`) has `theyTouched` false on both sides at the fence, so with
Jev unreachable / `jev-off` / `--no-input` **both proceed** (G1(c)); `appeared: LeaseConflict[]` carries `stamp` — use it; (ii) the fence is
blind when `repoKey` is null (fresh clone before `run:ready`, shallow clone, non-git workspace): the lease path has a `<repoKey>` component with
no fallback while §4.3 step 2 matches such a peer by `wsKey`; (iii) peers beyond `MAX_DEVICES` (16) are invisible to the fence.

## 5 — authenticated foreign records — PARTIAL
The heartbeat door is closed (§3.4 "a foreign record alone never stops a run"; hmac-valid from `trusted-devices.json` and a superseding
`claim.epoch`). Second door still open: §9.3 "Every `/resume` — with or without a local run dir — … refuses when any foreign `claims[]` /
`imports[]` epoch exceeds the local maximum" has no trust/hmac qualifier. Scenario: plant `runs/<anydev>/<myRunId>/run.json` with
`claims:[{epoch: 9007199254740990}]` → every `/resume` demands `--force-takeback`, whose successor epoch is unmintable at the safe-integer
ceiling → the run is permanently unresumable on every device (claims are never GC'd). Key distribution (W5 sketch: phrase → scrypt → one group
`commonsKey`) never binds `keyId` to the sending `deviceId`, so any paired device can forge records as any other paired device: auto-stop
runs, poison resumes, inject steers, `remoteControl:'allow'` pause/end and headless spending resumes, seed imports.

## 6 — self by read location — PARTIAL
Applied thoroughly (§5.4 three rules; §9.1 mirror excludes my own subtree; `parseRecord(text, kind, ctx: { origin, deviceId, … })`; conflict
copies and case games fail the id/path checks). Gaps: (i) `hostKey = sha8(hostname(), userInfo().username)` collides exactly in §11 row 3's
supported case (two default-named Macs, cloned VMs, corporate images sharing one `~/.jevcode`) → both adopt the same `deviceId`, each reads the
other's records from its own local root → `sameDevice: true` → the other machine's `pause`/`end` apply with no `[y]`, and `isPidAlive` is
evaluated against a foreign pid table; `readDeviceIdentity`'s `kind:'foreign'` is unreachable by construction, so `Prompter.adoptDevice?` never
fires; (ii) §10.1's `sharedDir` containment never requires the mirror root to realpath-differ from the coordination root (one symlink
restores the forged-same-device path); (iii) `claim.deviceId` unchecked.

## 7 — whole outputs — RESOLVED
§8.3 "every `run` / `read` output longer than the 600-char body cap is written whole … the threshold is the body cap"; G3(a), M8, W2 item 18
agree; bounds adequate (≤ 1 MiB/file, ≤ 64 MiB/run). Nits: §8.5's "absent `outputRef` only for an imported run" is false once the 64 MiB cap
evicts locally; §8.3's "(≤ 2 file reads per prompt)" is stale (up to 6 reads + two 32 KiB `headTail`s vs `promptBuildMs` p95 < 5 ms); §8.2's
budget maths and the `ctx` meter were not re-costed for the ~88 KiB history can now carry.

## The five code decisions
- (a) bootId in `run.lock` at creation, no spawn in the lock path — fine; every lock writer must pass a resolved `bootId` (a lock without one
  and a live pid is never replaced).
- (b) legacy = new builder behind a switch + golden byte-identity — fine if the golden covers all three modes and a `relaxed`→`legacy` resume,
  and the switch gates the execute-side changes (pseudo-path, zero-cost unchanged-read) so legacy steps equal HEAD's.
- (c) `SynthesisContext.cache`/`onRound` additive from `onSample` — fine; have `replay` read the round directory rather than trust
  `cache/step-n.json.llmRound` (a `void` `writeSample` can lose a write).
- (d) **keep `windowBudget` — REVERSED by the owner**: revision 3 already carries `budgetTokens` + `windowTokens` in §12.0.3, §8.7, §3.3 and
  W0 item 1, and `/context`'s `budget 70k of 128k window (55 %)` needs the window; the TUI adopts `budgetTokens` + `windowTokens`.
- (e) `RunMeta.claims[]` append-only — fine; no cap on the array, and `writeTakeoverLease`'s claim for a run with no local dir is persisted
  nowhere, so a later local `/resume` can re-issue that epoch (`compareClaim` = 0).
