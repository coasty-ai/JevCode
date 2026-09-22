# JevCode orchestration design — a run that becomes a parent, agents that work in worktrees, a critic that is code, a queue that lands

Written 2026-09-21 against `main` = `a2fee9c`, re-anchored at `c3b0aad` (which landed COORDINATION revision 3 and the
`llm-jev` guard work; it changed no source file this document cites — only `src/loop/stages/{complete,judge}.ts` and
`src/synth/{llm/source,search/*}.ts` — so every `file:line` below still holds, and the `CD:` line numbers are revision
3's). Working tree: the TUI round-3 changes are uncommitted; every `file:line` was re-read in that tree.
`CD §n` is `docs/COORDINATION-DESIGN.md`, `D §n` is `docs/DESIGN.md`, `TD §n` / `TD3 §n` are `docs/TUI-DESIGN.md` /
`docs/TUI-DESIGN-3.md`.

**Spine.** This document is **Shipyard** — planner / worker / critic, children in worktrees, a code critic and a landing
queue — the design that won both judgements of the orchestration round (27/40 and 7.3/10). Its shape is kept whole: code
enumerates candidate splits and proves them safe, Jev only ranks what survived, the human ratifies through the review
confirm, the repo's own tests decide what lands, and a delegating parent **stops** rather than idling. Twenty-two grafts
from the two judgements are folded in and each is marked **[G*n*]** at the point it changes the design; §0.2 is the ledger.
Four of them are blocking corrections to the winner, not polish, and they are marked **[G1] [G2] [G3] [G4]**.

**Revision 2 — the review pass.** An independent verification pass against `c3b0aad` raised fifteen defects against
revision 1. Thirteen are valid; they are fixed **in place** and marked **[D1]**–**[D15]** at the point they change the
design, with §0.3 as the ledger. Two are rejected, with the tree evidence, in **§11**. Six of the thirteen are
blockers, and four of those share one root cause that both the winner and revision 1 missed:

> **[G1]'s own premise is that a JevCode parent never commits — so the parent's working tree is dirty by
> construction.** §2.3's `dirtySync: true` copies that dirty set into every agent worktree, and revision 1's
> `git add -A` would then have committed the *user's* uncommitted work onto *every* agent branch. The launch merge
> into a checkout still holding those files aborts with `Your local changes … would be overwritten by merge` **[D1]**,
> and §3.4 rule 3's disjointness — true of the `own` specs — becomes false of the branch diffs **[D2]**.

The fix is a **scoped** commit set plus a launch pre-flight, and it is cheap, because the child engine already draws
the same line: `createWorkspace` snapshots what was dirty before the run touched anything into `snapshotDirty`
(`src/workspace/files.ts:184`) and `changedFiles()` subtracts it (`:235`). Two more blockers made a wave gate
unreachable as written — [G14]'s stage guard is false at HEAD **[D3]**, and [G2]'s render branch broke a row-count
contract that an existing `it.each` covers **[D4]**/**[D5]** — and one made the money reserve inert **[D6]**.

**Vocabulary, fixed once.** The product surface says **agent**; the mechanism is a **child run**. One agent row = one
locked `git worktree` + one branch `jevcode/<slug>` + one child `jevcode run` process with its own run id, session id,
`run.lock`, heartbeat, spend meter and limits. The **manifest** is the decomposition record. The **dock** is the single
staging worktree/branch `jevcode/dock-<runId8>` where agents land and verification runs. **Land** = agent → dock.
**Launch** (`/land`) = dock → the user's checkout, as one judged step. **Parent**, **child** and **sibling** are used in
CD §6.5's sense (`parentSessionId` / `parentRunId`), never as a conversation hierarchy: children have no conversation
with each other and no shared transcript.

**Renamed from the winner** [G4]: the module is `src/orchestrate/**` (the winner said `src/plan/**`), the config namespace
is `orchestrate.*` (the winner said `plan.*`) and the run-dir subdirectory is `<runDir>/orchestrate/`. The repo already
means something specific by "plan" — `Plan` / `PlanDraft` (`src/core/types.ts:33`), the `replan` stage, `plan.remaining`,
and the plan pane tab `p` (`src/tui/pane/model.ts:246`) — so `plan.split` and `<runDir>/plan/land.jsonl` would send every
reader to the replanner.

---

## 0. Prerequisites, what this is not, and the graft ledger

### 0.1 Prerequisites and non-goals

This design **consumes** CD §6.5 (child runs with their own `sessionId` + `parentSessionId`, worktrees created with
`git worktree add --lock --reason 'jevcode:<runId>:<sessionId>'`, depth cap 1, read-only child navigation), CD §7.2
(`Engine.pause(opts)`, the draft snapshot, `cache/step-<n>.json`), CD §12.0.2 (`PausePoint`, `pause:point`), CD §12.0.4
(the ledger and its write facade) and CD §4.3 (leases). It does not restate them. What it adds is the **planner**, the
**critic**, the **landing queue**, the **budget split** and the **control surface**.

| Needs | From CD | If it is not there yet |
| --- | --- | --- |
| `Engine.pause(opts?: {at, by})`, `PausePoint`, `pause:point`, `AbortError('human_pause')` exit 4 | W0–W2 | **hard** — P9/P10 are pause points; without them a parent could only be aborted |
| `CheckpointStore.writeCache(rel, json)` (does **not** exist at HEAD: `src/checkpoint/store.ts:29` `CHECKPOINT_FILES` has no cache entry) | §6.4 | **hard** — the manifest and the parked review live under `<runDir>/orchestrate/` |
| `BlockingAnswer` gains `'pause'`, `blockWaker` | §7.2 | **hard** — a child must *park* on a pane, never die. At HEAD `awaitBlocker` answers `'stop'` when no blocker is installed (`src/loop/engine.ts:1189`, and the comment above it names `--no-input` / `--json` explicitly) [G7] |
| `run:start` gains `parentSessionId`; picker indents children; `foldIndex` folds child spend | §6.5 | **hard** [G5] — see the ledger rule below |
| the ledger (`~/.jevcode/coordination/**`), heartbeats, `listSessions`, and the write facade `createWorktree` / `removeWorktree` / `sweep` / `gc` (CD:1895, CD:1899, CD §12.0.4) | W1, W3 | **hard for spawning** [G5] [G3] — degraded *discovery* is kept, degraded *control* is dropped |
| leases (`claims: 'advisory'`) | §4.3 | soft — children are physically disjoint directories, so leases are a *report*, not the guard |

**[G5] The ledger is a hard prerequisite for spawning, not a nice-to-have.** The winner shipped a degraded mode in which
the parent wrote control messages into `<childRunDir>/orchestrate/inbox/` when no ledger existed. That is a second
implementation of the one security-critical check in the whole design — `msg.from.sessionId ===
RunMeta.orchestration.parentSessionId`, which gates pause, end and budget-lowering — and the winner's own text conceded
that degraded mode loses leases, cross-device rows and `sessions who`. Decision: keep degraded **discovery** (read
`<parentRunDir>/orchestrate/manifest-*.json` plus each child's `run.lock` + `state.json`; read-only, cheap, and it is what
makes adoption work when the ledger is merely *stale*), and drop degraded **control**. Without a ledger,
`orchestrate.split` resolves to `off` and prints `agents need the coordination ledger (CD W1); orchestrate.split is off`.

**What this is not.** Not a team of peers messaging each other. Children never talk to each other; every fact flows
parent → child at spawn/kick and child → parent at land. This is Cognition's objection taken seriously
(https://cognition.com/blog/dont-build-multi-agents: "actions carry implicit decisions, and conflicting decisions carry
bad results"): the only thing that can carry a conflicting decision between two agents is a file, and two agents can
never own one file. It is also a deliberate refusal of the two hazards the reader survey found in shipping systems —
Claude Code agent teams' "teammates NOT worktree-isolated … two teammates editing the same file leads to overwrites"
(https://code.claude.com/docs/en/agent-teams), and the same page's "lead auto-approves teammate plan approvals WITHOUT
the user reviewing".

### 0.2 Graft ledger — the twenty-two corrections folded into the spine

| # | Graft | Where | Class |
| --- | --- | --- | --- |
| **G1** | **The harness must commit.** JevCode makes no git commits today, so every `baseSha..jevcode/<slug>` range would be empty and the entire landing layer would be inert | §2.6, §5.1, rows 36–37 | blocker |
| **G2** | **The manifest confirm needs a real card.** A synthetic `read`-class proposal renders as nothing: `confirmPreviewLines` (`src/tui/plain.ts:535`) returns `[]` when `describeAction(...).preview === ''`, which `read` is (`plain.ts:160`) | §3.7, §4.6 | blocker |
| **G3** | **Verify and merge a pinned sha, never a ref**, and deny `refs/**` to a child's sandbox | §5.2, §5.4, row 51 | blocker |
| **G4** | **Rename** `src/plan/**` → `src/orchestrate/**`, `plan.*` → `orchestrate.*`, `<runDir>/plan/` → `<runDir>/orchestrate/` | everywhere | blocker |
| G5 | Ledger is a hard prerequisite for spawning; degraded control deleted, degraded discovery kept | §0.1, §2.7 | correctness |
| G6 | Persist and re-establish the reserve: `heldUsd` in `SpendSnapshot`, restored on adoption | §6.2, row 31 | correctness |
| G7 | Name and test the file that installs the child's parking blocker (`src/cli/session.ts:2030`, `:2354`) | §2.5, row 27 | correctness |
| G8 | Close ownership belt 2 for `run` actions, or demote the land-time rule — `computeTargets` (`src/loop/stages/risk.ts:537`) yields paths only for `edit \| write \| patch` | §2.4, §5.3, row 18 | correctness |
| G9 | Make the lifted `dirtySnapshot` binary-safe (`src/synth/sieve/lanes.ts:158` reads `utf8`) | §2.3, row 17 | correctness |
| G10 | Delete the claim that `git worktree lock` keeps `git status` clean; give the sweep a real clean probe | §2.3, §5.6 | correctness |
| G11 | Code cross-check for the one judgement Jev owns: path-shaped tokens in a child's task text | §3.4, §3.5 | correctness |
| G12 | State the exit-code contract for a delegating headless run | §4.9, row 11 | correctness |
| G13 | `/why` + timeline + status plumbing for the new stage, assigned to D0/D1 | §8.2, §8.3 | completeness |
| G14 | A generic contract guard: every `StageName` appears in all five TUI stage tables | §8.2, §9 M11 | completeness |
| G15 | Reconcile `orchestrate.maxAgents` with CD's `coordination.maxChildren` / `childDepth` | §6.4, §3.4 | consistency |
| G16 | Create and remove worktrees through CD §12.0.4's facade; fix the metadata path to `devices/<hostKey>/` | §2.3, §8.2 | consistency |
| G17 | Honest P9 wording: engine-initiated, `by: 'self'`, and the elided `PausePoint` fields filled in | §4.2 | consistency |
| G18 | State the CD invariant narrowing (a git write outside a judged step) and the `/merge` redefinition | §5.2, §5.7 | consistency |
| G19 | Fix the citations (`shellQuote` is `src/workspace/git.ts:50`; `StageName` is `types.ts:241`) | everywhere | consistency |
| G20 | Pane-tab plumbing: `PANE_TABS`, `cycleTab`, the `paneNext`/`panePrev` titles, the `/panel` validator | §4.6, §8.3 | completeness |
| G21 | Ship `orchestrate.split` as `off` with a one-time hint until M10 has run | §3.1, §6.5, §10 Q1 | risk |
| G22 | Split `paused` (human-requested) from `parked` (self-parked): resume semantics differ | §2.8 | completeness |

### 0.3 Review-pass ledger — the thirteen defects of revision 1, and where each is fixed

| # | Defect in revision 1 | Fixed in | Class |
| --- | --- | --- | --- |
| **D1** | **The launch merge runs into a dirty checkout and `git merge` refuses.** [G1]'s premise makes the parent uncommitted by construction; the gate admits 200 dirty entries; nothing covered "the parent's working tree is dirty", which is the normal case | §2.3, §2.6, §3.7, §5.7, rows 53–54, M1 arm b | blocker |
| **D2** | **The synced dirty set voided the disjointness argument at the diff level** and made [G8]'s land-time prompt fire on every land with up to 200 unrelated paths | §2.3, §2.6, §3.4 rule 3, §5.3, rows 17, 19, 55 | blocker |
| **D3** | **[G14]'s guard is false at HEAD and unwritable as specified** — `TIMELINE_STAGES` holds 6 of 8 `StageName`s by design and `defaultTab` is a two-condition expression, not a table; D0's gate was therefore unreachable | §8.2 item 6, §8.3 items 31/33, §9 M11, row 52 | blocker |
| **D4** | **[G2]'s render branch broke the review header's row-count contract** (`confirmHeaderLines` is *exactly* 8 rows; `review.test.tsx:24`'s `it.each` runs n = 8…2) — deleting the gauge band left a 5-row hole | §3.7, §4.1, §8.3 item 30 | blocker |
| **D5** | **[G2] left three surfaces reading dimensions that do not exist**: `review:why`, `reviewScreenReaderLines`, and the still-required `ConfirmRequest.proposal` / `.risk` | §3.7, §4.1, §4.6, §8.3 item 30 | blocker |
| **D6** | **[G6]'s hold reserved nothing** — the session meter is `createSpendMeter(Number.POSITIVE_INFINITY)` (`src/cli/session.ts:1141`), so `exceeded()` on it is dead code and `sessionRemainingUsd` never saw `heldUsd` | §3.1, §6.1, §6.2, §6.7, §8.2 item 3, §10 Q5 | blocker |
| **D7** | **Q2's cycle rule does not fit `cycleTab`'s signature**, and the `paneNext` titles it proposed editing are static prose | §4.6, §8.3 item 29, §10 Q2 | medium |
| **D8** | **The kick minted an unnamespaced repo-global branch** `refs/heads/dock` in the shared common dir | §5.4, row 38 | medium |
| **D9** | **§6.4 was not "every limit, in one place"** — 14 rows against 30+ referenced keys, and `maxReserveUsd` had no value anywhere while appearing inside an arithmetic formula | §6.4, §8.3 item 26 | medium |
| **D10** | **The supervisor's sandbox was never constructed**, and §2.6 ("unsandboxed") contradicted §5.2(b) ("the same sandbox profile as the dock worktree") | §2.6, §5.2, §7.3 rule 4, §8.3 item 34, row 56 | medium |
| **D11** | **Slug-vs-branch collision suffix contradicted itself** (§2.2 suffixed the branch, §3.4 rule 1 and row 15 the slug) | §2.2, §3.4 rule 1, row 15 | low |
| **D12** | **Two named tests used flags that exist nowhere** — `--berth` and `--replay` | §2.1, §2.5, §3.7, §8.3 item 27, rows 27–28 | low |
| **D13** | **`EngineSeed` has no sibling-roster field** and `StepTiming` no `decomposeMs`, though §2.6 and §8.3 item 15 both rely on them | §2.6, §4.1, §8.2 item 1 | low |
| **D14** | **Row 39's "the dock is exactly as it was" overstated `reset --hard`** — it leaves the untracked build output the verify commands just created | §5.2, row 39, §6.4 | low |
| **D15** | **Three citation slips** (two valid, one not — see §11) | §3.1, §4.1 | low |

Two further corrections fell out of verifying the above and are folded in with them: **`orchestrate.commitNoVerify` is
deleted as dead** (`GIT_BASE_FLAGS` already sets `-c core.hooksPath=/dev/null` at `src/workspace/git.ts:37` for every
`runGit` call, so no hook path is configured and `--no-verify` can skip nothing), and **`--replay` is deleted in favour
of the `--resume` that already exists** (`src/cli/args.ts:241`).

---

## 1. Goals, restated as testable properties

Every row is a property a test asserts, not a sentiment. The right column names the §9 measurement.

| # | Requirement | Property | §9 |
| --- | --- | --- | --- |
| **O1** | "spawns the best coding agents with subagents, in parallel, in the highest detail" | (a) a split is proposed only when **code** has proven it safe — disjoint `own` sets, every remaining plan item covered exactly once, a verification command per code agent, resources and budget pre-flighted — and a fixture violating any one of these yields `no_split` **with zero Jev requests**; (b) N agents run as N OS processes in N worktrees on N branches, concurrently, each with its own cap trio (`$`, steps, wall); (c) the manifest records every **rejected** option with its code reason and Jev's probability, so the decomposition is auditable after the fact | M1, M2, M6 |
| **O2** | "complete control over pausing, starting and resuming everything" | (a) every verb (`pause`, `pause now`, `resume`, `end`, `steer`, `land`, `kick`, `budget +`, `drop`, `attach`) exists at three scopes — one agent, the tree, the device — with a TUI key, a slash command using CD §5.3's target grammar, and a `jevcode agents …` shell twin; (b) `pause tree` reaches every child's `run:end` within one step of each child and reports per-row acks in < 500 ms; (c) a child killed with SIGKILL, a supervisor killed with SIGKILL and a clean `/exit` all leave a state the next session **adopts** from disk with no double-spawn; (d) `end` never deletes a branch holding commits the parent does not have | M3, M4, M7 |
| **O3** | "people can control all of it in the TUI in the highest detail without any issues" | (a) all sixteen `AgentState` members have a distinct row string, a colour role and a key set; no agent row is ever hidden while the agent exists (hidden ≠ stopped); (b) a `review`-class proposal inside a child is **never** auto-approved and **never** auto-denied — it parks the child and opens the real review card in the parent's TUI with an `[agent <slug>]` badge; (c) the agents tab with 8 agents renders inside the existing render-lag gate and adds 0 bytes of I/O before `renderer.firstFrame()`; (d) `--plain`, `--json`, `--screen-reader` and the Ink tab are line-identical, because one pure function produces every row | M8, M9 |
| **O4** | "think of all edge and corner cases" | the §7.2 table has 58 rows, each with behaviour · detection · recovery · a named test; every row is either a decided behaviour or an explicit refusal with a fix line | all |
| **O5** | Jev's role stays honest | Jev is asked **exactly two requests per delegation**: one Choice + paired Nouls over code-built splits, one Score per verified agent for landing order. Neither can make an agent land, unland, pass or fail. Every Jev path has a deterministic code fallback, and every request is O(1) in the transcript (`STATE_LIMITS`, `src/loop/state.ts:30`, untouched) | M2, M6 |
| **O6** | work that lands is work that was written | every landed agent's diff is non-empty **because the harness committed it** [G1]; the commit carries **only what that agent changed**, never the dirty set synced in from the parent [D2]; the merged object is a **pinned sha** the verifier saw [G3]; the launch refuses to merge over the user's own uncommitted work [D1]; and no diff that deletes tests or drops the collected test count can land without a twice-typed human override | M1, M6, M12 |
| **O7** | it degrades to today | `orchestrate.split: 'off'` (the shipping default [G21]) is HEAD behaviour: the gate never opens, no new stage runs, `harnessMs` p95 is unchanged, no `orchestrate/` directory is created, zero Jev requests | M2 |

---

## 2. The agent model

### 2.1 Parent, child, sibling

| Relation | Definition | Enforced by |
| --- | --- | --- |
| **parent** | the run that reached P9 with a written manifest. Its `sessionId` is the children's `parentSessionId`; its `runId` their `parentRunId`. A parent is a **stopped process** while its children run (§2.9) | `RunMeta.orchestration`, `CheckpointState.orchestration` |
| **child** | an ordinary `jevcode run` with `EngineOptions.orchestration.depth === 1`, its own run id, session id, `run.lock`, heartbeat, spend meter, checkpoint store and worktree | `createEngine` refuses `depth > 1`; the gate is shut at depth 1 |
| **sibling** | two children of one manifest. Siblings share **nothing** writable: no directory, no branch, no transcript, no inbox, no lease. A child knows its siblings only as a roster of `{ slug, task ≤ 200 chars, own }` in its seed — never their output | disjointness proof (§3.4 rule 3); the seatbelt profile is built for the child's own worktree root (`src/sandbox/seatbelt.ts` writes the profile from the workspace root) |
| **grandchild** | does not exist. Depth is a constant, not a setting | `createEngine` rejects any depth-1 run that also carries `--split` / `--max-agents` / `--yes-split` as a `ConfigError` [D12: there is no `--berth` flag in this repo or in this design — the spawn flags are §2.6's]; row 20 |

The one-parent rule: **one live delegation per session**. No second manifest while children live, `orchestrate.maxSplits`
(2) per run, `orchestrate.splitEvery` (8) committed steps of cooldown. These are deterministic caps, in line with
Anthropic's Opus-5 guidance to pair delegation instructions with hard numeric limits
(https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5#controlling-subagent-spawning).

### 2.2 Identity

A child is identified four ways, and each has exactly one writer.

| Field | Value | Writer | Used for |
| --- | --- | --- | --- |
| `slug` | `^[a-z0-9][a-z0-9-]{0,39}$`, unique in the manifest, never `dock` or `dock-*`. **The slug is what takes `-<n>` on a collision, and it takes it before `manifestId` is computed** [D11] | the normaliser (§3.4 rule 1) | every human-facing surface: rows, keys, `/agent <slug>`, the branch name |
| `runId` / `sessionId` | a fresh run id, which is also its session id (as for every first run) | the child's own process | `run.lock`, heartbeat, leases, `outbox/<sessionId>/`, the fold |
| `branch` | **exactly** `jevcode/<slug>`, always, with no separate suffix [D11]; an existing branch is never force-updated (the collision renamed the slug instead) | the harness, at worktree creation | the unit of result: the branch is the truth, the worktree is a cache |
| `manifestId` | `sha256(canonical({ task, remaining, splitKind, agents, baseSha }))` | the normaliser | the replay key: a resumed delegation whose `manifestId` **and** `baseSha` still match is *adopted*, never re-spawned (row 12) |

**[D11] The collision suffix lands on the slug, not the branch.** Revision 1 said both, in two places, and they are
not interchangeable. The slug is a `manifestId` input, so renaming it changes row 12's adoption compare key and must
happen *before* `manifestId` is computed; renaming only the branch would break `branch === 'jevcode/' + slug`, which
§5.2's `rev-parse --verify refs/heads/jevcode/<slug>^{commit}` assumes. The fixed order inside the normaliser is:
rule 1 renames the slug → rules 2–9 run → `manifestId` is computed → `branch` is derived as `jevcode/<slug>`. §3.4
rule 1 and row 15 now say exactly this.

Own session ids are load-bearing, not cosmetic: CD §6.5 records that a session is `live` while any of its runs is live
and resolves to its newest run (`src/session/index.ts`), so a child sharing the parent's session id would make the paused
parent read `● live` and make `Enter` resume the child in its worktree.

### 2.3 Worktrees [G16] [G9] [G10]

Created **through CD §12.0.4's facade**, not by a second implementation [G16]:

```
createWorktree(ledger, { repoKey, slug, base: baseSha, runId, sessionId, dirtySync: true })
  -> { dir, branch, syncedIgnored, syncedDirty }      // [D2] syncedDirty is new in revision 2
```

which performs CD §6.5's recipe — `git worktree add --lock --reason 'jevcode:<parentRunId>:<childSessionId>' -b
jevcode/<slug> <dir> <baseSha>` — and writes the metadata to `coordination/devices/<hostKey>/worktrees/<repoKey>/<slug>.json`.
The winner abbreviated that path to `coordination/worktrees/...`, dropping the `devices/<hostKey>` component CD relies on
for single-writer-by-construction when `~/.jevcode` sits in a synced folder (CD §11 row 3); the facade's path is
authoritative. Two modules minting `jevcode:`-reason locked worktrees would mean two dirty-set syncs, two `syncedIgnored`
writers and two sweeps with different guard sets over one `git worktree list --porcelain`.

**Base is the parent's HEAD**, not the remote default branch. This is the deliberate, documented difference from Claude
Code, whose subagent worktrees branch "fresh" from the remote default (https://code.claude.com/docs/en/worktrees).
JevCode never resets a reopened worktree and never fetches. `docs/COMMANDS.md` says so in one line.

**[G10] The lock is not a cleanliness guarantee.** The winner claimed that because the lock is the marker, "nothing
untracked ever dirties the tree and `git status --porcelain` stays clean". That is wrong about git: `git worktree lock`
only prevents `prune` and `move`. A working agent's tree is dirty by construction, and after [G1] it is dirty between
commits. The sweep therefore runs its **own** porcelain probe (`statusPorcelain`, `src/workspace/git.ts:163`) and
subtracts the recorded `syncedIgnored` list; "clean" is measured, never assumed.

**[G9] The dirty-set sync must be binary-safe.** The parent's uncommitted work is replayed into each new worktree using
the `src/synth/sieve/lanes.ts` recipe (`DIRTY_ENTRIES_MAX = 200` at `:45`, `dirtySnapshot` at `:158`), lifted into
`src/orchestrate/worktree.ts` and shared. The lane version reads with `readFile(abs, 'utf8')`, which mangles any dirty
binary file; on a synth lane that dies with the lane, but in an agent it can be committed and landed into the user's
checkout. The lifted version copies **bytes** (`Buffer`) and preserves the file mode.

Gitignored files the repo needs (`.env` and friends, `orchestrate.agentInclude`, default `['.env', '.env.*']`) are
copied once per worktree and recorded in the facade's `syncedIgnored`, so they stay ignored by the worktree's own
`.gitignore` and can never be committed.

**[D2] The synced dirty set is recorded, not merely replayed.** `createWorktree` returns

```ts
syncedDirty: readonly { path: string; sha256: string; mode: number }[]   // one entry per file the sync wrote
```

and the supervisor copies it into the child's `RunMeta.agent.syncedDirty` and into `Manifest.syncedDirty`. Without
it, *"what did this agent change?"* is unanswerable inside an agent worktree: every synced file is dirty against
`baseSha` from the first second. Revision 1's `git add -A` would therefore have put the parent's uncommitted work on
**every** agent branch — so `git diff --name-only baseSha..<pinned>` would list up to 200 paths no agent owns, [G8]'s
`[a] include · [d] drop · [x] refuse` question would fire on every land, §3.4 rule 3's *"this is the whole safety
argument"* would hold of the specs and fail of the diffs (A and B both carrying commits over one file), and the
second merge would conflict on any such file either agent later touched. §2.6 computes the commit set against this
list, §5.3 subtracts it, and `commit.test.ts` asserts that no `syncedDirty` path appears in `baseSha..<branch>` for an
agent that never touched it.

The cost is near zero, because the child engine already draws the same line: `createWorkspace` snapshots the
pre-existing dirty set into `snapshotDirty` (`src/workspace/files.ts:184`) and `changedFiles()` subtracts it
(`:235`), so inside a child worktree `snapshotDirty` **is** `syncedDirty`. The one hole `snapshotDirty` leaves — a
`run` command that rewrites a file that was *already* in the synced set, which `externalChanges()` filters out — is
closed by the `sha256` in each entry (§2.6's `carried` set).

The **dock** is one more worktree, `dock-<runId8>` on `jevcode/dock-<runId8>`, created lazily at the first land through
the same facade with the same reason prefix, and with **`dirtySync: false`** — the dock is a clean `baseSha` checkout,
carrying only the `orchestrate.agentInclude` files, so nothing a verify command sees there came from the parent's
uncommitted work. Its slug `dock-<runId8>` is reserved by §2.2 (`dock` and `dock-*` are never agent slugs).

Non-git workspaces: `orchestrate.agentMode: 'copy'` uses the `lanes.ts` `cp -R` path with the same size gate; above it
the gate is shut and the reason is printed. A copy-mode agent cannot land (there is no branch) and is downgraded to
`role: 'research'`.

### 2.4 Ownership — three belts, and the hole in belt 2 [G8]

| Belt | Mechanism | Failure mode it closes |
| --- | --- | --- |
| **physical** | the child's workspace root *is* its worktree, and the seatbelt profile is built for that root | a child cannot write into the parent's checkout or a sibling's, at all — the Claude-teams overwrite failure is structurally impossible |
| **logical** | `EngineOptions.orchestration.own`; the risk stage refuses a target outside `own` with `outcome = { status: 'blocked', reason: "outside this agent's ownership: src/y.ts (owns src/x/**)" }` (`ActionOutcome` `'blocked'`, `src/core/types.ts:196`), counted in `counters.blocked` and visible to Jev and the generator | an agent wandering outside its slice *inside its own worktree*, which would conflict at land time |
| **reported** | one CD §4.3 lease per child, `type: 'agent'`, `paths = own`, renewed on the 15 s heartbeat | a *second human session* on the repo sees `3 agents own src/tui/**, src/loop/**, test/**` before starting heavy work |

**[G8] Belt 2 does not cover `run` actions.** `computeTargets` (`src/loop/stages/risk.ts:537`) yields paths only for
`edit | write | patch` (the function reads `a.kind === 'edit' || a.kind === 'write' ? [a.path] : a.kind === 'patch' ?
patchTouchedPaths(a.diff)... : []`). A formatter, a codegen step, or `npm test` regenerating `package-lock.json` writes
outside `own` with nothing to catch it. Two fixes, both adopted:

1. **Post-hoc, in the harness**: after every `run` action in a child, diff the post-images against `own`; paths outside
   it are recorded on the step as `escaped: string[]` and surfaced on the row (`wrote 1 file outside its slice:
   package-lock.json`). This does not block — blocking after the command ran would be theatre.
2. **At land time, demoted from hard-fail to a prompt**: the winner listed "no write outside `own`" among the five
   non-overridable hard rules and called reaching it "a bug report". With `run` uncovered it is the *routine* case, so
   it becomes a land-time question — `[a] include these 2 files · [d] drop them · [x] refuse` — and only the explicit
   `[d]`/`[x]` path consumes a kick. §5.3 records the demotion.

Three consecutive belt-2 refusals park the child with reason `scope-fight`, and the row says `the split was wrong for
this agent — [k] kick with a wider slice · [x] drop`. That is the honest signal that the decomposition, not the worker,
failed.

### 2.5 Modes, models, and the five engine differences [G7]

A child's `mode` defaults to the parent's; `role: 'research'` forces `jev-only` when a synthesizer is available.
`EngineMode` is unchanged (`'jev-on' | 'jev-off' | 'jev-only' | 'llm-jev'`, `src/core/types.ts:480`) and `MODES` is
untouched. Model selection is the child's own config chain — the parent forwards no keys (§2.6).

Exactly five differences from a normal run, all through additive `EngineOptions`:

```ts
EngineOptions.orchestration?: {
  depth: 0 | 1;                      // 1 in a child; createEngine refuses depth > 1
  role?: AgentRole;                  // 'research' restricts Action kinds to read | run | done in code
  own?: readonly string[];
  parentRunId?: string; parentSessionId?: string; slug?: string; manifestId?: string;
  reviewAnswerFile?: string;
  commit?: { name: string; email: string };   // [G1] §2.6
  syncedDirty?: readonly { path: string; sha256: string; mode: number }[];   // [D2] §2.6
};
```

(a) **`own` refusal** (§2.4). (b) **`role: 'research'`** additionally drops `edit | write | patch` from the tool schema
and from `computeTargets`, so the model is never offered them — Cognition's "subagents only tasked with answering a
question, not writing any code". (c) **A parking confirmer**: the child's `Confirmer` writes the `ConfirmRequest`
(`src/core/types.ts:691`) to `<childRunDir>/orchestrate/review-<step>.json`, emits `agent:review`, and rejects with
`AbortError('human_pause')` → rule-1 discard → **P10**. On the next start it reads `reviewAnswerFile`
(`{ id, approved, note?, by, at }`, id-matched, single-use, renamed to `.used` on consumption) and answers from it once;
anything else parks again. (d) **A parking blocker** [G7]. (e) **No decompose**: the gate is shut at depth 1.

**[G7] The parking blocker has to be installed somewhere specific, and today it would not be.** `src/cli/session.ts:2030`
and `:2354` pass `blocker` only when `o.interactive || prompter?.blocking`, and with no blocker `awaitBlocker` answers
`'stop'` (`src/loop/engine.ts:1189`; its doc comment names `--no-input` and `--json` as exactly the cases that get
`'stop'`). A child spawned `--plain --json --no-input` would therefore **stop** on a `spend-limit` pane instead of
parking, voiding O2(c) and corner rows 27–28. Fix: `src/cli/session.ts` installs a **parking blocker** — a non-interactive
`Blocker` that answers `'pause'` for every `BlockingKind` (`src/core/types.ts:1161`) — whenever
`o.orchestration?.depth === 1`, independent of `interactive`. Named test **[D12]**: `--agent b --no-input` plus a
`spend-limit` pane → `human_pause`, exit 4, resumable. (Revision 1 wrote this test as `--berth --no-input`; there is
no `--berth` flag in this repo, in CD, or in §2.6's own spawn line. Row 27 already had it right.)

### 2.6 What crosses the process boundary — and the commit [G1]

The supervisor spawns `process.execPath` + this package's entry, **never through the sandbox** (the sandbox exists for
agent commands; spawning JevCode is the host's own act):

```
jevcode run --parent <parentRunId> --parent-session <parentSessionId> --agent <slug> \
  --manifest <parentRunDir>/orchestrate/manifest-<step>.json \
  --workspace <worktreeDir> --task-file <parentRunDir>/orchestrate/agent-<slug>.task \
  --own <glob> [--own <glob> …] --base <baseSha> \
  --spend-cap <capUsd> --max-steps <n> --max-wall <ms> --mode <m> \
  --plain --json --no-input --runs-dir <same>
```

| Crosses | Does not cross |
| --- | --- |
| the task **as a file** under the parent's run dir (argv is world-readable via `ps`) | any key, token or credential — the child re-resolves the same config chain, so its `secretPaths` and `redact()` are identical **by construction** |
| the manifest path (read-only, checksummed, validated) | the parent's transcript, window or context cache beyond the seed |
| `own` globs, base sha, caps | any ability to widen: `--sandbox`, `--no-network`, `allowUnpriced`, `trustWorkspace` are **not** forwarded; `createEngine` refuses a child whose resolved sandbox level is weaker than the parent's recorded one |
| an `EngineSeed` (`src/core/types.ts:1131`) written to `<parentRunDir>/orchestrate/agent-<slug>.seed.json`: the parent's `plan`, `window`, `lastTestRun`, `createdThisRun`, `pinnedFiles`, and the sibling roster — which needs the **additive `EngineSeed.siblings?`** of §4.1, because HEAD's `EngineSeed` is exactly `parentRunId, plan, window, createdThisRun, lastTestRun, undoLog?, pinnedFiles?, carriedDirectives?` and revision 1's §4.1 list did not widen it [D13] | sibling output (it does not exist yet) |

The seed answers Cognition's second point ("share context, and share full agent traces, not just individual messages"):
a child starts with the parent's plan and window, not a bare prompt. It rides the existing `EngineOptions.seed` path.

**[G1] The harness commits. This is the graft without which nothing else in §5 executes.**

JevCode makes **zero git mutations** in the product path today. The only git writes anywhere in `src/` outside
`src/bench/**` and `src/perf/**` are `git restore --source=HEAD --worktree` (`src/workspace/git.ts:223`, `:236`),
`git add -A -N` for intent-to-add before a diff (`:252`) and `git apply` (`:217`); undo is pre/post images in the
checkpoint store, not git. So `git merge --no-ff jevcode/<slug>`, `git diff --name-only baseSha..branch`,
`rev-list --count base..branch` and `git revert` would every one of them operate on an **empty range**: every agent
would hit corner row 37 ("zero commits → lands trivially as a no-op"), the dock would report verified-and-green, the
transcript would read `3 agents: 3 landed`, and all three agents' actual work would sit uncommitted in three worktrees
that the sweep then sees as dirty.

**[D2] The commit set is computed, not `-A`.** Revision 1 wrote `git add -A --`, which in an agent worktree stages
the synced dirty set (§2.3) as well — the parent's uncommitted work, on every branch, from the first commit. The
harness instead computes the add set in code, from three sets it already has:

```
touched  = ⋃ over this agent's steps of ActionOutcome.changedFiles           # file actions AND post-`run` diffs
dirtyNow = statusPorcelain(<worktreeDir>).entries.paths                      # --untracked-files=all; ignored files never listed,
                                                                             # so syncedIgnored (.env) can never appear
carried  = { p ∈ RunMeta.agent.syncedDirty : sha256(<worktreeDir>/p) === p.sha256 }   # still byte-identical to what the sync wrote
addSet   = (dirtyNow \ carried) ∪ (touched ∩ dirtyNow)
```

`carried` is the exact answer to *"did this agent leave the parent's file alone?"*. The `sha256` recheck is what
makes it exact in the one case `Workspace.changedFiles()` cannot see: a `run` command that rewrites a file already in
`snapshotDirty` is filtered out of `externalChanges()` (`src/workspace/files.ts:235`) and would otherwise be dropped
from the commit. The second union term is belt-and-braces for the reverse case (a file action on a carried path,
which `touched` records directly). Deletions are staged too, because `git add -A` with a pathspec stages removals.

The fix, owned by the **harness** (§8.2 item 16, wave D2):

```
# after every committed step of a child whose outcome.status === 'executed' and changedFiles.length > 0,
# and unconditionally once at the child's run:end if addSet is non-empty
git -C <worktreeDir> --literal-pathspecs add -A -- <addSet, sorted, chunked at 256 paths per invocation>
git -C <worktreeDir> -c user.name=<commit.name> -c user.email=<commit.email> \
    -c commit.gpgsign=false commit -q -m "jevcode <slug> step <n>: <summary60>"
```

`--literal-pathspecs` is required for the same reason `restoreFromHead` uses it (`src/workspace/git.ts:226-234`): a
recorded path such as `pages/[slug].tsx` is a glob pathspec otherwise, and would stage the wrong file. The chunking
keeps argv inside `ARG_MAX` for a 200-entry change set. `addSet` empty → no commit, no error.

Both commands run through `runGit` (`src/workspace/git.ts:70`), which supplies the scrubbed env,
`GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_GLOBAL=/dev/null` (`:27`, `:35`) **and** `GIT_BASE_FLAGS`' `-c
core.hooksPath=/dev/null` (`:37`), so the user's hooks, signing config and identity are neutralised and no hook of
any kind — `pre-commit`, `commit-msg`, `prepare-commit-msg` — has a path to run from. Identity defaults to
`jevcode <jevcode@local>`, overridable by `orchestrate.commitIdentity`. The resulting sha is recorded in the child's
`StepRecord.commit?: string` (additive) and in its `run:end`.

**`orchestrate.commitNoVerify` is deleted.** Revision 1 added it "for repos that ship a slow or network-touching
hook", reasoning that a `core.hooksPath` planted in the *worktree* config could still be live. It cannot:
`core.hooksPath=/dev/null` is passed on the command line by `GIT_BASE_FLAGS`, which outranks every config file, so
`--no-verify` would skip nothing that is not already unreachable. One fewer setting, one fewer thing to be wrong
about.

**[D10] The commit runs in a sandbox, and the design says which one.** Revision 1 said the commit runs "through
`runGit` … so the user's hooks … are neutralised" *and* "the commit is still run unsandboxed by the harness". Those
cannot both be arranged by accident: `runGit(sandbox, ws, args, opts)` ends in `sandbox.run(shellJoin(full), runOpts)`
and there is exactly one implementation, `createSandbox` (`src/sandbox/run.ts:155`) — "unsandboxed" is a value
(`profile: 'off'`), not the absence of an argument. It also contradicted §5.2(b), which *requires* the verify commands
to run under a real profile. The supervisor therefore constructs one `Sandbox` per worktree it writes to, and §5.2
states the rule once for both uses.

Consequences recorded elsewhere: corner rows **36 and 37 invert** — uncommitted-at-end is now the *crash* case, not
the default, and "uncommitted" means *outside* `carried ∪ syncedIgnored`; `/undo` inside a child still works on images
and is unaffected (the commit happens after the step commits, and a revert of the last commit is `git -C <dir> reset
--soft HEAD~1` performed only by `[x] drop --uncommit`); and the launch merge gains the §5.7 pre-flight, because a
scoped commit set removes the *unrelated* dirty paths from the dock but not the ones an agent legitimately edited on
top of the parent's uncommitted work.

### 2.7 Budgets and limits per agent (summary; §6 is the full treatment)

Each child gets a hard `--spend-cap` on its own process, plus `--max-steps` and `--max-wall`. The existing `checkBudgets`
path is the enforcement, so a child at its cap stops with `spend_cap`, exit 4, **resumable**. The parent's session
budget is debited by the whole reserve at spawn via `SpendMeter.hold` / `release` [G6] **and** by threading `heldUsd`
through `sessionRemainingUsd`, which is what actually gates a new run [D6]; §6.2 is the full treatment.

### 2.8 Lifecycle states [G22]

Sixteen states. Each has a glyph, a colour role, a row word and a key set (§4.6). `paused` and `parked` are **separate**
[G22] because their resume semantics differ: a `paused` agent resumes on a human verb alone; a `parked` agent's blocking
condition is re-raised on resume and will park it again unless the condition was cleared (a cap raised, a key fixed, a
review answered).

```
                  ┌──────────────────────────────── drop (x) ────────────────────────────────┐
                  │                                                                          v
planned ──spawn──> starting ──ready──> running ──┬── cap/pane ──> parked ──[+]/[r]──> running
   │                  │                          ├── human ─────> paused ──[r]────────> running
   └── preflight ─────┴──> failed-start          ├── review ────> review ──answer─────> running
        refuses                                  ├── watchdog ──> stalled ──[k]───────> kicked ──> running
                                                 ├── SIGKILL ───> crashed ──[r]───────> running
                                                 └── run:end ───> done ──[l]/queue──> landing ──┬──> landed
                                                                                                 ├──> conflicted ──[k]──> kicked
                                                                                                 └──> failed-verify ──[k]──> kicked
                                                                    (any state) ──[x]×2──> dropped
```

| State | Meaning | Terminal? |
| --- | --- | --- |
| `planned` | in the manifest, not yet spawned (queue, or blocked on `dependsOn`) | no |
| `starting` | process spawned, no `run:ready` yet | no |
| `running` | working | no |
| `paused` | a human asked; exit 4, resumable, nothing wrong [G22] | no |
| `parked` | the child stopped itself: a cap, a blocking pane, or three ownership refusals. The reason is on the row | no |
| `review` | a `review`-class verdict is waiting for a human (P10) | no |
| `stalled` | the watchdog fired (§7.1); still running | no |
| `done` | `run:end` with work committed, not yet landed | no |
| `landing` | the queue holds `land.lock` and is merging/verifying this one | no |
| `landed` | merged into the dock and verified | **yes** |
| `conflicted` | the merge conflicted; the dock was restored | no (kickable) |
| `failed-verify` | merged cleanly, a verify command failed or a hard rule refused; the dock was reset | no (kickable) |
| `kicked` | resumed with the failure facts; counts against `maxKicks` | no |
| `dropped` | the human dropped it; the branch is kept | **yes** |
| `crashed` | the process died without `run:end` | no (resumable) |
| `failed-start` | spawn or worktree creation failed | **yes** |

### 2.9 Why the parent stops

Waiting on children with a live process burns context and money for nothing — Claude Code's costs page states plainly
that "each active teammate keeps consuming tokens" (https://code.claude.com/docs/en/costs), and measures agent teams at
~7× the tokens of a single session when teammates plan. A JevCode parent instead reaches pause point **P9** and its
process exits; the long-lived `SessionController` (`src/cli/session.ts:1082`) is the supervisor. A parent costs zero
while its children work, and a supervisor SIGKILL loses nothing that is not already on disk.

---

## 3. Spawning — how a run becomes a parent

`StageName` gains `'decompose'` (additive; the union is at `src/core/types.ts:241`). It runs in `runStep()` **before**
`stage('replan')` / `stage('intent')`, only when the gate is open, and it **never touches the workspace**: it is a
proposal, so a rule-1 discard of a `decompose` step costs one Jev request and nothing else.

### 3.1 The gate — pure code, zero cost when shut (`src/orchestrate/split/gate.ts`)

`splitGate(input): { open: false; why: GateReason } | { open: true; demand: DemandReason }`. Open iff **all** of:

| Condition | Source |
| --- | --- |
| `orchestrate.split !== 'off'` and `orchestration.depth === 0` | `EngineOptions.orchestration` |
| a ledger handle exists [G5] | `EngineOptions.coordination.ledger` |
| the workspace is a git repo with a born HEAD and `git worktree` is available (probed once, cached) | `GitState`, `src/workspace/gitstate.ts` |
| `plan.remaining.length >= 3` and no `unverified` item blocks every remaining one | `this.plan` |
| a verification set is resolvable (§5.1) **or** the split is research-only | §5.1 |
| the dirty set is ≤ `DIRTY_ENTRIES_MAX` (200) entries. A dirty parent is the **normal** case and is deliberately not a reason to shut the gate [D1]: §2.6 keeps it off the agent branches, §3.7's card names any overlap up front, and §5.7 refuses to merge over it | `statusPorcelain`, `src/workspace/git.ts:163` |
| no children of this session are live, `splits < orchestrate.maxSplits`, and `step - lastSplitStep >= orchestrate.splitEvery` | `CheckpointState.orchestration`, the fold |
| resources: `min(maxAgents, availableParallelism()-1, floor(freeMem/agentMemBytes), floor(freeDisk/repoBytes)) >= 2` | `os`, `statfs`, measured repo size (§3.6) |
| money **net of holds**: `sessionRemainingUsd(sessionCapOf(), sessionTotal(), heldUsd()) × reserveFraction ≥ 2 × minAgentUsd` [D6] | `sessionRemainingUsd` (`src/tui/budget/lines.ts:184`; `src/cli/session.ts:157` is only its import line [D15]) |
| this step is not a replan step, and `harnessProblems` holds no `orchestration` problem newer than `splitEvery` steps | the loop detector |

…**and** one *demand* reason holds: the remaining items' known file sets span ≥ 2 disjoint top-level source directories;
**or** `lastTestRun` shows ≥ 2 failing test files; **or** the human asked (`/split`, a one-shot flag consumed like a
pending limit). A shut gate emits nothing — not even a transcript line — except under `--json=verbose`, where one
`{ type: 'decompose:skipped', why }` line makes the gate testable (this is what M2 asserts).

**[G21] The shipping default is `off`.** `orchestrate.split: 'off' | 'ask' | 'auto'` ships as **`off`** with a one-time
hint (`this task looks separable — /split`) until M10 has been run. The winner proposed `ask`, which means the first
qualifying task in a fresh install opens a manifest confirm the user never asked for — on a surface that does not render
yet ([G2]) and before the design's own falsification test has been executed. M10's rule already says "if `split-on` does
not beat `split-off` at equal dollars on ≥ 2 of 3 metrics, it ships as `off`"; starting there and flipping after the
measurement is a one-line config change, whereas flipping back after users have seen it is not.

### 3.2 Enumerators — code builds the options (`src/orchestrate/split/enumerate.ts`)

Each returns zero or one `Split` (an ordered `AgentSpec[]`); all are pure over
`{ plan, fileMemory, listing, lastTestRun, prefixTree, limits }`.

| `SplitKind` | Rule |
| --- | --- |
| `by_plan_item` | one agent per remaining plan item; `own` = the union of files the item's evidence and `fileMemory` associate with it, prefix-collapsed; items with no file association merge into the nearest agent by directory, or into a `prelude` agent |
| `by_directory` | group remaining items by the top-level source directory of their files (from the `git ls-files` prefix tree already computed by `workspace.listCandidates()`); `own = ['<dir>/**']` |
| `by_failing_test` | one agent per failing test file/suite in `lastTestRun`; `own` = that test's file plus the source files it imports (single-hop, code-computed for ts/py); `verify` = the single-test command |
| `by_layer` | only when the repo has a workspace manifest listing ≥ 2 packages (`package.json workspaces`, `pyproject` members, `Cargo.toml members`): one agent per package |
| `as_written` | §3.3 — the generator's own split, normalised like any other |
| `no_split` | the escape: a zero-agent split. Always present, always the fallback |

Shared post-processing: a file ≥ 2 agents would need becomes the `own` of a **`prelude` agent** that every other agent
`dependsOn` (so the shared types/interface change lands first). If the prelude would hold more than
`orchestrate.preludeMaxFiles` (8) files, the option is **deleted** — the work is not actually separable.

### 3.3 The LLM writes one option, and only one

In `jev-on`, `jev-off` and `llm-jev` the generator gets **one** call at the gate with a dedicated tool `propose_split`
whose schema is `{ agents: [{ slug, task, own[], verify[] }] }`, ≤ `orchestrate.maxAgents` entries, and whose prompt
carries the plan, the remaining items, the directory prefix tree (≤ 200 entries) and the failing tests — **not** the
transcript. Its answer becomes the `as_written` option and goes through the same normaliser as every code option. In
`jev-only` there is no generator, so `as_written` is absent and the decomposition is entirely code + Jev.

The LLM's prose is discarded. Nothing it writes becomes an instruction to Jev or to another agent; only the structured
split survives, and code owns every safety property of it.

### 3.4 Normalisation — the rejection filter (`src/orchestrate/split/normalize.ts`)

Applied to every option, in order; the **first** failure deletes the option and records `{ kind, reason }` in
`Manifest.rejected`.

1. `slug` matches `SLUG_RE`, unique within the option, never `dock` or `dock-*`, and not an existing `jevcode/<slug>`
   branch — on any of those collisions **the slug** is renamed to `<slug>-<n>` [D11]. Rule 1 runs to completion for
   every agent before `manifestId` is computed (§2.2), and `branch` is derived afterwards as `jevcode/<slug>`.
2. `own` globs are in the allowed sub-language only: `path/to/file.ext`, `dir/`, `dir/**`, `dir/*.ext`. No `!`, no
   braces, no leading `/`, no absolute path, no `..`; NFC-normalised; case-folded for overlap only on a folding volume;
   ≤ 32 per agent (prefix-collapsed above that); ≤ 200 chars each; never a submodule path
   (`--show-superproject-working-tree` / `.gitmodules`); never `.git/**`; never a `secretPaths` entry; never outside the
   git toplevel.
3. **Disjointness**: pairwise `own` intersection empty under glob-prefix containment (`dir/**` contains `dir/a.ts`).
   Any overlap not resolved by the prelude rule → deleted. *This is the whole safety argument* — and [D2] is what
   makes it true of the **branch diffs** and not only of the specs: with an unscoped `git add -A`, two agents whose
   `own` sets are provably disjoint would still both carry commits over every file the parent left uncommitted, and
   the second merge would conflict on any of them either agent later touched. `commit.test.ts` asserts the diff-level
   statement; `normalize.test.ts` asserts the spec-level one.
4. **Coverage**: every remaining plan item appears in exactly one agent's task, and the union of `own` covers every file
   the plan's evidence associates with a remaining item.
5. **Verification**: every `role: 'code'` agent has a non-empty `verify` from §5.1. An agent with none is *downgraded*
   to `role: 'research'` (read-only; no branch; never lands; output is a ≤ 2 KiB facts handoff).
6. **Dependency graph**: `dependsOn` is a DAG over slugs, depth ≤ 2; a cycle deletes the option.
7. **Caps**: `agents ≤ min(orchestrate.maxAgents, coordination.maxChildren)` [G15] and ≤ the §3.6 resource minimum;
   per-agent `capUsd ≥ minAgentUsd`, `maxSteps ≤ agentMaxSteps`, `maxWallMs ≤ agentMaxWall`. **[G15]** CD §6.5 already
   fixes "≤ 3 live children per session (`coordination.maxChildren`)" (CD:826) and a `coordination.childDepth`; two
   settings cannot both govern. The clamp is `min(...)`, the clamp reason is recorded in `Manifest.rejected`, and
   `docs/COMMANDS.md` states that `coordination.maxChildren` is the ceiling and `orchestrate.maxAgents` the preference.
8. **[G11] Task/own cross-check**: scan each agent's `task` text for path-shaped tokens (`[\w./-]+\.\w{1,6}` plus
   `src/...`-shaped prefixes) and reject the option when a token resolves to a real repo path **outside** that agent's
   `own`. This catches the common self-containment failure in code, leaving Jev's `is_self_contained` Noul (§3.5) as a
   second opinion rather than the only guard — which matters because that Noul is the single judgement Jev owns here.
9. **Secrets**: `detectSecrets` (`src/core/redact.ts:429`) over every `task`, `own` **and `verify`** (amended
   2026-09-22 — review `docs/research/orchestration/review-planner-2026-09-22.md` finding 4: `verify` commands are
   clipped but not redacted because they are executed as written, so the scan is the only thing that keeps a token in
   a verify command off the confirm card and out of `land.jsonl`). A hit does not delete the option; it flags the
   manifest so the confirm shows the `⚠ secret?` badge and the human must ack (count only, never the value).

If only `no_split` survives, the stage returns `{ split: noSplit, verdict: 'code' }` and **no Jev request is made**.
That is the O1(a) property.

### 3.5 Jev's role — ranking and gating only, with a fallback on every path

Jev is asked **two requests per delegation, ever**. Neither can make an agent land, unland, pass or fail.

**Request 1, at `decompose`** (`src/orchestrate/split/questions.ts`, `rank.ts`). Wording follows the measured style of
the existing rank questions: backticked paths, "Answer carefully and literally.", criteria as a definition plus ≥ 2
examples on both sides, descriptive snake_case option keys, and the escape option always present (enforced by
`src/jev/questions.ts:64`). State is bounded and never O(transcript):

```
{ task, plan: { remaining: [<=12 x 200], unverified: [<=8 x 200] },
  repo: { directories: [<=12], failing_tests: [<=8 x 120], verification: [<=4 x 120] },
  options: { split_by_plan_item: { agents: [{ slug, task: <=200, owns: [<=8], verify: [<=2] }] }, ... } }
```

Questions in one request (≤ 13 total):

- `which_split` — a **Choice** (`src/jev/questions.ts:63`) over the surviving kinds, with `none_of_these` as the escape.
- `can_<kind>` — one **paired Noul** per non-escape option: *"the agents of this option can be worked on at the same
  time without one of them needing to change a file another one owns"*, criteria on both sides with examples.
- `agent_<slug>_is_self_contained` — one **literal-fact Noul** per agent of the leading option: *"the task text of agent
  `<slug>` describes work that can be completed using only the files it owns"*. Phrased as a comparison of two given
  texts, not as a judgement, and now backstopped by the code check of §3.4 rule 8 [G11].

Resolution is `resolveChoice` (`src/loop/stages/choose.ts:43`) with `PAIRED_NOUL_FLOOR = 0.5` (`choose.ts:10`), escape
`none_of_these`, **fallback `no_split`**, and `annotateChoiceRows` (`choose.ts:73`) so the decisions pane shows
`chosen | overridden | fallback`. An agent whose self-contained Noul is below `orchestrate.selfContainedFloor` (0.5) is
dropped and its items merged into the agent owning the nearest directory; below 2 agents the result is `no_split`.

**Request 2, after every agent has finished** (§5.5): one **Score** (`src/jev/questions.ts:78`) per agent, 5 levels, for
**landing order only**.

**Every code fallback, exhaustively.** Decider error / timeout / 401 / `jev-off` → `no_split`. Below the floor →
`no_split`. Escape chosen → `no_split`. `--no-input` with `split: 'ask'` → `no_split` (the confirm cannot be answered).
`split: 'auto'` → the first enumerator option that normalised, in the fixed order `by_failing_test → by_layer →
by_directory → by_plan_item → as_written` (deterministic, so a relaunch repeats it). Request 2 unavailable →
topological, then slug order. **No `jev-unreachable` pane is ever opened for a decomposition** (CD §11 row 33's rule:
coordination-class calls never open a pane); the failure is one `notice kind: 'orchestration' level: 'info'`.

### 3.6 Resource pre-flight (code, before any worktree)

`src/orchestrate/preflight.ts`: measured repo size (`du -sk` of `.git` + checkout, cached per `repoKey`) × agents + 10 %
≤ free disk − `minFreeBytes` (2 GiB); `agents × agentMemBytes` (3 GiB, from the bench's measured 2.9 GB RSS peak) ≤ free
memory; `agents ≤ availableParallelism() − 1`; `agents × 3` fds + the json pipes within the soft `RLIMIT_NOFILE` margin.
A shortfall **reduces** the agent count (dropping the lowest-ranked and merging their items into survivors) and records
why; below 2 agents it is `no_split` with the reason.

### 3.7 The manifest, and the confirm the human always sees [G2]

`<runDir>/orchestrate/manifest-<step>.json` (≤ 32 KiB, redacted, checksummed):

```ts
export type SplitKind = 'by_plan_item' | 'by_directory' | 'by_failing_test' | 'by_layer' | 'as_written' | 'no_split';
export type AgentRole = 'code' | 'research' | 'critic';
export interface AgentSpec {
  slug: string; task: string;                  // <= 2,000 after redact + indexOneLine
  own: readonly string[];                      // <= 32 globs, the §3.4 sub-language
  role: AgentRole;
  verify: readonly string[];                   // <= 4 commands, <= 200 chars each; [] only for 'research'
  dependsOn: readonly string[];                // slugs, DAG, depth <= 2
  capUsd: number; maxSteps: number; maxWallMs: number;
  mode: EngineMode;
  branch: string | null;                       // `jevcode/<slug>`; null for 'research'
}
export interface Manifest {
  v: 1; manifestId: string;
  runId: string; sessionId: string; step: number;
  splitKind: SplitKind; verdict: ChoiceVerdict; probability: number; confidence: number;
  baseSha: string; repoKey: string | null; dockBranch: string;
  /** [D2] what §2.3's dirtySync replayed into every agent worktree: excluded from each agent's commit set (§2.6)
   *  unless that agent changed it, from §5.3's outside-`own` computation, and from the land diff. */
  syncedDirty: readonly { path: string; sha256: string; mode: number }[];
  /** [D1] the subset of syncedDirty that falls inside some agent's `own`: the paths §5.7's launch will have to ask about */
  dirtyOverlap: readonly string[];
  agents: readonly AgentSpec[];
  reserveUsd: number; reserveFrom: 'session' | 'run';
  rejected: readonly { kind: SplitKind; reason: string; probability: number | null }[];
  demand: DemandReason; createdAt: string; checksum: string;
}
```

**[G2] The confirm is a real card, not a synthetic `read` proposal.** The winner proposed reusing the review path by
passing "a synthetic `read`-class action carrying the manifest in `rawText`" and claimed the card was unchanged. It is
not: `confirmPreviewLines` (`src/tui/plain.ts:535`) renders `describeAction(req.proposal.action).preview`, and `read`
returns `preview: ''` (`plain.ts:160`), so the body renders as **nothing** — in Ink, in `--plain` and in the
screen-reader twin alike — while `reviewHeaderLines` (`src/tui/review/lines.ts:251`) prints `RISK_DIMENSIONS` gauges and
a `matchesIntent` row from a `RiskAssessment` a decomposition would have to fabricate, and `review:why`
(`w` then 1–5, `src/tui/keys/bindings.ts:124`) offers per-dimension explanations for dimensions that do not exist. The
one human gate in the whole design — the only thing between a Jev-ranked split and three spawned processes holding real
money — would have rendered blank.

**[D4] but the fix must not delete rows, because the row count is a contract.** Revision 1's second branch was
"`reviewHeaderLines` skips the gauge rows and the `matchesIntent` row when `body` is present". `confirmHeaderLines` is
specified as *exactly* `CONFIRM_HEADER_ROWS` rows (`plain.ts:517`, `:529-531`) and asserted at that length
(`test/unit/tui/plain.test.ts:243`); the ladder at `review/lines.ts:251-264` is asserted for n = 8,7,6,5,4,3,2 by
`test/unit/tui/review.test.tsx:24`; `RISK_DIMENSIONS` has four members (`src/core/types.ts:326`), so n = 8 is
`[title, keys, ruler, 4 gauges, matchesIntent]`. Skipping the gauges and `matchesIntent` returns **three** rows where
`Review.tsx:67` reserved n and the readline twin reserved 8 — a five-row hole inside a drawn box, and
`reviewCardLines` (`review/lines.ts:143`) delegates into the same ladder.

**[D5] and three more surfaces read dimensions that would not exist.** (a) `review:why` stays bound and would append a
`/why` block for `plan_mismatch` from a fabricated assessment. (b) `reviewScreenReaderLines` (`review/lines.ts:277`)
emits one aria row per `RISK_DIMENSIONS` entry plus `matches_intent` **unconditionally**, so the screen-reader twin
would read four fake gauges aloud — directly against O3(d) and M8. (c) `ConfirmRequest.proposal: Proposal` and
`.risk: RiskAssessment` are **required** (`types.ts:691-699`), and `reviewTitle` / `reviewCardTitle` read
`req.risk.risk`, `dimOf(req, dominantDimension(req))`, `req.proposal.action` and `req.proposal.goal`
(`review/lines.ts:101-134`), so making them optional is not a two-line change.

The fix, minimal, additive, and **count-preserving**:

```ts
// src/core/types.ts, contract 1.5
ConfirmRequest.title?: string;                 // [D5] replaces the computed review title verbatim (cut to `columns`)
ConfirmRequest.headline?: readonly string[];   // [D4] <= HEADLINE_ROWS_MAX (5): fills the gauge band, row-for-row
ConfirmRequest.body?: readonly string[];       // [G2] pre-rendered preview lines; replaces describeAction().preview
ConfirmRequest.badge?: string;                 // e.g. 'agent tui-rows' — rendered in the header
```

`headline` and `body` are separate fields on purpose: `confirmPreviewLines(req)` takes no `n`, so it cannot know how
many lines the header band already consumed. With two fields the card is rendered contiguously, once, with nothing
duplicated and nothing dropped. Five branches, all guarded on `headline === undefined` / `body === undefined` so the
ordinary review path is byte-identical:

| # | Function | Branch |
| --- | --- | --- |
| 1 | `confirmPreviewLines` (`plain.ts:535`) | `body !== undefined` → `clipDetail(body.join('\n')).split('\n')`; otherwise unchanged |
| 2 | `reviewHeaderLines` (`review/lines.ts:251`) | `headline !== undefined` → the band that would have held `[…gauges, matchesIntent]` is filled from `headline` instead, **padded with `''` to the same length**: n ≥ 8 (non-sr) → `[title, keys, ruler, …headline[0..4]]` = 8; n = 7 or sr → `[title, keys, …headline[0..4]]` = 7; n = 6 → `[title, keys, …headline[0..3]]` = 6; n = 3..5 → `[title, keys, …headline[0..n-3]]` = n; n ≤ 2 unchanged. Every ladder rung returns exactly what it returned before |
| 3 | `reviewCardLines` (`review/lines.ts:143`) | the same substitution inside its own `rows === 3 / ≤ 6 / === 7 / === 8 ‖ sr / else` branches, so the framed card keeps its height too |
| 4 | `reviewScreenReaderLines` (`review/lines.ts:277`) | `headline !== undefined` → `[title, …headline, …body (clipped to SR_BODY_ROWS = 12), SR_REVIEW_CHOICES, SR_REVIEW_PROMPT]`; the per-dimension aria rows and the `matches_intent` row are **not** emitted [D5a] |
| 5 | `reviewTitle` / `reviewCardTitle` (`:101`, `:124`) | `title !== undefined` → `truncateCells(title, columns, g)` prefixed with `badge` when set; `dominantDimension`/`dimOf` are never called |

and one key change: **`review:why` is refused while `headline` is set** (`w` then 1–5 answers
`no risk dimensions on this card — this is a proposal, not an action`, one `[ui]` line, no `/why` block) [D5b].

`proposal` and `risk` stay **required**, and the decompose stage constructs them exactly as follows rather than
leaving the values to the implementer [D5c]:

```ts
proposal = { goal: `delegate: ${splitKind} — ${agents.length} agents`,
             action: { kind: 'read', paths: [<relative manifest path>] },
             plan: <the current PlanDraft, unchanged>, rawText: '' }
