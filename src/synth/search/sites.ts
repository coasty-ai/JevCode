/**
 * Site list for one sub-goal (docs/JEV-ONLY-DESIGN.md §2.5), built over `src/synth/localize`:
 *
 *   replace sites = Q5 top-3 lines per beam function (p ≥ 0.05)
 *                 ∪ Q5n Noul top-3 (single-file workspaces, one request asked here)
 *                 ∪ SBFL top-5 (single file) / top-3 (repository)
 *     unioned, never score-combined with SBFL; `def` lines never; ordered Jev evidence by p
 *     first — on repositories p × the beam function's probability, since each function had its
 *     own line Choice (`functionWeight`) — then SBFL-only lines by Ochiai rank (Ochiai is top-1
 *     on 7/38 but top-5 on 34/38, experiments/results/lit-search-based-repair.md §6; the union of
 *     two top-3 lists covered 38/40, probe-localization.md §8.2).
 *   insert sites  = the gap after AND before each of the top-3 Jev anchors (both neighbours of
 *     the four QuixBugs insertion points sit at D ranks 2–5, probe-localization.md §3.4), plus
 *     the gap the innermost loop around the anchor exits into (`loopExitGap`: `wrap`'s and
 *     `shunting_yard`'s golds sit there, one level out of the block Jev's line is in)
 *                 + Q6 `insert_after` top-3 gaps when a template statement is known (4/4 given
 *     the statement, 2/4 without: a site list, never a pick, probe-donor-and-templates.md §4)
 *                 + the gap after the last executed line of the failing test when the spectrum
 *     shows a line of the function the failing test never reaches (`shunting_yard`).
 *                 + the module-level import gap (after the last top-level import, else after the
 *     docstring, else line 1) of every suspected file that uses a name the failure text says is
 *     missing (`goal.missingNames`, a NameError / ImportError read by goals.ts): the traceback
 *     points inside the function that used the name, the fix goes at the top of the module
 *     (ladder `tagcloud`). Visited first: it holds a handful of import candidates at most.
 *                 + every remaining statement boundary of the top beam function when it is
 *     ≤ 40 lines (`functionGapSlots`: one legal (line, indent) slot per physical line, the
 *     enclosing block's level first where a block ends), ordered by the Jev probability of the
 *     neighbouring lines and by control-flow position (after a header, block end, mid-block).
 *     The measured misses were gaps that existed at the wrong indent (`shunting_yard`'s gap after
 *     L17 was built inside the `while` body; the fix sits one level out) or not at all
 *     (`reverse_linked_list`'s loop-body gap, not adjacent to any anchor).
 *   cut at 6 + 6; insert sites are visited after the replace site of the same anchor, or first
 *   when Q5 put ≥ 0.3 on `none_of_these` or Q7 puts ≥ 0.5 on `insert_new_line`.
 *
 * Q6 fallback (design §9 R1 "otherwise"): when the goal's sites are rebuilt after its search
 * reached WIDENED without a plausible candidate (`goal.phase === 'WIDENED'`), the top-5 statement
 * templates of the function (by prior, over its gaps) each get one Q6 `insert_after` Choice —
 * measured top-1 4/4 given the statement (probe-donor-and-templates.md §4) — and the chosen gaps
 * go first, insert sites first.
 *
 * WIDENED (§2.3 phase W): every code line of the beam functions as replace sites, `def` lines
 * excluded, plus every gap slot of the functions of ≤ 40 lines, interleaved in line order (the
 * gap before a line precedes the line), handed out in chunks with a cursor the caller carries
 * across steps in `mem.widenCursor` (median 23.8 s, max 119 s per QuixBugs program at 12-way,
 * contrarian-exhaustive.all.jsonl, so one step rarely runs it all). `orderWidenedSites` puts the
 * list in the order the run-cost budget should spend it: by the Jev line evidence the SEEDS
 * localisation gathered (Q5 p, Q5n Noul; a gap scores the better of its two neighbouring lines),
 * then by distance from the top-1 line, cut at WIDENED_SITES_MAX. Four `wrap` runs never reached
 * the gap before `return lines` (indent 4): Q5 put the function's mass on L7 and the gap's Noul
 * (0.16–0.21) tied with L6, so the 6-cut of the SEEDS insert list left it out and the line-ordered
 * WIDENED list had it last (jev-only-rungs-1-2.md §13.4). The evidence travels beside the SEEDS
 * list `buildGoalSites` returns (`lineEvidenceOf`), so the loop needs no new field on
 * `LocalizeResult`.
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
import { classMethodPrefixes } from '../introspect/prefixes.js';
import { HISTORY_SITE_NOTE, distanceToSite, locateReversals, sameSpan } from '../history/source.js';
import type { HistoryFacts } from '../history/types.js';
import type { IntrospectedNames } from '../introspect/types.js';
import { buildSites, functionGapSlots, indentAfter, indentBefore, isDefLine, sbflAnchorsFor, sbflKey, statementSiteAt } from '../localize/sites.js';
import type { Anchor, GapSlot } from '../localize/sites.js';
import type { FunctionEntry } from '../localize/types.js';
import { indentOf } from '../py/edits.js';
import { blockAt, scopeAt, statementAt } from '../py/structure.js';
import type { Block, Statement } from '../py/structure.js';
import type { PerTestResult, RankedLine } from '../sbfl/types.js';
import { isFailing } from '../sbfl/ochiai.js';
import { importInsertLine, unboundNames } from '../templates/imports.js';
import { enumerateTemplates } from '../templates/index.js';
import { CLASS_BODY_GAP_NOTE } from '../templates/introspect.js';
import type { EnumerateOptions, FailureView, FunctionCandidate, JevAsk, LocalizeResult, Site, SiteEvidence, SourceFile } from '../types.js';
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
/** Every statement boundary of a function becomes a gap site while the function is this long or shorter (QuixBugs programs are ≤ 30 lines; a 40-line function has ≤ ~40 slots of ≤ ~80 statements each). */
export const GAP_FUNCTION_MAX_LINES = 40;
/** Q6 fallback: statement templates asked about (one request each) once a search reached WIDENED with nothing plausible. */
export const Q6_FALLBACK_STATEMENTS = 5;
/** Q6 fallback: a gap other than the top-1 is kept when Jev put at least this much on it (the two defensible neighbours of `reverse_linked_list` sat at 0.43 / ~0.3). */
export const Q6_FALLBACK_MIN_P = 0.2;
/** Q6 fallback needs a function with at least this many gap slots to be worth a Choice. */
export const Q6_FALLBACK_MIN_GAPS = 3;
/** Q6 fallback is asked over functions of at most this many code lines (options = one per line + the escape). */
export const Q6_FALLBACK_MAX_LINES = 60;
/**
 * WIDENED sites per goal after the SEEDS sites are excluded: a 40-line function has ≈ 40 lines and
 * ≈ 40 gap slots, each worth ≈ 150 SIEVE candidates at QuixBugs scale (≈ 1,500 runs = one step's
 * run cap per 10 sites), so 24 is between two and three steps of WIDENED; `wrap` has 6 left after
 * its 10 SEEDS sites. The evidence order puts the lines Jev rated first, so the cut costs the
 * sites nothing pointed at.
 */
