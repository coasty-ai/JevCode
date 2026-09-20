import { readFileSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateTerminalBenchLocal, readReward, trialPaths, verifierPathMap } from '../../../src/bench/terminalbench/evaluator.js';
import { MOCK_SOLVE_FILE, agentPathMap, instructionMap, loadTerminalBenchSources, materialiseWorkspace, rewriteSolveScript, shimInstruction, toBenchTask } from '../../../src/bench/terminalbench/loader.js';
import { boundaryPattern, isInstallStep, mapContainerPath, parseCopyArgs, parseDockerfile, resolveDest, rewritePaths, venvPackages } from '../../../src/bench/terminalbench/shim.js';
import { loadTerminalBenchRecords, parseToml, readTaskToml, type TbManifestRecord, type TbTaskRecord } from '../../../src/bench/terminalbench/tasks.js';
import type { BenchSetupTools } from '../../../src/bench/types.js';
import { createFakeSandboxFactory, realExec, tempDir } from './helpers.js';

const FIXTURE = join(process.cwd(), 'test', 'fixtures', 'bench', 'tb-task');
const GOLD = join(process.cwd(), 'test', 'fixtures', 'bench', 'tb-gold');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('path rewrite', () => {
  const map = { '/app': '/W', '/tests': '/T', '/logs/verifier': '/L', '/logs': '/LOGS', '/output': '/O', '/results': '/R', '/tmp/agent.patch': '/L/agent.patch' };
  const table: [string, string][] = [
    ['/app', '/W'],
    ['/app/x', '/W/x'],
    ['"/app/x"', '"/W/x"'],
    ["'/app'", "'/W'"],
    ['/apple', '/apple'],
    ['/apple/x', '/apple/x'],
    ['./app', './app'],
    ['foo/app', 'foo/app'],
    ['x-/app', 'x-/app'],
    ['a/app/x', 'a/app/x'],
    ['cd /app && ls', 'cd /W && ls'],
    ['Path("/app/data"):', 'Path("/W/data"):'],
    ['/tests', '/T'],
    ['/tests/test_outputs.py', '/T/test_outputs.py'],
    ['/logs/verifier/reward.txt', '/L/reward.txt'],
    ['/logs/verifier', '/L'],
    ['/logs/other', '/LOGS/other'],
    ['/output/flight_plan.json', '/O/flight_plan.json'],
    ['/results', '/R'],
    ['/tmp/agent.patch', '/L/agent.patch'],
    ['/tmp/agent.patch.tmp', '/tmp/agent.patch.tmp'],
    ['/tmp/other', '/tmp/other'],
    ['`/app/data/x.json`', '`/W/data/x.json`'],
    ['[/app, /tests]', '[/W, /T]'],
  ];
  it.each(table)('%s -> %s', (input, expected) => {
    expect(rewritePaths(input, map)).toBe(expected);
  });
  it('boundary pattern matches at line ends and is global', () => {
    expect('x /app\ny /app'.replace(boundaryPattern('/app'), 'W')).toBe('x W\ny W');
    expect(mapContainerPath('/app/a/b', map)).toBe('/W/a/b');
    expect(mapContainerPath('/app', map)).toBe('/W');
    expect(mapContainerPath('/apple', map)).toBeNull();
    expect(mapContainerPath('/logs/verifier/ctrf.json', map)).toBe('/L/ctrf.json');
  });
});

