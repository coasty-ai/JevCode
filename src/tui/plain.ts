/**
 * Plain (non-Ink) renderer plus the transcript-item model shared by the TUI's <Static>
 * pane, the plain renderer and the engine's transcript.log (DESIGN.md §10, TUI-DESIGN §15.1).
 * `itemsFromEvent` is the single item source: transcript.log, `--plain` and the TUI stay
 * line-for-line identical for the whole of a run. This module is ink-free (Node built-ins and
 * pure `lines()` modules only) so the engine can import `itemsFromEvent` / `formatTranscriptItem`
 * without pulling in ink/react.
 */
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  Action,
  ActionOutcome,
  AgentRow,
  ConfirmOutcome,
  Confirmer,
  ConfirmRequest,
  Engine,
  EngineEvent,
  JudgeResult,
  NoticeKind,
  Renderer,
  RendererOptions,
  SecretHit,
  SessionHost,
  StepRecord,
  UiConfig,
  UiLabel,
} from '../core/types.js';
import { DEFAULT_COMPLETE_THRESHOLD, MODE_BADGE_WORD } from '../config/defaults.js';
import { isReplyOnlyRun } from '../core/agent-run.js';
import { AbortError } from '../errors.js';
import { createTerminalStreamSanitizer, stripTerminalControls, type TerminalStreamSanitizer } from '../core/ansi.js';
import { clip, firstLine } from '../core/text.js';
import { METER_RED_PCT } from '../core/limits.js';
import { formatDuration } from '../core/time.js';
import { MIN_SECRET_LENGTH, detectSecrets as detectSecretsByPattern, patternRedact } from '../core/redact.js';
import { gitBannerLine, headDriftWarning, headMoved } from '../workspace/gitstate.js';
// TUI-DESIGN-4 §6.1 / §6.2 (D-Z): the one edit summariser, and the PURE line diff (§14.2 review item 13 — the
// `undo/diff.ts` entry point pulls `node:fs/promises`, `checkpoint/images.ts`, `sandbox/paths.ts` and
// `workspace/git.ts` in behind `unifiedDiff`, and this module is on the first-frame path of every sink)
import { unifiedDiff } from './diff/text.js';
import { editSummary, editTargetText, type EditSummary } from './diff/summary.js';
import type { ColorRole } from './theme.js';
import { budgetItems } from './budget/lines.js';
// TUI-DESIGN §14.1 / §24: `--ascii` substitutes the glyph table on stdout only (glyphs.ts imports plain.ts's hoisted `sanitizeStream`; the cycle is safe: both use the other inside functions)
import { GLYPHS, glyphSet, glyphTwin, type GlyphSet } from './glyphs.js';
import { RETRY_SLOW_MS, blockingRowsStructured } from './blocking/lines.js';
import { REVIEW_KEYS_80, isProposalConfirm, reviewDiffLines, reviewHeaderLines } from './review/lines.js';
import { gatePlainPrompt, secretAckText } from './secrets/gate-lines.js';
// TUI-DESIGN-5 §13.1: the agent tree's single row producer (pure, `import type` only from the contract shapes)
import { AGENTS_WIDE_COLUMNS, agentRowText, agentRows } from './agents/lines.js';
import { blockTexts, blockWidth } from './block/lines.js';

// ---------------------------------------------------------------------------------------
// Transcript items
// ---------------------------------------------------------------------------------------

export type TranscriptKind =
  | 'run:start'
  | 'run:ready'
  | 'intent'
  | 'context'
  | 'synth'
  | 'proposal'
  | 'risk'
  | 'confirm:resolved'
  | 'outcome'
  | 'judge'
  | 'plan'
  | 'loop:tripped'
  | 'replan'
  | 'transcript'
  | 'error'
  | 'run:end'
  // contract 1.1 (TUI-DESIGN §15 item 19): the engine items of §15.1's item table
  | 'steer:queued'
  | 'steer:applied'
  | 'steer:withdrawn'
  | 'pause'
  | 'budget'
  | 'retry'
  | 'notice'
  | 'workspace'
  | 'blocking'
  | 'secret-ack'
  | 'ui'
  // contract 1.2 (TUI-DESIGN-2 §6 item 17, §4.5): the one-line step summary (`step:end`) and the `[you]` / `[jevcode]` bubbles (§3.10)
  | 'step'
  | 'chat'
  // AGENT-LOOP-DESIGN §9.4: one read-only agent tool result (`tool · read_file src/a.ts (lines 1-120) · 3 ms`) — the full view,
  // transcript.log and `--plain`; the compact TUI hides it (the step row summarises the batch)
  | 'tool';

/**
 * TUI-DESIGN-5 D-AG — the `context:warn` row, word-for-word the `ctx` status cell at its amber/red form
 * (`src/tui/context/lines.ts` `ctxText`): the WORD beside the percent, then the action, so `NO_COLOR`, `--ascii`
 * and a screen reader read the same crossing a colour would have shown. Built here from `METER_RED_PCT` rather
 * than by importing `context/lines.ts`, which would drag `src/loop/context/**` into the item formatter's static
 * import graph (the §14.2 item 13 gate); `plain.test.ts` pins this string equal to `ctxText`'s at every percent.
 */
export function contextWarnItemText(pct: number): string {
  return `ctx ${pct}% ${pct >= METER_RED_PCT ? 'red' : 'amber'}${SEP}/compact now`;
}

/** TUI-DESIGN-2 §4.5: the stage kinds the TUI's `compact` transcript hides (stamped `hidden: true` at append time); every sink still writes them */
export const COMPACT_HIDDEN_KINDS: ReadonlySet<TranscriptKind> = new Set<TranscriptKind>(['intent', 'context', 'synth', 'proposal', 'risk', 'outcome', 'judge', 'plan', 'run:ready', 'tool']);

/** `dim` is the quiet startup grade (the `[sandbox]` / `recent:` / `[setup] mode` one-liners): the TUI paints the body dim, every line sink prints it unchanged. */
export type TranscriptLevel = 'info' | 'warn' | 'error' | 'dim';

/** One immutable transcript row. `text` is one logical line; `detail` is a TUI-only body (scrollback). */
export interface TranscriptItem {
  readonly key: string;
  readonly seq: number;
  readonly step: number | null;
  readonly kind: TranscriptKind;
  readonly level: TranscriptLevel;
  readonly text: string;
  /** risk items carry the verdict so the TUI colours them like the decisions pane */
  readonly verdict?: 'ok' | 'review' | 'block';
  /** multi-line body shown under the line in the TUI only (never in plain / transcript.log) */
  readonly detail?: string;
  /** TUI-DESIGN §15 item 19 / §15.1: a renderer-local item (no engine live): printed by --plain and the TUI, never in transcript.log */
  readonly local?: boolean;
  /** TUI-DESIGN §15 item 19 / §15.1: printed instead of stepLabel(); only notice kind 'ui' and local items set it */
  readonly label?: UiLabel;
  /** TUI-DESIGN-2 §4.5 / §6 item 17: hidden by the TUI's `compact` transcript (stamped at append time); `--plain` and transcript.log ignore it */
  readonly hidden?: boolean;
  /**
   * contract 1.7 item 1 (TUI-DESIGN-4 §3.1.3, §6.4): the TUI's pre-split form of `detail` — already-rendered rows
   * with the colour role each takes. `detail: string` STAYS and is what `--plain`, `--json` and `clipDetail` use, so
   * this is a default-preserving widening: a producer that sets neither member behaves exactly as before.
   */
  readonly detailRows?: readonly { readonly text: string; readonly role: ColorRole }[];
  /** contract 1.7 item 1 (§6.4): `'diff'` routes the detail through `diffRows`; absent means `'text'`. Never sniffed — only a declared kind routes. */
  readonly detailKind?: 'diff' | 'table' | 'text';
  /**
   * AGENT-LOOP-DESIGN §9.4 / §A1 (TUI only): a `[jevcode]` row of the agent's streamed prose. The TUI draws it with the
   * reply block's own renderer (`proseRows`: light markdown, the prefix-stable wrap, no row cap, no 600-char clip), so the
   * committed rows are the rows the live reply drew. Absent on every other item, and never read by `--plain` or
   * transcript.log, which print `formatTranscriptItem(item)` as always.
   */
  readonly prose?: ProseInfo;
}

/**
 * AGENT-LOOP-DESIGN §9.4: how the TUI draws one prose item. `line` is the WHOLE source line (the item's `text` is the part
 * it shows); `[from, to)` is the display range of that line this item draws — absent for a whole line, set when an
 * overflow commit split a line that outgrew the reply block into a head (`to`) and a continuation (`from`, drawn with no
 * label and no spacer, hanging under the head). `partial` marks the reply block's still-streaming last line.
 */
export interface ProseInfo {
  readonly role: 'text' | 'code' | 'fence';
  readonly line: string;
  readonly from?: number;
  readonly to?: number;
  readonly partial?: true;
}

/**
 * OWNER ADDENDUM (2026-09): the two run-header items the INTERACTIVE transcript does not print — `[run] started · <badge> ·
 * <task>` and `[run] git <branch> · <state>`; `--plain`, `--json` and transcript.log keep them. Here (not in Transcript.tsx,
 * which re-exports it) so the reducer can find the last VISIBLE item the reply block's first row is spaced against.
 */
export function isRunHeaderItem(item: Pick<TranscriptItem, 'kind' | 'text'>): boolean {
  if (item.kind === 'run:start') return true;
  return item.kind === 'workspace' && /^git\b/.test(item.text);
}

/** TUI-DESIGN-2 §3.10: the two bubble labels; an item carrying one is of kind `chat` in every sink */
export function isChatLabel(label: UiLabel | undefined): label is '[you]' | '[jevcode]' {
  return label === '[you]' || label === '[jevcode]';
}

/** Caps keeping every transcript line bounded no matter what the generator or a command emits. */
export const TRANSCRIPT_TEXT_MAX = 600;
export const TRANSCRIPT_DETAIL_MAX_LINES = 60;
export const TRANSCRIPT_DETAIL_MAX_CHARS = 6000;
const TASK_MAX = 160;
const LIST_MAX = 5;
/** TUI-DESIGN-4 §3.6: the `replan` item names `task impossible <p>` only from this probability up. */
export const REPLAN_IMPOSSIBLE_MIN = 0.5;

/**
 * Drop escape sequences WHOLE (`core/ansi.ts`), then every other control character, keeping line structure (\t, \n,
 * \r). Applied to raw generator deltas and command output before they reach any terminal, so an escape sequence produced
 * by a command or by the generator cannot clear the screen, move the cursor or write the clipboard, and leaves no body
 * behind (`[33m✓[39m`). Foreign text only: never run it over the renderer's own styled output. A stream that arrives in
 * chunks uses `createTerminalStreamSanitizer`, so a sequence split between two chunks is held, not half-stripped.
 */
export function sanitizeStream(s: string): string {
  return stripTerminalControls(s);
}

/** Collapse a string onto one line and drop control characters (a command's escape codes must never reach the terminal raw). */
export function oneLine(s: string): string {
  // sequences first, while the line breaks still bound them (an unterminated OSC hides the rest of its line, no more)
  return sanitizeStream(s).replace(/\r\n|\r|\n/g, ' ⏎ ').replace(/\t/g, ' ');
}

