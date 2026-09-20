/**
 * Shared workspace plumbing of the jev-only ladder suites (QuixBugs, Ladder): the pytest
 * layout files (pytest.ini so the judge's test detection picks `pytest -q`; conftest.py for
 * pytest < 7, which lacks the `pythonpath` ini option), a one-commit git repository so
 * `model_patch` extraction diffs against the initial tree, and that extraction.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SandboxError } from '../../errors.js';
import { shellQuote, tail } from '../swebench/evaluator.js';
import { extractModelPatch } from '../swebench/predictions.js';
import type { BenchEvaluateContext, CommandRunner, PatchExtraction } from '../types.js';

export const PYTEST_INI = `[pytest]
testpaths = tests
pythonpath = .
addopts = -p no:cacheprovider
`;

export const CONFTEST_PY = `"""Puts the workspace root on sys.path so the tests import the code under test (pytest < 7 lacks the pythonpath ini option)."""
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
`;

/** `pytest` on PATH is not guaranteed; the module form runs wherever pytest is importable. */
export const MOCK_TEST_COMMAND = 'python3 -m pytest -q';
/** the mocked test run must never dominate a mocked bench */
export const MOCK_RUN_TIMEOUT_MS = 60_000;

/** Never part of a model patch: bench markers, byte-code caches, pytest's cache, a local venv. */
export const GIT_EXCLUDES: readonly string[] = ['.jevcode*', '__pycache__/', '*.pyc', '.pytest_cache/', '.venv/'];

export interface PytestLayoutOptions {
  /** the task's own pytest.ini text (kept verbatim when the task ships one) */
  pytestIni?: string;
}

export async function writePytestLayout(workspaceDir: string, o: PytestLayoutOptions = {}): Promise<void> {
  await writeFile(join(workspaceDir, 'pytest.ini'), o.pytestIni ?? PYTEST_INI, 'utf8');
  await writeFile(join(workspaceDir, 'conftest.py'), CONFTEST_PY, 'utf8');
}

export function gitInitCommand(message: string): string {
  const excludes = GIT_EXCLUDES.map((e) => `${e}\\n`).join('');
  return `git -c init.defaultBranch=main init -q && printf '${excludes}' >> .git/info/exclude && git add -A && git -c user.name=jevcode-bench -c user.email=bench@jevcode.invalid commit -q -m ${shellQuote(message)}`;
}

/** Make the workspace a repository with one commit holding the initial tree (cwd = workspace). */
export async function initGitRepo(run: CommandRunner, message: string, timeoutMs = 60_000): Promise<void> {
  const res = await run(gitInitCommand(message), { timeoutMs, maxOutputBytes: 32 * 1024 });
  if (!res.ok) throw new SandboxError(`git init/commit of the workspace failed: ${tail(res, 400)}`);
}

const SHA_RE = /^[0-9a-f]{40}$/;

/** The repository's root commit (the setup commit; survives anything the agent committed on top). */
export async function rootCommit(run: CommandRunner): Promise<string> {
  const res = await run('git rev-list --max-parents=0 HEAD', { timeoutMs: 30_000, maxOutputBytes: 4096 });
  const sha = res.stdout.trim().split('\n').at(-1)?.trim() ?? '';
  if (!res.ok || !SHA_RE.test(sha)) throw new SandboxError(`cannot find the workspace's initial commit: ${tail(res, 300)}`);
  return sha;
}

/** model_patch = `git diff` against the setup commit (DESIGN.md §13 extraction, same excludes). */
export async function extractPatchFromRootCommit(ctx: Pick<BenchEvaluateContext, 'run' | 'runDir'>): Promise<PatchExtraction> {
  const base = await rootCommit(ctx.run);
  return extractModelPatch(ctx.run, base, ctx.runDir);
}
