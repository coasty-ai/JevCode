/**
 * Local-venv SWE-bench evaluator (DESIGN.md §13, steps a–i), replicating the official eval.sh
 * without Docker: fresh clone, venv, spec install, model_patch with the official apply chain,
 * test_patch, the exact test invocation from eval.sh under a 1800 s timeout, official parsers
 * and the FULL rule. Every command runs through the sandbox runner rooted at the eval dir.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExecResult } from '../../core/types.js';
import type { CommandRunner, Evaluation } from '../types.js';
import { END_TEST_OUTPUT, START_TEST_OUTPUT, TEST_EXIT_CODE, gradeLog, selectParser } from './logparse.js';
import { testCommandFromEvalScript, type SwebenchRecord } from './tasks.js';

export const SETUP_TIMEOUT_MS = 20 * 60_000;
export const TEST_TIMEOUT_MS = 1800_000;
export const TEST_OUTPUT_FILE = 'test_output.txt';
/** Keep at most this much test output in memory before writing it (bounded, never a kill). */
const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;

/** MAP_REPO_TO_REQS_PATHS for the repos in the subset (spec.packages === "requirements.txt"). */
const REQS_PATHS: Record<string, string[]> = {
  'django/django': ['tests/requirements/py3.txt'],
  'pylint-dev/pylint': ['requirements_test.txt'],
};

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function venvPrefix(dir: string): string {
  const bin = join(dir, '.venv', 'bin');
  return `export PATH=${shellQuote(bin)}:"$PATH" VIRTUAL_ENV=${shellQuote(join(dir, '.venv'))} && `;
}

export function bareCloneDir(cacheRoot: string, repo: string): string {
  return join(cacheRoot, `${repo.split('/').join('__')}.git`);
}

export function repoUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

const cloneLocks = new Map<string, Promise<void>>();

/**
 * One bare clone per repo under <runsDir>/bench-cache, shared by every task and by both the
 * agent workspace and the eval dir; fetched again only when the wanted commit is missing.
 */
export async function ensureBareClone(cacheRoot: string, repo: string, commit: string, makeRunner: (root: string) => CommandRunner, timeoutMs = SETUP_TIMEOUT_MS): Promise<string> {
  const dir = bareCloneDir(cacheRoot, repo);
  const prev = cloneLocks.get(dir) ?? Promise.resolve();
  const next = prev.then(async () => {
    await mkdir(cacheRoot, { recursive: true });
    const run = makeRunner(cacheRoot);
    const q = shellQuote(dir);
    // an interrupted first clone leaves a directory that is not a repository; discard it rather than fetching into it forever
    const cmd = `if [ -d ${q} ] && ! git -C ${q} rev-parse --git-dir >/dev/null 2>&1; then rm -rf ${q}; fi; if [ ! -d ${q} ]; then git clone --bare -q ${shellQuote(repoUrl(repo))} ${q}; fi && (git -C ${q} cat-file -e ${shellQuote(`${commit}^{commit}`)} 2>/dev/null || git -C ${q} fetch -q ${shellQuote(repoUrl(repo))} '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*') && git -C ${q} cat-file -e ${shellQuote(`${commit}^{commit}`)}`;
    const res = await run(cmd, { timeoutMs, maxOutputBytes: 64 * 1024 });
    if (!res.ok) throw new Error(`bare clone of ${repo} failed or lacks ${commit}: ${tail(res)}`);
  });
  cloneLocks.set(dir, next.catch(() => undefined));
  await next;
  return dir;
}

export function tail(res: ExecResult, n = 600): string {
  const s = `${res.stdout}\n${res.stderr}`.trim();
  return s.length > n ? `…${s.slice(-n)}` : s;
}

export interface CheckoutOptions {
  cacheDir: string;
  commit: string;
  timeoutMs: number;
}

/** `git clone --shared` from the bare cache into an existing empty dir, then checkout. */
export async function cloneAt(run: CommandRunner, opts: CheckoutOptions): Promise<void> {
  const res = await run(`git clone --shared -q ${shellQuote(opts.cacheDir)} . && git checkout -q ${opts.commit} && printf '.venv/\\n.jevcode*\\n' >> .git/info/exclude`, {
    timeoutMs: opts.timeoutMs,
    maxOutputBytes: 64 * 1024,
  });
  if (!res.ok) throw new Error(`clone/checkout ${opts.commit} failed: ${tail(res)}`);
}