export function p2(x: number): string {
  return Number.isFinite(x) ? x.toFixed(2) : 'nan';
}
export function usd(x: number): string {
  return Number.isFinite(x) ? `$${x.toFixed(3)}` : '$nan';
}
export function kTokens(n: number): string {
  if (!Number.isFinite(n)) return 'nan';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * TUI-DESIGN-4 §3.7 (the R2 guard): the run-frame anchors, **glyph-agnostic** and exported by name so
 * `src/perf/pty.ts`, `test/pty/helpers.ts` and `scripts/pty/polish-check.mjs` import them instead of hard-coding a
 * `·` that silently stops matching in every `--ascii` capture. `Transcript.tsx:90` renders every item through
 * `glyphTwin`, and `glyphs.ts:116` `dot: '·'` vs `:168` `dot: '-'`, so an `--ascii` capture carries
 * `finished - complete - 4 steps`. A zero-match anchor is a hard failure, never a vacuous pass.
 */
/**
 * Written as an ALTERNATION, never a bracket class. The same source string is compiled by three engines: JS
 * `RegExp` (UTF-16), Tcl ARE (`drive.exp`, characters) and **Python `re` over BYTES** (`perf/drivers/pty_type.py`,
 * which matches the raw pty capture). `·` is U+00B7 = two UTF-8 bytes, so `[·-]` in a bytes regex is the one-byte
 * class `{0xC2, 0xB7, 0x2D}` and can never match the two-byte `·` followed by a space.
 *
 * MEASURED 2026-09-22: with the bracket form, every perf scenario that waits for `[run] started`
 * matched nothing on a **unicode** capture and everything on an `--ascii` one — `composer live`,
 * `composer live-stress`, `composer review` and five `states` scenarios reported `0/200 keys` and exit 124 after
 * a 20 s wait for a row that had been on screen for 20 s. `(?:·|-)` is one character in all three engines.
 */
export const GLYPH_DOT_CLASS = '(?:·|-)';
/** the word the `[run] started` row opens with (no glyph) */
export const RUN_STARTED_WORD = 'started';
/** the word the `[run] finished` row opens with (no glyph) */
export const RUN_FINISHED_WORD = 'finished';
/** `src/perf/pty.ts:804` `RUN_STARTED_PATTERN`'s tail — `<SGR>` is the caller's own insertion before `\\[run\\]` */
export const RUN_STARTED_TAIL_PATTERN = `${RUN_STARTED_WORD} ${GLYPH_DOT_CLASS} `;
/** `src/perf/pty.ts:800` `END_PATTERN` — `finished · complete · 4 steps` in either glyph set */
export const RUN_END_PATTERN = `${RUN_FINISHED_WORD} ${GLYPH_DOT_CLASS} [a-z_]+ ${GLYPH_DOT_CLASS} \\d+ steps`;
/** `scripts/pty/polish-check.mjs:397` V17's run-end anchor, as a named constant */
export const RUN_END_RE = new RegExp(`^ {0,9}\\[run\\] ${RUN_FINISHED_WORD} ${GLYPH_DOT_CLASS} `);
/** the `[run] started` anchor over a stripped capture row */
export const RUN_STARTED_RE = new RegExp(`^ {0,9}\\[run\\] ${RUN_STARTED_TAIL_PATTERN}`);

export function stepLabel(step: number | null): string {
  return step === null ? '[run]' : `[step ${step}]`;
}

export interface ActionDescription {
  kind: Action['kind'];
  /** path, command, paths or summary: what the action touches */
  target: string;
  /** the body a reviewer wants to see (old/new, content, diff, command); '' for read */
  preview: string;
}

/** TUI-DESIGN-4 §3.6 / §12: ` · ` is the ONE inline separator of an engine item (`glyphTwin` renders it ` - ` under `--ascii`). */
export const SEP = ' · ';
/** §6.1: the target of an edit action is cut to this many cells before it reaches a one-line item. */
export const EDIT_TARGET_CELLS = 60;

/**
 * TUI-DESIGN-4 §6.1 / §6.2 (D-Z, A6-2): the reviewable body of an edit action as a **unified diff**, so the review
 * card, the `<Static>` detail body, `--plain`'s `printRequest` and `/copy proposal` all show signs, hunks and line
 * numbers instead of two whole blobs labelled `--- old` / `+++ new`. `null` for an action that is not an edit, and
 * for an `edit` whose two sides are identical (the caller then keeps its own text).
 */
export function actionDiffText(a: Action): string | null {
  if (a.kind === 'patch') return a.diff.trim() === '' ? null : a.diff;
  if (a.kind === 'edit') {
    const rows = unifiedDiff(a.old, a.new, { aPath: `a/${a.path}`, bPath: `b/${a.path}` });
    return rows.length === 0 ? null : rows.join('\n');
  }
  if (a.kind === 'write') {
    // a write is a pure addition: `/dev/null` on the old side is exactly what git emits for a new file
    const rows = unifiedDiff('', a.content, { aPath: '/dev/null', bPath: `b/${a.path}` });
    return rows.length === 0 ? null : rows.join('\n');
  }
  return null;
}

export function describeAction(a: Action): ActionDescription {
  switch (a.kind) {
    case 'read':
      return { kind: a.kind, target: a.paths.slice(0, LIST_MAX).join(', ') + (a.paths.length > LIST_MAX ? ` (+${a.paths.length - LIST_MAX})` : ''), preview: '' };
    case 'edit':
    case 'write':
    case 'patch': {
      // §6.1 (A6-1): every edit action names its files and counts — a `patch` used to read `18 line unified diff`
      const summary = editSummary(a);
      const fallback = a.kind === 'patch' ? `${a.diff.split('\n').length} line unified diff` : a.path;
      const target = summary === null ? fallback : editTargetText(summary, EDIT_TARGET_CELLS);
      return { kind: a.kind, target: target === '' ? fallback : target, preview: actionDiffText(a) ?? (a.kind === 'write' ? a.content : a.kind === 'patch' ? a.diff : `--- old\n${a.old}\n+++ new\n${a.new}`) };
    }
    case 'run':
      return { kind: a.kind, target: `$ ${firstLine(a.command)}`, preview: a.command };
    case 'done':
      return { kind: a.kind, target: firstLine(a.summary), preview: a.summary };
  }
}

/** §6.4: the declared detail kind of a proposal's body — `'diff'` for the three edit kinds, absent for `read` / `run` / `done`. */
export function actionDetailKind(a: Action): 'diff' | 'text' | undefined {
  return a.kind === 'edit' || a.kind === 'write' || a.kind === 'patch' ? 'diff' : undefined;
}

export function actionLabel(a: Action): string {
  const d = describeAction(a);
  return clip(oneLine(`${d.kind} ${d.target}`), 200);
}

/** TUI-DESIGN-4 §6.5 item 3: a diff block's body may be far longer than a note's, bounded only by this. */
export const TRANSCRIPT_DIFF_DETAIL_MAX_CHARS = 200_000;

/**
 * Bounded, terminal-safe multi-line detail (TUI scrollback body and the readline confirmer's preview).
 *
 * TUI-DESIGN-4 §6.5 item 3 (A6-5): the 60-line clip is the **default**, not a law — `/diff --all`, documented as
 * lifting the 40-row cap, was silently re-capped at 60 here. A caller that knows its own cap passes `maxLines`
 * (`Infinity` for `--all`) and, for a diff block, the raised `maxChars`.
 */
export function clipDetail(s: string, opts: { maxLines?: number; maxChars?: number } = {}): string {
  const maxLines = opts.maxLines === undefined || Number.isNaN(opts.maxLines) ? TRANSCRIPT_DETAIL_MAX_LINES : Math.max(1, Math.floor(Math.min(opts.maxLines, Number.MAX_SAFE_INTEGER)));
  const maxChars = opts.maxChars === undefined || !Number.isFinite(opts.maxChars) ? TRANSCRIPT_DETAIL_MAX_CHARS : Math.max(1, Math.floor(opts.maxChars));
  const lines = sanitizeStream(s.replace(/\r\n|\r/g, '\n')).split('\n');
  let out = lines.length > maxLines ? `${lines.slice(0, maxLines).join('\n')}\n…[${lines.length - maxLines} lines omitted]` : lines.join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…`;
  return out;
}

/** §3.6: the engine writes `read 3 file(s)`; the item says `read 3 files` (and `read 1 file`). */
export function pluraliseCounts(summary: string): string {
  return summary.replace(/\b(\d+) ([a-z]+)\(s\)/g, (_, n: string, word: string) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`);
}

/** §3.6: `12 kB` / `840 B` — the context row's size, rounded, never `12.0kB`. */
export function formatSizeShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '? B';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const kb = bytes / 1000;
  return kb < 10 ? `${kb.toFixed(1)} kB` : `${Math.round(kb)} kB`;
}

/** One `<dim>: …; dominant level <k> "<text>"; …` clause of a `RiskAssessment.reason` (§3.6 edge 9 keeps the reason itself untouched). */
export interface RiskReasonClause {
  dim: string;
  level: number;
  text: string;
}

/**
 * §3.6 / §3.7 G3–G4: read the dominant-dimension clauses **out of** `RiskAssessment.reason` instead of interpolating
 * the whole 200-character string into the scrollback. `reason` itself is untouched — it is stored in
 * `decisions.jsonl`, returned in `RunResult` and fed back to the generator, so changing it would change model
 * behaviour and every bench baseline (edge 9).
 */
export function parseRiskReason(reason: string): RiskReasonClause[] {
  const out: RiskReasonClause[] = [];
  const re = /([a-z_]+): [^;]*; dominant level (\d+) "([^"]*)"/g;
  let m = re.exec(reason);
  while (m !== null) {
    out.push({ dim: m[1] ?? '', level: Number(m[2]), text: (m[3] ?? '').trim() });
    m = re.exec(reason);
  }
  return out;
}

/** §3.6: the level text a one-row outcome / risk summary quotes, clipped. */
export const RISK_LEVEL_TEXT_CELLS = 80;
/** §3.6: the `outcome blocked/declined/failed` summary quotes at most this much of the level text. */
export const OUTCOME_LEVEL_TEXT_CELLS = 60;

/** The shape `riskItemText` and `outcomeSummaryText` both read: just enough of a `RiskAssessment` to name a dimension. */
export interface RiskDims {
  dims: Record<string, { risk: number; level: number }>;
  reason: string;
}

/**
 * §3.6 / §14.2 review item 14: the ONE dominant-dimension selection. `risk` and the `outcome blocked` row one line
 * below it must name the same dimension; they used to agree only because `assessRisk` happens to emit the at-max
 * clauses first (`src/jev-modes/stages/risk.ts:274–284`), so any future reason whose first clause is not the at-max
 * dimension would have produced two contradicting rows. The dimension comes from `dims` (the numbers), the level
 * and its text from the matching clause of `reason` (the words).
 */
export function dominantRiskClause(risk: RiskDims): { dim: string; level: number; text: string } | null {
  let dom = '';
  let best = Number.NEGATIVE_INFINITY;
  for (const [dim, d] of Object.entries(risk.dims)) {
    if (Number.isFinite(d.risk) && d.risk > best) {
      best = d.risk;
      dom = dim;
    }
  }
  const clauses = parseRiskReason(risk.reason);
  // `assessRisk` writes one clause per **at-max** dimension, so a clause naming `dom` is the right one. When the
  // two disagree (a tie the dims order breaks differently, or a reason from an older run) the CLAUSE wins whole —
  // dimension, level and text together — because naming `dom` beside another dimension's level text is the one
  // outcome that is worse than either answer on its own.
  const match = clauses.find((c) => c.dim === dom);
  const clause = match ?? clauses[0];
  if (clause !== undefined) return { dim: clause.dim, level: clause.level, text: clause.text };
  if (dom === '') return null;
  return { dim: dom, level: risk.dims[dom]?.level ?? 0, text: '' };
}

/**
 * §3.6 (D-V, the row that removes the last `k=v` from the scrollback): `blocked · destructive 2 · "<level text>"`
 * instead of the whole `RiskAssessment.reason` — which carried `matches_intent=0.08` and repeated, verbatim and 200
 * characters long, the `risk` row printed one line above it. The full reason becomes the item's TUI-only `detail`.
 *
 * Only `blocked` and `declined` come through here: both carry a `RiskAssessment.reason`, so the clip is safe — the
 * clipped clause repeats the `risk` row printed one line above. `failed` carries `outcome.error`, which is §6.7's
 * patch diagnosis and appears **nowhere else** in `transcript.log` or `--plain` (§14.2 review item 6).
 */
export function outcomeSummaryText(status: 'blocked' | 'declined', raw: string, risk?: RiskDims): string {
  const clause = risk !== undefined ? dominantRiskClause(risk) : null;
  const first = clause ?? parseRiskReason(raw)[0] ?? null;
  if (first !== null && first.dim !== '') return `${status}${SEP}${first.dim} ${first.level}${SEP}"${clip(first.text, OUTCOME_LEVEL_TEXT_CELLS)}"`;
  return `${status}${SEP}"${clip(oneLine(raw).trim(), OUTCOME_LEVEL_TEXT_CELLS)}"`;
}

/**
 * §3.6 / §6.7 / §14.2 review item 6: a `failed` outcome keeps its **whole** diagnosis. `outcome.error` is not a
 * `RiskAssessment.reason`; it is the two-message text §6.7 builds (`patch failed: calc/ops.py:12 — patch does not
 * apply; calc/io.py:4 — patch does not apply`, 88 characters), and `transcript.log` and `--plain` have no `detail`
 * to fall back on, so a 60-cell clip cut §6.7's second message — the whole point of `PATCH_ERROR_MESSAGES_MAX = 2`
 * — off in the only place a `--plain` user ever sees it. The item's own `TRANSCRIPT_TEXT_MAX` is the bound.
 */
export function outcomeFailedText(error: string): string {
  return `failed${SEP}"${oneLine(error).trim()}"`;
}

function outcomeText(o: ActionOutcome, risk?: RiskDims): { text: string; level: TranscriptLevel; detail?: string } {
  switch (o.status) {
    case 'executed': {
      // §3.6: `done · <summary> · exit 0 · 10ms · 1 file (a.py)` — the duplicated `exit 0 (exit 0, 10ms)` collapses
      const parts = [`done`, pluraliseCounts(o.summary)];
      if (o.exec) {
        // an agent command's summary is often its exit status already (`exit 1`): say it once (`done · exit 1 · exit 1` in --plain)
        const exit = `exit ${o.exec.exitCode ?? 'null'}`;
        if (!parts[1]!.split(SEP).includes(exit)) parts.push(exit);
        if (o.exec.killedBy) parts.push(`killed by ${o.exec.killedBy}`);
        if (o.exec.truncated) parts.push('output truncated');
        if (o.exec.orphans.length > 0) parts.push(`${o.exec.orphans.length} orphan pids`);
        parts.push(formatDuration(o.exec.durationMs));
      }
      if (o.changedFiles.length > 0) {
        const names = o.changedFiles.slice(0, LIST_MAX).join(', ') + (o.changedFiles.length > LIST_MAX ? `, +${o.changedFiles.length - LIST_MAX}` : '');
        parts.push(`${o.changedFiles.length} file${o.changedFiles.length === 1 ? '' : 's'} (${names})`);
      }
      return { text: parts.join(SEP), level: o.exec && !o.exec.ok ? 'warn' : 'info' };
    }
    case 'noop':
      return { text: `done${SEP}${pluraliseCounts(o.summary)}`, level: 'info' };
    case 'blocked':
      return { text: outcomeSummaryText('blocked', o.reason, risk), level: 'warn', detail: o.reason };
    case 'declined':
      return { text: outcomeSummaryText('declined', o.reason, risk), level: 'warn', detail: o.reason };
    case 'failed':
      // §6.7: the diagnosis, whole — it is nowhere else in transcript.log or `--plain` (the `detail` is TUI-only)
      return { text: outcomeFailedText(o.error), level: 'warn', detail: o.error };
    case 'interrupted':
      return { text: `interrupted${o.exec?.signal ? `${SEP}signal ${o.exec.signal}` : ''}`, level: 'warn' };
  }
}

