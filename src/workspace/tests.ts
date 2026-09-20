/**
 * Test-command detection from the repository's own files and summary-line parsing (DESIGN.md §8).
 * Parsing is code, never a Jev question: the judge state carries the counts. Summaries are
 * read from the tail because a capped output keeps its last 16 KB.
 *
 * Detection order (first match wins; repository shapes only, never benchmark names):
 *   1. a pytest configuration: pytest.ini, pyproject [tool.pytest], setup.cfg [tool:pytest],
 *      tox.ini [pytest]                                        → `python -m pytest -q`
 *   2. a top-level tests/runtests.py (a Django-style suite; `python -m pytest` exits 1 at once
 *      in such a checkout because nothing there is a pytest module) → `python tests/runtests.py --parallel 1`
 *   3. bin/test with a python shebang (a sympy-style runner)     → `python bin/test`
 *   4. a pytest layout without configuration: conftest.py at the root, test_*.py / *_test.py at
 *      the root or under tests/ or test/                         → `python -m pytest -q`
 *   5. a tests/ or test/ package (__init__.py, no pytest files)   → `python -m unittest discover -v`
 *   6. setup.py declaring a test_suite                            → `python setup.py test`
 *   7. package.json scripts.test, Cargo.toml, go.mod (unchanged)
 * `python` is the interpreter when the workspace has .venv/bin/python (the sandbox puts .venv/bin
 * on PATH, src/sandbox/run.ts), `python3` otherwise. A `.jevcode-spec.json` at the root, written
 * by a bench loader with the harness's own `test_cmd`, confirms the runner: when its command names
 * a runner whose entry point exists in the tree, that runner wins over the file order. Detection
 * works without it.
 */
import type { TestCommand, TestCounts, TestRunner } from '../core/types.js';

export interface ManifestReader {
  /** relative path -> text (bounded) or null when missing / unreadable / not allowed */
  read(relPath: string): Promise<string | null>;
  /** relative directory listing (names only) or null */
  list(relPath: string): Promise<string[] | null>;
}

/** Written by bench loaders beside the checkout (git-excluded); `{ "test_cmd": "<the harness's test command>" }`. */
export const SPEC_FILE = '.jevcode-spec.json';

export type PythonInterpreter = 'python' | 'python3';
export type ScopeBuilder = (targets: readonly string[]) => string;

const NPM_PLACEHOLDER = /no test specified/;
const PYTHON_SHEBANG = /^#![^\n]*\bpython[0-9.]*\b/;
const TEST_FILE_NAME = /^test_.*\.py$|_tests?\.py$/;

function runnerFromScript(script: string): TestRunner {
  if (/\bvitest\b/.test(script)) return 'vitest';
  if (/\bjest\b/.test(script)) return 'jest';
  if (/\bpytest\b/.test(script)) return 'pytest';
  if (/\bcargo\s+test\b/.test(script)) return 'cargo';
  if (/\bgo\s+test\b/.test(script)) return 'go';
  return 'npm';
}

// ---------------------------------------------------------------------------------------
// Repository shapes
// ---------------------------------------------------------------------------------------

/** `python` when the workspace carries its own venv (on PATH inside the sandbox), else `python3`. */
export async function pythonInterpreter(r: ManifestReader): Promise<PythonInterpreter> {
  const bin = await r.list('.venv/bin');
  return bin !== null && bin.includes('python') ? 'python' : 'python3';
}

async function hasPytestConfig(r: ManifestReader): Promise<boolean> {
  if ((await r.read('pytest.ini')) !== null) return true;
  const pyproject = await r.read('pyproject.toml');
  if (pyproject !== null && /^\s*\[tool\.pytest(\.ini_options)?\]/m.test(pyproject)) return true;
  const setupCfg = await r.read('setup.cfg');
  if (setupCfg !== null && /^\s*\[tool:pytest\]/m.test(setupCfg)) return true;
  const tox = await r.read('tox.ini');
  if (tox !== null && /^\s*\[pytest\]/m.test(tox)) return true;
  return false;
}

async function hasDjangoRuntests(r: ManifestReader): Promise<boolean> {
  return (await r.read('tests/runtests.py')) !== null;
}

