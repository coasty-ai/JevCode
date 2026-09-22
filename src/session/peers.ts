/**
 * TUI-DESIGN-5 §2.3 / §2.4 (slot R5-1): the three coordination → TUI mappers and the one `/who` row builder.
 *
 * This module is the ONLY place `src/coordination/types.js` is read outside `src/cli/session.ts` (§2.3), and it
 * reads it with **`import type` only** — §2.1 rule 3a / rule 6 and gate G-R5-1: `src/cli/main.tsx` statically
 * imports `src/cli/session.ts`, which statically imports this file, so one value import here would put the whole
 * ledger/fold/claims/records tree on the argv path. The two peer *values* this module needs (`sameRepo`'s rule and
 * the holding-lease set) are therefore **re-declared against the peer's own types**, which is exactly the escape
 * rule 6 names; `test/unit/session/peers.test.ts` pins both against the facade so neither can drift.
 *
 * Nothing here does I/O, reads a clock or holds state: `fold.at` is the clock and every age is derived from it.
 */
import type { Fold, Heartbeat, Lease, SelfIdentity, SessionActivity } from '../coordination/index.js';
import type { PeerView, SelfIdentityView, SessionActivityView } from '../core/types.js';
import { type BlockRow, elideRight } from '../tui/block/lines.js';
import { cellWidth, type GlyphSet } from '../tui/glyphs.js';

// ── the two re-declared peer values (§2.1 rule 6) ─────────────────────────────────────────────────────────────────

/**
 * `src/coordination/types.ts`'s `HOLDING_LEASE_TYPES`, re-declared against `Lease['type']` so `tsc` fails the day a
 * member is renamed and `peers.test.ts` fails the day one is added or removed. `'intent'` is deliberately absent:
 * an intent does not hold, so a workspace whose only lease is an intent is `shared`, not `exclusive`.
 */
const HOLDING_TYPES: ReadonlySet<Lease['type']> = new Set<Lease['type']>(['exclusive', 'command', 'lane', 'worktree', 'takeover', 'agent']);

/** `src/coordination/ids.ts`'s `sameRepo`, re-declared (§2.1 rule 6); pinned against the facade by `peers.test.ts`. */
function sameWorkspace(a: { repoKey: string | null; remoteKey: string | null; wsKey: string }, b: { repoKey: string | null; remoteKey: string | null; wsKey: string }): boolean {
  if (a.repoKey !== null && a.repoKey === b.repoKey) return true;
  if (a.remoteKey !== null && a.remoteKey === b.remoteKey) return true;
  const aNone = a.repoKey === null && a.remoteKey === null;
  const bNone = b.repoKey === null && b.remoteKey === null;
  return (aNone || bNone) && a.wsKey === b.wsKey;
}

/** `src/coordination/fold.ts`'s `recordKeyOf` — the `fold.liveness` key. One expression, re-declared for the same reason. */
const livenessKeyOf = (hb: Pick<Heartbeat, 'deviceId' | 'runId' | 'pid'>): string => `${hb.deviceId}/${hb.runId}/${hb.pid}`;

/** `fold.origins` is keyed WITHOUT the pid (`src/coordination/fold.ts:493`). */
const originKeyOf = (hb: Pick<Heartbeat, 'deviceId' | 'runId'>): string => `${hb.deviceId}/${hb.runId}`;

// ── glyphs (§8.1 item 10 — the nine new `GlyphSet` members are R5-2's W1 commit, §9.2) ────────────────────────────

/**
 * The three round-5 `GlyphSet` members `/who` draws. `src/tui/glyphs.ts` is **R5-2's** file and its nine new members
 * land in R5-2's W1 commit (§9.3 constraint (g)); until then they are absent from the interface, so they are read
 * through this all-optional widening — a `GlyphSet` is assignable to it either way, and the day the members land
 * these reads resolve to them with **no edit here** (`string & (string | undefined)` is `string`). The fallbacks
 * spell the exact twins §8.1 item 10 pins: `●`→`*`, `○`→`o`, `◌`→`.` (S3 corrected, S60 stands).
 */
interface Round5Glyphs {
  readonly live?: string;
  readonly gone?: string;
  readonly stale?: string;
}

export interface WhoGlyphs {
  readonly live: string;
  readonly gone: string;
  readonly stale: string;
  readonly unknown: string;
  readonly dot: string;
  readonly warn: string;
}

