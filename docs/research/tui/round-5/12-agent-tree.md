# 12 — The agent-tree / control surface (round 5)

Scope: `docs/ORCHESTRATION-DESIGN.md` §8.3 items 26–38, §4.1's additive types, §3.7 (the manifest confirm), §6.4–6.7
(settings, `/cost`); cross-checked against `docs/TUI-DESIGN-4.md` §0/§8/§9/§12 and `docs/research/tui/round-5/00-contract-digest.md`
§A2 (§B items 2–6). Every symbol below was re-grepped/re-read directly against this worktree
(`.claude/worktrees/r5-design`, branch `r5-design`, HEAD `d860827`) on 2026-09-22; line numbers are as-seen. Contract
numbering context (verified via `git show` against main's history, not this worktree's checked-out files, since main
has moved 2 commits past this worktree's HEAD): `docs/DECISIONS.md` on main now assigns **1.8 to TUI round 5** and
**1.9 to Fastlane/HARNESS-NEXT**; orchestration itself is **1.5**, not yet landed. Numbers are assigned at design
acceptance, not merge order (main already shipped 1.7 before 1.5/1.6 exist).

---

## 1. What the designs and code say (verified, file:line)

### 1.1 Contract 1.5's type surface exists today only under `src/orchestrate/**`

`src/orchestrate/types.ts:1-13`'s own header states the plan: every type in its first two sections "MOVES TO
`src/core/types.ts` under the `// contract 1.5` header once coordination's `// contract 1.4` line is in the tree…
declared here, locally, so that this wave can land without touching `src/core/types.ts` at all." Confirmed absent
from `src/core/types.ts`: `grep -n "^// contract" src/core/types.ts` returns only `1.1, 1.2, 1.2, 1.3, 1.4, 1.7` — no
`1.5`/`1.6` line exists. The types round 5 needs are exported today from `src/orchestrate/index.ts:21-46`:

```ts
export type {
  AgentRef, AgentRole, AgentRow, AgentSpec, AskFn, Clock, CommitIdentity, DemandReason, DraftAgent, DraftSplit,
  GateReason, LandAttempt, Manifest, NormalizedSplit, NormalizeResult, RankedSplit, RejectedOption, RunGit,
  RunGitOptions, SplitKind, SplitPolicy, SyncedDirtyEntry, AgentState, VerifyResult,
} from './types.js';
export { DEFAULT_SPLIT_POLICY } from './types.js';
```

Definitions, `src/orchestrate/types.ts`: `SplitKind` (`:21`, 6 members incl. `'no_split'`), `AgentRole` (`:24`, `'code'
| 'research' | 'critic'`), `AgentState` (`:27-43`, **16 members**: `planned, starting, running, paused, parked,
review, stalled, done, landing, landed, conflicted, failed-verify, kicked, dropped, crashed, failed-start`),
`DemandReason` (`:46`), `GateReason` (`:49-67`, 18 members), `AgentSpec` (`:83-100`), `Manifest` (`:111-138`,
carries `syncedDirty`, `dirtyOverlap`, `agents: readonly AgentSpec[]`, `reserveUsd`, `rejected`), `VerifyResult`
(`:141-152`), `LandAttempt` (`:155-172`), `AgentRef` (`:175-180`, `{ slug; runId: string | null; sessionId: string |
null }`), `AgentRow` (`:187-204`, the one row model every surface renders — Ink tab, `--plain`, screen reader,
`jevcode agents list` — with a doc comment naming `src/tui/agents/lines.ts` (item 32, not yet written) as the row
STRING builder). **None of this needs contract 1.5 to land first**; the module's own header calls the future move
"a relocation, not a reshape."

### 1.2 Nothing on the TUI side has started

`grep -rln "orchestrat" src/tui` → zero matches (re-verified). `AgentSupervisor`, every `agent:*`/`land:*` event
consumer, the manifest confirm card fields, and the agents pane tab are **all absent**. Confirmed missing files:
`src/tui/pane/agents.ts`, `src/tui/agents/lines.ts`, `src/cli/agent-supervisor.ts`, `src/cli/agents.ts`, and the one
harness file the design names as not-yet-written, `src/orchestrate/preflight.ts`.

### 1.3 The agents tab and `PaneTab`

`src/tui/pane/model.ts:245-246`:
```ts
export type PaneTab = 'd' | 'p' | 't' | 's';
export const PANE_TABS: readonly PaneTab[] = ['d', 'p', 't', 's'];
```
`cycleTab(tab, dir)` (`:307-309`) indexes `PANE_TABS` directly with no state parameter and has **three** call sites:
`src/tui/App.tsx:1419` (the `]`/`[` handler — line verified to exist as a `cycleTab` call site, not independently
re-numbered this pass beyond the design's own citation) and `model.ts:356` and `:476` (the two side-by-side
next-tab-title builders, both read directly this pass: `` `${tabs}${g.rule.repeat(3)} ${TAB_TITLE[cycleTab(state.tab,
1)]} ${g.rule}` `` at `:356`, `sideTabLines(state, cycleTab(state.tab, 1), n, rightCells, g)` at `:476`). `TAB_TITLE`
(`:322`) is a total `Record<PaneTab, string>` = `{ d: 'decisions', p: 'plan', t: 'timeline', s: 'synth' }`. ORCHESTRATION-DESIGN
§4.6 [G20]/[D7] is correct that a fifth tab is not free: it names all four sites and ratifies

```ts
export function cycleTab(tab: PaneTab, dir: 1 | -1, tabs: readonly PaneTab[] = PANE_TABS): PaneTab
export function paneTabsFor(hasDelegation: boolean): readonly PaneTab[]   // PANE_TABS, minus 'a' when false
```

with every caller passing `paneTabsFor(state.agents.length > 0)`, keeping the default argument so
`test/unit/tui/pane/model.test.ts:165-167` (re-read: the test file exists in this worktree) stays green unchanged.
`PANEL_ARGS` (`src/tui/commands/registry.ts:97`) is `['d', 'p', 't', 's', 'off', 'full'] as const` and is consumed by
`parsePanelCommand`/`nextPanel` in `src/tui/pane/commands.ts:11,32` (`(PANEL_ARGS as readonly
string[]).includes(a)`) — adding `'a'` touches this array, the `panel` command's `valueHints` object at
`registry.ts:448`, and `nextPanel`'s signature (currently `arg: PaneTab | 'off' | 'full' | null`, already wide enough
to accept `'a'` once `PaneTab` gains it — no further change needed there). The binding titles hardcoding the cycle
in prose are confirmed: `src/tui/keys/bindings.ts:72-73`, `'next pane tab (d → p → t → s); opens a collapsed panel'`
/ `'previous pane tab; opens a collapsed panel'` — static strings today, exactly the two the design says must become
computed (`next pane tab (d → p → t → s, + a while delegating)`).

