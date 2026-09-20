/**
 * Site list for one sub-goal (docs/JEV-ONLY-DESIGN.md §2.5), built over `src/synth/localize`:
 *
 *   replace sites = Q5 top-3 lines per beam function (p ≥ 0.05)
 *                 ∪ Q5n Noul top-3 (single-file workspaces, one request asked here)
 *                 ∪ SBFL top-5 (single file) / top-3 (repository)
 *     unioned, never score-combined; `def` lines never; ordered Jev evidence by p first, then
 *     SBFL-only lines by Ochiai rank (Ochiai is top-1 on 7/38 but top-5 on 34/38,
 *     experiments/results/lit-search-based-repair.md §6; the union of two top-3 lists covered
 *     38/40, probe-localization.md §8.2).
 *   insert sites  = the gap after AND before each of the top-3 Jev anchors (both neighbours of
 *     the four QuixBugs insertion points sit at D ranks 2–5, probe-localization.md §3.4)
 *                 + Q6 `insert_after` top-3 gaps when a template statement is known (4/4 given
 *     the statement, 2/4 without: a site list, never a pick, probe-donor-and-templates.md §4)
 *                 + the gap after the last executed line of the failing test when the spectrum
 *     shows a line of the function the failing test never reaches (`shunting_yard`).
 *                 + the module-level import gap (after the last top-level import, else after the
 *     docstring, else line 1) of every suspected file that uses a name the failure text says is
 *     missing (`goal.missingNames`, a NameError / ImportError read by goals.ts): the traceback
 *     points inside the function that used the name, the fix goes at the top of the module
 *     (ladder `tagcloud`). Visited first: it holds a handful of import candidates at most.
 *   cut at 6 + 6; insert sites are visited after the replace site of the same anchor, or first
 *   when Q5 put ≥ 0.3 on `none_of_these` or Q7 puts ≥ 0.5 on `insert_new_line`.
 *
 * WIDENED (§2.3 phase W): every code line of the beam functions as replace sites, `def` lines
 * excluded, handed out in chunks with a cursor the caller carries across steps in
 * `mem.widenCursor` (median 23.8 s, max 119 s per QuixBugs program at 12-way,
 * contrarian-exhaustive.all.jsonl, so one step rarely runs it all).
 *
 * Every Jev question here goes through the caller's `ask` (the engine's `ctx.ask`) with the
 * measured wording; nothing asks Jev to count or compare numbers.
 */
import type { Answer, Json, Question, StageName } from '../../core/types.js';
import { AbortError } from '../../errors.js';
import { ESCAPE_KEY, assertQuestionBatch, choice, noul } from '../../jev/questions.js';
import type { NoulCriteriaSpec } from '../../jev/questions.js';
import { FAILURE_FIELD_CHARS_MAX, LINE_CHARS_MAX, TASK_CHARS_MAX, centredWindow, clip } from '../localize/budget.js';
import { lineKey } from '../localize/keys.js';
import { codeLines, entryAt, functionEntries } from '../localize/outline.js';
import type { CodeLine } from '../localize/outline.js';
import { FAILING_RUN_SUFFIX, LINE_QUESTION_ID } from '../localize/questions.js';
import { buildSites, indentAfter, isDefLine, sbflAnchorsFor, sbflKey } from '../localize/sites.js';
import type { Anchor } from '../localize/sites.js';
import type { FunctionEntry } from '../localize/types.js';
import { indentOf } from '../py/edits.js';
import { scopeAt, statementAt } from '../py/structure.js';
import type { PerTestResult, RankedLine } from '../sbfl/types.js';
import { isFailing } from '../sbfl/ochiai.js';
import { importInsertLine, unboundNames } from '../templates/imports.js';
import type { FailureView, FunctionCandidate, JevAsk, LocalizeResult, Site, SiteEvidence, SourceFile } from '../types.js';
import type { Goal } from './types.js';

// ---------------------------------------------------------------------------------------
// Measured constants
// ---------------------------------------------------------------------------------------