export function whoGlyphs(g: GlyphSet): WhoGlyphs {
  const r: GlyphSet & Round5Glyphs = g;
  const ascii = g.mode === 'ascii';
  return {
    live: r.live ?? (ascii ? '*' : '●'),
    gone: r.gone ?? (ascii ? 'o' : '○'),
    stale: r.stale ?? (ascii ? '.' : '◌'),
    unknown: '?',
    dot: g.dot,
    warn: g.warn,
  };
}

// ── `/peers` — TD4 §7.10's four scalars, finally backed by the fold (§2.4) ────────────────────────────────────────

/**
 * TUI-DESIGN-5 §2.4: `SessionHost.peers?()`'s answer, folded from `fold.live` / `fold.gone` / `fold.forks`,
 * `fold.liveness`, `fold.leases` and `fold.origins`.
 *
 * The privacy contract is load-bearing and unchanged (`PeerView` is a count, a count, an age and a boolean): no pid,
 * no path, no device label leaves this function — §7 row 61, asserted by `peers.test.ts`'s property test.
 *
 * - `live` counts **this session too** (TD4's `<n> here`; `peersText` renders nothing at `live <= 1`).
 * - `stale` is `stale` ∪ `stale-reused-pid` ∪ `gone`; `unknown` ("not synced yet") is neither — absence is not death.
 * - `oldestStartedMsAgo` and `exclusive` are **peer** facts and skip this session's own record: the user does not
 *   need to be told they are holding their own lease.
 * - Rows from an ignored device are skipped entirely (they are in `fold.ignored`, never in `live`/`gone`), and rows
 *   from another workspace are skipped by `sameWorkspace`.
 */
export function peerViewOf(fold: Fold, self: SelfIdentity): PeerView {
  let live = 0;
  let stale = 0;
  let oldest: number | null = null;
  let exclusive = false;
  const counted = new Set<string>();
  const holders = new Set<string>();

  const consider = (hb: Heartbeat): void => {
    const key = livenessKeyOf(hb);
    if (counted.has(key)) return;
    if (!sameWorkspace(hb.repo, self)) return;
    counted.add(key);
    const verdict = fold.liveness.get(key) ?? 'unknown';
    if (verdict === 'live') live += 1;
    else if (verdict !== 'unknown') stale += 1;
    if (isSelfRecord(fold, hb, self)) return;
    holders.add(`${hb.deviceId}/${hb.runId}`);
    const started = Date.parse(hb.startedAt);
    if (Number.isFinite(started)) {
      const age = Math.max(0, fold.at.wallMs - started);
      if (oldest === null || age > oldest) oldest = age;
    }
  };

  for (const hb of fold.live.values()) consider(hb);
  for (const list of fold.forks?.values() ?? []) for (const hb of list) consider(hb);
  for (const hb of fold.gone.values()) consider(hb);

  for (const lease of fold.leases.values()) {
    if (lease.released !== undefined) continue;
    if (!HOLDING_TYPES.has(lease.type)) continue;
    if (!holders.has(`${lease.deviceId}/${lease.runId}`)) continue;
    exclusive = true;
    break;
  }
  return { live, stale, oldestStartedMsAgo: oldest, exclusive };
}

/**
 * §2.1 rule 4: "is this mine?" is the fold's READ LOCATION (`Fold.origins`), never `record.deviceId ===
 * self.deviceId` — that comparison is the forged-record hole CO's revisions 4/5 closed (§7 row 17). A record is
 * *this session's own* when it was read from the local subtree AND it is this run.
 */
function isSelfRecord(fold: Fold, hb: Pick<Heartbeat, 'deviceId' | 'runId'>, self: SelfIdentity): boolean {
  if (self.runId === null) return false;
  return fold.origins.get(originKeyOf(hb))?.self === true && hb.runId === self.runId;
}

// ── the two views (§8.1 item 4) ───────────────────────────────────────────────────────────────────────────────────

