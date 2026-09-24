/** Fixtures and builders for the memory + goals unit tests (test/unit/jev-modes/synth/search/{memory,goals}.test.ts). */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RankedLine } from '../../../../../src/jev-modes/synth/sbfl/types.js';
import { newGoal } from '../../../../../src/jev-modes/synth/search/goals.js';
import type { Goal } from '../../../../../src/jev-modes/synth/search/types.js';
import type { FailureView, TestRunSummary } from '../../../../../src/jev-modes/synth/types.js';
import { summarize } from '../../../../../src/jev-modes/synth/verify/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SEARCH_FIXTURES = join(here, '../../../../fixtures/synth/search');
export const VERIFY_FIXTURES = join(here, '../../../../fixtures/synth/verify');
export const REPO_ROOT = join(here, '../../../../..');
export const QUIXBUGS_DIR = join(REPO_ROOT, 'bench/data/quixbugs');

export function searchFixture(name: string): string {
  return readFileSync(join(SEARCH_FIXTURES, name), 'utf8');
}

export function verifyFixture(name: string): string {
  return readFileSync(join(VERIFY_FIXTURES, name), 'utf8');
}

/** A pytest output fixture as the baseline summary (exit 1: something failed). */
export function pytestBaseline(text: string, command = 'python3 -m pytest -q --tb=short'): TestRunSummary {
  return summarize(command, { stdout: text, stderr: '', exitCode: 1 }, 100);
}

/** A run_tests.py JSON line as the baseline summary. */
export function quixbugsBaseline(json: string, command = 'python3 run_tests.py gcd programs/gcd.py'): TestRunSummary {
  return summarize(command, { stdout: json, stderr: '', exitCode: 1 }, 100);
}

export function failure(testId: string, call: string, expected = '1', actual = '0'): FailureView {
  return { testId, call, expected, actual };
}

/** A baseline with the given failing tests and `passed` passing tests. */
export function baselineOf(failing: readonly FailureView[], passed = 1): TestRunSummary {
  return {
    command: 'pytest -q',
    passed,
    failed: failing.length,
    errors: 0,
    skipped: 0,
    total: passed + failing.length,
    failing: failing.map((f) => f.testId),
    passing: [],
    failures: [...failing],
    exitCode: failing.length > 0 ? 1 : 0,
    timedOut: false,
    durationMs: 5,
    outputTail: '',
  };
}

/** A goal with default failures (one per test) and `src/m.py` suspected unless overridden. */
export function goal(id: string, tests: string[], over: Partial<Goal> = {}): Goal {
  const g = newGoal(id, tests, tests.map((t) => failure(t, t)), over.suspectedFiles ?? ['src/m.py']);
  return { ...g, ...over, planItem: over.planItem ?? g.planItem };
}

export function rankedLine(rank: number, file: string, line: number, score = 1 - rank / 10): RankedLine {
  return { rank, file, line, ef: 1, ep: 0, score, scores: { ochiai: score, tarantula: score, dstar: score } };
}