async function hasSympyBinTest(r: ManifestReader): Promise<boolean> {
  const text = await r.read('bin/test');
  return text !== null && PYTHON_SHEBANG.test(text);
}

async function hasPytestLayout(r: ManifestReader): Promise<boolean> {
  if ((await r.read('conftest.py')) !== null) return true;
  const root = await r.list('.');
  if (root !== null && root.some((n) => TEST_FILE_NAME.test(n))) return true;
  for (const dir of ['tests', 'test']) {
    const names = await r.list(dir);
    if (names !== null && names.some((n) => TEST_FILE_NAME.test(n) || n === 'conftest.py')) return true;
  }
  return false;
}

async function hasUnittestPackage(r: ManifestReader): Promise<boolean> {
  for (const dir of ['tests', 'test']) if ((await r.read(`${dir}/__init__.py`)) !== null) return true;
  return false;
}

async function hasSetupPyTestSuite(r: ManifestReader): Promise<boolean> {
  const setup = await r.read('setup.py');
  return setup !== null && /\btest_suite\s*=/.test(setup);
}

// ---------------------------------------------------------------------------------------
// Commands per runner
// ---------------------------------------------------------------------------------------

export function pytestCommand(py: PythonInterpreter): string {
  return `${py} -m pytest -q`;
}
export function djangoCommand(py: PythonInterpreter): string {
  return `${py} tests/runtests.py --parallel 1`;
}
export function sympyCommand(py: PythonInterpreter): string {
  return `${py} bin/test`;
}
export function unittestCommand(py: PythonInterpreter): string {
  return `${py} -m unittest discover -v`;
}

function withScope(command: string, runner: TestRunner): TestCommand {
  const scope = scopeBuilderFor(runner, command);
  return scope === null ? { command, runner } : { command, runner, scope };
}

/**
 * The runner a shell test command names (env assignments and the interpreter skipped):
 * `./tests/runtests.py …` / `python tests/runtests.py` → django, `bin/test …` → sympy_bintest,
 * `pytest` / `py.test` / `python -m pytest` → pytest, `python -m unittest` / `python setup.py test`
 * → unittest; null for anything else.
 */