/**
 * TUI-DESIGN-5 §8.1 item 4: `SessionActivity` (+ its `Heartbeat`) → the TUI-facing `SessionActivityView`.
 *
 * Three derivations the design's own field list gets wrong against the built `Heartbeat` (recorded in
 * `docs/research/tui/round-5/w0-reverify.md` §5 item 7), each pinned by `peers.test.ts`:
 *   - `spend.totalUsd` is `sessionUsd ?? generatorUsd + jevUsd` — the beat has no `totalUsd`;
 *   - `bench.done` / `.tasks` are `bench.tasks.done` / `bench.tasks.total` — the beat nests them;
 *   - `subwork: null` means **truncated away** (§15.1 Q20) and is keyed off `Heartbeat.truncated`, never off an
 *     empty array: an empty `subwork` means "none" and renders `lanes 0 · samples 0`.
 */
export function activityView(a: SessionActivity): SessionActivityView {
  const hb = a.heartbeat;
  const spend = hb.spend;
  const bench = hb.bench;
  return {
    runId: a.runId,
    sessionId: a.sessionId,
    label: a.label,
    parentSessionId: a.parentSessionId,
    deviceId8: a.deviceId.slice(0, 8),
    sameDevice: a.sameDevice,
    kind: a.kind,
    liveness: a.liveness,
    authority: a.authority,
    flags: {
      hung: a.flags.hung,
      skewed: a.flags.skewed,
      forked: a.flags.forked,
      takenOver: a.flags.takenOver,
      noLock: a.flags.noLock,
      ignoredDevice: a.flags.ignoredDevice,
      unverified: a.flags.unverified,
      cloned: a.flags.cloned,
    },
    beatAgeMs: a.beatAgeMs,
    arrivalAgeMs: a.arrivalAgeMs,
    skewMs: a.skewMs,
    syncLagMs: a.syncLagMs,
    sameRepo: a.sameRepo,
    sameBranch: a.sameBranch,
    leaseCount: a.leases.length,
    step: hb.step,
    maxSteps: hb.maxSteps,
    stage: hb.stage,
    mode: hb.mode,
    branch: hb.repo.branch,
    head: hb.repo.head,
    ctxPct: hb.context.pct,
    spend: { totalUsd: spend.sessionUsd ?? spend.generatorUsd + spend.jevUsd, capUsd: spend.capUsd },
    editing: hb.touched?.files ?? [],
    subwork: hb.truncated === true ? null : countSubwork(hb.subwork),
    bench: bench === undefined ? null : { benchId: bench.benchId, done: bench.tasks.done, tasks: bench.tasks.total, lanes: bench.lanes },
  };
}

function countSubwork(entries: readonly { kind: 'sample' | 'lane' | 'probe' | 'child' }[]): { lanes: number; samples: number; probes: number; children: number } {
  let lanes = 0;
  let samples = 0;
  let probes = 0;
  let children = 0;
  for (const e of entries) {
    if (e.kind === 'lane') lanes += 1;
    else if (e.kind === 'sample') samples += 1;
    else if (e.kind === 'probe') probes += 1;
    else children += 1;
  }
  return { lanes, samples, probes, children };
}

/**
 * TUI-DESIGN-5 §8.1 item 4 / §7 row 61: `SelfIdentity` → `SelfIdentityView`. `SelfIdentity` carries `hostKey`, a
 * device-secret derivative, and must never reach a JSON sink — this view is what `sessions who --json` emits.
 *
 * It takes the fold as a second argument because `sameDeviceCount` is a **fold** fact (how many rows the fold read
 * from this device's own subtree), not an identity field; §8.1 item 10 spells the mapper `selfView(s)` and the extra
 * argument is recorded as a deviation in the slot report.
 */
export function selfView(self: SelfIdentity, fold: Fold): SelfIdentityView {
  const seen = new Set<string>();
  const consider = (hb: Heartbeat): void => {
    if (fold.origins.get(originKeyOf(hb))?.self !== true) return;
    seen.add(livenessKeyOf(hb));
  };
  for (const hb of fold.live.values()) consider(hb);
  for (const list of fold.forks?.values() ?? []) for (const hb of list) consider(hb);
  return { deviceId8: self.deviceId.slice(0, 8), label: self.label, sameDeviceCount: seen.size };
}

// ── `/who` — one pure builder, four render targets (§2.3) ─────────────────────────────────────────────────────────

/** §12.1 S8. */
export const WHO_EMPTY = 'no other jevcode is working here — /who --all includes sessions gone more than 10 minutes';

