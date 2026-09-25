/**
 * Non-pytest runners for the test oracle (docs/JEV-ONLY-DESIGN.md §4.1, §4.3): unittest's
 * TextTestRunner (which is also what Django's `tests/runtests.py` prints) and sympy's `bin/test`
 * → TestRunSummary with test ids and failure details, plus `relatedTestFiles`, the code-only
 * guess at which test files exercise a module (for goal-subset runs). Nothing here is the oracle:
 * counts and ids are handed to code; Jev only ever sees the result. The count-only parsers the
 * engine's judge state uses live in src/workspace/tests.ts; these read the same lines.
 */
import type { FailureView, TestRunSummary } from '../types.js';
import { bound, tail, VALUE_BOUND } from './text.js';
import { stripAnsi } from '../../../core/ansi.js';

// ---------------------------------------------------------------------------------------
// Shared: expected / actual from a Python traceback
// ---------------------------------------------------------------------------------------

/**
 * The exception line of a traceback (the first non-indented line after the last `Traceback`
 * header, so a chained exception yields the final one) split into expected / actual:
 * `AssertionError: 'a' != 'b'` → actual `'a'`, expected `'b'`; other messages are the actual
 * with an empty expected. Bounded to VALUE_BOUND chars each.
 */
export function expectationFromTraceback(lines: readonly string[]): { expected: string; actual: string } {
  let start = 0;
  for (let k = 0; k < lines.length; k++) if ((lines[k] ?? '').startsWith('Traceback (most recent call last)')) start = k + 1;
  let exc = '';
  for (let k = start; k < lines.length; k++) {
    const l = lines[k] ?? '';
    if (l.trim() === '' || /^\s/.test(l) || l.startsWith('Traceback')) continue;
    exc = l.trim();
    break;
  }
  if (exc === '') exc = (lines.find((l) => l.trim() !== '') ?? '').trim();
  const m = /^AssertionError: (.*)$/.exec(exc);
  if (m !== null) {
    const msg = m[1] ?? '';
    const at = msg.indexOf(' != ');
    if (at !== -1) {
      const right = msg.slice(at + 4);
      const custom = right.indexOf(' : ');
      return { actual: bound(msg.slice(0, at), VALUE_BOUND), expected: bound(custom === -1 ? right : right.slice(0, custom), VALUE_BOUND) };
    }
    return { actual: bound(msg, VALUE_BOUND), expected: '' };
  }
  return { actual: bound(exc, VALUE_BOUND), expected: '' };
}

function emptySummary(ctx: RunnerSummaryContext): TestRunSummary {
  return { command: ctx.command, passed: 0, failed: 0, errors: 0, skipped: 0, total: 0, failing: [], passing: [], failures: [], exitCode: ctx.exitCode, timedOut: ctx.timedOut, durationMs: ctx.durationMs, outputTail: tail(ctx.outputTail) };
}

export interface RunnerSummaryContext {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

// ---------------------------------------------------------------------------------------
// unittest / Django
// ---------------------------------------------------------------------------------------

export type UnittestStatus = 'ok' | 'FAIL' | 'ERROR' | 'skipped' | 'expected failure' | 'unexpected success';

export interface UnittestCounts {
  ran: number;
  failures: number;
  errors: number;
  skipped: number;
  expectedFailures: number;
  unexpectedSuccesses: number;
  /** a `Ran N tests` line was found */
  found: boolean;
}

export interface UnittestParse {
  counts: UnittestCounts;
  /** dotted label (`decorators.tests.DecoratorsTest.test_attributes`, a valid runtests.py / unittest argument) → status */
  statuses: Map<string, UnittestStatus>;
  /** label → the traceback lines of its FAIL / ERROR section */
  sections: Map<string, string[]>;
}

const RAN_LINE = /^Ran (\d+) tests? in [\d.]+s\s*$/;
const RESULT_LINE = /^(OK|FAILED)(?: \(([^)]*)\))?\s*$/;
const RULE_EQ = /^={10,}$/;
const RULE_DASH = /^-{10,}$/;
const TEST_LINE = /^(\w+) \(([\w.]+)\)/;
const STATUS_SUFFIX = / \.\.\. (ok|OK|FAIL|ERROR|skipped\b.*|expected failure|unexpected success)\s*$/;
const BARE_STATUS = /^(ok|OK|FAIL|ERROR)$/;
const SECTION_HEADER = /^(FAIL|ERROR): (\w+) \(([\w.]+)\)/;

