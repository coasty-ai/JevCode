/**
 * The agent tree's row grammar — **one pure function, four render targets** (TUI-DESIGN-5 §4.2, OR §4.6).
 *
 * The Ink tab (`src/tui/pane/agents.ts`), the `--plain` twin (`src/tui/plain.ts`), the screen-reader twin and
 * `jevcode agents list` all call the builders here. No second row string exists anywhere; §13.1 pins this module as
 * the single home of S60–S86 and §13.2 clause 6 pins the one deliberate difference between the sinks (the Ink tab
 * scrolls above 12 rows, `--plain` and `--json` print every row — `agentRows` never filters).
 *
 * **`import type` only, and no value crosses (§4.1, §2.1 rule 6, §14.2 #14).** `src/orchestrate/index.ts` is a
 * *value* module whose dependency graph reaches `node:fs/promises`, so nothing here may import it at runtime.
 * D-AK's re-point has already happened: contract 1.5 landed on `main` (`2400a0c`), so the shapes are taken from
 * `src/core/types.js` directly — strictly safer for gate G-R5-1 and a no-op for the eventual move (w0-reverify §3).
 * Where round 5 wants a **value** — the sixteen state words, the sixteen state glyphs — it declares it here as a
 * total `Record<AgentState, …>`, which `tsc --strict` proves total against the imported union: a seventeenth member
 * is a compile error, not a blank cell (§10 `agents/lines.test.ts`).
 *
 * Pure: no Ink, no I/O, no clock. Every function is total over its inputs at every width.
 */
import type { AgentRow, AgentState, Manifest, StageName } from '../../core/types.js';
import type { BlockRole, BlockRow } from '../block/lines.js';
import type { AgentsOp } from '../keys/resolve.js';
import { GLYPHS, type GlyphSet, cellWidth, glyphTwin, truncateCells } from '../glyphs.js';

// ---------------------------------------------------------------------------------------
// §12.3 S60: the glyph column
// ---------------------------------------------------------------------------------------

/**
 * §12.3 S60 / §14.2 #43: the state column's glyph, taken from the `GlyphSet` so `--ascii` and the screen-reader
 * twin come for free — `○ ◌ ● ⏸ ⚠ ✓ ⟳ ✗ ↻ −` → `o . * = ! + ~ x @ -`. Six of the ten are R5-2's W1
 * `src/tui/glyphs.ts` members (`gone`, `stale`, `live`, `paused`, `landing`, `kicked`) and four were already there
 * (`warn`, `check`, `cross`, `minus`); `asciiTwins()` is one-to-one and first-wins, which is why `◌` is `.` and
 * never `o` (S3 corrected, S60 stands).
 *
 * Total over `AgentState` by construction — a seventeenth member is a `tsc --strict` error here before it is a
 * blank cell in a frame (§10's table test). The map is deliberately **not** injective: ten glyphs carry sixteen
 * states, and the *word* beside it is what distinguishes `conflicted` from `crashed`.
 */
export function agentStateGlyph(state: AgentState, g: GlyphSet = GLYPHS.unicode): string {
  switch (state) {
    case 'planned':
      return g.gone;
    case 'starting':
    case 'landing':
      return g.landing;
    case 'running':
      return g.live;
    case 'paused':
    case 'parked':
      return g.paused;
    case 'review':
      return g.warn;
    case 'stalled':
      return g.stale;
    case 'done':
    case 'dropped':
      return g.minus;
    case 'landed':
      return g.check;
    case 'conflicted':
    case 'failed-verify':
    case 'crashed':
    case 'failed-start':
      return g.cross;
    case 'kicked':
      return g.kicked;
  }
}

// ---------------------------------------------------------------------------------------
// §4.2: the sixteen row-state words
// ---------------------------------------------------------------------------------------

/**
 * §4.2 (OR §4.6, verbatim): the word each state renders when it needs no detail from the row. The eight states whose
 * word interpolates a fact — `running`, `parked`, `stalled`, `landed`, `conflicted`, `failed-verify`, `kicked`,
 * `crashed`, `failed-start` — read it from the row and fall back to the bare word here when the fact is absent, so a
 * row never prints `landed @` or `conflicts in ` with an empty tail (§13.2: a `landed @` cell is a bug, not a state).
 */
export const AGENT_STATE_WORD: Readonly<Record<AgentState, string>> = {
  planned: 'queued',
  starting: 'starting',
  running: 'running',
  paused: 'paused (you)',
  parked: 'parked',
  review: 'needs approval',
  stalled: 'no progress',
  done: 'done, not landed',
  landing: 'landing',
  landed: 'landed',
  conflicted: 'conflicts',
  'failed-verify': 'verify failed',
  kicked: 'kicked',
  dropped: 'dropped',
  crashed: 'crashed',
  'failed-start': 'failed to start',
};

/** the run of states whose word takes its one detail from `AgentRow.why` (the row model's only free-text cell). */
const DETAIL_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['parked', 'stalled', 'landed', 'conflicted', 'failed-verify', 'kicked', 'failed-start']);

/** §4.2: does this state's word read `AgentRow.why`? (exported so the fixtures and the table test agree on one list) */
export function usesWhy(state: AgentState): boolean {
  return DETAIL_STATES.has(state);
}

function stageWord(stage: StageName | 'idle'): string {
  return stage;
}