/** §3.6: `judge 0.90 · no tests · 0 of 0 claims accepted · complete 0.05` — six `k=v` pairs become four sentences. */
function judgeText(judge: JudgeResult | null, completion: number | null): string {
  const c = completion === null ? 'n/a' : p2(completion);
  if (judge === null) return `judge skipped${SEP}complete ${c}`;
  let tests = 'no tests';
  if (judge.tests) {
    tests =
      judge.tests.source === 'parsed'
        ? `tests ${judge.tests.passed}p/${judge.tests.failed}f/${judge.tests.errors}e ${judge.tests.allPassed ? 'pass' : 'fail'}`
        : `tests judged ${p2(judge.tests.allPassed)}`;
  }
  const accepted = judge.doneClaims.filter((d) => d.accepted).length;
  return `judge ${p2(judge.succeeded)}${SEP}${tests}${SEP}${accepted} of ${judge.doneClaims.length} claims accepted${SEP}complete ${c}`;
}

function quoteList(xs: readonly string[]): string {
  return xs
    .slice(0, LIST_MAX)
    .map((x) => `"${clip(oneLine(x), 80)}"`)
    .join('; ');
}

/** TUI-DESIGN-4 §3.6: `synth · rank · top candidate \`return 2\` · 12 candidates, 3 tested`; counts only when present. */
export function synthText(e: Extract<EngineEvent, { type: 'synth' }>): string {
  const counts: string[] = [];
  if (e.candidates !== undefined) counts.push(`${e.candidates} candidates`);
  if (e.tested !== undefined) counts.push(`${e.tested} tested`);
  return `synth${SEP}${e.phase}${SEP}${e.detail}${counts.length > 0 ? `${SEP}${counts.join(', ')}` : ''}`;
}

/** TUI-DESIGN-4 §3.6: `steer queued · step 8 · "<text>" · 1 waiting` — the queue length after this steer. */
export function steerQueuedText(e: Extract<EngineEvent, { type: 'steer:queued' }>): string {
  return `steer queued${SEP}step ${e.step}${SEP}"${e.text}"${SEP}${e.queued} waiting`;
}

/** TUI-DESIGN §24: `steer applied to step S (N directives; superseded: <text ≤ 80>)`; the superseded clause only when something was. */
export function steerAppliedText(e: Extract<EngineEvent, { type: 'steer:applied' }>): string {
  const n = `${e.count} directive${e.count === 1 ? '' : 's'}`;
  const superseded = e.superseded.length > 0 ? `${SEP}superseded ${e.superseded.map((s) => `"${clip(oneLine(s), 80)}"`).join(', ')}` : '';
  return `steer applied${SEP}step ${e.step}${SEP}${n}${superseded}`;
}

/**
 * TUI-DESIGN §13.1 / §15.1: the one `warning:` line a retry chain earns when it failed or lasted longer than
 * `RETRY_SLOW_MS` — `warning: <side> retry chain: N attempts over Ts — <short>`; null otherwise (a quick recovery is pane-only).
 */
export function retrySettledText(e: Extract<EngineEvent, { type: 'retry:settled' }>): string | null {
  if (e.ok && e.totalWaitMs <= RETRY_SLOW_MS) return null;
  const times = `${e.attempts} time${e.attempts === 1 ? '' : 's'}`;
  const short = e.ok ? 'recovered' : 'gave up';
  return `warning${SEP}${e.side} retried ${times} over ${formatDuration(Math.max(0, e.totalWaitMs))} — ${short}`;
}

/** TUI-DESIGN §13.3 / §24: the blocking pane's reason row as the transcript item (the keys stay in the pane). */
export function blockingRequestText(e: Extract<EngineEvent, { type: 'blocking:request' }>): string {
  return `blocking: ${blockingRowsStructured(e.request).title.join(' · ')}`;
}

/** TUI-DESIGN §13.3: `blocking <id> resolved: <answer>` (` (auto)` when the jev-unreachable timer answered). */
export function blockingResolvedText(e: Extract<EngineEvent, { type: 'blocking:resolved' }>): string {
  return `blocking ${e.id} resolved: ${e.answer}${e.auto ? ' (auto)' : ''}`;
}

/**
 * TUI-DESIGN §24 "Engine items": the notice kinds whose `text` is already the documented line (`[run] seeded from run <id>: …`,
 * `checkpoint degraded: <code> on <file>`, `resumed on <oid8>, run started on <oid8> — …`, `run <id> is in use by pid …`, the
 * offline/online, sandbox, instructions, config and pricing sentences); they print bare. `ui` is labelled by `annotate()`.
 */
export const BARE_NOTICE_KINDS: ReadonlySet<NoticeKind> = new Set<NoticeKind>(['offline', 'online', 'checkpoint:degraded', 'checkpoint:restored', 'sandbox', 'drift', 'seeded', 'instructions', 'config', 'pricing', 'lock']);

/**
 * §3.6 (D-V, G3): the `risk` item in ONE row. `ok` names the two harm levels (`risk 0.01 ok · destructive 0 ·
 * irreversible 0`, which used to cost **8 terminal rows**); `review` / `block` name the dominant dimension, quote
 * its level text and point at `/why`. The whole audit string becomes the item's TUI-only `detail`.
 */
export function riskItemText(risk: { dims: Record<string, { risk: number; level: number }>; risk: number; verdict: 'ok' | 'review' | 'block'; reason: string }, step: number | null): string {
  const head = `risk ${p2(risk.risk)} ${risk.verdict}`;
  if (risk.verdict === 'ok') {
    const harm = ['destructive', 'irreversible'].map((dim) => `${dim} ${risk.dims[dim]?.level ?? 0}`);
    return `${head}${SEP}${harm.join(SEP)}`;
  }
  // §14.2 review item 14: the same selector the `outcome blocked` row one line below uses
  const clause = dominantRiskClause(risk);
  const dom = clause?.dim ?? '';
  const level = clause?.level ?? 0;
  const quoted = clause === null || clause.text === '' ? '' : ` "${clip(clause.text, RISK_LEVEL_TEXT_CELLS)}"`;
  const why = step === null ? '' : `${SEP}/why s${step}.risk.${dom}`;
  return `${head}${SEP}${dom} ${level}${quoted}${why}`;
}

/**
 * §3.6 (D-V, G2): the `plan` item is emitted **only when a count changed** since the last one (the first plan of a
 * run always emits) — today it is byte-identical on every step. The "last counts" live here rather than in a
 * renderer because all three sinks must agree; the `WeakMap` makes the decision **per event object**, so the two
 * callers that see the same bus event in one process (`useEngine.tsx:649` and `session.ts:1504`) take the same
 * branch instead of the second one deciding "unchanged" because the first advanced the counter.
 */
const planDecision = new WeakMap<object, boolean>();

/**
 * §14.2 review item 15: the "last plan counts" state, **per event stream**. Contract 1.5 landed child engines that
 * run in the same process as the parent, so a module-level singleton let an interleaved child `plan` event with the
 * same counts suppress the parent's, and let the child's `run:start` reset the parent's baseline. A caller that
 * drives more than one engine passes its own state; `itemsFromEvent(e, seq)` with no state uses the process-wide
 * one, which is what every single-engine caller has always had.
 */
export interface ItemStreamState {
  /** the run each `plan` key belongs to, cleared at `run:end` so a long session does not grow one entry per run */
  readonly planKeys: Map<string, string>;
  /** the run id of the most recent `run:start` seen **on this stream** — what a `plan` event (which carries none) belongs to */
  runId: string;
  /**
   * AGENT-LOOP-DESIGN §9.4: the agent runs seen on this stream. Their finish step's `proposal` (`done <summary>`) and `noop`
   * outcome repeat the prose the `[jevcode]` rows already carry — S6 live `--plain` printed the final answer three times — so
   * those two items are not made; the step row (`done · verified`, wall time, cost) stays. Never pruned at `run:end`: the
   * sinks that share a stream read one event after another, and a session holds few runs.
   */
  readonly agentRuns?: Set<string>;
}

export function createItemStreamState(): ItemStreamState {
  return { planKeys: new Map<string, string>(), runId: '', agentRuns: new Set<string>() };
}

/** the current run of this stream is an agent run (§9.4) */
function inAgentRun(state: ItemStreamState): boolean {
  return state.agentRuns?.has(state.runId) === true;
}

const defaultStreamState = createItemStreamState();

function planEmits(e: Extract<EngineEvent, { type: 'plan' }>, key: string, state: ItemStreamState): boolean {
  const seen = planDecision.get(e);
  if (seen !== undefined) return seen;
  const emits = state.planKeys.get(state.runId) !== key;
  state.planKeys.set(state.runId, key);
  planDecision.set(e, emits);
  return emits;
}

/**
 * Transcript items for one engine event (0, 1 or a few; kinds per §10 and TUI-DESIGN §15.1's item table).
 * `seq` is the caller's monotonic counter for the first item produced; keys are `${step}:${kind}:${seq + i}`.
 * Events that feed the panes only (decision, status, stage:*, deltas, exec:output, retry, checkpoint, ...) yield [].
 */