/** Q5 anchors kept per beam function: top-3 covers 36/40 (probe-localization.md §1); below 0.05 a line is noise from a flat answer. */
export const ANCHORS_PER_FUNCTION = 3;
export const Q5_ANCHOR_MIN_P = 0.05;
/** Q5n Nouls: top-3 unioned with Q5's top-3 covers 38/40; exactly one line ≥ 0.9 was right 17/17 (probe-localization.md §8.3). */
export const Q5N_TOP = 3;
export const Q5N_SHORT_CIRCUIT_P = 0.9;
/** Lines per Noul request: the 255-option bound the probes used (one Noul per line). */
export const Q5N_MAX_LINES = 254;
/** Site cut of design §2.5 item 3 (the 32k state cap is enforced by localize/budget.ts). */
export const REPLACE_SITES_MAX = 6;
export const INSERT_SITES_MAX = 6;
/** Insert sites first when Q5 put this much on `none_of_these` (grammar-synthesis K rule: escape ≥ 0.3 means "not a listed line"). */
export const Q5_ESCAPE_INSERT_FIRST = 0.3;
/** Insert sites first when Q7 puts this much on `insert_new_line` (Q7 top-1 28–29/40; a soft prior, never a gate). */
export const Q7_INSERT_NEW_LINE_FIRST = 0.5;
/** Q6 gaps kept per known statement: the gap Choice was top-1 4/4 given the statement; three keeps both neighbours of a near miss. */
export const Q6_TOP_GAPS = 3;
/** Q6 is asked only when the function has more gaps than the anchor gaps already cover (design §2.7 Q6: "> 6 gaps"). */
export const Q6_MIN_GAPS = 6;
/** Statements asked about per goal per step (one request each, ≈ $0.0001). */
export const Q6_MAX_STATEMENTS = 2;
/** Tests shown in the Q5n / Q6 state (variant D used three). */
export const TESTS_IN_STATE = 3;

// ---------------------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------------------

/** What `buildGoalSites` needs from the engine context (`SynthesisContext` satisfies ask/task/signal). */
export interface GoalSiteContext {
  ask: JevAsk;
  task: string;
  signal: AbortSignal;
  /** the workspace's Python files, path -> analysed source (the same map the localizer saw) */
  files: ReadonlyMap<string, SourceFile>;
}

/** Spectrum evidence: the Ochiai ranking and, when available, the per-test coverage it came from. */
export interface SbflEvidence {
  ranked: readonly RankedLine[];
  perTest?: readonly PerTestResult[];
}

export interface GoalSiteOptions {
  /** P(none_of_these) of the goal's Q5 line Choice when the caller captured it (`captureLineChoiceEscape`) */
  q5EscapeProbability?: number;
  /** Q7 P(insert_new_line) when the caller already asked it; `orderGoalSites` re-orders later otherwise */
  insertNewLineProbability?: number;
  /** template statements whose placement is unknown: each gets one Q6 request (≤ Q6_MAX_STATEMENTS) */
  missingStatements?: readonly string[];
  /** ask the per-line Nouls (default: single-file workspaces only, as measured) */
  askLineNouls?: boolean;
  maxReplaceSites?: number;
  maxInsertSites?: number;
  /** stage recorded on the decision rows (the design routes every synthesizer question through `propose`) */
  stage?: StageName;
}

export interface GoalSites {
  /** replace sites in visiting order, ≤ maxReplaceSites */
  replace: Site[];
  /** insert sites in visiting order, ≤ maxInsertSites */
  insert: Site[];
  /** the interleaved order the search visits (see `orderGoalSites`) */
  ordered: Site[];
  insertFirst: boolean;
  /** the one line Q5n put ≥ 0.9 on when exactly one did: tried alone first */
  shortCircuit: Site | null;
  /** insert-site key -> anchor site key, for re-ordering after Q7 */
  insertAnchors: ReadonlyMap<string, string>;
  /** `path:line` -> Q5n probability */
  lineNouls: ReadonlyMap<string, number>;
  requests: number;
  notes: string[];
}

export function siteKey(s: Pick<Site, 'file' | 'line' | 'kind'>): string {
  return `${s.file.path}:${s.line}:${s.kind}`;
}

// ---------------------------------------------------------------------------------------
// Question builders (measured wording)
// ---------------------------------------------------------------------------------------

/** Q5n criteria, verbatim from experiments/probe-localize/quixbugs-localize.mts (variant C). */
export const LINE_NOUL_CRITERIA: NoulCriteriaSpec = {
  true: {
    definition: 'This line contains the defect: changing this line, and only this line, makes every test pass. The wrong operator, bound, argument, index, condition or return value is on this line.',
    examples: ['a `while` condition that never becomes false and the test times out', 'a recursive call whose arguments are swapped', 'a `return` of the wrong value or shape', 'an `if` bound using `<` where `<=` is needed'],
  },
  false: {
    definition: 'This line is correct as written. It may compute a value the faulty line misuses, be a `def` line, or an unrelated statement.',
    examples: ['the `def` line of the function', 'an initialisation such as `result = []` that the tests do not contradict', 'a line whose value is consumed by another line where the actual mistake is'],
  },
};

/** A code line to judge, with the function it belongs to when several functions are listed. */
export interface NoulLine extends CodeLine {
  fn?: string;
}

export interface LineNoulInput {
  task: string;
  failures: readonly FailureView[];
  /** the function whose lines are judged (the `<fn>` of the measured wording) unless a line names its own */
  functionName: string;
  lines: readonly NoulLine[];
}

