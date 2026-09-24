/**
 * Port of the official SWE-bench log parsers and grading rules
 * (swebench/harness/log_parsers/python.py and swebench/harness/grading.py at
 * SWE-bench/SWE-bench main, fetched 2026-09-19; DESIGN.md §13 steps g-h). Kept line-for-line
 * close to the Python so local verdicts match the harness on the same test_output.txt.
 */
import type { TestsStatus } from '../types.js';

export type TestStatus = 'FAILED' | 'PASSED' | 'SKIPPED' | 'ERROR' | 'XFAIL';
export const TEST_STATUSES: readonly TestStatus[] = ['FAILED', 'PASSED', 'SKIPPED', 'ERROR', 'XFAIL'];

export type StatusMap = Record<string, TestStatus>;
export type LogParserName = 'parse_log_pytest' | 'parse_log_pytest_options' | 'parse_log_django' | 'parse_log_sympy' | 'parse_log_pylint' | 'parse_log_requests';
export type LogParser = (log: string) => StatusMap;

// Markers written by eval.sh (swebench/harness/constants/__init__.py).
export const APPLY_PATCH_FAIL = '>>>>> Patch Apply Failed';
export const APPLY_PATCH_PASS = '>>>>> Applied Patch';
export const RESET_FAILED = '>>>>> Reset Failed';
export const TESTS_ERROR = '>>>>> Tests Errored';
export const TESTS_TIMEOUT = '>>>>> Tests Timed Out';
export const START_TEST_OUTPUT = '>>>>> Start Test Output';
export const END_TEST_OUTPUT = '>>>>> End Test Output';
export const TEST_EXIT_CODE = '>>>>> Test Exit Code';

/** Python str.split(): split on runs of whitespace, no empty fields. */
function pySplit(s: string): string[] {
  const t = s.trim();
  return t === '' ? [] : t.split(/\s+/);
}

function startsWithStatus(line: string): boolean {
  return TEST_STATUSES.some((s) => line.startsWith(s));
}

const SKIP_SUMMARY_COUNT = /^\[\d+\]$/;
/** pytest's `SKIPPED [N] path:line: reason` summary line, where [N] is not a test id. */
function isSkipSummary(status: string, name: string): boolean {
  return status === 'SKIPPED' && SKIP_SUMMARY_COUNT.test(name);
}

export function parseLogPytest(log: string): StatusMap {
  const map: StatusMap = {};
  for (let line of log.split('\n')) {
    if (!startsWithStatus(line)) continue;
    if (line.startsWith('FAILED')) line = line.split(' - ').join(' ');
    const parts = pySplit(line);
    if (parts.length <= 1) continue;
    const status = parts[0] as TestStatus;
    const name = parts[1]!;
    if (isSkipSummary(status, name)) continue;
    map[name] = status;
  }
  return map;
}

const OPTION_PATTERN = /(.*?)\[(.*)\]/;
/** pytest ids whose parameter is a path are reduced to `[/basename]` (pylint, requests, pydicom). */
export function parseLogPytestOptions(log: string): StatusMap {
  const map: StatusMap = {};
  for (let line of log.split('\n')) {
    if (!startsWithStatus(line)) continue;
    if (line.startsWith('FAILED')) line = line.split(' - ').join(' ');
    const parts = pySplit(line);
    if (parts.length <= 1) continue;
    const status = parts[0] as TestStatus;
    const raw = parts[1]!;
    if (isSkipSummary(status, raw)) continue;
    const m = OPTION_PATTERN.exec(raw);
    let name = raw;
    if (m) {
      const main = m[1]!;
      let option = m[2]!;
      if (option.startsWith('/') && !option.startsWith('//') && !option.includes('*')) {
        option = `/${option.split('/').at(-1)!}`;
      }
      name = `${main}[${option}]`;
    }
    map[name] = status;
  }
  return map;
}

const DJANGO_MULTILINE_PATTERNS: RegExp[] = [
  /^(.*?)\s\.\.\.\sTesting against Django installed in ([\s\S]*?) silenced\)\.\nok$/gm,
  /^(.*?)\s\.\.\.\sInternal Server Error: \/(.*)\/\nok$/gm,
  /^(.*?)\s\.\.\.\sSystem check identified no issues \(0 silenced\)\nok$/gm,
];

