/**
 * Terminal-Bench local verifier (design A, DESIGN.md §13 steps 2–7): fresh verifier app dir V
 * built from tests/Dockerfile plus the declared artifacts, a path-rewritten copy T of tests/,
 * PATH shims, `bash T/test.sh` through the sandbox, verdict from reward.json / reward.txt.
 * The exit code is never the verdict.
 */
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isFiniteNumber, isJsonObject, parseJson } from '../../core/json.js';
import type { CommandRunner, Evaluation } from '../types.js';
import { copyAndRewriteTests, isInstallStep, mapContainerPath, parseCopyArgs, parseDockerfile, replayCopy, resolveDest, rewritePaths, writeShims, type PathMap } from './shim.js';
import type { TbTaskRecord } from './tasks.js';

export const DEFAULT_VERIFIER_TIMEOUT_SEC = 600;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

export interface TrialPaths {
  trialDir: string;
  V: string;
  T: string;
  L: string;
  O: string;
  R: string;
  S: string;
  home: string;
  tmp: string;
  fsroot: string;
}

export function trialPaths(trialDir: string): TrialPaths {
  return {
    trialDir,
    V: join(trialDir, 'app'),
    T: join(trialDir, 'tests'),
    L: join(trialDir, 'logs', 'verifier'),
    O: join(trialDir, 'output'),
    R: join(trialDir, 'results'),
    S: join(trialDir, 'shim'),
    home: join(trialDir, 'home'),
    tmp: join(trialDir, 'tmp'),
    fsroot: join(trialDir, 'fsroot'),
  };
}