risk     = { dims: Object.fromEntries(RISK_DIMENSIONS.map(d => [d, ZERO_DIM])), risk: 0,
             verdict: 'review', reason: 'a decomposition proposal: nothing is written until you approve' }
// ZERO_DIM = { risk: 0, probability: 1, expected: 0, tailMass: 0, bound: 'expected', confidence: 1,
//              taskImpossible: 0, level: 0, text: 'not assessed: this card proposes a split, not an action' }
```

`matchesIntent` is left absent. The property `review.test.tsx` gains is that **with `title`/`headline`/`body` set, no
rendered row contains any substring of `risk` or `proposal`** — so the synthetic values are unreachable by
construction rather than merely unlikely to be noticed, and the `it.each` over n = 8…2 is extended with a
`headline`-bearing request at every n, asserting the identical row counts.

`[y] [n] [d] [e]`, the `⚠ secret?` badge, the decline note and `confirm:resolved` are all unchanged — those parts of
the winner's claim do hold. The card body is built by `src/tui/agents/lines.ts` and lists every agent with its `own`,
`verify`, caps and mode, the reserve arithmetic, and the rejected options with their reasons and probabilities. When
`Manifest.dirtyOverlap` is non-empty the card's **first** headline row is the [D1] warning, because it is the one
fact that changes what `/land` will do later:

```
⚠ your checkout has 7 uncommitted files; 2 of them (src/tui/Pane.tsx, src/loop/engine.ts) are inside an agent's
  slice — /land will ask you to commit or stash those two before it merges
