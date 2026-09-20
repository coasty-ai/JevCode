/**
 * Test-command detection from manifests and summary-line parsing (DESIGN.md §8).
 * Parsing is code, never a Jev question: the judge state carries the counts. Summaries are
 * read from the tail because a capped output keeps its last 16 KB.
 */
import type { TestCommand, TestCounts, TestRunner } from '../core/types.js';

export interface ManifestReader {
  /** relative path -> text (bounded) or null when missing / unreadable / not allowed */
  read(relPath: string): Promise<string | null>;
  /** relative directory listing (names only) or null */
  list(relPath: string): Promise<string[] | null>;
}

const NPM_PLACEHOLDER = /no test specified/;

function runnerFromScript(script: string): TestRunner {
  if (/\bvitest\b/.test(script)) return 'vitest';
  if (/\bjest\b/.test(script)) return 'jest';
  if (/\bpytest\b/.test(script)) return 'pytest';
  if (/\bcargo\s+test\b/.test(script)) return 'cargo';
  if (/\bgo\s+test\b/.test(script)) return 'go';
  return 'npm';
}

async function hasPytestLayout(r: ManifestReader): Promise<boolean> {
  if ((await r.read('pytest.ini')) !== null) return true;
  if ((await r.read('conftest.py')) !== null) return true;
  const pyproject = await r.read('pyproject.toml');
  if (pyproject !== null && /^\s*\[tool\.pytest(\.ini_options)?\]/m.test(pyproject)) return true;
  const setupCfg = await r.read('setup.cfg');
  if (setupCfg !== null && /^\s*\[tool:pytest\]/m.test(setupCfg)) return true;
  const tox = await r.read('tox.ini');
  if (tox !== null && /^\s*\[pytest\]/m.test(tox)) return true;
  for (const dir of ['tests', 'test']) {
    const names = await r.list(dir);
    if (names && names.some((n) => /^test_.*\.py$|_test\.py$|^conftest\.py$/.test(n))) return true;
  }
  return false;
}

/** First match wins: pytest layout, package.json scripts.test, Cargo.toml, go.mod. */
export async function detectTestCommand(r: ManifestReader): Promise<TestCommand | null> {
  if (await hasPytestLayout(r)) return { command: 'pytest -q', runner: 'pytest' };
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

/** `===== 3 passed, 1 failed, 2 errors, 1 skipped in 0.12s =====` (any subset, any order). */
export function parsePytest(text: string): TestCounts | null {
  const m = lastMatch(text, /^[=\s]*((?:\d+ [a-z]+(?:, )?)+) in \d+(?:\.\d+)?s(?: \([^)]*\))?[=\s]*$/gm);
  if (!m) {
    if (/^[=\s]*no tests ran in \d+(?:\.\d+)?s/m.test(text)) return { passed: 0, failed: 0, errors: 0, skipped: 0 };
    return null;
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

const ALL_PARSERS: readonly ((t: string) => TestCounts | null)[] = [parsePytest, parseJest, parseVitest, parseCargo, parseGo];

/** Pure. Parses from the tail; `npm`/`unknown` try every format. */
export function parseTestOutput(runner: TestRunner, output: string): TestCounts | null {
  if (typeof output !== 'string' || output.length === 0) return null;
  const t = tail(output);
  switch (runner) {
    case 'pytest':
      return parsePytest(t);
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