/** `/app→V`, `/tests→T`, `/logs/verifier→L`, `/output→O`, `/results→R`, `/tmp/agent.patch→L/agent.patch` (+ `/logs`, `/tmp`). */
export function verifierPathMap(p: TrialPaths): PathMap {
  return {
    '/app': p.V,
    '/tests': p.T,
    '/logs/verifier': p.L,
    '/logs': join(p.trialDir, 'logs'),
    '/output': p.O,
    '/results': p.R,
    '/tmp/agent.patch': join(p.L, 'agent.patch'),
    '/tmp': p.tmp,
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function shimPath(S: string, venvDir: string | null): string {
  const base = process.env['PATH'] ?? '/usr/bin:/bin';
  return venvDir === null ? `${S}:${base}` : `${S}:${join(venvDir, 'bin')}:${base}`;
}

async function exists(p: string): Promise<'dir' | 'file' | null> {
  try {
    const s = await stat(p);
    return s.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

/**
 * Step 2 (first half): replay tests/Dockerfile's COPY lines (except into /tests) and the
 * non-install RUN steps so V holds exactly what Harbor's verifier image bakes in.
 */
export async function buildVerifierDir(record: TbTaskRecord, paths: TrialPaths, map: PathMap, run: CommandRunner, envPath: string, timeoutMs: number, log: (l: string) => void): Promise<void> {
  const testsDir = join(record.taskDir, 'tests');
  const text = await readFile(join(testsDir, 'Dockerfile'), 'utf8').catch(() => '');
  let workdir = '/';
  for (const ins of parseDockerfile(text)) {
    if (ins.cmd === 'WORKDIR') {
      workdir = ins.args.startsWith('/') ? ins.args : join(workdir, ins.args);
      continue;
    }
    if (ins.cmd === 'COPY' || ins.cmd === 'ADD') {
      const spec = parseCopyArgs(ins.args);
      if (!spec) continue;
      const { local, container } = resolveDest(spec.dest, workdir, map, paths.fsroot);
      if (container === '/tests' || container.startsWith('/tests/')) continue;
      const destIsDir = spec.dest.endsWith('/') || spec.dest === '.' || spec.sources.length > 1;
      await replayCopy(spec, testsDir, local, destIsDir);
      continue;
    }
    if (ins.cmd === 'RUN') {
      if (isInstallStep(ins.args)) continue;
      const cmd = rewritePaths(ins.args.split('\n').join(' '), map);
      const cwd = mapContainerPath(workdir, map) ?? join(paths.fsroot, workdir);
      await mkdir(cwd, { recursive: true });
      log(`[terminal-bench ${record.manifest.name}] verifier RUN ${cmd.slice(0, 100)}`);
      const res = await run(`export PATH=${shellQuote(envPath)} HOME=${shellQuote(paths.home)} && ${cmd}`, { cwd, timeoutMs, maxOutputBytes: 64 * 1024 });
      if (!res.ok) throw new Error(`verifier build step failed (${cmd.slice(0, 80)}): ${res.stderr.slice(-400) || res.stdout.slice(-400)}`);
    }
  }
}

/**
 * Step 2 (second half): collect hooks run in W, then only the declared artifacts cross into V
 * (Harbor's "separate" mode never shows the verifier the whole workspace).
 */
export async function collectArtifacts(record: TbTaskRecord, agentMap: PathMap, verifierMap: PathMap, paths: TrialPaths, runInWorkspace: CommandRunner, log: (l: string) => void): Promise<string[]> {
  for (const hook of record.toml.collectCommands) {
    const cmd = rewritePaths(hook, agentMap);
    const res = await runInWorkspace(cmd, { timeoutMs: 120_000, maxOutputBytes: 64 * 1024 });
    if (!res.ok) log(`[terminal-bench ${record.manifest.name}] collect hook exited ${res.exitCode ?? 'null'}`);
  }
  const artifacts = record.toml.artifacts.length > 0 ? record.toml.artifacts : record.manifest.artifacts;
  const copied: string[] = [];
  for (const raw of artifacts) {
    const container = raw.replace(/\/+$/, '') || '/';
    const src = mapContainerPath(container, agentMap);
    const dst = mapContainerPath(container, verifierMap) ?? join(paths.fsroot, container);
    if (src === null) {
      log(`[terminal-bench ${record.manifest.name}] artifact ${raw} has no local stand-in; skipped`);
      continue;
    }
    const kind = await exists(src);
    if (kind === null) {
      log(`[terminal-bench ${record.manifest.name}] artifact ${raw} missing in workspace`);
      continue;
    }
    if (kind === 'dir') {
      await mkdir(dst, { recursive: true });
      await cp(src, dst, { recursive: true, force: true, dereference: false, filter: (s) => !basename(s).startsWith('.jevcode') });
    } else {
      await mkdir(dirname(dst), { recursive: true });
      await cp(src, dst, { force: true });
    }
    copied.push(raw);
  }
  return copied;
}

export type RewardRead = { kind: 'reward'; reward: number; source: 'reward.json' | 'reward.txt' } | { kind: 'malformed'; reason: string } | { kind: 'missing' };

/** Harbor's Verifier.verify(): reward.json (number, or a dict whose numeric values are summed), else reward.txt (single float). */
export async function readReward(L: string): Promise<RewardRead> {
  const jsonText = await readFile(join(L, 'reward.json'), 'utf8').catch(() => null);
  if (jsonText !== null) {
    const parsed = parseJson(jsonText);
    if (!parsed.ok) return { kind: 'malformed', reason: `reward.json: ${parsed.error}` };
    const v = parsed.value;
    if (isFiniteNumber(v)) return { kind: 'reward', reward: v, source: 'reward.json' };
    if (isJsonObject(v)) {
      const nums = Object.values(v);
      if (nums.length > 0 && nums.every(isFiniteNumber)) return { kind: 'reward', reward: nums.reduce((a, b) => a + b, 0), source: 'reward.json' };
    }
    return { kind: 'malformed', reason: 'reward.json is neither a number nor a dict of numbers' };
  }
  const txt = await readFile(join(L, 'reward.txt'), 'utf8').catch(() => null);
  if (txt !== null) {
    const n = Number(txt.trim());
    if (txt.trim() === '' || !Number.isFinite(n)) return { kind: 'malformed', reason: `reward.txt is not a number: ${txt.trim().slice(0, 40)}` };
    return { kind: 'reward', reward: n, source: 'reward.txt' };
  }
  return { kind: 'missing' };
}

const COMMAND_NOT_FOUND = /command not found|: not found$/m;

export interface TbEvalInput {
  record: TbTaskRecord;
  workspaceDir: string;
  agentMap: PathMap;
  /** <run>/eval/<name> */
  trialDir: string;
  makeRunner: (root: string) => CommandRunner;
  /** shared venv dir, or null to rely on the system python (unit tests) */
  venvDir: string | null;
  log: (line: string) => void;
  timeoutMs?: number;
}

export async function evaluateTerminalBenchLocal(input: TbEvalInput): Promise<Evaluation> {
  const { record } = input;
  const paths = trialPaths(input.trialDir);
  const map = verifierPathMap(paths);
  for (const d of [paths.V, paths.T, paths.L, paths.O, paths.R, paths.S, paths.home, paths.tmp, paths.fsroot]) await mkdir(d, { recursive: true });
  await writeShims(paths.S);
  const envPath = shimPath(paths.S, input.venvDir);
  const timeoutMs = input.timeoutMs ?? (record.toml.verifierTimeoutSec ?? record.manifest.verifier_timeout_sec ?? DEFAULT_VERIFIER_TIMEOUT_SEC) * 1000;
  const runTrial = input.makeRunner(input.trialDir);
  const runWorkspace = input.makeRunner(input.workspaceDir);

  try {
    await buildVerifierDir(record, paths, map, runTrial, envPath, Math.min(timeoutMs, 15 * 60_000), input.log);
    await collectArtifacts(record, input.agentMap, map, paths, runWorkspace, input.log);
    await copyAndRewriteTests(join(record.taskDir, 'tests'), paths.T, map);
  } catch (e) {
    return { pass: null, evaluator: 'none', reason: `verifier build failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const testSh = join(paths.T, 'test.sh');
  if ((await exists(testSh)) !== 'file') return { pass: null, evaluator: 'none', reason: 'tests/test.sh missing' };

  const out: string[] = [];
  const err: string[] = [];
  let captured = 0;
  const res = await runTrial(`export PATH=${shellQuote(envPath)} HOME=${shellQuote(paths.home)} PYTHONDONTWRITEBYTECODE=1 && cd ${shellQuote(paths.T)} && exec bash ${shellQuote(testSh)}`, {
    cwd: paths.T,
    timeoutMs,
    maxOutputBytes: 4 * 1024 * 1024,
    env: { PATH: envPath, HOME: paths.home, PYTHONDONTWRITEBYTECODE: '1' },
    onOutput: (stream, chunk) => {
      if (captured >= MAX_CAPTURE_BYTES) return;
      captured += chunk.length;
      (stream === 'stdout' ? out : err).push(chunk);
    },
  });
  const stdout = out.length > 0 || err.length > 0 ? out.join('') : res.stdout;
  const stderr = out.length > 0 || err.length > 0 ? err.join('') : res.stderr;
  await writeFile(join(paths.L, 'test-stdout.txt'), stdout, 'utf8').catch(() => undefined);
  await writeFile(join(paths.L, 'test-stderr.txt'), stderr, 'utf8').catch(() => undefined);

  const reward = await readReward(paths.L);
  const missingTool = COMMAND_NOT_FOUND.test(`${stdout}\n${stderr}`);
  if (reward.kind === 'reward') {
    if (reward.reward >= 1) return { pass: true, evaluator: 'local', evalExitCode: res.exitCode, reason: `reward ${reward.reward} from ${reward.source}` };
    if (missingTool) return { pass: null, evaluator: 'none', reason: 'unsupported-locally', evalExitCode: res.exitCode };
    return { pass: false, evaluator: 'local', evalExitCode: res.exitCode, reason: `reward ${reward.reward} from ${reward.source}` };
  }
  if (res.killedBy === 'timeout') return { pass: null, evaluator: 'none', reason: 'verifier-timeout', evalExitCode: null };
  if (missingTool) return { pass: null, evaluator: 'none', reason: 'unsupported-locally', evalExitCode: res.exitCode };
  if (reward.kind === 'malformed') return { pass: null, evaluator: 'none', reason: reward.reason, evalExitCode: res.exitCode };
  return { pass: null, evaluator: 'none', reason: 'no-reward-file', evalExitCode: res.exitCode };
}
