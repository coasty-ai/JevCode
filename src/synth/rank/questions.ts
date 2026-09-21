/**
 * State and question builders for the Jev ranker. Every wording here is copied from the
 * measured probes so the design doc can cite it:
 *   - experiments/results/probe-selection.md (`experiments/probe-select/run.mts`): the Choice
 *     instruction per site kind, the escape description, the correct-fix criteria and the
 *     compact per-candidate Noul; state = { task, program: { L<n> }, buggy_line_number,
 *     buggy_line, tests }.
 *   - experiments/results/probe-question-design.md §6: candidate text as the option
 *     DESCRIPTION with keys `candidate_<xx>`, the unchanged line dropped from the options,
 *     tests with expected AND actual, and " Answer carefully and literally." on the Choice.
 * Nothing here asks Jev to count or compute; targets are named by backticked path.
 */
import { clip } from '../../core/text.js';
import type { Json, Question } from '../../core/types.js';
import { ESCAPE_KEY, choice, contextNoul } from '../../jev/questions.js';
import { codeTokens, tokenizeFragment } from '../py/tokenize.js';
import type { Candidate, FailureView, LineEdit, RankContext, Site } from '../types.js';

// ---------------------------------------------------------------------------------------
// Measured wording (verbatim; see the file header for the sources)
// ---------------------------------------------------------------------------------------

/**
 * Site kind as the probes named it: a replaced line or a statement inserted after an anchor
 * line. `insert_before` is the one unmeasured edge: an insertion in front of the first line of
 * the file (a missing import at the top) has no line before it to anchor on, so the measured
 * insert wording is used with "after" turned into "before"; telling Jev the statement goes
 * after line 1 when it goes before it would be a false state.
 */
export type RankMode = 'replace' | 'insert' | 'insert_before';

const INSERT_AFTER = 'inserted immediately after `buggy_line`';
const INSERT_BEFORE = 'inserted immediately before `buggy_line`';

/** Choice instruction per mode (probe-select `CHOICE_INSTRUCTIONS`; `insert_before` derived from `insert`). */
export const CHOICE_INSTRUCTIONS: Readonly<Record<RankMode, string>> = {
  replace:
    'Which option is the corrected line that, put in place of `buggy_line`, makes every test in `tests` pass, including the tests that currently fail? Read each option literally: most options are wrong mutations of the faulty line or copies of other lines. Choose `none_of_these` if no option is a correct fix.',
  insert:
    'Which option is the missing statement that, inserted immediately after `buggy_line`, makes every test in `tests` pass, including the tests that currently fail? Read each option literally: most options are unrelated statements or wrong mutations. Choose `none_of_these` if no option is a correct fix.',
  insert_before:
    'Which option is the missing statement that, inserted immediately before `buggy_line`, makes every test in `tests` pass, including the tests that currently fail? Read each option literally: most options are unrelated statements or wrong mutations. Choose `none_of_these` if no option is a correct fix.',
};

/** probe-question-design §6 / REPORT §11: +0.04 accuracy on tricky literal questions. */
export const LITERAL_SUFFIX = ' Answer carefully and literally.';

/** Description of the `none_of_these` option (probe-select `ESCAPE_DESC`). */
export const ESCAPE_DESCRIPTION = 'No option is a correct fix; every option leaves the tests failing or breaks the function.';

/** Correct-fix criteria (probe-select `NOUL_TRUE` / `NOUL_FALSE`), stated once in the state for compact Nouls. */
export const CORRECT_FIX_CRITERIA = {
  true: {
    definition:
      'The candidate repairs the exact mistake so the function returns `expected` for every test input, including the tests that currently fail, and stays correct on the tests that already pass.',
    examples: ['the operator, index or argument the bug got wrong is corrected and nothing else changes', 'a line equivalent to the reference implementation of this algorithm'],
  },
  false: {
    definition: 'The candidate leaves the bug in place, introduces a different bug, or changes something unrelated to the failure.',
    examples: ['the faulty line unchanged', 'a mutation that changes the wrong operator or the wrong variable', 'a copy or mutation of another line of the program'],
  },
} as const;

/** The `state.correct_fix_criteria` object exactly as the compact-Noul probe wrote it. */
export const CORRECT_FIX_CRITERIA_STATE: Json = {
  correct_fix: CORRECT_FIX_CRITERIA.true.definition,
  correct_fix_examples: [...CORRECT_FIX_CRITERIA.true.examples],
  not_a_fix: CORRECT_FIX_CRITERIA.false.definition,
  not_a_fix_examples: [...CORRECT_FIX_CRITERIA.false.examples],
};

/** Task sentence per mode (probe-select `baseState`), with the function name substituted. */
export function taskSentence(mode: RankMode, functionName: string | null): string {
  const subject = functionName === null ? 'The Python code in `program`' : `The Python function \`${functionName}\``;
  if (mode === 'replace') {
    return `${subject} has a one-line bug. \`buggy_line\` (line \`buggy_line_number\` of \`program\`) is the faulty line. \`tests\` shows inputs, the expected output, and what the buggy program actually does.`;
  }
  const where = mode === 'insert' ? 'after' : 'before';
  return `${subject} is missing one statement. It belongs immediately ${where} \`buggy_line\` (line \`buggy_line_number\` of \`program\`). \`tests\` shows inputs, the expected output, and what the buggy program actually does.`;
}