export function parseLogDjango(log: string): StatusMap {
  const map: StatusMap = {};
  let prevTest: string | null = null;
  for (const rawLine of log.split('\n')) {
    let line = rawLine.trim();
    if (line.includes('--version is equivalent to version')) map['--version is equivalent to version'] = 'PASSED';
    if (line.includes(' ... ')) prevTest = line.split(' ... ')[0]!;
    for (const suffix of [' ... ok', ' ... OK', ' ...  OK']) {
      if (line.endsWith(suffix)) {
        // upstream's exclusive fix for django__django-7188 (migration output glued to the test line)
        if (line.startsWith('Applying sites.0002_alter_domain_unique...test_no_migrations')) {
          line = line.split('...').slice(1).join('...').trim();
        }
        const idx = line.lastIndexOf(suffix);
        map[line.slice(0, idx)] = 'PASSED';
        break;
      }
    }
    if (line.includes(' ... skipped')) map[line.split(' ... skipped')[0]!] = 'SKIPPED';
    if (line.endsWith(' ... FAIL')) map[line.split(' ... FAIL')[0]!] = 'FAILED';
    if (line.startsWith('FAIL:')) {
      const t = pySplit(line)[1];
      if (t !== undefined) map[t] = 'FAILED';
    }
    if (line.endsWith(' ... ERROR')) map[line.split(' ... ERROR')[0]!] = 'ERROR';
    if (line.startsWith('ERROR:')) {
      const t = pySplit(line)[1];
      if (t !== undefined) map[t] = 'ERROR';
    }
    if (line.startsWith('ok') && prevTest !== null) map[prevTest] = 'PASSED';
  }
  for (const pattern of DJANGO_MULTILINE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of log.matchAll(pattern)) map[m[1]!] = 'PASSED';
  }
  return map;
}

const SYMPY_FAIL_HEADER = /(_*) (.*)\.py:(.*) (_*)/g;
export function parseLogSympy(log: string): StatusMap {
  const map: StatusMap = {};
  SYMPY_FAIL_HEADER.lastIndex = 0;
  for (const m of log.matchAll(SYMPY_FAIL_HEADER)) map[`${m[2]!}.py:${m[3]!}`] = 'FAILED';
  for (const raw of log.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('test_')) continue;
    const name = pySplit(line)[0]!;
    if (line.endsWith(' E')) map[name] = 'ERROR';
    if (line.endsWith(' F')) map[name] = 'FAILED';
    if (line.endsWith(' ok')) map[name] = 'PASSED';
  }
  return map;
}

const PARSERS: Record<LogParserName, LogParser> = {
  parse_log_pytest: parseLogPytest,
  parse_log_pytest_options: parseLogPytestOptions,
  parse_log_django: parseLogDjango,
  parse_log_sympy: parseLogSympy,
  parse_log_pylint: parseLogPytestOptions,
  parse_log_requests: parseLogPytestOptions,
};

const REPO_PARSER: Record<string, LogParserName> = {
  'django/django': 'parse_log_django',
  'sympy/sympy': 'parse_log_sympy',
  'pytest-dev/pytest': 'parse_log_pytest',
  'pylint-dev/pylint': 'parse_log_pylint',
  'psf/requests': 'parse_log_requests',
};

export function isLogParserName(s: string): s is LogParserName {
  return Object.hasOwn(PARSERS, s);
}

/** Parser by the record's `log_parser`, falling back to the repo map; null when neither is known. */
export function selectParser(logParser: string | undefined, repo: string): LogParser | null {
  if (logParser !== undefined && isLogParserName(logParser)) return PARSERS[logParser];
  const byRepo = REPO_PARSER[repo];
  return byRepo === undefined ? null : PARSERS[byRepo];
}

// ---------------------------------------------------------------------------------------
// Grading (grading.py)
// ---------------------------------------------------------------------------------------

const PASSING: ReadonlySet<string> = new Set<TestStatus>(['PASSED', 'XFAIL']);

/** Exact key, or a prefix match for ids truncated mid-parameter (`[` outnumbers `]`) when all candidates agree. */
export function resolveCase(testCase: string, sm: StatusMap): string | null {
  if (Object.hasOwn(sm, testCase)) return testCase;
  const opens = testCase.split('[').length - 1;
  const closes = testCase.split(']').length - 1;
  if (opens > closes) {
    const matches = Object.keys(sm).filter((k) => k.startsWith(testCase));
    if (matches.length > 0) {
      const outcomes = new Set(matches.map((k) => PASSING.has(sm[k]!)));
      if (outcomes.size === 1) return matches[0]!;
    }
  }
  return null;
}

export function testPassed(testCase: string, sm: StatusMap): boolean {
  const key = resolveCase(testCase, sm);
  return key !== null && PASSING.has(sm[key]!);
}