export function runnerFromCommand(command: string): TestRunner | null {
  const toks = command
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  const base = (t: string | undefined): string => (t ?? '').replace(/^['"]|['"]$/g, '').split('/').pop() ?? '';
  let i = 0;
  if (/^python[0-9.]*$/.test(base(toks[0]))) {
    i = 1;
    if (toks[1] === '-m') {
      const mod = toks[2] ?? '';
      if (mod === 'pytest') return 'pytest';
      if (mod === 'unittest') return 'unittest';
      return null;
    }
  }
  const script = (toks[i] ?? '').replace(/^['"]|['"]$/g, '');
  const name = base(script);
  if (name === 'runtests.py') return 'django';
  if (name === 'test' && /(^|\/)bin\/test$/.test(script)) return 'sympy_bintest';
  if (name === 'pytest' || name === 'py.test') return 'pytest';
  if (name === 'unittest') return 'unittest';
  if (name === 'setup.py' && toks[i + 1] === 'test') return 'unittest';
  return null;
}

async function readSpecCommand(r: ManifestReader): Promise<string | null> {
  const text = await r.read(SPEC_FILE);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'test_cmd' in parsed) {
      const cmd = (parsed as { test_cmd?: unknown }).test_cmd;
      if (typeof cmd === 'string' && cmd.trim() !== '') return cmd;
    }
  } catch {
    /* malformed spec: detection proceeds from the files alone */
  }
  return null;
}

/** The command for a runner the spec names, provided its entry point exists in the tree. */
async function commandForRunner(r: ManifestReader, runner: TestRunner, py: PythonInterpreter): Promise<TestCommand | null> {
  switch (runner) {
    case 'django':
      return (await hasDjangoRuntests(r)) ? withScope(djangoCommand(py), 'django') : null;
    case 'sympy_bintest':
      return (await r.read('bin/test')) !== null ? withScope(sympyCommand(py), 'sympy_bintest') : null;
    case 'pytest':
      return withScope(pytestCommand(py), 'pytest');
    case 'unittest':
      return withScope(unittestCommand(py), 'unittest');
    default:
      return null;
  }
}

async function detectFromFiles(r: ManifestReader, py: PythonInterpreter): Promise<TestCommand | null> {
  if (await hasPytestConfig(r)) return withScope(pytestCommand(py), 'pytest');
  if (await hasDjangoRuntests(r)) return withScope(djangoCommand(py), 'django');
  if (await hasSympyBinTest(r)) return withScope(sympyCommand(py), 'sympy_bintest');
  if (await hasPytestLayout(r)) return withScope(pytestCommand(py), 'pytest');
  if (await hasUnittestPackage(r)) return withScope(unittestCommand(py), 'unittest');
  if (await hasSetupPyTestSuite(r)) return withScope(`${py} setup.py test`, 'unittest');
  const pkg = await r.read('package.json');
  if (pkg !== null) {
    try {
      const parsed: unknown = JSON.parse(pkg);
      if (typeof parsed === 'object' && parsed !== null && 'scripts' in parsed) {
        const scripts = (parsed as { scripts?: unknown }).scripts;
        if (typeof scripts === 'object' && scripts !== null && 'test' in scripts) {
          const t = (scripts as { test?: unknown }).test;
          if (typeof t === 'string' && t.trim().length > 0 && !NPM_PLACEHOLDER.test(t)) return { command: 'npm test', runner: runnerFromScript(t) };
        }
      }
    } catch {
      /* malformed package.json: fall through */
    }
  }
  if ((await r.read('Cargo.toml')) !== null) return { command: 'cargo test', runner: 'cargo' };
  if ((await r.read('go.mod')) !== null) return { command: 'go test ./...', runner: 'go' };
  return null;
}

/** See the module comment for the order; the spec file only confirms a runner whose entry point exists. */
export async function detectTestCommand(r: ManifestReader): Promise<TestCommand | null> {
  const py = await pythonInterpreter(r);
  const detected = await detectFromFiles(r, py);
  const specCommand = await readSpecCommand(r);
  if (specCommand !== null) {
    const runner = runnerFromCommand(specCommand);
    if (runner !== null && detected?.runner !== runner) {
      const confirmed = await commandForRunner(r, runner, py);
      if (confirmed !== null) return confirmed;
    }
  }
  return detected;
}

// ---------------------------------------------------------------------------------------
// Scoping a command to a subset (test files, node ids, runner labels)
// ---------------------------------------------------------------------------------------

/** POSIX single-quote quoting for `sh -c`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const SAFE_ARG = /^[A-Za-z0-9_.\/:=@%+-]+$/;
function quoteArg(s: string): string {
  return SAFE_ARG.test(s) ? s : shellQuote(s);
}

function uniq(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

function looksLikePath(t: string): boolean {
  return t.includes('/') || t.endsWith('.py');
}

const UNITTEST_ID = /^(\w+) \(([\w.]+)\)$/;

/** `test_x (a.b.C)` → `a.b.C.test_x`; `test_x (a.b.C.test_x)` (Python ≥ 3.11) → `a.b.C.test_x`; null for anything else. */
export function unittestLabel(id: string): string | null {
  const m = UNITTEST_ID.exec(id.trim());
  if (m === null) return null;
  const name = m[1] ?? '';
  const qual = m[2] ?? '';
  return qual.endsWith(`.${name}`) ? qual : `${qual}.${name}`;
}

/** A Python file path as a dotted module: `tests/decorators/tests.py` → `tests.decorators.tests`, `pkg/__init__.py` → `pkg`. */
export function moduleOfPath(path: string): string {
  let p = path.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (p.endsWith('.py')) p = p.slice(0, -3);
  if (p.endsWith('/__init__')) p = p.slice(0, -'/__init__'.length);
  if (p === '__init__') p = '';
  return p
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .join('.');
}

/**
 * A Django `runtests.py` label: a test path relative to the tests dir (`tests/decorators/tests.py`
 * → `decorators.tests`), a pytest node id (`tests/decorators/tests.py::DecoratorsTest::test_attributes`
 * → `decorators.tests.DecoratorsTest.test_attributes`), a unittest id (`test_attributes
 * (decorators.tests.DecoratorsTest)`) or an already dotted label, which passes through.
 */
export function djangoLabel(target: string, testsDir = 'tests'): string {
  const t = target.trim();
  const fromUnittest = unittestLabel(t);
  if (fromUnittest !== null) return fromUnittest;
  const [head = '', ...rest] = t.split('::');
  let base = head;
  if (looksLikePath(base)) {
    let p = base.replace(/^\.\//, '');
    if (p === testsDir || p === `${testsDir}/`) p = '';
    else if (p.startsWith(`${testsDir}/`)) p = p.slice(testsDir.length + 1);
    base = moduleOfPath(p);
  }
  return [base, ...rest].filter((s) => s !== '').join('.');
}

/** A `python -m unittest` label: a module path (`tests/test_x.py` → `tests.test_x`), a node id, a unittest id or a dotted label. */
export function unittestModuleLabel(target: string): string {
  const t = target.trim();
  const fromUnittest = unittestLabel(t);
  if (fromUnittest !== null) return fromUnittest;
  const [head = '', ...rest] = t.split('::');
  const base = looksLikePath(head) ? moduleOfPath(head) : head;
  return [base, ...rest].filter((s) => s !== '').join('.');
}

/** A sympy `bin/test` target: `path.py:test_x` (the runner's own header form) or `path.py::test_x` → path + name; a path; a bare test name. */
export function sympyTarget(target: string): { path: string | null; name: string | null } {
  const t = target.trim();
  const parts = t.split('::');
  if (parts.length > 1) return { path: parts[0] === '' ? null : (parts[0] ?? null), name: parts[parts.length - 1] ?? null };
  const at = t.indexOf('.py:');
  if (at !== -1) return { path: t.slice(0, at + 3), name: t.slice(at + 4) === '' ? null : t.slice(at + 4) };
  return looksLikePath(t) ? { path: t, name: null } : { path: null, name: t === '' ? null : t };
}

/** pytest: file paths and node ids appended as they are. */
export function pytestScope(command: string): ScopeBuilder {
  return (targets) => {
    const args = uniq(targets.map((t) => t.trim()).filter((t) => t !== ''));
    return args.length === 0 ? command : `${command} ${args.map(quoteArg).join(' ')}`;
  };
}

/** Django: dotted labels relative to the tests dir (`decorators.tests`, `decorators.tests.DecoratorsTest.test_attributes`). */
export function djangoScope(command: string): ScopeBuilder {
  return (targets) => {
    const labels = uniq(targets.map((t) => djangoLabel(t)).filter((l) => l !== ''));
    return labels.length === 0 ? command : `${command} ${labels.map(quoteArg).join(' ')}`;
  };
}

/** sympy: test file paths, then `-k <names>` for any test names among the targets (`-k` must come last: it swallows the following arguments). */
export function sympyScope(command: string): ScopeBuilder {
  return (targets) => {
    const paths: string[] = [];
    const names: string[] = [];
    for (const t of targets) {
      const s = sympyTarget(t);
      if (s.path !== null) paths.push(s.path);
      if (s.name !== null) names.push(s.name);
    }
    if (paths.length === 0 && names.length === 0) return command;
    const parts = [command, ...uniq(paths).map(quoteArg)];
    if (names.length > 0) parts.push('-k', ...uniq(names).map(quoteArg));
    return parts.join(' ');
  };
}

/** unittest: `python -m unittest -v <module or dotted labels>` (discovery is replaced by the explicit names). */
export function unittestScope(command: string): ScopeBuilder {
  const py = command.trim().split(/\s+/)[0] ?? 'python3';
  return (targets) => {
    const labels = uniq(targets.map((t) => unittestModuleLabel(t)).filter((l) => l !== ''));
    return labels.length === 0 ? command : `${py} -m unittest -v ${labels.map(quoteArg).join(' ')}`;
  };
}

/** The scope builder for a runner, or null when the runner cannot run a subset by name. */
export function scopeBuilderFor(runner: TestRunner, command: string): ScopeBuilder | null {
  switch (runner) {
    case 'pytest':
      return pytestScope(command);
    case 'django':
      return djangoScope(command);
    case 'sympy_bintest':
      return sympyScope(command);
    case 'unittest':
      return unittestScope(command);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------
// Summary parsers (counts for the judge state)
// ---------------------------------------------------------------------------------------

const TAIL_CHARS = 16 * 1024;

function tail(output: string): string {
  return output.length > TAIL_CHARS ? output.slice(output.length - TAIL_CHARS) : output;
}

function lastMatch(text: string, re: RegExp): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  for (const m of text.matchAll(re)) last = m;
  return last;
}

function num(s: string | undefined): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fallback for `pytest -qq` (e.g. `-q` on the command line on top of `addopts = -q`), which
 * prints no summary line at all: count the progress characters of lines such as
 * `tests/test_a.py ..F.s  [ 71%]` or `.......  [100%]` (`.` pass, `F` fail, `E` error,
 * `s`/`x` skipped or xfail, `X` xpass).
 */
export function parsePytestProgress(text: string): TestCounts | null {
  const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  let seen = false;
  for (const line of text.split('\n')) {
    const pm = /^(?:\S+\s+)?([.FEsxX]+)\s+\[\s*\d+%\]\s*$/.exec(line.trimEnd());
    if (!pm) continue;
    seen = true;
    for (const ch of pm[1]!) {
      if (ch === '.' || ch === 'X') counts.passed += 1;
      else if (ch === 'F') counts.failed += 1;
      else if (ch === 'E') counts.errors += 1;
      else counts.skipped += 1;
    }
  }
  return seen ? counts : null;
}

/** `===== 3 passed, 1 failed, 2 errors, 1 skipped in 0.12s =====` (any subset, any order). */
export function parsePytest(text: string): TestCounts | null {
  const m = lastMatch(text, /^[=\s]*((?:\d+ [a-z]+(?:, )?)+) in \d+(?:\.\d+)?s(?: \([^)]*\))?[=\s]*$/gm);
  if (!m) {
    if (/^[=\s]*no tests ran in \d+(?:\.\d+)?s/m.test(text)) return { passed: 0, failed: 0, errors: 0, skipped: 0 };
    return parsePytestProgress(text);
  }
  const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  let seen = false;
  for (const part of m[1]!.split(', ')) {
    const pm = /^(\d+) ([a-z]+)$/.exec(part.trim());
    if (!pm) continue;
    const n = num(pm[1]);
    switch (pm[2]) {
      case 'passed':
        counts.passed += n;
        seen = true;
        break;
      case 'failed':
        counts.failed += n;
        seen = true;
        break;
      case 'error':
      case 'errors':
        counts.errors += n;
        seen = true;
        break;
      case 'skipped':
      case 'deselected':
        counts.skipped += n;
        seen = true;
        break;
      case 'xfailed':
        counts.skipped += n;
        seen = true;
        break;
      case 'xpassed':
        counts.passed += n;
        seen = true;
        break;
      default:
        break; // warnings, rerun, etc.
    }
  }
  return seen ? counts : null;
}

const UNITTEST_RAN = /^Ran (\d+) tests? in [\d.]+s\s*$/gm;
const UNITTEST_RESULT = /^(OK|FAILED)(?: \(([^)]*)\))?\s*$/m;
const UNITTEST_STATUS_SUFFIX = / \.\.\. (ok|OK|FAIL|ERROR|skipped\b.*|expected failure|unexpected success)\s*$/;

/** `failures=2, errors=1, skipped=1, expected failures=1, unexpected successes=1` → numbers by key. */
function unittestFields(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of s.matchAll(/([a-z ]+?)=(\d+)/g)) out[(m[1] ?? '').trim()] = num(m[2]);
  return out;
}

/**
 * unittest's TextTestRunner (also Django's `tests/runtests.py`): `Ran 23 tests in 0.012s` then
 * `OK`, `OK (skipped=1)` or `FAILED (failures=1, errors=1, skipped=1, expected failures=1,
 * unexpected successes=1)`. Expected failures count as skipped and unexpected successes as failed
 * (the run exits 1 on them). Without the summary (a killed run) the verbose ` ... ok` lines are counted.
 */
export function parseUnittest(text: string): TestCounts | null {
  const ran = lastMatch(text, UNITTEST_RAN);
  if (ran !== null) {
    const total = num(ran[1]);
    const res = UNITTEST_RESULT.exec(text.slice(ran.index + ran[0].length));
    const f = unittestFields(res?.[2] ?? '');
    const failed = (f['failures'] ?? 0) + (f['unexpected successes'] ?? 0);
    const errors = f['errors'] ?? 0;
    const skipped = (f['skipped'] ?? 0) + (f['expected failures'] ?? 0);
    return { passed: Math.max(0, total - failed - errors - skipped), failed, errors, skipped };
  }
  const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  let seen = false;
  let pending = false;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const m = UNITTEST_STATUS_SUFFIX.exec(line);
    const status = m !== null ? (m[1] ?? '') : pending && /^(ok|OK|FAIL|ERROR)$/.test(line.trim()) ? line.trim() : null;
    pending = m === null && /^\w+ \([\w.]+\)/.test(line);
    if (status === null) continue;
    seen = true;
    if (status === 'ok' || status === 'OK') counts.passed += 1;
    else if (status === 'FAIL' || status === 'unexpected success') counts.failed += 1;
    else if (status === 'ERROR') counts.errors += 1;
    else counts.skipped += 1;
  }
  return seen ? counts : null;
}