```

Policy:

- `split: 'ask'`: always confirmed. A decline is an ordinary `declined` outcome — the reason reaches Jev and the
  generator, and `harnessProblems` gains an `orchestration` entry so the next steps go single-threaded.
- `split: 'auto'`: the confirm is skipped **only** when every agent has `role: 'research'`. A code-writing agent is
  never spawned without a human `[y]`.
- `--no-input` / pipe / bench: no blocker → the confirm answers `stop` → `no_split`. Headless delegation needs an
  explicit `--split=auto` (research-only) or `--yes-split`, recorded in `RunMeta.overrides`.

On approval the engine writes the manifest, emits `orchestration:proposed`, and reaches **P9**.

---

## 4. Control — pause, resume, end, steer, from anywhere

This section is **normative for the surface**, in the shape of CD §12.0: every name is either already in this document
or additive, and the TUI session codes against these signatures without touching `src/loop/**`.

### 4.1 Contract header and the additive type list

Types land in `src/core/types.ts` under one new header line, placed **directly after** CD's `// contract 1.4` line
(which is not yet in the tree — HEAD's last header is `// contract 1.3 (2026-09-21)` at `types.ts:12`, so orchestration
rebases onto the commit that lands 1.4 and never edits above it):

```
// contract 1.5 (2026-09-21): orchestration — decompose stage, manifest, agents, landing queue per docs/ORCHESTRATION-DESIGN.md §4.1;
// every item is optional or a new union member; Action, STOP_REASON_SET, exitCodeFor, MODES and CheckpointEnvelope.version are untouched.
```

```ts
StageName                 | 'decompose'                                   // types.ts:241
PausePointReason          | 'delegate' | 'review-needed'                  // CD §12.0.2
HarnessProblemKind        | 'orchestration'
NoticeKind                | 'orchestration'
UndoSkipReason            | 'landed'                                      // types.ts:996
PaneTab                   | 'a'                                           // TUI-owned; see [G20]
MessageType               | 'budget' | 'review' | 'kick' | 'land'         // coordination
Lease['type']             | 'agent'
CancelReason              | (unchanged; CD §6.4 already adds 'pause')
export type SplitKind, AgentRole, AgentState, DemandReason, GateReason
export interface AgentSpec, Manifest, LandAttempt, VerifyResult, AgentRow, AgentRef
ConfirmRequest.body?: readonly string[]; ConfirmRequest.badge?: string           // [G2]
ConfirmRequest.title?: string; ConfirmRequest.headline?: readonly string[]        // [D4] [D5]; proposal and risk stay REQUIRED
StepRecord.commit?: string                                                        // [G1]
StepRecord.escaped?: readonly string[]                                            // [G8]
StepTiming.decomposeMs?: number                                                   // [D13]; types.ts:380
EngineSeed.siblings?: readonly { slug: string; task: string; own: readonly string[] }[]   // [D13]; types.ts:1131
EngineOptions.orchestration?: { depth: 0 | 1; role?; own?; parentRunId?; parentSessionId?; slug?; manifestId?; reviewAnswerFile?; commit?; syncedDirty? }
EngineOptions.splitPolicy?: { split: 'off'|'ask'|'auto'; maxAgents: number; maxSplits: number; splitEvery: number; ... }
CheckpointState.orchestration?: { manifestId; step; dockBranch; agents: { slug; state: AgentState; runId: string|null; commit: string|null }[] }
CheckpointState.splits?: number
RunMeta.orchestration?: { manifestId; agents: string[]; dockBranch; landed: { slug; commit; step }[] }
RunMeta.agent?: { slug; parentRunId; parentSessionId; own: string[]; manifestId; syncedDirty: { path; sha256; mode }[] }   // [D2]
RunMeta.landed?: { step: number; branch: string; commit: string }[]
RunMeta.undoUnavailableBelow?: number                                             // shared with CD §9.3
EngineStatus.orchestration?: { manifestId; agents: number; live: number; landed: number; reserveUsd: number; heldUsd: number } | null
SpendMeter.hold?(usd: number): void;  SpendMeter.release?(usd: number): void      // optional so every fake compiles; types.ts:731
SpendSnapshot.heldUsd?: number                                                    // [G6]; restore() re-establishes it
sessionRemainingUsd(capUsd, spentUsd, heldUsd = 0)                                // [D6]; src/tui/budget/lines.ts:184 — a third
                                                                                  //   OPTIONAL argument, so childCapUsd/followUpDecision
                                                                                  //   and every existing caller keep their behaviour
CheckpointStore.writeCache?(rel: string, json: Json): Promise<void>               // shared with CD §6.4
```

`EngineEvent` gains twelve members, all additive so unknown-type-ignoring consumers are unaffected and the json stream
stays `v: 1`:

```ts
| { type: 'decompose:start'; step: number; options: number }
| { type: 'decompose:skipped'; step: number; why: GateReason }                    // --json=verbose only
| { type: 'decompose:ranked'; step; splitKind: SplitKind; verdict: ChoiceVerdict; probability: number; agents: number; rejected: number }
| { type: 'orchestration:proposed'; step: number; manifest: Manifest }
| { type: 'agent:start'; agent: AgentRef }                                        // host-emitted
| { type: 'agent:status'; agent: AgentRef; row: AgentRow }                        // host-emitted, verbose
| { type: 'agent:review'; agent: AgentRef; request: ConfirmRequest }
| { type: 'agent:end'; agent: AgentRef; stopReason: StopReason; exitCode: number; commits: number; changedFiles: number; spendUsd: number }
| { type: 'land:attempt'; slug: string; dockHead: string; pinned: string }        // [G3] pinned sha
| { type: 'land:result'; slug: string; outcome: 'landed'|'conflicted'|'failed-verify'|'refused'; commit?: string; verify?: VerifyResult[]; rule?: string }
| { type: 'orchestration:settled'; landed: string[]; parked: string[]; dropped: string[]; dockBranch: string; spendUsd: number }
| { type: 'agent:adopted'; count: number; parentRunId: string }
```

and the TUI-owned host widening (**[D15]**: the widening attaches to `pause()` at `types.ts:1551`, not to the
`interface SessionHost` line at `:1538`, which revision 1 cited):

```ts
SessionHost.pause(opts?: { at?: 'step'|'now'; scope?: 'run'|'tree'|'agents'|'all'|`agent:${string}` }): void   // types.ts:1551 [D15]
SessionHost.agents?(): readonly AgentRow[]                                                                     // the interface opens at types.ts:1538
```

`test/unit/core/contract.test.ts` gains the `1.5` header-order case and asserts `Action`, `STOP_REASON_SET`,
`exitCodeFor` and `MODES` are byte-identical.

### 4.2 Two new pause points [G17]

Added to CD §12.0.2's table, same shape, same stop reason (`human_pause`, exit 4, resumable without `--force`).
`PausePointReason` gains `'delegate' | 'review-needed'`.

| # | Point | `pause({at:'step'})` | `pause({at:'now'})` | Persisted, in order | `PausePoint` |
| --- | --- | --- | --- | --- | --- |
| **P9** | **delegation accepted** — the manifest was confirmed at step *n*; the parent has nothing left to do until children report | identical (the manifest is written; nothing is in flight) | identical | `orchestrate/manifest-<n>.json` → `state.json` (`orchestration`, `interrupted = null` — **the step committed**) → heartbeat `phase:'ended'` with `pausePoint` → `run:end` | `{ step: n+1, round: null, phase: 'idle', reason: 'delegate', resumableAt: 'boundary', replayable: false, by: 'self', end: false }` |
| **P10** | **a child needs a human decision** — a `review` verdict, or any blocking pane, inside a child | the pane/confirm is awaited as today until `pause()` | the parking confirmer/blocker rejects with `AbortError('human_pause')` → rule-1 discard + `cache/step-<n>.json` | `orchestrate/review-<n>.json` → `cache/step-<n>.json` → `state.json` (`interrupted` + `interruptedDetail`) → heartbeat → `run:end` | `{ step: n, round: null, phase: 'risk' \| 'pane', pane?: kind, reason: 'review-needed', resumableAt: 'cache/step-n.json', replayable: proposal !== null, by: 'self', end: false }` |

**[G17] P9 is engine-initiated, and every surface must say so.** Reusing `human_pause` as the stop reason is defensible
— CD already overloads it for `end` — but no human asked. Therefore: `by` is `'self'`, not a `peer:`/`device:` form;
the transcript stop line, `run:end` and the picker read `delegated at step 11 — 3 agents running`, never the
paused-by-a-human phrasing; and every consumer that keys off `human_pause` to mean "a human asked" (the status strings,
the `--json` consumers, the resume card's default action) adds the `reason: 'delegate'` case explicitly. The winner's
P9/P10 rows also elided two **required** members of CD's `PausePoint` — `round` and `end` — which are filled in above.

P9 is the only pause point where the run stopped with **nothing interrupted** (the step committed whole), which is why
`[r] replay` is absent and `Enter` resumes at a fresh step. P10's replay re-asks the confirm, which the answer file
satisfies.

### 4.3 Scope grammar — three scopes, every verb

`/<verb> [now] [<scope>]`, extending CD §5.3's target grammar:

| Scope | Means |
| --- | --- |
| *(default)* | this run only |
| `tree` | this run **and every live child of this session** |
| `agent:<slug>` / `<slug>` | one agent |
| `agents` | every live child, not the parent |
| `all` | every live run on this device (CD §5.3) |
| `device:<label>` | routed (CD §7.3) |

**The default for a delegating session is `tree`, and the UI says so.** Pausing a parent while three children keep
spending is the footgun. `Esc` on a delegating session opens exactly this row:

```
pause this session: [y] tree (3 agents at their next step)  [Y] tree now  [t] this run only  [n] stay
```

`Esc Esc` (abort) with children live asks `abort 3 agents too? [y] all  [t] this run only  [n] cancel` — and **abort
always needs the local `[y]`**; no relayed abort is ever honoured.

### 4.4 Cascade mechanics, and its bound

Parent → child is not a signal; it is a **`pause` / `end` / `budget` / `review` / `kick` message** in the coordination
inbox addressed to the child's `sessionId`, applied by the child's own host via `engine.pause({ at, by: 'peer:<sid8>' })`.
The relay is trusted **by construction and only by construction**: same device, same user, and
`msg.from.sessionId === RunMeta.agent.parentSessionId`. The child's host checks that field and refuses anything else
without `coordination.remoteControl: 'allow'`. Nothing about the relay widens the child's rights: it can pause, end,
lower a budget, deliver a review answer it asked for, and steer within the existing bounds. It cannot approve a
*different* confirm, raise a cap it did not park on, change the sandbox, or run a command. There is no file-mailbox
fallback [G5].

**The cascade never blocks the parent.** `pause tree` (a) sends N messages, (b) reports `3 pause requests sent · 1 acked
· 2 pending (they finish their step)`, (c) returns. Children end on their own schedule; a child mid-`execute` is
**never killed** (CD P4's rule: a half-applied command is worse than 20 more seconds) and its row says
`execute finishes first (12 s)`. The 5 s shutdown-checkpoint bound applies to each process independently, so the tree's
shutdown is bounded by `max(child step time)`, not by their sum.

**Reaping.** The supervisor keeps a reaper: a child whose process exits without a `run:end` line (crash, OOM kill) is
marked `crashed` from its `state.json` + dead `run.lock` (`isPidAlive`, `src/session/lock.ts:27`, plus the boot-time
rule for pid reuse). A child whose `run:end` never arrives but whose heartbeat is live is left alone — it is working,
the pipe is just quiet.

**Adoption.** A SIGKILLed supervisor leaves children running; their state is entirely on disk, and the **next session on
this workspace adopts them** within one poll (15 s), printing `adopted 3 agents of run 2026…-rpywkq2v (2 running, 1
parked)` and emitting `agent:adopted`. This is strictly better than in-process teammates, whose ghosts survive a
`/resume` (Claude Code's agent-teams page lists "no session resumption of in-process teammates" as a standing
limitation).

**Caps are checked against the fold, never a counter.** A resumed or adopted child counts against `maxAgents` because
the check is `listSessions(fold, self).filter(a => a.heartbeat.parentRunId === myRunId && a.liveness === 'live').length`.
This closes the "resuming takes a fresh slot without checking the limit" hole that Claude Code documents in its own
subagent limits.

### 4.5 The resume card

Shown by `resumeRun` (`src/cli/session.ts:2260`) before `createEngine` whenever `state.orchestration` exists, in CD
§7.3's card slot, in the plain block and in `--json`:

```
─ resume 20260921-234432-rpywkq2v · "fix store rotation + tui rows" ──────────────────────────
delegated at step 11 · manifest by_directory (chosen, p=0.78) · 3 agents · reserve $0.90
base 3f9a2c1 (unchanged) · dock jevcode/dock-a2fee9c1 (1 landed, verified)
  ✓ fix-store    landed    7 steps  $0.21  jevcode/fix-store @8bc0d11   npm test ✓ typecheck ✓
  ● tui-rows     running   step 4/12 propose  $0.14/0.30  src/tui/**        no beat 3 s
  ⏸ test-fixture review    step 3    $0.06/0.30  patch test/unit/store.test.ts (risk 0.52)
[Enter] resume the parent (converge)   [a] agents tab   [Enter on a row] act   [d] diff dock
[p] pause tree   [e] end tree (branches kept)   [f] forget the delegation (keeps branches)   [Esc]
```

Exact rules. `[Enter]` resumes the parent even with children live (its next step is the converge step; live children
read `pending`). The card **refuses** to resume a *child* that is live (the existing `run.lock` + `peerLive` check, exit
2, naming the pid/device). A `baseSha` mismatch replaces `[Enter]` with `base moved 3f9a2c1 → 9d21ee0 (2 commits by
you) — [r] rebase the 3 agents · [s] stage on the old base · [f] forget`. A missing worktree offers `[n] recreate from
jevcode/<slug>` (the branch is the truth, the worktree is a cache). A missing branch **and** missing run dir marks the
agent `dropped`.

### 4.6 What the TUI needs — the control surface [G20] [G2]

**The agents tab** (`PaneTab` gains `'a'`; `src/tui/pane/agents.ts`, pure).

**[G20] A fifth tab is not free.** `PaneTab` and `PANE_TABS` enumerate exactly four (`src/tui/pane/model.ts:245-246`),
`cycleTab` indexes that array (`:307-309`), `TAB_TITLE` is a total `Record<PaneTab, string>` (`:322`), and the
`global:paneNext` / `panePrev` binding titles hardcode the cycle "d → p → t → s" in prose
(`src/tui/keys/bindings.ts:72-73`). A fifth tab therefore touches `PaneTab`, `PANE_TABS`, `TAB_TITLE`, `cycleTab`,
**both** binding titles and the `/panel` argument validator (`PANEL_ARGS` in `src/tui/commands/registry.ts`, read by
`parsePanelCommand`, `src/tui/pane/commands.ts:32`). The cycle position is decided here rather than left to the
implementer: `'a'` goes **last** (`d → p → t → s → a`) and is **skipped by the cycle when no delegation exists in
this session**, so `]` does not silently change behaviour between runs; `/panel a` and `Alt+A` still open it directly
and print `no agents in this session` when empty.

**[D7] "Skipped when empty" is not expressible against today's signature, so the signature changes.** `cycleTab(tab,
dir)` is pure over the module-level `PANE_TABS` with no state parameter, and it has three callers, not one: the
`]`/`[` handler (`src/tui/App.tsx:1419`) and the two side-by-side next-tab titles (`model.ts:356`, `:476`). The
ratified shape is

```ts
export function cycleTab(tab: PaneTab, dir: 1 | -1, tabs: readonly PaneTab[] = PANE_TABS): PaneTab
export function paneTabsFor(hasDelegation: boolean): readonly PaneTab[]   // PANE_TABS, minus 'a' when false
```

with every caller passing `paneTabsFor(state.agents.length > 0)`; the default argument keeps
`test/unit/tui/pane/model.test.ts:165-167` green unchanged. The same fact makes the two binding titles **dynamic**
rather than the static prose [G20] proposed editing, so they read `next pane tab (d → p → t → s, + a while
delegating)` and `previous pane tab (…)` — one string each, no per-frame computation. §8.3 items 29 and 31 carry this
before they are estimated; it is the whole content of the Q2 amendment.

Collapsed strip (1 row): `agents 3 · ✓1 ● 1 ⏸1 · $0.41/0.90 · dock ✓`. Open (≤ 6 rows) / full (12 rows): one row per
agent, **always every agent** — a row is never hidden while the agent exists, and rows never collapse into "N idle
agents" (both behaviours exist in shipping agent panels and both confuse hidden with stopped). Above 12 the tab scrolls.

Row columns, clipped by `stringWidth` in this drop order (widest first): `glyph state · slug · step/max stage ·
$spent/cap · wall/max · own (first glob + "+n") · branch@head · verify · last line (≤ 40)`.

| State | Glyph · role | Word | Keys offered |
| --- | --- | --- | --- |
| `planned` | `○` muted | `queued` | `x` |
| `starting` | `◌` muted | `starting` | `x` |
| `running` | `●` accent | `step n/m <stage>` | `p P t + x d g Enter Space` |
| `paused` | `⏸` muted | `paused (you)` | `r + x d` |
| `parked` | `⏸` warn | `parked (<why>)` | `r + k x d` |
| `review` | `⏸` warn | `needs approval` | `Enter d q x` |
| `stalled` | `⚠` warn | `no progress 11 m` | `p k x d` |
| `done` | `✓` ok | `done, not landed` | `l k x d` |
| `landing` | `⟳` accent | `landing` | — |
| `landed` | `✓` ok | `landed @<sha7>` | `d` |
| `conflicted` | `✗` error | `conflicts in <path>` | `k x d` |
| `failed-verify` | `✗` error | `<cmd> failed` | `k x d` |
| `kicked` | `↻` warn | `kicked (1/1)` | `p x d` |
| `dropped` | `−` muted | `dropped` | — |
| `crashed` | `✗` error | `crashed at step n (<stage>)` | `r x d` |
| `failed-start` | `✗` error | `failed to start (<code>)` | `x` |

`--ascii` substitutions per TD §14.1. **Every row string is produced by one pure function** shared by the Ink tab, the
`--plain` twin, the screen-reader twin and `jevcode agents list`, which is what makes O3(d) a single-function property
rather than four implementations that drift.

**Cards** (`src/tui/agents/lines.ts`, pure): the **manifest card** (the `title` / `headline` / `body` of [G2] [D4]
[D5], with the `dirtyOverlap` warning as headline row 1 when it is non-empty [D1]), the **resume
card** (§4.5), the **land preview** (`/agent <slug> land --dry`), and the **agent review banner** — the parent's review
card carrying `ConfirmRequest.badge = 'agent tui-rows'` so nobody approves the wrong thing.

**Keys** (`src/tui/keys/bindings.ts`; each default checked free against the registry in the working tree —
`meta+a` is unused, and there is **no** `ctrl+x` chord bound at all today): `global:panelAgents` = `meta+a`;
`run:pauseTree` = `ctrl+x ctrl+a`. On the agents tab (a new `KeyContext 'agents'`): `↑↓` select, `Enter` attach,
`Space` peek (last 8 lines), `p`/`P` pause / pause-now, `r` resume, `t` steer, `+` budget, `l` land, `k` kick, `x`+`x`
drop, `d` diff, `g` copy worktree path, `Esc` leave. The bindings test asserts per-context key uniqueness, so a later
collision fails CI.

**Status line**: one field after the session meter, dropped before it —
`agents 2/3 ✓1 ✗0 · $0.41/0.90 (+$0.06)`, the parenthesis being the worst-case overshoot (§6.3). While delegated the
mode badge is followed by `delegated` instead of a stage verb.

**Toasts**: agent started / landed / failed to land / parked / needs approval / stalled / crashed / budget raised / dock
verified / queue settled. `--notify` (OSC 9/777) fires for **needs approval**, **conflicted**, **crashed** and **queue
settled** when the terminal is blurred; `orchestrate.notify: 'all' | 'attention' | 'off'`, default `attention`.

**Chat facts** (`src/chat/facts.ts`, `replies.ts`): "what are my agents doing?", "how much have the agents spent?", "why
did fix-store not land?" are answered from the in-memory rows and `land.jsonl` with **no model call**, the same
treatment `/cost` and `/status` questions get today.

### 4.7 Commands and shell twins

| Command | Avail | Plain | Args |
| --- | --- | --- | --- |
| `/split` (alias `sp`) | idle, live | yes | `[n]` — propose a split of n agents at the next step; `off` shuts the gate for this run |
| `/agents` (alias `ag`) | any | yes | `[--worktrees] [--all]` — the table; opens the tab in the TUI |
| `/agent <slug> <verb>` | any | yes | `pause [now] · resume · end · drop · tell <text> · budget +<usd> · land [--dry\|--anyway] · kick · review · diff · logs` |
| `/land` (alias `/merge`) | idle | yes | bare: launch the verified dock as a judged step; with a slug: land that agent [G18] |
| `/pause` | live | yes | gains `[now] [tree\|agents\|<slug>\|all]` |
| `/end` | any | yes | gains `[now] [tree\|<slug>]` |
| `/spawn <task>` | idle, live | yes | CD §6.5's one-off: a **one-agent manifest** with `own` from `--own`, through the same confirm, critic and queue — the degenerate case of the same machine, not a second path |

Shell twins: `jevcode agents [list|logs|pause|resume|end|drop|tell|budget|land|kick|review|gc] [<slug>]` with `--json`,
`--now`, `--all`, `-f`, built over an injected I/O seam like `src/cli/sessions.ts`, starting no engine.

`/land` is added to `EXCLUSIVE_COMMANDS` (`src/cli/session.ts:218`) — it touches files, credentials and the run list.

### 4.8 Verbs, keys and the exact strings

| Moment | TUI | Shell | Status / transcript text |
| --- | --- | --- | --- |
| propose a split | `/split [n]` | `run --split=ask` | `decomposing · 4 options built, 1 rejected (shared file: src/core/types.ts)` |
| the manifest confirm | review card `[y][n][d][e]` (`w` answers `no risk dimensions on this card` [D5]) | — | `3 agents · src/tui/** · src/loop/** · test/** · reserve $0.90 of $1.80 · verify: npm test, npm run typecheck` |
| declined | `[n]` | — | `split declined; continuing single-threaded (the reason reaches the next step)` |
| delegated (P9) | — | — | `delegated at step 11 — 3 agents starting · /agents (Alt+A) · Esc pauses the tree` |
| an agent row | `↑↓` | `agents list` | `● tui-rows  step 4/12 propose  $0.14/0.30  4m02s/15m  src/tui/**  jevcode/tui-rows  "edit src/tui/Pane.tsx"` |
| attach (read-only) | `Enter` | `agents logs <slug> -f` | `watching tui-rows (read-only) — ←/Esc back · [t] tell · [p] pause` |
| pause one | `p` | `agents pause <slug>` | `pausing tui-rows · step 4 commits first (propose, 41 s)` |
| pause now | `P` | `agents pause --now <slug>` | `paused tui-rows now at step 4 (propose): proposal kept — resume replays it` |
| pause the tree | `Esc`→`[y]`, `Ctrl-X Ctrl-A` | `agents pause tree` | `3 pause requests sent · 1 acked · 2 pending (they finish their step)` |
| resume one | `r` | `agents resume <slug>` | `resumed tui-rows at step 5 (replayed the paused proposal; risk re-checked)` |
| review needed (P10) | toast + `Enter` | `agents review <slug>` | `test-fixture needs approval: patch test/unit/store.test.ts (risk 0.52) — [Enter] review · [d] decline · [q] leave it parked` |
| steer one | `t` | `agents tell <slug> "…"` | `steered test-fixture (1 queued for its step 4)` |
| more budget | `+` | `agents budget <slug> +0.20` | `tui-rows cap $0.30 → $0.50 (session $1.43/2.00) — resumed` |
| land one | `l` | `agents land <slug>` | `landed fix-store into jevcode/dock-a2fee9c1 @8bc0d11 · npm test ✓ (412) · typecheck ✓` |
| land refused | — | — | `fix-store not landed: removed 4 assertions in test/unit/store.test.ts — /agent fix-store land --anyway (twice) overrides` |
| conflict | `k` | `agents kick <slug>` | `fix-store conflicts with tui-rows in src/checkpoint/store.ts (lines 361–383) — kicked (1 of 1)` |
| drop one | `x`×2 | `agents end <slug>` | `dropped test-fixture (branch jevcode/test-fixture kept, 1 commit)` |
| stalled | — | `agents list` | `tui-rows: no progress for 11 m (same step 4, no files changed) — [p] pause · [k] kick · [x] drop` |
| queue settled | — | — | `3 agents: 2 landed, 1 parked · dock verified · /land merges it here` |
| launch | `/land` | — | `step 12: run git merge --no-ff <pinned sha> → 14 files, npm test ✓` |
| undo a land | `/undo 12` | — | `step 12 was a merge; images cannot restore it — [g] git revert 4b1c9de (a new judged step)` |
| exit with agents live | `[k][e][n]` row | — | `3 agents live: [k] keep them running (they keep spending) · [e] end them · [n] stay` |
| adopted after a crash | — | `agents list` | `adopted 3 agents of run 2026…-rpywkq2v (2 running, 1 parked) — /agents` |

### 4.9 Headless and the exit-code contract [G12]

A delegating parent finishes at P9 with `human_pause`, which `exitCodeFor` (`src/loop/stop.ts:22`) maps to
`EXIT_CODES.budget` = **4**, *while its children are still live*. Left unstated, a CI job would read 4 as "budget
exhausted" and a script would exit before any agent landed. Decided:

- `jevcode run --split=auto --json` **waits** by default: after P9 the process stays alive as the supervisor, streams
  `agent:*` and `land:*` lines, drives the queue, and then runs the converge step. Its exit code is the **converge run's**
  code, not 4. The bound is `orchestrate.agentWaitCeilingMs` (default 30 min); on expiry it sends `end` to every live
  child, waits ≤ 5 s, emits `orchestration:settled` with `parked`, and exits with the converge code.
- `--split=auto --no-wait` returns at P9 with exit 4 and prints
  `delegated: 3 agents running; jevcode agents list --json to follow, jevcode run --resume <id> to converge`.
- `run:end` for a delegating parent carries `orchestration: { agents, live }` so a consumer can distinguish P9's 4 from
  a real budget stop without parsing prose.

---

## 5. Results — merging child worktrees, conflicts, and tests as the arbiter

**The critic is code.** `orchestrate.critic: 'tests' | 'run' | 'off'`, default `'tests'`. There is no "critic agent" by
default, because a model asked to grade a diff is a worse instrument than the repo's own tests, and because the
independence that makes a critic worth anything (AgentCoder's result depends on the grader being independent of the
writer) holds for the repo's tests by construction and not for a sibling model.

### 5.1 The verification set — resolved by code (`src/orchestrate/verify.ts`)

In order, first hit wins:

1. `orchestrate.verify` from the config (an array of commands) — explicit wins.
2. `package.json` scripts, **only** the names `test`, `typecheck`, `lint`, and only when present → `npm run <name>`.
3. `pyproject.toml` / `pytest.ini` / `tox.ini` → `pytest -q`; `Cargo.toml` → `cargo test`; `go.mod` → `go test ./...`;
   a `Makefile` with a `test:` target → `make test`.
4. The synth oracle's runner when the workspace is one it handles (`src/synth/oracle`).
5. The parent's `lastTestRun.command` — whatever the parent actually ran and parsed.
6. None → every code agent is downgraded to `research` (§3.4 rule 5) and the manifest says `no verification command
   found; agents are research-only (set orchestrate.verify to allow code agents)`.

Each command is bounded by the existing sandbox rules (`commandTimeoutMs`, `maxOutputBytes`, tree kill) and marked
`exclusiveTree` (CD §4.2's command class), so two docks or a user build never race.

### 5.2 The dock and the land attempt (`src/orchestrate/land.ts`) [G3] [G18]

The queue is `LandQueue`: a pure reducer over `{ agents, landed, head, attempts }` producing `LandStep`s, unit-testable
without git. The effects, per agent, in queue order, holding `<runDir>/orchestrate/land.lock` (O_EXCL + pid liveness,
the `acquireRunLock` recipe, `src/session/lock.ts:91`):

```
# once, lazily, through the CD §12.0.4 facade
createWorktree(ledger, { repoKey, slug: 'dock-<runId8>', base: baseSha, runId, sessionId })

# [G3] pin the ref ONCE, then never mention the branch again
pinned=$(git -C <dockDir> rev-parse --verify refs/heads/jevcode/<slug>^{commit})
record pinned in orchestrate/land.jsonl and emit land:attempt { slug, dockHead, pinned }

git -C <dockDir> merge --no-ff --no-edit <pinned>
  -> conflict: git merge --abort ; state 'conflicted' ; record conflicting paths + hunk ranges
  -> clean:    run this agent's verify commands AND the base set, against the merged tree
       -> all exit 0 and the §5.3 hard rules pass:
            re-check: git -C <dockDir> rev-parse refs/heads/jevcode/<slug> == pinned, else HARD REFUSE
            state 'landed', record the merge commit
       -> else: git -C <dockDir> reset --hard <previousDockHead>
                git -C <dockDir> clean -fdx -e <each syncedIgnored> -e <each orchestrate.dockCleanExclude>   # [D14]
                state 'failed-verify'; record the failing command + tail (<= 40 lines)
```

**[D14] `reset --hard` does not restore the dock; `reset --hard` plus a scoped `clean` does.** Row 39 promised "the
dock is exactly as it was", but `git reset --hard` leaves untracked files alone, and the verify commands are
precisely what create them — `dist/`, `.pytest_cache`, `coverage/`, `__pycache__`, `*.tsbuildinfo`. The next agent's
merge then runs against a polluted tree, and `git merge` can itself refuse on an untracked file it would overwrite —
the same failure class as [D1], one level down. The `clean` needs `-x` (the artefacts are gitignored) and therefore
needs explicit exclusions, or it would delete the `.env` the dock was given (`syncedIgnored`) and re-cost every
`node_modules` install: `orchestrate.dockCleanExclude` defaults to `['node_modules/', '.venv/', 'target/', '.gradle/',
'.tox/', '.mypy_cache/']` and is unioned with `syncedIgnored`. Row 39 and `land.test.ts` state the invariant as
*"after a failed verify, `git status --porcelain --untracked-files=all` in the dock lists nothing outside
`syncedIgnored ∪ dockCleanExclude`"*.

**[D10] The supervisor's two sandboxes, specified once.** Nothing in revision 1 constructed the `Sandbox` that
`runGit` and every verify command require, and §2.6 and §5.2(b) disagreed about whether one existed. The supervisor
builds exactly one per worktree it writes to, from the **parent's** resolved configuration, and reuses it for that
worktree's whole life:

```ts
createSandbox({
  workspaceRoot: <agentDir | dockDir>,          // the worktree is the root: writes cannot leave it
  runDir:        <childRunDir | parentRunDir>,  // tmp/ and home/ live here
  profile:       <the parent's resolved SandboxProfile>,   // never 'off'; a weaker child profile is refused (§2.6)
  noNetwork:     <the parent's>,                // the [G1] commit needs none; a verify command may
  secretReadDenies: <the parent's>, redact: <the parent's>,
  gitDir: <worktree gitDir>, gitCommonDir: <repo commonDir>, configDirs: <the parent's>,
})
```

used for (i) the [G1] `add`/`commit` in an agent worktree, (ii) `rev-parse`, `merge`, `reset`, `clean` and `rebase`
in the dock, and (iii) every §5.1 verify command, with `commandTimeoutMs`, tree-kill, `maxOutputBytes` and
`exclusiveTree` applied by the supervisor exactly as the engine applies them. §8.3 item 34 owns the construction.

**The depth keying of [G3]'s refs deny is an invariant, not a detail.** The deny list below is added **only** when
`orchestration.depth === 1`. If the supervisor were to reuse a child's profile, [G1]'s commit could not write
`refs/heads/jevcode/<slug>` and the landing layer would be inert a second time, for a second reason.
`seatbelt.test.ts` carries both cases: a depth-1 profile denies `<commonDir>/refs/**`, and a depth-0 supervisor
profile for the same worktree does not.

**[G3] Verify and merge a pinned sha, never a ref.** The winner verified and merged `jevcode/<slug>` as a *branch name*,
which opens a TOCTOU window: `<commonDir>` is a **writable root** for a linked worktree
(`src/sandbox/seatbelt.ts` adds `commonDir` / `gitDir` to the write allow-list when they fall outside the workspace), and
the git denies cover only `config`, `hooks`, `config.worktree`, `modules/*/{config,hooks}` and
`worktrees/*/config.worktree` — **not** `refs/**`, **not** `packed-refs`, **not** `logs/**`. A sibling's sandboxed
command can therefore move its own or the dock's branch between the verify and the merge, and under
`orchestrate.land: 'step'` that dock is merged into the user's checkout. Two fixes, both required:

1. Resolve the branch to a sha once, verify **that** object, merge **that** object, and hard-refuse if `rev-parse` no
   longer equals it at merge time (above).
2. Extend the seatbelt deny list for children (`orchestration.depth === 1`, and **only** there — see [D10] above):
   `<commonDir>/refs/**`, `<commonDir>/packed-refs`, `<commonDir>/logs/**`, `<commonDir>/worktrees/*/HEAD`. An agent
   never needs to move a ref — after [G1] the *harness* moves them, from a depth-0 profile — so the deny costs
   nothing.

**[G18] This narrows a CD invariant, and the narrowing is stated rather than implied.** CD §6.5 says `/merge <slug>`
proposes the merge as a TASK because "JevCode never runs a git write outside a judged step". The supervisor here runs
`git merge --no-ff` into the dock and then runs the repo's verify commands, both outside any judged step. The
narrowing, recorded so the two documents do not ship contradicting each other:

- (a) the dock branch and worktree are **disposable and never the user's checkout**; the only write to the user's
  checkout is §5.7's judged step;
- (b) the supervisor's git writes **and** its verify commands run under the dock's own sandbox — the [D10] object
  above, workspace root = the dock dir, profile = the parent's resolved level, never `'off'` — with
  `commandTimeoutMs`, tree-kill, `maxOutputBytes` and `exclusiveTree` enforced by the supervisor calling
  `sandbox.run` directly: the same enforcement the engine applies, in the one place the engine is not running;
- (c) `/merge <slug>` is **redefined** from CD's meaning (propose a merge task) to an alias of `/land <slug>`;
  `docs/COMMANDS.md` and CD §6.5 both say so.

Order: topological over `dependsOn` first (prelude agents first), then by Jev's rank Score (§5.5) descending, then by
slug. Every attempt appends one line to `<runDir>/orchestrate/land.jsonl` (append-only, one writer = the lock holder),
which is what makes the queue resumable and auditable.

### 5.3 The hard rules code enforces, and the one the grafts demoted [G8]

Computed in code from the diff `baseSha..<pinned>`:

| Rule | Computation | On violation |
| --- | --- | --- |
| **tests are not removed or weakened** | for every path matching `orchestrate.testGlobs` (default `['test/**','tests/**','spec/**','**/*_test.*','**/*.test.*','**/test_*.py','**/conftest.py']`): no file deleted, and no net decrease in assertion-shaped lines (`assert`, `expect(`, `should`, `t.Error`, `#[test]`) | **hard fail**, reason `removed 4 assertions in test/unit/store.test.ts` |
| **the collected test count does not drop** | parsed counts from the verification output on the dock head vs after | hard fail with both counts |
| **no `.git`, no submodule, no `secretPaths`, no `syncedIgnored` file committed** | path check over the diff | hard fail |
| **the merge introduces no conflict markers** | grep `^<<<<<<< ` / `^>>>>>>> ` in the merged tree | hard fail |
| **the pinned sha still matches at merge time** [G3] | `rev-parse` re-check | hard fail (`the branch moved during verification`) |
| ~~no write outside `own`~~ → **a land-time question** [G8] | `git diff --name-only baseSha..<pinned>` ∩ complement(`own`) **∖ `Manifest.syncedDirty`** [D2] | **demoted**: `fix-store touched 2 files outside its slice (package-lock.json, dist/x.js) — [a] include them · [d] drop them from the merge · [x] refuse`. `[d]` re-merges with those paths checked out from the dock head; only `[d]`/`[x]` consume a kick |

The demotion is forced by the belt-2 hole of §2.4: with `run` actions uncovered, a formatter or a lockfile regeneration
makes this the **routine** case, and a hard fail there would read as a bug report and burn the single allowed kick.

**[D2] and the `∖ Manifest.syncedDirty` term is what keeps the question rare enough to be worth asking.** §2.6 keeps
untouched carried paths out of the commit, so they are already absent from `baseSha..<pinned>`; the subtraction here
is the belt for the case where the *same* path is both carried and genuinely edited by the agent — the diff then
contains the parent's hunks as well as the agent's, which is correct (the agent built on that work) but must not be
reported to the human as "touched a file outside its slice". It is also what §5.7's pre-flight keys on.

The only route past a real hard fail is `/agent <slug> land --anyway` typed twice, which records a
`RunMeta.overrides[]` entry `{ setting: 'land.hardRule', from: '<rule>', to: 'overridden' }` and prints the rule in the
transcript. **Jev is not consulted, ever, about a hard rule.**

### 5.4 Conflict handling and kicks

A `conflicted` or `failed-verify` agent is *kicked* at most `orchestrate.maxKicks` (default 1) times. A kick **resumes**
the agent (never restarts it — its run dir, plan and window survive) after a code-performed rebase attempt:

```
git -C <agentDir> rebase jevcode/dock-<runId8>
  -> clean:       the kick becomes a plain re-land (no model call at all)
  -> conflicting: git rebase --abort, and the conflict is handed to the agent as a directive
```

**[D8] No fetch, and no unnamespaced branch.** Revision 1 wrote `git -C <agentDir> fetch .
jevcode/dock-<runId8>:refs/heads/dock` first. That mints `refs/heads/dock` — a **repo-global** branch in the shared
common dir, the only name in this design outside the `jevcode/` namespace, and one §2.2 already forbids as a slug
for exactly this reason. In a repo that has a `dock` branch the fetch is a non-fast-forward rejection (the kick
fails quietly and the agent parks with a wrong reason) or, forced, clobbers the user's branch; and two agents kicked
in one delegation contend for the one name. The fetch is also unnecessary: an agent worktree shares the common dir
with the dock worktree, so `jevcode/dock-<runId8>` is already a visible ref there. The rebase names it directly.
`land.test.ts` gains a fixture repo that *has* a `dock` branch and asserts it is untouched across a kick.

The directive rides the existing `EngineOptions.humanDirective` path:

```
landing failed. jevcode/fix-store conflicts with landed agent tui-rows in src/checkpoint/store.ts
(both changed lines 361–383). Rebase your branch on jevcode/dock-a2fee9c1 and resolve it, or change approach.
```

After `maxKicks` the agent is `parked` and the human decides. Every kick is recorded in `land.jsonl` and in the agent's
`RunMeta.overrides[]`.

Conflicts are *expected to be rare and are not auto-resolved by a model*. This matches every cloud coding agent
surveyed — Cursor background agents, Jules and GitHub Copilot's coding agent all isolate into a VM/branch and leave
merge conflicts to git and PR review; none documents automatic conflict resolution.

### 5.5 Jev's second and last request — landing order only

After every agent has finished and its diff exists: one **Score** per agent (≤ 8 questions), 5 levels, *"how much of
the stated task does this diff accomplish"*, the levels written as situations (`src/jev/questions.ts:78` enforces 2–10
situation levels). State per agent: its task (≤ 200), its `own`, its diff **stat** (files, +/− lines) and up to 40 lines
of diff per file for ≤ 4 files — never the whole diff, so the request stays O(1) in the change size. Used for **order
and the `[k] kick` suggestion only**. Code fallback: topological then slug order. `critic: 'off'` skips it entirely.