/** §12.1 S9 — `Fold.skipped` is the count of devices past `MAX_DEVICES` (16), §7 row 11. */
export function foldCapNotice(skipped: number): string {
  return `${skipped} device${skipped === 1 ? '' : 's'} past the fold cap — jevcode sessions gc lists them`;
}

/**
 * §12.1 S7 — `who · 3 live, 1 gone`.
 *
 * `stale` is its OWN clause, never folded into `gone`: §14.2 #58 split S3b (`○ gone`) from S3 (`◌ stale`) exactly
 * because a session whose process may still be there is not a session that ended, and a header that calls it gone
 * contradicts the row under it. With no stale row the string is S7 verbatim, so the pin holds.
 */
export function whoHeader(rows: readonly SessionActivityView[], g: GlyphSet): string {
  let live = 0;
  let stale = 0;
  let gone = 0;
  for (const r of rows) {
    if (r.liveness === 'live') live += 1;
    else if (r.liveness === 'gone') gone += 1;
    else if (r.liveness !== 'unknown') stale += 1;
  }
  return `who ${g.dot} ${live} live, ${stale > 0 ? `${stale} stale, ` : ''}${gone} gone`;
}

/** §2.3: the eight flag suffixes, in a fixed order; `⚠` is `g.warn` so `--ascii` gets `!` (§12.1 S10). */
export function flagSuffixes(row: SessionActivityView, g: GlyphSet): string[] {
  const w = g.warn;
  const out: string[] = [];
  if (row.flags.hung) out.push(`${w} hung`);
  if (row.flags.skewed) out.push(`${w} skewed ${Math.round(Math.abs(row.skewMs ?? 0) / 1000)}s`);
  if (row.flags.forked) out.push(`${w} forked`);
  if (row.flags.takenOver) out.push('taken over');
  if (row.flags.noLock) out.push('no lock');
  if (row.flags.ignoredDevice) out.push('ignored');
  if (row.flags.unverified) out.push('unverified');
  if (row.flags.cloned) out.push(`${w} cloned`);
  return out;
}

/** `2 s` · `4 m` · `3 h` · `2 d`; the `beat 2 s` and `last beat 4 m ago` cells of S1/S3. */
export function shortAge(ms: number): string {
  const v = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (v < 60_000) return `${Math.floor(v / 1000)} s`;
  if (v < 3_600_000) return `${Math.floor(v / 60_000)} m`;
  if (v < 86_400_000) return `${Math.floor(v / 3_600_000)} h`;
  return `${Math.floor(v / 86_400_000)} d`;
}

function usd(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '?';
}

/**
 * §12.1 S1's SR cell is `spent 12 cents of 2 dollars`, not `spent 0.12 of 2.00 dollars`: a screen reader saying
 * "zero point one two" for twelve cents is the kind of literal transliteration §7 row 82 exists to prevent.
 */
function spokenMoney(n: number): string {
  if (!Number.isFinite(n)) return 'an unknown amount';
  const v = Math.max(0, n);
  if (v < 1) {
    const cents = Math.round(v * 100);
    return `${cents} cent${cents === 1 ? '' : 's'}`;
  }
  const dollars = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return `${dollars} dollar${dollars === '1' ? '' : 's'}`;
}

/** the liveness glyph of a row (`●` live/hung · `◌` stale · `○` gone · `?` unknown). */
function livenessGlyph(row: SessionActivityView, wg: WhoGlyphs): string {
  switch (row.liveness) {
    case 'live':
      return wg.live;
    case 'gone':
      return wg.gone;
    case 'unknown':
      return wg.unknown;
    default:
      return wg.stale;
  }
}

/**
 * §2.3's column ladder, dropped **right to left** as the block narrows:
 * `lanes · samples` → `editing …` → `$spend` → `ctx` → `mode` → `branch@sha`. The widths are the block's, so the
 * same ladder runs in the TUI, in `--plain` and in `transcript.log` (§13).
 *
 * The top rung keeps **nine** cells: a run row HAS nine (`whoCells`), and §2.14 consequence 1 makes the ninth —
 * `lanes 2 · samples 3` — the only place the heartbeat's `subwork` is ever rendered. `blockWidth(120) = 110`, so
 * 110 is "the 120-column form" (§2.3's own numbers are terminal columns; `whoRows` takes the BLOCK width, which is
 * what both sinks pass).
 */