/**
 * §4.2, the sixteen words verbatim: `planned` → `queued` · `starting` → `starting` · `running` → `step n/m <stage>` ·
 * `paused` → `paused (you)` · `parked` → `parked (<why>)` · `review` → `needs approval` · `stalled` →
 * `no progress 11 m` · `done` → `done, not landed` · `landing` → `landing` · `landed` → `landed @<sha7>` ·
 * `conflicted` → `conflicts in <path>` · `failed-verify` → `<cmd> failed` · `kicked` → `kicked (1/1)` · `dropped` →
 * `dropped` · `crashed` → `crashed at step n (<stage>)` · `failed-start` → `failed to start (<code>)`.
 *
 * Total over the union by construction (the `switch` has no `default` and every arm returns), so a seventeenth
 * `AgentState` fails to compile here — which is the property `agents/lines.test.ts`'s table test pins.
 */
export function agentStateText(r: AgentRow): string {
  const why = r.why.trim();
  switch (r.state) {
    case 'planned':
    case 'starting':
    case 'paused':
    case 'done':
    case 'landing':
    case 'dropped':
      return AGENT_STATE_WORD[r.state];
    case 'running':
      return `step ${r.step}/${r.maxSteps} ${stageWord(r.stage)}`;
    case 'parked':
      return why === '' ? AGENT_STATE_WORD.parked : `parked (${why})`;
    case 'review':
      return 'needs approval';
    case 'stalled':
      return why === '' ? AGENT_STATE_WORD.stalled : `no progress ${why}`;
    case 'landed':
      return why === '' ? AGENT_STATE_WORD.landed : `landed @${why}`;
    case 'conflicted':
      return why === '' ? AGENT_STATE_WORD.conflicted : `conflicts in ${why}`;
    case 'failed-verify':
      return why === '' ? AGENT_STATE_WORD['failed-verify'] : `${why} failed`;
    case 'kicked':
      return why === '' ? AGENT_STATE_WORD.kicked : `kicked (${why})`;
    case 'crashed':
      return `crashed at step ${r.step} (${stageWord(r.stage)})`;
    case 'failed-start':
      return why === '' ? AGENT_STATE_WORD['failed-start'] : `failed to start (${why})`;
  }
}

// ---------------------------------------------------------------------------------------
// §4.12: the row at 40 / 80 / 120
// ---------------------------------------------------------------------------------------

/** §4.4: below this width the collapsed strip drops to `agents 3 · $0.41/0.90`; the tab's rows keep rung 3. */
export const AGENTS_MIN_COLUMNS = 40;
/** §4.12: at or above this width the row gains `$spent/cap` and the wall clock. */
export const AGENTS_SPEND_COLUMNS = 80;
/** §4.12: at or above this width the row gains the branch / verify column. */
export const AGENTS_WIDE_COLUMNS = 120;
/** §13.2 clause 6: the Ink tab's viewport — above this many rows it SCROLLS; `agentRows` still returns every row. */
export const AGENTS_TAB_ROWS = 12;

/** the slug column is padded to this many cells while the widest slug is narrower (F-54's aligned columns). */
const SLUG_COL_MAX = 16;
/** the state column is padded to this many cells at ≥ 80 (F-54: `step 4/12 propose` … `npm run lint failed`). */
const STATE_COL_MAX = 20;

function usd(x: number): string {
  return Number.isFinite(x) ? `$${Math.max(0, x).toFixed(2)}` : '$—';
}