/** The variant-D state shared by the line questions: `program`, `tests`, `failing_test_run`. */
function lineState(task: string, failures: readonly FailureView[], lines: readonly CodeLine[]): Record<string, Json> {
  const program: Record<string, Json> = {};
  for (const l of lines) program[`L${l.line}`] = clip(l.text, LINE_CHARS_MAX);
  const first = failures[0];
  const state: Record<string, Json> = { task: clip(task, TASK_CHARS_MAX) + (first === undefined ? '' : FAILING_RUN_SUFFIX), program };
  const shown = failures.slice(0, TESTS_IN_STATE);
  if (shown.length > 0) state['tests'] = shown.map((f) => ({ call: clip(f.call, FAILURE_FIELD_CHARS_MAX), expected: clip(f.expected, FAILURE_FIELD_CHARS_MAX) }));
  if (first !== undefined) state['failing_test_run'] = { call: clip(first.call, FAILURE_FIELD_CHARS_MAX), expected: clip(first.expected, FAILURE_FIELD_CHARS_MAX), actual: clip(first.actual, FAILURE_FIELD_CHARS_MAX) };
  return state;
}

/** Q5n: one Noul per code line, measured wording (variant C), criteria on every Noul. */
export function lineNoulRequest(input: LineNoulInput): { state: Json; questions: Record<string, Question> } {
  const state = lineState(input.task, input.failures, input.lines);
  const names = new Set(input.lines.map((l) => l.fn ?? input.functionName));
  // `function` names the listing only when it is one function (the measured single-function state)
  if (names.size === 1) state['function'] = input.functionName;
  const questions: Record<string, Question> = {};
  for (const l of input.lines) {
    questions[lineKey(l.line)] = noul(`Is line \`program.L${l.line}\` the line that must change to fix the bug in \`${l.fn ?? input.functionName}\`? Judge this line only; other lines are judged separately.`, LINE_NOUL_CRITERIA);
  }
  return { state, questions };
}

export const GAP_QUESTION_ID = 'insert_after';
/** Q6 wording, verbatim from experiments/probe-donor/probe.mts (4) `given_line`. */
export const GAP_QUESTION = 'Where in `program` must `missing_statement` be inserted so that all `tests` pass?';

export interface GapRequestInput {
  task: string;
  failures: readonly FailureView[];
  functionName: string;
  /** every physical code line of the function, the `def` line included (a gap after it is the first body line) */
  lines: readonly CodeLine[];
  missingStatement: string;
}

/** Option key of the gap after line `n`, and of the gap before the first listed line. */
export function gapAfterKey(line: number): string {
  return `after_l${line}`;
}
export function gapBeforeKey(line: number): string {
  return `before_l${line}`;
}

/** Q6: a Choice over the gaps of one function for a known statement (probe-donor §4 state and options). */
export function gapRequest(input: GapRequestInput): { state: Json; questions: Record<string, Question> } {
  const first = input.lines[0];
  if (first === undefined) throw new RangeError('gapRequest: no lines');
  const program: Record<string, Json> = {};
  for (const l of input.lines) program[`L${l.line}`] = clip(l.text, LINE_CHARS_MAX);
  const state: Record<string, Json> = {
    task: `The function \`${input.functionName}\` in \`program\` is missing one statement, which makes some cases in \`tests\` fail. \`missing_statement\` is the statement to insert (indentation will be adjusted to the chosen position).`,
    program,
    tests: input.failures.slice(0, TESTS_IN_STATE).map((f) => ({ call: clip(f.call, FAILURE_FIELD_CHARS_MAX), expected: clip(f.expected, FAILURE_FIELD_CHARS_MAX), actual: clip(f.actual, FAILURE_FIELD_CHARS_MAX) })),
    missing_statement: clip(input.missingStatement.trim(), LINE_CHARS_MAX),
  };
  const options: Record<string, Json | null> = { [gapBeforeKey(first.line)]: `insert as the new first line, before L${first.line}: ${clip(first.text.trim(), LINE_CHARS_MAX)}` };
  for (const l of input.lines) options[gapAfterKey(l.line)] = `insert directly after L${l.line}: ${clip(l.text.trim(), LINE_CHARS_MAX)}`;
  return { state, questions: { [GAP_QUESTION_ID]: choice(GAP_QUESTION, options) } };
}

// ---------------------------------------------------------------------------------------
// Capturing Q5's escape mass without changing the localizer's contract
// ---------------------------------------------------------------------------------------

/**
 * Wrap the `ask` handed to the localizer so the P(`none_of_these`) of its line Choice is
 * recorded; `LocalizeResult` does not carry it. The single-file path asks exactly one line
 * Choice; the repository path asks one per beam function concurrently, so the value kept is
 * the maximum over them (independent of which request resolved last, and the conservative
 * reading of "the fix is not a listed line"). `escape()` is null until a line Choice was answered.
 */