/** Step (b)/(c) package installs: venv, spec.packages, pip_packages, pre_install, install. */
export function installCommands(record: SwebenchRecord, dir: string): string[] {
  const pre = venvPrefix(dir);
  const cmds: string[] = [`python3 -m venv .venv`];
  const pkgs = record.spec.packages;
  if (pkgs === 'requirements.txt') {
    const paths = REQS_PATHS[record.repo] ?? ['requirements.txt'];
    cmds.push(`${pre}python -m pip install -q ${paths.map((p) => `-r ${shellQuote(p)}`).join(' ')}`);
  } else if (pkgs !== null && pkgs.trim() !== '') {
    cmds.push(`${pre}python -m pip install -q ${pkgs.trim().split(/\s+/).map(shellQuote).join(' ')}`);
  }
  if (record.spec.pip_packages.length > 0) {
    cmds.push(`${pre}python -m pip install -q ${record.spec.pip_packages.map(shellQuote).join(' ')}`);
  }
  return cmds;
}

export interface EnvironmentBuildOptions {
  dir: string;
  cacheDir: string;
  run: CommandRunner;
  timeoutMs: number;
  log: (line: string) => void;
}

/**
 * Steps (b) and (c): clone at environment_setup_commit, venv + packages, then checkout
 * base_commit and run pre_install/install. Shared by the agent workspace setup and the
 * evaluator so both trees are built the same way.
 */
export async function buildEnvironment(record: SwebenchRecord, opts: EnvironmentBuildOptions): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  const remaining = (): number => Math.max(1000, deadline - Date.now());
  await cloneAt(opts.run, { cacheDir: opts.cacheDir, commit: record.environment_setup_commit, timeoutMs: remaining() });
  for (const cmd of installCommands(record, opts.dir)) {
    opts.log(`[swebench ${record.instance_id}] ${cmd.slice(0, 120)}`);
    const res = await opts.run(cmd, { timeoutMs: remaining(), maxOutputBytes: 64 * 1024 });
    if (!res.ok) throw new Error(`environment step failed (${cmd.slice(0, 80)}): ${tail(res)}`);
  }
  const co = await opts.run(`git checkout -q ${record.base_commit}`, { timeoutMs: remaining(), maxOutputBytes: 16 * 1024 });
  if (!co.ok) throw new Error(`checkout ${record.base_commit} failed: ${tail(co)}`);
  const pre = venvPrefix(opts.dir);
  for (const step of [...record.spec.pre_install, record.spec.install]) {
    if (step.trim() === '') continue;
    const res = await opts.run(`${pre}${step}`, { timeoutMs: remaining(), maxOutputBytes: 64 * 1024 });
    if (!res.ok) throw new Error(`install step failed (${step.slice(0, 80)}): ${tail(res)}`);
  }
}

/** GIT_APPLY_CMDS from run_evaluation.py, tried in order without resetting in between (as upstream does). */
export const GIT_APPLY_CMDS = ['git apply --verbose', 'git apply --verbose --3way', 'git apply --verbose --reject', 'patch --batch --forward --fuzz=5 -p1 -i'];

export async function applyWithFallbacks(run: CommandRunner, patchFile: string, timeoutMs: number): Promise<{ applied: boolean; log: string }> {
  let log = '';
  for (const cmd of GIT_APPLY_CMDS) {
    const res = await run(`${cmd} ${shellQuote(patchFile)}`, { timeoutMs, maxOutputBytes: 64 * 1024 });
    log += `$ ${cmd}\n${tail(res, 2000)}\n`;
    if (res.ok) return { applied: true, log };
  }
  return { applied: false, log };
}

/**
 * The wrapper eval.sh uses: markers around the exact test invocation, exit code recorded after.
 * Upstream writes the markers as `: '>>>>> …'` no-ops that only reach the log because eval.sh
 * runs under `set -x`; we run without tracing, so the markers are echoed explicitly (the parser
 * only needs the marker text to be present on its own line).
 */
export function testScript(record: SwebenchRecord, dir: string): string | null {
  const cmd = testCommandFromEvalScript(record.eval_script) ?? `${record.spec.test_cmd} ${record.test_files.map(shellQuote).join(' ')}`;
  if (cmd.trim() === '') return null;
  return [`${venvPrefix(dir)}echo ${shellQuote(START_TEST_OUTPUT)}`, cmd, 'rc=$?', `echo ${shellQuote(END_TEST_OUTPUT)}`, `echo ${shellQuote(`${TEST_EXIT_CODE}: `)}"$rc"`].join('\n');
}