/** Django's runner is unittest's TextTestRunner; the summary lines are the same. */
export const parseDjango: (text: string) => TestCounts | null = parseUnittest;

const ANSI = /\u001b\[[0-9;]*m/g;
const SYMPY_ITEM = /(\d+) (passed|failed|skipped|expected to fail but passed|expected to fail|exceptions)/g;
const SYMPY_STATUS_CHARS = /^([.FEswTKfX]+)\s*(?:\[(?:OK|FAIL)\])?\s*$/;
const SYMPY_FILE_LINE = /^(\S+\.py)\[(?:\d+|\?)\]\s*(.*)$/;
const SYMPY_VERBOSE_LINE = /^(test\w*)\s+(?:.*?\s+)?(ok|F|E|s|w|T|K|f|X)\s*(?:\[(?:OK|FAIL)\])?\s*$/;

function sympyCountChar(counts: TestCounts, ch: string): void {
  if (ch === '.' || ch === 'X' || ch === 'ok') counts.passed += 1;
  else if (ch === 'F') counts.failed += 1;
  else if (ch === 'E') counts.errors += 1;
  else counts.skipped += 1; // s, w (slow), T (timeout), K (interrupt), f (xfail)
}

/**
 * sympy's `bin/test`: `tests finished: 90 passed, 1 failed, 2 skipped, 1 expected to fail,
 * 1 expected to fail but passed, 1 exceptions, in 5.61 seconds` (the line wraps at the terminal
 * width, so it is read up to `seconds`). Exceptions are errors, expected failures are skipped,
 * unexpected passes are passed. Without the summary the status characters after each
 * `path.py[N]` (quiet) or the `test_x ok|F|E|…` lines (--verbose) are counted; only when the
 * `test process starts` banner is present, so ordinary text never reads as sympy tests.
 */
export function parseSympyBinTest(text: string): TestCounts | null {
  const clean = text.replace(ANSI, '');
  const at = clean.lastIndexOf('tests finished:');
  if (at !== -1) {
    const end = clean.indexOf('seconds', at);
    const summary = (end === -1 ? clean.slice(at) : clean.slice(at, end)).replace(/[=\n]/g, ' ');
    const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
    let seen = false;
    for (const m of summary.matchAll(SYMPY_ITEM)) {
      seen = true;
      const n = num(m[1]);
      switch (m[2]) {
        case 'passed':
        case 'expected to fail but passed':
          counts.passed += n;
          break;
        case 'failed':
          counts.failed += n;
          break;
        case 'exceptions':
          counts.errors += n;
          break;
        default:
          counts.skipped += n; // skipped, expected to fail
      }
    }
    if (seen) return counts;
  }
  if (!clean.includes('test process starts')) return null;
  const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  let seen = false;
  let inFile = false;
  for (const raw of clean.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('____') || line.includes('tests finished:')) break;
    const f = SYMPY_FILE_LINE.exec(line);
    if (f !== null) {
      inFile = true;
      const rest = (f[2] ?? '').replace(/\s*\[(?:OK|FAIL)\]\s*$/, '').trim();
      if (rest !== '' && /^[.FEswTKfX]+$/.test(rest)) {
        seen = true;
        for (const ch of rest) sympyCountChar(counts, ch);
      }
      continue;
    }
    if (!inFile) continue;
    const v = SYMPY_VERBOSE_LINE.exec(line);
    if (v !== null) {
      seen = true;
      sympyCountChar(counts, v[2] ?? '');
      continue;
    }
    const c = SYMPY_STATUS_CHARS.exec(line);
    if (c !== null) {
      seen = true;
      for (const ch of c[1] ?? '') sympyCountChar(counts, ch);
    }
  }
  return seen ? counts : null;
}