export function captureLineChoiceEscape(ask: JevAsk): { ask: JevAsk; escape: () => number | null } {
  let captured: number | null = null;
  const wrapped: JevAsk = async (stage, state, questions) => {
    const r = await ask(stage, state, questions);
    const a = r.answers[LINE_QUESTION_ID];
    if (a !== undefined && a.type === 'choice' && LINE_QUESTION_ID in questions) captured = Math.max(captured ?? 0, a.probabilities[ESCAPE_KEY] ?? 0);
    return r;
  };
  return { ask: wrapped, escape: () => captured };
}

// ---------------------------------------------------------------------------------------
// Site construction helpers
// ---------------------------------------------------------------------------------------

const entryCache = new WeakMap<SourceFile, FunctionEntry[]>();
function entriesOf(file: SourceFile): FunctionEntry[] {
  let e = entryCache.get(file);
  if (e === undefined) {
    e = functionEntries(file);
    entryCache.set(file, e);
  }
  return e;
}

function blockFor(file: SourceFile, line: number): Site['block'] {
  const e = entryAt(entriesOf(file), line);
  return e === undefined ? null : { name: e.qualname, startLine: e.startLine, endLine: e.endLine };
}

function isCodeLine(file: SourceFile, line: number): boolean {
  const text = file.mod.lines[line - 1];
  if (text === undefined) return false;
  const t = text.trim();
  return t !== '' && !t.startsWith('#');
}

/** A replace site at a code line, with the given evidence; null on a blank, comment or `def` line. */
export function replaceSiteAt(file: SourceFile, line: number, evidence: SiteEvidence): Site | null {
  if (!isCodeLine(file, line) || isDefLine(file, line)) return null;
  const text = file.mod.lines[line - 1] ?? '';
  return { file, line, kind: 'replace', currentLine: text, indent: indentOf(text), block: blockFor(file, line), scope: scopeAt(file.mod, line), evidence };
}

/** The gap after the statement that starts (or continues) at `line`: `Site.line` is the line the new statement goes before. */
export function insertAfterSite(file: SourceFile, line: number, evidence: SiteEvidence): Site {
  const st = statementAt(file.mod, line);
  const after = (st?.endLine ?? line) + 1;
  return { file, line: after, kind: 'insert', currentLine: '', indent: indentAfter(file, line), block: blockFor(file, line), scope: scopeAt(file.mod, line), evidence };
}

/**
 * The gap before `line` (names bound on `line` are not visible there). The block is the one
 * enclosing the position, i.e. the line above: a gap before a `def` line lies outside that def.
 */
export function insertBeforeSite(file: SourceFile, line: number, evidence: SiteEvidence): Site {
  const text = file.mod.lines[line - 1] ?? '';
  const above = line - 1;
  return { file, line, kind: 'insert', currentLine: '', indent: indentOf(text), block: above >= 1 ? blockFor(file, above) : null, scope: scopeAt(file.mod, Math.max(1, above)), evidence };
}

/** Prefix of the evidence note that marks a module-level import gap (`isImportGap`). */
export const IMPORT_GAP_NOTE = 'module-level import gap';

/**
 * The module-level gap a missing import goes into: before `importInsertLine` (after the last
 * top-level import, else after the module docstring, else line 1), at module indentation, in no
 * block. Null unless the file uses one of `names` without binding it anywhere (a name the file
 * already imports or defines is not missing here; a `ModuleNotFoundError` names an installed
 * package, not a line of this file). The names actually missing are recorded in the evidence.
 */
export function importGapSite(file: SourceFile, names: readonly string[]): Site | null {
  const unbound = new Set(unboundNames(file.mod));
  const missing = names.filter((n) => unbound.has(n));
  if (missing.length === 0) return null;
  const line = importInsertLine(file.mod);
  return { file, line, kind: 'insert', currentLine: '', indent: '', block: null, scope: scopeAt(file.mod, line), evidence: { notes: [`${IMPORT_GAP_NOTE} for ${missing.join(', ')}`] } };
}

/** True for a site `importGapSite` built: a module-level insert gap carrying the import-gap note. */
export function isImportGap(site: Pick<Site, 'kind' | 'block' | 'evidence'>): boolean {
  return site.kind === 'insert' && site.block === null && site.evidence.notes.some((n) => n.startsWith(IMPORT_GAP_NOTE));
}

/** Code lines of one function span, `def` header (and decorators) excluded. */
function functionCodeLines(file: SourceFile, startLine: number, endLine: number): CodeLine[] {
  return codeLines(file.mod, startLine, endLine).filter((c) => !isDefLine(file, c.line));
}

