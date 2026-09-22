/**
 * The `propose_fix` prompt (docs/LLM-JEV-DESIGN.md §4.3–§4.4). One fixed system text per run and
 * a user message whose every section is bounded by `PROMPT_LIMITS_FIX`. The listing set is code
 * ∪ jev: the enclosing function of every traceback frame inside the workspace (≤ 3 deepest,
 * always present) plus the Jev anchors, ≤ 4 functions of ≤ 120 lines (or a ±40-line module-level
 * window) — the feedback round L1′ widens the set by up to `listingsWidenMax` more members (§4.9),
 * and `## Code` renders every member the caller built, never a hard slice at 4. No plan, no
 * intent, no window of prior steps: the attempt ledger is code-computed.
 * Hint h1 ("Jev put p=0.xx on L<n>") is given only when Q5's P(top) ≥ 0.9 (the 92 % bin);
 * below it the localisation section lists the candidate lines without a pointer.
 */
import { sha12 } from '../../core/hash.js';
import { clip, headTail } from '../../core/text.js';
import type { FailureView, SourceFile } from '../types.js';
import type { Block } from '../py/structure.js';
import type { OracleClass } from './types.js';

export const PROMPT_LIMITS_FIX = {
  taskHeadChars: 3000,
  taskTailChars: 1000,
  /** test ids named in the goal line; the rest is "+N more" */
  goalTests: 3,
  failures: 3,
  callChars: 200,
  expectedChars: 300,
  actualChars: 300,
  tracebackChars: 1500,
  reproScriptLines: 60,
  reproOutputChars: 600,
  /** traceback frames always in the listing set (deepest first) */
  tracebackFrames: 3,
  /** Jev-ranked localisation lines shown after the frames */
  jevLines: 5,
  listingLines: 120,
  listings: 4,
  /** the feedback round's widening at most (§4.9: 3 members, 6 on a strong fix-absent signal); `## Code` never shows more than `listings + listingsWidenMax` */
  listingsWidenMax: 6,
  /** ± window for a module-level listing member */
  moduleWindowLines: 40,
  outlines: 5,
  outlineSymbols: 40,
  attempts: 6,
  attemptChars: 600,
  partialChars: 1200,
} as const;

/** Q5 P(top) at or above which the h1 anchor hint is given (58/63 = 92 % in the probe bin). */
export const H1_MIN_TOP_P = 0.9;

export type HintTier = 'h1' | 'h2' | 'h3' | 'h4';

export interface HintAnchor {
  path: string;
  line: number;
  probability: number;
}

export interface FixHint {
  tiers: readonly HintTier[];
  /** the Q5 top line, for h1 */
  anchor?: HintAnchor;
  /** the Q7 edit class, for h4 */
  editClass?: string;
}

export const NO_HINT: FixHint = { tiers: [] };

export interface Listing {
  path: string;
  /** enclosing function (qualname when known), null for a module-level window */
  name: string | null;
  startLine: number;
  endLine: number;
  /** physical lines startLine..endLine */
  lines: readonly string[];
  origin: 'traceback' | 'jev';
}

export interface LocalisationLine {
  path: string;
  line: number;
  fn: string | null;
  origin: 'traceback' | 'jev';
  probability?: number;
}

export interface OutlineView {
  path: string;
  symbols: readonly string[];
}

export interface ReproView {
  script: string;
  output: string;
}

/** One entry of the attempt ledger (§4.4 "Earlier attempts this run"), built in candidates.ts from VerifyOutcomes and dropped hunks. */
export interface AttemptRecord {
  /** the candidate's `op` (`sample_<k>_<j>`) or a seed source name */
  op: string;
  step: number;
  /** head of the unified diff */
  diffHead: string;
  /** the code verdict sentence */
  verdict: string;
  /** sha12 of the diff ('' for a hunk that never applied) */
  sha: string;
}

