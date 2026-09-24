# Round-5 topic: the coordination surface (`/sessions`, `sessions`, pause/resume/end, peers)

Scope: `docs/COORDINATION-DESIGN.md` §12.0.4 (product contract), §3.1, §10.3, §14 item 19 "as built" at `6d46875`,
plus `src/coordination/**` and `src/session/**` as they exist on this worktree (`r5-design`, based on `main`). Every
symbol below was grepped/read directly against the files in this checkout; line numbers are as-seen. Read-only —
nothing under `src/` or the other design docs was touched to produce this file.

---

## 1. What the designs and the code say (verified, file:line)

### 1.1 The facade — which files, which Ledger type

`src/coordination/index.ts` (343 lines) is the **only** import path COORDINATION-DESIGN.md §12.0.4 grants
`src/session/**` / `src/cli/**` / `src/tui/**`. The design's own as-built reconciliation (§14 item 19) lists the real
module split: `types.ts` (contract types), `claims.ts` (claim fence + authenticity), `fold.ts` (fold readers),
`records.ts` (parsing, `isLive`, `lockReplaceVerdict`), `ledger.ts` (`openLedger`, `LedgerHandle`), `leases.ts`,
`mailbox.ts`.

**Two Ledger types exist, and round 5 must type against the wider one.** `src/coordination/types.ts:466`:

```ts
export interface Ledger {
  readonly root: string; readonly self: SelfIdentity; readonly fold: Readonly<Fold>;
  open(): Promise<void>; setIdentity(patch: IdentityPatch): Promise<void>;
  subscribe(cb: (fold: Readonly<Fold>, change: FoldChange) => void): () => void;
  close(): Promise<void>;
}
```
— 7 members. `src/coordination/ledger.ts:189` declares `LedgerHandle extends Ledger`, and `openLedger()`
(`ledger.ts:1774`) returns `LedgerHandle`, not `Ledger`. The extension (`ledger.ts:189-321`, 132 lines) adds far more
than the "25 members" the merge commit `6d46875` names or the 27 the round-5 digest counted: `paths`, `hostKey`,
`bootId`, `fs`, `now`, `monotonicNow`, `redact`, `stamps`, `mirror`, `opened`, `actor8`, `timers`, `status`, `clock`,
`enqueue`, `writeOwn`, `writeOwnSync`, `removeOwn`, `trackLease`, `untrackLease`, `removeOwnFile`, `refresh`,
`refreshFence`, `foreignLive`, `peerLive`, `claim`, `forkVerdict`, `nextEpoch`, `takeoverLease`,
`writeClaimsProjection`, `readClaimEpochs`, `forceTakebackEpochFor`, `readRunClaim`, `ignoreDevice`,
`unignoreDevice`, `pairDevice`, `reloadTrust`, `resolveDeviceRef`, `allDeviceIds`, `unpairDevice`, `syncStatus`,
`setDeviceLabel`, `syncDisable`, `sign`, `verify`, plus more past line 321 (`gc`-adjacent helpers). **Recommendation
(§5): the TUI types every coordination-surface variable as `LedgerHandle`, never the bare `Ledger` contract type** —
the base interface cannot render `sessions who`, cannot call `forkVerdict`, cannot call `setDeviceLabel`.

### 1.2 The claim fence — `claimRefusal`, `ForkVerdict`, `lockReplaceVerdict`

All three exist exactly as COORDINATION-DESIGN.md §14 items 18/19 describe them, verified against the code:

- **`ForkVerdict`**, `src/coordination/claims.ts:220-235`:
  ```ts
  export type ForkRole = 'alone' | 'holder' | 'loser';
  export interface ForkVerdict { role: ForkRole; holder: Claim; losers: Claim[]; verified: boolean; unverifiedFork: boolean }
  ```
  `forkVerdict(mine, others)` (`claims.ts:246-254`) computes the holder as the highest **qualified** epoch
  (`others.filter(o => o.authority !== 'unverified')`); `role === 'loser'` is what gates the engine-side exit-2 stop
  — but **only when `verified === true`** (`claims.ts:251`: `qualified.some(c => compareClaim(c, mine) < 0)`).
  `unverifiedFork` (`claims.ts:252`) is `others.some(o => o.authority === 'unverified' && compareClaim(o.claim, mine) < 0)`
  — the row-51 notice: a claim that outranks mine but was never authenticated, which must raise a flag, never a stop.
- **`claimRefusal(local, foreign)`**, `claims.ts:265-282`: refuses `/resume` only when a **qualified** foreign epoch
  strictly exceeds `max(local)`; an unqualified epoch (`r.qualified === false`) is skipped entirely (`claims.ts:274`),
  never refusing. Epochs outside `[FIRST_EPOCH, MAX_CLAIM_EPOCH]` are dropped before comparison (`claims.ts:275`).
  Ties on epoch break by the lower `deviceId` (`claims.ts:277`). **This function has no caller anywhere in
  `src/cli/**` or `src/tui/**` today** — `grep -rn claimRefusal src/cli src/tui` is empty; `resumeRun`
  (`src/cli/session.ts:2296`) does not call it, `readFold`, or `openLedger` at all.
