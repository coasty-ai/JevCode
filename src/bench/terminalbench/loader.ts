/**
 * Terminal-Bench task loader (DESIGN.md §13): materialises the agent workspace W from
 * environment/ (COPY lines + non-install RUN steps), rewrites `/app` in instruction.md to W,
 * and builds the mocked trajectory from gold/<name>/solve.sh. tests/ and gold/ never enter W.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toJson } from '../../core/json.js';
import type { Json, MockTurn } from '../../core/types.js';
import type { BenchEvaluateContext, BenchSetupTools, BenchTask, BenchTaskSource, BuildTaskOptions, Evaluation } from '../types.js';
import { evaluateTerminalBenchLocal } from './evaluator.js';
import { boundaryPattern, ensureVerifierVenv, mapContainerPath, parseCopyArgs, replayCopy, resolveDest, rewritePaths, venvPackages, writeShims, type PathMap } from './shim.js';
import { loadTerminalBenchRecords, type TbTaskRecord } from './tasks.js';

export const PROPOSE_TOOL = 'propose_action';
export const MOCK_SOLVE_FILE = '.jevcode-mock-solve.sh';
const MOCK_RUN_TIMEOUT_MS = 600_000;
const SETUP_STEP_TIMEOUT_MS = 10 * 60_000;

/** Agent-side stand-ins: `/app` is W; every other container root lives under the runner-owned aux dir. */
export function agentPathMap(workspaceDir: string, auxDir: string): PathMap {
  return {
    '/app': workspaceDir,
    '/output': join(auxDir, 'output'),
    '/results': join(auxDir, 'results'),
    '/logs/verifier': join(auxDir, 'logs', 'verifier'),
    '/logs': join(auxDir, 'logs'),
    '/root': join(auxDir, 'root'),
    '/tmp/agent.patch': join(auxDir, 'agent.patch'),
  };
}

/** `/app` always; other roots only when the environment actually materialises them (COPY dest or RUN mkdir). */
export function instructionMap(record: TbTaskRecord, map: PathMap): PathMap {
  const out: PathMap = { '/app': map['/app']! };
  const haystack = [...record.manifest.env_copy_lines, ...record.manifest.env_run_steps_non_install].join('\n');
  for (const key of Object.keys(map)) {
    if (key === '/app') continue;
    if (boundaryPattern(key).test(haystack)) out[key] = map[key]!;
  }
  return out;
}