function byDesc<T>(items: readonly T[], score: (t: T) => number): T[] {
  return items.map((t, i) => ({ t, i })).sort((a, b) => score(b.t) - score(a.t) || a.i - b.i).map((x) => x.t);
}

function noulP(a: Answer | undefined): number {
  return a !== undefined && a.type === 'noul' ? a.noul : 0;
}

// ---------------------------------------------------------------------------------------
// The site list
// ---------------------------------------------------------------------------------------

interface ScoredReplace {
  site: Site;
  /** Jev evidence: max of the Q5 line probability and the Q5n Noul; 0 for SBFL-only lines */
  jev: number;
  sbflRank: number;
}

interface BeamFunction {
  file: SourceFile;
  name: string;
  startLine: number;
  endLine: number;
}

/** Beam functions in rank order, from the localizer's function beam, else from the anchors' blocks. */
function beamFunctions(localized: LocalizeResult, anchors: readonly Site[]): BeamFunction[] {
  const out: BeamFunction[] = [];
  const seen = new Set<string>();
  const push = (f: BeamFunction): void => {
    const k = `${f.file.path}:${f.startLine}:${f.endLine}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(f);
  };
  for (const f of localized.functions as readonly FunctionCandidate[]) push({ file: f.file, name: f.name, startLine: f.startLine, endLine: f.endLine });
  for (const a of anchors) if (a.block !== null) push({ file: a.file, name: a.block.name, startLine: a.block.startLine, endLine: a.block.endLine });
  return out;
}

/**
 * Q5 top-3 per beam function with p ≥ 0.05, reconstructed from the localizer's sites: every
 * replace site carrying a `jevProbability` was an option of that function's line Choice, and
 * the localizer's anchors are exactly the top-3 of each Choice.
 */
export function q5Anchors(localized: LocalizeResult, perFunction = ANCHORS_PER_FUNCTION, minP = Q5_ANCHOR_MIN_P): Site[] {
  const groups = new Map<string, Site[]>();
  for (const s of localized.sites) {
    if (s.kind !== 'replace' || s.evidence.jevProbability === undefined || s.evidence.jevProbability < minP) continue;
    if (isDefLine(s.file, s.line) || !isCodeLine(s.file, s.line)) continue;
    const k = `${s.file.path}:${s.block?.startLine ?? 'module'}`;
    const g = groups.get(k) ?? [];
    g.push(s);
    groups.set(k, g);
  }
  const out: Site[] = [];
  for (const g of groups.values()) out.push(...byDesc(g, (s) => s.evidence.jevProbability ?? 0).slice(0, perFunction));
  return byDesc(out, (s) => s.evidence.jevProbability ?? 0);
}

/**
 * Q5n over the beam functions' code lines (≤ 254, the top function first; a longer top function
 * is windowed around `focus`, the top Q5 anchor); returns `path:line` -> p.
 */
async function askLineNouls(ctx: GoalSiteContext, goal: Goal, fns: readonly BeamFunction[], stage: StageName, focus: number | null): Promise<{ probs: Map<string, number>; requests: number }> {
  const probs = new Map<string, number>();
  const first = fns[0];
  if (first === undefined) return { probs, requests: 0 };
  // The lines judged: the top function whole, then further beam functions of the same file while
  // they fit (the single-file Q5 listed the whole program; each line names its own function).
  const lines: NoulLine[] = [];
  for (const f of fns) {
    if (f.file.path !== first.file.path) continue;
    const more = functionCodeLines(f.file, f.startLine, f.endLine)
      .filter((c) => !lines.some((l) => l.line === c.line))
      .map((c): NoulLine => ({ ...c, fn: f.name }));
    if (lines.length + more.length > Q5N_MAX_LINES) {
      if (lines.length === 0) lines.push(...centredWindow(more, Q5N_MAX_LINES, focus));
      break;
    }
    lines.push(...more);
  }
  if (lines.length === 0) return { probs, requests: 0 };
  const req = lineNoulRequest({ task: ctx.task, failures: goal.failures, functionName: first.name, lines });
  if (ctx.signal.aborted) throw new AbortError('signal');
  assertQuestionBatch(req.questions);
  const r = await ctx.ask(stage, req.state, req.questions);
  for (const l of lines) probs.set(sbflKey(first.file.path, l.line), noulP(r.answers[lineKey(l.line)]));
  return { probs, requests: 1 };
}

/** Q6 for one statement over one function's gaps; returns the gap keys ranked by p (escape excluded). */
async function askGaps(ctx: GoalSiteContext, goal: Goal, fn: BeamFunction, lines: readonly CodeLine[], statement: string, stage: StageName): Promise<{ key: string; p: number }[]> {
  const req = gapRequest({ task: ctx.task, failures: goal.failures, functionName: fn.name, lines, missingStatement: statement });
  if (ctx.signal.aborted) throw new AbortError('signal');
  const r = await ctx.ask(stage, req.state, req.questions);
  const a = r.answers[GAP_QUESTION_ID];
  if (a === undefined || a.type !== 'choice') return [];
  return byDesc(
    Object.entries(a.probabilities)
      .filter(([k, p]) => k !== ESCAPE_KEY && p > 0)
      .map(([key, p]) => ({ key, p })),
    (x) => x.p,
  );
}

/**
 * The gap after the last line of `fn` the goal's failing tests executed, when the spectrum shows
 * lines of `fn` those tests never reached (a missing statement before a branch the fix must
 * take, `shunting_yard`). Null without per-test coverage or when the failing tests ran every line.
 */
export function traceTailGap(fn: BeamFunction, goal: Goal, perTest: readonly PerTestResult[]): Site | null {
  const goalTests = new Set(goal.tests);
  const executed = new Set<number>();
  let witness: string | null = null;
  for (const t of perTest) {
    if (!isFailing(t.outcome) || (goalTests.size > 0 && !goalTests.has(t.id))) continue;
    for (const l of t.lines[fn.file.path] ?? []) {
      if (l < fn.startLine || l > fn.endLine || isDefLine(fn.file, l)) continue;
      executed.add(l);
      witness ??= t.id;
    }
  }
  if (executed.size === 0 || witness === null) return null;
  const code = functionCodeLines(fn.file, fn.startLine, fn.endLine);
  const unreached = code.filter((c) => !executed.has(c.line) && statementAt(fn.file.mod, c.line)?.startLine === c.line);
  if (unreached.length === 0) return null;
  const last = Math.max(...executed);
  return insertAfterSite(fn.file, last, { notes: [`after last executed line L${last} of failing test ${witness}`, `${unreached.length} statements of ${fn.name} never reached`] });
}

/**
 * Visiting order: module-level import gaps first (the failure text named the missing name; the
 * gap holds a handful of candidates), then insert sites right after the replace site of their
 * anchor (design §2.5 item 2), remaining inserts (Q6, trace tail, anchors cut from the replace
 * list) last; or every insert site first when `insertFirst`. Call again after Q7 when
 * `insert_new_line` ≥ 0.5 changes the answer.
 */
export function orderGoalSites(g: Pick<GoalSites, 'replace' | 'insert' | 'insertAnchors'>, insertFirst: boolean): Site[] {
  const importGaps = g.insert.filter(isImportGap);
  const inserts = g.insert.filter((s) => !isImportGap(s));
  if (insertFirst) return [...importGaps, ...inserts, ...g.replace];
  const out: Site[] = [...importGaps];
  const placed = new Set<string>();
  for (const r of g.replace) {
    out.push(r);
    const rk = siteKey(r);
    for (const i of inserts) {
      const ik = siteKey(i);
      if (placed.has(ik) || g.insertAnchors.get(ik) !== rk) continue;
      placed.add(ik);
      out.push(i);
    }
  }
  for (const i of inserts) if (!placed.has(siteKey(i))) out.push(i);
  return out;
}

/** Design §2.5 item 2: insert sites first when Q5's escape mass or Q7's `insert_new_line` says the fix is a new line. */
export function insertSitesFirst(q5Escape: number | undefined, insertNewLine: number | undefined): boolean {
  return (q5Escape ?? 0) >= Q5_ESCAPE_INSERT_FIRST || (insertNewLine ?? 0) >= Q7_INSERT_NEW_LINE_FIRST;
}

/**
 * Build the ranked site list of one sub-goal from the localizer's result, the spectrum and (on
 * single-file workspaces) one Q5n request; plus ≤ Q6_MAX_STATEMENTS Q6 requests when the caller
 * knows template statements. Pure apart from those requests; deterministic given the answers.
 */
export async function buildGoalSites(ctx: GoalSiteContext, goal: Goal, localized: LocalizeResult, sbfl?: SbflEvidence, options: GoalSiteOptions = {}): Promise<GoalSites> {
  if (ctx.signal.aborted) throw new AbortError('signal');
  const stage = options.stage ?? 'propose';
  const maxReplace = options.maxReplaceSites ?? REPLACE_SITES_MAX;
  const maxInsert = options.maxInsertSites ?? INSERT_SITES_MAX;
  const singleFile = ctx.files.size <= 1;
  const notes: string[] = [];
  let requests = 0;

  const sbflMap = new Map<string, RankedLine>();
  for (const r of sbfl?.ranked ?? []) if (ctx.files.has(r.file)) sbflMap.set(sbflKey(r.file, r.line), r);

  // 1. Q5 anchors (top-3 per beam function, p ≥ 0.05) and the beam functions they live in.
  const anchors = q5Anchors(localized);
  const fns = beamFunctions(localized, anchors);
  const replace = new Map<string, ScoredReplace>();
  const addReplace = (site: Site, jev: number): void => {
    const k = siteKey(site);
    const cur = replace.get(k);
    const rank = sbflMap.get(sbflKey(site.file.path, site.line))?.rank ?? Number.POSITIVE_INFINITY;
    if (cur === undefined) replace.set(k, { site, jev, sbflRank: rank });
    else {
      cur.jev = Math.max(cur.jev, jev);
      for (const n of site.evidence.notes) if (!cur.site.evidence.notes.includes(n)) cur.site.evidence.notes.push(n);
    }
  };
  for (const a of anchors) addReplace({ ...a, evidence: { ...a.evidence, notes: [...a.evidence.notes] } }, a.evidence.jevProbability ?? 0);

  // 2. Q5n Nouls (single file): top-3 by p, unioned; exactly one ≥ 0.9 short-circuits.
  const lineNouls = new Map<string, number>();
  let shortCircuit: Site | null = null;
  if (options.askLineNouls ?? singleFile) {
    const r = await askLineNouls(ctx, goal, fns, stage, anchors[0]?.line ?? null);
    requests += r.requests;
    for (const [k, p] of r.probs) lineNouls.set(k, p);
    const ranked = byDesc([...r.probs.entries()].filter(([, p]) => p > 0), ([, p]) => p);
    const fileOf = fns[0]?.file;
    if (fileOf !== undefined) {
      for (const [k, p] of ranked.slice(0, Q5N_TOP)) {
        const line = Number(k.slice(k.lastIndexOf(':') + 1));
        const q5 = anchors.find((a) => a.line === line)?.evidence.jevProbability;
        const evidence: SiteEvidence = { notes: [`q5n noul ${p.toFixed(2)}`] };
        if (q5 !== undefined) evidence.jevProbability = q5;
        const site = replaceSiteAt(fileOf, line, evidence);
        if (site !== null) addReplace(site, p);
      }
      const confident = ranked.filter(([, p]) => p >= Q5N_SHORT_CIRCUIT_P);
      if (confident.length === 1) {
        const line = Number(confident[0]![0].slice(confident[0]![0].lastIndexOf(':') + 1));
        shortCircuit = replace.get(siteKey({ file: fileOf, line, kind: 'replace' }))?.site ?? null;
        if (shortCircuit !== null) notes.push(`q5n short-circuit on L${line}`);
      }
    }
  }

  // 3. SBFL top-k unioned (5 single file / 3 repo), by Ochiai rank. Rows that can never be a
  //    site (`def` lines, blanks, comments) are dropped before the cut; rows a Jev line already
  //    covers count towards k, as in localize/sites.ts `sbflOnlySites`.
  // (a code-line / `def` test per row, not a Site per row: a repository spectrum has thousands of rows)
  const editable = [...sbflMap.values()].filter((r) => {
    const file = ctx.files.get(r.file);
    return file !== undefined && isCodeLine(file, r.line) && !isDefLine(file, r.line);
  });
  for (const r of byDesc(editable, (r) => -r.rank).slice(0, sbflAnchorsFor(ctx.files.size))) {
    const site = replaceSiteAt(ctx.files.get(r.file)!, r.line, { sbflRank: r.rank, sbflScore: r.score, notes: [`sbfl rank ${r.rank}`] });
    if (site !== null) addReplace(site, 0);
  }

  // 4. Order: the short-circuit line, then Jev evidence by p, then SBFL-only by rank; cut at 6.
  const scored = [...replace.values()];
  const ordered = [
    ...(shortCircuit === null ? [] : [shortCircuit]),
    ...byDesc(
      scored.filter((s) => s.jev > 0 && s.site !== shortCircuit),
      (s) => s.jev,
    ).map((s) => s.site),
    ...scored
      .filter((s) => s.jev <= 0 && s.site !== shortCircuit)
      .sort((a, b) => a.sbflRank - b.sbflRank)
      .map((s) => s.site),
  ];
  const replaceSites = ordered.slice(0, maxReplace);

  // 5. Insert sites: the import gap of every file that uses a reported-missing name unbound
  //    (pushed first so the cut keeps it), then gaps after and before the top-3 anchors, then
  //    Q6 gaps, then the trace tail.
  const insertAnchors = new Map<string, string>();
  const inserts: Site[] = [];
  const insertKeys = new Set<string>();
  const pushInsert = (s: Site, anchor: Site | null): void => {
    const k = siteKey(s);
    if (insertKeys.has(k)) return;
    insertKeys.add(k);
    inserts.push(s);
    if (anchor !== null) insertAnchors.set(k, siteKey(anchor));
  };
  const missingNames = goal.missingNames ?? [];
  if (missingNames.length > 0) {
    // suspected files first (the traceback's own), then the files of the beam functions
    const paths = [...new Set([...goal.suspectedFiles, ...fns.map((f) => f.file.path)])];
    for (const p of paths) {
      const file = ctx.files.get(p);
      if (file === undefined) continue;
      const gap = importGapSite(file, missingNames);
      if (gap !== null) {
        pushInsert(gap, null);
        notes.push(`import gap ${p}:${gap.line} for ${missingNames.join(', ')}`);
      }
    }
  }
  for (const a of anchors.slice(0, ANCHORS_PER_FUNCTION)) {
    const entry = entryAt(entriesOf(a.file), a.line) ?? null;
    const anchor: Anchor = { file: a.file, line: a.line, entry, lineProbabilities: new Map(), notes: [] };
    if (a.evidence.jevProbability !== undefined) anchor.jevProbability = a.evidence.jevProbability;
    const built = buildSites({ anchors: [anchor], sbfl: sbflMap, frames: [], window: 0 });
    const after = built.find((s) => s.kind === 'insert' && s.line !== a.line);
    const before = built.find((s) => s.kind === 'insert' && s.line === a.line);
    if (after !== undefined) pushInsert(after, a);
    if (before !== undefined) pushInsert(before, a);
  }
  const statements = (options.missingStatements ?? []).map((s) => s.trim()).filter((s) => s !== '').slice(0, Q6_MAX_STATEMENTS);
  const top = fns[0];
  if (statements.length > 0 && top !== undefined) {
    const lines = codeLines(top.file.mod, top.startLine, top.endLine);
    if (lines.length + 1 > Q6_MIN_GAPS) {
      for (const stmt of statements) {
        const ranked = await askGaps(ctx, goal, top, lines, stmt, stage);
        requests += 1;
        for (const { key, p } of ranked.slice(0, Q6_TOP_GAPS)) {
          const after = /^after_l(\d+)$/.exec(key);
          const before = /^before_l(\d+)$/.exec(key);
          const ev: SiteEvidence = { jevProbability: p, notes: [`q6 ${key} p=${p.toFixed(2)} for \`${stmt}\``] };
          if (after !== null) pushInsert(insertAfterSite(top.file, Number(after[1]), ev), null);
          else if (before !== null) pushInsert(insertBeforeSite(top.file, Number(before[1]), ev), null);
        }
      }
    } else notes.push(`q6 skipped: ${lines.length + 1} gaps ≤ ${Q6_MIN_GAPS}`);
  }
  if (sbfl?.perTest !== undefined && top !== undefined) {
    const tail = traceTailGap(top, goal, sbfl.perTest);
    if (tail !== null) pushInsert(tail, null);
  }
  const insertSites = inserts.slice(0, maxInsert);

  const insertFirst = insertSitesFirst(options.q5EscapeProbability, options.insertNewLineProbability);
  const g: GoalSites = { replace: replaceSites, insert: insertSites, ordered: [], insertFirst, shortCircuit, insertAnchors, lineNouls, requests, notes };
  g.ordered = orderGoalSites(g, insertFirst);
  return g;
}

