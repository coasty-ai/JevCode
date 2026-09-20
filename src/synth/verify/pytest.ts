/**
 * pytest output → TestRunSummary. Reads three layers, each optional, so `-q`, `-rA`, `-v` and
 * `--tb=no|line|short|long` all work:
 *   1. the final counts line ("7 failed, 1 passed, 1 skipped, 1 xfailed, 1 xpassed, 1 error in 0.02s")
 *      is authoritative for the numbers;
 *   2. status lines give node ids: the short test summary ("FAILED path::id - msg", always
 *      printed for failures and errors, PASSED/XPASS only with -rA) and the verbose progress
 *      lines ("path::id PASSED [ 10%]");
 *   3. the FAILURES / ERRORS sections give the `E` lines per test, from which expected and
 *      actual are extracted (assertion introspection `assert left == right`, the bench module's
 *      "<call> -> <actual>, expected <expected>" message, or the exception line).
 * Nothing here is the oracle: counts and ids are handed to code; Jev only ever sees the result.
 */
import type { FailureView, TestRunSummary } from '../types.js';
import { bound, tail, VALUE_BOUND } from './text.js';

export type PytestStatus = 'PASSED' | 'FAILED' | 'ERROR' | 'SKIPPED' | 'XFAIL' | 'XPASS';

export interface PytestCounts {
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  xfailed: number;
  xpassed: number;
  deselected: number;
  /** a counts line was found (also true for "no tests ran") */
  found: boolean;
}

export interface PytestParse {
  counts: PytestCounts;
  /**
   * node id → status. The short test summary is authoritative for every status kind it lists;
   * verbose progress lines only contribute ids of kinds the summary does not report (PASSED
   * under plain -v). Why: a test's captured stdout is echoed under PASSES / FAILURES and, with
   * -s, in the progress area, so a status-shaped line there must not become a phantom test.
   */
  statuses: Map<string, PytestStatus>;
  /** node id → short summary message ("assert (1 + 1) == 3") when the summary line carried one */
  messages: Map<string, string>;
  /** section name (e.g. "test_param[13-13-13]", "TestGroup.test_method_fail") → E lines of the FIRST section with that name */
  sections: Map<string, string[]>;
  /** every FAILURES / ERRORS section in order, with the test-file paths its traceback names (to tell same-named tests in two files apart) */
  sectionList: PytestSection[];
}

export interface PytestSection {
  name: string;
  eLines: string[];
  /** paths as printed in the section's location lines ("test_x.py:12: AssertionError", "file /abs/test_x.py, line 3") */
  files: string[];
}

const STATUS_WORDS = 'PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS';
const SHORT_SUMMARY_LINE = new RegExp(`^(${STATUS_WORDS})\\s+(.*)$`);
// "path::name[params] STATUS ..." — the id must contain "::" so the plain-word summary lines do not match here.
const VERBOSE_LINE = new RegExp(`^([^\\s:][^\\s]*::.+?)\\s+(${STATUS_WORDS})\\b.*$`);
const SECTION_HEADER = /^={3,} (.+?) ={3,}$/;
const TEST_HEADER = /^_{3,} (.+?) _{3,}$/;
const E_LINE = /^E(?:\s+(.*))?$/;
// "test_x.py:12: AssertionError", "test_x.py:6: in gcd", "/abs/test_x.py:34", "file /abs/test_x.py, line 34"
const LOCATION_LINE = /^(?:file )?(\S+\.py)(?::\d+|, line \d+)/;
const SUMMARY_SECTION = 'short test summary info';
const COUNT_ITEM = /(\d+) (passed|failed|errors?|skipped|xfailed|xpassed|deselected)\b/g;
const COUNTS_LINE = /\bin \d+(?:\.\d+)?s\b/;

function emptyCounts(): PytestCounts {
  return { passed: 0, failed: 0, errors: 0, skipped: 0, xfailed: 0, xpassed: 0, deselected: 0, found: false };
}

/** The last "... in 1.23s" line that carries counts (or "no tests ran"). */
function parseCounts(lines: readonly string[]): PytestCounts {
  for (let k = lines.length - 1; k >= 0; k--) {
    const raw = lines[k] ?? '';
    if (!COUNTS_LINE.test(raw)) continue;
    const line = raw.replace(/^=+|=+$/g, '').trim();
    if (/^no tests ran\b/.test(line)) return { ...emptyCounts(), found: true };
    const counts = emptyCounts();
    let any = false;
    for (const m of line.matchAll(COUNT_ITEM)) {
      const n = Number(m[1]);
      const word = m[2] ?? '';
      any = true;
      if (word === 'passed') counts.passed = n;
      else if (word === 'failed') counts.failed = n;
      else if (word === 'error' || word === 'errors') counts.errors = n;
      else if (word === 'skipped') counts.skipped = n;
      else if (word === 'xfailed') counts.xfailed = n;
      else if (word === 'xpassed') counts.xpassed = n;
      else if (word === 'deselected') counts.deselected = n;
    }
    if (any) return { ...counts, found: true };
  }
  return emptyCounts();
}