/** `test_x (a.b.C)` → `a.b.C.test_x`; Python ≥ 3.11 prints `test_x (a.b.C.test_x)`. */
export function unittestLabelOf(name: string, qual: string): string {
  return qual.endsWith(`.${name}`) ? qual : `${qual}.${name}`;
}

function normaliseStatus(s: string): UnittestStatus {
  if (s === 'ok' || s === 'OK') return 'ok';
  if (s === 'FAIL' || s === 'ERROR' || s === 'expected failure' || s === 'unexpected success') return s;
  return 'skipped';
}

function emptyUnittestCounts(): UnittestCounts {
  return { ran: 0, failures: 0, errors: 0, skipped: 0, expectedFailures: 0, unexpectedSuccesses: 0, found: false };
}

/**
 * Pure and total. Verbose lines are `test_x (mod.Class) ... ok|FAIL|ERROR|skipped 'why'|expected
 * failure|unexpected success`; a docstring puts the status on the next line (`test_x (mod.C)` then
 * `The docstring. ... FAIL`) and Django's own output can glue a message between the dots and a bare
 * `ok` on the following line. Sections start with a rule of `=`, then `FAIL: test_x (mod.C)`, an
 * optional docstring, a rule of `-`, the traceback. The summary is `Ran N tests in Xs` + `OK` /
 * `FAILED (failures=a, errors=b, skipped=c, expected failures=d, unexpected successes=e)`.
 */
export function parseUnittestOutput(output: string): UnittestParse {
  const lines = output.split(/\r?\n/);
  const statuses = new Map<string, UnittestStatus>();
  const sections = new Map<string, string[]>();
  const counts = emptyUnittestCounts();
  let pending: string | null = null;
  let phase: 'progress' | 'sections' = 'progress';
  let current: { lines: string[]; inBody: boolean } | null = null;
  for (let k = 0; k < lines.length; k++) {
    const line = (lines[k] ?? '').trimEnd();
    const ran = RAN_LINE.exec(line);
    if (ran !== null) {
      counts.ran = Number(ran[1]);
      counts.found = true;
      current = null;
      for (let j = k + 1; j < lines.length; j++) {
        const res = RESULT_LINE.exec((lines[j] ?? '').trimEnd());
        if (res === null) continue;
        for (const f of (res[2] ?? '').matchAll(/([a-z ]+?)=(\d+)/g)) {
          const key = (f[1] ?? '').trim();
          const n = Number(f[2]);
          if (key === 'failures') counts.failures = n;
          else if (key === 'errors') counts.errors = n;
          else if (key === 'skipped') counts.skipped = n;
          else if (key === 'expected failures') counts.expectedFailures = n;
          else if (key === 'unexpected successes') counts.unexpectedSuccesses = n;
        }
        break;
      }
      continue;
    }
    if (RULE_EQ.test(line)) {
      phase = 'sections';
      current = null;
      continue;
    }
    if (phase === 'sections') {
      const header = SECTION_HEADER.exec(line);
      if (header !== null) {
        const label = unittestLabelOf(header[2] ?? '', header[3] ?? '');
        current = { lines: [], inBody: false };
        if (!sections.has(label)) sections.set(label, current.lines);
        const status = header[1] === 'ERROR' ? 'ERROR' : 'FAIL';
        const known = statuses.get(label);
        if (known === undefined || known === 'ok' || known === 'skipped') statuses.set(label, status);
        continue;
      }
      if (RULE_DASH.test(line)) {
        if (current !== null && !current.inBody) current.inBody = true;
        else current = null;
        continue;
      }
      if (current !== null && current.inBody) current.lines.push(line);
      continue;
    }
    const suffix = STATUS_SUFFIX.exec(line);
    const test = TEST_LINE.exec(line);
    if (test !== null) {
      const label = unittestLabelOf(test[1] ?? '', test[2] ?? '');
      if (suffix !== null) {
        statuses.set(label, normaliseStatus(suffix[1] ?? ''));
        pending = null;
      } else {
        pending = label;
      }
      continue;
    }
    if (pending !== null) {
      if (suffix !== null) {
        statuses.set(pending, normaliseStatus(suffix[1] ?? ''));
        pending = null;
      } else {
        const bare = BARE_STATUS.exec(line.trim());
        if (bare !== null) {
          statuses.set(pending, normaliseStatus(bare[1] ?? ''));
          pending = null;
        }
      }
    }
  }
  return { counts, statuses, sections };
}