export interface FixPromptInput {
  goal: { tests: readonly string[]; path: string };
  task: string;
  failures: readonly FailureView[];
  traceback?: string | null;
  repro?: ReproView | null;
  localisation: readonly LocalisationLine[];
  listings: readonly Listing[];
  outlines?: readonly OutlineView[];
  attempts: readonly AttemptRecord[];
  partial?: { diff: string } | null;
  hint: FixHint;
  /** `## Code` members shown; default every listing given (the caller's `listingSet` bounds them), never above `listings + listingsWidenMax` */
  maxListings?: number;
}

// ---------------------------------------------------------------------------------------
// System prompt (§4.4, fixed per run)
// ---------------------------------------------------------------------------------------

export function buildFixSystemPrompt(): string {
  return [
    'You write patches for a Python repository. The harness has localised the fault, will run every patch you return against the failing tests and a regression scope in an isolated copy, and commits only what passes; a patch that fails is shown back to you with its test outcome.',
    'You never run commands, read other files, or decide when the task is done.',
    'Return 1–3 genuinely different patches as `propose_fix`. Each edit replaces one contiguous block: `old` is copied verbatim from the listing (including indentation; ≥ 1 line; unique in the file — add a neighbouring line if needed), `new` is its replacement (empty `new` deletes the block). Set `near_line` to the `L<n>` of the first line of `old`.',
    'Never edit files under `tests/`. At most 4 files and 12 edits per patch. If the fix needs code you cannot see, fill `need` and return no patches.',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------
// Listing set (§4.3)
// ---------------------------------------------------------------------------------------

export interface ListingMember {
  path: string;
  line: number;
  fn?: string | null;
}

export interface ListingSetInput {
  files: ReadonlyMap<string, SourceFile>;
  /** workspace traceback frames, innermost last (localize/outline.ts tracebackFrames order) */
  frames: readonly ListingMember[];
  /** Jev anchors in rank order (Q5 lines or the Q2–Q4 top sites) */
  anchors: readonly ListingMember[];
  maxListings?: number;
  maxLines?: number;
}

function innermostDef(file: SourceFile, line: number): Block | null {
  let best: Block | null = null;
  for (const b of file.mod.blocks) {
    if (b.kind !== 'def' || line < b.startLine || line > b.endLine) continue;
    if (best === null || b.depth > best.depth) best = b;
  }
  return best;
}

function qualname(file: SourceFile, b: Block): string {
  const parts = [b.name];
  let p = b.parent;
  while (p !== null) {
    const pb = file.mod.blocks[p];
    if (pb === undefined) break;
    parts.unshift(pb.name);
    p = pb.parent;
  }
  return parts.join('.');
}

/** A window of ≤ `maxLines` lines of [start, end] that contains `line` (the function head is kept when it fits). */
function windowAround(start: number, end: number, line: number, maxLines: number): { start: number; end: number } {
  if (end - start + 1 <= maxLines) return { start, end };
  let s = Math.max(start, line - Math.floor(maxLines / 2));
  let e = s + maxLines - 1;
  if (e > end) {
    e = end;
    s = e - maxLines + 1;
  }
  return { start: s, end: e };
}

/** The listing member for one (path, line): its enclosing function, or a ±window at module level. Null when the file is unknown. */
export function listingAt(files: ReadonlyMap<string, SourceFile>, m: ListingMember, origin: Listing['origin'], maxLines: number = PROMPT_LIMITS_FIX.listingLines): Listing | null {
  const file = files.get(m.path);
  if (file === undefined) return null;
  const total = file.mod.lines.length;
  if (total === 0) return null;
  const line = Math.min(Math.max(1, m.line), total);
  const def = innermostDef(file, line);
  const range = def === null ? windowAround(Math.max(1, line - PROMPT_LIMITS_FIX.moduleWindowLines), Math.min(total, line + PROMPT_LIMITS_FIX.moduleWindowLines), line, maxLines) : windowAround(def.startLine, def.endLine, line, maxLines);
  return { path: m.path, name: def === null ? null : qualname(file, def), startLine: range.start, endLine: range.end, lines: file.mod.lines.slice(range.start - 1, range.end), origin };
}

/**
 * Code ∪ jev: the ≤ 3 deepest traceback frames' functions first (never removed by Jev's rank),
 * then the anchors' functions in rank order, de-duplicated by span, ≤ `maxListings` in total.
 */
export function listingSet(input: ListingSetInput): Listing[] {
  const max = input.maxListings ?? PROMPT_LIMITS_FIX.listings;
  const maxLines = input.maxLines ?? PROMPT_LIMITS_FIX.listingLines;
  const out: Listing[] = [];
  const seen = new Set<string>();
  const add = (m: ListingMember, origin: Listing['origin']): void => {
    if (out.length >= max) return;
    const l = listingAt(input.files, m, origin, maxLines);
    if (l === null) return;
    const key = `${l.path}:${l.startLine}-${l.endLine}`;
    if (seen.has(key)) return;
    // a frame inside a span already listed from an anchor (or vice versa) is the same member
    if (out.some((x) => x.path === l.path && x.startLine <= m.line && m.line <= x.endLine)) return;
    seen.add(key);
    out.push(l);
  };
  const deepest = input.frames.slice(-PROMPT_LIMITS_FIX.tracebackFrames).reverse();
  for (const f of deepest) add(f, 'traceback');
  for (const a of input.anchors) add(a, 'jev');
  return out;
}

/** Identity of a listing set for the round cache: paths, spans and the text they show. */
export function listingHash(listings: readonly Listing[]): string {
  return sha12(listings.map((l) => [l.path, l.startLine, l.endLine, sha12(l.lines.join('\n'))]));
}

// ---------------------------------------------------------------------------------------
// Hints (§4.4, §4.6)
// ---------------------------------------------------------------------------------------

/** h1 is given only at or above the measured 92 % bin. */
export function h1Allowed(pTop: number | undefined | null): boolean {
  return typeof pTop === 'number' && pTop >= H1_MIN_TOP_P;
}

export interface HintScheduleOptions {
  /** the Q5 top line and its probability; h1 is dropped from the schedule unless `h1Allowed` */
  anchor?: HintAnchor | null;
  /** the Q7 top edit class when Q7 was asked (h4) */
  editClass?: string | null;
  /** repository class: `t_repro ≤ 2 s` widens the schedule (h1+h2, h4) */
  tReproMs?: number | null;
}

/** Sample 0 always h0; the rest follow the class's hint column of the §4.6 table, h1 gated. */
export function hintSchedule(klass: OracleClass, n: number, opts: HintScheduleOptions = {}): FixHint[] {
  const anchor = opts.anchor ?? null;
  const h1 = anchor !== null && h1Allowed(anchor.probability);
  const editClass = opts.editClass ?? null;
  const fast = klass === 'repository' && (opts.tReproMs ?? Number.POSITIVE_INFINITY) <= 2000;
  const column: HintTier[][] = klass === 'repository' && fast ? [['h1'], ['h2'], ['h3'], ['h1', 'h2'], ['h4']] : [['h1'], ['h2'], ['h3'], ...(editClass !== null && klass === 'quixbugs' ? [['h4'] as HintTier[]] : [])];
  const usable = column
    .map((tiers) => tiers.filter((t) => (t === 'h1' ? h1 : t === 'h4' ? editClass !== null : true)))
    .filter((tiers) => tiers.length > 0);
  const out: FixHint[] = [NO_HINT];
  for (let k = 1; k < n; k++) {
    const tiers = usable.length === 0 ? [] : usable[(k - 1) % usable.length]!;
    const hint: FixHint = { tiers };
    if (tiers.includes('h1') && anchor !== null) hint.anchor = anchor;
    if (tiers.includes('h4') && editClass !== null) hint.editClass = editClass;
    out.push(hint);
  }
  return out;
}

/** The `## Hint` line, or null for h0. An h1 whose anchor fails the gate is silently omitted. */
export function renderHint(hint: FixHint): string | null {
  const parts: string[] = [];
  for (const t of hint.tiers) {
    switch (t) {
      case 'h1':
        if (hint.anchor !== undefined && h1Allowed(hint.anchor.probability)) parts.push(`Jev put p=${hint.anchor.probability.toFixed(2)} on \`${hint.anchor.path}:L${hint.anchor.line}\`.`);
        break;
      case 'h2':
        parts.push('Prefer the smallest change that fixes the failing behaviour.');
        break;
      case 'h3':
        parts.push('A statement may be missing — consider inserting one rather than changing an existing line.');
        break;
      case 'h4':
        if (hint.editClass !== undefined) parts.push(`A code analysis suggests the edit class \`${hint.editClass}\` (a soft hint; ignore it if the evidence says otherwise).`);
        break;
    }
  }
  return parts.length === 0 ? null : parts.join(' ');
}

// ---------------------------------------------------------------------------------------
// User message (§4.4)
// ---------------------------------------------------------------------------------------

const ERROR_ACTUAL = /^(?:[A-Z]\w*(?:Error|Exception|Exit|Interrupt|Warning)\b|timeout\b|Timeout\b|recursion)/;

function statusOf(f: FailureView): 'failed' | 'error' {
  return ERROR_ACTUAL.test(f.actual.trim()) ? 'error' : 'failed';
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function goalLine(goal: FixPromptInput['goal']): string {
  const shown = goal.tests.slice(0, PROMPT_LIMITS_FIX.goalTests);
  const more = goal.tests.length - shown.length;
  return `# Goal\nfix ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''} in ${goal.path}`;
}

function taskSection(task: string): string {
  return `## Task\n${headTail(task.trim(), PROMPT_LIMITS_FIX.taskHeadChars, PROMPT_LIMITS_FIX.taskTailChars)}`;
}

function failureSection(input: FixPromptInput): string {
  const L = PROMPT_LIMITS_FIX;
  const rows = input.failures.slice(0, L.failures).map((f) => `- ${f.testId}: called ${clip(oneLine(f.call), L.callChars)} ; expected ${clip(oneLine(f.expected), L.expectedChars)} ; actual ${clip(oneLine(f.actual), L.actualChars)} ; status ${statusOf(f)}`);
  const more = input.failures.length - Math.min(input.failures.length, L.failures);
  if (more > 0) rows.push(`- +${more} more failing tests of this goal`);
  const parts = [`## Failing behaviour`, ...rows];
  const tb = input.traceback?.trim() ?? '';
  if (tb !== '') parts.push('traceback tail:', tb.length > L.tracebackChars ? tb.slice(-L.tracebackChars) : tb);
  if (input.repro) {
    const lines = input.repro.script.split('\n');
    const script = lines.length > L.reproScriptLines ? [...lines.slice(0, L.reproScriptLines), `# … ${lines.length - L.reproScriptLines} more lines`].join('\n') : input.repro.script;
    parts.push('reproduction script:', '```python', script, '```', 'its output at base:', clip(input.repro.output, L.reproOutputChars));
  }
  return parts.join('\n');
}

function localisationSection(input: FixPromptInput): string {
  const frames = input.localisation.filter((l) => l.origin === 'traceback').slice(-PROMPT_LIMITS_FIX.tracebackFrames).reverse();
  const jev = input.localisation.filter((l) => l.origin === 'jev').slice(0, PROMPT_LIMITS_FIX.jevLines);
  const row = (l: LocalisationLine): string => `- ${l.path}:L${l.line}${l.fn ? ` (fn ${l.fn})` : ''}${l.origin === 'traceback' ? ' — traceback frame' : ''}`;
  const rows = [...frames.map(row), ...jev.map(row)];
  if (rows.length === 0) rows.push('- (no localisation beyond the listing)');
  return ['## Localisation', ...rows].join('\n');
}

/** The `## Code` cap a prompt input asks for: its `maxListings` or every listing, bounded by `listings + listingsWidenMax`. */
export function codeListingCap(input: Pick<FixPromptInput, 'listings' | 'maxListings'>): number {
  const L = PROMPT_LIMITS_FIX;
  return Math.max(0, Math.min(input.maxListings ?? input.listings.length, L.listings + L.listingsWidenMax));
}

function codeSection(listings: readonly Listing[], max: number): string {
  const parts = ['## Code'];
  for (const l of listings.slice(0, max)) {
    const lines = l.lines.slice(0, PROMPT_LIMITS_FIX.listingLines);
    parts.push(`${l.path} — ${l.name === null ? 'module level' : `fn ${l.name}`} L${l.startLine}-L${l.startLine + lines.length - 1}`);
    lines.forEach((text, i) => parts.push(`L${l.startLine + i}: ${text}`));
  }
  if (listings.length === 0) parts.push('(no listing)');
  return parts.join('\n');
}

function outlineSection(outlines: readonly OutlineView[] | undefined): string | null {
  if (outlines === undefined || outlines.length === 0) return null;
  const parts = ['## Other files'];
  for (const o of outlines.slice(0, PROMPT_LIMITS_FIX.outlines)) {
    const syms = o.symbols.slice(0, PROMPT_LIMITS_FIX.outlineSymbols);
    parts.push(`- ${o.path}: ${syms.join(', ')}${o.symbols.length > syms.length ? `, … ${o.symbols.length - syms.length} more` : ''}`);
  }
  return parts.join('\n');
}

/** One ledger row, ≤ `attemptChars`: the verdict first (it is what the model must not repeat), then the diff head. */
export function renderAttempt(a: AttemptRecord): string {
  const L = PROMPT_LIMITS_FIX.attemptChars;
  const head = `- ${a.op} (step ${a.step}): ${oneLine(a.verdict)}`;
  const room = L - head.length - 1;
  if (room <= 20 || a.diffHead.trim() === '') return clip(head, L);
  return `${head}\n${clip(a.diffHead.trimEnd(), room)}`;
}

function attemptsSection(attempts: readonly AttemptRecord[]): string | null {
  if (attempts.length === 0) return null;
  const shown = attempts.slice(-PROMPT_LIMITS_FIX.attempts);
  return ['## Earlier attempts this run', ...shown.map(renderAttempt)].join('\n');
}

function partialSection(partial: FixPromptInput['partial']): string | null {
  if (!partial || partial.diff.trim() === '') return null;
  return ['## Best partial so far', 'This held edit fixes some of the tests; you may include it in a patch.', clip(partial.diff.trimEnd(), PROMPT_LIMITS_FIX.partialChars)].join('\n');
}

/** The bounded user message of §4.4. */
export function buildFixUserMessage(input: FixPromptInput): string {
  const sections: (string | null)[] = [
    goalLine(input.goal),
    taskSection(input.task),
    failureSection(input),
    localisationSection(input),
    codeSection(input.listings, codeListingCap(input)),
    outlineSection(input.outlines),
    attemptsSection(input.attempts),
    partialSection(input.partial),
    (() => {
      const h = renderHint(input.hint);
      return h === null ? null : `## Hint\n${h}`;
    })(),
    '## Reply\nCall `propose_fix`.',
  ];
  return sections.filter((s): s is string => s !== null).join('\n\n');
}

/** Sum of the section caps: an upper bound on the user message a caller can assert against (chars); `widen` = the feedback round's extra listing members (≤ `listingsWidenMax`). */
export function fixPromptCharBound(widen = 0): number {
  const L = PROMPT_LIMITS_FIX;
  const listing = (L.listings + Math.min(Math.max(0, widen), L.listingsWidenMax)) * L.listingLines * 200;
  return 2000 + L.taskHeadChars + L.taskTailChars + L.failures * (L.callChars + L.expectedChars + L.actualChars + 200) + L.tracebackChars + L.reproScriptLines * 200 + L.reproOutputChars + (L.tracebackFrames + L.jevLines) * 200 + listing + L.outlines * (L.outlineSymbols * 40 + 200) + L.attempts * (L.attemptChars + 10) + L.partialChars + 400;
}