function isStatus(s: string): s is PytestStatus {
  return s === 'PASSED' || s === 'FAILED' || s === 'ERROR' || s === 'SKIPPED' || s === 'XFAIL' || s === 'XPASS';
}

/**
 * Where a line sits in pytest's output. Status lines are only read where pytest itself prints
 * them: verbose progress lines before the first section (a run killed early has nothing else),
 * short summary lines inside "short test summary info". Everything under PASSES, warnings or an
 * unknown section is a test's own output and is ignored.
 */
type Phase = 'progress' | 'failures' | 'summary' | 'other';

/** Split the whole output into its pieces; pure and total (never throws on garbage). */
export function parsePytestOutput(output: string): PytestParse {
  const lines = output.split(/\r?\n/);
  const verbose = new Map<string, PytestStatus>();
  const summary = new Map<string, PytestStatus>();
  const messages = new Map<string, string>();
  const sections = new Map<string, string[]>();
  const sectionList: PytestSection[] = [];
  let phase: Phase = 'progress';
  let current: PytestSection | null = null;
  for (const line of lines) {
    const section = SECTION_HEADER.exec(line);
    if (section !== null) {
      const name = section[1] ?? '';
      if (name === 'FAILURES' || name === 'ERRORS') phase = 'failures';
      else if (name === SUMMARY_SECTION) phase = 'summary';
      else if (/^test session starts$/.test(name)) phase = 'progress';
      else phase = 'other';
      current = null;
      continue;
    }
    if (phase === 'failures') {
      const header = TEST_HEADER.exec(line);
      if (header !== null) {
        // "ERROR at setup of test_x" / "ERROR collecting test_x.py" → the plain name
        const name = (header[1] ?? '').replace(/^ERROR (?:at (?:setup|call|teardown) of|collecting) /, '');
        current = { name, eLines: [], files: [] };
        sectionList.push(current);
        if (!sections.has(name)) sections.set(name, current.eLines);
        continue;
      }
      if (current === null) continue;
      const e = E_LINE.exec(line);
      if (e !== null) {
        current.eLines.push(e[1] ?? '');
        continue;
      }
      const loc = LOCATION_LINE.exec(line);
      if (loc !== null && loc[1] !== undefined && !current.files.includes(loc[1])) current.files.push(loc[1]);
      continue;
    }
    if (phase === 'summary') {
      const short = SHORT_SUMMARY_LINE.exec(line);
      if (short === null) continue;
      const status = short[1] ?? '';
      const rest = short[2] ?? '';
      // SKIPPED lines carry "[n] path:line: reason", no node id: the count line already has them.
      if (status === 'SKIPPED' || !isStatus(status)) continue;
      const sep = rest.indexOf(' - ');
      const id = (sep === -1 ? rest : rest.slice(0, sep)).trim();
      if (id === '') continue;
      summary.set(id, status);
      if (sep !== -1) messages.set(id, rest.slice(sep + 3).trim());
      continue;
    }
    if (phase === 'progress') {
      const v = VERBOSE_LINE.exec(line);
      if (v === null) continue;
      const id = (v[1] ?? '').trim();
      const status = v[2] ?? '';
      if (isStatus(status) && id !== '') verbose.set(id, status);
    }
  }
  // Merge: the summary wins for the kinds it reports; verbose ids fill in the kinds it does not.
  const reported = new Set(summary.values());
  const statuses = new Map<string, PytestStatus>();
  for (const [id, status] of verbose) if (!reported.has(status) && !summary.has(id)) statuses.set(id, status);
  for (const [id, status] of summary) statuses.set(id, status);
  return { counts: parseCounts(lines), statuses, messages, sections, sectionList };
}

/** The file part of a node id ("pkg/test_x.py::TestA::test_b" → "pkg/test_x.py"), '' when there is none. */
function fileOf(nodeId: string): string {
  const at = nodeId.indexOf('::');
  return at === -1 ? '' : nodeId.slice(0, at);
}

/**
 * The E lines for a node id. FAILURES headers carry only the test name, so two files with a
 * test of the same name collide; when they do, the section whose traceback names the id's file
 * is the right one. Falls back to the first section of that name, then to the id itself
 * (collection errors are keyed by module).
 */
export function sectionFor(parse: PytestParse, nodeId: string): readonly string[] {
  const name = sectionNameOf(nodeId);
  const file = fileOf(nodeId);
  const same = parse.sectionList.filter((s) => s.name === name);
  if (same.length > 1 && file !== '') {
    const match = same.find((s) => s.files.some((f) => f === file || f.endsWith(`/${file}`)));
    if (match !== undefined) return match.eLines;
  }
  return same[0]?.eLines ?? parse.sections.get(nodeId) ?? [];
}

/** "path::TestGroup::test_x[1-2]" → "TestGroup.test_x[1-2]" (the FAILURES header form). */
export function sectionNameOf(nodeId: string): string {
  const parts = nodeId.split('::');
  return parts.length > 1 ? parts.slice(1).join('.') : nodeId;
}