### 5.6 `critic: 'run'` — an independent verification writer, for repos with no tests

A restricted engine run in a **fresh** worktree at `baseSha`, mode `jev-only` when available, action space
`read | write | run | done`, writes confined by code to `orchestrate.criticWriteGlobs` (default
`['test/**','tests/**','spec/**']`), caps `criticCapUsd` (0.15) / `criticMaxSteps` (4). It is given the **agent's task
and the base tree only — never the worker's diff** (the independence rule). Its output is one command added to that
agent's `verify` set. It is itself an agent row (`role: 'critic'`), pausable and resumable like any other.

### 5.7 The launch — one judged step in the user's checkout, and the pre-flight before it [D1]

Orchestration never writes to the user's checkout outside a judged step. When the queue settles, the parent is resumed
and its **next step** is an ordinary step whose proposal the harness seeds as a `run` action:

```
git merge --no-ff --no-edit <pinned dock sha>
```

with `exclusiveTree`. It goes through `risk` (Scores), the review confirm when the verdict is `review`,
`takePreImages`, `execute`, `takePostImages` and `judge` exactly like any other step. Everything falls out for free:
the transcript, `--json`, the decisions pane and `/diff` all show it.

**[D1] The merge must not be proposed into a checkout that is dirty on the paths it changes.** This is the blocker
the whole [G1] graft created and revision 1 did not see. A JevCode parent is uncommitted **by construction** — that
is [G1]'s own premise — the gate deliberately admits up to 200 dirty entries (§3.1), and §2.3 syncs exactly those
files into every agent worktree. Even after [D2] scopes each agent's commits to what that agent changed, an agent
that legitimately edits a file the parent had left dirty commits the parent's hunks with its own, so the dock's diff
can still touch a path the user has locally modified. `git merge` then aborts, deterministically, with
`Your local changes to the following files would be overwritten by merge` — on **any** real session, and invisibly
to an M1 whose fixture repo is clean.