/** `Tests:       1 failed, 2 passed, 3 total` */
export function parseJest(text: string): TestCounts | null {
  const m = lastMatch(text, /^Tests:\s+(.+?),\s*(\d+) total\s*$/gm);
  if (!m) return null;
  const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  for (const part of m[1]!.split(',')) {
    const pm = /(\d+) (failed|passed|skipped|todo|pending)/.exec(part);
    if (!pm) continue;
    const n = num(pm[1]);
    if (pm[2] === 'failed') counts.failed += n;
    else if (pm[2] === 'passed') counts.passed += n;
    else counts.skipped += n;
  }
  return counts;
}

/** ` Tests  1 failed | 2 passed | 1 skipped (4)` */
export function parseVitest(text: string): TestCounts | null {
  const m = lastMatch(text, /^\s*Tests\s{2,}(.+?)\s*\((\d+)\)\s*$/gm);
  if (!m) return null;
  const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  for (const part of m[1]!.split('|')) {
    const pm = /(\d+) (failed|passed|skipped|todo)/.exec(part);
    if (!pm) continue;
    const n = num(pm[1]);
    if (pm[2] === 'failed') counts.failed += n;
    else if (pm[2] === 'passed') counts.passed += n;
    else counts.skipped += n;
  }
  return counts;
}