describe('dockerfile and toml parsing', () => {
  it('joins continuations, drops comments, parses COPY flags and JSON form', () => {
    const ins = parseDockerfile('# c\nFROM x\nRUN a \\\n  && b\nCOPY --chown=1:1 a b /dst/\nCOPY ["x", "/y"]\nWORKDIR /app\n');
    expect(ins.map((i) => i.cmd)).toEqual(['FROM', 'RUN', 'COPY', 'COPY', 'WORKDIR']);
    expect(ins[1]!.args).toBe('a \n  && b');
    expect(parseCopyArgs(ins[2]!.args)).toEqual({ sources: ['a', 'b'], dest: '/dst/' });
    expect(parseCopyArgs(ins[3]!.args)).toEqual({ sources: ['x'], dest: '/y' });
    expect(parseCopyArgs('--from=builder /a /b')).toBeNull();
    expect(isInstallStep('pip install --no-cache-dir pytest==9.1.1')).toBe(true);
    expect(isInstallStep('uv pip install --system x')).toBe(true);
    expect(isInstallStep('apt-get update && apt-get install -y git')).toBe(true);
    expect(isInstallStep('curl -LsSf https://astral.sh/uv/install.sh | sh')).toBe(true);
    expect(isInstallStep('mkdir -p /app /output')).toBe(false);
    expect(isInstallStep('npm ci')).toBe(false);
    expect(isInstallStep('python /tmp/setup_challenge.py && cd /app && git init -q')).toBe(false);
  });
  it('resolves COPY destinations against WORKDIR, normalises them, then maps them', () => {
    const map = { '/app': '/V', '/output': '/O' };
    expect(resolveDest('./', '/app', map, '/F')).toEqual({ local: '/V', container: '/app' });
    expect(resolveDest('.', '/app', map, '/F')).toEqual({ local: '/V', container: '/app' });
    expect(resolveDest('data/', '/app', map, '/F')).toEqual({ local: '/V/data', container: '/app/data' });
    expect(resolveDest('/output/x.json', '/', map, '/F')).toEqual({ local: '/O/x.json', container: '/output/x.json' });
    expect(resolveDest('/root/data', '/app', map, '/F')).toEqual({ local: '/F/root/data', container: '/root/data' });
    expect(resolveDest('/app/./data/../inputs/', '/app', map, '/F')).toEqual({ local: '/V/inputs', container: '/app/inputs' });
    // a `..` after a mapped prefix must not escape the stand-in: it resolves at container level first
    expect(resolveDest('/app/../etc', '/app', map, '/F')).toEqual({ local: '/F/etc', container: '/etc' });
    expect(resolveDest('../etc', '/app', map, '/F')).toEqual({ local: '/F/etc', container: '/etc' });
  });
  it('parses task.toml (arrays, inline tables, sections, array tables)', () => {
    const t = readTaskToml(readFileSync(join(FIXTURE, 'task.toml'), 'utf8'));
    expect(t.artifacts).toEqual(['/app/prog.py', '/app/result.txt']);
    expect(t.verifierTimeoutSec).toBe(60);
    expect(t.metadata['category']).toBe('Software');
    expect(t.collectCommands).toEqual([]);
    const shadow = readTaskToml(readFileSync(join(process.cwd(), 'bench', 'data', 'terminal-bench', 'tasks', 'shadow-relay', 'task.toml'), 'utf8'));
    expect(shadow.artifacts).toEqual(['/tmp/agent.patch']);
    expect(shadow.collectCommands).toHaveLength(1);
    expect(shadow.collectCommands[0]).toContain('git diff --binary --no-color $base');
    const p = parseToml('a = [1, 2,\n 3]\n[x.y]\nz = "q\\"r"\n[[arr]]\nk = true\n[[arr]]\nk = false\n');
    expect(p).toEqual({ a: [1, 2, 3], x: { y: { z: 'q"r' } }, arr: [{ k: true }, { k: false }] });
  });
  it('loads the checked-in manifest filtered to the 10 present tasks', async () => {
    const records = await loadTerminalBenchRecords(join(process.cwd(), 'bench', 'data'));
    expect(records.map((r) => r.manifest.name).sort()).toEqual(['cargo-flight-dispatch', 'fin-saccr-rwa', 'foodstuff-beta-activity', 'photonic-waveguide-routing', 'production-planning', 'protein-autointerp-disulfide', 'react-lead-form', 'shadow-relay', 'sound-change-cascade', 'wal-recovery-ordering']);
    expect(records.every((r) => r.goldDir !== null && r.toml.verifierTimeoutSec !== null)).toBe(true);
    expect(venvPackages(records.map((r) => r.manifest))).toEqual(expect.arrayContaining(['pytest==9.1.1', 'pytest-json-ctrf==0.5.2', 'openpyxl==3.1.5', 'hypothesis==6.122.3', 'pycryptodome==3.22.0', 'pyyaml==6.0.2']));
    const sources = await loadTerminalBenchSources(join(process.cwd(), 'bench', 'data'), { mocked: true });
    const cargo = sources.find((s) => s.id === 'cargo-flight-dispatch')!.build({ workspaceDir: '/W', auxDir: '/A', mocked: true });
    expect(cargo.task).toContain('`/W/data/airports.json`');
    expect(cargo.task).toContain('python /W/dispatch.py --output /A/output/flight_plan.json');
    expect(cargo.task).not.toContain('/app/');
    expect(cargo.meta.instructionShim).toBe(true);
    const protein = sources.find((s) => s.id === 'protein-autointerp-disulfide')!.build({ workspaceDir: '/W', auxDir: '/A', mocked: true });
    expect(protein.task).toContain('/A/root/data/query_sequences.json');
    const turns = cargo.mockTrajectory();
    expect(turns.map((t) => (t.toolCall!.input as { action: { kind: string } }).action.kind)).toEqual(['write', 'run', 'done']);
    const write = (turns[0]!.toolCall!.input as { action: { path: string; content: string } }).action;
    expect(write.path).toBe(MOCK_SOLVE_FILE);
    expect(write.content).toContain(join(process.cwd(), 'bench', 'data', 'terminal-bench', 'gold', 'cargo-flight-dispatch', 'fix_dispatch.py'));
    expect(write.content).toContain('touch /W/requirements.txt');
    // the container's /solution root is gone; W/solution/... (cargo's third candidate) is a legitimate rewrite
    expect(write.content).not.toMatch(/(?<![\w.\/-])\/solution\//);
  });
});

function fixtureRecord(taskDir = FIXTURE, goldDir: string | null = GOLD): TbTaskRecord {
  const manifest: TbManifestRecord = {
    name: 'synthetic-task',
    category: 'Software',
    subcategory: 'Testing',
    difficulty: null,
    expert_time_estimate_hours: 0.1,
    verifier_timeout_sec: 60,
    artifacts: ['/app/prog.py', '/app/result.txt'],
    env_workdir: '/app',
    env_copy_lines: ['prog.py ./', 'data/ ./data/'],
    env_run_steps_non_install: ['mkdir -p /output && echo seed > /app/seed.txt'],
    verifier_pip_packages: ['pytest==9.1.1', 'pytest-json-ctrf==0.5.2'],
    tests_hardcode_paths: ['/app/prog.py', '/output/result.json', '/logs/verifier/reward.json', '/tests/check.py'],
    local_feasibility: 'unlikely',
    shim_effort: 'low',
  };
  return { manifest, toml: readTaskToml(readFileSync(join(taskDir, 'task.toml'), 'utf8')), taskDir, goldDir, instruction: readFileSync(join(taskDir, 'instruction.md'), 'utf8') };
}

function realTools(root: string, runsDir: string): BenchSetupTools & { makeRunner: (r: string) => ReturnType<BenchSetupTools['makeRunner']> } {
  const sandbox = createFakeSandboxFactory(() => undefined, 'real');
  const makeRunner = (r: string) => {
    const sb = sandbox.create({ workspaceRoot: r, runDir: runsDir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (s) => s });
    return (cmd: string, o: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number; env?: Record<string, string>; onOutput?: (s: 'stdout' | 'stderr', c: string) => void } = {}) =>
      sb.run(cmd, { timeoutMs: o.timeoutMs ?? 15_000, maxOutputBytes: o.maxOutputBytes ?? 65536, signal: new AbortController().signal, ...(o.cwd !== undefined ? { cwd: o.cwd } : {}), ...(o.env !== undefined ? { env: o.env } : {}), ...(o.onOutput !== undefined ? { onOutput: o.onOutput } : {}) });
  };
  return { run: makeRunner(root), makeRunner, mocked: true, runsDir, signal: new AbortController().signal, log: () => undefined };
}