const CELL_DROP_WIDTH: readonly { readonly width: number; readonly keep: number }[] = [
  { width: 110, keep: 9 },
  { width: 100, keep: 8 },
  { width: 88, keep: 7 },
  { width: 76, keep: 6 },
  { width: 64, keep: 5 },
  { width: 52, keep: 4 },
  { width: 0, keep: 3 },
];

/** the widest rung's `keep` — a run row's cell count, asserted against `whoCells` by `peers.test.ts`. */
export const WHO_CELLS_MAX = 9;

export function keptCells(width: number): number {
  for (const r of CELL_DROP_WIDTH) if (width >= r.width) return r.keep;
  return 3;
}

/**
 * §12.1 S1's **column order**, as indices into `whoCells`' DROP order. The two orders are deliberately different
 * and both are load-bearing: cells drop right-to-left in `whoCells`' order (so the 40-column form is
 * `● mbp  step 7/40 propose  beat 2 s`, §2.3), and the kept cells are then drawn in S1's order — label, branch,
 * step, mode, ctx, spend, editing, lanes, **beat last**. An earlier draft rebuilt the array cell-for-cell and so
 * reordered nothing (§14.2, round-5 fix pass finding 22).
 */
const WHO_DISPLAY_ORDER: readonly number[] = [0, 3, 1, 4, 5, 6, 7, 8, 2];

/**
 * TUI-DESIGN-5 §2.3, S1/S2: the cells of one `/who` row, widest form first. `head` is clipped to 7 characters so
 * S1's `main@3f9a2c1` is exact; the full sha stays in the view for `--json`.
 */
export function whoCells(row: SessionActivityView, wg: WhoGlyphs, label = row.label): string[] {
  const dot = wg.dot;
  const glyph = livenessGlyph(row, wg);
  if (row.kind === 'bench') {
    const b = row.bench;
    const id = b === null ? row.runId.slice(0, 8) : b.benchId;
    const tasks = b === null ? '' : `${b.done}/${b.tasks} tasks`;
    const lanes = b === null ? '' : `live ${row.subwork?.lanes ?? 0} ${dot} lanes ${b.lanes}`;
    return [`${glyph} ${label}`, `bench ${id}`, tasks, lanes];
  }
  const cells: string[] = [`${glyph} ${label}`];
  cells.push(row.step === null ? 'step —' : `step ${row.step}/${row.maxSteps ?? '?'}${row.stage === null ? '' : ` ${row.stage}`}`);
  cells.push(`beat ${shortAge(row.beatAgeMs)}`);
  cells.push(row.branch === null ? '' : `${row.branch}${row.head === null ? '' : `@${row.head.slice(0, 7)}`}`);
  cells.push(row.mode ?? '');
  cells.push(row.ctxPct === null ? '' : `ctx ${Math.round(row.ctxPct)}%`);
  cells.push(row.spend === null ? '' : `$${usd(row.spend.totalUsd)}/${usd(row.spend.capUsd)}`);
  cells.push(editingCell(row));
  cells.push(row.subwork === null ? '' : `lanes ${row.subwork.lanes} ${dot} samples ${row.subwork.samples}`);
  return cells;
}

/**
 * §2.3: two devices may carry one label (the default is the hostname, and `sessions label` does not police
 * uniqueness), and a row that says only `mbp` when two `mbp`s are live is a lie. When a label is carried by more
 * than one `deviceId8` — **counting this session's own device**, which is why the builder takes `self` — every
 * occurrence of it is qualified `mbp#3f9a…`, the form §12.1 S40 already pins. A unique label is never decorated.
 */
export function labelResolver(rows: readonly SessionActivityView[], self: SelfIdentityView): (row: SessionActivityView) => string {
  const devices = new Map<string, Set<string>>();
  const note = (label: string, deviceId8: string): void => {
    const set = devices.get(label);
    if (set === undefined) devices.set(label, new Set([deviceId8]));
    else set.add(deviceId8);
  };
  note(self.label, self.deviceId8);
  for (const r of rows) note(r.label, r.deviceId8);
  return (row) => ((devices.get(row.label)?.size ?? 1) > 1 ? `${row.label}#${row.deviceId8}` : row.label);
}

function editingCell(row: SessionActivityView): string {
  const files = row.editing;
  if (files.length === 0) return '';
  const first = files[0] ?? '';
  return files.length === 1 ? `editing ${first}` : `editing ${first} (+${files.length - 1})`;
}