/** True when the output is unittest-shaped at all (a `Ran N tests` line or any status line). */
export function looksLikeUnittest(parse: UnittestParse): boolean {
  return parse.counts.found || parse.statuses.size > 0;
}

/**
 * Counting rules: expected failures are skipped (the suite says they must fail), unexpected
 * successes are failed (unittest exits 1 on them). `failing` = FAIL + ERROR + unexpected-success
 * labels, `passing` = ok labels (empty at verbosity 1: the counts still carry the numbers).
 */
export function summaryFromUnittest(parse: UnittestParse, ctx: RunnerSummaryContext): TestRunSummary {
  const failing: string[] = [];
  const passing: string[] = [];
  const failures: FailureView[] = [];
  for (const [id, status] of parse.statuses) {
    if (status === 'FAIL' || status === 'ERROR' || status === 'unexpected success') {
      failing.push(id);
      const section = parse.sections.get(id) ?? [];
      const ex = status === 'unexpected success' ? { expected: 'the test fails (marked expectedFailure)', actual: 'unexpected success' } : expectationFromTraceback(section);
      const actual = ex.actual !== '' ? ex.actual : status === 'ERROR' ? 'error: no details in the output' : 'failed: no details in the output';
      failures.push({ testId: id, call: id, expected: ex.expected, actual });
    } else if (status === 'ok') {
      passing.push(id);
    }
  }
  const c = parse.counts;
  const byStatus = (pred: (s: UnittestStatus) => boolean): number => [...parse.statuses.values()].filter(pred).length;
  const failed = c.found ? c.failures + c.unexpectedSuccesses : byStatus((s) => s === 'FAIL' || s === 'unexpected success');
  const errors = c.found ? c.errors : byStatus((s) => s === 'ERROR');
  const skipped = c.found ? c.skipped + c.expectedFailures : byStatus((s) => s === 'skipped' || s === 'expected failure');
  const passed = c.found ? Math.max(0, c.ran - failed - errors - skipped) : passing.length;
  return { ...emptySummary(ctx), passed, failed, errors, skipped, total: passed + failed + errors + skipped, failing, passing, failures };
}

// ---------------------------------------------------------------------------------------
// sympy bin/test
// ---------------------------------------------------------------------------------------

export type SympyStatus = 'ok' | 'F' | 'E' | 's' | 'f' | 'X';

export interface SympyCounts {
  passed: number;
  failed: number;
  skipped: number;
  xfailed: number;
  xpassed: number;
  exceptions: number;
  /** a `tests finished:` line was found */
  found: boolean;
}

export interface SympyParse {
  counts: SympyCounts;
  /** `path.py:test_name` (the runner's own failure-header form) → status; a file that failed to import is keyed by its path */
  statuses: Map<string, SympyStatus>;
  /** id → traceback lines of its failure / exception section */
  sections: Map<string, string[]>;
  /** the `test process starts` banner was seen */
  started: boolean;
  /** status characters of quiet (non-verbose) runs, which carry no test names */
  anonymous: { passed: number; failed: number; errors: number; skipped: number };
}

const SYMPY_FILE_LINE = /^(\S+\.py)\[(\d+|\?)\]\s*(.*)$/;
const SYMPY_VERBOSE_LINE = /^(test\w*)\s+(?:.*?\s+)?(ok|F|E|s|w|T|K|f|X)\s*(?:\[(?:OK|FAIL)\])?\s*$/;
const SYMPY_STATUS_CHARS = /^([.FEswTKfX]+)\s*(?:\[(?:OK|FAIL)\])?\s*$/;
const SYMPY_SECTION_HEADER = /^_+ (\S+\.py)(?::(\w+))? _+$/;
const SYMPY_RULE = /^_{10,}$/;
const SYMPY_ITEM = /(\d+) (passed|failed|skipped|expected to fail but passed|expected to fail|exceptions)/g;