describe('synthetic task end to end (design A)', () => {
  it('materialises W, shims the instruction, runs the gold solution, verifies through the rewritten tests/ and reads reward.json', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const record = fixtureRecord();
    const W = join(t.dir, 'pair', 'workspace');
    const aux = join(t.dir, 'pair', 'aux');
    const tools = realTools(W, join(t.dir, 'runs'));
    await materialiseWorkspace(record, W, aux, tools);
    expect(await readFile(join(W, 'prog.py'), 'utf8')).toContain('41');
    expect(await readFile(join(W, 'data', 'input.json'), 'utf8')).toContain('"x"');
    expect((await readFile(join(W, 'seed.txt'), 'utf8')).trim()).toBe('seed');
    expect((await stat(join(aux, 'output'))).isDirectory()).toBe(true);
    await expect(stat(join(W, 'tests'))).rejects.toThrow();
    await expect(stat(join(W, 'solution'))).rejects.toThrow();

    const map = agentPathMap(W, aux);
    expect(instructionMap(record, map)).toEqual({ '/app': W, '/output': join(aux, 'output') });
    const task = shimInstruction(record, map);
    expect(task).toContain(`\`${W}/prog.py\``);
    expect(task).toContain(`--output ${join(aux, 'output')}/result.json`);
    expect(task).toContain('Do not touch `/apple`');
    expect(task).toContain(`"${W}/x"`);
    expect(task).toContain('`./app` and `foo/app`');
    expect(task).not.toMatch(/(?<![\w./-])\/app(?=[/"'\s:)`]|$)/);

    // the mocked trajectory: write the rewritten solve.sh, run it (here executed directly as the engine would)
    const bench = toBenchTask({ record, workspaceDir: W, auxDir: aux, mocked: true, venvPackages: [], venvDir: null, solveScript: readFileSync(join(GOLD, 'solve.sh'), 'utf8') });
    expect(bench.task).toBe(task);
    const turns = bench.mockTrajectory();
    const write = (turns[0]!.toolCall!.input as { action: { path: string; content: string } }).action;
    expect(write.content).toContain(`SCRIPT_DIR="${GOLD}"`);
    expect(write.content).toContain(`python3 ${GOLD}/helper.py`);
    expect(write.content).toContain(`cp "$SCRIPT_DIR/prog.py" ${W}/prog.py`);
    await writeFile(join(W, write.path), write.content);
    const runCmd = (turns[1]!.toolCall!.input as { action: { command: string } }).action.command;
    const solved = await realExec({ root: W, command: runCmd, cwd: undefined, env: undefined }, { timeoutMs: 15_000, maxOutputBytes: 65536, signal: new AbortController().signal });
    expect(solved.ok).toBe(true);
    expect(await readFile(join(W, 'prog.py'), 'utf8')).toContain('42');

    // mocked evaluator: artifacts present
    const mockCtx = { workspaceDir: W, runDir: join(t.dir, 'runs', 'r1'), runsDir: join(t.dir, 'runs'), run: tools.run, makeRunner: tools.makeRunner, mocked: true, condition: 'jev-on' as const, result: null as never, outcomes: [], patch: null, signal: new AbortController().signal, log: () => undefined };
    expect(await bench.evaluate(mockCtx)).toEqual({ pass: true, evaluator: 'mock' });

    // local verifier: V from tests/Dockerfile + artifacts, rewritten T, shims, reward.json
    const trialDir = join(t.dir, 'runs', 'r1', 'eval', 'synthetic-task');
    const ev = await evaluateTerminalBenchLocal({ record, workspaceDir: W, agentMap: map, trialDir, makeRunner: tools.makeRunner, venvDir: null, log: () => undefined });
    expect(ev).toMatchObject({ pass: true, evaluator: 'local' });
    const p = trialPaths(trialDir);
    expect(JSON.parse(await readFile(join(p.L, 'reward.json'), 'utf8'))).toEqual({ reward: 1 });
    expect((await readFile(join(p.T, 'test.sh'), 'utf8'))).toContain(`python3 ${p.V}/prog.py --output ${p.O}/result.json`);
    expect((await readFile(join(p.T, 'check.py'), 'utf8'))).toContain(`EXPECTED = pathlib.Path("${p.V}/expected/result.json")`);
    expect(await readFile(join(p.T, 'Dockerfile'), 'utf8')).toContain('COPY . /tests/');
    expect(await readFile(join(p.V, 'expected', 'result.json'), 'utf8')).toContain('42');
    expect((await stat(join(p.V, 'prog.py'))).isFile()).toBe(true);
    await expect(stat(join(p.V, 'seed.txt'))).rejects.toThrow(); // not a declared artifact
    await expect(stat(join(p.V, MOCK_SOLVE_FILE))).rejects.toThrow();
    expect((await stat(join(p.L, 'test-stdout.txt'))).isFile()).toBe(true);
    expect(await readReward(p.L)).toEqual({ kind: 'reward', reward: 1, source: 'reward.json' });
    // the verifier map covers every design A stand-in
    expect(Object.keys(verifierPathMap(p))).toEqual(expect.arrayContaining(['/app', '/tests', '/logs/verifier', '/output', '/results', '/tmp/agent.patch']));
  }, 20_000);

  it('unsolved workspace -> reward 0 -> pass false; missing tool -> unsupported-locally; no reward file -> none', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const record = fixtureRecord();
    const W = join(t.dir, 'w');
    const aux = join(t.dir, 'aux');
    const tools = realTools(W, join(t.dir, 'runs'));
    await materialiseWorkspace(record, W, aux, tools);
    await writeFile(join(W, 'result.txt'), 'x');
    const fail = await evaluateTerminalBenchLocal({ record, workspaceDir: W, agentMap: agentPathMap(W, aux), trialDir: join(t.dir, 'e1'), makeRunner: tools.makeRunner, venvDir: null, log: () => undefined });
    expect(fail).toMatchObject({ pass: false, evaluator: 'local' });

    // a variant whose test.sh needs a tool this machine lacks and writes no reward
    const variant = join(t.dir, 'variant');
    await cp(FIXTURE, variant, { recursive: true });
    await writeFile(join(variant, 'tests', 'test.sh'), '#!/bin/bash\nsome_missing_tool_xyz --run /tests/check.py\nexit 0\n');
    await chmod(join(variant, 'tests', 'test.sh'), 0o755);
    const unsupported = await evaluateTerminalBenchLocal({ record: fixtureRecord(variant), workspaceDir: W, agentMap: agentPathMap(W, aux), trialDir: join(t.dir, 'e2'), makeRunner: tools.makeRunner, venvDir: null, log: () => undefined });
    expect(unsupported).toEqual(expect.objectContaining({ pass: null, evaluator: 'none', reason: 'unsupported-locally' }));

    await writeFile(join(variant, 'tests', 'test.sh'), '#!/bin/bash\necho nothing\n');
    const none = await evaluateTerminalBenchLocal({ record: fixtureRecord(variant), workspaceDir: W, agentMap: agentPathMap(W, aux), trialDir: join(t.dir, 'e3'), makeRunner: tools.makeRunner, venvDir: null, log: () => undefined });
    expect(none).toEqual(expect.objectContaining({ pass: null, evaluator: 'none', reason: 'no-reward-file' }));

    await writeFile(join(variant, 'tests', 'test.sh'), '#!/bin/bash\nmkdir -p /logs/verifier\necho 0.5 > /logs/verifier/reward.txt\nexit 1\n');
    const txt = await evaluateTerminalBenchLocal({ record: fixtureRecord(variant), workspaceDir: W, agentMap: agentPathMap(W, aux), trialDir: join(t.dir, 'e4'), makeRunner: tools.makeRunner, venvDir: null, log: () => undefined });
    expect(txt).toMatchObject({ pass: false, evaluator: 'local', evalExitCode: 1, reason: 'reward 0.5 from reward.txt' });
  }, 20_000);

  it('rewriteSolveScript points /solution and SCRIPT_DIR at gold and container roots at their stand-ins', () => {
    const out = rewriteSolveScript('SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\ncp "$SCRIPT_DIR/x" /app/x\npython3 /solution/solve.py > /output/o\n', '/G', { '/app': '/W', '/output': '/O' });
    expect(out).toBe('SCRIPT_DIR="/G"\ncp "$SCRIPT_DIR/x" /W/x\npython3 /G/solve.py > /O/o\n');
  });

  it('a task dir with a missing COPY source fails setup loudly', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const record = fixtureRecord();
    record.manifest.env_copy_lines = ['missing.py ./'];
    await mkdir(join(t.dir, 'w'), { recursive: true });
    await expect(materialiseWorkspace(record, join(t.dir, 'w'), join(t.dir, 'aux'), realTools(join(t.dir, 'w'), join(t.dir, 'runs')))).rejects.toThrow(/does not exist/);
  });
});