So the launch is a pre-flight and then one or two judged steps:

```
overlap = statusPorcelain(<workspaceRoot>).paths  ∩  git diff --name-only <baseSha>..<pinned dock sha>
```

`overlap` empty → the merge step is seeded exactly as above, unchanged. `overlap` non-empty → **no merge action is
proposed at all**; `/land` prints the paths and offers three answers, each of which is itself an ordinary judged
step, because §5.2(b)'s narrowing allows the supervisor to write only to the *dock*, never to the user's checkout:

```
/land: 2 of your uncommitted files are also changed by the dock —
  src/tui/Pane.tsx, src/loop/engine.ts
  [c] commit them first as a judged step, then merge   (recommended: the merge becomes an ordinary 3-way and any
                                                        real disagreement surfaces as a conflict you can read)
  [s] stash them as a judged step, then merge          (you get them back with `git stash pop`, which may conflict:
                                                        the dock already carries your hunks for these files)
  [x] cancel                                           (the dock stays; `jevcode agents list` and /diff still work)
```

`[c]` seeds `git add -- <overlap> && git commit -m "wip before landing 3 agents"`; `[s]` seeds
`git stash push -u -- <overlap>`; both then re-run the pre-flight and seed the merge as a second judged step. Both
are `exclusiveTree`, both go through risk/review/images/judge, and both appear in `/undo`. `[c]` is recommended and
is what the prose says, because it is the only one of the three whose result is a merge whose conflicts mean what
they look like.

Two further consequences. `orchestrate.land: 'branch'` never reaches the pre-flight at all, which is a real point in
its favour (§10 Q3). And M1 gains arm **b**: the same scenario with a dirty parent — two files modified in the
checkout, one of them inside an agent's `own` — asserting that the agent branches carry no commit over the
*untouched* dirty file, that the manifest card printed the `dirtyOverlap` warning, and that `/land` offered
`[c]/[s]/[x]` instead of proposing a merge that would have aborted.

`/undo` needs one addition, because a merge commit cannot be undone by restoring images: `UndoSkipReason` gains
`'landed'` (`src/core/types.ts:996`), `RunMeta.landed?: [{ step, branch, commit }]` is recorded, and `/undo` on a landed
step offers `[g] git revert <commit>` — a **new judged step** — instead of an image restore. `/rewind` below the
delegation step is refused via `RunMeta.undoUnavailableBelow` with the reason `4 agents landed at step 12; rewind below
it would leave the branches orphaned`.

`orchestrate.land: 'branch'` stops before this: the transcript reads `verified on jevcode/dock-a2fee9c1 (3 agents, npm
test + npm run typecheck green) — /land merges it here, or merge it yourself`, and nothing touches the checkout. This
is the mode for people who want a PR, and it is what makes the design usable in the cloud-agent style.

---

## 6. Budgets, cost and limits

The in-process `SpendMeter` tree (`src/core/types.ts:731`) cannot span processes, so money is handled as a **reserve
split before anything starts**, plus a per-process hard cap, plus a fold.

### 6.1 The reserve

