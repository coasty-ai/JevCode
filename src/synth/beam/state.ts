/**
 * Jev state and question wordings for the token-beam and template routes. The shapes and
 * sentences are the ones measured in experiments/results/probe-token-synthesis.md (§1, §4);
 * when several hypotheses share one request each question names its own target by a
 * backticked path under `hypotheses` (REPORT §7: questions are independent; §14: name the
 * target by path when the state holds more than one candidate).
 */
import type { Json } from '../../core/types.js';
import { noul } from '../../jev/questions.js';
import type { NoulCriteriaSpec } from '../../jev/questions.js';
import type { Question } from '../../core/types.js';
import { blockAt } from '../py/index.js';
import type { FailureView, Site } from '../types.js';
import { sanitise } from './tokens.js';

export const MARK = '<<<FIX THIS LINE>>>';
export const HYPOTHESES_KEY = 'hypotheses';
/** Failing tests shown in the state (measured with 3; bounded so the state stays small). */
export const MAX_FAILURES_IN_STATE = 5;
/** Lines of context around a module-level site when no enclosing block exists. */
export const MODULE_CONTEXT_LINES = 15;
/** A file this short is listed whole (the measured shape: the entire QuixBugs program, imports included). */
export const WHOLE_FILE_MAX_LINES = 60;
/** The outermost enclosing def/class is listed when it fits in this many lines, else the innermost. */
export const OUTER_BLOCK_MAX_LINES = 120;

/**
 * Line range of `program`: the whole file when short (imports and helpers stay visible, as
 * measured), else the outermost enclosing def/class when it fits (a nested function shows the
 * closure variables its fix needs, e.g. `nodesvisited` in depth_first_search), else the innermost
 * block, else a window around a module-level site.
 */
export function listingRange(site: Site): { from: number; to: number } {
  const mod = site.file.mod;
  const n = mod.lines.length;
  if (n <= WHOLE_FILE_MAX_LINES) return { from: 1, to: n };
  if (site.block !== null) {
    let outer = blockAt(mod, site.block.startLine);
    while (outer !== undefined && outer.parent !== null) outer = mod.blocks[outer.parent];
    if (outer !== undefined && outer.endLine - outer.startLine + 1 <= OUTER_BLOCK_MAX_LINES) return { from: outer.startLine, to: outer.endLine };
    return { from: site.block.startLine, to: site.block.endLine };
  }
  return { from: Math.max(1, site.line - MODULE_CONTEXT_LINES), to: Math.min(n, site.line + MODULE_CONTEXT_LINES) };
}

/** Listing of `listingRange` with the site replaced by (or preceded by) the marker; no line numbers. */
export function markedListing(site: Site): string {
  const lines = site.file.mod.lines;
  const { from, to } = listingRange(site);
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    if (n === site.line) {
      out.push(site.indent + MARK);
      if (site.kind === 'insert') out.push(lines[n - 1] ?? '');
      continue;
    }
    out.push(lines[n - 1] ?? '');
  }
  if (site.kind === 'insert' && site.line > to) out.push(site.indent + MARK);
  return out.join('\n');
}

/** Current line without indentation, or null for an insert site. */
export function buggyLine(site: Site): string | null {
  if (site.kind === 'insert') return null;
  const t = site.currentLine.trim();
  return t.length === 0 ? null : t;
}

export function taskSentence(site: Site): string {
  const where = site.block !== null ? `The Python function \`${site.block.name}\`` : `The Python module \`${site.file.path}\``;
  const origin = buggyLine(site) === null ? 'No line existed there: a new line must be inserted.' : 'The original wrong line at that position is `buggy_line`; the correct line is usually a small edit of it.';
  return `${where} has a one-line bug. In \`program\` the faulty position is marked \`${MARK}\` (the marker keeps the correct indentation). ${origin} The corrected program must make every entry of \`tests\` pass.`;
}

export function testsView(failures: readonly FailureView[]): Json {
  return failures.slice(0, MAX_FAILURES_IN_STATE).map((f) => ({ test: f.testId, call: f.call, expected: f.expected, actual: f.actual }));
}