function sympyStatus(ch: string): SympyStatus {
  if (ch === 'ok') return 'ok';
  if (ch === 'F' || ch === 'E' || ch === 'f' || ch === 'X') return ch;
  return 's'; // s, w (slow), T (timeout), K (interrupt)
}

function countAnonymous(a: SympyParse['anonymous'], ch: string): void {
  if (ch === '.' || ch === 'X') a.passed += 1;
  else if (ch === 'F') a.failed += 1;
  else if (ch === 'E') a.errors += 1;
  else a.skipped += 1;
}

/**
 * Pure and total. Progress: `path.py[N]` then either status characters (`....F..E  [FAIL]`,
 * wrapping onto bare lines at the terminal width) or, with --verbose, one `test_x ok|F|E|s|f|X`
 * line per test (a skip prints its reason before the letter: `test_x Slow w`). Sections after a
 * rule of `_`: `____ path.py:test_x ____` (or `____ path.py ____` for an import error) then the
 * traceback. Summary: `tests finished: 4 passed, 1 failed, 1 exceptions, in 1.23 seconds`, wrapped
 * at the terminal width. ANSI colours are stripped first (`-C` is not assumed).
 */
export function parseSympyOutput(output: string): SympyParse {
  const clean = stripAnsi(output);
  const lines = clean.split(/\r?\n/);
  const statuses = new Map<string, SympyStatus>();
  const sections = new Map<string, string[]>();
  const anonymous = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  const counts: SympyCounts = { passed: 0, failed: 0, skipped: 0, xfailed: 0, xpassed: 0, exceptions: 0, found: false };
  const started = clean.includes('test process starts');
  let currentFile: string | null = null;
  let phase: 'progress' | 'sections' | 'done' = 'progress';
  let current: string[] | null = null;
  for (let k = 0; k < lines.length; k++) {
    const line = (lines[k] ?? '').trimEnd();
    if (line.includes('tests finished:')) {
      const rest = lines.slice(k).join('\n');
      const at = rest.indexOf('tests finished:');
      const end = rest.indexOf('seconds', at);
      const summary = (end === -1 ? rest.slice(at) : rest.slice(at, end)).replace(/[=\n]/g, ' ');
      for (const m of summary.matchAll(SYMPY_ITEM)) {
        const n = Number(m[1]);
        counts.found = true;
        switch (m[2]) {
          case 'passed':
            counts.passed = n;
            break;
          case 'failed':
            counts.failed += n; // failed tests and failed doctests are two items of the same name
            break;
          case 'skipped':
            counts.skipped = n;
            break;
          case 'expected to fail':
            counts.xfailed = n;
            break;
          case 'expected to fail but passed':
            counts.xpassed = n;
            break;
          case 'exceptions':
            counts.exceptions = n;
            break;
          default:
            break;
        }
      }
      phase = 'done';
      current = null;
      continue;
    }
    if (phase === 'done') continue;
    if (SYMPY_RULE.test(line)) {
      phase = 'sections';
      current = null;
      continue;
    }
    if (phase === 'sections') {
      const header = SYMPY_SECTION_HEADER.exec(line);
      if (header !== null) {
        const file = header[1] ?? '';
        const name = header[2];
        const id = name === undefined ? file : `${file}:${name}`;
        current = [];
        if (!sections.has(id)) sections.set(id, current);
        // the header does not say F or E; --verbose lines already did, else an import error is an E and a test an F
        if (!statuses.has(id)) statuses.set(id, name === undefined ? 'E' : 'F');
        continue;
      }
      if (line.startsWith('DO *NOT* COMMIT')) continue;
      if (current !== null) current.push(line);
      continue;
    }
    const f = SYMPY_FILE_LINE.exec(line);
    if (f !== null) {
      currentFile = f[1] ?? null;
      const rest = (f[3] ?? '').replace(/\s*\[(?:OK|FAIL)\]\s*$/, '').trim();
      if (f[2] === '?' || /Failed to import/.test(rest)) {
        if (currentFile !== null) statuses.set(currentFile, 'E');
      } else if (rest !== '' && /^[.FEswTKfX]+$/.test(rest)) {
        for (const ch of rest) countAnonymous(anonymous, ch);
      }
      continue;
    }
    if (currentFile === null) continue;
    const v = SYMPY_VERBOSE_LINE.exec(line);
    if (v !== null) {
      statuses.set(`${currentFile}:${v[1] ?? ''}`, sympyStatus(v[2] ?? ''));
      continue;
    }
    const c = started ? SYMPY_STATUS_CHARS.exec(line) : null;
    if (c !== null) for (const ch of c[1] ?? '') countAnonymous(anonymous, ch);
  }
  return { counts, statuses, sections, started, anonymous };
}