/** Compact per-candidate Noul (probe-select `noulRequest`, style `compact`). */
export function compactNoulInstruction(mode: RankMode, key: string): string {
  const placement = mode === 'replace' ? 'put in place of `buggy_line`' : mode === 'insert' ? INSERT_AFTER : INSERT_BEFORE;
  return `Is \`candidates.${key}\` a correct fix per \`correct_fix_criteria\`: ${placement}, does it make every test in \`tests\` pass?`;
}

/** Question id of the Choice in every request that carries one. */
export const CHOICE_QUESTION_ID = 'fix';

// ---------------------------------------------------------------------------------------
// Bounds on the state (the probes used whole QuixBugs programs and 3 tests)
// ---------------------------------------------------------------------------------------

export const MAX_PROGRAM_LINES = 120;
/** Window around the site when there is no enclosing def/class block. */
export const MODULE_WINDOW_LINES = 20;
export const MAX_TESTS_IN_STATE = 6;
export const MAX_TEST_VALUE_CHARS = 400;
export const MAX_USER_TASK_CHARS = 2000;
export const MAX_CANDIDATE_CHARS = 400;

// ---------------------------------------------------------------------------------------
// Option keys
// ---------------------------------------------------------------------------------------

/** `candidate_aa`, `candidate_ab`, … (probe-question-design `candidate_<xx>`); base-26, at least two letters. */
export function candidateKey(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`candidate index must be a non-negative integer, got ${index}`);
  let letters = '';
  let n = index;
  do {
    letters = String.fromCharCode(97 + (n % 26)) + letters;
    n = Math.floor(n / 26);
  } while (n > 0);
  return `candidate_${letters.padStart(2, 'a')}`;
}

// ---------------------------------------------------------------------------------------
// Site geometry
// ---------------------------------------------------------------------------------------

/** Replace sites rank as `replace`; insert sites as `insert`, or `insert_before` when there is no line in front of the gap. */
export function rankMode(site: Site): RankMode {
  if (site.kind !== 'insert') return 'replace';
  return site.line > 1 ? 'insert' : 'insert_before';
}

/**
 * The line Jev is told about as `buggy_line`. For replace sites it is the site line; for
 * insert sites the probe's anchor is the line BEFORE the insertion point (`Site.line` is the
 * line the new statement goes in front of). At the top of the file there is no such line, so
 * the anchor is the first line and the wording switches to "before" (`insert_before`).
 */
export function anchorLine(site: Site): number {
  if (site.kind === 'replace') return site.line;
  return site.line > 1 ? site.line - 1 : site.line;
}

/** A statement-level replace site (localize/sites.ts `Site.endLine`): the candidates replace the physical span `line..endLine` with one line. */
function isSpanSite(site: Pick<Site, 'kind' | 'line' | 'endLine'>): site is Site & { endLine: number } {
  return site.kind === 'replace' && site.endLine !== undefined && site.endLine > site.line;
}

/**
 * What the state shows as `buggy_line`, and the `L<n>` it names. A physical-line site shows the
 * program's line; a statement-level site shows the statement joined onto one line (its
 * `currentLine`) and names the span `L<first>-L<last>`: the candidates are one-line rewrites of the
 * whole statement, and the ≤ 255-option Choice and the Noul rubric would otherwise compare them
 * with an unbalanced bracket fragment (`return hash((`) that no option resembles.
 */
export function buggyLineOf(site: Site): { number: string; text: string } {
  const lines = site.file.mod.lines;
  if (isSpanSite(site)) return { number: `L${site.line}-L${site.endLine}`, text: site.currentLine };
  const anchor = anchorLine(site);
  return { number: `L${anchor}`, text: lines[anchor - 1] ?? site.currentLine };
}

/** 1-based inclusive line range shown as `program`: the enclosing block, bounded and centred on the anchor. */
export function programRange(site: Site): { start: number; end: number } {
  const total = site.file.mod.lines.length;
  const anchor = Math.min(Math.max(1, anchorLine(site)), Math.max(1, total));
  let start: number;
  let end: number;
  if (site.block !== null) {
    start = Math.max(1, site.block.startLine);
    end = Math.min(total, site.block.endLine);
  } else {
    start = Math.max(1, anchor - MODULE_WINDOW_LINES);
    end = Math.min(total, anchor + MODULE_WINDOW_LINES);
  }
  if (end - start + 1 > MAX_PROGRAM_LINES) {
    // Keep the anchor visible: shrink from whichever side is further away first.
    const half = Math.floor(MAX_PROGRAM_LINES / 2);
    start = Math.max(start, anchor - half);
    end = Math.min(end, start + MAX_PROGRAM_LINES - 1);
    start = Math.max(1, end - MAX_PROGRAM_LINES + 1);
  }
  return { start, end };
}

// ---------------------------------------------------------------------------------------
// Candidate identity (the unchanged line, duplicates)
// ---------------------------------------------------------------------------------------