/** P2P semantics: a skipped test is not a regression. */
export function testMaintained(testCase: string, sm: StatusMap): boolean {
  const key = resolveCase(testCase, sm);
  return testPassed(testCase, sm) || (key !== null && sm[key] === 'SKIPPED');
}

/** Missing ids count as failed; a skipped F2P test is not a resolution. */
export function testFailed(testCase: string, sm: StatusMap): boolean {
  const key = resolveCase(testCase, sm);
  return key === null || sm[key] === 'FAILED' || sm[key] === 'ERROR' || sm[key] === 'SKIPPED';
}

export interface GradeInput {
  failToPass: readonly string[];
  passToPass: readonly string[];
}

export interface TestsReport {
  testsStatus: TestsStatus;
  /** FULL rule: every F2P passed and every P2P maintained */
  resolved: boolean;
}

export function buildTestsReport(sm: StatusMap, input: GradeInput): TestsReport {
  const f2p = { success: [] as string[], failure: [] as string[] };
  const p2p = { success: [] as string[], failure: [] as string[] };
  for (const t of input.failToPass) {
    if (testPassed(t, sm)) f2p.success.push(t);
    else if (testFailed(t, sm)) f2p.failure.push(t);
  }
  for (const t of input.passToPass) {
    if (testMaintained(t, sm)) p2p.success.push(t);
    else if (testFailed(t, sm)) p2p.failure.push(t);
  }
  const resolved = f2p.failure.length === 0 && p2p.failure.length === 0 && f2p.success.length === input.failToPass.length;
  return { testsStatus: { FAIL_TO_PASS: f2p, PASS_TO_PASS: p2p }, resolved };
}

const SUITE_RAN =
  /Executed [1-9]\d* of \d+|TOTAL: [1-9]\d* (?:SUCCESS|FAILED)|[1-9]\d* passing|Tests:\s+[1-9]\d*|Test Suites:\s+(?:\d+ \w+, )*[1-9]\d* total|^# tests [1-9]\d*|[1-9]\d* specs?, \d+ failures?|': ok$/m;

const TEST_EXIT_CODE_RE = new RegExp(`${TEST_EXIT_CODE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(-?\\d+)`);

export function parseTestExitCode(content: string): number | null {
  const m = TEST_EXIT_CODE_RE.exec(content);
  return m ? Number(m[1]) : null;
}

export type LogEval =
  | { valid: true; statusMap: StatusMap; exitCode: number | null }
  | { valid: false; reason: string; exitCode: number | null };

/**
 * get_logs_eval: marker checks, parse between the output markers (whole log as fallback),
 * "never ran" detection and the exit-code anti-spoofing rule (#620).
 */
export function evaluateLog(content: string, parser: LogParser): LogEval {
  const exitCode = parseTestExitCode(content);
  const bad = [APPLY_PATCH_FAIL, RESET_FAILED, TESTS_ERROR, TESTS_TIMEOUT].filter((m) => content.includes(m));
  if (bad.length > 0) return { valid: false, reason: `marker: ${bad.join(', ')}`, exitCode };
  if (!(content.includes(START_TEST_OUTPUT) && content.includes(END_TEST_OUTPUT))) {
    return { valid: false, reason: 'test output markers missing', exitCode };
  }
  const sliced = content.split(START_TEST_OUTPUT)[1]!.split(END_TEST_OUTPUT)[0]!;
  let statusMap = parser(sliced);
  if (Object.keys(statusMap).length === 0) statusMap = parser(content);
  if (Object.keys(statusMap).length === 0 && !SUITE_RAN.test(content)) {
    return { valid: false, reason: 'no test results and no sign the suite ran', exitCode };
  }
  const anyFailure = Object.values(statusMap).some((s) => s === 'FAILED' || s === 'ERROR');
  if (exitCode !== null && exitCode !== 0 && Object.keys(statusMap).length > 0 && !anyFailure) {
    return { valid: false, reason: `test command exited ${exitCode} but the log reports no failure`, exitCode };
  }
  return { valid: true, statusMap, exitCode };
}

export type Grade =
  | { valid: true; resolved: boolean; testsStatus: TestsStatus; exitCode: number | null; statusMap: StatusMap }
  | { valid: false; reason: string; exitCode: number | null };

/** Full pipeline for one test_output.txt: markers, parse, FULL rule. */
export function gradeLog(content: string, parser: LogParser, input: GradeInput): Grade {
  const ev = evaluateLog(content, parser);
  if (!ev.valid) return ev;
  const report = buildTestsReport(ev.statusMap, input);
  return { valid: true, resolved: report.resolved, testsStatus: report.testsStatus, exitCode: ev.exitCode, statusMap: ev.statusMap };
}