/**
 * §2.3's column ladder applied: the cells this row SHOWS at `width`, already in §12.1 S1's display order.
 *
 * Dropping happens in `whoCells`' order (right to left, so `● mbp  step 7/40 propose  beat 2 s` survives at 40);
 * drawing happens in `WHO_DISPLAY_ORDER` (so the widest form is S1 verbatim, `beat` last). A bench row is a
 * different row shape (§7 row 12) with four cells of its own and no ladder.
 */
export function whoShownCells(row: SessionActivityView, wg: WhoGlyphs, width: number, label = row.label): string[] {
  const cells = whoCells(row, wg, label);
  if (row.kind === 'bench') return cells.filter((c) => c !== '');
  // the first three cells (glyph+label, step, beat) are the 40-column form and are never dropped
  const keep = Math.max(3, keptCells(width));
  const out: string[] = [];
  for (const i of WHO_DISPLAY_ORDER) {
    if (i >= keep) continue;
    const cell = cells[i];
    if (cell !== undefined && cell !== '') out.push(cell);
  }
  return out;
}

/**
 * §13 / §13.2 clause 1: **the** `/who` row text, at a width — the ONE producer behind the Ink block, `--plain`,
 * `transcript.log` and `jevcode sessions who`. It is deliberately a finished line rather than a `table` row:
 * `renderBlock`'s table pass keeps at most `tableColumns(tier)` = 4/3/2/1 columns (`src/tui/block/lines.ts:311`),
 * so a nine-cell `table` row lost five cells in the TUI and none in the CLI twin — the identity rule §13 states
 * broken by construction (round-5 fix pass, blocker 1). The block rows below carry this string through
 * `{ kind: 'facts', wrap: false }`, which `renderBlock` documents as "the PRE-BUILT line form … never re-wrapped".
 *
 * In the screen-reader glyph set the row IS the sentence (§12.1 S1–S5's SR column, §14.2 #60), so `whoSentence`
 * finally has a sink.
 */
export function whoRowText(row: SessionActivityView, opts: { width: number; g: GlyphSet; label?: string }): string {
  const g = opts.g;
  const width = Math.max(1, Math.floor(Number.isFinite(opts.width) ? opts.width : 1));
  const label = opts.label ?? row.label;
  if (g.mode === 'sr') return whoSentence(row, label);
  const joined = whoShownCells(row, whoGlyphs(g), width, label).join('  ');
  return cellWidth(joined) <= width ? joined : elideRight(joined, width, g);
}

/**
 * §12.1 S10: the dim flag row under a flagged row, indented two cells and clipped to the width in BOTH sinks —
 * the CLI wrote it with no width at all, so an eight-flag row (~90 cells) overflowed a 40-column terminal
 * (gate G-R5-6). `null` when the row carries no flag, and in the SR set (where `whoSentence` already speaks them).
 */
export function whoFlagRow(row: SessionActivityView, opts: { width: number; g: GlyphSet }): string | null {
  const g = opts.g;
  if (g.mode === 'sr') return null;
  const flags = flagSuffixes(row, g);
  if (flags.length === 0) return null;
  const width = Math.max(1, Math.floor(Number.isFinite(opts.width) ? opts.width : 1));
  const text = `  ${flags.join(` ${g.dot} `)}`;
  return cellWidth(text) <= width ? text : elideRight(text, width, g);
}

/**
 * §2.3's one pure builder. Cells drop right-to-left as `width` shrinks and the identity rule holds by construction
 * (`whoRowText` is the only producer, §13); each flagged row keeps its dim suffix row, and a flagged row is
 * **never hidden** (§7 row 13).
 *
 * §7 row 11 phrases the fold-cap notice as a `/who --all` behaviour, so BOTH branches gate it on `all` and
 * `sessionsWho` follows the same rule — the same fold state printed different things in the two sinks before.
 */