/** `test result: ok. 5 passed; 0 failed; 1 ignored; ...` summed over every test binary. */
export function parseCargo(text: string): TestCounts | null {
  const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  let seen = false;
  for (const m of text.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)) {
    seen = true;
    counts.passed += num(m[1]);
    counts.failed += num(m[2]);
    counts.skipped += num(m[3]);
  }
  return seen ? counts : null;
}

/** `--- PASS:` / `--- FAIL:` / `--- SKIP:` lines from `go test -v`. */
export function parseGo(text: string): TestCounts | null {
  const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  let seen = false;
  for (const m of text.matchAll(/^\s*--- (PASS|FAIL|SKIP): /gm)) {
    seen = true;
    if (m[1] === 'PASS') counts.passed++;
    else if (m[1] === 'FAIL') counts.failed++;
    else counts.skipped++;
  }
  return seen ? counts : null;
}

const ALL_PARSERS: readonly ((t: string) => TestCounts | null)[] = [parsePytest, parseJest, parseVitest, parseCargo, parseGo, parseUnittest, parseSympyBinTest];

/** Pure. Parses from the tail; `npm`/`unknown` try every format. */
export function parseTestOutput(runner: TestRunner, output: string): TestCounts | null {
  if (typeof output !== 'string' || output.length === 0) return null;
  const t = tail(output);
  switch (runner) {
    case 'pytest':
      return parsePytest(t);
    case 'django':
    case 'unittest':
      return parseUnittest(t);
    case 'sympy_bintest':
      return parseSympyBinTest(t);
    case 'jest':
      return parseJest(t) ?? parseVitest(t);
    case 'vitest':
      return parseVitest(t) ?? parseJest(t);
    case 'cargo':
      return parseCargo(t);
    case 'go':
      return parseGo(t);
    case 'npm':
    case 'unknown': {
      for (const p of ALL_PARSERS) {
        const r = p(t);
        if (r) return r;
      }
      return null;
    }
    default:
      return null;
  }
}