export function itemsFromEvent(e: EngineEvent, seq: number, state: ItemStreamState = defaultStreamState): TranscriptItem[] {
  let n = 0;
  const one = (step: number | null, kind: TranscriptKind, text: string, level: TranscriptLevel = 'info', extra: { verdict?: 'ok' | 'review' | 'block'; detail?: string; label?: UiLabel; detailKind?: 'diff' | 'table' | 'text' } = {}): TranscriptItem => {
    const s = seq + n;
    n += 1;
    return {
      key: `${step ?? 'run'}:${kind}:${s}`,
      seq: s,
      step,
      kind,
      level,
      text: clip(oneLine(text), TRANSCRIPT_TEXT_MAX),
      ...(extra.verdict ? { verdict: extra.verdict } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
      ...(extra.label ? { label: extra.label } : {}),
      ...(extra.detailKind ? { detailKind: extra.detailKind } : {}),
    };
  };
  const make = (step: number | null, kind: TranscriptKind, text: string, level: TranscriptLevel = 'info', extra: { verdict?: 'ok' | 'review' | 'block'; detail?: string; label?: UiLabel; detailKind?: 'diff' | 'table' | 'text' } = {}): TranscriptItem[] => [one(step, kind, text, level, extra)];
  switch (e.type) {
    case 'run:start': {
      // §3.6 (G1): `started · jev+llm · <task>`; the run id moves to the epilogue and `/status`
      state.runId = e.runId;
      state.planKeys.delete(e.runId);
      if (e.mode === 'agent') state.agentRuns?.add(e.runId);
      // §14.2 review item 18: ` · ` is the ONE inline separator of an engine item, and `MODE_BADGE_WORD['llm-jev']`
      // is `llm+jev · verified`, so the badge would smuggle a second one into a row whose grammar forbids it — a
      // reader (and a grep) would see four segments. The badge is flattened for this row only; the console's own
      // badge is untouched.
      const badge = (MODE_BADGE_WORD[e.mode] ?? e.mode).split(SEP).join(' ');
      const resumed = e.resumedFromStep !== null ? `resumed at step ${e.resumedFromStep}${SEP}` : '';
      return make(null, 'run:start', `${RUN_STARTED_WORD}${SEP}${badge}${SEP}${resumed}${clip(oneLine(e.task), TASK_MAX)}`);
    }
    case 'run:ready':
      // §3.6 (G1): deleted as an item — the kind stays for `--json` and `useEngine`. Saves one row and one id per run
      return [];
    case 'intent':
      return make(e.step, 'intent', `intent${SEP}${e.intent}${SEP}${p2(e.probability)} (confidence ${p2(e.confidence)})${e.answer !== e.intent ? `${SEP}Jev answered ${e.answer}` : ''}`);
    case 'context': {
      if (e.files.length === 0) return make(e.step, 'context', `context${SEP}nothing to read of ${e.candidates} candidates`);
      const names = `${e.files.slice(0, LIST_MAX).join(', ')}${e.files.length > LIST_MAX ? ` (+${e.files.length - LIST_MAX})` : ''}`;
      return make(e.step, 'context', `context${SEP}${e.files.length} of ${e.candidates} files${SEP}${formatSizeShort(e.bytes)}${SEP}${names}`);
    }
    case 'synth':
      // jev-only synthesizer progress: one line per event, so it lands in transcript.log like every other item
      return make(e.step, 'synth', synthText(e));
    case 'proposal': {
      // AGENT-LOOP-DESIGN §9.4: an agent finish proposal is the streamed prose again (see `ItemStreamState.agentRuns`)
      if (e.proposal.action.kind === 'done' && inAgentRun(state)) return [];
      // §3.6 (G2, G7): `proposal · edit a.py +12 −3 · "<goal>"`; the plan counts move to the `plan` item, which already carries them
      const d = describeAction(e.proposal.action);
      const goal = oneLine(e.proposal.goal).trim();
      // an agent observe step of read-only commands has no file to name: `proposal · read · "bash cat a.txt"`, not `read  ·`
      const text = `proposal${SEP}${d.kind}${d.target === '' ? '' : ` ${d.target}`}${goal === '' ? '' : `${SEP}"${goal}"`}`;
      const kind = actionDetailKind(e.proposal.action);
      return make(e.step, 'proposal', text, 'info', { ...(d.preview ? { detail: clipDetail(d.preview) } : {}), ...(kind !== undefined ? { detailKind: kind } : {}) });
    }
    case 'risk':
      // §3.6 (G3): one row; the audit string is the item's TUI-only detail (the `reason` itself is untouched, edge 9)
      return make(e.step, 'risk', riskItemText(e.risk, e.step), e.risk.verdict === 'block' ? 'warn' : 'info', { verdict: e.risk.verdict, detail: clipDetail(e.risk.reason) });
    case 'confirm:resolved':
      // §3.6 (G5): `review declined · "<note>"` — the confirm id is machine-only (it is in decisions.jsonl)
      return make(e.step, 'confirm:resolved', `review ${e.aborted ? 'aborted' : e.approved ? 'approved' : 'declined'}${e.note ? `${SEP}"${e.note}"` : ''}`, e.aborted ? 'warn' : 'info');
    case 'outcome': {
      // AGENT-LOOP-DESIGN §9.4: an agent finish's `noop` outcome is the streamed prose again
      if (e.outcome.status === 'noop' && inAgentRun(state)) return [];
      // a failed model turn: the `error` row says what failed, and the step row says the turn failed — no `propose:` row
      if (e.outcome.status === 'failed' && e.outcome.error.startsWith('propose: ') && inAgentRun(state)) return [];
      const o = outcomeText(e.outcome);
      return make(e.step, 'outcome', o.text, o.level, o.detail !== undefined ? { detail: clipDetail(o.detail) } : {});
    }
    case 'judge':
      return make(e.step, 'judge', judgeText(e.judge, e.completion));
    case 'plan': {
      // §3.6 (G2): `plan · 1 done · 2 remaining`, emitted only when a count changed since the last plan item
      const p = e.plan;
      const key = `${p.done.length}/${p.remaining.length}/${p.unverified.length}/${p.openProblems.length + p.harnessProblems.length}/${e.rejectedDone.join('\u0000')}`;
      if (!planEmits(e, key, state)) return [];
      let text = `plan${SEP}${p.done.length} done${SEP}${p.remaining.length} remaining`;
      if (e.rejectedDone.length > 0) text += `${SEP}rejected ${quoteList(e.rejectedDone)}`;
      return make(e.step, 'plan', text, e.rejectedDone.length > 0 ? 'warn' : 'info');
    }
    case 'loop:tripped':
      return make(e.step, 'loop:tripped', `loop${SEP}the same step repeated ${e.occurrences} times${SEP}${e.signature}`, 'warn');
    case 'replan': {
      // §3.6 (G5): `replan · change approach · 0.61 (confidence 0.50) · "<text>"`; the impossible figure only at ≥ 0.50
      const move = e.directive.move.replace(/_/g, ' ');
      const impossible = e.directive.taskImpossible >= REPLAN_IMPOSSIBLE_MIN ? `${SEP}task impossible ${p2(e.directive.taskImpossible)}` : '';
      return make(e.step, 'replan', `replan${SEP}${move}${SEP}${p2(e.directive.probability)} (confidence ${p2(e.directive.confidence)})${impossible}${SEP}"${oneLine(e.directive.text).trim()}"`, 'warn');
    }
    case 'transcript':
      // §3.6 / §3.7 G1 (D-V): the `stop:` line is DELETED as an item — `[run] finished · <reason> · …` already says
      // it, and the same stop used to be stated three times in three consecutive rows (A3 §2.9). The design put the
      // deletion at `src/loop/stop.ts:56`, but the engine keeps emitting the line, so the drop lands here instead,
      // in the ONE formatter §3.6 names first — one place, not four. Every sink §3.7 lists reads this
      // function — transcript.log (`src/loop/engine.ts:1981`), `--plain`, the TUI and the session controller — so
      // the four stay identical, and `--json` consumers, which read EVENTS and never item text, are untouched.
      // The hunk owed to `stop.ts` is a cosmetic follow-up (the event would then carry ''), not a behaviour change.
      return e.text.trim() === '' || STOP_LINE_RE.test(e.text) ? [] : make(e.step, 'transcript', e.level === 'info' ? e.text : `${e.level}: ${e.text}`, e.level);
    case 'error':
      return make(e.step, 'error', `error ${e.error.code}: ${e.error.message}${e.fatal ? ' (fatal)' : ''}`, 'error');
    case 'notice':
      // contract 1.1 (TUI-DESIGN §15.1 / §24 "Engine items"): a labelled notice (Engine.annotate) prints `<label> <text>`; the engine's own
      // kinds already emit self-describing texts (`seeded from run …`, `checkpoint degraded: …`, `run <id> is in use …`) and print bare;
      // `notice <kind>: <text>` is the fallback for a kind that does not describe itself (an unlabelled `ui`, or one from a newer engine).
      // TUI-DESIGN-2 §3.10: a `[you]` / `[jevcode]` annotation while a run is live is a `chat` item (the compact transcript shows it)
      return make(e.step, isChatLabel(e.label) ? 'chat' : 'notice', e.label || BARE_NOTICE_KINDS.has(e.kind) ? e.text : `notice ${e.kind}: ${e.text}`, e.level, { ...(e.detail ? { detail: clipDetail(e.detail) } : {}), ...(e.label ? { label: e.label } : {}) });
    case 'step:end':
      // TUI-DESIGN-2 §4.5: one `[step N]` summary line per step in all three sinks (the compact TUI shows this row alone)
      return make(e.record.step, 'step', stepSummaryText(e.record, e.costUsd));
    // --- TUI-DESIGN §15.1 item table: the contract 1.1 engine items (§24 "Engine items" strings) ---------------------
    case 'steer:queued':
      return make(e.step, 'steer:queued', steerQueuedText(e));
    case 'steer:applied':
      return make(e.step, 'steer:applied', steerAppliedText(e));
    case 'steer:withdrawn':
      return make(e.step, 'steer:withdrawn', `steer withdrawn${SEP}${e.index}`);
    case 'pause:requested':
      return make(e.step, 'pause', `pausing${SEP}the run stops after step ${e.step}`);
    case 'budget:warn':
      // TUI-DESIGN §9.2 / §24: `[run] budget: …` through the shared money lines; 80 % and 95 % are warnings, 50 % is information
      return budgetItems(e).map((text) => one(null, 'budget', text, e.pct >= 80 ? 'warn' : 'info'));
    case 'context:warn':
      // TUI-DESIGN-5 D-AG (deviation 16): the engine's one-per-upward-crossing event, as a row in all three sinks.
      // Before this arm `--json` carried the crossing and every interactive and `--plain` user saw nothing at 85 %.
      return make(e.step, 'notice', contextWarnItemText(e.pct), 'warn');
    case 'context:compacted':
      // TUI-DESIGN-5 D-AJ (b) / deviation 3: the typed event yields NO row of its own. The engine emits a
      // `notice{kind:'ui', label:'[ui]'}` beside it whose text already states `<before> → <after> prompt chars`,
      // the fold count, the step and the TRIGGER (`src/loop/engine.ts`), and that notice goes through the `notice`
      // arm below into all three sinks. A row here would print the same compaction twice, with strictly less in it.
      return [];
    case 'budget:stop':
    case 'budget:unpriced':
      return budgetItems(e).map((text) => one(null, 'budget', text, 'warn'));
    case 'budget:clamp':
    case 'budget:override':
      return budgetItems(e).map((text) => one(null, 'budget', text, 'info'));
    case 'retry:settled': {
      // TUI-DESIGN §13.1 / §15.1: one `warning:` line only when the chain failed or lasted > 10 s
      const text = retrySettledText(e);
      return text === null ? [] : make(e.step, 'retry', text, 'warn');
    }
    case 'workspace': {
      // TUI-DESIGN §12.2 / §24: `[run] git <banner>`, `[run] instructions: <path> (<bytes>, sha256 <8>)`, the P52 HEAD-drift warning on resume
      const banner = gitBannerLine(e.git);
      const items = [one(null, 'workspace', banner.text, banner.level)];
      for (const i of e.instructions) items.push(one(null, 'workspace', `instructions: ${i.path} (${i.bytes}, sha256 ${i.sha256.slice(0, 8)})`));
      if (e.git.resumedOn !== undefined && headMoved(e.git.head, e.git.resumedOn)) items.push(one(null, 'workspace', headDriftWarning(e.git.head, e.git.resumedOn), 'warn'));
      return items;
    }
    case 'blocking:request':
      return make(e.request.step, 'blocking', blockingRequestText(e), 'error');
    case 'blocking:resolved':
      return make(null, 'blocking', blockingResolvedText(e));
    case 'secret-ack':
      // TUI-DESIGN §10.2 / §24: `[step n] sent K secret(s) to the generator on request` (`[run]` before step 1); count only, never a value
      return make(e.step, 'secret-ack', secretAckText(e.count));
    case 'run:end': {
      const r = e.result;
      // §14.2 review item 15: the run's plan baseline dies with the run, so a session does not grow one entry per run
      state.planKeys.delete(state.runId);
      // §3.6 (G1): ONE form everywhere. The `(generator … · jev …)` split is ALWAYS present — it is what a user
      // checks when a bill surprises them — and, being attached to the cost token, is what TD3 rule 3 wraps as a unit
      // AGENT-LOOP-DESIGN §14.3: an agent run names no Jev it did not use — `jev $0.000` goes; a Jev hint that cost
      // something (RA0 / RA1 / RA2) still shows, so a surprising bill still splits
      const jevPart = r.mode === 'agent' && r.usage.jev.costUsd === 0 ? '' : `${SEP}jev ${usd(r.usage.jev.costUsd)}`;
      const cost = `${usd(r.usage.generator.costUsd + r.usage.jev.costUsd)} (generator ${usd(r.usage.generator.costUsd)}${jevPart})`;
      // §14.2 review item 5: the error clause is the LAST segment, after `exit <n>`. It used to sit between the
      // stop reason and the step count, where it broke the exported `RUN_END_PATTERN` — the anchor `src/perf`,
      // `test/pty` and `polish-check.mjs` grep for — for exactly the runs that end badly. `render-lag.ts:386` does
      // `capture.search(new RegExp(END_PATTERN))`, and a silent non-match turns the lag window into the whole
      // capture and the gate into a lie: R2, the failure §3.7's guard exists to prevent.
      const err = r.error ? `${SEP}${r.error.code}: ${clip(oneLine(r.error.message), 80)}` : '';
      const exit = e.exitCode !== undefined ? `${SEP}exit ${e.exitCode}` : '';
      return make(
        null,
        'run:end',
        `${RUN_FINISHED_WORD}${SEP}${r.stopReason}${SEP}${r.steps} steps${SEP}${formatDuration(r.wallMs)}${SEP}${cost}${exit}${err}`,
        r.stopReason === 'complete' ? 'info' : r.stopReason === 'error' ? 'error' : 'warn',
      );
    }
    // --- AGENT-LOOP-DESIGN §9.2 / §9.4: the agent-mode members ---------------------------------------------------------
    case 'assistant:text':
      // one `[jevcode]` row per committed line of the turn's prose — blank lines kept, never clipped (§A1); `--plain`
      // skips these for a turn that streamed `generator:delta` (the raw deltas were printed), the TUI commits its own
      return proseLinesOf(e.text).map((line) => {
        const s = seq + n;
        n += 1;
        return { key: `${e.step}:chat:${s}`, seq: s, step: e.step, kind: 'chat' as const, level: 'info' as const, text: sanitizeStream(line).replace(/\r/g, ''), label: '[jevcode]' as const };
      });
    case 'assistant:reset':
      // the reply's own notice: it sits in the reply under its label (never `[step N]`, which a chat-looking turn has not)
      return make(e.step, 'notice', AGENT_REPLY_RESTARTED, 'dim', { label: '[jevcode]' });
    case 'tool:result':
      // read-only results only: a mutating call's proposal / outcome / step rows already say what it did
      return e.readOnly ? make(e.step, 'tool', agentToolResultText(e), e.ok ? 'info' : 'warn') : [];
    default:
      return [];
  }
}

/** AGENT-LOOP-DESIGN §9.4: the dim notice an `assistant:reset` (a provider retry after bytes streamed) leaves in every sink. */
export const AGENT_REPLY_RESTARTED = 'reply restarted after a dropped stream';

/** AGENT-LOOP-DESIGN §A1: the label every line of the agent's prose carries in `--plain` (the TUI's and transcript.log's too). */
export const PROSE_PLAIN_LABEL = '[jevcode]';

/**
 * AGENT-LOOP-DESIGN §9.3: the lines an `assistant:text` commits. The shaper sends "everything up to the last newline"; a
 * text that still carries that newline would otherwise read as one extra blank line, so exactly one trailing `\n` is
 * dropped. Every other blank line is kept.
 */
export function proseLinesOf(text: string): string[] {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n');
}

/** AGENT-LOOP-DESIGN §4.1 / §9.4 (slice S5a): the tool names as the transcript's verbs — `Read calc/core.py`, `Bash npm test`. */
export const AGENT_TOOL_VERB: Readonly<Record<string, string>> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  todo_write: 'Todo',
  invalid: 'Invalid call',
};