/** `task`, `goal`, `file`, `program`, `buggy_line`, `tests`: shared by every question of a site. */
export function baseState(site: Site, task: string, failures: readonly FailureView[]): Record<string, Json> {
  const state: Record<string, Json> = {
    task: taskSentence(site),
    file: site.file.path,
    program: markedListing(site),
    buggy_line: buggyLine(site),
    tests: testsView(failures),
  };
  if (task.trim().length > 0) state['goal'] = task;
  return state;
}

/** Stable, semantic state key for a hypothesis (never a positional index). */
export function hypothesisKey(prefix: string, text: string, taken: Set<string>): string {
  const base = `${prefix}_${sanitise(text.length === 0 ? 'empty' : text)}`.slice(0, 56);
  let k = base;
  let n = 2;
  while (taken.has(k)) k = `${base}_${n++}`;
  taken.add(k);
  return k;
}

/** Path prefix for fields of one hypothesis, or '' when the state is flat. */
export function fieldPath(hypothesis: string | null, field: string): string {
  return hypothesis === null ? field : `${HYPOTHESES_KEY}.${hypothesis}.${field}`;
}

// ---------------------------------------------------------------------------------------
// Measured question wordings
// ---------------------------------------------------------------------------------------

export function nextTokenQuestion(hypothesis: string | null): string {
  const pl = `\`${fieldPath(hypothesis, 'partial_line')}\``;
  const pt = `\`${fieldPath(hypothesis, 'partial_tokens')}\``;
  return `${pl} is the beginning of the correct replacement line for the \`${MARK}\` marker in \`program\` (its tokens so far, left to right, are ${pt}). Which single Python token comes immediately next in the correct line? Choose \`end_of_line\` if ${pl} is already the complete correct line. Choose \`none_of_these\` if the next token is not offered. Answer literally: exactly one token, not a whole expression.`;
}

export const TEMPLATE_QUESTION = `Each option is a line shape where \`_\` stands for any single identifier or literal (names, numbers, strings, True/False/None); keywords, operators and punctuation are shown literally. Which shape does the correct replacement line for the \`${MARK}\` marker in \`program\` have? Choose \`none_of_these\` if no listed shape fits the correct line.`;

export function slotQuestion(hypothesis: string | null): string {
  const lws = `\`${fieldPath(hypothesis, 'line_with_slots')}\``;
  const stf = `\`${fieldPath(hypothesis, 'slot_to_fill')}\``;
  return `${lws} is the correct replacement line for the \`${MARK}\` marker in \`program\`, with earlier slots already filled and the remaining slots shown as \`<SLOT_n>\`. Which identifier or literal belongs at ${stf}? Choose \`none_of_these\` if the right token is not offered.`;
}

/** Paired Noul (probe §7.7): the escape option does not detect "the pool is wrong" when the buggy line is in the state. */
export const CURRENT_LINE_CORRECT_ID = 'buggy_line_already_correct';
const CURRENT_LINE_CORRECT_CRITERIA: NoulCriteriaSpec = {
  true: {
    definition: 'with `buggy_line` left exactly as it is at the marker, every entry of `tests` would pass; the defect is elsewhere in `program`',
    examples: ['the failing test exercises a branch that does not run through the marked line', 'the expected and actual outputs differ because of a line other than `buggy_line`'],
  },
  false: {
    definition: '`buggy_line` is the defect: at least one entry of `tests` fails because of what this line computes, compares or returns',
    examples: ['`return gcd(a % b, b)` recurses forever where `tests` expect `gcd(b, a % b)`', 'a `<` where the expected output needs `<=`, an argument in the wrong order, a wrong constant'],
  },
};
export function currentLineCorrectNoul(): Question {
  return noul('Does `buggy_line`, unchanged, already make every entry of `tests` pass? Answer literally from `program` and `tests`.', CURRENT_LINE_CORRECT_CRITERIA);
}