- **`lockReplaceVerdict({ lock, peerLive, self })`**, `src/coordination/records.ts:829-846`, returning
  `LockReplace = { replace: true; reason: 'no-lock'|'dead-pid'|'other-boot' } | { replace: false; reason:
  'peer-live'|'boot-unknown'|'held'; detail60: string }`. A fresh foreign heartbeat (`peerLive !== null`) refuses
  replacement unconditionally, before the pid/boot checks run at all (`records.ts:830-834`) — this is the fix for
  the "stale-reused-pid" double-writer bug §3.2/§14 item 18's re-check (6) names. **No caller in `src/session/**`
  either** — `src/session/lock.ts` (`RunLock:14`, `isPidAlive:27`, `parseRunLock:38`, `readRunLock:48`,
  `lockIsLive:57`, `lockInUseMessage:62`, `acquireRunLock:91`, `releaseRunLock:132`) has its own, older
  `lockIsLive(lock, { host, isAlive })` that does not consult `peerLive` or `bootId` at all. Wiring
  `acquireRunLock`/`takeRunLock`'s "should I replace this lock" decision to `lockReplaceVerdict` is a harness-side
  change (`src/loop/**`), but the TUI-owned `sessions who`/`sessions unlock` text that explains **why** a lock could
  or could not be replaced should read the same three-reason vocabulary (`no-lock`/`dead-pid`/`other-boot` vs.
  `peer-live`/`boot-unknown`/`held`) so the CLI's explanation and the engine's actual decision cannot drift apart.

### 1.3 The registry API surface that exists vs. the surface `/sessions` needs

`src/coordination/fold.ts` has every pure reader the design names: `listSessions` (`:387`), `byRunId` (`:443`,
the design's `byRun`), `claimHolderOf` (`:462`), `sessionDevices` (`:474`), `ackOrigin` (`:488`), `originOf` (`:493`),
`messageOrigin`/`leaseOrigin` (`:498`/`:503`), `seenEpochs` (`:514`), `childrenOf` (`:524`). `Fold`
(`src/coordination/types.ts:327-366`) has all 14 fields the design's §14 item 19 table lists: `live`, `gone`,
`leases`, `byPath`, `inbox`, `acks`, `devices`, `cloned`, `liveness`, `ignored`, `skipped`, `at`, `forks?`, `origins`.
**None of this is imported anywhere under `src/tui/**` or `src/cli/**` today**: `src/tui/status/lines.ts` has zero
matches for `coordination`/`peer`/`heads-up`/`⇄`; `src/chat/facts.ts:17-18`'s `FACT_KEYS` (14 keys — `what_it_is`,
`mode_now`, `switch_mode`, `workspace`, `last_run`, `last_tests`, `keys`, `cost_so_far`, `sandbox`, `how_to_task`,
`review`, `undo`, `commands`, `provider`) has no "who else is working here?" fact; `src/tui/blocking/lines.ts` has
no `PeerView` reference; `src/session/picker-lines.ts` (`:1-33`) measures and filters purely on the local index plus
a caller-supplied `live?: (runId) => boolean` — it never reads a fold.

`src/cli/sessions.ts` (137 lines) implements exactly `list | reindex | prune | unlock` (`sessions.ts:124-130`); none
of `who`, `pause`, `resume`, `end`, `tell`, `headsup`, `request`, `inbox`, `label`, `pair`, `unpair`, `gc`, `sync`
exist. `src/tui/commands/registry.ts`'s `COMMANDS` array has **exactly 37 entries** (counted directly:
`name: '...'` at the 4-space indent inside the array — 37 matches), matching round 4's own "37 → 41" delta and the
digest's count; `/pause` exists (no args, `live`-only, title "stop after the step in flight commits") but has no
`[now]` / target grammar; `/who`, `/inbox`, `/tell`, `/headsup`, `/request`, `/end`, `/peers` are absent.

### 1.4 The contract types that landed vs. the ones that didn't