/** The part of a call summary after the tool name (`read_file src/a.ts (lines 1-120)` → `src/a.ts (lines 1-120)`). */
function callRest(name: string, summary: string): string {
  const s = oneLine(summary).trim();
  return s.startsWith(`${name} `) ? s.slice(name.length + 1).trim() : s === name ? '' : s;
}

/** AGENT-LOOP-DESIGN §9.4: one call as a row segment — `Read src/a.ts (lines 1-120)`, `Grep "x" in src (3 matches)`, `(failed)` when it failed. */
/** The per-call and per-stage rows `--plain` leaves out of an agent run: its `[step N]` summary row says the same in one line. */
const PLAIN_AGENT_STEP_DETAIL: ReadonlySet<TranscriptKind> = new Set<TranscriptKind>(['tool', 'proposal', 'outcome', 'plan']);

/** A summary that already says how the call ended (`read_file a.js (error)`): no second marker after it. */
const ENDED_MARKER_RE = /\((?:error|failed|invalid|not executed|blocked|declined)\)$/;

export function agentCallText(c: { name: string; summary: string; ok: boolean }): string {
  const verb = AGENT_TOOL_VERB[c.name] ?? c.name;
  const rest = callRest(c.name, c.summary);
  return `${verb}${rest === '' ? '' : ` ${rest}`}${c.ok || ENDED_MARKER_RE.test(rest) ? '' : ' (failed)'}`;
}

/** AGENT-LOOP-DESIGN §9.4: the full-view row of a read-only tool result — `tool · read_file src/a.ts (lines 1-120) · 3 ms`. */
export function agentToolResultText(e: { name: string; summary: string; ok: boolean; ms: number }): string {
  const ms = Number.isFinite(e.ms) ? `${Math.max(0, Math.round(e.ms))} ms` : '? ms';
  const summary = oneLine(e.summary).trim() || e.name;
  return `tool${SEP}${summary}${e.ok || ENDED_MARKER_RE.test(summary) ? '' : `${SEP}failed`}${SEP}${ms}`;
}

/** Most file names a compact read batch lists before `(+N)`. */
export const AGENT_READ_BATCH_NAMES = 3;

/**
 * AGENT-LOOP-DESIGN §9.4 (slice S5a): an observe step's calls as ONE compact row — consecutive successful `read_file`
 * calls fold into `Read a.ts, b.ts, c.ts (+2)`; every other call keeps its own segment (`Grep "x" in src (3 matches)`,
 * `Bash git diff (exit 0)`, `Todo (1/3 done)`), joined with ` · `.
 */
export function agentBatchText(calls: readonly { name: string; summary: string; ok: boolean }[]): string {
  const segs: string[] = [];
  let reads: string[] = [];
  const flushReads = (): void => {
    if (reads.length === 0) return;
    const shown = reads.slice(0, AGENT_READ_BATCH_NAMES).join(', ');
    segs.push(`Read ${shown}${reads.length > AGENT_READ_BATCH_NAMES ? ` (+${reads.length - AGENT_READ_BATCH_NAMES})` : ''}`);
    reads = [];
  };
  for (const c of calls) {
    if (c.name === 'read_file' && c.ok) {
      const rest = callRest(c.name, c.summary);
      reads.push(rest.split(/\s+/)[0] || rest);
      continue;
    }
    flushReads();
    segs.push(agentCallText(c));
  }
  flushReads();
  return segs.join(SEP);
}