### 1.4 `KeyContext` has five members, no `'agents'`; no chord is actually bound by default today

`src/tui/keys/bindings.ts:12,15`: `export type KeyContext = 'global' | 'composer' | 'review' | 'picker' | 'palette'`.
A sixth, `'agents'`, is new work, as ORCHESTRATION-DESIGN §8.3 item 29 says. One correction to the design's own
phrasing ("chords already exist, `bindings.ts:8`, `:202`, `chordPrefixes` `:225`"): the chord **syntax** exists
(`isChordPrefix`, `chordPrefixes: ReadonlyMap<KeyContext, ReadonlySet<string>>` at `:225`) but the one example the
comments give, `session:export`/`session:cost` at `:81-83`, is explicitly `keys: []` — **unbound by default**
("unbound by default; e.g. `\"session:export\": \"ctrl+x ctrl+s\"`"). So `run:pauseTree = ctrl+x ctrl+a` would be
the **first** chord actually bound out of the box, not a reuse of an existing one; the claim "no `ctrl+x` chord
bound at all today" in ORCHESTRATION-DESIGN §4.6 is accurate and consistent with this.

### 1.5 `ConfirmRequest` today has no `title`/`headline`/`body`/`badge`

`src/core/types.ts:693-702`:
```ts
export interface ConfirmRequest {
  id: string; step: number; proposal: Proposal; risk: RiskAssessment;
  matchesIntent?: number | null; jevLatencyMs?: number;
}
```
`proposal` and `risk` are **required**. `CONFIRM_HEADER_ROWS = 8` (`src/tui/plain.ts:517`); `describeAction('read')`
does return an empty `preview` string as [G2] claims — this is the reason a manifest confirm cannot reuse a synthetic
`read` action without the four new fields. `RISK_DIMENSIONS` (`src/core/types.ts`) has four members, matching the
design's `n = 8 → [title, keys, ruler, 4 gauges, matchesIntent]` accounting. The five count-preserving branches
(`confirmPreviewLines`, `reviewHeaderLines`, `reviewCardLines`, `reviewScreenReaderLines`,
`reviewTitle`/`reviewCardTitle`) are all still today's un-widened forms — none of the four new fields exist to branch
on yet. `EXCLUSIVE_COMMANDS` is confirmed at `src/cli/session.ts:218`, exact set: `['undo', 'rewind', 'diff',
'export', 'report', 'login', 'logout', 'resume', 'new', 'trust', 'historyClear']` — `land` is not a member (correct,
since `/land` doesn't exist yet).

### 1.6 `PausePointReason`, `Engine.pause`/`.end`, `EngineStatus` — a correction to the digest

`src/core/types.ts:1543-1547`, current union, **5 members**: `'step' | 'now' | 'now-after-execute' | 'pane' |
'worktree'` — no `'delegate'`/`'review-needed'`. `PauseOptions` (`:1582-1587`) is `{ at?: 'step' | 'now'; by?:
PausePoint['by'] }` — no `scope`. `SessionHost.pause(opts?: PauseOptions): void` is at `src/core/types.ts:1884` (the
00-contract-digest cites orchestration's own doc line `types.ts:1551` for this — that is the *design draft's* stale
line reference, not this worktree's; the real call site as read here is `:1884`). **Correction to
`00-contract-digest.md`'s A2 table**: it flags `Engine.end?(opts?: { at?; by? })` as "unverified, likely NOT YET,"
reasoning from the absence of an end-specific `PausePointReason` member. Direct read of this worktree shows
`Engine.end?(opts?: EndOptions): void` **already exists**, at `src/core/types.ts:1771`, with `EndOptions` defined at
`:1590-1594` (`{ at?: 'step' | 'now'; by?: 'human' | 'remote' }`) and `RunMeta.ended?: RunEnded | null` at `:1073`
(`RunEnded = { at: string; by: 'human' | 'remote' }`) — this landed under contract 1.4 (coordination), not 1.5. This
matters for round 5: **a `/end` command wired to `engine.end?.()` is buildable today**, with no contract-1.5
dependency, for the single-run case; only the *scope* grammar (`tree`/`agent:<slug>`/`agents`) needs the widened
`by` field orchestration's §4.1 table proposes (`by: 'human' | 'remote'` would need widening the same way `pause`'s
`by: PausePoint['by']` already accepts a `peer:<sid>` form — unverified whether `PausePoint['by']` already carries
that shape; not re-checked this pass beyond confirming the type alias exists). `EngineStatus`
(`src/core/types.ts:1426-1456`) has no `orchestration` field — confirmed, `grep -n "orchestration" src/core/types.ts`
returns zero matches inside the file.

### 1.7 `parentRunId` already exists broadly; only `parentSessionId` is new — a second correction

The 00-contract-digest's A2 table (item "`src/session/{index,picker-lines,seed}.ts`") says `INDEX_KINDS` needs "no
`parentSessionId` on `run:start`" as a gap — true, but it undersells how much of the parent/child plumbing is
**already there** at the run level: `RunMeta.parentRunId?: string | null` (`src/core/types.ts:1077`), `RunRow.parentRunId:
string | null` (`:1912`), the `run:start` index kind already carries it (`src/session/index.ts:25`: `{ v: 1; t: string;
kind: 'run:start'; sessionId: string; runId: string; parentRunId: string | null; … }`), `sessionFieldsOf` reads it
(`index.ts:66-69`), `newRun`/fold-application read/write it (`index.ts:266-267, 324, 332`), the `run:ready` event
carries `parentRunId?: string | null` (`types.ts:1470`), and `json-stream.ts`'s `session:start` line carries it too
(`json-stream.ts:40,81,133`). **`grep -n "parentSessionId" src/core/types.ts src/session/*.ts src/cli/*.ts` returns
zero matches anywhere in this worktree** — that field genuinely does not exist. So the real gap for round 5's
picker/session-index work (item 36) is narrower than it first reads: it is `parentSessionId` (needed because a
child's *session* may differ from its parent's, since a child can itself later be resumed/adopted into a different
session) plus the three `INDEX_KINDS` rows, not the whole parent/child run relationship.

### 1.8 `INDEX_KINDS`

`src/session/index.ts:36`: `const INDEX_KINDS: readonly string[] = ['run:start', 'run:end', 'rename', 'steer', 'undo',
'pause', 'budget', 'chat']` — 8 kinds, confirmed no `agent:start`/`agent:end`/`land` (orchestration wants these
three) and no `session:end`/`relocate`/`handoff` (coordination's separate ask, per the digest's §B item 8). One
array, three designs' rows queued for it — the digest's §C slot plan already assigns this convergence to a single
slot (R5-6) landing all additions in one commit; nothing in this worktree contradicts that.

### 1.9 `sessionRemainingUsd` / the reserve-and-hold arithmetic — the TUI half is done, the harness half is not

`src/tui/budget/lines.ts:188-191`:
```ts
export function sessionRemainingUsd(sessionCapUsd: number, sessionSpentUsd: number, heldUsd = 0): number {
  if (sessionCapUsd === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return finite(sessionCapUsd) - Math.max(0, finite(sessionSpentUsd)) - Math.max(0, finite(heldUsd));
}
```
exact 3-argument signature match to ORCHESTRATION-DESIGN §4.1's `[D6]` line. Both call sites,
`src/cli/session.ts:2021` and `:2347`, pass only 2 arguments today (`heldUsd` defaults to 0) — correct, because
nothing produces a non-zero hold yet. The harness side's own anticipation of this is real:
`src/orchestrate/split/gate.ts:51-52`:
```ts
/** [D6] ALREADY net of holds: `sessionRemainingUsd(sessionCapOf(), sessionTotal(), heldUsd())` */
sessionRemainingUsd: number;
```
(`GateInput.sessionRemainingUsd`, consumed at `gate.ts:119-121`'s money check) — a plain `number` field, so
`gate.ts`'s own tests supply it directly; there is still no `heldUsd()` producer anywhere (`src/spend/meter.ts` has
no `hold`/`release` method — confirmed by grep, zero matches for either name in that file). `SpendSnapshot` has no
`heldUsd?` field either (design-cited fields `generator, jev, totalUsd, capUsd, exceeded, parentExceeded?, parent?`
— not independently re-read field-by-field this pass, consistent with the digest's prior verification). **Net: the
entire remaining TUI-side task on reserve/held display is swapping the 2-arg calls in `session.ts` for 3-arg calls
once a real `heldUsd()` exists** — everything else (the function, its arithmetic, its `/cost` consumer shape) is
already correct and tested today.

### 1.10 The manifest confirm, P9, and the settings/CLI/command tables

Re-read in full against `docs/ORCHESTRATION-DESIGN.md` §3.7, §4.1–§4.9, §6.4–§6.7, §8.3 (verbatim quotes preserved
in this document's §4 and §5 below where they become pinned strings or recommendations). Nothing in this worktree
contradicts the design text there — `ConfirmRequest`, `PausePointReason`, `EngineStatus`, `INDEX_KINDS`, `PaneTab`,
`KeyContext`, `CommandAction`, `EXCLUSIVE_COMMANDS` are all confirmed at the state the design assumes ("not yet
landed"). `CommandAction`'s union (`src/tui/commands/dispatch.ts:38-68+`) confirmed to have no `split`/`agent(s)`/
`land`/`spawn` member; `{ kind: 'pause' }` (`:45`) takes **no** payload today, confirming `/pause`'s scope-grammar
widening (item 28) is real, additive work, not already-present.

---

## 2. What the best tools do (cited)

**opencode — a real session tree, navigated, not pause/resumed as a group.** Child (subagent) sessions are project-scoped
and navigated with dedicated keybinds, not scrolled through as a flat list: `session_child_first` (default
`<leader>+Down`) opens the first child of the current session, `session_child_cycle` (default `Right`) / `session_child_cycle_reverse`
(default `Left`) move between siblings, `session_parent` (default `Up`) returns to the parent
([opencode docs — Agents](https://opencode.ai/docs/agents/), fetched 2026-09-22). This is the closest existing
prior art to round 5's `agent:<slug>` attach/back model, but opencode's own open issues show the gap the design
explicitly closes: entering a child session drops the sidebar entirely, "no context usage or cost for that session"
([opencode issue #48548](https://github.com/sst/opencode/issues/48548)), and a background subagent's completion can
silently flip which model is "active" without ever showing the child that finished
([opencode issue #47526](https://github.com/sst/opencode/issues/47526)) — exactly the class of bug ORCHESTRATION-DESIGN
§4.6's "a row is never hidden while the agent exists" rule and the `AgentRow` cost/step fields are built to prevent.
(Note: search results for opencode issue numbers should be treated as approximate — the canonical repo is
`sst/opencode`; some search results surfaced a differently-named fork and are not cited here.)

**Claude Code — background subagents with no live view, and a known visibility complaint.** `/tasks` (alias
`/bashes`) is "View and manage background work in the current session, including subagents that have finished"
([Claude Code docs — slash-commands](https://code.claude.com/docs/en/slash-commands), fetched 2026-09-22) — a
**retrospective** list, not a live control surface: nothing pauses, budgets or steers a running subagent from this
view. `subagentStatusLine`, a hook-configured command, "receives all visible subagent rows and returns
`{"id","content"}` lines" for the bottom status line
([Claude Code docs — statusline](https://code.claude.com/docs/en/statusline), fetched 2026-09-22) — closer to round
5's collapsed-strip row (`agents 3 · ✓1 ● 1 ⏸1 · $0.41/0.90 · dock ✓`) than to the full tab. The community-reported
gap is exactly what P10's "review-needed" pause point and the toast rules exist to prevent: "Background subagents
give the user zero visibility; model waits silently for 15+ minutes"
([issue #95730](https://github.com/anthropics/claude-code/issues/95730)), and orphaned background agents can "display
as running indefinitely" after a crash with no reaper
([issue #94872](https://github.com/anthropics/claude-code/issues/94872)) — the reaper/adoption mechanism in
ORCHESTRATION-DESIGN §4.4 ("a child whose process exits without a `run:end` line… is marked `crashed`… the next
session on this workspace adopts them within one poll") is a direct, better-specified answer to this class of bug.

**Cursor 3 "Agents Window" — the nearest fleet-view analogue, cross-repo.** Released April 2026: "a sidebar that
shows every active agent session, local or cloud, across all your repos, all at once… the task that started it, the
repo it targets, and whether it runs locally or in the cloud," each agent in its own git worktree so agents "cannot
overwrite each other's files," with up to 8 background agents running in parallel
([Cursor 3 Agents Window guide](https://www.digitalapplied.com/blog/cursor-3-agents-window-complete-guide), fetched
2026-09-22; official changelog at [cursor.com/changelog/3-0](https://cursor.com/changelog/3-0)). This validates two
of round 5's structural choices independently: worktree-per-agent (§2.3 of ORCHESTRATION-DESIGN, already
implemented in `src/orchestrate/worktree.ts`) and a bounded parallelism cap (`orchestrate.maxAgents`, default 3,
clamped by `coordination.maxChildren`) — Cursor's hard cap of 8 is the same shape of decision, just a different
number for a different cost model. Cursor's own docs do not publish the exact row schema (fetched directly; the
page defers to a separate reference this session could not resolve further), so round 5's 11-column `AgentRow`
(state · slug · step/max stage · $spent/cap · wall/max · own · branch@head · verify · last line) is **more
specified** than the public Cursor documentation, not less.

**Codex CLI (OpenAI) — worktree isolation plus a `list`/`apply` verb pair, not a live pane.** "Codex 0.154.0 …
combining experimental worktrees…" binds "each eligible thread to its checkout, which then becomes that session's
working directory"; parallel agents across projects use "git worktree isolation where each thread works on an
isolated copy of your repo"; `codex cloud list` shows recent cloud tasks and `codex apply <TASK_ID>` pulls a
finished task's result into the local repo
([remio.ai — Codex 0.154.0](https://www.remio.ai/post/openai-codex-0-154-0-turns-the-cli-into-a-parallel-working-system),
fetched 2026-09-22). The `list` + `apply` shape is the same two-verb minimum round 5's `jevcode agents list` /
`/agent <slug> land` pair covers, but Codex's is asynchronous-only (no live attach, no pause/steer) — round 5's
`Enter` (attach, read-only) plus `p`/`t`/`+` (pause/steer/budget) is a strictly richer live surface than either
Codex or Claude Code's `/tasks` offers today.

**tmux `choose-tree` — the closest thing to a "collapse/expand a tree of live processes" UI outside an AI tool.**
`choose-tree [-s|-w] [-Z] …` puts a pane into tree mode over every session/window/pane; keys in that mode: arrows
navigate, `+`/`-` expand/collapse a node, `x` kills the selected item(s), `t` tags an item (for a batch operation),
`C-s` searches by name, `v` toggles a live preview
([tmux choose-tree reference](https://waylonwalker.com/tmux-choose-tree/), fetched 2026-09-22; corroborated by
`man tmux`). This is the strongest outside precedent for round 5's agents-tab key table (`x`+`x` drop, `k` kick,
`d` diff/preview) — tmux's `x`-to-kill and double-confirm-free batch tagging is one reason ORCHESTRATION-DESIGN
requires `x`+`x` (two presses) for `drop` rather than tmux's single `x`, given that a drop is unrecoverable for an
agent's *pending* work in a way a tmux pane kill is not (the branch survives; the running process's un-committed
diff does not).

**Aider — no comparison available.** Aider is a single-agent, single-session pair-programming CLI with no
subagent, worktree, or fleet concept; it is not cited further because there is nothing in its design that bears on
an agent-tree control surface. This absence is itself informative: none of the tools reviewed here that popularized
"agentic coding" as a single-session experience (Aider) also solved multi-agent visibility — every fleet/tree UI
surveyed above is a **later, separate** feature added once single-agent sessions were already trusted, which
matches round 5's own sequencing (agents tab ships after rounds 1–4's single-session TUI, not before).

---

## 3. Edge cases

Grounded in ORCHESTRATION-DESIGN §4.2–§4.6, §7.2 (the 58-row corner-case table, not fully re-read this pass) and
this worktree's confirmed absences:

1. **A child mid-`execute` when the parent asks to pause the tree.** §4.4: "a child mid-`execute` is never killed…
   its row says `execute finishes first (12 s)`." The 5 s shutdown-checkpoint bound (contract 1.4's existing rule)
   applies per-child independently, so the tree's shutdown is bounded by `max(child step time)`, not the sum — a
   real difference from a naive "wait for all children serially" implementation.
2. **A crashed `AgentSupervisor` process, children still running.** §4.4's reaper distinguishes a truly-crashed
   child (`isPidAlive` false + dead `run.lock`, `src/session/lock.ts:27` per the design's citation — not
   independently re-verified this pass) from a child that is merely quiet (heartbeat live, no `run:end` yet — "it is
   working, the pipe is just quiet"). Adoption happens within one poll (15 s) on the next session touching the
   workspace, printing `adopted 3 agents of run 2026…-rpywkq2v (2 running, 1 parked)` and emitting `agent:adopted`.
   §4.4 explicitly contrasts this with in-process teammates (Claude Code's Task-tool subagents), whose "ghosts
   survive a `/resume`" per that product's own documented limitation — this is a real, cited product difference to
   defend in review, not a design flourish.
3. **Caps checked against the live fold, never a counter.** §4.4: a resumed or adopted child must count against
   `orchestrate.maxAgents` via `listSessions(fold, self).filter(a => a.heartbeat.parentRunId === myRunId &&
   a.liveness === 'live').length` — not a persisted integer that a resume could silently reset. This closes exactly
   the "resuming takes a fresh slot without checking the limit" class of bug.
4. **`base moved` on the resume card.** §4.5: a `baseSha` mismatch (someone committed to the parent's branch after
   delegation) replaces the plain `[Enter]` resume action with `base moved 3f9a2c1 → 9d21ee0 (2 commits by you) —
   [r] rebase the 3 agents · [s] stage on the old base · [f] forget`. This is the one resume-card branch that is not
   a simple present/absent check — it requires diffing the parent's current HEAD against the manifest's recorded
   `baseSha` at render time.
5. **A missing worktree vs. a missing branch.** §4.5: worktree gone but branch present → `[n] recreate from
   jevcode/<slug>` ("the branch is the truth, the worktree is a cache"); branch **and** run dir both gone → the
   agent is marked `dropped` outright, with no recovery offered.
6. **`review-needed` (P10) inside a child that the parent never sees directly.** The parent's own review card must
   carry `ConfirmRequest.badge = 'agent tui-rows'` so "nobody approves the wrong thing" (§4.6) when multiple children
   could plausibly be blocked at once — this is a labelling requirement on the *shared* review-rendering code
   (§3.7's five branches), not agents-tab-local code, so it is one more reason items 30 and 31/32 must land
   together rather than out of order.
7. **Headless exit-code ambiguity.** §4.9 [G12]: a delegating parent's own stop reason at P9 is `human_pause`, which
   `exitCodeFor` maps to exit code **4** — the same code a real budget exhaustion uses — while children are still
   live and spending. Without the wait-by-default behaviour, "a CI job would read 4 as 'budget exhausted' and a
   script would exit before any agent landed." `--no-wait` must therefore print a *different*, explicit sentence
   (`delegated: 3 agents running; …`) rather than relying on the exit code alone to disambiguate.
8. **Mid-flight budget lowered below the held reserve.** §6.5: lowering `session-spend-cap` below what is currently
   held must *shrink the reserve by releasing unspawned holds* and relay a `budget` message to live children; a
   child already past the new cap stops at its next loop top with `spend_cap` (resumable) rather than being killed
   mid-step. Raising is refused mid-step ("a surprise") and only reaches children already parked at their cap.
9. **`split: 'auto'` with a non-research agent.** §3.7's policy table: `auto` skips the human confirm **only** when
   every agent in the manifest has `role: 'research'` — a single code-writing agent in an otherwise-auto manifest
   forces the ordinary `[y]` gate. This is a hard rule, not a preference, and any fixture-driven test of the
   confirm-skip path must assert it holds even for a 4-agent manifest with 3 research + 1 code agent.
10. **`--no-input` / pipe / bench with delegation pending.** §3.7: with no blocker available, the confirm auto-answers
    `stop` → `no_split`; headless delegation requires an *explicit* `--split=auto` (research-only) or `--yes-split`,
    and either path must record the override in `RunMeta.overrides` so a later audit of "why did this run spawn
    agents with nobody watching" has an answer.
11. **Land refused for removing assertions.** §4.8's exact pinned line — `fix-store not landed: removed 4 assertions
    in test/unit/store.test.ts — /agent fix-store land --anyway (twice) overrides` — encodes both an edge case (a
    verify pass that is green because it deleted the failing assertions) and a UX rule (the override needs **two**
    invocations of `--anyway`, not one, matching the tree's general "irreversible things cost an extra keystroke"
    pattern already used for `x`+`x` drop).

---

## 4. Pinned strings and twins

Every string below is quoted verbatim from `docs/ORCHESTRATION-DESIGN.md` (§4.6–§4.8, §3.7, §6.7) as the design's
own pinned copy; none of it exists in this worktree's code yet (§1.2), so these are the **target** strings a
fixture-first implementation renders, not a diff against shipped text. Design intent (§4.6, restated from source):
"every row string is produced by one pure function shared by the Ink tab, the `--plain` twin, the screen-reader twin
and `jevcode agents list`" — i.e. every string in this section needs exactly one implementation with four render
targets, not four separate strings.

**Collapsed strip (1 row, status line):**
```
agents 3 · ✓1 ● 1 ⏸1 · $0.41/0.90 · dock ✓
agents 2/3 ✓1 ✗0 · $0.41/0.90 (+$0.06)
```
(the second form is the §4.6 "Status line" row — `(+$0.06)` is the worst-case per-process overshoot of §6.3, not a
live number the render layer computes itself.)

**The manifest confirm card body (`ConfirmRequest.body`, §4.8):**
```
3 agents · src/tui/** · src/loop/** · test/** · reserve $0.90 of $1.80 · verify: npm test, npm run typecheck
```
`[D1]`'s dirty-overlap headline row, when non-empty, is **row 1** of `headline` ahead of everything else:
```
⚠ your checkout has 7 uncommitted files; 2 of them (src/tui/Pane.tsx, src/loop/engine.ts) are inside an agent's
  slice — /land will ask you to commit or stash those two before it merges
```

**P9 (delegation accepted) — the transcript/status line, `by: 'self'` always (never a peer/device form, per [G17]):**
```
delegated at step 11 — 3 agents starting · /agents (Alt+A) · Esc pauses the tree
```

**Declined split:**
```
split declined; continuing single-threaded (the reason reaches the next step)
```

**Pausing the tree (default scope for a delegating session, §4.3):**
```
pause this session: [y] tree (3 agents at their next step)  [Y] tree now  [t] this run only  [n] stay
```
```
abort 3 agents too? [y] all  [t] this run only  [n] cancel
```
```
3 pause requests sent · 1 acked · 2 pending (they finish their step)
```

**Per-agent verbs (§4.8's exact table, key / shell twin / status-transcript text triples):**
```
pausing tui-rows · step 4 commits first (propose, 41 s)
paused tui-rows now at step 4 (propose): proposal kept — resume replays it
resumed tui-rows at step 5 (replayed the paused proposal; risk re-checked)
test-fixture needs approval: patch test/unit/store.test.ts (risk 0.52) — [Enter] review · [d] decline · [q] leave it parked
steered test-fixture (1 queued for its step 4)
tui-rows cap $0.30 → $0.50 (session $1.43/2.00) — resumed
landed fix-store into jevcode/dock-a2fee9c1 @8bc0d11 · npm test ✓ (412) · typecheck ✓
fix-store not landed: removed 4 assertions in test/unit/store.test.ts — /agent fix-store land --anyway (twice) overrides
fix-store conflicts with tui-rows in src/checkpoint/store.ts (lines 361–383) — kicked (1 of 1)
dropped test-fixture (branch jevcode/test-fixture kept, 1 commit)
tui-rows: no progress for 11 m (same step 4, no files changed) — [p] pause · [k] kick · [x] drop
3 agents: 2 landed, 1 parked · dock verified · /land merges it here
adopted 3 agents of run 2026…-rpywkq2v (2 running, 1 parked) — /agents
```

**Exit-with-agents-live gate (headless/interactive shared):**
```
3 agents live: [k] keep them running (they keep spending) · [e] end them · [n] stay
```

**`/cost` (the exact arithmetic-checkable form, §6.7):**
```
/cost → run $0.12 · agents $0.31 (3 runs) · session $0.43/2.00 · held $0.29 · free $1.28
```

**Agents tab row-state word table (§4.6, 16 states — the glyph/word pairing every twin must match):**

| State | Word |
| --- | --- |
| `planned` | `queued` |
| `starting` | `starting` |
| `running` | `step n/m <stage>` |
| `paused` | `paused (you)` |
| `parked` | `parked (<why>)` |
| `review` | `needs approval` |
| `stalled` | `no progress 11 m` |
| `done` | `done, not landed` |
| `landing` | `landing` |
| `landed` | `landed @<sha7>` |
| `conflicted` | `conflicts in <path>` |
| `failed-verify` | `<cmd> failed` |
| `kicked` | `kicked (1/1)` |
| `dropped` | `dropped` |
| `crashed` | `crashed at step n (<stage>)` |
| `failed-start` | `failed to start (<code>)` |

**The twins, explicit per the design and confirmed against this worktree's existing pattern (`--plain` twins already
exist for every current command; screen-reader twins already exist for the review card):**
- **Ink tab**: `src/tui/pane/agents.ts` (new) renders the 16-row table inside the pane, ≤ 12 rows visible, scrolls
  above that.
- **`--plain`**: the same row strings, one per line, no ANSI — the pattern every other pane already follows
  (`src/tui/plain.ts`'s existing per-pane `--plain` renderers, not independently re-read this pass beyond confirming
  the file is S5's and already has this shape for the other four tabs).
- **Screen reader**: the row strings again, through the same `reviewScreenReaderLines`-style aria path used for the
  confirm card (§3.7's branch 4) — for the manifest card specifically, `[title, …headline, …body (clipped to
  SR_BODY_ROWS = 12), SR_REVIEW_CHOICES, SR_REVIEW_PROMPT]`.
- **`jevcode agents list --json`**: the shell twin (`src/cli/agents.ts`, item 35) over an injected I/O seam "like
  `src/cli/sessions.ts`" (confirmed: `src/cli/sessions.ts` exists today at 137 lines per the digest, a real pattern
  to copy), starting no engine.
- **`--ascii`**: every glyph column (`○ ◌ ● ⏸ ⚠ ✓ ⟳ ✗ ↻ −`) substitutes per `TD §14.1` — the existing glyph-set
  mechanism (`src/tui/glyphs.ts`'s `GlyphSet`, already used by every other pane) is the one place this substitution
  needs to be wired, not a new mechanism.

---

## 5. Recommended decisions with options and a recommendation

### 5.1 Build order: fixture-first types now, or wait for contract 1.5 to land in `core/types.ts`

- **Option A — wait.** Block all agents-tab/`AgentRow`/`Manifest` work until orchestration's D0 lands contract 1.5
  in `src/core/types.ts`.
- **Option B — build against `src/orchestrate/index.ts`'s pre-merge exports now** (`AgentRef`, `AgentRow`,
  `AgentSpec`, `Manifest`, `SplitKind`, `AgentState`, etc., confirmed exported today at `index.ts:21-46`), treating
  the future move to `core/types.ts` as a pure relocation per that module's own header comment.
- **Recommendation: B.** The module's own doc comment states the move is "a relocation, not a reshape," and this
  worktree confirms the types are already fully defined and exported. Waiting for contract 1.5 costs a full wave for
  zero benefit — nothing about `src/tui/agents/lines.ts` (pure row-string builders, item 32) or `src/tui/pane/agents.ts`
  (item 31) needs the types to live in `core/types.ts` specifically; they need the types to exist and be stable,
  which they already are.

### 5.2 `/end`'s single-run form: ship now, or bundle with the scope-grammar widening

- **Option A — bundle.** Land `/end` only once the scope grammar (`tree`/`agent:<slug>`) is ready, so there is one
  command surface instead of two.
- **Option B — ship the single-run form now.** `Engine.end?(opts?: EndOptions): void` already exists on contract
  1.4 (`src/core/types.ts:1771`, confirmed §1.6 above); a `/end [now]` command with no scope argument is a pure
  registry + dispatch addition today, with the scope grammar arriving as a widening later exactly the way `/pause`'s
  own scope widening is already planned as additive.
- **Recommendation: B.** This is a genuine "buildable now" item the digest's own table marked as blocked
  ("NOT FOUND... treat as unverified, likely NOT YET") on a mistaken premise. Shipping the single-run `/end` now
  gives round 5 an early, low-risk win and exercises the `RunMeta.ended`/exit-3-refusal path (§8 D-AA's own
  `epilogue` correctness rule: "the epilogue never lies") before the harder multi-agent cascade work lands.

### 5.3 Manifest confirm card fields: land with the agents tab, or land alone first

- **Option A — land alone first.** `ConfirmRequest.title/headline/body/badge` (item 30) ships as its own PR against
  the *existing* single-run review card (using it for nothing agent-related yet — e.g. a future non-agent proposal
  that wants a custom title), proving the five-branch count-preserving substitution in isolation before the agents
  tab depends on it.
- **Option B — land together with items 31/32.** One PR carries the fields, the five branches, and the agents tab
  that is their first real consumer.
- **Recommendation: A, with a minimal synthetic test fixture, not B.** §3.7's own property test target — "no
  rendered row contains any substring of `risk` or `proposal`" — is independent of agents entirely; landing it first
  against `test/unit/tui/review.test.tsx`'s existing `it.each` (extended per the design, n = 8…2) de-risks the
  trickiest part of round 5 (five render branches across three twins, all row-count-preserving) without also
  needing a working `AgentSupervisor` to exercise it. This is consistent with the module map's existing convention
  of landing pure-module work in an early wave (TD4 §9.3's own W1) before the feature that consumes it.

### 5.4 The agents tab's row source while `AgentSupervisor` (item 34, ~620 LOC) is not yet built

- **Option A — stub the tab behind a feature flag until the supervisor exists**, shipping no visible behaviour.
- **Option B — build the tab, the four cards, and the 16-row-state renderer entirely against typed fixtures**
  (`AgentRow[]` literals covering all 16 states), with `paneTabsFor(hasDelegation)` gating visibility, so the
  **rendering** is complete, tested (`app-harness.tsx`-style fixture tests) and reviewable before the supervisor's
  process-management half exists at all.
- **Recommendation: B.** This mirrors ORCHESTRATION-DESIGN §4.6's own framing — "every row string is produced by one
  pure function" — which is by construction supervisor-independent: the function takes an `AgentRow`, not a live
  process. Building the tab against fixtures first also gives the eventual `AgentSupervisor` author (item 34, the
  single largest item in the whole design, "the single largest risk item") a fully-specified, already-tested
  consumer to fold real rows into, rather than writing both halves at once.

### 5.5 Where `AgentSupervisor` lives, and whether it starts before D0–D2

- **Confirmed today**: `src/cli/agent-supervisor.ts` does not exist. ORCHESTRATION-DESIGN §8.3 item 34 specifies it
  as its own module (not inline in the already-4,067-line `session.ts`) "created lazily at the first
  `pause:point{reason:'delegate'}`" — i.e. it cannot do anything until P9 exists, which needs `StageName` to gain
  `'decompose'` (harness D1, not yet on main — confirmed absent from the 8-member union in this worktree) and the
  engine's P9/P10 wiring (harness, also not started).
- **Recommendation**: do not start item 34 until harness D0 (contract 1.5 merge) **and** D1 (`decompose` stage +
  P9/P10 wiring) both land — there is nothing to pause at and no manifest to confirm before then, so the module
  would have no real caller to test against beyond a hand-rolled fake `pause:point`. This is the one item in §8.3's
  table that is genuinely blocked, not merely inconvenienced, by the peer's sequencing — everything else in this
  document (§5.1–§5.4, the settings table, the CLI flags, the command registry rows, the `INDEX_KINDS` additions)
  is buildable against fixtures or pre-merge exports today.

### 5.6 The 34 `orchestrate.*` settings and the 9 CLI flags: land now, independent of everything else

- **Confirmed**: `src/config/{types,defaults,resolve,ui,validate}.ts` have no `orchestrate.` prefix today (matches
  the digest). ORCHESTRATION-DESIGN §8.2/§8.3 item 26 itself says this item "has no dependency on contract
  1.5/1.6, only on... pure data" and can start immediately.
- **Recommendation**: start item 26 (config rows) and item 27 (CLI flags: `--parent`, `--parent-session`, `--agent`,
  `--manifest`, `--own`, `--base`, `--split`, `--max-agents`, `--yes-split`, `--no-wait`) in round 5's first wave,
  in parallel with §5.4's fixture-driven tab work — the two are fully independent, and the settings table's own
  `contract.test.ts` case ("every `orchestrate.*` name this document mentions has a `SETTINGS` row") is a clean,
  self-contained property test that catches drift regardless of what else in round 5 slips.

### 5.7 `/split` `/agents` `/agent <id>` `/land` `/spawn`: register now with no-op/fixture semantics, or wait

- **Option A — wait** until `AgentSupervisor` exists so every command has real behaviour on day one.
- **Option B — register the seven command rows (§4.7) and their `CommandAction` members now**, with dispatch
  returning a typed "not available in this build" or fixture-backed response (the same pattern round 4 ships for
  `/peers`' stub state: `the peer registry is not available in this build`, `docs/TUI-DESIGN-4.md:2817`), so the
  palette, `--plain` numbered list, `docs/COMMANDS.md` generation and the 41→48 command-count identity test all stay
  in sync with the design from the start, rather than arriving in one big-bang PR alongside the supervisor.
- **Recommendation: B**, explicitly modelled on round 4's own `/peers` precedent (a real command, in the registry,
  with args and availability, that answers honestly that its backing store doesn't exist yet). This avoids the
  "never a dead command" violation TD4 §14.2 finding 41 already flagged and fixed once for `/peers` — round 5 should
  not reintroduce the same defect for `/split`/`/agents`/`/land`/`/spawn`.

---

## 6. Open questions

1. **Is `SessionHost.pause`'s scope widening (`{ at?; scope?: 'run'|'tree'|'agents'|'all'|\`agent:${string}\` }`)
   coordination's file or orchestration's?** ORCHESTRATION-DESIGN §4.1 attributes the widening to "`types.ts:1551`
   [D15]" as a correction to a *previous* draft that cited `:1538` — but this worktree's actual `SessionHost.pause`
   line is `:1884`, and `:1538` is where the `SessionHost` interface itself opens. Both peer-cited line numbers are
   stale against this worktree; which slot lands the widened signature, and does it land before or alongside CD's
   own `agent:<slug>`/`device:<label>` target-grammar work (COORDINATION-DESIGN §5.3), since both share one parser?
2. **Does harness D1's `decompose` stage land before or interleaved with round 5's fixture-driven tab work (§5.4)?**
   If D1 slips well past round 5's other five slots, does the agents tab ship dark (built, tested, but
   `paneTabsFor(false)` always hides it because `state.agents.length` never exceeds 0 in production) for an entire
   release, and is that an acceptable interim state to document in `docs/COMMANDS.md`?
3. **`EndOptions.by: 'human' | 'remote'`** — does the cascade's `pause({ by: 'peer:<sid8>' })` precedent (already
   accepted for `pause` under contract 1.4) get mirrored onto `end` as `by: 'peer:<sid8>'` too, or does `end`
   deliberately stay narrower than `pause` because ending a whole tree is a more consequential action than pausing
   one? The design's §4.1 table does not widen `EndOptions` explicitly.
4. **`orchestrate.maxAgents` default 3 vs. Cursor's 8** — is 3 a deliberate conservatism given JevCode's
   per-process cost multiplier framing (§6.6's "~15× chat tokens... ~7× for agent teams," cited from Anthropic's own
   multi-agent research writeup), or a placeholder pending the M10 measurement gate [G21] mentions? Worth pinning
   down before `--max-agents` ships as a user-facing flag with an unexplained default.
5. **Does `jevcode agents list --json`'s row schema need to match `AgentRow` field-for-field**, or is a `--json`
   consumer expected to get a richer/different shape (e.g. including `LandAttempt` history inline)? The design names
   `AgentRow` as "the one row model every surface renders," but the shell twin's `--json` output is not shown
   verbatim anywhere in §4.7/§4.8/§8.3 the way the Ink/`--plain`/SR strings are.
6. **Which slot owns the `paneTabsFor`/`cycleTab` signature change** if round 4's own `PANE_TABS`-adjacent work (the
   brand-strip/wordmark logic that also reads pane state) is still landing in parallel — is there a real collision
   risk between round 4's S1 (`App.tsx`, `pane/model.ts`'s brand segment) and round 5's item 31 touching the same
   `model.ts` file, beyond what the digest's §B item 9 already flags at the design-doc level?