`src/core/types.ts` header lines 9-14 show `// contract 1.1` … `1.4` (coordination) … `1.7` (TUI round 4) — no
`1.5`/`1.6` (orchestration/import haven't merged). **Landed already, verified directly:**
- `PausePointReason` (`types.ts:1543-1548`, 5 members: `step | now | now-after-execute | pane | worktree`),
  `PausePoint` (`:1551-1573`), `PauseOptions`/`EndOptions`/`RunEnded` (`:1578-1595`).
- `Engine.pause(opts?: PauseOptions): void` (`:1769`), `end?(opts?: EndOptions): void` (`:1771`),
  `deliver?(msg: DeliverableMessage): AckOutcome` (`:1773`); `AckOutcome` (`:1623`), `DeliverableMessage` (`:1630`).
- `SessionHost.peers?(): PeerView | null` (`:1901`) and `PeerView { live, stale, oldestStartedMsAgo, exclusive }`
  (`:1904-1909`) — round 4's §7.10 stub type, tagged `contract 1.6 item 9` in the comment even though the file
  header three lines up says `contract 1.7`; a real numbering inconsistency worth fixing before round 5 adds its own
  header (§6 open question).

**Not landed, verified by absence:**
- `EngineOptions` (`types.ts:1239`) has **no `coordination?: CoordinationOptions` field** — grepped the full
  interface body, zero matches for `coordination`/`Ledger`/`peerLive`/`identity`. `src/loop/engine.ts` has exactly
  one match for the string `coordination` (a doc-comment at `:1235` citing the design section, not code).
  **No file under `src/loop/**`, `src/cli/**` or `src/tui/**` imports from `src/coordination/**` at all** — the
  entire ledger/fold/claims machinery is built and unit-tested in isolation but wired into nothing.
- `StageName` (`types.ts:243`) has 8 members, no `'coordinate'`.
- `BlockingKind` (`types.ts:1225`) has 6 members — `jev-unreachable | key-rejected | spend-limit |
  checkpoint-degraded | drift | sandbox-unavailable` — **no `'lease-conflict'`**. This matters concretely: §12.0.2's
  pause-point table (P6, P7) and §4.3 steps 4-5 describe a `lease-conflict` pane with `[w]`/`[r]`/`[t]`/`[q]` keys and
  a worktree-relocation flow, but there is no type for the TUI to render that pane against yet.
- `UiLabel` (`types.ts:1461`) has 6 members — `[ui] | [setup] | [config] | [sandbox] | [you] | [jevcode]` — **no
  `[session]`**, which §5.3 requires for every applied remote verb's transcript line.
- `SessionRow` (`types.ts:1923-1933`) has no `ended?`, `parentSessionId`, or `workspaces?` field; `run:start`
  (`src/session/index.ts:25`) has no `parentSessionId`. `INDEX_KINDS` (`src/session/index.ts:36`) is
  `['run:start', 'run:end', 'rename', 'steer', 'undo', 'pause', 'budget', 'chat']` — 8 kinds, none of
  `session:end`, `relocate`, `handoff`.
- `src/config/types.ts`'s `SettingName` union has **no `coordination.*` row** at all (checked the full union) —
  `coordination.claims`, `.remoteControl`, `.sync`, `.syncRuns`, `.notify` have no config schema entries, so there
  is nothing for `jevcode config` to print or `resolveConfig` to resolve yet.
- The pause index line (`src/cli/session.ts:1550`) writes `{ v:1, t, kind:'pause', sessionId, runId, step }` — no
  `by` field, so §5.3's "every applied remote verb gains `by: 'self' | 'peer:<sid8>' | 'device:<id8>'`" is unbuilt.

### 1.5 Test coverage: solid on the harness side, absent on the TUI side

`test/unit/coordination/` has 10 files (`fold`, `heartbeat`, `ids`, `leases`, `ledger`, `mailbox`, `records`,
`subwork`, `sync-shared-dir`, `watch`) — `records.test.ts` alone imports and exercises `claimRefusal`, `forkVerdict`,
`compareClaim`, `hmacOf`/`hmacValid`, `mintClaim` directly from `claims.ts` (`records.test.ts:7`, assertions at
`:193-275`), so the claim fence itself is well tested even though the design named a separate `claims.test.ts` that
doesn't exist as its own file. **What genuinely doesn't exist**: `sessions-target.test.ts` (the §5.3 target-grammar
resolver), `engine-takeover.test.ts` (the `/resume` → `claimRefusal` wiring), `sessions-gc.test.ts` — all TUI/CLI-side
tests the design names, none present under `test/`.

### 1.6 Round-4's `/peers` stub — what round 5 is wiring into

TUI-DESIGN-4.md §7.10 (P-D10) specifies a `PeerView | null`-driven surface: a status-line segment (`2 here`, count
only, never a pid or path), a session-open `[ui]` item pointing at a real `/peers` command (never a dead pointer —
§6.6 edge 6's rule), and a blocking pane `[w] wait for it   [r] read-only session   [q] quit` when a peer holds an
exclusive lease. Its `/peers` command spec: `{ name: 'peers', category: 'session', usage: '/peers', args: [],
available: 'always' }`, output a block headed `peers · <n> here, <m> stale`, one `kv` row per peer
(`workspace`, `started <t> ago`, `<state>`), the stub sentence `the peer registry is not available in this build`
when `PeerView` is null. This is unimplemented on `main`/this worktree (§1.3 above — 37 commands, no `/peers`;
`PeerView` has zero consumers in `src/`). Round 5's job, stated by both this digest and by COORDINATION-DESIGN.md's
own §12.0.4 (`Fold.inbox`/`liveness`/`ignored`/`cloned`/`origins`), is to replace the stub's `PeerView` (4 fields:
`live`, `stale`, `oldestStartedMsAgo`, `exclusive`) with a real `Ledger`/`Fold`-backed implementation — but
`PeerView`'s own shape is far narrower than `SessionActivity` (`src/coordination/types.ts` — `runId`, `sessionId`,
`deviceId`, `label`, `liveness`, `flags: {hung,skewed,forked,takenOver,noLock,ignoredDevice,unverified,cloned}`,
`heartbeat`, `leases`, …), so either `PeerView` grows into something closer to a `sessions who`-lite row set, or
`/peers` becomes a thin, count-only view while `/who` (net-new) exposes the full `SessionActivity` rows. §5 below
recommends the split explicitly.

---

## 2. What the best tools do (cited)