At the confirm, code computes `reserveUsd = min(sessionRemainingUsd(sessionCapOf(), sessionTotal(), heldUsd()) ×
orchestrate.reserveFraction (0.5), orchestrate.maxReserveUsd (**2.00** — revision 1 used this setting inside the
formula and gave it no value anywhere [D9])) and splits it: `capUsd_i = max(minAgentUsd, reserveUsd × w_i / Σw)` where `w_i` is the
agent's item count. **`w_i` is a code weight; Jev has no say in money.** Every `capUsd_i` is rounded down to the cent so
`Σ capUsd_i ≤ reserveUsd` exactly.

### 6.2 Hold, release, and surviving a crash [G6]

The parent's session meter is debited by `reserveUsd` at spawn through a new `SpendMeter.hold(usd)` / `release(usd)`
pair (additive, two methods, no behaviour change for existing callers: `hold` adds to a `held` field that `exceeded()`
counts; `release` subtracts), plus a `RunMeta.overrides[]` entry and a `budget:override` event. Holding rather than
spending is what makes the reconcile in §6.3 correct.

**[D6] A `held` field the meter counts reserves nothing, because that meter has no cap.** Revision 1's first half
was *"`hold` adds to a `held` field that `exceeded()` counts"*. The session meter is
`createSpendMeter(Number.POSITIVE_INFINITY)` (`src/cli/session.ts:1141`), so `exceeded()` on it can never be true and
is dead code on that object. What actually gates a new run is
`sessionRemainingUsd(sessionCapOf(), sessionTotal())` (`src/tui/budget/lines.ts:184`, called at `session.ts:1985` and
`:2311`), and `sessionTotal()` is `sessionMeter.snapshot().totalUsd` (`session.ts:1270`) — which a new `held` field
does not change. The reserve would have been invisible to the only code path it exists to constrain, and §3.1's money
gate would have read pre-hold remaining.

The fix is one optional parameter, threaded:

```ts
// src/tui/budget/lines.ts:184 — a third OPTIONAL argument, so every existing caller is unchanged
export function sessionRemainingUsd(sessionCapUsd: number, sessionSpentUsd: number, heldUsd = 0): number {
  if (sessionCapUsd === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return finite(sessionCapUsd) - Math.max(0, finite(sessionSpentUsd)) - Math.max(0, finite(heldUsd));
}
```

with `heldUsd()` (= `sessionMeter.snapshot().heldUsd ?? 0`) passed at `session.ts:1985`, `session.ts:2311`, §3.1's
money gate and §6.1's reserve arithmetic. `childCapUsd` (`budget/lines.ts:191`) and `followUpDecision` (`:199`) take
it too, so a follow-up run cannot be started against money three agents are holding. `SpendMeter.hold` / `release`
still exist and still maintain `SpendSnapshot.heldUsd` — they are the *storage*; `sessionRemainingUsd` is the
*enforcement*. Keeping them separate is also what lets `exceeded()` stay untouched, which matters because on a
**run** meter (a real finite cap) `exceeded()` is live and must keep meaning "this run spent its cap", not "this
session is holding money for agents".

**[G6] The hold must survive the supervisor.** `sessionMeter` is an in-memory object rebuilt from the session index
(`src/cli/session.ts:1141` creates it with an infinite cap; `:1270` folds the total), and `SpendMeter.restore`
deliberately drops the cap — its comment at `src/spend/meter.ts:104-111` says "Only the usage is restored: the cap
belongs to this run's configuration". So after a supervisor SIGKILL the adopting session would under-count in-flight
agent spend by up to `reserveUsd` and could start a run the session cap cannot afford. Fix, three parts: add
`heldUsd?: number` to `SpendSnapshot`; have `SpendMeter.restore` re-establish it (it is usage-shaped, not
cap-shaped, so this does not weaken the comment's rule); and have **adoption** (§4.4, row 31) rebuild the holds from
`orchestrate/manifest-*.json` × live `run.lock`s, so an adopted tree of 3 agents re-holds their unspent caps.

### 6.3 The per-process gate and the bounded overshoot

Each child runs with `--spend-cap capUsd_i`, so the existing `checkBudgets` / `spend_cap` path is the enforcement. A
child at its cap stops with `spend_cap`, exit 4, **resumable**, and its row reads `parked at its cap ($0.30) after 7
steps, 2 of 3 items done`.

Worst-case total overshoot is `liveAgents × maxSampleCostUsd` — one model request per live agent, because the cap is a
pre-request gate. This is the same shape Anthropic's Managed Agents budget uses (a hard dollar cap enforced as a
pre-request gate, so "the request that crosses completes" and overshoot is at most one model request per running
thread). The status line shows it as `worst case +$0.06`, so the number is never a surprise.

### 6.4 Every setting and every limit, in one place [G15] [D9]

**[D9] Revision 1's table had 14 rows against 30-odd keys the document references, and `orchestrate.maxReserveUsd`
appeared inside an arithmetic formula (§6.1) with no value anywhere — an implementer could not compute the reserve.**
`orchestrate.verify`, `orchestrate.land` and `orchestrate.incidentalGlobs` had no default either. The table below is
now **one row per key**, with the default, the env variable, the flag where there is one, and the config-table group
— the shape `SETTINGS` already uses (`src/config/defaults.ts:107ff`: `{ name, flag?, env[], fileKey, defaultValue,
secret, description }`). All of them live in the `orchestrate` group of `jevcode config`; all are `secret: false`;
none is a launch setting, so all are re-resolvable mid-session.

| Setting | Default | Env | Flag | Note |
| --- | --- | --- | --- | --- |
| `orchestrate.split` | **`off`** [G21] | `JEVCODE_ORCHESTRATE_SPLIT` | `--split` | `off \| ask \| auto`; `off` prints the one-time hint. §10 Q1 |
| `orchestrate.maxAgents` | 3 | `JEVCODE_ORCHESTRATE_MAX_AGENTS` | `--max-agents` | preference; clamped by `coordination.maxChildren` (CD:826) — **that** is the ceiling [G15] |
| depth | 1 | — | — | a **constant**, not a setting; `coordination.childDepth` must agree |
| `orchestrate.maxSplits` | 2 | `JEVCODE_ORCHESTRATE_MAX_SPLITS` | — | per run; consumed only on a *written* manifest |
| `orchestrate.splitEvery` | 8 | `JEVCODE_ORCHESTRATE_SPLIT_EVERY` | — | committed steps of cooldown between splits |
| `orchestrate.preludeMaxFiles` | 8 | `JEVCODE_ORCHESTRATE_PRELUDE_MAX_FILES` | — | above it the option is deleted (§3.2) |
| `orchestrate.selfContainedFloor` | 0.5 | `JEVCODE_ORCHESTRATE_SELF_CONTAINED_FLOOR` | — | below it an agent is dropped and merged (§3.5) |
| `orchestrate.reserveFraction` | 0.5 | `JEVCODE_ORCHESTRATE_RESERVE_FRACTION` | — | of session remaining **net of holds** [D6] |
| `orchestrate.maxReserveUsd` | **2.00** | `JEVCODE_ORCHESTRATE_MAX_RESERVE_USD` | — | the missing number of [D9]; the reserve is `min(remaining × fraction, this)` |
| `orchestrate.minAgentUsd` | 0.20 | `JEVCODE_ORCHESTRATE_MIN_AGENT_USD` | — | below it, fewer agents; below 2 agents, `no_split` |
| `orchestrate.agentMaxSteps` | 12 | `JEVCODE_ORCHESTRATE_AGENT_MAX_STEPS` | — | per child |
| `orchestrate.agentMaxWall` | 15 min | `JEVCODE_ORCHESTRATE_AGENT_MAX_WALL` | — | `maxWallMs_i = min(this, parentRemainingWall / liveAgents)`, floor 10 min |
| `orchestrate.agentStallMs` | 10 min | `JEVCODE_ORCHESTRATE_AGENT_STALL_MS` | — | §7.1 |
| `orchestrate.onStall` | `notify` | `JEVCODE_ORCHESTRATE_ON_STALL` | — | `notify \| pause \| kick` |
| `orchestrate.maxKicks` | 1 | `JEVCODE_ORCHESTRATE_MAX_KICKS` | — | per agent, per delegation |
| `orchestrate.critic` | `tests` | `JEVCODE_ORCHESTRATE_CRITIC` | — | `tests \| run \| off`; `off` also skips Jev request 2 |
| `orchestrate.criticCapUsd` | 0.15 | `JEVCODE_ORCHESTRATE_CRITIC_CAP_USD` | — | `critic: 'run'` only (§5.6) |
| `orchestrate.criticMaxSteps` | 4 | `JEVCODE_ORCHESTRATE_CRITIC_MAX_STEPS` | — | `critic: 'run'` only |
| `orchestrate.criticWriteGlobs` | `['test/**','tests/**','spec/**']` | `JEVCODE_ORCHESTRATE_CRITIC_WRITE_GLOBS` | — | code-enforced write confinement for the critic |
| `orchestrate.verify` | `[]` | `JEVCODE_ORCHESTRATE_VERIFY` | — | empty = resolve by §5.1's six steps; non-empty wins over all six |
| `orchestrate.verifyRetries` | 0 | `JEVCODE_ORCHESTRATE_VERIFY_RETRIES` | — | the design never auto-retries a test to green (row 41) |
| `orchestrate.testGlobs` | `['test/**','tests/**','spec/**','**/*_test.*','**/*.test.*','**/test_*.py','**/conftest.py']` | `JEVCODE_ORCHESTRATE_TEST_GLOBS` | — | the §5.3 hard rule's scope |
| `orchestrate.land` | **`step`** | `JEVCODE_ORCHESTRATE_LAND` | — | `step \| branch`; `branch` stops at the verified dock and never reaches §5.7's pre-flight. §10 Q3 |
| `orchestrate.incidentalGlobs` | `[]` | `JEVCODE_ORCHESTRATE_INCIDENTAL_GLOBS` | — | empty = always ask (§5.3). §10 Q11 proposes a starter list |
| `orchestrate.agentMode` | `worktree` | `JEVCODE_ORCHESTRATE_AGENT_MODE` | — | `worktree \| copy`; `copy` agents are research-only and never land |
| `orchestrate.agentInclude` | `['.env', '.env.*']` | `JEVCODE_ORCHESTRATE_AGENT_INCLUDE` | — | gitignored files copied per worktree, recorded as `syncedIgnored` |
| `orchestrate.commitIdentity` | `jevcode <jevcode@local>` | `JEVCODE_ORCHESTRATE_COMMIT_IDENTITY` | — | [G1]; §10 Q10 |
| ~~`orchestrate.commitNoVerify`~~ | — | — | — | **deleted in revision 2**: `GIT_BASE_FLAGS` passes `-c core.hooksPath=/dev/null` on every `runGit` call (`src/workspace/git.ts:37`), so no hook can run and `--no-verify` skips nothing |
| `orchestrate.dockCleanExclude` | `['node_modules/','.venv/','target/','.gradle/','.tox/','.mypy_cache/']` | `JEVCODE_ORCHESTRATE_DOCK_CLEAN_EXCLUDE` | — | **new in revision 2** [D14]; unioned with `syncedIgnored` for the post-failure `git clean -fdx` |
| `orchestrate.dockRetentionDays` | 30 | `JEVCODE_ORCHESTRATE_DOCK_RETENTION_DAYS` | — | `agents gc` |
| `orchestrate.notify` | `attention` | `JEVCODE_ORCHESTRATE_NOTIFY` | — | `all \| attention \| off` (§4.6) |
| `orchestrate.agentWaitCeilingMs` | 30 min | `JEVCODE_ORCHESTRATE_AGENT_WAIT_CEILING_MS` | `--no-wait` disables the wait | headless [G12] |
| `orchestrate.agentJsonLineBytes` | 64 KiB | `JEVCODE_ORCHESTRATE_AGENT_JSON_LINE_BYTES` | — | longer lines skipped and counted |
| `orchestrate.agentDeltaHz` | 4/s | `JEVCODE_ORCHESTRATE_AGENT_DELTA_HZ` | — | `generator:delta` rate limit per agent |
| `orchestrate.minFreeBytes` | 2 GiB | `JEVCODE_ORCHESTRATE_MIN_FREE_BYTES` | — | §3.6 pre-flight |
| `orchestrate.agentMemBytes` | 3 GiB | `JEVCODE_ORCHESTRATE_AGENT_MEM_BYTES` | — | §3.6 pre-flight; from the bench's measured 2.9 GB RSS peak |
| `--yes-split` | — | — | `--yes-split` | a flag, not a setting: the headless consent of §3.7, recorded in `RunMeta.overrides` |

Thirty-five rows for thirty-four settings plus the depth constant; `contract.test.ts` gains a case asserting that
every `orchestrate.*` name this document mentions has a `SETTINGS` row, so §6.4 cannot drift out of date again.
Token budgets (`maxGeneratorTokens`) split the same way as money when set. Paused time is excluded from wall exactly
as today.

### 6.5 Mid-flight budget changes

- `/budget session-spend-cap` **lowered** below the held reserve shrinks the reserve by releasing unspawned holds and
  relays a `budget` message to live children, whose hosts apply `meter.setCap`; a child already past the new cap stops
  at its next loop top with `spend_cap` (resumable).
- **Raising** reaches only children already parked at their cap. A raise mid-step is refused as a surprise.
- `/agent <slug> budget +0.20` is the explicit raise: it takes from the parent's remaining session budget, records an
  override, and resumes the parked child.

### 6.6 Cost honesty

`docs/COMMANDS.md` states plainly that multi-agent work costs a multiple of single-agent work: Anthropic measures ~15×
chat tokens for multi-agent research (https://www.anthropic.com/engineering/multi-agent-research-system) and ~7× for
agent teams in plan mode (https://code.claude.com/docs/en/costs). The answer this design gives is not "it is cheap" but
"it is capped before it starts, split by code, reported per agent, and `off` by default until M10 says otherwise
[G21]".

### 6.7 `/cost`

```
/cost → run $0.12 · agents $0.31 (3 runs) · session $0.43/2.00 · held $0.29 · free $1.28
```

`free` is `sessionRemainingUsd(cap, spent, held)` — the number the gate and the follow-up box actually use after
[D6], printed so the arithmetic is checkable by eye: `2.00 − 0.43 − 0.29 = 1.28`. The two paths must agree: the
per-process caps sum to the reserve, and the session fold sums child sessions by `parentSessionId`. M5 asserts both,
and asserts that `free` never counts a released hold twice.

---

## 7. Failure modes and corner cases

### 7.1 The watchdog — stall, loop and progress detection

Unattended workers need a watchdog, and every surveyed system has one: Magentic-One re-plans after ≤ 2 stalls, Claude
Code's `/goal` halts after several tool-less turns and caps idle check-ins at 3, Copilot's coding agent hard-stops at
59 minutes, Gas Town's Witness flags "hooked work with no progress". This one is code, in the supervisor:

| Signal | Computation | `orchestrate.onStall` |
| --- | --- | --- |
| **no step progress** | the heartbeat has shown the same `step` for `agentStallMs` (10 min) while `phase === 'running'` | `notify` (default) / `pause` / `kick` |
| **no file progress** | the last 3 committed steps produced no `changedFiles` and no test-count change | same, with `no files changed in 3 steps` |
| **churn** | the last 3 steps touched the same file with a net diff of 0 lines against 3 steps ago | `kick` with the fact |
| **its own loop detector** | `replan_stop` / `max_replans` (existing) | the agent parks itself; the row says why |
| **wall / steps / spend** | its own `checkBudgets` | parks, resumable, `[+]` |
| **quiet pipe, live heartbeat** | no json line for 2 × `HEARTBEAT_MS` while `isLive` | **not a stall** — the row shows `(quiet)`; never acted on |

Every signal is a **fact on the row and one toast**, never a silent kill. `onStall: 'pause'` is for people who leave the
machine; `'kick'` is for people who want one more try.

### 7.2 Corner-case table (58 rows)

Columns: behaviour · detection · recovery · test. Rows 1–12 decomposition, 13–24 spawn and isolation, 25–34 control
(pause/resume/end/crash), 35–44 critic and landing, 45–52 resource, surface, money and the grafts, **53–58 the
review-pass defects [D1]–[D14]**.

| # | Case | Behaviour | Detection | Recovery | Test |
| --- | --- | --- | --- | --- | --- |
| 1 | two candidate agents both need one shared file (a types module, a barrel export) | the file becomes the `own` of a `prelude` agent every other `dependsOn`, so it lands first; above `preludeMaxFiles` (8) the whole option is **deleted before Jev sees it** | pairwise `own` intersection under glob-prefix containment (normalise rule 3) | the surviving options are ranked; only `no_split` left → no Jev request at all | `normalize.test.ts` prelude + delete |
| 2 | the generator's `as_written` split overlaps, escapes the repo (`../`, `/etc`), or names a submodule / `secretPaths` entry | deleted at normalisation with `reason: 'own escapes the repo: ../x'`; the prose is discarded either way | glob sub-language check (rule 2), `--show-superproject-working-tree`, `secretPaths` | the code enumerators still compete; the manifest shows why `as_written` lost | `globs.test.ts` hostile fixtures |
| 3 | a remaining plan item has no file association at all | merged into the nearest agent by directory, else into the `prelude`; if that would make one agent own the whole repo, the option is deleted | `fileMemory` / evidence lookup empty | coverage rule 4 forces the merge or the delete | `enumerate.test.ts` unassociated item |
| 4 | Jev is unreachable / 401 / times out at `decompose` | `no_split`, one `notice kind:'orchestration' level:'info'`, **no `jev-unreachable` pane** (CD §11 row 33's rule) | decider rejection | the run continues single-threaded; the gate cools down `splitEvery` steps | `decompose.test.ts` decider error |
| 5 | every paired Noul is below the floor | `resolveChoice` → `verdict:'fallback'`, option `no_split`; the manifest records the probabilities | `PAIRED_NOUL_FLOOR` (`choose.ts:10`) | single-threaded; `/split` can force another attempt (one `maxSplits` slot) | `rank.test.ts` floor |
| 6 | Jev picks the escape `none_of_these` | identical to row 5 — the escape is never treated as an instruction | Choice answer | as row 5 | `rank.test.ts` escape |
| 7 | one agent's `is_self_contained` Noul is below `selfContainedFloor` | that agent is dropped and its items merged into the agent owning the nearest directory; below 2 agents → `no_split` | Noul value | the manifest names the dropped agent and the value | `rank.test.ts` drop-one |
| 8 | the `decompose` step is aborted / paused mid-request | rule-1 discard: nothing was written, nothing touched the workspace; `replayable: false` | `!draft.executeStarted` | resume starts a fresh step; a `maxSplits` slot is consumed only by a *written* manifest | `decompose.test.ts` abort |
| 9 | the human declines the manifest confirm | ordinary `declined` outcome; the reason reaches Jev's `recent` and the generator; an `orchestration` harness problem suppresses the gate for `splitEvery` steps | `confirm:resolved { approved: false }` | single-threaded; `/split` re-opens deliberately | `decompose.test.ts` decline |
| 10 | an agent task or an `own` glob contains a secret | never blocked: `detectSecrets` (`redact.ts:429`) flags the manifest, the confirm shows `⚠ secret?`, the human acks (count only) and the task file is written redacted | `detectSecrets` before the confirm | the value never reaches disk, argv, an index line or the json stream | `decompose.test.ts` secret manifest |
| 11 | `--no-input` / pipe / bench / `--json` with `split: 'ask'` | no blocker → the confirm answers `stop` → `no_split`. Headless needs `--split=auto` (research-only) or `--yes-split`, recorded in `RunMeta.overrides[]`. Exit-code contract per §4.9 [G12] | `opts.blocker === undefined` | documented in `--help`; CI gets the explicit flag and reads the converge code, not P9's 4 | `decompose.test.ts` headless; `exit-code.test.ts` |
| 12 | the same manifest would be proposed twice (a resumed run re-opens the gate) | `manifestId` already in `CheckpointState.orchestration` → the gate stays shut and the existing delegation is **adopted** | `manifestId` + `baseSha` compare | `/agents` shows the adopted agents; no second spawn | `manifest.test.ts` idempotence |
| 13 | `git worktree add` fails after the branch was created (ENOSPC, stale registration, existing directory) | facade retries once after `git worktree prune`; still failing → `failed-start`, the branch is deleted **only if it has no commits**, and the delegation continues with survivors; < 2 survivors → abandoned with facts | non-zero exit from the facade | the row reads `failed to start (ENOSPC)`; the manifest records it | `worktree.test.ts` add failure |
| 14 | `git worktree` unsupported, not a repo, unborn HEAD, or a shallow clone with no base | the gate never opens; one notice `agents need a git worktree (git ≥ 2.5) and a committed HEAD` | `GitState` / `rev-parse` probe, cached | `agentMode: 'copy'` for small non-git workspaces (research-only); else single-threaded | `gate.test.ts` non-git |
| 15 | the branch `jevcode/<slug>` already exists | **the slug** gains `-<n>` (never the branch alone [D11]), before `manifestId` is computed, and `branch` is re-derived as `jevcode/<slug>`; an existing branch is **never** force-updated or reset | `git show-ref` at normalise rule 1 | the manifest records the final slug, and `branch === 'jevcode/' + slug` holds for §5.2's `rev-parse` | `worktree.test.ts` branch collision; `normalize.test.ts` asserts the rename precedes `manifestId` |
| 16 | the parent's dirty set is huge (an un-ignored `node_modules`) | untracked entries are dropped from the sync (the `lanes.ts:45` `DIRTY_ENTRIES_MAX` rule); above 200 **tracked** entries the gate is shut with the reason | `statusPorcelain` (`git.ts:163`) count | commit or stash, then `/split` | `worktree.test.ts` dirty cap |
| 17 | the parent has a dirty **binary** file (a fixture `.png`, a `.db`) | copied as **bytes** with its mode preserved [G9] and recorded in `syncedDirty` with its `sha256` [D2]; the `utf8` read of `lanes.ts:171` would have corrupted it, and without [D2] even an uncorrupted copy would have been committed onto every branch by `git add -A` | the lifted `dirtySnapshot` is `Buffer`-based; the sha is what `carried` compares | none needed: the file is `carried`, so no agent commits it unless it changed it | `worktree.test.ts` binary dirty file (sha round-trip); `commit.test.ts` carried-not-committed |
| 18 | an agent proposes an **edit/write/patch** outside its `own` set | code refusal before any write: `outcome = { status:'blocked', reason: "outside this agent's ownership: src/y.ts (owns src/tui/**)" }`, counted, visible to Jev and the generator | `computeTargets` (`risk.ts:537`) ∩ complement(`own`) | 3 in a row → `parked` with `scope-fight`; the row offers `[k] kick with a wider slice` | `ownership.test.ts` |
| 19 | an agent's **`run` command** writes outside `own` (a formatter, codegen, a regenerated lockfile) | **not** blocked — `computeTargets` yields no paths for `run` [G8]. The post-images are diffed against `own`, the paths are recorded in `StepRecord.escaped` and shown on the row, and at land time the human is asked `[a] include · [d] drop · [x] refuse` | post-image diff ∩ complement(`own`) ∖ `Manifest.syncedDirty` [D2] | `[d]` re-merges with those paths taken from the dock head; only `[d]`/`[x]` consume a kick | `ownership.test.ts` run-escape; `land.test.ts` include/drop; `land.test.ts` asserts a 200-entry synced-dirty set produces **zero** escape prompts |
| 20 | an agent tries to spawn its own agents | refused in `createEngine` (`orchestration.depth === 1` shuts the gate; `--agent` with `--split` is a `ConfigError`), not only in the TUI, so a hand-typed `jevcode run --parent …` cannot make grandchildren | `orchestration.depth` | the message names the cap | `engine-orchestration.test.ts` depth |
| 21 | an agent's `--json` pipe floods or backs up | bounded reader: ≤ 64 KiB per line, `generator:delta` rate-limited to `agentDeltaHz` (4/s) and the rest dropped; the agent's own `transcript.log` remains the complete record | line length, a per-agent token bucket | the row's last line may lag ≤ 250 ms; nothing is lost on disk | `supervisor.test.ts` flood |
| 22 | an agent's json line is torn, oversized, or of an unknown type | skipped and counted (`row.skipped`), never parsed into a path or a command | length / `parseJson` / the type switch | `/agents --all` shows `skipped 3`; the run continues | `supervisor.test.ts` hostile lines |
| 23 | the agent process fails to start (ENOENT on `execPath`, EMFILE, EAGAIN) | row `failed-start (<code>)`; the delegation continues with fewer; ≥ half failing → abandoned, reserve released, facts written | spawn error / immediate non-zero exit with no `stream:start` | the §3.6 pre-flight usually prevents it; the human retries with `/split` | `supervisor.test.ts` spawn failure |
| 24 | an agent is a `research` agent (no verification command was found) | read-only action space (`read \| run \| done`, enforced in code **and** in the tool schema), no branch, no worktree write, no land; output is a ≤ 2 KiB facts handoff rendered inside the untrusted-data fence under `## Agents` | `role: 'research'` | its facts reach the parent's next prompt; it can never write code | `role.test.ts`, `prompts-agents.test.ts` |
| 25 | `pause` on a delegating parent (already stopped at P9) | there is no parent process to pause; `Esc` opens `[y] tree · [Y] tree now · [t] this run only · [n] stay`, and the status says which scope is acting | `state.orchestration` present, no live parent run | `pause tree` sends N messages and reports acks; nothing waits | `pause-tree.test.ts` |
| 26 | `pause now` on an agent mid-`execute` | never killed (CD P4): the command runs to its own end or `commandTimeoutMs`, post-images are taken, the judge is skipped, the step commits with `interruptedAt: { stage:'judge', reason:'human_pause' }` | `currentStage === 'execute'` | the row reads `execute finishes first (12 s) — Esc Esc aborts`; a true kill is `abort` | `engine-pause-now.test.ts` agent |
| 27 | an agent hits a blocking pane (`jev-unreachable`, `key-rejected`, `spend-limit`, `checkpoint-degraded`, `sandbox-unavailable`) | its **parking blocker** answers `'pause'` → `human_pause`, exit 4, resumable; the row reads `parked (spend-limit)`. Without [G7] this would have been `'stop'`, because `awaitBlocker` defaults to `'stop'` with no blocker (`engine.ts:1189`) and `session.ts:2030`/`:2354` install one only when interactive | `BlockingRequest` in a child | `[r]` resumes; the pane condition is re-raised if it still holds | `engine-blocker.test.ts`: `--agent b --no-input` + `spend-limit` → exit 4, resumable (§2.5's named test now matches this row [D12]) |
| 28 | an agent's risk verdict is `review` | parks at **P10**: the request is written to `<childRunDir>/orchestrate/review-<n>.json`, the draft is cached, the step is a rule-1 discard; the parent's TUI opens the **real** review card with `ConfirmRequest.badge = 'agent <slug>'` [G2] | `verdict === 'review'` in a child | the answer file is written by the parent's process, id-matched, single-use, renamed `.used`; the agent resumes with `jevcode run --resume <childRunId> --agent <slug>` (`src/cli/args.ts:241`), and CD §7.2's existing replay of `cache/step-<n>.json` re-asks the confirm, which the answer file consumes. **There is no `--replay` flag** [D12] | `agent-review.test.ts` |
| 29 | a review answer file is missing, stale, id-mismatched, or written twice | the parking confirmer parks again with `reason: 'answer not for this request'`; a consumed answer is renamed so a replay cannot reuse it | id + single-use rename | the human is asked again; nothing is auto-approved or auto-denied | `agent-review.test.ts` mismatch |
| 30 | an agent is SIGKILLed | no handler runs: `run.lock` keeps a dead pid, the heartbeat stops, the step is uncommitted, and a `run` in flight keeps running to its own end in the sandbox. **After [G1] its earlier steps are real commits**, so its branch holds everything up to the last committed step | `isPidAlive` false (`lock.ts:27`) + `startedAt >= bootAt` for pid reuse | the row reads `crashed at step n (execute)`; where `pre/<n>/` exists the row lists files whose sha differs; `[r]` resumes, and the branch is landable as-is | `agent-crash.test.ts` |
| 31 | the supervisor is SIGKILLed with agents live | agents keep running — their state is entirely on disk; none is orphaned in memory | a dead session pid + live agent heartbeats/locks | the next session **adopts** them within one poll (15 s) and **rebuilds the spend holds** from the manifest × live locks [G6]; the asserted invariant is that no agent is spawned twice | `adoption.test.ts` (incl. `heldUsd` restored) |
| 32 | a clean `/exit` with agents live | the gate `3 agents live: [k] keep them running (they keep spending) · [e] end them · [n] stay`; `[k]` detaches them (independent processes) and records the delegation so the next session adopts them; `[e]` sends `end` and waits ≤ 5 s | `host.exit` with live rows | `[k]` is the documented money risk and the row says so | `exit-gate.test.ts` |
| 33 | `Esc Esc` (abort) with agents live | asks `abort 3 agents too? [y] all · [t] this run only · [n] cancel`; **abort always needs the local `[y]`** — no relayed abort is ever honoured | live rows + an abort request | `[y]` sends `abort`, applied locally by each host; exit 130 each, resumable | `abort-tree.test.ts` |
| 34 | two devices resume the same parent | CD's fork rule (lower Lamport stamp holds; the loser stops at its loop top with exit 2 and keeps its tail). Worktrees are device-local paths, so the winner's agents are the **branches** — a cross-device resume recreates worktrees from `jevcode/<slug>` | the fold: two heartbeats for one `runId` | the card names the device; `/agents` on the loser shows `agents are on <label>` | `engine-takeover.test.ts` + `adoption.test.ts` cross-device |
| 35 | the parent's HEAD moves while agents run | the dock is rebased onto the new HEAD before the first land; agents whose `own` files changed get the fact at their next step; a conflicting rebase parks the delegation | `headMoved` + per-file sha compare | the card offers `[r] rebase all · [s] stage on the old base · [f] forget` | `land.test.ts` base moved |
| 36 | an agent's worktree is dirty at `run:end` | **After [G1] this is the crash case, not the default** — and "dirty" means dirty **outside `carried ∪ syncedIgnored`** [D2], since the carried set is dirty in every healthy agent worktree for the whole run: the harness commits at every committed step and once more at `run:end`, so `addSet ≠ ∅` at end means the process died between the step commit and the git commit. Nothing is committed on its behalf after death; the worktree is listed | `statusPorcelain` in the agent dir after the process is gone, minus `carried` (sha-compared) and minus `syncedIgnored` | `[c] commit its worktree as-is and land` (a recorded human act), or `[x] drop` which keeps the dirty worktree | `land.test.ts` dirty agent; `commit.test.ts` end-commit + carried-is-not-dirty |
| 37 | an agent's branch has **zero** commits | it genuinely decided there was nothing to do (`done` at step 2 with no `executed` outcomes). Lands trivially as a no-op; the manifest records `nothing to change`. **Without [G1] this would have been every agent**, silently | `rev-list --count <base>..<pinned> === 0` **and** a clean worktree | its plan items move to the parent's `done` with the agent's evidence | `land.test.ts` empty agent; `commit.test.ts` asserts a working agent is never empty |
| 38 | a land conflicts | `git merge --abort`, state `conflicted`, conflicting paths + hunk ranges recorded; a code-attempted `git rebase dock` runs first and a clean rebase turns it into a plain re-land | merge exit + `--name-only --diff-filter=U` | one kick with the conflict facts; after `maxKicks` the agent parks and the human decides | `land.test.ts` conflict + kick |
| 39 | verification fails after a clean merge | `git reset --hard <previousDockHead>` **then `git clean -fdx -e <syncedIgnored> -e <dockCleanExclude>`** [D14], state `failed-verify`, the failing command and ≤ 40 lines of tail recorded. `reset --hard` alone leaves the untracked `dist/`, `.pytest_cache`, coverage and `*.tsbuildinfo` the verify commands just wrote, and the next agent's `git merge` can itself refuse on an untracked file it would overwrite | command exit ≠ 0; then `statusPorcelain --untracked-files=all` in the dock must list nothing outside the two exclusion sets | kick with the tail, or `[x] drop`; the dock never keeps a failing merge **and never keeps its debris** | `land.test.ts` verify failure; `land.test.ts` dock-clean invariant (a verify command that writes `dist/x.js` and an `.env` that survives) |
| 40 | the diff deletes tests or drops the collected count | **hard fail**, never overridable by Jev; the reason names the file and the assertion delta | `testGlobs` diff analysis + parsed counts before/after | only `/agent <slug> land --anyway` twice, recorded in `RunMeta.overrides[]` and printed | `critic.test.ts` test deletion (property) |
| 41 | verification is flaky | each command runs once; a failure is recorded with its tail. A `flaky?` flag is *reported* (not acted on) when the same command passed on the dock head and the merge touched no file the test reads; `orchestrate.verifyRetries` (0) can raise it | pass/fail history per command per dock head | the human retries with `/agent <slug> land`; the design never auto-retries a test to green | `critic.test.ts` flaky flag |
| 42 | all agents fail to land | a **fact, not a stop**: the parent resumes with an `orchestration` harness problem (`3 agents, 0 landed: 2 conflicts, 1 verify failure`) and continues single-threaded; `maxSplits` prevents retrying forever; every dollar is recorded | `orchestration:settled` with empty `landed` | `/agents` keeps the rows and branches for inspection; `agents gc` cleans up later | `land.test.ts` total failure |
| 43 | `/agent <slug> land` races the supervisor's own land | the second refuses, naming the holder: `orchestrate/land.lock` is O_EXCL with pid liveness (`acquireRunLock`, `lock.ts:91`) | EEXIST + a live pid | it retries after the queue step; `land.jsonl` has one writer by construction | `land.test.ts` lock |
| 44 | `/undo` or `/rewind` across a land | a merge commit cannot be restored from images: `UndoSkipReason 'landed'`; `/undo <landStep>` offers `[g] git revert <commit>` as a new judged step; `/rewind` below the delegation step is refused via `RunMeta.undoUnavailableBelow` | `RunMeta.landed[]` | the revert is an ordinary judged step (risk, review, images, transcript) | `undo-land.test.ts` |
| 45 | disk / memory / fd exhaustion from N worktrees | the §3.6 pre-flight refuses or reduces **before any worktree exists**; ENOSPC mid-run is a `failed-start` or a parked agent, never a corrupt dock | `statfs`, `os.freemem`, `availableParallelism`, `getrlimit` | fewer agents with the reason in the manifest; < 2 → `no_split` | `preflight.test.ts` |
| 46 | an agent stalls (same step 10 min, or no files changed in 3 steps, or zero-net churn) | flagged `stalled` with the exact fact; `onStall` decides `notify` (default) / `pause` / `kick`. A quiet pipe with a live heartbeat is **not** a stall | heartbeat `step` age, `changedFiles` history, diff-vs-3-steps-ago | `[p] · [k] · [x]`; the hard wall and step caps bound it regardless | `stall.test.ts` (fake clock) |
| 47 | an agent hits its spend, wall, step or token cap | stops with `spend_cap` / `wall_time` / `max_steps` / `token_cap`, exit 4, **resumable**; row `parked at its cap ($0.30) after 7 steps, 2 of 3 items done` | its own `checkBudgets` | `[+]` gives it more from the parent's remaining session budget (recorded override) and resumes it; `[l]` lands what it has; `[k]`; `[x]` | `budget-agent.test.ts` |
| 48 | `/budget session-spend-cap` changed while agents run | lowering releases unspawned holds and relays `budget`; a child past the new cap stops at its next loop top (resumable). Raising reaches only children already parked at their cap | the pending-settings path + the relay | the report names which agents were lowered and which were left alone | `budget-agent.test.ts` relay |
| 49 | the agents tab with many agents, 40 columns, `--ascii`, a screen reader | one pure function produces every row for Ink, `--plain`, the screen-reader twin and `jevcode agents list`; columns drop widest-first; **no row is hidden while the agent exists** and rows never collapse into "N idle agents"; above 12 the tab scrolls | `stringWidth`, `glyphSet` | `/agents` prints the full table regardless of terminal size; `agents list --json` is the machine form | `agents-lines.test.ts`, `test/pty/agents.steps` |
| 50 | an agent message tries to widen rights (a forged `steer`, a `pause` from a stranger, a relayed approval, a `budget` raise) | refused: the child's host honours a relay only when `msg.from.sessionId === RunMeta.agent.parentSessionId` on the same device and user; `abort` always needs the local `[y]`; a review answer is a **file in the parent's own run dir**, not a message; a raise is honoured only at the cap; peer/worker text reaches the generator only inside the untrusted-data fence; the seatbelt read-denies `orchestrate/**`, `coordination/**` and every other run dir. There is **no file-mailbox fallback** [G5] | `parentSessionId` check, `remoteControl`, the seatbelt profile | the refusal acks with `detail60` and shows in both transcripts | `mailbox.test.ts` agent relay; `seatbelt.test.ts` read-deny; `prompts-agents.test.ts` fence |
| 51 | a sibling's sandboxed command rewrites a branch ref between verify and merge | **refused twice** [G3]: the queue verifies and merges a **pinned sha** and re-checks `rev-parse` before the merge (`the branch moved during verification`), and the child seatbelt denies `<commonDir>/refs/**`, `packed-refs`, `logs/**` and `worktrees/*/HEAD` — which HEAD's profile does not, since it adds `commonDir` to the writable roots and denies only `config`/`hooks`/`config.worktree`/`modules/*` | the `rev-parse` re-check; the deny list | the agent is `failed-verify` with the rule name; the dock is untouched | `land.test.ts` ref-moved (property); `seatbelt.test.ts` refs deny |
| 52 | `/why s11.decompose.which_split`, Ctrl+O, the timeline strip and the status line after a new stage | all four work, because [G13] assigns the plumbing: `src/tui/why.ts:56` (the `STAGES` set that makes `parseWhyRef` return `null`), `:259` (the order array in `stepWhyBlocks`), `src/tui/pane/timeline.ts:17` (`TIMELINE_STAGES` needs a letter — `D`), `src/tui/commands/registry.ts` (the `/why` arg values) and `src/tui/status/lines.ts`. Unassigned, `/why` would not parse and Ctrl+O would silently omit the block — for the one decision that spawns three processes and holds $0.90 | `contract-stages.test.ts` asserts, **per table and with an explicit exclusion set** [D3], that every `StageName` member is present: `STAGES` and `stepWhyBlocks` exclude nothing, `STEP_WORDS` excludes nothing, `TIMELINE_STAGES` excludes exactly `TIMELINE_EXCLUDED_STAGES`. `/why`'s registry row takes a free-form `rest` arg (`registry.ts:271-273`), so there is no fifth table there and none is invented | none needed; the guard fails CI instead | `why.test.ts` decompose ref; `contract-stages.test.ts` [G14] [D3] |
| 53 | **the parent's working tree is dirty at `/land` and the dock changes some of the same files** — the normal case, and the one revision 1 could not execute [D1] | **no merge action is proposed**: `/land` prints the overlap and offers `[c] commit them first as a judged step · [s] stash them as a judged step · [x] cancel`, each of which is itself a judged step; only after the overlap is empty is `git merge --no-ff --no-edit <pinned dock sha>` seeded. Without this, `git merge` aborts with `Your local changes to the following files would be overwritten by merge`, deterministically, on any real session | `statusPorcelain(<workspaceRoot>).paths ∩ git diff --name-only <baseSha>..<pinned dock sha>` at launch time | `[c]` (recommended) makes the merge an ordinary 3-way; `[s]` warns that the dock already carries those hunks; `[x]` leaves the dock intact and inspectable | `land.test.ts` dirty-checkout pre-flight (all three answers); **M1 arm b** (a dirty fixture parent end to end) |
| 54 | the parent's dirty file is **inside** an agent's `own`, and that agent edits it | legitimate and allowed: the agent starts from the parent's content (that is what `dirtySync` is for), its commit carries both sets of hunks (the blob is whole), the path leaves `carried` at the first sha mismatch [D2], and it is recorded in `Manifest.dirtyOverlap` so the manifest card warns about it **before** any money is spent (§3.7) and row 53's pre-flight asks about it at land time | sha256 mismatch against the `syncedDirty` entry | none needed; the human was told twice, at the confirm and at the launch | `commit.test.ts` carried-then-edited; `decompose.test.ts` `dirtyOverlap` on the card |
| 55 | 200 dirty entries in the parent, three agents, none of which touches any of them | **zero** of those paths appear in any `baseSha..<branch>` diff, so no escape prompt fires, no two agents' diffs intersect, and the second merge cannot conflict on them [D2]. Revision 1's `git add -A` would have put all 200 on all three branches | `commit.test.ts` compares `git diff --name-only <base>..<branch>` against `Manifest.syncedDirty` for every agent | none needed — this is the invariant, not a recovery | `commit.test.ts` synced-dirty exclusion (property, 50 generated dirty sets) |
| 56 | the supervisor needs to run `git commit`, `git merge` and the repo's test command outside any engine step | it runs them through **one `Sandbox` per worktree**, built from the parent's resolved profile (`workspaceRoot` = that worktree, `runDir` = that run dir, `profile` = the parent's level, never `'off'`), with `commandTimeoutMs`, tree-kill, `maxOutputBytes` and `exclusiveTree` [D10]. The [G3] `refs/**` deny is keyed strictly on `orchestration.depth === 1`, so the depth-0 supervisor can still move `refs/heads/jevcode/<slug>` — if it could not, the landing layer would be inert a second time | `createSandbox` is called once per worktree and the handle is held for its life; a missing handle is a harness bug, not a fallback | none: a sandbox that cannot be built is a `failed-start` for that agent, or a refusal to open the dock, with the reason printed | `seatbelt.test.ts` supervisor profile (depth-0 may write refs, depth-1 may not); `land.test.ts` verify runs sandboxed |
| 57 | the pane cycle with and without a delegation, and the two next-tab titles | `cycleTab(tab, dir, tabs = PANE_TABS)` takes the tab list as a defaulted third argument and all three callers (`App.tsx:1419`, `model.ts:356`, `:476`) pass `paneTabsFor(hasDelegation)`, so `]` never lands on an empty `a` tab and never changes behaviour between runs; the `paneNext`/`panePrev` titles are the one dynamic pair in the registry [D7] | the default argument keeps `model.test.ts:165-167` passing untouched; a `bindings.test.ts` case asserts both titles name `a` | `/panel a` and `Alt+A` still open the tab directly and print `no agents in this session` | `model.test.ts` cycle with and without `a`; `bindings.test.ts` dynamic titles |
| 58 | a repo that already has a branch called `dock` | untouched: the kick rebases `jevcode/dock-<runId8>` directly from the agent worktree, which shares the common dir, so no ref is ever created outside the `jevcode/` namespace [D8]. Revision 1's `fetch . …:refs/heads/dock` would have been rejected non-fast-forward (a silent kick failure) or, forced, would have clobbered the user's branch, with two kicked agents contending for the one name | `git show-ref` in the fixture asserts `refs/heads/dock` is byte-identical before and after a kick | none needed | `land.test.ts` kick with a pre-existing `dock` branch |

### 7.3 Security, as ten standing rules

1. **No laundering, in either direction.** A child's message can never widen the parent's rights and the parent's relay
   can never widen a child's (§4.4).
2. **Keys never cross.** Not in argv, not in env beyond what the child's own config chain resolves, not in the seed.
   The child's `redact()` and `secretPaths` are identical **by construction** (same config file).
3. **Argv is public.** The task, the review answer and the seed travel as 0600 files under the parent's run dir; argv
   carries only ids, paths, caps and globs.
4. **The sandbox cannot see or forge any of it.** `~/.jevcode/coordination/**`, `<parentRunDir>/orchestrate/**` and
   every other run's directory are read-denied in the seatbelt profile, and `<commonDir>/refs/**` and friends are now
   write-denied **for children** [G3]. "For children" is load-bearing and is keyed on `orchestration.depth === 1`
   [D10]: the supervisor's own per-worktree sandbox (§5.2) is depth 0 and *must* be able to move
   `refs/heads/jevcode/<slug>`, or [G1]'s commit cannot happen. It is still a real sandbox — the parent's resolved
   profile, the worktree as its only writable root — never `profile: 'off'`.
5. **Peer and worker text is data.** A child's handoff, a research agent's facts, a conflict tail and a verification
   tail reach the parent's generator only inside CD §5.4's fenced block, after `sanitizeStream` and a one-line clip, in
   a `## Agents` section bounded to 8 × 300 chars. Nothing from a child ever becomes a `harnessProblem` — those mutate
   the plan and are re-armed on resume — except the single code-authored `orchestration` problem the parent writes
   itself.
6. **Nothing from a record is executed or path-joined.** Slugs, globs, shas, branch names and paths are regex- and
   containment-validated before any git command; every git invocation goes through `runGit` (`src/workspace/git.ts:70`)
   as an **argv array**, never a shell string built from a record. (Where a command must be rendered for display,
   `shellQuote` is `src/workspace/git.ts:50` — the winner cited `src/synth/verify/text.ts` [G19].)
7. **No new network surface.** No listener, no port, no daemon, no mDNS. Agents are child processes and files.
8. **`jevcode:` is the only lock reason we ever release**, and only when the owning heartbeat is dead on this device. A
   user's own `git worktree lock` is never touched.
9. **Hard rules are not negotiable by a model.** §5.3's rules are code; the only override is a human typing `--anyway`
   twice, and it is recorded.
10. **Refusals are loud.** Every refusal here — an overlapping split, a bad glob, a missing verification set, an
    insufficient resource, a hard-rule violation, a depth > 1 spawn, a live-agent resume, a moved ref — prints the
    reason and the fix line. None is silent.

---

## 8. Owner split and implementation plan

### 8.1 Who owns what

| Owner | Code | On disk |
| --- | --- | --- |
| **harness** | `src/orchestrate/**` (new): `split/{gate,enumerate,normalize,globs,questions,rank}.ts`, `canonical.ts` (the one canonical form behind both `manifestId` and the checksum — added 2026-09-22 so adoption cannot silently re-spawn), `manifest.ts`, `worktree.ts`, `commit.ts` [G1], `verify.ts`, `critic.ts`, `land.ts`, `preflight.ts`, `stall.ts`, `index.ts` (the one facade the surface imports); `src/loop/stages/decompose.ts`; `src/loop/engine.ts` (gate, stage, P9/P10, `own` refusal, `orchestration` options, events); `src/loop/stages/risk.ts` (the ownership filter); `src/checkpoint/store.ts` (`writeCache`, the `orchestrate/` dir); `src/core/types.ts` (additive, contract 1.5); `src/core/limits.ts`; `src/provider/prompts.ts` (`propose_split` + the `## Agents` section); `src/sandbox/seatbelt.ts` (the child deny list [G3]); `src/coordination/**` (the new `MessageType`s, `Lease.type 'agent'`); `src/synth/sieve/lanes.ts` (extract a binary-safe `dirtySnapshot` [G9]); `src/spend/meter.ts` (`hold`/`release` + `heldUsd` in `restore` [G6]); `src/bench/**` (the `split-on` arm) | `<runDir>/orchestrate/{manifest-<n>.json, agent-<slug>.task, agent-<slug>.seed.json, review-<n>.json, land.jsonl, land.lock}`; the worktrees and metadata **through CD's facade** [G16] |
| **TUI session** | `src/cli/session.ts` — **the `AgentSupervisor`** (one `Sandbox` per worktree [D10], spawn, bounded json reader, row fold, reaper, landing-queue driver, parent resume, the `[k]/[e]/[n]` exit gate, adoption, the parking blocker [G7]); `src/cli/agents.ts`; `src/cli/args.ts`; `src/tui/pane/agents.ts` + `model.ts` (`PaneTab 'a'`, `TAB_TITLE.a`, and `cycleTab`'s third argument [G20] [D7]); `src/tui/agents/lines.ts`; `src/tui/Pane.tsx`, `StatusLine.tsx`, `status/lines.ts`, `toasts.ts`; `src/tui/plain.ts` + `review/lines.ts` + `Review.tsx` (`ConfirmRequest.title`/`headline`/`body`/`badge` [G2] [D4] [D5]); `src/tui/budget/lines.ts` (`sessionRemainingUsd`'s third argument [D6]); `src/tui/why.ts`, `pane/timeline.ts` [G13]; `src/tui/keys/bindings.ts` (+ the `agents` `KeyContext`); `src/tui/commands/{registry,dispatch,parse}.ts`; `src/tui/useEngine.tsx`; `src/session/index.ts` (`agent:start`/`agent:end`/`land` kinds, `run:start.parentSessionId`, the child fold); `src/session/picker-lines.ts`; `src/session/seed.ts`; `src/config/**` (the `orchestrate.*` schema); `src/chat/{facts,replies}.ts`; `docs/{COMMANDS,KEYS}.md`; `test/pty/**` | `~/.jevcode/sessions/index.jsonl`, `<runDir>/ui.json` |

Rules. (1) `src/orchestrate/**` imports nothing from `src/tui/**`, `src/cli/**`, `src/session/**` or `src/config/**` —
it takes `home`, clocks, `sandbox.run`, the ledger handle and the identity as arguments, so it is unit-testable over a
temp repo. (2) The surface imports it only through `src/orchestrate/index.ts`. (3) The supervisor lives in the
controller, not the renderer, so `--plain`, `--json` and one-shot get it too.

### 8.2 Waves — harness

Prerequisite: **CD W0–W3 land first** (`Engine.pause(opts)`, `PausePoint`, `AbortError('human_pause')`,
`BlockingAnswer 'pause'` + `blockWaker`, `CheckpointStore.writeCache`, `run:start.parentSessionId`, and the §12.0.4
write facade incl. `createWorktree`/`removeWorktree`/`sweep`). D0 rebases its `types.ts` edits onto the commit that
lands CD's `// contract 1.4` line and never edits above it. Each wave lands only when `npm run typecheck` (tsc + the
no-`any` check) and the named tests are green. LOC are new/changed lines **excluding** tests; tests are roughly equal.

**D0 — contract, limits, bounds (½ day) — lands first, alone**

| # | File | Change | LOC |
| --- | --- | --- | --- |
| 1 | `src/core/types.ts` | the `// contract 1.5` header after CD's 1.4 line, then every item of §4.1 — including `EngineSeed.siblings?` and `StepTiming.decomposeMs?`, which revision 1's list omitted although §2.6 and item 15 both depend on them [D13] | ~210 |
| 2 | `src/core/limits.ts` | `MANIFEST_BYTES` 32 KiB, `AGENT_TASK_CHARS` 2,000, `OWN_GLOBS_MAX` 32, `OWN_GLOB_CHARS` 200, `PRELUDE_FILES_MAX` 8, `VERIFY_COMMANDS_MAX` 4, `VERIFY_TAIL_LINES` 40, `AGENT_TAIL_LINES` 8, `AGENT_JSON_LINE_BYTES` 64 KiB, `DEPENDS_DEPTH_MAX` 2, `ORCHESTRATION_DEPTH_MAX` 1, `AGENTS_PROMPT_ITEMS` 8 × 300, `LAND_LOG_LINE_BYTES` 1 KiB | ~30 |
| 3 | `src/spend/meter.ts`, `src/tui/budget/lines.ts` | `hold` / `release` + `heldUsd` in the snapshot, restored by `restore` [G6]; **`sessionRemainingUsd(cap, spent, heldUsd = 0)`** and the `childCapUsd` / `followUpDecision` pass-through — the half of the reserve that actually enforces anything [D6] | ~50 |
| 4 | `src/checkpoint/store.ts` | the `orchestrate/` directory; `writeCache` accepts `orchestrate/*` relative paths (bounded, redacted, per-file chain) | ~15 |
| 5 | `test/unit/core/contract.test.ts` | the `1.5` header-order case; byte-identity for `Action`, `STOP_REASON_SET`, `exitCodeFor`, `MODES`, `CheckpointEnvelope.version` | tests |
| 6 | **`test/unit/core/contract-stages.test.ts`** (new) [G14] [D3] | **the guard, restated per table with explicit exclusions** — see below | tests |
| 6b | `src/tui/why.ts`, `src/tui/status/lines.ts` | the three one-word additions the guard needs on day one: `'decompose'` into `STAGES` (`why.ts:56`), into `stepWhyBlocks`'s order array (`:259`) and into `STEP_WORDS` (`status/lines.ts:159`). Moved into D0 from [G13] so D0's gate is reachable [D3] | ~3 |

**[D3] The generic guard, as it can actually be written.** Revision 1 specified it as *"every `StageName` appears in
all five TUI stage tables and in `defaultTab`"*, which is false at HEAD and cannot be made true: `TIMELINE_STAGES`
(`src/tui/pane/timeline.ts:17`) holds **6 of the 8** members and its own doc comment says so — "The six lettered
stages of the strip" — `replan` and `complete` being deliberately absent; `defaultTab` (`pane/model.ts:313`) is
`mode === 'jev-only' && stage === 'propose' ? 's' : 'd'`, a two-condition expression that nothing can "appear in";
and `/why`'s registry row takes a free-form `rest` argument (`registry.ts:271-273`), so the "registry arg values"
table does not exist. The test would have failed at HEAD, before `decompose` was added, making D0's gate — and
therefore "D0 lands first, alone" — unreachable. The guard is therefore four tables, each with its own asserted
exclusion set:

| Table | Rule |
| --- | --- |
| `STAGES` (`why.ts:56`) | ⊇ every `StageName`; exclusion set **empty**, asserted |
| `stepWhyBlocks`'s `order` (`why.ts:259`) | **equals** every `StageName`, in loop order; exclusion set empty |
| `STEP_WORDS` (`status/lines.ts:159`) | ⊇ every `StageName`; exclusion set empty (it already holds all 8 at HEAD — the one table the guard works on unchanged) |
| `TIMELINE_STAGES` (`timeline.ts:17`) | its stages **plus** a new exported `TIMELINE_EXCLUDED_STAGES` partition `StageName` exactly. At D0 that constant is `{replan, complete, decompose}`; §8.3 item 31 lands the `D` letter and narrows it to `{replan, complete}` in the same commit |

`defaultTab` is dropped from the guard. `replan`'s and `complete`'s absence from the strip is a **pre-existing**
choice the guard now documents in one named constant instead of tolerating silently; whether the strip should grow
`R`/`✓` letters is a separate question this design does not answer.

**On `decompose`'s letter.** §8.3 item 31 gives it `D` and this revision keeps that, because the strip exists to show
where a step's time went and `decompose` is the most expensive optional stage in the loop (a Jev request and a
generator call). The contradiction the review noted — "the strip's loop order" against a stage that runs at most
twice a run — is resolved the same way `replan` resolves it for the letter strip's *sizing*: a stage absent from a
step contributes zero cells and no letter. The rule is written into `timeline.ts`'s doc comment, which stops saying
"six".

Gate: typecheck clean; both contract tests green **at HEAD before any behaviour change** (this is the point of the
exclusion sets); **no behaviour change** (nothing reads the new fields yet).

**D1 — the planner (2½ days)**

| # | File | Change | LOC |
| --- | --- | --- | --- |
| 7 | `src/orchestrate/split/globs.ts` | the `own` sub-language: parse, validate, match, prefix-collapse, pairwise disjointness under prefix containment, case-fold only on a folding volume | ~140 |
| 8 | `src/orchestrate/split/gate.ts` | `splitGate(input)` — the pure all-of/one-of predicate of §3.1 with a typed `GateReason`; zero I/O | ~110 |
| 9 | `src/orchestrate/split/enumerate.ts` | the five enumerators + the prelude rule | ~260 |
| 10 | `src/orchestrate/split/normalize.ts` | the nine rejection rules in order (incl. the [G11] task/own cross-check and the [G15] clamp), `manifestId`, per-agent cap arithmetic, the `research` downgrade | ~230 |
| 11 | `src/orchestrate/verify.ts` | the six-step verification-set resolution | ~150 |
| 12 | `src/orchestrate/split/questions.ts` | the bounded state builder + the Choice + paired Nouls + self-contained Nouls, via `src/jev/questions.ts` builders | ~180 |
| 13 | `src/orchestrate/split/rank.ts` | `rankSplits` over `resolveChoice` + `annotateChoiceRows`, `fallback: 'no_split'`, the drop rule, every fallback of §3.5 | ~120 |
| 14 | `src/orchestrate/manifest.ts` | canonical form, checksum, write/read under `<runDir>/orchestrate/`, bounded + redacted parse returning `{ ok:false, reason }` | ~120 |
| 15 | `src/loop/stages/decompose.ts` + `src/loop/engine.ts` + `src/provider/prompts.ts` | the stage; the call site before `replan`/`intent`; the manifest confirm through the existing `Confirmer` with `title`/`headline`/`body`/`badge` and the exactly-specified synthetic `proposal`/`risk` [G2] [D4] [D5]; `StepTiming.decomposeMs?` [D13]; **P9**; `CheckpointState.orchestration`/`.splits`; the `orchestration` harness problem; the `propose_split` tool and its bounded prompt section | ~380 |
| 16 | `src/orchestrate/index.ts` | the single facade | ~30 |

Gate: `gate`, `globs`, `enumerate`, `normalize`, `rank`, `manifest`, `decompose`, `verify` tests; **M2** (zero cost when
shut; zero Jev requests when only `no_split` survives).

**D2 — isolation, the commit, the child engine (2 days)**

| # | File | Change | LOC |
| --- | --- | --- | --- |
| 17 | `src/orchestrate/worktree.ts` | the thin adapter over CD's `createWorktree`/`removeWorktree` [G16] + the **binary-safe** `dirtySnapshot` lifted from `lanes.ts` [G9], now also returning `syncedDirty: { path, sha256, mode }[]` [D2] + a real clean probe for the sweep that subtracts `carried ∪ syncedIgnored` [G10] [D2] | ~210 |
| 18 | **`src/orchestrate/commit.ts`** [G1] [D2] [D10] | the **`addSet` computation** (`touched`, `dirtyNow`, sha-compared `carried`, 256-path chunking, `--literal-pathspecs`) and commit-after-step / commit-at-end through `runGit` with the neutralising flags and the supervisor's per-worktree `Sandbox`; `StepRecord.commit`; the `reset --soft HEAD~1` used by `drop --uncommit` | ~190 |
| 19 | `src/loop/engine.ts` + `src/loop/stages/risk.ts` | the child differences of §2.5: `own` refusal in `computeTargets`, the `research` action space, the parking confirmer, **P10**, the post-`run` escape diff [G8], depth refusal | ~260 |
| 20 | `src/sandbox/seatbelt.ts` [G3] | the child deny list: `<commonDir>/refs/**`, `packed-refs`, `logs/**`, `worktrees/*/HEAD` when `orchestration.depth === 1` | ~40 |
| 21 | `src/orchestrate/preflight.ts` | §3.6 | ~110 |

Gate: `worktree` (incl. the binary round-trip), `commit` (a working agent is never empty), `ownership` (edit **and**
run-escape), `seatbelt` refs-deny, `preflight`, `engine-orchestration` depth.

**D3 — the critic and the landing queue (2 days)**

| # | File | Change | LOC |
| --- | --- | --- | --- |
| 22 | `src/orchestrate/land.ts` | the pure `LandQueue` reducer + the git effects of §5.2 with the **pinned sha** and the re-check [G3], the post-failure `reset --hard` + scoped `clean -fdx` [D14], the fetch-free kick rebase [D8], `land.jsonl`, `land.lock` | ~330 |
| 23 | `src/orchestrate/critic.ts` | the §5.3 hard rules (diff analysis, assertion counting, test-count parsing) and the [G8] include/drop question | ~220 |
| 24 | `src/orchestrate/stall.ts` | §7.1, pure over a fake clock | ~90 |
| 25 | `src/loop/engine.ts` | the launch step seeding (§5.7) **and its dirty-checkout pre-flight with the `[c]/[s]/[x]` answers** [D1], `RunMeta.landed`, `UndoSkipReason 'landed'`, `undoUnavailableBelow` | ~150 |

Gate: `land` (conflict, verify failure, lock, ref-moved property, empty agent, dirty agent), `critic` (test-deletion
property, flaky flag), `stall`, `undo-land`.

### 8.3 Waves — TUI session (in parallel from D1)

| # | File | Change | LOC |
| --- | --- | --- | --- |
| 26 | `src/config/{types,defaults,resolve,ui,validate}.ts` | the **34** `orchestrate.*` settings of §6.4 — one `SETTINGS` row each, with the defaults now all supplied [D9] (`split: 'off'` [G21], `maxReserveUsd: 2.00`, `land: 'step'`, `verify: []`, `incidentalGlobs: []`, the new `dockCleanExclude` [D14]; `commitNoVerify` deleted) — env names, `--split` / `--max-agents` / `--yes-split` / `--no-wait` flags, the config-table row group, the one-time default announcement, and the `contract.test.ts` case that every key this document names has a row | ~300 |
| 27 | `src/cli/args.ts` | `--parent`, `--parent-session`, `--agent`, `--manifest`, `--own` (repeatable), `--base`, `--split`, `--max-agents`, `--yes-split`, `--no-wait` [G12]; the `agents` `Command` member and its ops. **No `--berth` and no `--replay`** [D12]: a child is resumed with the existing `--resume <childRunId>` (`args.ts:241`), and `--agent` with `--split` is the `ConfigError` of row 20 | ~140 |
| 28 | `src/tui/commands/{registry,dispatch,parse}.ts` | the seven rows of §4.7, their `CommandAction`s, the target-grammar parser, `EXCLUSIVE_COMMANDS` membership for `land`, the `/why` arg values for `decompose` [G13] | ~230 |
| 29 | `src/tui/keys/bindings.ts` + `resolve.ts` | `global:panelAgents` (`meta+a`), `run:pauseTree` (`ctrl+x ctrl+a` — chords already exist, `bindings.ts:8`, `:202`, `chordPrefixes` `:225`), the `agents` `KeyContext` and its 13 actions, the **dynamic** `paneNext`/`panePrev` titles [G20] [D7], and the `review:why` refusal while `headline` is set [D5b]; the per-context uniqueness assertion | ~150 |
| 30 | `src/tui/plain.ts`, `review/lines.ts`, `Review.tsx` | **`ConfirmRequest.title` / `headline` / `body` / `badge`** [G2] [D4] [D5]: the **five** branches of §3.7 — `confirmPreviewLines`, the count-preserving band substitution in **both** `reviewHeaderLines` and `reviewCardLines`, `reviewScreenReaderLines`, and `reviewTitle`/`reviewCardTitle` — plus the extended `review.test.tsx` `it.each` (a `headline`-bearing request at n = 8…2, identical row counts) and the "no rendered row quotes the synthetic `risk`/`proposal`" property. Re-scoped past revision 1's 110 LOC because the row-count contract is tested and the SR twin is a fifth surface | ~260 |
| 31 | `src/tui/pane/{agents,model,timeline}.ts`, `Pane.tsx`, `pane/commands.ts`, `commands/registry.ts` | the agents tab, the 16 row states, `PaneTab 'a'` + `TAB_TITLE.a` + **`cycleTab`'s third argument and `paneTabsFor`, applied at all three call sites** (`App.tsx:1419`, `model.ts:356`, `:476`) [G20] [D7] + `PANEL_ARGS`, and `TIMELINE_STAGES` gains `D` while `TIMELINE_EXCLUDED_STAGES` narrows to `{replan, complete}` [G13] [D3] | ~370 |
| 32 | `src/tui/agents/lines.ts` | the four cards, pure | ~200 |
| 33 | `src/tui/why.ts`, `status/lines.ts`, `StatusLine.tsx`, `toasts.ts` | the `decompose` `/why` block content and criteria rendering (the three table entries themselves moved to D0 item 6b so D0's gate is reachable [D3]); the agents status field; the ten toasts and the `--notify` rule | ~140 |
| 34 | **`src/cli/session.ts` — the `AgentSupervisor`** | created lazily at the first `pause:point{reason:'delegate'}`: preflight → **one `createSandbox` per worktree** [D10] → create worktree per entry → spawn (task/seed as files, no keys in argv) → the bounded json reader with the delta bucket → the row fold → the reaper → `agent:*` host events → **the parking blocker for children** [G7] → adoption incl. **hold rebuild** [G6] → the landing-queue driver → the `[k]/[e]/[n]` exit gate → the parent resume → the headless wait/`--no-wait` contract [G12] | ~620 |
| 35 | `src/cli/agents.ts` | the shell twin over an injected I/O seam; `--json`, `--now`, `--all`, `-f`; starts no engine | ~300 |
| 36 | `src/session/{index,picker-lines,seed}.ts` | the three index kinds, `parentSessionId`, the child fold for spend, indented picker rows, the agent seed | ~200 |
| 37 | `src/chat/{facts,replies}.ts` | the four agent questions answered with no model call | ~90 |
| 38 | `docs/{COMMANDS,KEYS}.md`, `scripts/gen-docs.mjs`, `docs/COORDINATION-DESIGN.md` | regenerated; the four prose paragraphs: the base-branch difference from Claude Code, the cost multiplier, what `[k] keep running` means, and the CD §6.5 `/merge` redefinition + invariant narrowing [G18] | ~110 |

**D4 — hardening, perf gates, docs (both, 1–2 days)**: the §9 measurements, the pty steps, the bench arm.

Rough totals after the review pass: harness ≈ 3,300 LOC over 21 files; TUI ≈ 3,100 LOC over 19 files; tests ≈ 5,600 LOC (the growth is D2's commit-set computation, D1's launch pre-flight, D4/D5's five render branches and D9's completed settings table). The single largest
risk item is #34 inside a 4,067-line `session.ts`, which is why the supervisor is written as its own module
(`src/cli/agent-supervisor.ts`) with `session.ts` holding only the wiring.

### 8.4 Sequencing against the two concurrent designs

Three designs now queue for the same files. `docs/HARNESS-NEXT-DESIGN.md` (Fastlane, committed at `c3b0aad`) and this
one both edit `src/core/types.ts`, `src/core/limits.ts`, `src/loop/engine.ts`, `src/checkpoint/store.ts`,
`src/cli/args.ts`, `src/config/defaults.ts` and `src/jev/questions.ts`; CD's W0–W3 edit the first four as well. The
rule that keeps them from colliding is the one CD already established and this document inherits:

1. **Contract lines are append-only and numbered in landing order.** CD takes `1.4`; orchestration takes **`1.5`**;
   Fastlane declares no number yet and must take `1.6` or later if it lands after. Each wave rebases its `types.ts`
   edits onto the commit that landed the previous header and **never edits above that line**, so the file merges by
   construction and `contract.test.ts`'s header-order case is the enforcement.
2. **CD W0–W3 land before orchestration D0**, because `pause(opts)`, `PausePoint`, `writeCache`,
   `BlockingAnswer 'pause'` and the worktree facade are hard prerequisites (§0.1).
3. **Fastlane and orchestration are independent below `engine.ts`** — Fastlane owns the *step's interior* (routing,
   speculation, the warm runner, `src/loop/{router,replay,window,budget}.ts`), orchestration owns a *new stage plus a
   pause point* (`src/orchestrate/**`, `stages/decompose.ts`). The one genuine overlap is `runStep()`'s stage
   sequence: orchestration inserts `decompose` before `replan`, Fastlane reorders what happens after `intent`. Whoever
   lands second rebases that one function; [G14]'s `contract-stages.test.ts` catches a dropped stage in either
   direction.
4. **`orchestrate.split: 'off'` by default [G21]** means orchestration's landing cannot regress Fastlane's perf
   numbers: with the gate shut there is no new stage, no new I/O and no new Jev request (M2).

---

## 9. Measurement

| # | What | How | Gate |
| --- | --- | --- | --- |
| **M1** | **the scripted 3-child scenario, end to end — in two arms** | **arm a (clean parent)**: a fixture repo with 3 disjoint failing test files (`test/a.test.ts`, `test/b.test.ts`, `test/c.test.ts` over `src/a/**`, `src/b/**`, `src/c/**`), a mocked generator and a mock Jev. Assert: 1 manifest with 3 agents; 3 worktrees, 3 branches, 3 `run.json`s carrying `RunMeta.agent`; **each branch has ≥ 1 commit** [G1]; the dock verified; the launch step committed in the checkout; `/cost` = parent + 3 children; `orchestration:settled` lists 3 landed. **arm b (dirty parent — the normal case)** [D1] [D2]: the same repo with `src/a/x.ts` (inside agent a's slice) and `README.md` (inside nobody's) modified and uncommitted. Assert: no branch's `baseSha..branch` diff contains `README.md`; agent a's does contain `src/a/x.ts`; the manifest card printed the `dirtyOverlap` warning naming exactly `src/a/x.ts`; `/land` offered `[c]/[s]/[x]` and did **not** propose a merge; `[c]` then merges cleanly. Revision 1 failed arm b deterministically | green, deterministic, < 90 s per arm with a mocked model |
| **M2** | **zero cost when it cannot help** [G21] | `split: 'off'` and gate-shut fixtures: `harnessMs` p95 unchanged (< 50 ms, `src/perf/step-overhead.ts:13`), `decomposeMs` p95 < 5 ms of code time, **zero** Jev requests when only `no_split` survives, zero bytes under `orchestrate/`, zero I/O before `renderer.firstFrame()` (< 300 ms) | p95 gates |
| **M3** | **pause / resume / end of each of the three, with timings** | on the M1 scenario, scripted: (1) `pause agent:b` while b is mid-`propose` → b's `run:end` within one step, a and c untouched, wall recorded; (2) `resume agent:b` → it replays the cached proposal, risk re-checked; (3) `pause tree` → the ack report renders in < 500 ms and all three reach `run:end` within `max(child step)`; (4) `resume tree`; (5) `end agent:c` → exit 4, `RunMeta.ended`, **branch kept with its commits**; (6) `pause now` on a mid-`execute` child → the command is **not** killed and the step commits with `interruptedAt.stage === 'judge'`. Every transition is timed and the table is printed | timing assertions; (3) < 500 ms; no step is ever killed |
| **M4** | **crash and adoption** | SIGKILL the supervisor with 3 children live → a new session adopts all 3 within 15 s, **no child spawned twice** (a run-dir count invariant), and the spend holds are rebuilt [G6]. SIGKILL one child → its row reads `crashed at step n (execute)`, `[r]` resumes it, and its branch still holds every committed step [G1] | property test |
| **M5** | **budget arithmetic** | `Σ child spend ≤ reserve + liveAgents × maxSampleUsd`; the parent's session total equals the `parentSessionId` fold; a lowered cap stops a child at its next loop top; a raise reaches only a parked child; `heldUsd` survives a `restore`; **and the enforcement half of [D6]**: with a $2.00 session cap, $0.43 spent and a $0.90 hold, `sessionRemainingUsd` returns 0.67, `followUpDecision` refuses a $1.00 follow-up, and §3.1's money gate reads the same number — all of which are false if `heldUsd` lives only inside `exceeded()` | property test |
| **M6** | **the hard rules** | a child whose diff deletes a test assertion never lands, in every mode and with `critic` `tests` and `off`; `--anyway` ×2 lands it and records the override; an `edit` outside `own` is blocked; a `run` that escapes `own` is **recorded and asked about**, not silently landed [G8]; a branch moved between verify and merge is refused [G3] | property test |
| **M7** | **verbs at three scopes** | table-driven: every verb × {agent, tree, all} × {TUI key, slash command, shell twin} produces the same state transition and the same string | exhaustive |
| **M8** | **the surface** | the agents tab with 8 agents inside the existing render-lag gate; all 16 states render distinctly at 40, 80 and 200 columns, in `--ascii` and for a screen reader; `--plain` / `--json` / Ink line-identical; **the manifest card renders a non-empty body** [G2]; **at every n from 8 to 2 it renders exactly as many rows as an ordinary review card** [D4]; and **no rendered row on any of the four surfaces — Ink, `--plain`, the SR twin, `jevcode agents list` — contains a risk dimension name, a gauge bar or a `matches_intent` row** [D5] | frame tests + `test/pty/agents.steps` |
| **M9** | **honesty** | prompts test: worker/critic/peer text is always inside the fence and never a directive; a research agent's output never becomes a `harnessProblem`; the decompose request is byte-bounded and independent of transcript length | unit |
| **M10** | **is it worth it** | bench arms `split-off` vs `split-on` on a 30-task SWE-bench subset, **budget-matched** (the same total $ cap per task, not the same step count): report solved, median wall, $/solved, and the **discordance** count (solved by one arm only). Falsifiable: if `split-on` does not beat `split-off` at equal dollars on ≥ 2 of 3 metrics, `orchestrate.split` **stays** `off` [G21] | reported, not gated — and it is the gate on flipping the default |
| **M11** | **the stage guard** [G14] [D3] | `contract-stages.test.ts`, **four tables with asserted exclusion sets**: `STAGES` and `stepWhyBlocks`'s order (`why.ts:56`, `:259`) and `STEP_WORDS` (`status/lines.ts:159`) cover every `StageName` with an empty exclusion set; `TIMELINE_STAGES` ∪ `TIMELINE_EXCLUDED_STAGES` partitions `StageName` exactly. Deleting `'decompose'` from any of the four, or adding a stage to none of them, fails CI. `defaultTab` and the `/why` registry row are **not** in the guard — the first is an expression, the second takes a free-form arg. The test is green at HEAD *before* `decompose` exists, which is what makes D0's gate reachable | unit |
| **M12** | **the two commit invariants** [G1] [D2] | a property test over 50 generated agent runs, each with a generated parent dirty set of 0–200 entries. **(i)** for every agent with ≥ 1 `executed` outcome and a non-empty `changedFiles`, `rev-list --count <base>..<branch> >= 1` — without [G1]'s commit step this fails on **every** case. **(ii)** for every agent and every path `p` in `Manifest.syncedDirty`, `p ∈ (baseSha..branch)` **iff** that agent's steps changed `p` — without [D2]'s scoped `addSet` this fails on every case with a non-empty dirty set, which is every real session | property test |

### 9.1 The scripted scenario, in full

```
$ jevcode run --split=ask --max-agents 3 "fix the three failing suites"   # fixture repo
  step  1-10  ... ordinary work
  step 11     decomposing · 5 options built, 2 rejected (shared file: src/core/types.ts; cycle in dependsOn)
              → confirm: 3 agents · src/a/** · src/b/** · src/c/** · reserve $0.90 of $1.80
              → [y]
              delegated at step 11 — 3 agents starting · /agents (Alt+A)
  t+0.0s      agent:start a, b, c                      (3 worktrees, 3 branches, 3 pids)
  t+0.4s      /agents                                   → 3 rows, all `running`
  t+12s       /agent b pause                            → "pausing b · step 2 commits first (propose, 8 s)"
  t+20s       agent:end b (human_pause, exit 4)         → row `paused (you)`          [measure: 8.1 s]
  t+21s       /agent b resume                           → "resumed b at step 3 (replayed the paused proposal)"
  t+40s       Esc → [y] tree                            → "3 pause requests sent · 0 acked · 3 pending"
  t+40.3s     ack report rendered                                                      [measure: 312 ms < 500 ms]
  t+58s       all three at run:end                                                     [measure: max child step = 18 s]
  t+59s       /resume tree
  t+95s       agent:end a, c (complete); b at its cap   → `parked at its cap ($0.30)`
  t+96s       /agent b budget +0.20                     → resumed; completes at t+120s
  t+121s      land queue: a landed @3f1c0de · c landed @9ab2f01 · b conflicted in src/shared.ts
  t+124s      b kicked (rebase clean) → re-land → landed @4b1c9de
  t+130s      3 agents: 3 landed · dock verified (npm test ✓ 412, typecheck ✓)
  t+131s      /land → pre-flight: checkout clean against the dock diff (arm a) → step 12: run git merge --no-ff
                     4b1c9de → 14 files, npm test ✓
              (arm b, dirty parent: /land prints the 1-path overlap and offers [c]/[s]/[x]; [c] seeds step 12
               `git commit -- src/a/x.ts`, step 13 is the merge)                                  [D1]
```

Every timestamped line is an assertion in `test/integration/orchestrate-3.test.ts`; the bracketed measurements are the
numbers M3 prints.

---

## 10. Open questions for the owner

**Ratified 2026-09-22** (harness owner; the TUI session concurred): **Q1** `orchestrate.split` ships `off` with the
one-time hint; **Q2** `PaneTab 'a'` is placed last and skipped when no delegation exists, with the dynamic
`cycleTab(tab, dir, tabs)` / `paneTabsFor(hasDelegation)` at all three call sites; **Q3** `orchestrate.land` ships `step`.
Every other question below ships with the default written in its item; the contract line is `// contract 1.5`, after
coordination's 1.4 and before import's 1.6.

1. **`orchestrate.split` default.** This document ships **`off`** with a one-time hint [G21], against the winner's
   `ask`, because the manifest card is new surface and M10 has not run. Ratify, or accept `ask` after M10 passes.
2. **The tab letter and its cycle position.** `PaneTab 'a'` placed last and skipped when no delegation exists [G20],
   **which requires `cycleTab(tab, dir, tabs = PANE_TABS)` plus `paneTabsFor(hasDelegation)` at all three call sites
   and two dynamic binding titles** [D7] — that is now folded into items 29 and 31 and priced. The alternative is
   `'w'` ("workers") or a permanent fifth position. Ratify before D1, because #28, #29 and #31 all depend on it.
3. **`orchestrate.land` default.** §6.4 now **ships `step`**, because §5.7 already behaves as if it were chosen and
   an implementer cannot be left without a value [D9]. `branch` (leave the dock) is safer for people with CI and has
   one new argument in its favour after the review pass: it never reaches §5.7's dirty-checkout pre-flight at all
   [D1]. Ratify `step`, or flip to `branch` — it is a one-line config change either way.
4. **Should `decompose` run mid-run at all, or only at step 1?** Mid-run splitting is strictly more useful and strictly
   more surprising. `splitEvery` (8) + `maxSplits` (2) is the proposed compromise.
5. **Where the reserve lives — re-posed after [D6].** Revision 1 framed this as "the meter change, versus modelling
   the reserve in the controller at the cost of `exceeded()` not knowing about it". That framing was wrong in a way
   worth recording: **`exceeded()` not knowing about it is the status quo either way**, because the session meter is
   created with an infinite cap (`src/cli/session.ts:1141`) and `sessionRemainingUsd` — not `exceeded()` — is what
   gates a new run. So the real question is narrower: `heldUsd` must be threaded through `sessionRemainingUsd` and
   its two call sites regardless (that is the enforcement, and it is not optional), and what is left to ratify is
   only whether `heldUsd` is *also* stored on `SpendSnapshot` and re-established by `restore`. Recommend yes: the
   crash case (row 31) needs an adopting session to rebuild holds it did not place, and a snapshot field is the only
   place that survives a supervisor SIGKILL.
6. **One Jev request at decompose, or two?** One is cheaper and the questions are independent; two would let the
   self-containment pass be skipped when the ranking already fell back. Recommend one, revisit if the request exceeds
   the model's comfortable question count.
7. **Cross-device agents.** A worktree is a local path, so resuming a parent on another device must recreate worktrees
   from branches (row 34). Build it in a later wave, or document "agents are device-local; the branches are not"?
8. **`critic: 'run'` independence.** Giving the critic the task but not the diff is the right rule, but it means the
   critic may write a test the worker's approach cannot pass for legitimate reasons. Cap kicks at 1 (as proposed), or
   let a disputed critic test be dropped with a recorded override?
9. **Research agents in `auto`.** `auto` skipping the confirm for research-only agents is the one unconfirmed spawn in
   the design. It costs money without a human `[y]`. Keep, or require `--yes-split` there too?
10. **[G1] commit identity.** Committing as `jevcode <jevcode@local>` with hooks neutralised is the safe default, but
    some repos' CI reads trailers or requires signed commits. Offer `orchestrate.commitIdentity` and `commitTrailer`
    (proposed), or commit as the user's configured identity? The `--no-verify` half of this question is **gone**:
    `GIT_BASE_FLAGS` passes `-c core.hooksPath=/dev/null` on every `runGit` call (`src/workspace/git.ts:37`), so no
    hook can run and `orchestrate.commitNoVerify` was deleted as dead. Signing is the live part — `commit.gpgsign=false`
    is passed explicitly, and a repo that *requires* signed commits will reject the dock's branch at push time, not
    at land time.
11. **[G8] The demoted ownership rule.** Asking `[a] include · [d] drop · [x] refuse` at land time is honest but adds a
    prompt to the common lockfile case. `orchestrate.incidentalGlobs` ships as `[]` (always ask) [D9]; the alternative
    is a starter allow-list (`package-lock.json`, `*.lock`, `dist/**`) with the question reserved for the rest. Note
    that [D2] already removed the *other* source of noise here — the synced dirty set, which under revision 1 would
    have made this prompt fire on every land with up to 200 unrelated paths — so the remaining volume is genuinely
    just the lockfile case.
12. **M10's cost.** 30 tasks × 2 arms is real money. Run it on a 12-task SWE-bench slice or the 10-task Terminal-Bench
    subset first?
13. **[D14] `dockCleanExclude`'s default.** `node_modules/`, `.venv/`, `target/`, `.gradle/`, `.tox/`, `.mypy_cache/`
    is a guess at "expensive to rebuild, safe to keep dirty". It is per-ecosystem and will be wrong somewhere. Ship
    the list, or derive it from the verify command's ecosystem (`npm run test` → keep `node_modules/`) and ship `[]`?
14. **[D1] The launch pre-flight's default answer.** `[c] commit them first` is recommended in prose but nothing is
    pre-selected, so a `--no-input` launch with a dirty overlap simply refuses. Is that right for CI, or should
    `--yes-split` (or a new `--land-dirty=commit`) imply `[c]`?

---

## 11. Rejected critiques

Two of the fifteen review findings are not adopted. Both were re-checked in the working tree at `c3b0aad` before
being rejected, and the check is recorded here so the next reader does not have to repeat it.

### R1 — "`EngineSeed` is `types.ts:1130`, not `:1131`" (part of D15)

**Rejected: the document was right.** `awk 'NR>=1128 && NR<=1133' src/core/types.ts` gives

```
1128: }
1129:
1130: // TUI-DESIGN §15 item 11: session seeding, clamps and blocking pauses
1131: export interface EngineSeed {
```

`:1130` is the comment above the interface. §2.6's citation of `src/core/types.ts:1131` is the declaration line and
is unchanged. The other two thirds of D15 are valid and are fixed: `SessionHost.pause` is `types.ts:1551` (the
interface opens at `:1538`), and `sessionRemainingUsd` is `src/tui/budget/lines.ts:184` (`src/cli/session.ts:157` is
only its import line).

### R2 — "D4's fix: fill the gauge band with the first `n − 3` lines of `body`"

**The defect is accepted and fixed; the proposed fix is rejected.** D4 is right that deleting the gauge band leaves a
five-row hole in a drawn box, and §3.7 now preserves the count at every rung of the ladder. But filling the band from
`body` cannot work, for a mechanical reason: `confirmPreviewLines(req)` takes no `n`. It is called with the request
alone — by the readline twin (`plain.ts:681`), by `previewWant` (`Review.tsx:83`) to compute the layout's
`previewWant`, and by `reviewPreviewLines` (`review/lines.ts:159`) — so it cannot know how many lines the header band
above it consumed and therefore cannot return "the rest". Every caller would have to be given `n`, `previewWant`
would become circular (the layout needs the count to choose `n`, and `n` would choose the count), and the same lines
would render twice wherever a caller got it wrong.

Two fields instead of one — `headline` (≤ 5 rows, fills the band) and `body` (the preview) — cost one more optional
member and make both functions total over their existing arguments. The count-preserving property D4 asked for is
kept exactly, and §3.7's table states the substitution rung by rung.

The arithmetic detail also differs: `n − 3` is right only at n = 8 (title, keys, ruler, then 5). At n = 7 and in the
screen-reader set the ruler is absent, so the band is 5 with two rows above it; at n = 6 it is 4; at n = 3–5 it is
`n − 2`. §3.7's table gives each rung its own row rather than one formula, because the ladder is not uniform.