/** `7 passed` · `5 passed, 2 failed` · `5 passed, 1 error` — the parsed test counts a run / verify row ends with. */
export function testCountsText(t: { passed: number; failed: number; errors: number }): string {
  const parts = [`${t.passed} passed`];
  if (t.failed > 0) parts.push(`${t.failed} failed`);
  if (t.errors > 0) parts.push(`${t.errors} error${t.errors === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * AGENT-LOOP-DESIGN §A1: the rows a still-replying agent run holds back — its header and git rows, `instructions:`,
 * informational notices and budget lines, step / stage rows, and a failed model turn's own error row. They are written when
 * the run's first command or change turns the chrome on, and dropped when the run ends as a reply (a failed reply's error is
 * the session's one `[ui]` row), so a reply shows only its prose in the TUI and in `--plain`. Warnings, a fatal error, a
 * blocking pane, a retry and the reply-restarted notice are never held.
 */
export function isHoldableAgentRow(item: Pick<TranscriptItem, 'kind' | 'level' | 'text' | 'label'>): boolean {
  if (item.kind === 'error') return item.level === 'error' && !item.text.endsWith('(fatal)');
  if (item.level === 'warn' || item.level === 'error') return false;
  switch (item.kind) {
    case 'run:start':
    case 'run:ready':
    case 'workspace':
    case 'step':
    case 'plan':
    case 'proposal':
    case 'outcome':
    case 'transcript':
    case 'budget':
    case 'tool':
      return true;
    case 'notice':
      // a `[ui]` notice is the human's own command answering while the reply is in flight (`/status` through Engine.annotate):
      // never held — it lands at once, in the order transcript.log records it, not after the reply
      return item.level === 'info' && item.label !== '[ui]';
    default:
      return false;
  }
}

/**
 * The stops that close a run which never ran a command or changed a file (`tools` false) as a REPLY (§A1: "a run that made
 * no workspace change and ran no command is a reply"): a look-up answered after read-only tools (`generator_done`), a reply
 * stopped by Esc / Ctrl-C (`human_abort`, `signal`), and a reply whose model turn failed (`error` — the session says so in
 * one `[ui]` row; a failed reply is not a run to report).
 */
const QUIET_AGENT_STOPS: ReadonlySet<string> = new Set(['generator_done', 'human_abort', 'signal', 'error']);

/**
 * AGENT-LOOP-DESIGN §A1 / §A5: does this `run:end` close a REPLY — the model answered in prose (`answered`, or the one
 * predicate `isReplyOnlyRun` over the steps), answered a question with read-only tools only, or a reply was stopped or
 * failed before any command or change?
 */
export function agentRunEndedAsReply(stopReason: string, steps: readonly Pick<StepRecord, 'agent'>[], tools: boolean): boolean {
  return stopReason === 'answered' || isReplyOnlyRun(steps) || (!tools && QUIET_AGENT_STOPS.has(stopReason));
}

/** The tools a look-up may call and still be a reply: they read, they plan, they run nothing and change nothing. */
const LOOKUP_TOOLS: ReadonlySet<string> = new Set(['read_file', 'grep', 'glob', 'todo_write', 'invalid']);

/**
 * AGENT-LOOP-DESIGN §9.2 / §A1: an event that turns the agent run's chrome on — the first call that runs a command (any
 * `bash`, a read-only one included) or changes a file, or a proposal / command start of such a step. Until one arrives
 * the run is a reply (§A1, §A5), look-ups included: the TUI keeps the chat chrome, `--plain` holds the run's header
 * rows back, and Esc / Ctrl-C stop the reply.
 */
export function isAgentToolActivity(e: EngineEvent): boolean {
  switch (e.type) {
    case 'tool:call':
      return !e.readOnly || !LOOKUP_TOOLS.has(e.name);
    // the finish step of a reply executes its `done` too (stage execute → `exec:start` with a done action): not a command
    case 'exec:start':
      return e.action.kind !== 'done';
    // an observe step's proposal is a `read` (its calls already said what they were)
    case 'proposal':
      return e.proposal.action.kind !== 'done' && e.proposal.action.kind !== 'read';
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-2 §4.5: the step summary line
// ---------------------------------------------------------------------------------------

const STEP_TARGET_CELLS = 40;
const STEP_GOAL_CHARS = 32;

/** `$0.004` — three decimals, four below $0.001 (§4.5 "cost or tokens") */
export function stepCostText(x: number): string {
  if (!Number.isFinite(x)) return '$?';
  return x > 0 && x < 0.001 ? `$${x.toFixed(4)}` : usd(x);
}

/** `1.2s` under ten seconds, then `formatDuration` (`12s`, `1m2s`) */
export function stepWallText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatDuration(ms);
}

/**
 * TUI-DESIGN-4 §6.6 / F-E2: the target of the `[step N]` row's **action** segment. An `edit` / `write` already names
 * its file, and §6.6 puts the churn in the *outcome* segment (`1 file +3 −0`), so repeating ` +3 −0` here would state
 * it twice in one row — F-E2 and §3.6's compact-run frame both draw `write scratch_0.py "Create scratch_0.py"`.
 * A `patch` has no other name (A6-1), so it keeps §6.1's `editTargetText`.
 */
function stepTargetText(a: Action): string {
  if (a.kind === 'edit' || a.kind === 'write') return a.path;
  return describeAction(a).target;
}

function stepActionText(r: StepRecord): string {
  const p = r.proposal;
  if (p === null) return r.intent !== null ? `${r.intent} (no proposal)` : '(no proposal)';
  const d = describeAction(p.action);
  const target = clip(oneLine(stepTargetText(p.action)), STEP_TARGET_CELLS);
  const goal = p.action.kind === 'edit' || p.action.kind === 'write' || p.action.kind === 'patch' ? oneLine(p.goal).trim() : '';
  return `${d.kind} ${target}${goal !== '' ? ` "${clip(goal, STEP_GOAL_CHARS)}"` : ''}`.trim();
}

/**
 * TUI-DESIGN-4 §6.6 (D-Z, A6-6): the `[step N]` row's outcome segment. `3 files +18 −4` — the counts come from
 * §6.1's `editSummary` on the **proposal's** action, which is already in `StepRecord.proposal`, so there is no new
 * engine field and no extra I/O. Edge 2: when the two name sets disagree (a rename git resolved differently) the
 * names come from `changedFiles` and the **counts are dropped**; edge 1: a `run` that changed files has no counts.
 */
function stepOutcomeText(o: ActionOutcome | null, action: Action | null = null): string | null {
  if (o === null) return null;
  switch (o.status) {
    case 'executed': {
      const n = o.changedFiles.length;
      if (n === 0) return null;
      const files = `${n} file${n === 1 ? '' : 's'}`;
      const summary: EditSummary | null = action === null ? null : editSummary(action);
      if (summary === null || summary.truncatedFiles > 0) return files;
      const named = new Set(summary.files.map((f) => f.path));
      const changed = new Set(o.changedFiles);
      if (named.size !== changed.size || [...named].some((x) => !changed.has(x))) return files;
      return `${files} +${summary.added} −${summary.deleted}`;
    }
    case 'noop':
      return 'skipped';
    case 'declined':
    case 'failed':
    case 'blocked':
    case 'interrupted':
      return o.status;
  }
}

/** §6.6: the last segment of a `[step N]` row — dropped first by TD3 rule 3, because it is a pointer, not information. */
export function diffHintText(step: number): string {
  return `/diff ${step}`;
}

/**
 * `<action> · risk <r> <verdict> · <outcome> · tests <p>p/<f>f/<e>e · judge <p>[ · complete <c>] · <wall> · $<cost>|jev <k>` —
 * the text of the `step` item (`[step N]` is its label, `stepLabel`); action and verdict come first so wall and cost wrap.
 * An interrupted step reads `interrupted at <stage> (<reason>)`. `costUsd` comes from the event (§6 item 3); absent → tokens.
 */
export function stepSummaryText(r: StepRecord, costUsd?: { generator: number; jev: number }, opts: { completeThreshold?: number } = {}): string {
  if (r.interruptedAt !== undefined) return `interrupted at ${r.interruptedAt.stage} (${r.interruptedAt.reason})`;
  // AGENT-LOOP-DESIGN §9.4: an agent step (it carries `StepRecord.agent`) reads as the tool row it was — no `risk … ok`, no `judge …`
  if (r.agent !== undefined) return agentStepText(r, costUsd);
  // an agent step whose model turn failed has no summary: it says so (never the legacy `(no proposal) · failed`)
  if (r.proposer === 'agent' && r.proposal === null) {
    const cost = costUsd !== undefined ? costUsd.generator + costUsd.jev : 0;
    return [`model turn failed`, r.error?.code ?? 'error', stepWallText(r.timing.totalMs), ...(cost > 0 ? [stepCostText(cost)] : [])].join(SEP);
  }
  const parts: string[] = [stepActionText(r)];
  if (r.risk !== null) parts.push(`risk ${p2(r.risk.risk)} ${r.risk.verdict === 'ok' ? 'ok' : `[${r.risk.verdict}]`}`);
  const outcome = stepOutcomeText(r.outcome, r.proposal?.action ?? null);
  if (outcome !== null) parts.push(outcome);
  const tests = r.judge?.tests;
  if (tests && tests.source === 'parsed') parts.push(`tests ${tests.passed}p/${tests.failed}f/${tests.errors}e`);
  if (r.judge !== null) {
    const threshold = opts.completeThreshold ?? DEFAULT_COMPLETE_THRESHOLD;
    parts.push(`judge ${p2(r.judge.succeeded)}${r.completion !== null && r.completion >= threshold ? ` · complete ${p2(r.completion)}` : ''}`);
  }
  parts.push(stepWallText(r.timing.totalMs));
  if (costUsd !== undefined) parts.push(stepCostText(costUsd.generator + costUsd.jev));
  else {
    const gen = r.usage.generator.inputTokens + r.usage.generator.outputTokens;
    const jev = r.usage.jev.inputTokens + r.usage.jev.outputTokens;
    parts.push(gen > 0 ? `gen ${kTokens(gen)} jev ${kTokens(jev)}` : `jev ${kTokens(jev)}`);
  }
  // §6.6: the `/diff <N>` pointer is the LAST segment and is conditional on the step having changed files, so it is
  // never a dead command and TD3 rule 3 drops it before it drops the cost
  if (r.outcome !== null && r.outcome.status === 'executed' && r.outcome.changedFiles.length > 0) parts.push(diffHintText(r.step));
  return parts.join(' · ');
}

/** The words after the count of plan items a `done` agent row names as still open (`done · 1 todo left`). */
const AGENT_TODO_WORD = 'todo left';

/**
 * AGENT-LOOP-DESIGN §9.4 (slice S5a): the `[step N]` row of an agent step, in all three sinks —
 *
 * - observe: the batch, compactly (`Read calc/core.py, tests/test_core.py · Grep "parse" in calc (3 matches)`);
 * - act: `Edit calc/core.py (+2 −2)` · `Write notes.md (+12 −0)` · `Bash python -m pytest -q · 7 passed` (or `· exit 1`);
 * - verify (the harness's own test run): `Verify npm test · 12 passed`;
 * - finish: `done` (`· 1 todo left` when the plan still has items);
 *
 * then `failed` / `declined` / `blocked` / `interrupted` when the action did not run, the step's wall time, and its cost
 * when the step sampled a model turn (a queued call's step costs nothing and says so by saying nothing).
 */
export function agentStepText(r: StepRecord, costUsd?: { generator: number; jev: number }): string {
  const a = r.agent!;
  const action = r.proposal?.action ?? null;
  const parts: string[] = [];
  const tests = r.judge?.tests;
  const counts = tests && tests.source === 'parsed' ? testCountsText(tests) : null;
  const exitCode = r.outcome?.status === 'executed' ? (r.outcome.exec?.exitCode ?? null) : null;
  const runTail = (): void => {
    if (counts !== null) parts.push(counts);
    else if (exitCode !== null) parts.push(`exit ${exitCode}`);
  };
  switch (a.kind) {
    case 'observe':
      parts.push(a.calls.length > 0 ? agentBatchText(a.calls) : action !== null ? describeAction(action).target : 'read');
      break;
    case 'act':
      if (action === null) parts.push('(no action)');
      else if (action.kind === 'run') {
        parts.push(`Bash ${clip(oneLine(action.command), STEP_TARGET_CELLS)}`);
        runTail();
      } else if (action.kind === 'edit' || action.kind === 'write' || action.kind === 'patch') {
        const verb = action.kind === 'write' ? 'Write' : 'Edit';
        const s = editSummary(action);
        const target = action.kind === 'patch' ? describeAction(action).target : action.path;
        parts.push(`${verb} ${clip(oneLine(target), STEP_TARGET_CELLS)}${s !== null ? ` (+${s.added} −${s.deleted})` : ''}`);
      } else parts.push(describeAction(action).target);
      break;
    case 'verify':
      parts.push(`Verify ${action !== null && action.kind === 'run' ? clip(oneLine(action.command), STEP_TARGET_CELLS) : 'tests'}`);
      runTail();
      break;
    case 'finish': {
      const left = r.proposal?.plan.remaining.length ?? 0;
      parts.push(left > 0 ? `done${SEP}${left} ${AGENT_TODO_WORD}` : 'done');
      break;
    }
  }
  const o = r.outcome;
  if (o !== null && o.status !== 'executed' && o.status !== 'noop') parts.push(o.status);
  parts.push(stepWallText(r.timing.totalMs));
  const cost = costUsd !== undefined ? costUsd.generator + costUsd.jev : null;
  if (cost !== null && (a.turn !== null || cost > 0)) parts.push(stepCostText(cost));
  return parts.join(SEP);
}

/**
 * AGENT-LOOP-DESIGN §9.4: the finish row of a step with no calls — the reply's prose already said it and `[run] finished`
 * states the outcome, so the compact TUI hides it (the full view, `--plain` and transcript.log keep it).
 */
export function isQuietAgentFinish(r: Pick<StepRecord, 'agent'>): boolean {
  return r.agent !== undefined && r.agent.kind === 'finish' && r.agent.calls.length === 0;
}

/** The one-line form written to transcript.log, by the plain renderer and by the TUI's <Static> rows. A `label` (TUI-DESIGN §15.1) replaces the step label. */
export function formatTranscriptItem(item: TranscriptItem): string {
  // TUI-DESIGN-4 §5.2 P-C4: a blank line of a pasted turn survives as an empty item, whose stored row is `[you]`
  // with NO trailing space — the same in transcript.log, in `--plain` and in the TUI
  return `${item.label ?? stepLabel(item.step)} ${item.text}`.trimEnd();
}

/**
 * §3.6 / §3.7 G1: the engine's stop line, exactly as `stopTranscriptLine` builds it
 * (`stop: <reason> at step <n>[ (<detail>)]`, `src/loop/stop.ts:56`). Anchored at both ends so no generator or
 * command output that merely starts with the word can be swallowed.
 */
const STOP_LINE_RE = /^stop: [a-z_]+ at step \d+(?: \(.*\))?$/s;

/** TUI-DESIGN-4 §1.3.4: the dump is written in chunks of this many characters so a slow link cannot push the exit past `UNMOUNT_TIMEOUT_MS`. */
export const SCROLLBACK_CHUNK_CHARS = 64 * 1024;

/**
 * TUI-DESIGN-4 §1.3.4: the whole transcript as the PRIMARY screen should see it — one row per item, exactly the
 * bytes `createPlainRenderer` writes for the same items (`glyphTwin(formatTranscriptItem(item))` and a newline,
 * `:1289` and `:1320`). Going through the one formatter is what makes the `/scrollback` print and the on-exit dump
 * byte-identical to a `--plain` run of the same script, which is the property §1.3.4 claims and §10 tests.
 *
 * The result is split into chunks of at most `SCROLLBACK_CHUNK_CHARS`, never mid-row, so a very long transcript
 * over a slow link is a sequence of bounded writes rather than one multi-megabyte one. An empty item list gives an
 * empty array — §1.3.4 skips the dump then.
 */
export function transcriptDumpChunks(items: readonly TranscriptItem[], g: GlyphSet, chunkChars: number = SCROLLBACK_CHUNK_CHARS): string[] {
  const limit = Number.isFinite(chunkChars) && chunkChars > 0 ? Math.floor(chunkChars) : SCROLLBACK_CHUNK_CHARS;
  const out: string[] = [];
  let cur = '';
  for (const item of items) {
    const row = `${glyphTwin(formatTranscriptItem(item), g)}\n`;
    if (cur.length > 0 && cur.length + row.length > limit) {
      out.push(cur);
      cur = '';
    }
    cur += row;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * TUI-DESIGN §15.1: a renderer-local item while no engine is live (the recent-session row, the sandbox line,
 * idle help, `[ui] error:` for idle commands, …): printed by `--plain` and the TUI, carried by `--json` as a
 * `ui` line, never in any transcript.log. `seq` is the renderer's own counter; keys never collide with event items.
 */
export function localItem(
  text: string,
  seq: number,
  opts: {
    label?: UiLabel;
    level?: TranscriptLevel;
    detail?: string;
    /** contract 1.7 item 1 (§3.1.3, §6.4): the TUI's pre-split form of the body, with a colour role per row */
    detailRows?: readonly { readonly text: string; readonly role: ColorRole }[];
    /** contract 1.7 item 1 (§6.4): `'diff'` routes the rows through `diffRows`; the default `'text'` is today's behaviour */
    detailKind?: 'diff' | 'table' | 'text';
    /** §6.5 item 3: the caller's own cap instead of the fixed `TRANSCRIPT_DETAIL_MAX_LINES` (`Infinity` for `/diff --all`) */
    maxDetailLines?: number;
  } = {},
): TranscriptItem {
  const label = opts.label ?? '[ui]';
  const diff = opts.detailKind === 'diff';
  return {
    key: `local:${label}:${seq}`,
    seq,
    step: null,
    // TUI-DESIGN-2 §3.10 / §6 item 17: an idle-time bubble is a `chat` item (one per line, printed `[you] <text>` / `[jevcode] <text>`)
    kind: isChatLabel(label) ? 'chat' : 'ui',
    level: opts.level ?? 'info',
    text: clip(oneLine(text), TRANSCRIPT_TEXT_MAX),
    local: true,
    label,
    ...(opts.detail ? { detail: clipDetail(opts.detail, { ...(opts.maxDetailLines !== undefined ? { maxLines: opts.maxDetailLines } : {}), ...(diff ? { maxChars: TRANSCRIPT_DIFF_DETAIL_MAX_CHARS } : {}) }) } : {}),
    ...(opts.detailRows !== undefined ? { detailRows: opts.detailRows } : {}),
    ...(opts.detailKind !== undefined ? { detailKind: opts.detailKind } : {}),
  };
}

// ---------------------------------------------------------------------------------------
// Confirmation summary (shared by the Ink box and the readline prompt)
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §6.1 / §15.2: the full review header is 8 rows (was 6); the layout budget subtracts exactly this. */
export const CONFIRM_HEADER_ROWS = 8;
/** The width the shared header is cut to for the readline twin and the legacy Ink box (§6.1 "full header at 80 columns"). */
export const CONFIRM_HEADER_COLUMNS = 80;
/** TUI-DESIGN §6.1 row 2 (§24 "Review box" keys): what the TUI header shows. */
export const CONFIRM_KEYS_LINE = REVIEW_KEYS_80;
/** TUI-DESIGN §6.5: the readline confirmer's prompt keys (`d <note>` on the same line). */
export const READLINE_CONFIRM_KEYS = '[y] approve  [n] decline  [d] decline+note';
/** TUI-DESIGN §6.4: a decline note is one line of at most this many characters. */
export const CONFIRM_NOTE_MAX = 600;
/** TUI-DESIGN §24: the note prompt of the readline twin (Enter on an empty line cancels the note). */
export const READLINE_NOTE_PROMPT = 'note (≤ 600, Enter sends, empty cancels): ';

/** TUI-DESIGN §6.1 / §15.2: exactly CONFIRM_HEADER_ROWS rows — `reviewHeaderLines(req, 8, 80)`, the one shared header. */
export function confirmHeaderLines(req: ConfirmRequest): string[] {
  return reviewHeaderLines(req, CONFIRM_HEADER_ROWS, CONFIRM_HEADER_COLUMNS);
}

/** Preview body lines (old/new, content, diff, command); '' preview yields []. */
export function confirmPreviewLines(req: ConfirmRequest): string[] {
  /**
   * TUI-DESIGN-5 §4.6 [G2] / contract 1.5 §3.7: `body` is a PRE-RENDERED preview and replaces
   * `describeAction(proposal.action).preview` outright. It exists because `describeAction('read').preview` is the
   * empty string, so a manifest confirm faked as a synthetic `read` action rendered a blank body — the defect the
   * four fields close. The clip is still applied, so the row cap cannot be bypassed by a long body.
   *
   * **`isProposalConfirm` is the discriminant here too, not `body !== undefined`** (§4.6: "`headline` — not
   * `badge`, not `title` — is the discriminant"). `body` and `headline` are independently optional, so keying the
   * `--plain` twin off one field and every Ink / card / SR branch off the other makes a request with a `body` and
   * no `headline` render the body under `--plain` and the `describeAction` diff in the TUI — the twin divergence
   * §13's identity rule forbids. One predicate now decides the shape in all four sinks.
   */
  const body = isProposalConfirm(req) ? req.body : undefined;
  if (body !== undefined) return body.length === 0 ? [] : clipDetail(body.join('\n')).split('\n');
  const d = describeAction(req.proposal.action);
  if (d.preview === '') return [];
  return clipDetail(d.preview).split('\n');
}

// ---------------------------------------------------------------------------------------
// Readline confirmer
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §6.4 / §10.7: what the `d` note's gate needs from the session host; absent → pattern-only detection and `patternRedact`. */
export type NoteGate = Pick<SessionHost, 'detectSecrets' | 'addSecret' | 'redact'>;

/**
 * TUI-DESIGN §1 / §6.5 / §14.2: one `node:readline` interface per stdin. On a `--plain` TTY the readline composer
 * (`plain-composer.ts`) owns it and lends its `'line'` stream through this shape; the confirmer borrows the lines
 * for one review and detaches — it never creates a second interface over the same stream, never calls `rl.close()`
 * (which pauses the shared input) and never `input.pause()`s. `closed` is the EOF fact (a review that arrives
 * after EOF declines at once; nobody can answer it).
 */
export interface LineSource {
  /** every line until the returned release runs; the owner swallows them meanwhile (and shows no prompt) */
  onLine(fn: (line: string) => void): () => void;
  /** EOF on the shared stream (the owner's readline `close`); returns the detach */
  onClose(fn: () => void): () => void;
  /** true once EOF was seen */
  readonly closed: boolean;
}

export interface ReadlineConfirmerOptions {
  /** readline SIGINT while a question is pending (only fires in terminal mode; kept for completeness) */
  onAbort: (reason: 'signal') => void;
  /** non-interactive: decline after this many ms (default 0) */
  confirmTimeoutMs?: number;
  /** rows of preview printed before the question (default 20) */
  previewRows?: number;
  /** TUI-DESIGN §6.4: the note gate, read at question time (the host attaches after the first frame) */
  host?: () => NoteGate | null;
  /**
   * TUI-DESIGN §1 (C46): whether a human can answer at all. Default `Boolean(stdin.isTTY)`; wave 3 passes
   * `!flags.noInput && !isInCi && TERM !== 'dumb'` so `--no-input`, `CI` and `TERM=dumb` on a TTY take the safe
   * default (decline after `confirmTimeoutMs`) without reading a byte.
   */
  interactive?: boolean;
  /**
   * TUI-DESIGN §1 / §6.5: the shared stdin's line source (the readline composer's `lines`), read at question time.
   * Absent or null → the confirmer creates one interface of its own, once, and keeps it for its whole lifetime.
   */
  lines?: () => LineSource | null;
  /** TUI-DESIGN §14.1: the glyph table for stdout (`--ascii`); default unicode */
  glyphs?: GlyphSet;
}

export const READLINE_MAX_PROMPTS = 5;
export const IDENTITY_REVIEWER = 'reviewer';
export const IDENTITY_NO_TTY = 'no reviewer (stdin not a TTY)';
/** TUI-DESIGN §1: a TTY stdin the launch made non-interactive (`--no-input`, `CI`, `TERM=dumb`) */
export const IDENTITY_NO_INPUT = 'no reviewer (non-interactive)';

function abortErrorFrom(signal: AbortSignal): AbortError {
  return signal.reason instanceof AbortError ? signal.reason : new AbortError('signal');
}

/** Minimal stream shapes so tests can pass PassThrough streams. */
export type ConfirmInput = NodeJS.ReadableStream & { isTTY?: boolean };
export type ConfirmOutput = NodeJS.WritableStream;

/** TUI-DESIGN §6.4: `sanitizeStream → oneLine → clip 600` — the note's shape before the gate and the redactor. */
export function normaliseNote(raw: string): string {
  return clip(oneLine(sanitizeStream(raw)).trim(), CONFIRM_NOTE_MAX);
}

/** TUI-DESIGN §10.2: every hit span ≥ 8 chars, de-duplicated, in text order — what `y` hands to `addSecret`. */
function hitSpans(text: string, hits: readonly SecretHit[]): string[] {
  const out: string[] = [];
  for (const h of [...hits].sort((a, b) => a.start - b.start)) {
    const span = text.slice(Math.max(0, h.start), Math.max(0, h.end));
    if (span.length >= MIN_SECRET_LENGTH && !out.includes(span)) out.push(span);
  }
  return out;
}

/**
 * A `LineSource` over one `node:readline` interface that lives as long as its owner: listeners attach and detach
 * per question, the interface is never closed by a question (TUI-DESIGN §1: one interface per stdin).
 */
function ownLineSource(stdin: ConfirmInput, stdout: ConfirmOutput): LineSource {
  const lineFns = new Set<(line: string) => void>();
  const closeFns = new Set<() => void>();
  let closed = false;
  const rl = createInterface({ input: stdin, output: stdout, terminal: false });
  rl.on('line', (line: string) => {
    for (const fn of [...lineFns]) fn(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const fn of [...closeFns]) fn();
  });
  return {
    onLine(fn) {
      lineFns.add(fn);
      return () => lineFns.delete(fn);
    },
    onClose(fn) {
      closeFns.add(fn);
      return () => closeFns.delete(fn);
    },
    get closed() {
      return closed;
    },
  };
}

/**
 * y/n/d on TTY stdin through `node:readline` with `terminal: false`, so the kernel keeps
 * delivering SIGINT on Ctrl-C (raw mode is never enabled) and the process handler runs the
 * §14.2 matrix. TUI-DESIGN §6.5: the 8 header lines and ≤ 20 preview rows, then
 * `[step N] [y] approve  [n] decline  [d] decline+note > `; `d <note>` on the same line (or `d`
 * then the note on its own line) declines with a note that passes the §6.4 gate → redact → clip;
 * five invalid answers decline (a cancelled note or gate is not an invalid answer).
 * `confirmDetailed` returns the `ConfirmOutcome`; `confirm` is its boolean view. A non-interactive
 * launch (no TTY, `--no-input`, `CI`, `TERM=dumb`) declines after `confirmTimeoutMs`. Never auto-approves.
 * The lines come from `opts.lines()` (the composer's shared readline) or from one interface of its own.
 */
export function createReadlineConfirmer(stdin: ConfirmInput, stdout: ConfirmOutput, opts: ReadlineConfirmerOptions): Confirmer & { confirmDetailed(req: ConfirmRequest, o: { signal: AbortSignal }): Promise<ConfirmOutcome> } {
  const tty = Boolean(stdin.isTTY);
  // TUI-DESIGN §1 (C46): `--no-input`/`CI`/`TERM=dumb` on a TTY are non-interactive too
  const interactive = opts.interactive ?? tty;
  const timeoutMs = Math.max(0, opts.confirmTimeoutMs ?? 0);
  const previewRows = Math.max(0, opts.previewRows ?? 20);
  const identity = interactive ? IDENTITY_REVIEWER : tty ? IDENTITY_NO_INPUT : IDENTITY_NO_TTY;
  const glyphs = opts.glyphs ?? glyphSet();
  let secretSeq = 0;
  let own: LineSource | null = null;
  // TUI-DESIGN §14.1: every stdout write passes the glyph twin (`--ascii`); the strings themselves stay canonical
  const write = (s: string): void => {
    stdout.write(glyphTwin(s, glyphs));
  };
  const source = (): LineSource => {
    const shared = opts.lines?.() ?? null;
    if (shared !== null) return shared;
    own ??= ownLineSource(stdin, stdout);
    return own;
  };

  function printRequest(req: ConfirmRequest): void {
    // TUI-DESIGN-4 §6.3 "Identity": the readline twin renders the SAME rows through the SAME builder (indent 2, no
    // colour, the same truthful tail) — that is the declared normaliser for this surface
    const lines = confirmHeaderLines(req);
    const preview = reviewDiffLines(req, previewRows, CONFIRM_HEADER_COLUMNS, glyphs);
    const body = [...lines.map((l) => `${stepLabel(req.step)} ${l}`), ...preview];
    write(`${body.join('\n')}\n`);
  }

  function declineAfterTimeout(req: ConfirmRequest, signal: AbortSignal): Promise<ConfirmOutcome> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        write(`${stepLabel(req.step)} confirm ${req.id} declined: ${identity}\n`);
        resolve({ approved: false });
      }, timeoutMs);
      const onAbort = (): void => {
        clearTimeout(t);
        reject(abortErrorFrom(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function ask(req: ConfirmRequest, signal: AbortSignal): Promise<ConfirmOutcome> {
    return new Promise((resolve, reject) => {
      const src = source();
      const label = stepLabel(req.step);
      if (src.closed) {
        // EOF already happened: nobody can approve, so decline (never auto-approve)
        write(`${label} confirm ${req.id} declined: stdin closed\n`);
        resolve({ approved: false });
        return;
      }
      let invalid = 0;
      let settled = false;
      // TUI-DESIGN §6.5: `keys` awaits y/n/d; `note` awaits the note line after a bare `d`; `gate` awaits the §4.10 y/N for a note with a secret
      let mode: { kind: 'keys' } | { kind: 'note' } | { kind: 'gate'; note: string; hits: readonly SecretHit[] } = { kind: 'keys' };
      let detachLine: () => void = () => undefined;
      let detachClose: () => void = () => undefined;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        // detach only: the interface belongs to its owner and stays open for the next line (§1: one interface per stdin)
        detachLine();
        detachClose();
        fn();
      };
      const onAbort = (): void => finish(() => reject(abortErrorFrom(signal)));
      /** TUI-DESIGN §6.5: re-show the keys prompt (a cancelled note/gate comes back here without counting as an invalid answer) */
      const showKeys = (): void => {
        mode = { kind: 'keys' };
        write(`${label} ${READLINE_CONFIRM_KEYS} > `);
      };
      /** TUI-DESIGN §6.5: only a genuinely invalid keys-mode line counts; the fifth declines */
      const invalidAnswer = (): void => {
        invalid += 1;
        if (invalid >= READLINE_MAX_PROMPTS) {
          write(`${label} confirm ${req.id} declined: no valid answer after ${invalid} prompts\n`);
          finish(() => resolve({ approved: false }));
          return;
        }
        showKeys();
      };
      const declineWith = (note: string): void => {
        const gate = opts.host?.() ?? null;
        const redacted = normaliseNote(gate ? gate.redact(note) : patternRedact(note));
        finish(() => resolve(redacted.length > 0 ? { approved: false, note: redacted } : { approved: false }));
      };
      const takeNote = (raw: string): void => {
        const note = normaliseNote(raw);
        if (note.length === 0) {
          // an empty note cancels back to the keys prompt (§24 "empty cancels"); not an invalid answer
          showKeys();
          return;
        }
        // TUI-DESIGN §6.4 / §10.7: the note passes the gate before it reaches the engine
        const gate = opts.host?.() ?? null;
        const hits = gate ? gate.detectSecrets(note) : detectSecretsByPattern(note);
        if (hits.length === 0) {
          declineWith(note);
          return;
        }
        mode = { kind: 'gate', note, hits };
        write(`${label} ${gatePlainPrompt(hits)} `);
      };
      const onLine = (line: string): void => {
        if (settled) return;
        if (mode.kind === 'note') {
          takeNote(line);
          return;
        }
        if (mode.kind === 'gate') {
          const a = line.trim().toLowerCase();
          if (a === 'y' || a === 'yes') {
            // TUI-DESIGN §10.2: `y` → addSecret for every hit span ≥ 8 chars before the note leaves the confirmer
            const gate = opts.host?.() ?? null;
            if (gate) for (const span of hitSpans(mode.note, mode.hits)) gate.addSecret(`composer#${++secretSeq}`, span);
            declineWith(mode.note);
            return;
          }
          // anything else cancels the note and keeps the review open (not an invalid answer)
          showKeys();
          return;
        }
        const a = line.trim();
        const lower = a.toLowerCase();
        if (lower === 'y' || lower === 'yes') return finish(() => resolve({ approved: true }));
        if (lower === 'n' || lower === 'no') return finish(() => resolve({ approved: false }));
        if (lower === 'd') {
          mode = { kind: 'note' };
          write(`${label} ${READLINE_NOTE_PROMPT}`);
          return;
        }
        if (/^d\s+\S/.test(lower)) {
          takeNote(a.slice(1));
          return;
        }
        invalidAnswer();
      };
      detachLine = src.onLine(onLine);
      // stdin closed under us: nobody can approve, so decline (never auto-approve).
      detachClose = src.onClose(() => finish(() => resolve({ approved: false })));
      signal.addEventListener('abort', onAbort, { once: true });
      showKeys();
    });
  }

  function confirmDetailed(req: ConfirmRequest, { signal }: { signal: AbortSignal }): Promise<ConfirmOutcome> {
    if (signal.aborted) return Promise.reject(abortErrorFrom(signal));
    printRequest(req);
    return interactive ? ask(req, signal) : declineAfterTimeout(req, signal);
  }

  return {
    identity,
    confirmDetailed,
    confirm: (req, o) => confirmDetailed(req, o).then((r) => r.approved),
  };
}