/**
 * Code-token signature of a line: whitespace inside the line does not matter to Python, so
 * `gcd(b,a%b)` and `gcd(b, a % b)` are the same candidate. Falls back to the trimmed text
 * when the fragment does not tokenize at all.
 */
export function lineSignature(text: string): string {
  try {
    const toks = codeTokens(tokenizeFragment(text));
    if (toks.length === 0) return text.trim();
    return toks.map((t) => t.text).join('\u0000');
  } catch {
    return text.trim();
  }
}

function editsSignature(edits: readonly LineEdit[] | undefined): string {
  if (edits === undefined || edits.length === 0) return '';
  return JSON.stringify(edits.map((e) => [e.path, e.line, e.kind, e.text === undefined ? null : lineSignature(e.text)]));
}

/** Identity used to drop the unchanged line and to fold duplicate candidates into one option. */
export function candidateSignature(c: Candidate): string {
  return `${lineSignature(c.text)}\u0001${editsSignature(c.extraEdits)}`;
}

/** True when the candidate would leave the site as it is (replace sites only; inserts always change the file). */
export function isUnchanged(c: Candidate, site: Site): boolean {
  if (site.kind !== 'replace') return false;
  if (c.extraEdits !== undefined && c.extraEdits.length > 0) return false;
  return lineSignature(c.text) === lineSignature(site.currentLine);
}

// ---------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------

export interface RankStateOptions {
  /** include `candidates` (and `correct_fix_criteria`) in the state, as the Noul requests need */
  withCandidates: boolean;
}

/** Option description for one candidate: the line, or the line plus its follow-up edits. */
export function candidateDescription(c: Candidate): Json {
  const line = clip(c.text, MAX_CANDIDATE_CHARS);
  if (c.extraEdits === undefined || c.extraEdits.length === 0) return line;
  return {
    line,
    follow_up_edits: c.extraEdits.map((e) => ({ path: e.path, line: e.line, kind: e.kind, text: e.text === undefined ? null : clip(e.text, MAX_CANDIDATE_CHARS) })),
  };
}

function testView(f: FailureView): Json {
  return {
    test_id: clip(f.testId, MAX_TEST_VALUE_CHARS),
    call: clip(f.call, MAX_TEST_VALUE_CHARS),
    expected: clip(f.expected, MAX_TEST_VALUE_CHARS),
    actual_with_bug: clip(f.actual, MAX_TEST_VALUE_CHARS),
  };
}

/**
 * The Jev state for ranking candidates at one site (measured shape, probe-selection.md
 * "State shape"). `program` is rebuilt from the site's file rather than taken from
 * `ctx.functionListing` because the probes measured the `{ L<n>: text }` object form and a
 * single-string listing measurably hurt selection (probe-question-design `Sc_string`).
 */
export function buildRankState(candidates: readonly Candidate[], keys: readonly string[], site: Site, ctx: Pick<RankContext, 'task' | 'failures'>, opts: RankStateOptions): Record<string, Json> {
  if (candidates.length !== keys.length) throw new RangeError(`buildRankState: ${candidates.length} candidates but ${keys.length} keys`);
  const mode = rankMode(site);
  const { start, end } = programRange(site);
  const lines = site.file.mod.lines;
  const program: Record<string, Json> = {};
  for (let n = start; n <= end; n++) program[`L${n}`] = lines[n - 1] ?? '';
  const buggy = buggyLineOf(site);
  const state: Record<string, Json> = {
    task: taskSentence(mode, site.block?.name ?? null),
    file: site.file.path,
    program,
    buggy_line_number: buggy.number,
    buggy_line: buggy.text,
    tests: ctx.failures.slice(0, MAX_TESTS_IN_STATE).map(testView),
  };
  const userTask = ctx.task.trim();
  if (userTask.length > 0) state['user_task'] = clip(userTask, MAX_USER_TASK_CHARS);
  if (opts.withCandidates) {
    const cands: Record<string, Json> = {};
    candidates.forEach((c, i) => {
      cands[keys[i] ?? candidateKey(i)] = candidateDescription(c);
    });
    state['candidates'] = cands;
    state['correct_fix_criteria'] = CORRECT_FIX_CRITERIA_STATE;
  }
  return state;
}

// ---------------------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------------------

/** The Choice over candidates: text as description, `none_of_these` described, literal suffix. */
export function buildChoiceQuestion(candidates: readonly Candidate[], keys: readonly string[], mode: RankMode): Question {
  const options: Record<string, Json | null> = {};
  candidates.forEach((c, i) => {
    options[keys[i] ?? candidateKey(i)] = candidateDescription(c);
  });
  options[ESCAPE_KEY] = ESCAPE_DESCRIPTION;
  return choice(CHOICE_INSTRUCTIONS[mode] + LITERAL_SUFFIX, options);
}

/** One compact Noul per candidate, question id = option key (ids are invisible to the model, REPORT §7). */
export function buildCompactNouls(keys: readonly string[], mode: RankMode): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const k of keys) out[k] = contextNoul(compactNoulInstruction(mode, k));
  return out;
}