const COMPARISONS: readonly string[] = [' == ', ' != ', ' not in ', ' in ', ' is not ', ' is ', ' <= ', ' >= ', ' < ', ' > '];

/** `assert left OP right` → actual = left; expected = right for ==, "OP right" otherwise. */
export function splitComparison(expr: string): { actual: string; expected: string } {
  let best: { at: number; op: string } | null = null;
  for (const op of COMPARISONS) {
    const at = expr.indexOf(op);
    if (at !== -1 && (best === null || at < best.at)) best = { at, op };
  }
  if (best === null) return { actual: expr, expected: '' };
  const left = expr.slice(0, best.at).trim();
  const right = expr.slice(best.at + best.op.length).trim();
  return { actual: left, expected: best.op === ' == ' ? right : `${best.op.trim()} ${right}` };
}

const BENCH_MESSAGE = /^(?:AssertionError: )?(.*?) -> (.*), expected (.*)$/;
const ASSERT_INTRO = /^(?:AssertionError: )?assert (.+)$/;

/**
 * expected / actual (and the call when the message names it) from a test's `E` lines, falling
 * back to the short summary message. Bounded to VALUE_BOUND chars each.
 */
export function extractExpectation(eLines: readonly string[], shortMessage?: string): { call: string | null; expected: string; actual: string } {
  const text = eLines.map((l) => l.trim()).filter((l) => l !== '');
  const candidates = shortMessage !== undefined && shortMessage !== '' ? [...text, shortMessage] : text;
  // 1. the bench modules' message form carries the call, the actual value and the expected value
  for (const l of candidates) {
    const m = BENCH_MESSAGE.exec(l);
    if (m !== null) return { call: bound(m[1] ?? '', VALUE_BOUND), actual: bound(m[2] ?? '', VALUE_BOUND), expected: bound(m[3] ?? '', VALUE_BOUND) };
  }
  // 2. pytest's assertion introspection line
  for (const l of candidates) {
    const m = ASSERT_INTRO.exec(l);
    if (m !== null) {
      const parts = splitComparison(m[1] ?? '');
      return { call: null, actual: bound(parts.actual, VALUE_BOUND), expected: bound(parts.expected, VALUE_BOUND) };
    }
  }
  // 3. an exception or a fixture error: the first line is what happened; nothing to expect against
  const first = candidates[0] ?? '';
  return { call: null, actual: bound(first, VALUE_BOUND), expected: '' };
}

export interface PytestSummaryContext {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

/**
 * Build the summary. Counting rules (why): a test that pytest reports as xfailed is one the
 * suite itself says must not count as a failure, so it is bucketed with skipped; an xpassed
 * (non-strict) test ran and passed, so it counts as passed. `failing` = FAILED + ERROR ids,
 * `passing` = PASSED + XPASS ids (empty without -rA/-v: the counts still carry the numbers).
 */
export function summaryFromPytest(parse: PytestParse, ctx: PytestSummaryContext): TestRunSummary {
  const c = parse.counts;
  const failing: string[] = [];
  const passing: string[] = [];
  const failures: FailureView[] = [];
  for (const [id, status] of parse.statuses) {
    if (status === 'FAILED' || status === 'ERROR') {
      failing.push(id);
      const ex = extractExpectation(sectionFor(parse, id), parse.messages.get(id));
      // -v --tb=no leaves nothing but the status word; say so rather than hand Jev an empty string
      const actual = ex.actual !== '' ? ex.actual : status === 'ERROR' ? 'error: no details in the output' : 'failed: no details in the output';
      failures.push({ testId: id, call: ex.call ?? id, expected: ex.expected, actual });
    } else if (status === 'PASSED' || status === 'XPASS') {
      passing.push(id);
    }
  }
  // Without a counts line (killed run, crash before the session summary) the ids are all we have.
  const passed = c.found ? c.passed + c.xpassed : passing.length;
  const failed = c.found ? c.failed : parse.statuses.size === 0 ? 0 : [...parse.statuses.values()].filter((s) => s === 'FAILED').length;
  const errors = c.found ? c.errors : [...parse.statuses.values()].filter((s) => s === 'ERROR').length;
  const skipped = c.found ? c.skipped + c.xfailed : [...parse.statuses.values()].filter((s) => s === 'SKIPPED' || s === 'XFAIL').length;
  return {
    command: ctx.command,
    passed,
    failed,
    errors,
    skipped,
    total: passed + failed + errors + skipped,
    failing,
    passing,
    failures,
    exitCode: ctx.exitCode,
    timedOut: ctx.timedOut,
    durationMs: ctx.durationMs,
    outputTail: tail(ctx.outputTail),
  };
}

/** True when the output looks like pytest at all (a counts line or any status line). */
export function looksLikePytest(parse: PytestParse): boolean {
  return parse.counts.found || parse.statuses.size > 0;
}