export function whoRows(rows: readonly SessionActivityView[], self: SelfIdentityView, opts: { all?: boolean; width: number; g: GlyphSet; skipped?: number }): BlockRow[] {
  const g = opts.g;
  const width = Math.max(1, Math.floor(Number.isFinite(opts.width) ? opts.width : 1));
  const out: BlockRow[] = [];
  const skipped = opts.skipped ?? 0;
  const capNotice = (): void => {
    if (skipped > 0 && opts.all === true) out.push({ kind: 'note', flush: true, text: foldCapNotice(skipped) });
  };
  if (rows.length === 0) {
    out.push({ kind: 'note', flush: true, text: WHO_EMPTY });
    capNotice();
    return out;
  }
  const label = labelResolver(rows, self);
  for (const row of rows) {
    out.push({ kind: 'facts', wrap: false, segments: [whoRowText(row, { width, g, label: label(row) })] });
    const flags = whoFlagRow(row, { width, g });
    if (flags !== null) out.push({ kind: 'facts', wrap: false, segments: [flags], role: 'dim' });
  }
  capNotice();
  return out;
}

/**
 * §7 row 82 / §12.1 S1–S5: the screen-reader sentence of one row — every fact the sighted row carries, in words.
 * §14.2 #60: the draft's twin dropped `jev+llm` and `lanes · samples`, giving the SR user strictly less.
 */
export function whoSentence(row: SessionActivityView, label = row.label): string {
  const parts: string[] = [label];
  parts.push(livenessWord(row));
  if (row.kind === 'bench') {
    const b = row.bench;
    if (b !== null) {
      parts.push(`bench ${b.benchId}`, `${b.done} of ${b.tasks} tasks`, `${row.subwork?.lanes ?? 0} live`, `${b.lanes} lanes`);
    }
    return parts.join(', ');
  }
  if (row.branch !== null) parts.push(row.head === null ? row.branch : `${row.branch} at ${row.head.slice(0, 7)}`);
  if (row.step !== null) parts.push(`step ${row.step} of ${row.maxSteps ?? 'unknown'}${row.stage === null ? '' : ` ${row.stage}`}`);
  if (row.mode !== null) parts.push(`mode ${row.mode.replace(/\+/g, ' plus ').replace(/-/g, ' ')}`);
  if (row.ctxPct !== null) parts.push(`context ${Math.round(row.ctxPct)} percent`);
  if (row.spend !== null) parts.push(`spent ${spokenMoney(row.spend.totalUsd)} of ${spokenMoney(row.spend.capUsd)}`);
  if (row.editing.length > 0) parts.push(`editing ${row.editing.length} file${row.editing.length === 1 ? '' : 's'}`);
  if (row.subwork !== null) parts.push(`${row.subwork.lanes} lanes and ${row.subwork.samples} samples`);
  parts.push(`last beat ${shortAge(row.beatAgeMs).replace(' s', ' seconds').replace(' m', ' minutes').replace(' h', ' hours').replace(' d', ' days')} ago`);
  for (const f of flagSuffixesPlain(row)) parts.push(f);
  return parts.join(', ');
}

function livenessWord(row: SessionActivityView): string {
  switch (row.liveness) {
    case 'live':
      return row.flags.hung ? 'live but no beat, possibly hung' : 'live';
    case 'stale':
      return 'stale';
    case 'stale-reused-pid':
      return 'stale, the process id was reused';
    case 'gone':
      return 'gone';
    default:
      return 'unknown, not synced yet';
  }
}

function flagSuffixesPlain(row: SessionActivityView): string[] {
  const out: string[] = [];
  if (row.flags.skewed) out.push(`clock skewed ${Math.round(Math.abs(row.skewMs ?? 0) / 1000)} seconds`);
  if (row.flags.forked) out.push('forked');
  if (row.flags.takenOver) out.push('taken over');
  if (row.flags.noLock) out.push('no lock');
  if (row.flags.ignoredDevice) out.push('ignored device');
  if (row.flags.unverified) out.push('unverified');
  if (row.flags.cloned) out.push('cloned device');
  return out;
}

/**
 * The `--plain` / `transcript.log` twin of one `/who` row: the SAME text the TUI drew, at the same width (§13) —
 * it is literally `whoRowText`, so the two cannot drift.
 *
 * `label` is REQUIRED context, not decoration: when two devices carry one label the TUI row reads `mbp#aaaaaaaa`
 * and a twin that re-read `row.label` printed a bare `mbp`, which §2.3 calls a lie. Callers build the resolver
 * once over their rows (`labelResolver(rows, self)`) and pass its answer.
 */
export function whoPlainRow(row: SessionActivityView, opts: { width: number; g: GlyphSet; label?: string }): string {
  return whoRowText(row, opts);
}