- **tmux** is the closest analogue to "multiple engines sharing one ledger and needing to know about each other."
  Its status-line format variables (`#{session_name}`, `#{session_attached}` — client count, not identity —
  `#{session_activity}`, `#{session_windows}`) are exactly the shape JevCode's `⇄ 2 live · 1 heads-up · ✉ 1` zone
  imitates: a count and a recency, never a pid or a path, with the full detail one keystroke away (`tmux ls` /
  `Ctrl-b s`). ([tmux status-bar docs](https://mintlify.com/tmux/tmux/concepts/status-bar);
  [tmux(1) man page](https://man7.org/linux/man-pages/man1/tmux.1.html)) tmux has no cross-session *authority* model
  at all — any attached client can kill any pane — which is the gap JevCode's claim/epoch fence exists to close
  that tmux never had to.
- **Claude Code** writes one small file per running session under `~/.claude/.../sessions/` specifically
  "for detecting concurrent sessions and crashes" (per this repo's own prior research,
  `docs/research/tui/10-sessions-and-multiturn.md:50`, citing `https://code.claude.com/docs/en/claude-directory`),
  and warns that resuming the same transcript from two processes makes the transcripts "interleave"
  (`10-sessions-and-multiturn.md:589`) — i.e., Claude Code detects the collision but does not fence it; JevCode's
  claim epoch is a strictly stronger answer to the same problem. This session's own `ListAgents`/`SendMessage`
  tools are the live version of the same idea one layer up: a flat directory of named peers (subagents, teammates,
  other local sessions, cloud sessions) with a `[ref]` disambiguator only shown when two rows share a bare name —
  the same "resolve by unique suffix, disambiguate on collision" rule COORDINATION-DESIGN.md §5.3's `resolveTarget`
  uses for run/session ids.
- **opencode**, by contrast, is the cautionary tale for *not* having a claim fence: multiple opencode instances in
  the same project share one SQLite database keyed by working-directory-derived `project_id`, so two concurrent
  instances read/write the same session rows, interleave loop/stream output into "phantom assistant messages", and
  can corrupt the shared git-snapshot store with a literal `gc.pid.lock: File exists` race
  ([opencode issue #31307](https://github.com/anomalyco/opencode/issues/31307),
  [#49190](https://github.com/anomalyco/opencode/issues/49190),
  [#49367 "two processes can run loops on the same session simultaneously"](https://github.com/anomalyco/opencode/issues/49367),
  [#4251 "concurrent sessions working on different repos interfere"](https://github.com/anomalyco/opencode/issues/4251)).
  Proposed fixes in that thread — an exclusive SQLite lock, or a PID file under the data dir — are exactly the
  weaker cousins of JevCode's `run.lock` + heartbeat + claim epoch. This is strong external evidence that the
  claim-epoch fence (§9.3) and `lockReplaceVerdict`'s refusal-by-default (§1.2) are solving a real, currently-shipping
  bug class in a peer tool, not a speculative one.
- **Codex CLI**'s two-region streaming (stable lines committed to `<Static>`, a 2-row mutable tail) is unrelated to
  multi-session awareness but is the same discipline JevCode's own transcript already follows; nothing in the
  locally-fetched Codex research (`docs/research/tui/04-codex-cli.md`) documents a cross-instance awareness feature
  to compare against — Codex does not appear to coordinate multiple concurrent CLIs on one repo at all.
- **Cursor / Aider**: no locally-cached research on either tool's multi-session model exists in this repo
  (`docs/research/tui/` has no Cursor/Aider file), and neither is well documented publicly for *concurrent-instance*
  coordination specifically (both are largely single-session-per-editor-window tools) — flagged rather than guessed
  at (see §6).

**Takeaway for §5**: the count-first, detail-on-demand pattern (tmux's status line, Claude Code's toast-free
"one file per session") is already what round 4's `/peers` stub and COORDINATION-DESIGN.md §3.6's status zone do;
the thing none of the three comparison tools have, and JevCode's design does, is an authenticated ownership fence
(`claimRefusal`, `ForkVerdict`) — that is the feature to protect most carefully during round 5's wiring, not to
simplify away for the sake of matching a peer tool's simpler (and, per opencode's issue tracker, buggier) model.

---

## 3. Edge cases

Grounded in COORDINATION-DESIGN.md §7.2's per-point table, §7.6, §9.3, §10.3 and §11, cross-checked against the
current code's gaps from §1:

1. **Mid-step pause (`pause({at:'step'})`)** — P1/P2 in the design's table: the step completes, commits whole, then
   the loop top calls `finish('human_pause')`. No code gap; `Engine.pause` exists (`types.ts:1769`) and the pause
   index line already fires (`session.ts:1550`) — it just lacks `by`.
2. **Mid-stage pause-now (`pause({at:'now'})`)** during `replan`/`intent`/`context`/`propose`/`risk` — a synchronous
   draft snapshot to `cache/step-<n>.json` before the abort fires, so `[r]` replay is possible. `PausePoint.resumableAt`
   and `.replayable` (`types.ts:1551-1573`) already model this; nothing to build TUI-side beyond reading the fields.
3. **Mid-LLM-round pause (P3, llm-jev only)** — every arrived sample is already on disk; `PausePoint.llm =
   { goalId, round, arrived }`. This is the one point that depends on the `'coordinate'` StageName member landing
   (§1.4) — until then `PausePoint.llm` and `StepRecord.coord` have nowhere to be populated from on the round-5
   timeline, so any TUI rendering of it is necessarily fixture-driven, not live.
4. **Mid-execute / mid-command (P4/P5)** — the rule is **wait, never kill**: `pausing · execute finishes first (12s)`.
   No TUI gap; this is purely a status-line string (§4).
5. **A blocking pane is open (P6)** — `[p]` pauses, `[q]` stops in every pane except `drift` (`[p] pin`/`[q] stop`
   only) and `checkpoint-degraded` (`[r]` retries the write, not a `human_pause`). **`lease-conflict` (P6/P7) has no
   `BlockingKind` member yet (§1.4)** — this is the one pane round 5 cannot render at all until the harness side
   adds it, or round 5 explicitly defers the pane and only builds the status-zone / `sessions who` half.
6. **Across devices** — `/resume <id> --on device:<label>` routes a message; the far device needs a live TUI
   (`[y] resume here [n]`) or `coordination.remoteControl: 'allow'` to spawn headless. **Neither `remoteControl` nor
   any other `coordination.*` setting has a config schema row (§1.4)**, so this mode cannot even be configured yet —
   round 5's config-skeleton work (shared with the orchestration slot per the round-5 digest §C) has to land before
   this edge case is reachable in the product, not just in the design doc.
7. **After a crash** — `sessions who` reads `gone` facts (`Fold.gone`, kept ≤ 10 min) and prints
   `crashed 3m ago during step 8 (propose, 41s in) — step 8 restarts`. `listSessions` (`fold.ts:387`) already
   computes this; the picker (`picker-lines.ts`) has no fold input to read it from yet.
8. **For a bench** — `Heartbeat.kind: 'bench'` carries `bench: { benchId, tasks, lanes, spendUsd }`; the design's
   row format `● mbp  bench glm-vs-jev  12/30 tasks live 4 · lanes 8` is a distinct renderer branch from the run row,
   not a variant of it — a naive `sessions who` that assumes every heartbeat is a run will misrender every bench row.
9. **Fork with an unverified peer** — never a stop, only `⚠ forked` + `[c] continue here / [q] stop`
   (`unverifiedFork`, §1.2). The TUI must never conflate `role === 'loser'` alone with "stop": the gate is
   `role === 'loser' && verified === true`; rendering `role` without `verified` would either stop on a forged beat
   or silently swallow a real takeover.
10. **A cloned device** (`Fold.cloned: Set<string>`) — every gated action (`steer`, `pause`, `resume`, `end`,
    import, the exit-2 stop, the `/resume` claim refusal) is suspended for that `deviceId` until re-paired; its
    records still display and still count for conflict detection. A UI that hides a cloned device's row entirely
    (rather than showing it flagged `⚠ cloned`, disabled) would hide the exact information a human needs to fix it.
11. **`--force-takeback` at the epoch ceiling** — `claimRefusal`'s bound-filtering (§1.2) means a planted epoch at
    `MAX_CLAIM_EPOCH` cannot lock a run out forever, but the CLI/TUI text must say the mint is "input-clamped, never
    output-clamped" honestly (§9.3's own distinction) — a UI that prints "taking over…" without surfacing
    `'epoch-exhausted'` on the rare refusal path will look like a silent hang instead of a stated, permanent limit.
12. **`sessions gc --device` resolving a label past `MAX_DEVICES`** — the fold caps at 16 device subtrees, but `gc`'s
    label resolution walks the disk directly (up to `MAX_GC_DEVICES` = 1,024) specifically so the junk past the fold
    cap can still be named and removed. A `sessions gc` implementation that resolves labels through `fold.devices`
    (the tempting shortcut) cannot ever reach the case it exists to fix.
13. **Same-device message needing no confirm vs. a forged one** — "same device" is the **read location**
    (`ctx.origin === 'local'`), never a content comparison; a forged file placed in the local subtree pretending
    `deviceId` matches still has to pass the `hostKey`/`bootId` checks (§5.4 rules 4/5) before it auto-applies. A
    TUI/CLI implementation that checks only `record.deviceId === self.deviceId` reintroduces exactly the
    vulnerability the design's revisions 4/5 closed.
14. **Two runs in one checkout with diverging `repoKey`** — an unborn-HEAD race can make one run's `repoKey` differ
    from a sibling's; the dual-directory lease write (`keyDir(repoKey)` and `keyDir(wsKey)`) is what keeps them
    mutually visible. Not a TUI-owned mechanism, but any TUI text that names "the lease directory" as singular would
    misdescribe the on-disk layout for this case.

---

## 4. Pinned strings and twins

Every string below is quoted verbatim from COORDINATION-DESIGN.md; each needs an Ink render, a `--plain` twin
(through `blockLines`/`plain.ts`), a `--json` shape where the verb has a CLI form, and a screen-reader/`--ascii`
announcement (per this worktree's own standing rule, TUI-DESIGN-4.md §0). None of these strings exist in
`src/tui/plain.ts` or `registry.ts` today (§1.3/§1.4).

**`sessions who` / `/who` row** (§3.6):
```
● mbp  main@3f9a2c1  step 7/40 propose  jev+llm  ctx 41%  $0.12/2.00  editing src/loop/engine.ts (+1)  lanes 2 · samples 3  beat 2 s
● mbp  bench glm-vs-jev  12/30 tasks live 4 · lanes 8
◌ stale (last beat 4 m ago) · crashed during step 8 (propose)
● … (no beat 4 m — hung?)
? unknown (not synced yet)
```
Status zone: `⇄ 2 live · 1 heads-up · ✉ 1`.

**Resume card** (§7.3 step 2, the full block):
```
─ resume 20260921-234432-rpywkq2v · "fix store rotation" ──────────────────────────────
paused 42 m ago · now at step 7 (pause now during propose, 62 % streamed) · 3 steers pending
HEAD 3f9a2c1 → 8bc0d11 (2 commits by mbp: "fix store rotation", "tests") · changed since: store.ts, engine.ts
live on this repo: mbp (step 12, editing src/tui/App.tsx) · spend $0.42/2.00 · wall 12m04s/30m · ctx 41%
[Enter] resume (fresh step 7)   [r] replay the paused proposal   [f] fresh   [d] diff since pause   [w] who   [Esc]
```
Variants: `targets changed since the proposal (store.ts by mbp@8bc0d11) — replay unavailable`; imported run:
`the paused proposal and its samples stayed on <label> — resuming starts a fresh step`; crashed:
`crashed 3 m ago during step 8 (propose, 41 s in) — step 8 restarts`; live elsewhere:
`● live on mbp — [w] watch (read-only tail) · [t] tell · [p] ask to pause · [Esc]`.

**Pause / resume / end status-line strings** (§7.6 table, verbatim):
- `pausing · step 8 commits first (propose, 41 s, ~40 s p50 left) · Esc Esc aborts · Ctrl-X Ctrl-P pauses now`
- `paused now at step 8 (propose): proposal kept — /resume replays it`
- `paused after step 7 — /resume continues, or type a follow-up` + `· 3 steers pending · mbp is live on this repo`
- `paused at the <kind> pane after step 7 — /resume retries it`; `checkpoint degraded: <code> on state.json — not
  resumable (exit 3)`
- `resumed at step 8 (replayed the paused proposal; risk re-checked)` / `resumed at step 8 (fresh: targets changed)`
  / `resumed here from mbp (imported 7 steps; undo unavailable)`
- `relocated to worktree <slug> (branch jevcode/<slug>) — /worktree back merges or hands off`
- `ended session "<title>" after step 7 — /resume <id> --force reopens`
- `mbp asks to pause this run — [y] at step end  [Y] now  [n] ignore`
- `taken over by mbp at 14:02 (claim 4) — /resume --force-takeback re-takes it`
- forked, verified peer: `stopped: run <id> is also live on mbp (claim 4 supersedes 3) — this device's steps 8–9
  kept as steps.forked-…jsonl`; unverified: `run <id> also appears live on mbp (unverified) — [c] continue here
  [q] stop`
- `watching <runId> — tailing transcript.log` (same device) / `watching mbp · updates every 15 s + sync lag` (other)

**End confirm row** (§7.4): `end this session: [y] at step boundary  [Y] now  [n] stay`.

**Messaging** (§5.2-5.5): `[session] mbp: committed 3f9a2c1 on main — engine.ts, store.ts`;
`mbp asks to pause this run — [y] pause at step end  [Y] pause now  [n] ignore`;
`heads-up: editing src/loop/engine.ts (+1) for: <task60>`; `mbp is waiting for src/x.ts — commit and move on when
you can`; unpaired ack: `refused` with `detail60:'device unpaired'`.

**Security/pairing** (§10.3): `unpaired mbp — it can no longer steer, stop, resume, end or import your runs. It
still holds this device's key: run 'jevcode sessions pair --rotate' to invalidate it everywhere.`;
`this device took a new id (<id8>) and a new key — run 'jevcode sessions pair' with each peer again`;
`device id <id8> is also live on another machine — run 'jevcode sessions pair --rotate' to invalidate the shared
key`; `machine id unavailable — two machines sharing this home would share one device id`.

**Claim / takeover display** (§9.3): `mbp claims 4 (unverified) — ignored; sessions pair to make it count`;
`ignored an out-of-range unqualified claim from <label> — the new claim is <n>`; `claim epochs for this run
reached the bound (1e9); nothing can take it over — start a new run from this state`; import card:
`import run <id> from mbp#3f9a (host MacBook-Pro.local) — [i] import  [Esc]` (+ `unverified` suffix pre-pairing);
`origin not fully synced yet (step N row missing)`.

**`/peers` stub → real** (TUI-DESIGN-4.md §7.10): `another jevcode is working in this workspace (started 4m ago) —
/peers lists them`; head `peers · <n> here, <m> stale`; empty: `no other jevcode is working in this workspace`;
no registry: `the peer registry is not available in this build`; pane `[w] wait for it   [r] read-only session
[q] quit`.

**Twins, stated once so no verb ships without them**: every row above needs (a) an Ink block/status render, (b) a
`blockLines`/`plain.ts` line for `transcript.log` and `--plain` stdout (identity rule, §5.3), (c) a `--json`/
`--json=verbose` line for the CLI twin (`sessions who --json`, `session:peer`/`session:message` events), and (d) a
screen-reader announcement + `--ascii` glyph substitution for every glyph used (`●`, `◌`, `⇄`, `✉`, `⚠`, `→`, `↪`).

---

## 5. Recommended decisions

### 5.1 Which Ledger type the TUI imports

**Options**: (a) type against the narrow `Ledger` (7 members) and cast/widen at call sites; (b) type against
`LedgerHandle` everywhere; (c) define a third, TUI-specific narrower view type.
**Recommendation: (b).** `openLedger()` — the only constructor `src/session/**`/`src/cli/**` will ever call — returns
`LedgerHandle`, not `Ledger` (§1.1). Every read the surface needs (`status()`, `forkVerdict()`, `setDeviceLabel()`,
`syncStatus()`) lives only on the extension. Introducing a third type (c) would duplicate a contract the harness
already maintains and drift the moment either side adds a member. The one place `Ledger` (narrow) is the right type
is a function signature that is deliberately generic over "any ledger-shaped thing" (there are none identified in
the surface work); default to `LedgerHandle`.

### 5.2 `/peers` vs. `/who`: one command or two

**Options**: (a) make round 4's `/peers` the one and only cross-session command, growing `PeerView` into something
closer to `SessionActivity`; (b) keep `/peers` exactly as specified (count + coarse state, §1.6) and add `/who` as
the new, full-detail command COORDINATION-DESIGN.md §3.6 actually specifies; (c) drop `/peers`, rename it to `/who`
and treat round 4's spec as superseded.
**Recommendation: (b).** Round 4's `/peers` was scoped deliberately narrow — "never a pid, never a path" — as a
low-detail, always-safe surface for the common "am I stepping on myself" case. COORDINATION-DESIGN.md's `/who` is
explicitly a different, richer verb (`step 7/40 propose`, `editing src/loop/engine.ts (+1)`, `lanes 2 · samples 3`).
Merging them either overloads `/peers` past its stated "no pid, no path" privacy contract or under-serves `/who`.
Ship both: `/peers` wired to a `Ledger`-backed `PeerView` builder (still 4 fields, still privacy-narrow), `/who` as
the new command reading `listSessions(fold, self)` directly. `/inbox`, `/tell`, `/headsup`, `/request` are separate
verbs regardless (§5.3's target grammar has nothing to do with the peer-count question).

### 5.3 Where the target-grammar resolver lives

**Options**: (a) one `resolveTarget` in a new TUI-owned module (e.g. `src/tui/commands/target.ts`) shared by every
slash command and by `src/cli/sessions.ts`; (b) duplicate the resolver per call site; (c) put it in
`src/coordination/index.ts` and import it, even though it is pure string/fold logic with no coordination I/O.
**Recommendation: (a).** The reserved-word-vs-title collision rule (§3, "`resolveTarget` resolves in a stated
order... a title equal to a reserved word is addressable only by id") is exactly the kind of logic that must be
tested once (`sessions-target.test.ts`, named but absent — §1.5) and shared, not re-derived per verb. It belongs to
the TUI side by the design's own ownership table (§12.0.1: `src/session/**`, `src/cli/**`, `src/tui/**` are the TUI
session's), and it takes a `Fold` as a plain argument rather than a `Ledger`, so it has no reason to live inside the
harness-owned facade.

### 5.4 How `/resume` gets its claimRefusal wiring without touching `src/loop/**`

**Options**: (a) `resumeRun` (`src/cli/session.ts:2296`) calls `openLedger()`/`readFold()` itself, reads
`runs/*/<runId>/claims.json` via the fold, and calls `claimRefusal` before `createEngine`; (b) push the refusal
into the harness (`createEngine` itself refuses); (c) leave the refusal engine-side (already partly true per
COORDINATION-DESIGN.md §12.0.1 rule 5: "the `Ledger` handle is created by the caller… the engine never opens a
second one") and have the TUI only read the **result** for display.
**Recommendation: (a), matching the design's own §12.0.1 ownership split exactly.** `EngineOptions.coordination`
(§1.4) does not exist yet, so `createEngine` cannot refuse anything coordination-shaped on its own — that field is
harness-side, unbuilt work outside round 5's file ownership (`src/loop/**`, `src/core/types.ts` non-TUI blocks).
`resumeRun` already owns the pre-`createEngine` check sequence (foreign liveness, relocation, HEAD drift — §7.3
step 1) as plain TUI-side code; adding the claim check to the same function, before the same call, is the smallest
change that satisfies §7.3 step 1(a) without waiting on `EngineOptions.coordination` to land. This is the change
`engine-takeover.test.ts` (named, absent) should cover.

### 5.5 `BlockingKind` and the `lease-conflict` pane: build now or defer

**Options**: (a) request the harness slot add `'lease-conflict'` to `BlockingKind` in this round, as a §9.2-style
cross-slot request, and build the pane against it; (b) defer the pane entirely to round 6 and ship only the
status-zone / `sessions who` half of coordination this round; (c) build the pane against a **TUI-local** stand-in
type and reconcile later.
**Recommendation: (a) if the harness slot can land the one-line additive union member early in the wave, else (b).**
`BlockingKind` is a `src/core/types.ts` union with no structural risk in widening it (additive, matches every other
contract-1.4 change's own stated pattern). (c) risks exactly the kind of type drift the round-4 digest already
flagged for orchestration's `PausePointReason` additions — a TUI-local stand-in becomes a second source of truth the
moment the real member lands with a different name. Given the file is core and the change is one union member, it
is cheap enough to request rather than defer; but if the harness's own wave ordering cannot fit it, shipping the
`sessions who`/resume-card/messaging half without the pane is a coherent, shippable slice on its own (nothing else
in §12.0.4 depends on `lease-conflict` existing).

### 5.6 `INDEX_KINDS` convergence

**Options**: (a) one PR adding `session:end`, `relocate`, `handoff` (coordination) alongside whatever orchestration
and import need in the same array, per the round-5 digest's §B item 8 observation that three designs want the same
8-kind array; (b) coordination lands its three kinds alone, first, and the other two designs rebase onto it; (c)
each design adds its own kinds independently and accepts the merge risk.
**Recommendation: (b), not (a).** Waiting for orchestration's and import's kinds to be ready before coordination's
three land would block coordination on two designs that (per the round-5 digest) haven't started their TUI-side
work at all (§A2/§A3 of the digest: zero `orchestrat` matches in `src/tui`, no `import` CLI). Coordination's three
kinds, `SessionRow.ended?`/`parentSessionId`/`workspaces?`, and the picker's indented-child-row rendering are a
complete, testable unit on their own; landing them first and letting the later designs append to the same array
(never reordering existing entries — `INDEX_KINDS` is read by index, not by parsing order, so appending is safe)
avoids a three-way blocking dependency for no benefit.

### 5.7 `sessions pause --now` and the scope grammar

**Options**: (a) round 5 widens `/pause`'s args to the full `tree`/`agent:<slug>`/`agents`/`all`/`device:<label>`
scope grammar in one pass, sharing the parser with orchestration's `/pause [scope]`; (b) round 5 ships only the
`[now]` + coordination target forms (`<target>` per §5.3's grammar) and leaves the orchestration scopes
(`agent:<slug>`, `agents`) to whichever round lands the agent tree; (c) leave `/pause` as-is and ship `sessions
pause` as CLI-only.
**Recommendation: (b).** The digest's own round-5 slot plan (§C, R5-1) already scopes this: "widen `/pause`'s
args/flags for the scope grammar" is coordination's job, but `agent:<slug>`/`agents` scopes have no referent at all
until orchestration's agent tree exists (`AgentSupervisor` is "NOT FOUND anywhere" per the digest). Building the
full grammar now means writing a parser branch for a target kind (`agent:<slug>`) that cannot be exercised, tested,
or even constructed until a later round. Ship `[now]` + the coordination target forms; leave one documented TODO
comment where the scope union would grow, so orchestration's later widening is additive, not a rewrite.

---

## 6. Open questions

1. **"Ledger's 25 members"** (the `6d46875` merge commit message) doesn't match either the base `Ledger` (7
   members, `types.ts:466`) or the counted `LedgerHandle` extension (well over 27 by direct count of
   `ledger.ts:189-321` alone, before whatever exists past line 321) — which number was the commit message counting,
   and is there a narrower "public" Ledger view intended for the TUI that isn't `LedgerHandle` itself?
2. The `contract 1.6`/`contract 1.7` numbering is inconsistent **inside this worktree's own `types.ts`**: the header
   at `:14` says `// contract 1.7`, but the `SessionHost.peers?()`/`PeerView` comment at `:1901`/`:1903` says
   `contract 1.6 item 9`. Is this a stale comment from before round 4's header was renumbered, and should round 5's
   own new header be `1.8` (per the digest's contract-number ledger) regardless of this discrepancy?
3. `EngineOptions.coordination` and the `'coordinate'` `StageName` member are both still entirely absent from
   `src/core/types.ts` and `src/loop/engine.ts` (§1.4) — is the harness maintainers' plan to land the engine-side
   wiring before or after round 5 ships the `/resume` claim-refusal call, the `/who`/`sessions who` fold read, and
   the messaging verbs? None of those three strictly need `EngineOptions.coordination` (they read the fold directly,
   not through a running engine's options), but `Engine.deliver?()` and the `pause`/`end` message-application path
   (§5.4) do need a live engine that was constructed with a `Ledger` — is that in round 5's scope or round 6's?
4. `BlockingKind` has no `'lease-conflict'` member (§1.4, §3 edge case 5) — can the harness slot land this one
   additive union member early in round 5's wave 0/1, so the pane half of coordination isn't deferred wholesale?
5. No local research exists on Cursor's or Aider's multi-session/concurrent-instance model (§2) — is that gap worth
   closing with a dedicated fetch before round 5's design is finalized, or is tmux/Claude Code/opencode sufficient
   precedent for the decisions in §5?
6. `sessions.ts`'s current four verbs (`list|reindex|prune|unlock`) have no test file checked in this pass beyond
   what's implied by their existence — should the thirteen new verbs (§1.3) share one `sessions-verbs.test.ts` or
   follow the design's per-concern split (`sessions-target.test.ts`, `sessions-gc.test.ts`, `mailbox.test.ts` already
   covers the message verbs' harness half)?