export interface SwebenchEvalInput {
  record: SwebenchRecord;
  modelPatch: string;
  /** <run>/eval/<instance_id>; created here */
  evalDir: string;
  cacheRoot: string;
  makeRunner: (root: string) => CommandRunner;
  log: (line: string) => void;
  setupTimeoutMs?: number;
  testTimeoutMs?: number;
}

function invalid(reason: string, extra: Partial<Evaluation> = {}): Evaluation {
  return { pass: null, evaluator: 'invalid', reason, ...extra };
}

export async function evaluateSwebenchLocal(input: SwebenchEvalInput): Promise<Evaluation> {
  const { record } = input;
  const setupTimeoutMs = input.setupTimeoutMs ?? SETUP_TIMEOUT_MS;
  const testTimeoutMs = input.testTimeoutMs ?? TEST_TIMEOUT_MS;
  // (a) an empty patch is a definite failure; the official harness never runs these.
  if (input.modelPatch.trim() === '') return { pass: false, evaluator: 'local-venv', patchApplied: false, reason: 'empty model_patch' };

  await mkdir(input.evalDir, { recursive: true });
  const run = input.makeRunner(input.evalDir);
  const parser = selectParser(record.log_parser, record.repo);
  if (parser === null) return { pass: null, evaluator: 'none', reason: `no log parser for ${record.repo} (${record.log_parser})` };

  // (b)+(c) environment
  let cacheDir: string;
  try {
    cacheDir = await ensureBareClone(input.cacheRoot, record.repo, record.base_commit, input.makeRunner, setupTimeoutMs);
    await buildEnvironment(record, { dir: input.evalDir, cacheDir, run, timeoutMs: setupTimeoutMs, log: input.log });
  } catch (e) {
    return { pass: null, evaluator: 'none', reason: `environment build failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Patch files live beside the clone, never inside it, so they cannot leak into a diff.
  const sidecar = dirname(input.evalDir);
  const modelPatchFile = join(sidecar, `${record.instance_id}.model.patch`);
  const testPatchFile = join(sidecar, `${record.instance_id}.test.patch`);
  await writeFile(modelPatchFile, input.modelPatch, 'utf8');
  await writeFile(testPatchFile, record.test_patch, 'utf8');

  // (d)
  const applied = await applyWithFallbacks(run, modelPatchFile, 120_000);
  await writeFile(join(input.evalDir, 'apply.log'), applied.log, 'utf8').catch(() => undefined);
  if (!applied.applied) return { pass: false, evaluator: 'local-venv', patchApplied: false, reason: 'model_patch did not apply' };

  // (e)
  const reset = await run(`git checkout ${record.base_commit} -- ${record.test_files.map(shellQuote).join(' ')} && git apply -v ${shellQuote(testPatchFile)}`, { timeoutMs: 120_000, maxOutputBytes: 64 * 1024 });
  if (!reset.ok) return invalid(`test_patch did not apply: ${tail(reset)}`, { patchApplied: true });

  // (f)
  const script = testScript(record, input.evalDir);
  if (script === null) return invalid('no test command in eval_script', { patchApplied: true });
  const chunks: string[] = [];
  let captured = 0;
  const res = await run(script, {
    timeoutMs: testTimeoutMs,
    maxOutputBytes: 4 * 1024 * 1024,
    onOutput: (_stream, chunk) => {
      if (captured >= MAX_CAPTURE_BYTES) return;
      captured += chunk.length;
      chunks.push(chunk);
    },
  });
  // Some sandboxes report the head+tail only through the result; prefer the streamed copy when present.
  const content = chunks.length > 0 ? chunks.join('') : [res.stdout, res.stderr].filter((s) => s !== '').join('\n');
  await writeFile(join(input.evalDir, TEST_OUTPUT_FILE), content, 'utf8');
  if (res.killedBy === 'timeout') return invalid(`tests timed out after ${testTimeoutMs} ms`, { patchApplied: true, evalExitCode: null });

  // (g)+(h)
  const grade = gradeLog(content, parser, { failToPass: record.fail_to_pass, passToPass: record.pass_to_pass });
  if (!grade.valid) return invalid(grade.reason, { patchApplied: true, evalExitCode: grade.exitCode ?? res.exitCode });
  // (i)
  return {
    pass: grade.resolved,
    evaluator: 'local-venv',
    patchApplied: true,
    testsStatus: grade.testsStatus,
    evalExitCode: grade.exitCode ?? res.exitCode,
  };
}