/** True when the output is sympy-runner-shaped at all (the banner, a summary line or any status). */
export function looksLikeSympy(parse: SympyParse): boolean {
  return parse.started || parse.counts.found || parse.statuses.size > 0;
}

/**
 * Counting rules mirror pytest's: an expected failure is skipped, an unexpected pass is passed,
 * an exception is an error. `failing` = F + E ids (+ import-error files), `passing` = ok + X ids
 * (empty without --verbose: the counts still carry the numbers).
 */
export function summaryFromSympy(parse: SympyParse, ctx: RunnerSummaryContext): TestRunSummary {
  const failing: string[] = [];
  const passing: string[] = [];
  const failures: FailureView[] = [];
  for (const [id, status] of parse.statuses) {
    if (status === 'F' || status === 'E') {
      failing.push(id);
      const ex = expectationFromTraceback(parse.sections.get(id) ?? []);
      const actual = ex.actual !== '' ? ex.actual : status === 'E' ? 'error: no details in the output' : 'failed: no details in the output';
      failures.push({ testId: id, call: id, expected: ex.expected, actual });
    } else if (status === 'ok' || status === 'X') {
      passing.push(id);
    }
  }
  const c = parse.counts;
  const a = parse.anonymous;
  const byStatus = (pred: (s: SympyStatus) => boolean): number => [...parse.statuses.values()].filter(pred).length;
  const passed = c.found ? c.passed + c.xpassed : passing.length + a.passed;
  const failed = c.found ? c.failed : byStatus((s) => s === 'F') + a.failed;
  const errors = c.found ? c.exceptions : byStatus((s) => s === 'E') + a.errors;
  const skipped = c.found ? c.skipped + c.xfailed : byStatus((s) => s === 's' || s === 'f') + a.skipped;
  return { ...emptySummary(ctx), passed, failed, errors, skipped, total: passed + failed + errors + skipped, failing, passing, failures };
}

// ---------------------------------------------------------------------------------------
// Test files related to a module (code only)
// ---------------------------------------------------------------------------------------

export const RELATED_TESTS_MAX = 6;

export interface RelatedTestsOptions {
  /** at most this many files (default RELATED_TESTS_MAX) */
  max?: number;
  /** test-file contents for the import check (`from pkg.mod import …`); path-based scoring only when absent */
  contents?: (path: string) => string | null | undefined;
}

const NOT_A_TEST_FILE = new Set(['__init__.py', 'conftest.py', 'runtests.py', 'setup.py', 'urls.py', 'models.py', 'views.py']);
const TEST_DIR = /(^|\/)(tests?|testing)\//;
const TEST_BASENAME = /^test_[^/]*\.py$|_tests?\.py$|^tests\.py$/;

/** A runnable test module: under tests/ (Django's `tests/<app>/tests.py`), or named test_*.py / *_test(s).py; never __init__, conftest, runtests. */
export function isTestFile(path: string): boolean {
  if (!path.endsWith('.py')) return false;
  const base = path.split('/').pop() ?? '';
  if (NOT_A_TEST_FILE.has(base)) return false;
  return TEST_DIR.test(path) || TEST_BASENAME.test(base);
}

const IMPORT_LINE = /^\s*(?:from|import)\s+[^\n]*/gm;