// ---------------------------------------------------------------------------------------
// Plain renderer
// ---------------------------------------------------------------------------------------

/** Key of the synthetic header row; never collides with event items (their keys end in a numeric seq). */
export const HEADER_ITEM_KEY = 'run:header';

/**
 * The header row both renderers show before any engine exists: the task (or the run being
 * resumed) and the `step 0/–` sentinel. The TUI puts it at the top of <Static>, the plain
 * renderer writes it as its first line, so both transcripts start identically. It is not an
 * engine item: seq −1 keeps the engine's counter (transcript.log) untouched.
 */
export function headerItem(task: string, resumeId: string | null): TranscriptItem {
  const what = resumeId ? `resuming ${resumeId}` : `task: ${clip(oneLine(task), TASK_MAX)}`;
  return { key: HEADER_ITEM_KEY, seq: -1, step: null, kind: 'run:start', level: 'info', text: `jevcode ${what} | step 0/– starting` };
}

/** TUI-DESIGN §1 / §24: the session header `jevcode session · <dir> | step 0/– starting` (`chat`; no run exists yet). */
export function sessionHeaderItem(cwd: string): TranscriptItem {
  const dir = basename(cwd) || cwd;
  return { key: HEADER_ITEM_KEY, seq: -1, step: null, kind: 'run:start', level: 'info', text: `jevcode session · ${oneLine(dir)} | step 0/– starting` };
}

/** First line, written before any engine exists; carries the same `step 0/–` sentinel as the TUI. */
export function plainFirstLine(task: string, resumeId: string | null): string {
  return formatTranscriptItem(headerItem(task, resumeId));
}