export const WIDENED_SITES_MAX = 24;

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
  /**
   * llm-jev (docs/LLM-JEV-DESIGN.md §9.2 stage 4): the Q6 fallback asks about every statement template in ONE request over one
   * state (`missing_statements.stmt_<k>`, one Choice each) instead of one request per statement. Off by default: the measured
   * probe-donor state carries a single `missing_statement`.
   */
  batchQ6Fallback?: boolean;
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
  /** the Q6 fallback's placements when it ran: statement → gap keys Jev chose (see `q6FallbackApplies`) */
  q6Fallback: ReadonlyMap<string, string[]>;
  requests: number;
  notes: string[];
}

/**
 * The Q6 fallback runs when the goal's sites are rebuilt after a search that reached WIDENED and
 * found nothing plausible: `goal.phase` is the last phase visited, and a goal whose search
 * committed is fixed (or held) rather than re-localised. A `change_approach` directive rebuilds
 * the sites (`mem.localizeCache.delete`), which is when this is read.
 */
export function q6FallbackApplies(goal: Pick<Goal, 'phase' | 'status'>): boolean {
  return goal.phase === 'WIDENED' && goal.status !== 'fixed';
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

/**
 * The Q6 fallback batched (llm-jev): one state with `missing_statements: {stmt_1, …}` and one Choice per statement over the
 * same gap options; question ids are `${GAP_QUESTION_ID}_<k>`, returned beside the statement they ask about.
 */
export function gapBatchRequest(input: Omit<GapRequestInput, 'missingStatement'> & { missingStatements: readonly string[] }): { state: Json; questions: Record<string, Question>; ids: { id: string; statement: string }[] } {
  const first = input.lines[0];
  if (first === undefined) throw new RangeError('gapBatchRequest: no lines');
  const program: Record<string, Json> = {};
  for (const l of input.lines) program[`L${l.line}`] = clip(l.text, LINE_CHARS_MAX);
  const statements: Record<string, Json> = {};
  const ids: { id: string; statement: string }[] = [];
  const questions: Record<string, Question> = {};
  const options: Record<string, Json | null> = { [gapBeforeKey(first.line)]: `insert as the new first line, before L${first.line}: ${clip(first.text.trim(), LINE_CHARS_MAX)}` };
  for (const l of input.lines) options[gapAfterKey(l.line)] = `insert directly after L${l.line}: ${clip(l.text.trim(), LINE_CHARS_MAX)}`;
  input.missingStatements.forEach((statement, i) => {
    const key = `stmt_${i + 1}`;
    statements[key] = clip(statement.trim(), LINE_CHARS_MAX);
    const id = `${GAP_QUESTION_ID}_${i + 1}`;
    ids.push({ id, statement });
    questions[id] = choice(`Where in \`program\` must \`missing_statements.${key}\` be inserted so that all \`tests\` pass?`, options);
  });
  const state: Record<string, Json> = {
    task: `The function \`${input.functionName}\` in \`program\` is missing one statement, which makes some cases in \`tests\` fail. Each entry of \`missing_statements\` is a candidate for that statement (indentation will be adjusted to the chosen position).`,
    program,
    tests: input.failures.slice(0, TESTS_IN_STATE).map((f) => ({ call: clip(f.call, FAILURE_FIELD_CHARS_MAX), expected: clip(f.expected, FAILURE_FIELD_CHARS_MAX), actual: clip(f.actual, FAILURE_FIELD_CHARS_MAX) })),
    missing_statements: statements,
  };
  assertQuestionBatch(questions);
  return { state, questions, ids };
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

/**
 * A replace site at a code line, with the given evidence; null on a blank, comment or `def` line.
 * At the FIRST line of a multi-line statement the statement-level site (localize/sites.ts
 * `statementSiteAt`: the statement joined onto one line, `Site.endLine` the span) stands in place of
 * the physical-line site, as `buildSites` builds it for the Jev anchors — the sources then see
 * `return hash((a, b))` whole instead of `return hash((` (swebench-reach-oracle-9.md capability 4);
 * at a later line of the statement the physical site is returned (`statementSiteFor` adds the span).
 */
export function replaceSiteAt(file: SourceFile, line: number, evidence: SiteEvidence): Site | null {
  if (!isCodeLine(file, line) || isDefLine(file, line)) return null;
  const st = statementAt(file.mod, line);
  if (st !== undefined && st.startLine === line && st.endLine > st.startLine) {
    const span = statementSiteAt(file, line, evidence, blockFor(file, line));
    if (span !== null) return span;
  }
  const text = file.mod.lines[line - 1] ?? '';
  return { file, line, kind: 'replace', currentLine: text, indent: indentOf(text), block: blockFor(file, line), scope: scopeAt(file.mod, line), evidence };
}

/**
 * The statement-level site of the multi-line statement a CONTINUATION line belongs to (null at a
 * statement's first line, where `replaceSiteAt` already returns it, and for one-line statements):
 * the Q5n / SBFL rows of `buildGoalSites` add it once beside the physical-line site, as
 * localize/sites.ts `buildSites` does for the anchors.
 */
export function statementSiteFor(file: SourceFile, line: number, evidence: SiteEvidence): Site | null {
  const st = statementAt(file.mod, line);
  if (st === undefined || st.startLine === line || st.endLine === st.startLine) return null;
  return statementSiteAt(file, line, evidence, blockFor(file, st.startLine));
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
  const above = line - 1;
  return { file, line, kind: 'insert', currentLine: '', indent: indentBefore(file, line), block: above >= 1 ? blockFor(file, above) : null, scope: scopeAt(file.mod, Math.max(1, above)), evidence };
}

/** An insert site at a gap slot of `functionGapSlots`: scope as of the statement it follows (names bound there are visible). */
export function gapSlotSite(file: SourceFile, slot: GapSlot, evidence: SiteEvidence): Site {
  return { file, line: slot.line, kind: 'insert', currentLine: '', indent: slot.indent, block: blockFor(file, slot.afterLine), scope: scopeAt(file.mod, slot.afterLine), evidence };
}

/** Control-flow tier of a gap, best first: the first line of a block, a block end, then mid-block. */
const POSITION_TIER: Readonly<Record<GapSlot['position'], number>> = { after_header: 0, block_end: 1, mid_block: 2 };

/**
 * Gap slots ranked for the SEEDS cut: by the Jev probability of the lines around the gap (the
 * statement it follows and the next one, from Q5 / Q5n: `lineP`), then by control-flow position
 * (after a header, block end, mid-block), then by line. Deterministic.
 */
export function orderGapSlots(slots: readonly GapSlot[], lineP: (line: number) => number): GapSlot[] {
  const score = (g: GapSlot): number => Math.max(lineP(g.afterLine), g.nextLine === null ? 0 : lineP(g.nextLine));
  return [...slots].sort((a, b) => score(b) - score(a) || POSITION_TIER[a.position] - POSITION_TIER[b.position] || a.line - b.line || a.indent.length - b.indent.length);
}

/** Note text of a gap-slot site (`gap after L17 (block_end, dedent 1)`). */
function gapNote(slot: GapSlot): string {
  return `gap after L${slot.afterLine} (${slot.position}${slot.dedent > 0 ? `, dedent ${slot.dedent}` : ''})`;
}

/**
 * Every gap slot of a function of ≤ GAP_FUNCTION_MAX_LINES lines as insert sites, in line order
 * (`orderGapSlots` ranks them for the cut); [] for a longer function, whose anchors' gaps stand alone.
 */
export function functionGapSites(fn: Pick<FunctionCandidate, 'file' | 'name' | 'startLine' | 'endLine'>, maxLines: number = GAP_FUNCTION_MAX_LINES): Site[] {
  if (fn.endLine - fn.startLine + 1 > maxLines) return [];
  return functionGapSlots(fn.file, fn.startLine, fn.endLine).map((slot) => gapSlotSite(fn.file, slot, { notes: [gapNote(slot), `in ${fn.name}`] }));
}

/** Prefix of the evidence note that marks a loop-exit gap (`loopExitGap`). */
export const LOOP_EXIT_GAP_NOTE = 'exit gap of the loop enclosing';

/**
 * The gap the innermost `for` / `while` enclosing `line` (or headed at `line`) exits into: the
 * block-end slot of `functionGapSlots` at the loop's own indent between the end of its body and
 * the statement that follows it (the function's end when none). Two of the four QuixBugs
 * insertion golds sit exactly there — `wrap`'s `lines.append(text)` after the `while` whose body
 * holds Jev's top line (L7, p 0.61–0.67 in every live run), `shunting_yard`'s
 * `opstack.append(token)` after the inner `while` — and neither gap is a neighbour of the anchor
 * line in the ±1 sense §2.5 item 2 builds, so the 6-cut of the insert list never held it
 * (jev-only-rungs-1-2.md §13.4). Null when `line` lies in no loop of the function or the body's
 * end has no legal slot at that indent (a `while … else:`).
 */
export function loopExitGap(file: SourceFile, line: number, fn: Pick<FunctionCandidate, 'startLine' | 'endLine'>): GapSlot | null {
  const mod = file.mod;
  const at = statementAt(mod, line);
  if (at === undefined || at.startLine < fn.startLine || at.startLine > fn.endLine) return null;
  let loop: Statement | null = at.kind === 'for' || at.kind === 'while' ? at : null;
  let cur = at.indent;
  for (let k = at.index - 1; k >= 0 && loop === null; k--) {
    const s = mod.statements[k];
    if (s === undefined || s.startLine < fn.startLine) break;
    if (s.kind === 'decorator' || s.indent >= cur) continue;
    if (s.kind === 'for' || s.kind === 'while') loop = s;
    else if (s.kind === 'def' || s.kind === 'class') break;
    cur = s.indent;
  }
  if (loop === null) return null;
  const next = mod.statements.find((s) => s.startLine > loop.endLine && s.startLine <= fn.endLine && s.indent <= loop.indent && s.kind !== 'decorator');
  const exitLine = next?.startLine ?? fn.endLine + 1;
  const loopIndent = indentOf(mod.lines[loop.startLine - 1] ?? '');
  const slots = functionGapSlots(file, fn.startLine, fn.endLine).filter((g) => g.indent === loopIndent && g.line > loop.endLine && g.line <= exitLine && g.afterLine > loop.startLine);
  return slots.at(-1) ?? null;
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
export function q5Anchors(localized: LocalizeResult, perFunction = ANCHORS_PER_FUNCTION, minP = Q5_ANCHOR_MIN_P, weight: (site: Site) => number = () => 1): Site[] {
  // OOS iteration 3, item 4 — the deepest of the three `--jev off` holes, and the one that
  // survived iteration 2's localiser fallback. `jevProbability` is ABSENT on an anchor the code
  // order produced (localize/index.ts says so on purpose: "these anchors carry no Jev evidence
  // and say so"), and this filter then dropped every one of them — so with every Choice escaped
  // the goal's site list had NO REPLACE SITE AT ALL, only the code-derived insert gaps. That is
  // the recorded `--jev off` `kth` run (`20260922-155658-35hfmbqm`): nine sites, every one a gap,
  // `plausible 0` on every step, while the gold REPLACES L12. `p ≥ minP` is a filter on a FLAT
  // Jev answer ("below 0.05 a line is noise"); it cannot also mean "no answer at all", which is
  // §1.2 clause 3's fallback trigger. When not one replace site of the localisation carries a
  // probability, the localiser's own order stands in — it is already the code order.
  // Review finding 5: `evidenced` is decided PER GROUP, not over the whole localisation. A global
  // predicate killed the fallback the moment any one Choice answered, which is the normal Jev-on
  // case (one function ranked, another escaped or unasked): on a two-file localisation with
  // `a.py:3` answered 0.8 and `b.py` fully escaped, b.py's five code-order replace sites were all
  // dropped — the very "no replace site at all" bug this fallback exists to prevent.
  const groups = new Map<string, Site[]>();
  for (const s of localized.sites) {
    if (s.kind !== 'replace') continue;
    if (isDefLine(s.file, s.line) || !isCodeLine(s.file, s.line)) continue;
    const k = `${s.file.path}:${s.block?.startLine ?? 'module'}`;
    const g = groups.get(k) ?? [];
    g.push(s);
    groups.set(k, g);
  }
  const out: Site[] = [];
  for (const g of groups.values()) {
    const evidenced = g.some((s) => s.evidence.jevProbability !== undefined);
    // with no Jev evidence in THIS group the per-function cut is a ranking cut with nothing to
    // rank, so the whole code order of the function is offered and the site budget decides
    if (!evidenced) {
      out.push(...g);
      continue;
    }
    out.push(...byDesc(g.filter((s) => (s.evidence.jevProbability ?? 0) >= minP), (s) => s.evidence.jevProbability ?? 0).slice(0, perFunction));
  }
  return byDesc(out, (s) => (s.evidence.jevProbability ?? 0) * weight(s));
}

/**
 * Weight of a line's Jev evidence on a repository workspace: the localizer's probability of the
 * beam function holding the line (its file × function path score, `FunctionCandidate.probability`).
 * The repository path asks one line Choice PER beam function, so a line's p is conditional on its
 * function; the joint is what orders lines across functions. Measured need: QuixBugs
 * `depth_first_search` ships a `node.py` whose `Node.successor` property Jev flags at p 0.99 (its
 * body is `return self.successor`) although Q2 gave `node.py` 0.1 and `depth_first_search` 0.93
 * — unweighted, the three top anchors and every anchor gap of the 6-cut went to `node.py`, and
 * the gap after `else:` where `nodesvisited.add(node)` belongs never entered SEEDS. The
 * single-file flat path asks one Choice over the whole file, so its p is already the joint:
 * weight 1 there (`singleFile`). Lines outside every beam function keep weight 1.
 */
export function functionWeight(localized: LocalizeResult, singleFile: boolean): (site: Pick<Site, 'file' | 'line'>) => number {
  if (singleFile) return () => 1;
  const fns = localized.functions as readonly FunctionCandidate[];
  return (site) => {
    let best: number | null = null;
    for (const f of fns) {
      if (f.file.path !== site.file.path || site.line < f.startLine || site.line > f.endLine) continue;
      if (best === null || f.probability > best) best = f.probability;
    }
    return best ?? 1;
  };
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

/** The gap keys of a Choice answer ranked by p (escape excluded). */
function rankedGaps(a: Answer | undefined): { key: string; p: number }[] {
  if (a === undefined || a.type !== 'choice') return [];
  return byDesc(
    Object.entries(a.probabilities)
      .filter(([k, p]) => k !== ESCAPE_KEY && p > 0)
      .map(([key, p]) => ({ key, p })),
    (x) => x.p,
  );
}

/** Q6 for one statement over one function's gaps; returns the gap keys ranked by p (escape excluded). */
async function askGaps(ctx: GoalSiteContext, goal: Goal, fn: BeamFunction, lines: readonly CodeLine[], statement: string, stage: StageName): Promise<{ key: string; p: number }[]> {
  const req = gapRequest({ task: ctx.task, failures: goal.failures, functionName: fn.name, lines, missingStatement: statement });
  if (ctx.signal.aborted) throw new AbortError('signal');
  const r = await ctx.ask(stage, req.state, req.questions);
  return rankedGaps(r.answers[GAP_QUESTION_ID]);
}

/** Q6 for every statement in one request (llm-jev, `batchQ6Fallback`); the ranked gaps per statement. */
async function askGapsBatched(ctx: GoalSiteContext, goal: Goal, fn: BeamFunction, lines: readonly CodeLine[], statements: readonly string[], stage: StageName): Promise<Map<string, { key: string; p: number }[]>> {
  const req = gapBatchRequest({ task: ctx.task, failures: goal.failures, functionName: fn.name, lines, missingStatements: statements });
  if (ctx.signal.aborted) throw new AbortError('signal');
  const r = await ctx.ask(stage, req.state, req.questions);
  return new Map(req.ids.map(({ id, statement }) => [statement, rankedGaps(r.answers[id])]));
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

  // 1. Q5 anchors (top-3 per beam function, p ≥ 0.05), ordered across functions by p × the
  //    function's probability on repositories (`functionWeight`), and the beam functions they live in.
  const weight = functionWeight(localized, singleFile);
  const anchors = q5Anchors(localized, ANCHORS_PER_FUNCTION, Q5_ANCHOR_MIN_P, weight);
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
  for (const a of anchors) addReplace({ ...a, evidence: { ...a.evidence, notes: [...a.evidence.notes] } }, (a.evidence.jevProbability ?? 0) * weight(a));

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
        const span = statementSiteFor(fileOf, line, evidence);
        if (span !== null) addReplace(span, p);
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
    const span = statementSiteFor(ctx.files.get(r.file)!, r.line, { sbflRank: r.rank, sbflScore: r.score, notes: [`sbfl rank ${r.rank}`] });
    if (span !== null) addReplace(span, 0);
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
    // the anchor's third gap: the one the loop around it exits into (`loopExitGap`; wrap, shunting_yard)
    if (entry !== null) {
      const exit = loopExitGap(a.file, a.line, entry);
      if (exit !== null) pushInsert(gapSlotSite(a.file, exit, { notes: [`${LOOP_EXIT_GAP_NOTE} L${a.line}`, gapNote(exit), `in ${entry.qualname}`] }), a);
    }
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

  // 6. Every remaining statement boundary of the top beam function (≤ 40 lines), ranked by the
  //    Jev probability of the lines around each gap and by control-flow position, after the
  //    anchors' own gaps so the cut keeps those first (design §2.5 item 2 lists them first).
  //    The Q6 fallback (design §9 R1) runs before them when the search already reached WIDENED
  //    with nothing plausible: its placements are spliced in FRONT of every other insert site.
  const q6Fallback = new Map<string, string[]>();
  if (top !== undefined) {
    const slots = functionGapSlots(top.file, top.startLine, top.endLine);
    const lineP = (line: number): number => Math.max(lineNouls.get(sbflKey(top.file.path, line)) ?? 0, anchorLineP(localized, top.file, line));
    if (top.endLine - top.startLine + 1 <= GAP_FUNCTION_MAX_LINES) {
      for (const slot of orderGapSlots(slots, lineP)) pushInsert(gapSlotSite(top.file, slot, { notes: [gapNote(slot), `in ${top.name}`] }), null);
      if (slots.length > 0) notes.push(`${slots.length} gap slots of ${top.name}`);
    }
    if (q6FallbackApplies(goal)) {
      const fb = await q6FallbackSites(ctx, goal, top, slots, stage, options.batchQ6Fallback === true);
      requests += fb.requests;
      for (const [stmt, keys] of fb.placements) q6Fallback.set(stmt, keys);
      notes.push(...fb.notes);
      if (fb.sites.length > 0) {
        // in front of everything else, dedup against what was pushed: the same key keeps the fallback's evidence
        const frontKeys = new Set(fb.sites.map(siteKey));
        const rest = inserts.filter((i) => !frontKeys.has(siteKey(i)));
        inserts.splice(0, inserts.length, ...fb.sites, ...rest);
        for (const k of frontKeys) insertAnchors.delete(k);
      }
    }
  }
  const insertSites = inserts.slice(0, maxInsert);

  const insertFirst = insertSitesFirst(options.q5EscapeProbability, options.insertNewLineProbability) || q6Fallback.size > 0;
  const g: GoalSites = { replace: replaceSites, insert: insertSites, ordered: [], insertFirst, shortCircuit, insertAnchors, lineNouls, q6Fallback, requests, notes };
  g.ordered = orderGoalSites(g, insertFirst);
  // the line evidence behind this list, for the WIDENED order (`orderWidenedSites`): Q5 p of every anchor, Q5n Noul of every judged line
  const evidence = new Map<string, number>();
  for (const a of anchors) {
    const k = sbflKey(a.file.path, a.line);
    evidence.set(k, Math.max(evidence.get(k) ?? 0, a.evidence.jevProbability ?? 0));
  }
  for (const [k, p] of lineNouls) evidence.set(k, Math.max(evidence.get(k) ?? 0, p));
  LINE_EVIDENCE.set(g.ordered, evidence);
  return g;
}

/** P(line) from the localizer's line Choice, read off any site of that line (every option line carries it). */
function anchorLineP(localized: LocalizeResult, file: SourceFile, line: number): number {
  let best = 0;
  for (const s of localized.sites) if (s.file.path === file.path && s.line === line && s.kind === 'replace') best = Math.max(best, s.evidence.jevProbability ?? 0);
  return best;
}

/** Enumeration options for the statement templates the Q6 fallback asks about (no test literals: the statement family does not read them). */
function fallbackEnumerateOptions(files: ReadonlyMap<string, SourceFile>): EnumerateOptions {
  return { cap: 254, testLiterals: [], taskIdentifiers: [], corpus: files };
}

/**
 * The top statement templates of a function by prior: the `statement` family enumerated at every
 * gap slot, one entry per distinct statement text (max prior), `Q6_FALLBACK_STATEMENTS` kept.
 */
export function topStatementTemplates(file: SourceFile, fn: Pick<FunctionCandidate, 'name' | 'startLine' | 'endLine'>, slots: readonly GapSlot[], files: ReadonlyMap<string, SourceFile>, limit: number = Q6_FALLBACK_STATEMENTS): { text: string; prior: number }[] {
  const best = new Map<string, number>();
  const opts = fallbackEnumerateOptions(files);
  for (const slot of slots) {
    const site = gapSlotSite(file, slot, { notes: [gapNote(slot), `in ${fn.name}`] });
    for (const c of enumerateTemplates(site, opts, ['statement'])) {
      if (c.text.includes('\n')) continue; // one-line statements only: Q6 names one `missing_statement`
      const text = c.text.trim();
      const prior = c.prior ?? 0;
      if ((best.get(text) ?? -1) < prior) best.set(text, prior);
    }
  }
  return [...best.entries()]
    .map(([text, prior]) => ({ text, prior }))
    .sort((a, b) => b.prior - a.prior || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
    .slice(0, limit);
}

/**
 * Q6 fallback: one `insert_after` Choice per top statement template; the chosen gaps (top-1, plus
 * any other at p ≥ Q6_FALLBACK_MIN_P, ≤ Q6_TOP_GAPS) become insert sites carrying the statement
 * and Jev's probability in their evidence. `after_l<i>` maps to the slots after the statement at
 * line i (several when a blank line gave a second level); `before_l<def>` lies outside the function.
 */
async function q6FallbackSites(ctx: GoalSiteContext, goal: Goal, fn: BeamFunction, slots: readonly GapSlot[], stage: StageName, batch = false): Promise<{ sites: Site[]; placements: Map<string, string[]>; requests: number; notes: string[] }> {
  const out = { sites: [] as Site[], placements: new Map<string, string[]>(), requests: 0, notes: [] as string[] };
  const lines = codeLines(fn.file.mod, fn.startLine, fn.endLine);
  if (slots.length < Q6_FALLBACK_MIN_GAPS || lines.length > Q6_FALLBACK_MAX_LINES) {
    out.notes.push(`q6 fallback skipped: ${slots.length} gap slots, ${lines.length} lines`);
    return out;
  }
  const statements = topStatementTemplates(fn.file, fn, slots, ctx.files);
  if (statements.length === 0) {
    out.notes.push('q6 fallback skipped: no statement template');
    return out;
  }
  const seen = new Set<string>();
  // llm-jev: one request over one state for every statement; else one request per statement (the measured shape)
  const batched = batch ? await askGapsBatched(ctx, goal, fn, lines, statements.map((s) => s.text), stage) : null;
  if (batched !== null) out.requests += 1;
  for (const { text } of statements) {
    let ranked: { key: string; p: number }[];
    if (batched !== null) ranked = batched.get(text) ?? [];
    else {
      ranked = await askGaps(ctx, goal, fn, lines, text, stage);
      out.requests += 1;
    }
    const kept = ranked.filter((r, i) => i === 0 || r.p >= Q6_FALLBACK_MIN_P).slice(0, Q6_TOP_GAPS);
    out.placements.set(text, kept.map((r) => r.key));
    for (const { key, p } of kept) {
      const after = /^after_l(\d+)$/.exec(key);
      if (after === null) continue;
      const line = Number(after[1]);
      const st = statementAt(fn.file.mod, line);
      const matching = slots.filter((g) => g.afterLine === (st?.startLine ?? line));
      for (const slot of matching) {
        const k = `${slot.line}:${slot.indent.length}`;
        const ev: SiteEvidence = { jevProbability: p, notes: [`q6 fallback ${key} p=${p.toFixed(2)} for \`${text}\``, gapNote(slot), `in ${fn.name}`] };
        if (seen.has(k)) {
          const prev = out.sites.find((x) => x.line === slot.line)!;
          prev.evidence.notes.push(ev.notes[0]!);
          if ((prev.evidence.jevProbability ?? 0) < p) prev.evidence.jevProbability = p;
          continue;
        }
        seen.add(k);
        out.sites.push(gapSlotSite(fn.file, slot, ev));
      }
    }
    out.notes.push(`q6 fallback \`${text}\` → ${kept.map((r) => `${r.key} p=${r.p.toFixed(2)}`).join(', ') || 'no gap'}`);
  }
  // the placement Jev is surest about is sieved first, whichever statement it belongs to (stable across statements)
  out.sites = out.sites.map((site, i) => ({ site, i })).sort((a, b) => (b.site.evidence.jevProbability ?? 0) - (a.site.evidence.jevProbability ?? 0) || a.i - b.i).map((x) => x.site);
  return out;
}

// ---------------------------------------------------------------------------------------
// Introspection-derived sites: the raising statement's gap, the class body the failing call's objects point at, the import gap
// ---------------------------------------------------------------------------------------

/**
 * Extra sites the introspected names add per goal, after the Jev-ranked list: the gap before the
 * statement an operand of the failing call was read in, one class-body gap and one module-level
 * import gap (a candidate that collides with a located site is merged onto it and not counted).
 */
export const INTROSPECTION_SITES_MAX = 3;
/** Prefix of the evidence note that marks an introspection-derived site. */
export const INTROSPECTION_SITE_NOTE = 'introspection:';
/** Prefix of the note on the gap before the statement an operand was read in: templates/introspect.ts writes the guard exactly there. */
export const RAISING_GAP_NOTE = `${INTROSPECTION_SITE_NOTE} gap before the raising statement`;

interface ClassTarget {
  file: SourceFile;
  cls: Block;
  /** the method of `cls` the fact points at (the raising / anchored frame's, the site's), or null */
  method: Block | null;
  why: string;
}

/** The innermost `class` block enclosing `line` of `file`, with the direct method of that class the line is in (or null). */
function classAround(file: SourceFile, line: number): { cls: Block; method: Block | null } | null {
  const mod = file.mod;
  let b = blockAt(mod, line);
  let method: Block | null = null;
  while (b !== undefined && b.kind !== 'class') {
    if (b.kind === 'def') method = b;
    b = b.parent === null ? undefined : mod.blocks[b.parent];
  }
  if (b === undefined) return null;
  return { cls: b, method: method !== null && method.parent === b.index ? method : null };
}

/** The corpus file a frame path names: the path itself, else the one file whose path is a suffix of it (or of which it is a suffix). */
function fileOfPath(files: ReadonlyMap<string, SourceFile>, path: string): SourceFile | undefined {
  const direct = files.get(path.replace(/^\.\//, ''));
  if (direct !== undefined) return direct;
  for (const [p, f] of files) if (path.endsWith(`/${p}`) || p.endsWith(`/${path}`)) return f;
  return undefined;
}

/**
 * The class-body gap of `target`: after the method the fact points at when that method is a
 * direct child of the class (the alias production appends `<prefix><Class> = <method>` there),
 * else before the first method of the class; at the class body's indent, `block` the class, in
 * no def. Null when the class has no method at all (nothing to alias to). The first note is the
 * `CLASS_BODY_GAP_NOTE` mark templates/introspect.ts reads, also once merged onto a located gap.
 */
function classBodyGap(target: ClassTarget): Site | null {
  const { file, cls } = target;
  const mod = file.mod;
  const methods = mod.blocks.filter((b) => b.kind === 'def' && b.parent === cls.index);
  const first = methods[0];
  if (first === undefined) return null;
  const after = target.method !== null && methods.includes(target.method) ? target.method : null;
  const line = after !== null ? after.endLine + 1 : first.startLine;
  const indent = indentOf(mod.lines[cls.bodyStart - 1] ?? '') || ' '.repeat(cls.bodyIndent);
  const where = after !== null ? `after ${after.name} (L${after.startLine}-${after.endLine})` : `before ${first.name} (L${first.startLine})`;
  return {
    file,
    line,
    kind: 'insert',
    currentLine: '',
    indent,
    block: { name: cls.name, startLine: cls.startLine, endLine: cls.endLine },
    scope: scopeAt(mod, Math.max(1, line - 1)),
    evidence: { notes: [`${CLASS_BODY_GAP_NOTE} ${cls.name} ${where}`, target.why] },
  };
}

/** The `class <name>` block defined in one of `files` (the first file in map order that defines it). */
function classNamed(files: readonly SourceFile[], name: string): { file: SourceFile; cls: Block } | null {
  for (const file of files) {
    const cls = file.mod.blocks.find((b) => b.kind === 'class' && b.name === name);
    if (cls !== undefined) return { file, cls };
  }
  return null;
}

/**
 * The gap immediately before the statement each operand of the failing call was read in
 * (`operand.frame`), when that frame is in a localised file: at the statement's own indent, so the
 * `attribute_predicate_guard` written there protects exactly that statement (jev-only-rungs-1-2.md
 * §21.5: sympy-17139's guard was tested only inside the raising `if`'s body). Raising receivers
 * first; one gap per statement; a `def` header is not guarded.
 */
function raisingGaps(names: IntrospectedNames, files: ReadonlyMap<string, SourceFile>, localPaths: ReadonlySet<string>): Site[] {
  const out: Site[] = [];
  const seen = new Set<string>();
  const operands = [...names.operands].sort((a, b) => Number(b.raisingReceiver) - Number(a.raisingReceiver));
  for (const o of operands) {
    if (o.frame === null) continue;
    const file = fileOfPath(files, o.frame.path);
    if (file === undefined || !localPaths.has(file.path)) continue;
    if (o.frame.line < 1 || o.frame.line > file.mod.lines.length) continue;
    const line = statementAt(file.mod, o.frame.line)?.startLine ?? o.frame.line;
    if (isDefLine(file, line)) continue;
    const key = `${file.path}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = file.mod.lines[line - 1] ?? '';
    out.push({ file, line, kind: 'insert', currentLine: '', indent: indentOf(text), block: blockFor(file, line), scope: scopeAt(file.mod, Math.max(1, line - 1)), evidence: { notes: [`${RAISING_GAP_NOTE} L${line} of ${file.path}`, `the operand ${o.expr} was read there${o.frame.fn === null ? '' : ` (${o.frame.fn})`}`] } });
  }
  return out;
}

/**
 * The introspection sites in priority order, before any deduplication: the raising-statement gaps,
 * the class-body gap of the class the facts point at, that file's import gap.
 */
function introspectionCandidates(names: IntrospectedNames, files: ReadonlyMap<string, SourceFile>, localised: readonly string[], sites: readonly Site[]): Site[] {
  const localFiles = [...new Set(localised)].map((p) => files.get(p)).filter((f): f is SourceFile => f !== undefined);
  if (localFiles.length === 0) return [];
  const localPaths = new Set(localFiles.map((f) => f.path));
  const out: Site[] = raisingGaps(names, files, localPaths);
  const targets: ClassTarget[] = [];
  const seenClass = new Set<string>();
  const push = (t: ClassTarget | null): void => {
    if (t === null || !localPaths.has(t.file.path)) return;
    const k = `${t.file.path}:${t.cls.index}`;
    if (seenClass.has(k)) return;
    seenClass.add(k);
    targets.push(t);
  };
  // 1. the class whose method the reproduction's traceback raised in (innermost first), then the frames the operands were read in
  const frames = [...[...names.frames].reverse(), ...names.operands.map((o) => o.frame).filter((f): f is NonNullable<typeof f> => f !== null)];
  for (const fr of frames) {
    const file = fileOfPath(files, fr.path);
    if (file === undefined) continue;
    const around = classAround(file, fr.line);
    if (around !== null) push({ file, cls: around.cls, method: around.method, why: `the failing call's frame ${fr.fn ?? '?'} at ${file.path}:${fr.line}` });
  }
  // 2. the class of a raising receiver (`self` / an argument of the raising frame), when a localised file defines it
  for (const o of names.operands) {
    if (!o.raisingReceiver) continue;
    for (const name of [o.typeName, ...o.classes.slice(0, 2)]) {
      const found = classNamed(localFiles, name);
      if (found !== null) push({ file: found.file, cls: found.cls, method: null, why: `the raising receiver ${o.expr} is a ${name}` });
    }
  }
  // 3. the class enclosing the Jev-ranked sites, in site order
  for (const s of sites) {
    if (!localPaths.has(s.file.path)) continue;
    const around = classAround(s.file, s.kind === 'insert' ? Math.max(1, s.line - 1) : s.line);
    if (around !== null) push({ file: s.file, cls: around.cls, method: around.method, why: `the located site ${siteKey(s)} is in ${around.cls.name}` });
  }
  if (targets.length === 0) return out;
  // the class the alias production can write into first: one with a dispatch prefix shared by ≥ 2 methods
  const prefixed = (t: ClassTarget): number => (classMethodPrefixes(t.file.mod).some((p) => p.classIndex === t.cls.index) ? 0 : 1);
  targets.sort((a, b) => prefixed(a) - prefixed(b));
  const top = targets[0]!;
  const gap = classBodyGap(top);
  if (gap !== null) out.push(gap);
  // the module-level import gap of the same file: an alias or a guard may need a name the module does not import yet
  const line = importInsertLine(top.file.mod);
  out.push({ file: top.file, line, kind: 'insert', currentLine: '', indent: '', block: null, scope: scopeAt(top.file.mod, line), evidence: { notes: [`${INTROSPECTION_SITE_NOTE} module-level import gap of ${top.file.path}`, top.why] } });
  return out;
}

/**
 * Sites the introspected names of the failing call add to a goal's list (swebench-reach-oracle-9.md
 * capability 2; jev-only-rungs-1-2.md §18.5 caveat 1, §21.5): localisation builds function-level
 * sites only, so (1) the guard production's target — the gap before the statement an operand was
 * read in, when its file is localised — (2) the class-body gap of the class the facts point at,
 * when a LOCALISED file defines it — the class whose method raised (the innermost workspace frame
 * of the reproduction's traceback, then the anchored frames), the class of a raising receiver
 * operand (`type(self)`), else the class enclosing the Jev-ranked sites; after the raising /
 * located method, else before the first method — and (3) the module-level import gap of that file
 * become insert sites, ≤ `max` in all, in that order, those whose `siteKey` a located site holds
 * left out (see `mergeIntrospectionSites` for the merge `locate` uses instead). Classes with a
 * dispatch prefix (introspect/prefixes.ts) come first: they are the ones the alias production can
 * write into. Pure; nothing is asked.
 */
export function introspectionSites(names: IntrospectedNames, files: ReadonlyMap<string, SourceFile>, localised: readonly string[], sites: readonly Site[], max: number = INTROSPECTION_SITES_MAX): Site[] {
  if (max <= 0) return [];
  const taken = new Set(sites.map(siteKey));
  const out: Site[] = [];
  for (const s of introspectionCandidates(names, files, localised, sites)) {
    if (out.length >= max) break;
    const k = siteKey(s);
    if (taken.has(k)) continue;
    taken.add(k);
    out.push(s);
  }
  return out;
}

export interface MergedSites {
  /** the located sites (colliding ones replaced by their merged copy) followed by the added introspection sites */
  sites: Site[];
  added: Site[];
  merged: Site[];
}

/**
 * The goal's site list with the introspection sites: a candidate whose `siteKey` a located site
 * already holds is MERGED onto that site — its notes appended, so the class-body mark
 * (`CLASS_BODY_GAP_NOTE`) makes `mro_method_alias` fire there at the class indent and the
 * raising-gap mark travels with the site — instead of being dropped (§21.5: sympy-15345's
 * `MCodePrinter` gap collided with the method's block-end slot at the same line and only the
 * import gap survived); the others are appended, ≤ `max` of them. Merges do not count.
 */
export function mergeIntrospectionSites(sites: readonly Site[], names: IntrospectedNames, files: ReadonlyMap<string, SourceFile>, localised: readonly string[], max: number = INTROSPECTION_SITES_MAX): MergedSites {
  const out = [...sites];
  const added: Site[] = [];
  const merged: Site[] = [];
  const at = new Map<string, number>();
  out.forEach((s, i) => {
    const k = siteKey(s);
    if (!at.has(k)) at.set(k, i);
  });
  for (const s of introspectionCandidates(names, files, localised, sites)) {
    const k = siteKey(s);
    const i = at.get(k);
    if (i !== undefined) {
      const cur = out[i]!;
      const notes = s.evidence.notes.filter((n) => !cur.evidence.notes.includes(n));
      if (notes.length === 0) continue;
      const m: Site = { ...cur, evidence: { ...cur.evidence, notes: [...cur.evidence.notes, ...notes] } };
      out[i] = m;
      merged.push(m);
      continue;
    }
    if (added.length >= max) continue;
    at.set(k, out.length);
    out.push(s);
    added.push(s);
  }
  return { sites: out, added, merged };
}

/** True for a site `introspectionSites` built (or marked by `mergeIntrospectionSites`). */
export function isIntrospectionSite(site: Pick<Site, 'evidence'>): boolean {
  return site.evidence.notes.some((n) => n.startsWith(INTROSPECTION_SITE_NOTE));
}

/** True for the gap before a raising statement (`raisingGaps`), built or merged. */
export function isRaisingGap(site: Pick<Site, 'evidence'>): boolean {
  return site.evidence.notes.some((n) => n.startsWith(RAISING_GAP_NOTE));
}

// ---------------------------------------------------------------------------------------
// History-derived sites: where the harvested commits' reversals sit
// ---------------------------------------------------------------------------------------

/** History sites per goal, after the Jev-ranked and the introspection sites. */
export const HISTORY_SITES_MAX = 2;

/**
 * The sites of the reversals that are NOT at a located site (history/source.ts locates the reverse
 * of each change run of the harvested commits at its own lines and emits it only there, so a
 * reversal elsewhere is reachable only through its own site): ≤ `max`, most recent commit first,
 * then nearest to the located sites of the same file (farthest last; files without a located site
 * after those with one), then run order. One per `siteKey`, and none whose key a located site
 * already holds — the goal's bookkeeping (`exhausted`, the visit key) is by `siteKey`, so a second
 * site under the same key would share it. Pure.
 */
export function historySites(facts: Pick<HistoryFacts, 'commits'>, files: ReadonlyMap<string, SourceFile>, localised: readonly string[], sites: readonly Site[] = [], max: number = HISTORY_SITES_MAX): Site[] {
  if (max <= 0 || facts.commits.length === 0) return [];
  const localFiles = [...new Set(localised)].map((p) => files.get(p)).filter((f): f is SourceFile => f !== undefined);
  const taken = new Set(sites.map(siteKey));
  const rows: { site: Site; recency: number; index: number; distance: number }[] = [];
  for (const file of localFiles) {
    const located = sites.filter((s) => s.file.path === file.path);
    for (const r of locateReversals(file, facts)) {
      if (located.some((s) => sameSpan(s, r.candidate.site))) continue;
      if (taken.has(siteKey(r.candidate.site))) continue;
      const distance = located.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...located.map((s) => distanceToSite(s, r.candidate.site)));
      rows.push({ site: r.candidate.site, recency: r.recency, index: r.index, distance });
    }
  }
  rows.sort((a, b) => a.recency - b.recency || a.distance - b.distance || a.index - b.index || a.site.file.path.localeCompare(b.site.file.path));
  const out: Site[] = [];
  for (const r of rows) {
    if (out.length >= max) break;
    const k = siteKey(r.site);
    if (taken.has(k)) continue;
    taken.add(k);
    out.push(r.site);
  }
  return out;
}

/** True for a site `historySites` listed (history/source.ts built it). */
export function isHistorySite(site: Pick<Site, 'evidence'>): boolean {
  return site.evidence.notes.some((n) => n.startsWith(HISTORY_SITE_NOTE));
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
 * blanks and comments excluded) plus every gap slot of the functions of ≤ GAP_FUNCTION_MAX_LINES
 * lines as insert sites, functions in beam order, sites in line order (a gap before a line ahead
 * of the line), deduplicated. `exclude` drops sites already searched (the SEEDS sites) so WIDENED
 * spends on new positions only.
 */
export function widenedSites(functions: readonly Pick<FunctionCandidate, 'file' | 'name' | 'startLine' | 'endLine'>[], exclude: ReadonlySet<string> = new Set()): Site[] {
  const out: Site[] = [];
  const seen = new Set<string>(exclude);
  functions.forEach((f, rank) => {
    const note = `widened over ${f.name} (beam #${rank + 1})`;
    const sites: Site[] = [];
    for (const c of functionCodeLines(f.file, f.startLine, f.endLine)) {
      const site = replaceSiteAt(f.file, c.line, { notes: [note] });
      if (site !== null) sites.push(site);
    }
    // every statement boundary of a short function, the gap before a line ahead of the line itself
    for (const g of functionGapSites(f)) {
      g.evidence.notes.push(note);
      sites.push(g);
    }
    sites.sort((a, b) => a.line - b.line || (a.kind === b.kind ? 0 : a.kind === 'insert' ? -1 : 1));
    for (const site of sites) {
      const k = siteKey(site);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(site);
    }
  });
  return out;
}

/** Jev line evidence (Q5 p or Q5n Noul) of a line of a file; 0 where Jev was not asked or said nothing. */
export type LineEvidence = (file: Pick<SourceFile, 'path'>, line: number) => number;

/** The evidence behind a `buildGoalSites` list, keyed by the `ordered` array it returned (the array `LocalizeResult.sites` carries). */
const LINE_EVIDENCE = new WeakMap<readonly Site[], ReadonlyMap<string, number>>();

/**
 * The line evidence of a goal's SEEDS site list: the map `buildGoalSites` recorded for it, else
 * (a list built elsewhere, tests) the `jevProbability` its replace sites carry.
 */
export function lineEvidenceOf(sites: readonly Site[]): LineEvidence {
  const recorded = LINE_EVIDENCE.get(sites);
  if (recorded !== undefined) return (file, line) => recorded.get(sbflKey(file.path, line)) ?? 0;
  const fromSites = new Map<string, number>();
  for (const s of sites) {
    if (s.kind !== 'replace' || s.evidence.jevProbability === undefined) continue;
    const k = sbflKey(s.file.path, s.line);
    fromSites.set(k, Math.max(fromSites.get(k) ?? 0, s.evidence.jevProbability));
  }
  return (file, line) => fromSites.get(sbflKey(file.path, line)) ?? 0;
}

/** The nearest code line above `line` (the statement a gap before `line` follows); 0 when there is none. */
function previousCodeLine(file: SourceFile, line: number): number {
  for (let l = line - 1; l >= 1; l--) if (isCodeLine(file, l)) return l;
  return 0;
}

/** The evidence score of a widened site: a line's own; for a gap, the better of the line it follows and the line it precedes. */
export function widenedSiteScore(site: Site, lineP: LineEvidence): number {
  if (site.kind === 'replace') return lineP(site.file, site.line);
  const above = previousCodeLine(site.file, site.line);
  return Math.max(above === 0 ? 0 : lineP(site.file, above), lineP(site.file, site.line));
}

/**
 * The WIDENED list in spending order: evidence score descending, then distance from the top-1
 * line (same file; another file sorts after every line of the top file), then the line order
 * `widenedSites` produced; cut at `max`. Deterministic, so the cursor carried across steps in
 * `mem.widenCursor` keeps its meaning while the localisation stands.
 */
export function orderWidenedSites(all: readonly Site[], lineP: LineEvidence, top: Pick<Site, 'file' | 'line'> | null, max: number = WIDENED_SITES_MAX): Site[] {
  const distance = (s: Site): number => (top === null ? 0 : s.file.path === top.file.path ? Math.abs(s.line - top.line) : Number.MAX_SAFE_INTEGER);
  return all
    .map((s, i) => ({ s, i, score: widenedSiteScore(s, lineP), distance: distance(s) }))
    .sort((a, b) => b.score - a.score || a.distance - b.distance || a.i - b.i)
    .slice(0, Math.max(0, max))
    .map((x) => x.s);
}

/** The next `size` widened sites from `cursor` (0-based into `all`); `size` ≤ 0 takes everything left. */
export function nextWidenChunk(all: readonly Site[], cursor: number, size: number): WidenChunk {
  const start = Math.max(0, Math.min(Math.floor(cursor), all.length));
  const end = size > 0 ? Math.min(all.length, start + Math.floor(size)) : all.length;
  return { sites: all.slice(start, end), cursor: end, done: end >= all.length };
}