interface ModuleParts {
  /** the module's basename (`decorators`; a package's directory name for `__init__.py`) */
  name: string;
  /** its directory (`django/utils`), '' at the root */
  pkgDir: string;
  /** the first path segment (`django`, `requests`), '' at the root */
  topPkg: string;
  /** dotted import paths that name the module: `django.utils.decorators`, `utils.decorators` (every suffix of ≥ 2 segments, so a `src/` layout still matches) */
  dotted: string[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function moduleParts(modulePath: string): ModuleParts | null {
  const p = modulePath.replace(/^\.\//, '');
  if (!p.endsWith('.py')) return null;
  const segs = p.split('/');
  let name = (segs.pop() ?? '').slice(0, -3);
  if (name === '__init__') name = segs.pop() ?? '';
  if (name === '') return null;
  const dotted: string[] = [];
  for (let k = 0; k < segs.length; k++) dotted.push([...segs.slice(k), name].join('.'));
  return { name, pkgDir: segs.join('/'), topPkg: segs[0] ?? '', dotted };
}

/**
 * +8 the test file is named after the module (`test_decorators.py`, `decorators_test.py`);
 * +7 a directory on its path is (Django's `tests/decorators/tests.py`); +2 its name merely contains
 * the module's; +6 an import line names the module's dotted path (`django.utils.decorators`,
 * `utils.decorators`), +2 when it only names the bare module (`django.contrib.auth.decorators`
 * is a different module); +3 it lives under the module's own directory (`sympy/utilities/tests/`);
 * +1 its name carries the top package (`test_requests.py` for `requests/models.py`).
 */
function scoreAgainst(testPath: string, mod: ModuleParts, content: string | null): number {
  const segs = testPath.split('/');
  const base = (segs.pop() ?? '').slice(0, -3);
  const word = new RegExp(`\\b${escapeRe(mod.name)}\\b`);
  let score = 0;
  if (base === `test_${mod.name}` || base === `${mod.name}_test` || base === `${mod.name}_tests` || base === `test${mod.name}` || base === mod.name) score += 8;
  else if (segs.includes(mod.name)) score += 7;
  else if (word.test(base.replace(/_/g, ' '))) score += 2;
  if (content !== null) {
    const dottedRe = mod.dotted.length === 0 ? null : new RegExp(`(^|[\\s.])(?:${mod.dotted.map(escapeRe).join('|')})\\b`);
    let imported = 0;
    for (const m of content.matchAll(IMPORT_LINE)) {
      const line = m[0];
      if (dottedRe !== null && dottedRe.test(line)) {
        imported = 6;
        break;
      }
      if (word.test(line)) imported = Math.max(imported, 2);
    }
    score += imported;
  }
  if (mod.pkgDir !== '' && testPath.startsWith(`${mod.pkgDir}/`)) score += 3;
  if (mod.topPkg !== '' && mod.topPkg !== mod.name && new RegExp(`\\b${escapeRe(mod.topPkg)}\\b`).test(base.replace(/_/g, ' '))) score += 1;
  return score;
}

/**
 * Test files that name or import the modules (bounded, ranked): `test_<name>.py` / a directory
 * named after the module (Django's `tests/decorators/tests.py`) first, then files whose import
 * lines mention the module (when `contents` is given), then the package's own tests dir
 * (`sympy/utilities/tests/*` for `sympy/utilities/lambdify.py`), then files naming the top
 * package (`test_requests.py` for `requests/models.py`). Ties break on the shorter, then
 * alphabetical, path. Never asks Jev.
 */
export function relatedTestFiles(workspaceFiles: readonly (string | { path: string })[], moduleFiles: readonly string[], opts: RelatedTestsOptions = {}): string[] {
  const max = opts.max ?? RELATED_TESTS_MAX;
  const mods = moduleFiles.map(moduleParts).filter((m): m is NonNullable<typeof m> => m !== null);
  if (mods.length === 0 || max <= 0) return [];
  const paths = [...new Set(workspaceFiles.map((f) => (typeof f === 'string' ? f : f.path)).map((p) => p.replace(/^\.\//, '')))].filter(isTestFile);
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    if (moduleFiles.includes(path)) continue;
    const content = opts.contents === undefined ? null : (opts.contents(path) ?? null);
    let best = 0;
    for (const mod of mods) best = Math.max(best, scoreAgainst(path, mod, content));
    if (best > 0) scored.push({ path, score: best });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return scored.slice(0, max).map((s) => s.path);
}