/** TUI-DESIGN §15 item 16: the plain renderer's options — `RendererOptions` plus the cwd the session header names. */
export interface PlainRendererOptions extends RendererOptions {
  /** the directory the `chat` header names (default `process.cwd()`) */
  cwd?: string;
  /**
   * TUI-DESIGN §1 (C46): whether the readline confirmer may ask at all. Wave 3 passes
   * `!flags.noInput && !isInCi && TERM !== 'dumb'`; default `Boolean(stdin.isTTY)`.
   */
  interactive?: boolean;
  /** TUI-DESIGN §1 / §6.5: the readline composer's shared line source (`composer.lines`); `setLineSource()` may hand it over later */
  lines?: LineSource;
}

/** The plain renderer: `Renderer` plus the contract-1.1 hooks it implements (TUI-DESIGN §15 item 16). */
export interface PlainRenderer extends Renderer {
  setHost(host: SessionHost): void;
  setUi(ui: UiConfig): void;
  notify(text: string, opts?: { level?: TranscriptLevel; detail?: string; label?: UiLabel }): void;
  /**
   * TUI-DESIGN §1 / §6.5: hand the readline composer's `lines` to the confirmer so both share the one stdin
   * interface; must run before the first review (before the first run starts) on a `--plain` TTY.
   */
  setLineSource(lines: LineSource): void;
  /** the host handed over by `setHost`, null before */
  readonly host: SessionHost | null;
  /** the session settings handed over by `setUi`, null before */
  readonly ui: UiConfig | null;
  /** TUI-DESIGN §14.1: the glyph table stdout is written through (`--ascii` → ASCII twins; items stay canonical) */
  readonly glyphs: GlyphSet;
}

/**
 * TUI-DESIGN §1 / §15.1: the line renderer for `--plain`, pipes, `CI`, `TERM=dumb` and `--no-input`.
 * Engine items come from `itemsFromEvent` (identical to transcript.log and the TUI); idle-time
 * local items arrive through `notify()` and print with their label (`[ui]`, `[setup]`, `[config]`,
 * `[sandbox]`). The readline confirmer takes the session host's gate once `setHost()` ran and the
 * composer's shared line source once `setLineSource()` ran. TUI-DESIGN §14.1: stdout is written
 * through the launch glyph table (`--ascii`); the item strings themselves — and so transcript.log —
 * stay canonical Unicode.
 */
export function createPlainRenderer(opts: PlainRendererOptions): PlainRenderer {
  const stdout: ConfirmOutput = opts.stdout ?? process.stdout;
  const stdin: ConfirmInput = opts.stdin ?? process.stdin;
  let seq = 0;
  let localSeq = 0;
  // A raw generator stream is on the current line until `proposal` (or any item) terminates it.
  let streamOpen = false;
  let detach: (() => void) | null = null;
  let host: SessionHost | null = opts.host ?? null;
  let ui: UiConfig | null = null;
  let lines: LineSource | null = opts.lines ?? null;
  // TUI-DESIGN §14.1 / §16: the glyph mode is a launch setting (flag > env > default), fixed before the first frame
  const glyphs = glyphSet({ ...(opts.launch?.ascii !== undefined ? { ascii: opts.launch.ascii } : {}), ...(opts.launch?.screenReader !== undefined ? { screenReader: opts.launch.screenReader } : {}) });
  const write = (s: string): void => {
    stdout.write(glyphTwin(s, glyphs));
  };

  const header = opts.mode === 'session' ? sessionHeaderItem(opts.cwd ?? process.cwd()) : headerItem(opts.task, opts.resumeId);
  const firstFrame = new Promise<void>((resolve) => {
    stdout.write(glyphTwin(`${formatTranscriptItem(header)}\n`, glyphs), () => resolve());
  });

  const confirmer = createReadlineConfirmer(stdin, stdout, {
    onAbort: (reason) => opts.onAbort(reason),
    ...(opts.confirmTimeoutMs !== undefined ? { confirmTimeoutMs: opts.confirmTimeoutMs } : {}),
    ...(opts.interactive !== undefined ? { interactive: opts.interactive } : {}),
    host: () => host,
    lines: () => lines,
    glyphs,
  });

  function endStream(): void {
    if (streamOpen) {
      stdout.write('\n');
      streamOpen = false;
    }
    lineStart = true;
  }

  // AGENT-LOOP-DESIGN §9.4 / §A1 (slice S5a): an agent run prints its prose AS IT ARRIVES, each line opened with the
  // `[jevcode] ` label (written with the line's first character, so a blank line is `[jevcode]` exactly as its
  // transcript.log row), skips the `assistant:text` rows of a turn that streamed, holds the run's own rows until its first
  // tool call and drops them when it ends as a reply: a tool-less turn prints only `[you] …` / `[jevcode] …`.
  let agentRun = false;
  let agentTools = false;
  let agentHeld: TranscriptItem[] = [];
  let agentSteps: Pick<StepRecord, 'agent'>[] = [];
  let turnStreamed = false;
  let lineStart = true;
  // one per model turn (both paths): a sequence split between two deltas is held, never printed half-stripped
  let deltas: TerminalStreamSanitizer = createTerminalStreamSanitizer();

  function writeItems(items: readonly TranscriptItem[]): void {
    if (items.length === 0) return;
    endStream();
    for (const item of items) write(`${formatTranscriptItem(item)}\n`);
  }

  /** `clean` is already sanitized (`deltas.push` / `deltas.flush`) */
  function writeProse(clean: string): void {
    const text = clean.replace(/\r/g, '');
    if (text.length === 0) return;
    let out = '';
    for (const part of text.split(/(\n)/)) {
      if (part === '') continue;
      if (part === '\n') {
        out += lineStart ? `${PROSE_PLAIN_LABEL}\n` : '\n';
        lineStart = true;
        continue;
      }
      if (lineStart) out += `${PROSE_PLAIN_LABEL} `;
      out += part;
      lineStart = false;
    }
    write(out);
    streamOpen = !lineStart;
    turnStreamed = true;
  }

  /** the turn's stream ended: what the sanitizer still held (an unfinished sequence is dropped) */
  function flushProse(): void {
    writeProse(deltas.flush());
  }

  function handleAgent(e: EngineEvent): void {
    switch (e.type) {
      case 'generator:start':
        if ((e.sample ?? 0) === 0) {
          flushProse();
          deltas = createTerminalStreamSanitizer();
          turnStreamed = false;
          // a new turn starts a new line: two turns' prose never run together (`…exit 0).The "failure" is…`, S6 review)
          endStream();
        }
        return;
      case 'generator:delta':
        if (e.sample !== undefined && e.sample >= 1) return;
        writeProse(deltas.push(e.text));
        return;
      case 'assistant:text':
        // a line commit comes mid-stream (a sequence may still be open across the next delta); the final one ends it
        if (e.final) flushProse();
        // the raw deltas already printed this turn's prose; a turn with no deltas (a JSON transport) prints its lines here
        if (turnStreamed) return;
        break;
      case 'assistant:reset':
        // a provider retry restarts the text: nothing the failed attempt left half-open carries over
        deltas = createTerminalStreamSanitizer();
        break;
      case 'run:end':
        flushProse();
        break;
      case 'step:end':
        agentSteps.push(e.record.agent !== undefined ? { agent: e.record.agent } : {});
        break;
      default:
        break;
    }
    // AGENT-LOOP-DESIGN §9.4 (the S6 review's --plain polish): one row per step — the `[step N] Read … · Edit … · Bash … · exit 0`
    // summary — not its `tool ·`, `proposal ·`, `done ·` and `plan ·` rows as well (transcript.log keeps every row); a warning
    // or a failure still prints
    const items = itemsFromEvent(e, seq).filter((i) => !PLAIN_AGENT_STEP_DETAIL.has(i.kind) || i.level === 'warn' || i.level === 'error');
    seq += items.length;
    if (!agentTools && isAgentToolActivity(e)) {
      agentTools = true;
      writeItems(agentHeld);
      agentHeld = [];
    }
    if (e.type === 'run:end') {
      const reply = agentRunEndedAsReply(e.result.stopReason, agentSteps, agentTools);
      if (!reply) writeItems(agentHeld);
      agentHeld = [];
      if (!reply) writeItems(items);
      else endStream();
      agentRun = false;
      return;
    }
    if (!agentTools && e.type !== 'assistant:reset') {
      agentHeld.push(...items.filter(isHoldableAgentRow));
      writeItems(items.filter((i) => !isHoldableAgentRow(i)));
      return;
    }
    writeItems(items);
  }

  /** the legacy modes' raw generator stream: already sanitized text, printed as it came */
  function writeRaw(text: string): void {
    if (text.length === 0) return;
    stdout.write(text);
    streamOpen = !text.endsWith('\n');
  }

  function handle(e: EngineEvent): void {
    if (e.type === 'run:start') deltas = createTerminalStreamSanitizer();
    if (e.type === 'run:start' && e.mode === 'agent') {
      agentRun = true;
      agentTools = false;
      agentSteps = [];
      turnStreamed = false;
      endStream();
      agentHeld = itemsFromEvent(e, seq);
      seq += agentHeld.length;
      return;
    }
    if (agentRun) {
      handleAgent(e);
      return;
    }
    if (e.type === 'generator:delta') {
      // llm-jev (docs/LLM-JEV-DESIGN.md §9.3): only the first candidate streams; later samples would interleave here
      if (e.sample !== undefined && e.sample >= 1) return;
      writeRaw(deltas.push(e.text));
      return;
    }
    const items = itemsFromEvent(e, seq);
    if (items.length === 0) return;
    seq += items.length;
    // an item ends the raw stream: what the sanitizer held is flushed onto its line first
    writeRaw(deltas.flush());
    endStream();
    for (const item of items) write(`${formatTranscriptItem(item)}\n`);
  }

  return {
    confirmer,
    glyphs,
    get host() {
      return host;
    },
    get ui() {
      return ui;
    },
    attach(engine: Engine) {
      detach?.();
      detach = engine.events.onAny(handle);
    },
    firstFrame: () => firstFrame,
    setHost(h: SessionHost) {
      host = h;
    },
    setUi(u: UiConfig) {
      ui = u;
    },
    setLineSource(l: LineSource) {
      lines = l;
    },
    // TUI-DESIGN §15.1: an idle-time renderer-local item — `--plain` prints it with its label; no transcript.log exists to hold it
    notify(text, o = {}) {
      const item = localItem(text, localSeq++, { ...(o.label ? { label: o.label } : {}), ...(o.level ? { level: o.level } : {}), ...(o.detail ? { detail: o.detail } : {}) });
      endStream();
      write(`${formatTranscriptItem(item)}\n`);
    },
    /**
     * contract 1.7 item 3 (TUI-DESIGN-4 §3.5, D-W): the row-list form of a block body. `lines` are the
     * ALREADY-RENDERED row texts `renderBlock` produced; each becomes one `[ui] <row>` item, head first, so
     * `--plain`'s stdout and `--plain`'s `transcript.log` carry the same rows the TUI's `<Static>` body does.
     * This IS today's per-line `note` — written out so the default and the override cannot drift.
     */
    blockLines(rows, o = {}) {
      for (const row of rows) this.notify(row, o);
    },
    async unmount() {
      detach?.();
      detach = null;
      endStream();
      await new Promise<void>((resolve) => {
        stdout.write('', () => resolve());
      });
    },
  };
}

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-5 §4.2 / §13.1: the agent tree's `--plain` and `transcript.log` twin
// ---------------------------------------------------------------------------------------

/**
 * §13.1 / §9.2 (`src/tui/plain.ts`'s row): the agent rows route through **this one formatter**, so the Ink tab, the
 * `--plain` block and the `transcript.log` rows `Engine.annotateBlock` writes are the same rows by construction.
 * The row strings themselves are `src/tui/agents/lines.ts`'s — nothing is re-declared here (the §13.4 rule).
 *
 * §13.2 clause 6 is the one declared difference and it is asserted, not assumed: the Ink tab's visible subset is a
 * **viewport** (`src/tui/pane/agents.ts`), while this twin's row count equals `rows.length` — `agentRows` never
 * filters and never caps, so a `--plain` user sees every agent whatever the terminal is doing.
 *
 * §13.2 clause 1's width rule applies to the default: *`--plain` without a TTY renders the 120-column form*, so a
 * piped `jevcode agents list` keeps the branch / verify column rather than silently dropping it at
 * `CONFIRM_HEADER_COLUMNS`'s 80 — the twin must not be narrower than the tab a TTY would have drawn.
 */
export function agentBlockLines(rows: readonly AgentRow[], columns = AGENTS_WIDE_COLUMNS, g: GlyphSet = GLYPHS.unicode): string[] {
  const width = blockWidth(columns);
  return blockTexts(agentRows(rows, { width, g }), width, g);
}

/** §4.9 / §12.3 S85 (D-AN): `/agents`'s head row for the `--plain` block and `annotateBlock`'s head argument. */
export function agentBlockHead(rows: readonly AgentRow[]): string {
  return rows.length === 0 ? 'agents' : `agents (${rows.length})`;
}

/** §12 SR twin: the same rows with the glyph column dropped — the state word already carries the fact it encodes. */
export function agentScreenReaderLines(rows: readonly AgentRow[], columns = AGENTS_WIDE_COLUMNS): string[] {
  const width = blockWidth(columns);
  return rows.map((r) => agentRowText(r, { width, g: GLYPHS.sr, sr: true }));
}