/** §4.11 F-54's wall column: `6m`, `1h04m`, `41s`. Never negative, never `NaN`. */
export function wallText(ms: number): string {
  const n = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  const s = Math.floor(n / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/**
 * §4.12's 120-column column. `AgentRow` carries no base sha (contract 1.5's row model is slug/state/step/…/why), so
 * F-54's `jevcode/tui-rows@3f9a2c1` renders as the branch alone rather than inventing a second source for the sha —
 * see the deviation recorded in the round-5 report. A landed row shows the verification it landed on instead, which
 * is `AgentRow.verify` and is exactly what F-54's fourth line draws.
 */
export function agentTailText(r: AgentRow, g: GlyphSet): string {
  if (r.state === 'landed' && r.verify.length > 0) return r.verify.map((v) => `${v} ${g.check}`).join(` ${g.dot} `);
  if (r.branch !== null && r.branch !== '') return r.branch;
  if (r.own.length > 0) return r.own.join(' ');
  return '';
}

/** what `agentRowText` / `agentRows` / `agentStripText` need from the caller. */
export interface AgentLineOptions {
  /** the row's cell budget (the pane's width, the block's width, `Infinity` for a `--plain` pipe) */
  width: number;
  g?: GlyphSet;
  /** §12 SR column: the glyph column is replaced by the state word spoken, so a screen reader never reads `●` */
  sr?: boolean;
}

function widthOf(o: AgentLineOptions): number {
  const w = o.width;
  if (w === Number.POSITIVE_INFINITY) return AGENTS_WIDE_COLUMNS;
  return Number.isFinite(w) ? Math.max(0, Math.floor(w)) : 0;
}

/**
 * §4.2 / §4.12: one agent's row at a width — `● tui-rows  step 4/12 propose` at 40, `+ $spent/cap` and the wall at
 * 80, `+ the branch / verify column` at 120. The `slugCells` option aligns a set of rows on their widest slug; a
 * single row passes nothing and takes its own width.
 */
export function agentRowText(r: AgentRow, o: AgentLineOptions & { slugCells?: number }): string {
  const g = o.g ?? GLYPHS.unicode;
  const w = widthOf(o);
  const state = agentStateText(r);
  const slugCells = Math.min(SLUG_COL_MAX, Math.max(cellWidth(r.slug), Math.floor(o.slugCells ?? 0)));
  const slug = pad(r.slug, slugCells);
  // §12 SR twin: `●` is not spoken, the state word already carries the fact
  const head = o.sr === true ? `${slug}  ${state}` : `${agentStateGlyph(r.state, g)} ${slug}  ${state}`;
  if (w < AGENTS_SPEND_COLUMNS) return truncateCells(glyphTwin(head, g), w, g);
  const spend = `${usd(r.spendUsd)}/${usd(r.capUsd).slice(1)}`;
  const mid = `${o.sr === true ? head : `${agentStateGlyph(r.state, g)} ${slug}  ${pad(state, STATE_COL_MAX)}`} ${spend}  ${wallText(r.wallMs)}`;
  if (w < AGENTS_WIDE_COLUMNS) return truncateCells(glyphTwin(mid, g), w, g);
  const tail = agentTailText(r, g);
  return truncateCells(glyphTwin(tail === '' ? mid : `${mid}  ${tail}`, g), w, g);
}

function pad(s: string, cells: number): string {
  const n = cellWidth(s);
  return n >= cells ? s : `${s}${' '.repeat(cells - n)}`;
}

/**
 * §4.2 / §13.2 clause 6: **every** row, as `BlockRow`s — `agentRows` never filters and never caps. A row is never
 * hidden while the agent exists; the Ink tab's viewport is applied by `src/tui/pane/agents.ts`, and the `--plain`
 * twin's row count equals `rows.length`. The property test in §10 asserts that at every width.
 */
export function agentRows(rows: readonly AgentRow[], o: AgentLineOptions): BlockRow[] {
  if (rows.length === 0) return [{ kind: 'note', text: AGENTS_EMPTY }];
  const slugCells = rows.reduce((m, r) => Math.max(m, cellWidth(r.slug)), 0);
  return rows.map((r) => {
    const role = agentRowRole(r.state);
    return { kind: 'facts' as const, segments: [agentRowText(r, { ...o, slugCells })], wrap: false as const, ...(role === null ? {} : { role }) };
  });
}

/** §12.3 S60 / theme: the row's colour role — the same three-way split every other block row uses (`ok` · `warn` · `error`). */
export function agentRowRole(state: AgentState): BlockRole | null {
  switch (state) {
    case 'landed':
      return 'ok';
    case 'review':
    case 'stalled':
    case 'kicked':
      return 'warn';
    case 'conflicted':
    case 'failed-verify':
    case 'crashed':
    case 'failed-start':
      return 'error';
    default:
      return null;
  }
}

/** §4.0 / §4.3: the tab's empty state — the tab only exists while something delegates, so this is the adoption race. */
export const AGENTS_EMPTY = 'no agents in this run yet';

// ---------------------------------------------------------------------------------------
// §4.4: the collapsed strip
// ---------------------------------------------------------------------------------------

/** §4.4: what the strip counts, folded once so the strip and the `/cost` row cannot disagree. */
export interface AgentTally {
  total: number;
  live: number;
  landed: number;
  paused: number;
  failed: number;
  spendUsd: number;
  capUsd: number;
}

/** §4.4 / §4.10: the strip's counters, from the rows alone. */
export function tallyAgents(rows: readonly AgentRow[]): AgentTally {
  let live = 0;
  let landed = 0;
  let paused = 0;
  let failed = 0;
  let spendUsd = 0;
  let capUsd = 0;
  for (const r of rows) {
    spendUsd += Number.isFinite(r.spendUsd) ? r.spendUsd : 0;
    capUsd += Number.isFinite(r.capUsd) ? r.capUsd : 0;
    if (r.state === 'running' || r.state === 'starting' || r.state === 'landing') live += 1;
    else if (r.state === 'landed') landed += 1;
    else if (r.state === 'paused' || r.state === 'parked') paused += 1;
    else if (r.state === 'conflicted' || r.state === 'failed-verify' || r.state === 'crashed' || r.state === 'failed-start') failed += 1;
  }
  return { total: rows.length, live, landed, paused, failed, spendUsd, capUsd };
}

/**
 * §4.4 / §13.2 clause 5: the `✓1 ● 1 ⏸1 ✗2` cell of the strip AND of the tab's summary row, built **once** so the
 * two can never disagree (the defect: the tab printed `✓0 ● 1 ⏸0` beside a strip that reads `● 1`). A zero count is
 * OMITTED, never printed — a `✓0` cell is a bug, not a state — and an all-zero tally is the empty string.
 */
export function agentCountCells(t: AgentTally, g: GlyphSet = GLYPHS.unicode): string {
  return [t.landed > 0 ? `${g.check}${t.landed}` : '', t.live > 0 ? `${g.live} ${t.live}` : '', t.paused > 0 ? `${g.paused}${t.paused}` : '', t.failed > 0 ? `${g.cross}${t.failed}` : ''].filter((s) => s !== '').join(' ');
}

/** §4.4 / §13.2 clause 5: `dock ✓` / `dock ✗`, or the empty string when the fact is absent (omitted, never zeroed). */
export function dockCell(dock: boolean | undefined, g: GlyphSet = GLYPHS.unicode): string {
  return dock === undefined ? '' : `dock ${dock ? g.check : g.cross}`;
}

/**
 * §12.3 S61 / §4.4 / §4.11 F-55: the collapsed status-line form —
 * `agents 3 · ✓1 ● 1 ⏸1 · $0.41/0.90 · dock ✓` at 80+, `agents 3 · $0.41/0.90` at 40 (`AGENTS_MIN_COLUMNS`).
 * The segment is **not** in `DROP_ORDER` (live agents spending money are never dropped, §4.4); the text shortens
 * instead, which is why the width rungs live here and not in `status/lines.ts`.
 */
export function agentStripText(rows: readonly AgentRow[], o: AgentLineOptions & { dock?: boolean }): string {
  const g = o.g ?? GLYPHS.unicode;
  const t = tallyAgents(rows);
  if (t.total === 0) return '';
  const money = `${usd(t.spendUsd)}/${usd(t.capUsd).slice(1)}`;
  const w = widthOf(o);
  if (w < AGENTS_SPEND_COLUMNS) return glyphTwin(`agents ${t.total} ${g.dot} ${money}`, g);
  const counts = agentCountCells(t, g);
  const dock = dockCell(o.dock, g);
  return glyphTwin([`agents ${t.total}`, ...(counts === '' ? [] : [counts]), money, ...(dock === '' ? [] : [dock])].join(` ${g.dot} `), g);
}

/** §4.4: `EngineStatus.orchestration`'s six scalars — the shape the harness landed (w0-reverify §3), not a row array. */
export interface OrchestrationSummary {
  manifestId: string;
  agents: number;
  live: number;
  landed: number;
  reserveUsd: number;
  heldUsd: number;
  /**
   * §13.2 clause 5: how many children ended in a failure state. **Optional, and never derived.** `agents − live −
   * landed` counts every queued, paused and parked child as a failure — three healthy parked agents would render
   * `✗3` — so the cell is OMITTED when the fact is absent, exactly as `overshootUsd` is.
   */
  failed?: number;
}

/**
 * §12.3 S62 / §4.4: the *status* strip built from `EngineStatus.orchestration` —
 * `agents 2/3 ✓1 ✗0 · $0.41/0.90 (+$0.06)`. Three of its cells are facts this layer does not own, and §13.2
 * clause 5's rule applies to all three — **omitted, never substituted**:
 *  - `(+$…)` is OR §6.3's worst-case per-process overshoot, carried on the status object;
 *  - `✗N` is the failure count, which OR §4.6 tracks per child (never `agents − live − landed`, which labels every
 *    queued or parked child a failure);
 *  - `$spent/reserve` is the agents' **spend**, which is not `heldUsd` — a hold is money reserved and not yet
 *    spent, so printing it as spend overstates the bill. With no spend figure the money cell is dropped and the
 *    hold is named as a hold instead.
 */
export function orchestrationStripText(s: OrchestrationSummary, o: AgentLineOptions & { spendUsd?: number; failed?: number; overshootUsd?: number }): string {
  const g = o.g ?? GLYPHS.unicode;
  const over = o.overshootUsd === undefined || !Number.isFinite(o.overshootUsd) ? '' : ` (+${usd(o.overshootUsd)})`;
  const failed = o.failed ?? s.failed;
  const head = [`agents ${s.live}/${s.agents}`, `${g.check}${s.landed}`, ...(failed === undefined || !Number.isFinite(failed) ? [] : [`${g.cross}${Math.max(0, Math.floor(failed))}`])].join(' ');
  const spend = o.spendUsd;
  const money = spend === undefined || !Number.isFinite(spend) ? `held ${usd(s.heldUsd)} of ${usd(s.reserveUsd).slice(1)}` : `${usd(spend)}/${usd(s.reserveUsd).slice(1)}`;
  return glyphTwin(`${head} ${g.dot} ${money}${over}`, g);
}

// ---------------------------------------------------------------------------------------
// §4.6 / §7 rows 49–51: the four cards
// ---------------------------------------------------------------------------------------

/** §4.6: the manifest confirm's payload — the plan, plus the dirty-checkout warning §12.3 S64 spells. */
export interface ManifestCardInput {
  manifest: Manifest;
  /** the user's checkout: how many files are uncommitted, and which of them fall inside an agent's slice */
  dirty?: { files: number; inSlice: readonly string[] } | null;
  /**
   * §12.3 S63's second money cell: the **pool the reserve came from**, which OR §6.1 defines as
   * `min(sessionRemainingUsd(…) × reserveFraction, maxReserveUsd)` — it is `sessionRemainingUsd(…)`, the caller's
   * fact. It is **not** `Σ agent.capUsd`: OR §6.1 guarantees `Σ capUsd_i ≤ reserveUsd` exactly, so that sum can
   * never exceed the reserve and `reserve $0.90 of $0.90` would be the best a derived figure could ever say.
   * Absent → the ` of $Y` clause is OMITTED (§13.2 clause 5: omit, never invent).
   */
  of?: number;
}

/** §7 rows 49 / 50: the resume card's two recovery branches. */
export interface ResumeCardInput {
  rows: readonly AgentRow[];
  /** §7 row 49 (S82): `baseSha` moved since delegation */
  baseMoved?: { from: string; to: string; commits: number; by: string } | null;
  /** §7 row 50 (S83): the worktree is gone but `jevcode/<slug>` is still there — the branch is the truth */
  worktreeGone?: readonly string[];
  /** §7 row 50 tail: branch AND run dir gone → `dropped`, and no recovery is offered */
  gone?: readonly string[];
}

/** §12.3 S80 / S75 / S76 / S77: the land preview. */
export interface LandCardInput {
  rows: readonly AgentRow[];
  dockVerified?: boolean;
}

/** §12.3 S74 / §7 row 51: one child's review offer, badged so nobody approves the wrong thing. */
export interface ReviewCardInput {
  slug: string;
  /** `patch tests/test_core.py` — the action and its target, already one-lined by the caller */
  action: string;
  risk: number;
}

export type AgentCardInput =
  | ({ kind: 'manifest' } & ManifestCardInput)
  | ({ kind: 'resume' } & ResumeCardInput)
  | ({ kind: 'land-preview' } & LandCardInput)
  | ({ kind: 'review' } & ReviewCardInput);

/**
 * §12.3 S63's cells, in order: the agent count, one cell per distinct `own` glob, the reserve and the verify
 * commands. The reserve reads `of` — the pool the reserve was taken from — and drops the ` of $Y` clause when the
 * caller does not have it, the same omission the missing base sha takes (§13.2 clause 5: omit, never invent).
 */
export function manifestBodyCells(m: Manifest, of?: number): string[] {
  const globs = [...new Set(m.agents.flatMap((a) => a.own))];
  const verify = [...new Set(m.agents.flatMap((a) => a.verify))];
  const pool = of !== undefined && Number.isFinite(of) ? ` of ${usd(of)}` : '';
  const cells = [`${m.agents.length} agent${m.agents.length === 1 ? '' : 's'}`, ...globs, `reserve ${usd(m.reserveUsd)}${pool}`];
  if (verify.length > 0) cells.push(`verify: ${verify.join(', ')}`);
  return cells;
}

/** §12.3 S63: the manifest confirm's body row, verbatim — the `·`-joined form §4.12 draws at 80 and 120. */
export function manifestBodyText(m: Manifest, g: GlyphSet = GLYPHS.unicode, of?: number): string {
  return glyphTwin(manifestBodyCells(m, of).join(` ${g.dot} `), g);
}

/**
 * §4.12: the manifest confirm's body at a width. At or above `AGENTS_SPEND_COLUMNS` it is S63's one `·`-joined
 * row; **below it the cells stack, one glob per row**, which is the design's own 40-column form — the joined row
 * word-wraps mid-list there, splitting `src/tui/**` across two rows behind a trailing `·`.
 */
export function manifestBodyRows(m: Manifest, width: number, g: GlyphSet = GLYPHS.unicode, of?: number): string[] {
  const w = width === Number.POSITIVE_INFINITY ? AGENTS_WIDE_COLUMNS : Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (w >= AGENTS_SPEND_COLUMNS) return [manifestBodyText(m, g, of)];
  return manifestBodyCells(m, of).map((c) => glyphTwin(c, g));
}

/** §12.3 S64's tail names the count as a WORD (`those two`), which is the sentence the design pins; ≥ 10 keeps the digits. */
const NUMBER_WORDS: readonly string[] = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** §12.3 S64: the dirty-checkout warning — the files inside a slice, never the whole dirty set. */
export function dirtyWarningText(d: { files: number; inSlice: readonly string[] }, g: GlyphSet = GLYPHS.unicode): string {
  const n = d.inSlice.length;
  return glyphTwin(`${g.warn} your checkout has ${d.files} uncommitted file${d.files === 1 ? '' : 's'}; ${n} of them (${d.inSlice.join(', ')}) ${n === 1 ? 'is' : 'are'} inside an agent's slice ${g.dash} /land will ask you to commit or stash ${n === 1 ? 'that one' : `those ${numberWord(n)}`} before it merges`, g);
}

/**
 * §4.6: `no risk dimensions on this card — this is a proposal, not an action` (S65), the manifest card's own line.
 *
 * §13.4: the **extended** form of this sentence — the `review:why` refusal — has exactly one home, and it is
 * `REVIEW_WHY_REFUSAL` in `src/tui/review/lines.ts`, beside the `reviewWhyRefusal(req)` that is its only caller.
 * A second copy lived here through the first pass and drifted (`[Enter] approves` against the live
 * `[y] approves`), which is precisely the two-home drift §13.4's inventory exists to prevent.
 */
export const NO_RISK_DIMENSIONS = 'no risk dimensions on this card — this is a proposal, not an action';

/** §12.3 S82: `base moved 3f9a2c1 → 9d21ee0 (2 commits by you) — [r] rebase the 3 agents · [s] stage on the old base · [f] forget` */
export function baseMovedText(b: { from: string; to: string; commits: number; by: string }, agents: number, g: GlyphSet = GLYPHS.unicode): string {
  return glyphTwin(`base moved ${b.from} ${g.arrow} ${b.to} (${b.commits} commit${b.commits === 1 ? '' : 's'} by ${b.by}) ${g.dash} [r] rebase the ${agents} agent${agents === 1 ? '' : 's'} ${g.dot} [s] stage on the old base ${g.dot} [f] forget`, g);
}

/** §12.3 S83 / §7 row 50: the branch is the truth, the worktree is a cache. */
export function recreateFromBranchText(slug: string): string {
  return `[n] recreate from jevcode/${slug}`;
}

/** §7 row 50 tail: branch **and** run dir gone → `dropped`, and no recovery is offered. */
export function goneText(slug: string, g: GlyphSet = GLYPHS.unicode): string {
  return glyphTwin(`${slug}: branch and run dir are both gone ${g.dash} dropped, nothing to recover`, g);
}

/** §12.3 S81: the adoption row. */
export function adoptedText(runId: string, rows: readonly AgentRow[], g: GlyphSet = GLYPHS.unicode): string {
  const t = tallyAgents(rows);
  const parked = rows.filter((r) => r.state === 'parked').length;
  return glyphTwin(`adopted ${t.total} agent${t.total === 1 ? '' : 's'} of run ${runId} (${t.live} running, ${parked} parked) ${g.dash} /agents`, g);
}

/** §12.3 S80: the land preview's summary row. */
export function landSummaryText(rows: readonly AgentRow[], dockVerified: boolean, g: GlyphSet = GLYPHS.unicode): string {
  const t = tallyAgents(rows);
  const parked = rows.filter((r) => r.state === 'parked' || r.state === 'paused').length;
  const parts = [`${t.total} agent${t.total === 1 ? '' : 's'}: ${t.landed} landed, ${parked} parked`];
  if (dockVerified) parts.push('dock verified');
  parts.push('/land merges it here');
  return glyphTwin(parts.join(` ${g.dot} `), g);
}

/** §12.3 S74: one child's review offer. */
export function reviewOfferText(c: ReviewCardInput, g: GlyphSet = GLYPHS.unicode): string {
  return glyphTwin(`${c.slug} needs approval: ${c.action} (risk ${c.risk.toFixed(2)}) ${g.dash} [Enter] review ${g.dot} [d] decline ${g.dot} [q] leave it parked`, g);
}

/** §4.6: the badge that keeps two simultaneous approvals apart (§7 row 51) — `ConfirmRequest.badge`. */
export function agentBadge(slug: string): string {
  return `agent ${slug}`;
}

/**
 * §4.6, stated as a **hard rule, not a preference**: under `split: 'auto'` the human confirm is skipped **only**
 * when every agent in the manifest has `role: 'research'`. One code-writing agent in an otherwise-auto manifest
 * forces the ordinary `[y]` gate — a research agent cannot write code (`RESEARCH_ACTION_KINDS`), so nothing it
 * does needs a human; a `code` or `critic` agent can, so something does. An empty manifest also asks (there is
 * nothing to prove safe).
 */
export function manifestNeedsConfirm(m: Pick<Manifest, 'agents'>, split: 'off' | 'ask' | 'auto'): boolean {
  if (split !== 'auto') return true;
  return m.agents.length === 0 || !m.agents.every((a) => a.role === 'research');
}

/**
 * §4.2's fourth render target: the four cards, as `BlockRow`s. The `kind` is the input's own discriminant so `tsc`
 * narrows the payload at the call site (the design writes `agentCard(kind, …)`; one tagged parameter is the same
 * signature with the narrowing for free).
 *
 * Every card is count-stable at every width: the rows are `note` / `facts` rows and `renderBlock` wraps them, so no
 * card ever chooses between "drop a row" and "overflow" (§11 G-R5-6).
 */
export function agentCard(card: AgentCardInput, o: AgentLineOptions): BlockRow[] {
  const g = o.g ?? GLYPHS.unicode;
  switch (card.kind) {
    case 'manifest': {
      // §4.12: one `note` row per cell below 80 (the stacked form), one joined row at 80 and 120
      const rows: BlockRow[] = manifestBodyRows(card.manifest, widthOf(o), g, card.of).map((text, i) => ({ kind: 'note' as const, text, ...(i === 0 ? { flush: true as const } : {}) }));
      if (card.dirty !== undefined && card.dirty !== null && card.dirty.inSlice.length > 0) rows.push({ kind: 'note', text: dirtyWarningText(card.dirty, g), role: 'warn' });
      rows.push({ kind: 'note', text: glyphTwin(NO_RISK_DIMENSIONS, g) });
      return rows;
    }
    case 'resume': {
      const rows: BlockRow[] = agentRows(card.rows, o);
      if (card.baseMoved !== undefined && card.baseMoved !== null) rows.push({ kind: 'note', text: baseMovedText(card.baseMoved, card.rows.length, g), role: 'warn' });
      for (const slug of card.worktreeGone ?? []) rows.push({ kind: 'note', text: recreateFromBranchText(slug) });
      for (const slug of card.gone ?? []) rows.push({ kind: 'note', text: goneText(slug, g), role: 'error' });
      return rows;
    }
    case 'land-preview':
      return [...agentRows(card.rows, o), { kind: 'note', text: landSummaryText(card.rows, card.dockVerified === true, g), flush: true }];
    case 'review':
      return [{ kind: 'note', text: reviewOfferText(card, g), role: 'warn' }];
  }
}

// ---------------------------------------------------------------------------------------
// §4.7 / §7 row 48: caps are checked against the live fold, never a persisted counter
// ---------------------------------------------------------------------------------------

/**
 * §4.7 / §7 row 48: the one rule round 5 writes down so the eventual `AgentSupervisor` cannot get it wrong — a
 * resumed or adopted child counts against `orchestrate.maxAgents`, so a resume can never silently take a free slot.
 *
 * The parameter is structural on purpose: the caller passes `listSessions(fold, self)` (`src/coordination/fold.ts`)
 * and this module keeps its **zero runtime imports outside `src/tui/`** — `src/coordination/fold.js` is a value
 * module and `src/tui/plain.ts`, which imports this file, is on the first-frame path (gate G-R5-1).
 */
export interface ChildActivity {
  readonly liveness: string;
  readonly heartbeat: { readonly parentRunId: string | null };
}

/** §4.7: how many children of `parentRunId` the **fold** says are live right now. */
export function liveChildCount(sessions: readonly ChildActivity[], parentRunId: string): number {
  let n = 0;
  for (const a of sessions) if (a.heartbeat.parentRunId === parentRunId && a.liveness === 'live') n += 1;
  return n;
}

/** §4.7 / §7 row 48: may one more child start? `remaining` is never negative — an over-subscribed fold refuses. */
export function agentCapVerdict(sessions: readonly ChildActivity[], parentRunId: string, maxAgents: number): { ok: boolean; live: number; remaining: number } {
  const cap = Number.isFinite(maxAgents) ? Math.max(0, Math.floor(maxAgents)) : 0;
  const live = liveChildCount(sessions, parentRunId);
  return { ok: live < cap, live, remaining: Math.max(0, cap - live) };
}

// ---------------------------------------------------------------------------------------
// §12.3: the strings with no builder of their own (pinned here so §13.4's grep has one home)
// ---------------------------------------------------------------------------------------

/** S66 */
export function delegatedText(step: number, agents: number, g: GlyphSet = GLYPHS.unicode): string {
  return glyphTwin(`delegated at step ${step} ${g.dash} ${agents} agent${agents === 1 ? '' : 's'} starting ${g.dot} /agents (Alt+A) ${g.dot} Esc pauses the tree`, g);
}
/** S67 */
export const SPLIT_DECLINED = 'split declined; continuing single-threaded (the reason reaches the next step)';
/** S68 */
export function pauseTreeLadder(agents: number): string {
  return `pause this session: [y] tree (${agents} agent${agents === 1 ? '' : 's'} at their next step)  [Y] tree now  [t] this run only  [n] stay`;
}
/** S69 */
export function abortTreeLadder(agents: number): string {
  return `abort ${agents} agent${agents === 1 ? '' : 's'} too? [y] all  [t] this run only  [n] cancel`;
}
/** S70 */
export function pauseAckText(sent: number, acked: number, g: GlyphSet = GLYPHS.unicode): string {
  const pending = Math.max(0, sent - acked);
  return glyphTwin(`${sent} pause request${sent === 1 ? '' : 's'} sent ${g.dot} ${acked} acked ${g.dot} ${pending} pending (they finish their step)`, g);
}
/** S71 — the exit gate, reachable the moment any child exists (§4.5) */
export function exitGateLadder(agents: number, g: GlyphSet = GLYPHS.unicode): string {
  return glyphTwin(`${agents} agent${agents === 1 ? '' : 's'} live: [k] keep them running (they keep spending) ${g.dot} [e] end them ${g.dot} [n] stay`, g);
}
/** S72 — `--no-wait`'s explicit sentence; the exit code is 4 either way, which is why the sentence exists (§4.5) */
export function noWaitText(agents: number): string {
  return `delegated: ${agents} agent${agents === 1 ? '' : 's'} running; jevcode agents list follows them`;
}
/**
 * §12.3 S73 (OR §4.8): the five per-agent verb lines, one builder each. They have no supervisor and no caller in
 * this build (§4.0) — like S74 / S80–S83 / S85, which are built for the same reason: §13.4 makes a zero-match grep
 * in the pin test a **hard failure**, so every §12.3 string whose single home §13.1 gives this module is built
 * here, with its `--ascii` and SR twins, the day the module lands. The eventual `AgentSupervisor` calls them.
 */
export function pausingText(slug: string, step: number, stage: StageName | 'idle', wallMs: number, g: GlyphSet = GLYPHS.unicode): string {
  return glyphTwin(`pausing ${slug} ${g.dot} step ${step} commits first (${stageWord(stage)}, ${wallText(wallMs)})`, g);
}
/** S73 (2 of 5): the ack — the proposal is kept, so a resume replays it rather than re-proposing. */
export function pausedNowText(slug: string, step: number, stage: StageName | 'idle', g: GlyphSet = GLYPHS.unicode): string {
  return glyphTwin(`paused ${slug} now at step ${step} (${stageWord(stage)}): proposal kept ${g.dash} resume replays it`, g);
}
/** S73 (3 of 5): the resume — the replay is named, and so is the re-check, because risk is not carried forward. */
export function resumedText(slug: string, step: number, replayed: boolean): string {
  return `resumed ${slug} at step ${step} (${replayed ? 'replayed the paused proposal; risk re-checked' : 'fresh step'})`;
}
/** S73 (4 of 5): the steer ack — the queue depth and the step it lands on, never a bare "sent". */
export function steeredText(slug: string, queued: number, step: number): string {
  return `steered ${slug} (${queued} queued for its step ${step})`;
}
/** S73 (5 of 5): the budget raise — the child's cap, the session's position, and whether the raise resumed it. */
export function budgetRaisedText(slug: string, from: number, to: number, session: { spentUsd: number; capUsd: number }, resumed: boolean, g: GlyphSet = GLYPHS.unicode): string {
  const tail = resumed ? ` ${g.dash} resumed` : '';
  return glyphTwin(`${slug} cap ${usd(from)} ${g.arrow} ${usd(to)} (session ${usd(session.spentUsd)}/${usd(session.capUsd).slice(1)})${tail}`, g);
}

/** §12.3 S75: the land receipt — the dock branch, the merge commit and every verification that ran on it. */
export function landedText(slug: string, dockBranch: string, sha: string, verify: readonly { command: string; ok: boolean; tests?: number }[], g: GlyphSet = GLYPHS.unicode): string {
  const cells = verify.map((v) => `${v.command} ${v.ok ? g.check : g.cross}${v.tests === undefined ? '' : ` (${v.tests})`}`);
  return glyphTwin([`landed ${slug} into ${dockBranch} @${sha}`, ...cells].join(` ${g.dot} `), g);
}

/** §12.3 S76: the land REFUSAL — what the child removed, and the two-step override that exists for it. */
export function notLandedText(slug: string, reason: string, g: GlyphSet = GLYPHS.unicode): string {
  return glyphTwin(`${slug} not landed: ${reason} ${g.dash} /agent ${slug} land --anyway (twice) overrides`, g);
}

/** §12.3 S77: the conflict — the other child, the file, the lines, and the kick budget it spent. */
export function conflictText(slug: string, other: string, path: string, lines: { from: number; to: number }, kick: { n: number; of: number }, g: GlyphSet = GLYPHS.unicode): string {
  return glyphTwin(`${slug} conflicts with ${other} in ${path} (lines ${lines.from}${g.range}${lines.to}) ${g.dash} kicked (${kick.n} of ${kick.of})`, g);
}

/** §12.3 S78: the drop — the branch is KEPT, and the row says so, because the commits are still reachable. */
export function droppedText(slug: string, branch: string | null, commits: number): string {
  return branch === null ? `dropped ${slug} (no branch, ${commits} commit${commits === 1 ? '' : 's'} lost)` : `dropped ${slug} (branch ${branch} kept, ${commits} commit${commits === 1 ? '' : 's'})`;
}

/** §12.3 S79: the no-progress row — the evidence for the claim, then the three keys that act on it. */
export function noProgressText(slug: string, forText: string, step: number, g: GlyphSet = GLYPHS.unicode): string {
  return glyphTwin(`${slug}: no progress for ${forText} (same step ${step}, no files changed) ${g.dash} [p] pause ${g.dot} [k] kick ${g.dot} [x] drop`, g);
}

/** S85 — D-AN: every command row answers this until its store exists */
export function notAvailableText(verb: string): string {
  return `${verb} is not available in this build — no agent is running`;
}
/**
 * §12.3 S85's `<verb>` slot for the tab's own keys: the **user-facing** word of each `AgentsOp`, so the refusal
 * reads `agents drop is not available…` and never leaks the internal `dropArm` / `dropConfirm` of the `x` `x`
 * chord. `move` and `unfocus` are navigation, not verbs — they are handled before the refusal and map to
 * themselves only so the record is total (a new op is a `tsc --strict` error here, not a leaked camelCase name).
 * The type is imported **type-only**, so this module keeps its zero runtime imports outside `src/tui/`.
 */
export const AGENTS_VERB_WORD: Readonly<Record<AgentsOp, string>> = {
  move: 'move',
  attach: 'attach',
  pause: 'pause',
  steer: 'steer',
  budget: 'budget',
  diff: 'diff',
  kick: 'kick',
  dropArm: 'drop',
  dropConfirm: 'drop',
  land: 'land',
  unfocus: 'unfocus',
};
/** S86b — the focused rule row's tail, so the focus state is never invisible (§4.3) */
export function focusedTail(g: GlyphSet = GLYPHS.unicode): string {
  return glyphTwin(`[a]gents ${g.dot} Esc unfocuses`, g);
}
/** S86a — §7 row 99: focus is refused while the draft is non-empty */
export const FOCUS_REFUSED = 'finish or clear the line first — Alt+A then focuses the agents tab';
/**
 * §4.11 F-54's keys row, **widest rung first** — `fitRung` picks the widest that fits, so §4.12's table holds by
 * measurement rather than by a width constant: rung 1 (79 cells) at 120, rung 2 (73) at 80, rung 3 (56) between,
 * rung 4 (23) at 40. Every rung keeps `x x`, because the two-key drop is the safety property, not a decoration.
 */
export const AGENTS_KEYS_RUNGS: readonly string[] = [
  'Enter attach · p pause · t steer · + budget · d diff · k kick · x x drop · l land',
  'Enter · p pause · t steer · + budget · d diff · k kick · x x drop · l land',
  'Enter · p pause · t steer · d diff · x x drop · l land',
  'Enter · p · t · x x · l',
];