export function shimInstruction(record: TbTaskRecord, map: PathMap): string {
  return rewritePaths(record.instruction, instructionMap(record, map));
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function exists(p: string): Promise<'dir' | 'file' | null> {
  try {
    const s = await stat(p);
    return s.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

/** Step 1: replay environment/ COPY lines and plain RUN steps into W (never tests/ or gold/). */
export async function materialiseWorkspace(record: TbTaskRecord, workspaceDir: string, auxDir: string, tools: BenchSetupTools, timeoutMs = SETUP_STEP_TIMEOUT_MS): Promise<void> {
  const map = agentPathMap(workspaceDir, auxDir);
  const fsroot = join(auxDir, 'fsroot');
  const S = join(auxDir, 'shim');
  for (const d of [workspaceDir, ...Object.values(map), fsroot, S]) await mkdir(d, { recursive: true });
  await writeShims(S);
  const envDir = join(record.taskDir, 'environment');
  for (const line of record.manifest.env_copy_lines) {
    const spec = parseCopyArgs(line);
    if (!spec) continue;
    const { local } = resolveDest(spec.dest, record.manifest.env_workdir, map, fsroot);
    const destIsDir = spec.dest.endsWith('/') || spec.dest === '.' || spec.sources.length > 1;
    await replayCopy(spec, envDir, local, destIsDir);
  }
  const envPath = `${S}:${process.env['PATH'] ?? '/usr/bin:/bin'}`;
  for (const step of record.manifest.env_run_steps_non_install) {
    const cmd = rewritePaths(step, map);
    tools.log(`[terminal-bench ${record.manifest.name}] env RUN ${cmd.slice(0, 100)}`);
    const res = await tools.run(`export PATH=${shellQuote(envPath)} HOME=${shellQuote(join(auxDir, 'home'))} && ${cmd}`, { timeoutMs, maxOutputBytes: 64 * 1024, env: { PATH: envPath } });
    if (!res.ok) throw new Error(`environment step failed (${cmd.slice(0, 80)}): ${(res.stderr || res.stdout).slice(-400)}`);
  }
  // shadow-relay records the baseline sha at /root/.build_sha for its collect hook
  if ((await exists(join(workspaceDir, '.git'))) === 'dir') {
    const sha = await tools.run('git rev-parse HEAD', { timeoutMs: 30_000, maxOutputBytes: 4096 });
    if (sha.ok && /^[0-9a-f]{40}/.test(sha.stdout.trim())) {
      await mkdir(join(auxDir, 'root'), { recursive: true });
      await writeFile(join(auxDir, 'root', '.build_sha'), `${sha.stdout.trim()}\n`, 'utf8');
    }
  }
}

export function mockTurn(goal: string, action: Json, plan: { done: string[]; remaining: string[]; openProblems: string[] }): MockTurn {
  const input = toJson({ goal, action, plan });
  return { text: goal, toolCall: { name: PROPOSE_TOOL, input, rawJson: JSON.stringify(input) } };
}

/** solve.sh rewritten to run from W: `/solution` and `$SCRIPT_DIR` point at gold/, container roots at their stand-ins. */
export function rewriteSolveScript(script: string, goldDir: string, map: PathMap): string {
  const withGold = script
    .split('$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)')
    .join(goldDir)
    .split("$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" && pwd)")
    .join(goldDir);
  return rewritePaths(withGold, { ...map, '/solution': goldDir });
}

/** write the rewritten solution script into W, run it, done. */
export function solveTrajectory(solveScript: string): MockTurn[] {
  return [
    mockTurn('Write the solution script', { kind: 'write', path: MOCK_SOLVE_FILE, content: solveScript }, { done: [], remaining: ['run the solution', 'report'], openProblems: [] }),
    mockTurn('Run the solution script', { kind: 'run', command: `bash ${MOCK_SOLVE_FILE}`, timeoutMs: MOCK_RUN_TIMEOUT_MS }, { done: ['wrote the solution script'], remaining: ['report'], openProblems: [] }),
    mockTurn('The solution has been applied', { kind: 'done', summary: 'Ran the solution script.' }, { done: ['wrote the solution script', 'ran the solution'], remaining: [], openProblems: [] }),
  ];
}

export interface TbTaskOptions extends BuildTaskOptions {
  record: TbTaskRecord;
  /** union of verifier_pip_packages over the bench (+ pytest pins) */
  venvPackages: readonly string[];
  /** undefined = create/reuse <runsDir>/tb-venv; null = system python only (tests) */
  venvDir?: string | null;
  /** solve.sh content for the mocked trajectory (read by the loader) */
  solveScript?: string;
}

export function toBenchTask(opts: TbTaskOptions): BenchTask {
  const { record } = opts;
  const map = agentPathMap(opts.workspaceDir, opts.auxDir);
  const task = shimInstruction(record, map);
  const artifacts = record.toml.artifacts.length > 0 ? record.toml.artifacts : record.manifest.artifacts;

  async function evaluateMock(ctx: BenchEvaluateContext): Promise<Evaluation> {
    // mocked verdict: the solution "applied" iff every declared artifact now exists on the agent side
    const missing: string[] = [];
    for (const raw of artifacts) {
      const container = raw.replace(/\/+$/, '') || '/';
      const local = mapContainerPath(container, map);
      if (local === null) continue;
      if (container === '/tmp/agent.patch') {
        const res = await ctx.run('git add -A -N && git status --porcelain', { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 });
        if (!res.ok || res.stdout.trim() === '') missing.push(raw);
        continue;
      }
      if ((await exists(local)) === null) missing.push(raw);
    }
    return missing.length === 0 ? { pass: true, evaluator: 'mock' } : { pass: false, evaluator: 'mock', reason: `artifacts missing: ${missing.join(', ')}` };
  }

  return {
    suite: 'terminal-bench',
    id: record.manifest.name,
    task,
    meta: { instructionShim: true, ...(record.manifest.category !== null ? { category: record.manifest.category } : {}), ...(record.manifest.difficulty !== null ? { difficulty: record.manifest.difficulty } : {}) },
    setup: (workspaceDir, tools) => materialiseWorkspace(record, workspaceDir, opts.auxDir, tools),
    async evaluate(ctx) {
      if (ctx.mocked) return evaluateMock(ctx);
      const venvDir = opts.venvDir === undefined ? await ensureVerifierVenv(ctx.runsDir, opts.venvPackages, ctx.makeRunner, ctx.log) : opts.venvDir;
      return evaluateTerminalBenchLocal({ record, workspaceDir: ctx.workspaceDir, agentMap: map, trialDir: join(ctx.runDir, 'eval', record.manifest.name), makeRunner: ctx.makeRunner, venvDir, log: ctx.log });
    },
    mockTrajectory: () => {
      if (opts.solveScript === undefined || record.goldDir === null) {
        return [mockTurn('No solution available; stop', { kind: 'done', summary: 'no gold solution' }, { done: [], remaining: [], openProblems: ['no gold solution'] })];
      }
      return solveTrajectory(rewriteSolveScript(opts.solveScript, record.goldDir, map));
    },
  };
}

export interface LoadTbOptions {
  mocked: boolean;
  venvDir?: string | null;
}

export async function loadTerminalBenchSources(dataDir: string, opts: LoadTbOptions): Promise<BenchTaskSource[]> {
  const records = await loadTerminalBenchRecords(dataDir);
  const packages = venvPackages(records.map((r) => r.manifest));
  const out: BenchTaskSource[] = [];
  for (const record of records) {
    const solveScript = opts.mocked && record.goldDir !== null ? await readFile(join(record.goldDir, 'solve.sh'), 'utf8').catch(() => undefined) : undefined;
    out.push(sourceFor(record, packages, solveScript, opts.venvDir));
  }
  return out;
}

export function sourceFor(record: TbTaskRecord, packages: readonly string[], solveScript: string | undefined, venvDir: string | null | undefined): BenchTaskSource {
  return {
    suite: 'terminal-bench',
    id: record.manifest.name,
    meta: { instructionShim: true, ...(record.manifest.category !== null ? { category: record.manifest.category } : {}) },
    build(b) {
      const o: TbTaskOptions = { ...b, record, venvPackages: packages };
      if (solveScript !== undefined) o.solveScript = solveScript;
      if (venvDir !== undefined) o.venvDir = venvDir;
      return toBenchTask(o);
    },
  };
}