// ---------------------------------------------------------------------------------------
// WIDENED: every code line of the beam functions, cursor-carried across steps
// ---------------------------------------------------------------------------------------

export interface WidenChunk {
  sites: Site[];
  /** cursor to store in `mem.widenCursor[goal.id]` for the next step */
  cursor: number;
  /** true when no line is left after this chunk */
  done: boolean;
}

/**
 * Every code line of the beam functions as replace sites (`def` lines, decorators, docstrings,
 * blanks and comments excluded), functions in beam order and lines ascending, deduplicated.
 * `exclude` drops lines already searched (the SEEDS sites) so WIDENED spends on new lines only.
 */
export function widenedSites(functions: readonly Pick<FunctionCandidate, 'file' | 'name' | 'startLine' | 'endLine'>[], exclude: ReadonlySet<string> = new Set()): Site[] {
  const out: Site[] = [];
  const seen = new Set<string>(exclude);
  functions.forEach((f, rank) => {
    for (const c of functionCodeLines(f.file, f.startLine, f.endLine)) {
      const site = replaceSiteAt(f.file, c.line, { notes: [`widened over ${f.name} (beam #${rank + 1})`] });
      if (site === null) continue;
      const k = siteKey(site);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(site);
    }
  });
  return out;
}

/** The next `size` widened sites from `cursor` (0-based into `all`); `size` ≤ 0 takes everything left. */
export function nextWidenChunk(all: readonly Site[], cursor: number, size: number): WidenChunk {
  const start = Math.max(0, Math.min(Math.floor(cursor), all.length));
  const end = size > 0 ? Math.min(all.length, start + Math.floor(size)) : all.length;
  return { sites: all.slice(start, end), cursor: end, done: end >= all.length };
}
