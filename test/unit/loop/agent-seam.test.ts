/**
 * docs/AGENT-LOOP-DESIGN.md §2.2 / §2.3 / §15 S4 — the agent seam end to end through the REAL engine tail: a scripted AgentDriver
 * (the S1 contract only) over a tool-calling fake provider. Each step kind commits a StepRecord with `proposer: 'agent'`, its agent
 * summary and `seqAfter`; observe steps take no images while act steps take pre/post images; no Jev stage runs; the status names
 * the stage that runs NOW; a reply-only run stops `answered`; and the first provider request goes out before any sandbox command.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../../src/core/types.js';
import { percentile } from '../../../src/core/time.js';
import { createEngine } from '../../../src/loop/engine.js';
import type { AgentHarness, Harness } from './fakes.js';
import {
  DEFAULT_LIMITS,
  FIXED_RUN_ID,
  alwaysDecline,
  createFakeDecider,
  createFakeMeter,
  createFakeSandbox,
  createFakeToolProvider,
  createFakeWorkspace,
  createScriptedAgentDriver,
  everyToolUsePaired,
  makeAgentEngine,
  makeEngine,
  passingTests,
  repoState,
  turn,
} from './fakes.js';
import { budgetMs } from '../helpers/perf-budget.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function agent(...args: Parameters<typeof makeAgentEngine>): Promise<AgentHarness> {
  const h = await makeAgentEngine(...args);
  harnesses.push(h);
  return h;
}

/** A runs dir whose root doubles as the workspace, with the fake workspace's files really on disk (the images read them). */
function realFiles(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jevcode-agent-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.py'), 'def f():\n    return 1\n');
  writeFileSync(join(dir, 'tests', 'test_a.py'), 'from src.a import f\n\ndef test_f():\n    assert f() == 2\n');
  return dir;
}

const FIX_TURNS = [
  { text: "I'll read the code and its test first.\n", toolCalls: [{ name: 'read_file', input: { path: 'src/a.py' } }, { name: 'read_file', input: { path: 'tests/test_a.py' } }] },
  { text: 'f() returns 1; the test wants 2.\n', toolCalls: [{ name: 'edit_file', input: { path: 'src/a.py', old_string: 'return 1', new_string: 'return 2' } }] },
  { toolCalls: [{ name: 'bash', input: { command: 'pytest -q' } }] },
  { text: 'Fixed f() so tests/test_a.py passes.' },
];

describe('the agent seam through the real engine tail (§2.2, §15 S4)', () => {
  it('observe → act edit → act test → finish: StepRecords with proposer agent, the kind and seqAfter; complete on the green unscoped run; no Jev', async () => {
    const runsDir = realFiles();
    const git = repoState();
    const h = await agent(FIX_TURNS, {
      runsDir,
      workspace: createFakeWorkspace({ root: runsDir, gitState: git }),
      probeGitState: git,
      sandbox: createFakeSandbox(() => passingTests),
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('complete');
    const end = h.of('run:end')[0]!;
    expect(end.exitCode).toBe(0);
    expect(end.resumable).toBe(false);

    const steps = h.store.steps;
    expect(steps.map((s) => s.agent?.kind)).toEqual(['observe', 'act', 'act', 'finish']);
    expect(steps.every((s) => s.proposer === 'agent')).toBe(true);
    const seqs = steps.map((s) => s.agent!.seqAfter);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(steps[0]!.proposal?.action).toEqual({ kind: 'read', paths: ['src/a.py', 'tests/test_a.py'] });
    expect(steps[0]!.agent!.calls.map((c) => c.name)).toEqual(['read_file', 'read_file']);
    expect(steps[1]!.proposal?.action).toEqual({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' });
    expect(steps[2]!.proposal?.action).toEqual({ kind: 'run', command: 'pytest -q' });
    // §2.2 "test results without Jev": the code judge on the test run; the legacy detector signs nothing
    expect(steps[2]!.judge?.source).toBe('code');
    expect(steps[2]!.judge?.tests).toMatchObject({ source: 'parsed', allPassed: true, passed: 2 });
    expect(steps.every((s) => s.loopSignatures.length === 0)).toBe(true);
    expect(steps[3]!.outcome).toEqual({ status: 'noop', summary: 'Fixed f() so tests/test_a.py passes.' });
    expect(steps[3]!.stoppedAt).toBe('complete');

    // no Jev stage and no Jev request (§9.1 "not emitted in agent mode")
    expect(h.decider.calls).toHaveLength(0);
    for (const type of ['jev:request', 'intent', 'context', 'judge', 'replan', 'risk', 'decision'] as const) expect(h.of(type)).toHaveLength(0);
    expect(h.store.jevRequests).toHaveLength(0);

    // §2.2 "tool results before the checkpoint": observe() ran for act, act and finish (not for the observe step)
    expect(h.driver.observations.map((o) => o.step)).toEqual([2, 3, 4]);
    expect(h.driver.observations[0]!.changedFiles).toEqual(['src/a.py']);
    expect(h.driver.observations[1]!.tests).toMatchObject({ command: 'pytest -q', allPassed: true });

    // §10: the driver's state rides state.json, and the checkpoint's seq covers the last step's records
    const state = h.store.last()!;
    expect(state.mode).toBe('agent');
    expect(state.agentState).toMatchObject({ v: 1, transcriptSeq: seqs[3] });

    // one model turn per generate(); `attempt` is the turn number (§9.1); tool results threaded by id on the next request
    expect(h.of('generator:start').map((e) => e.attempt)).toEqual([1, 2, 3, 4]);
    expect(h.tools.requests).toHaveLength(4);
    for (const req of h.tools.requests) {
      expect(req.messages).toEqual([]);
      expect(everyToolUsePaired(req.agent!.messages)).toBe(true);
    }
    const second = h.tools.requests[1]!.agent!.messages;
    const results = second.flatMap((m) => (m.role === 'user' ? m.content.filter((b) => b.type === 'tool_result') : []));
    expect(results.map((b) => (b.type === 'tool_result' ? b.toolUseId : ''))).toEqual(['call_1_0', 'call_1_1']);
  });

  it('observe steps take no images; act steps take pre/post images (edit targets, the dirty set before a command)', async () => {
    const runsDir = realFiles();
    const git = repoState();
    const h = await agent(FIX_TURNS, {
      runsDir,
      workspace: createFakeWorkspace({ root: runsDir, gitState: git }),
      probeGitState: git,
      sandbox: createFakeSandbox(() => passingTests),
    });
    await h.engine.run();
    const runDir = join(runsDir, FIXED_RUN_ID);
    expect(existsSync(join(runDir, 'pre', '1'))).toBe(false);
    expect(existsSync(join(runDir, 'post', '1.json'))).toBe(false);
    expect(h.store.steps[0]!.timing.imagesMs).toBeUndefined();
    expect(existsSync(join(runDir, 'pre', '2'))).toBe(true);
    expect(existsSync(join(runDir, 'post', '2.json'))).toBe(true);
    expect(h.store.steps[1]!.timing.imagesMs).toBeGreaterThanOrEqual(0);
    // the command's pre-image copies the dirty set (the edited file)
    expect(existsSync(join(runDir, 'pre', '3'))).toBe(true);
    expect(existsSync(join(runDir, 'pre', '4'))).toBe(false);
  });

  it('agent mode emits the status at stage START, so the status row names what runs now; legacy modes do not', async () => {
    const h = await agent([{ text: 'Hello! How can I help?' }]);
    await h.engine.run();
    const i = h.events.findIndex((e) => e.type === 'stage:start');
    expect(i).toBeGreaterThanOrEqual(0);
    const after = h.events[i + 1] as EngineEvent;
    expect(after.type).toBe('status');
    if (after.type === 'status') expect(after.status.stage).toBe('propose');

    const legacy = await makeEngine({ mode: 'jev-off', turns: [turn({ kind: 'done', summary: 'x' })] });
    harnesses.push(legacy);
    await legacy.engine.run();
    const j = legacy.events.findIndex((e) => e.type === 'stage:start');
    expect(legacy.events[j + 1]!.type).not.toBe('status');
  });

  it('§A1: a prose-only reply stops `answered` (exit 0, not resumable), with no harness verify and no sandbox command', async () => {
    const h = await agent([{ text: 'Hi! I am JevCode.\nAsk me to change something in this workspace.' }], { driver: { verify: true } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('answered');
    const end = h.of('run:end')[0]!;
    expect(end.exitCode).toBe(0);
    expect(end.resumable).toBe(false);
    expect(h.sandbox.commands).toEqual([]);
    expect(h.store.steps.map((s) => s.agent?.kind)).toEqual(['finish']);
    expect(h.store.steps[0]!.agent!.calls).toEqual([]);
    // the prose streamed as raw deltas, exactly as the legacy contract has it
    expect(h.of('generator:delta').map((e) => e.text).join('')).toBe('Hi! I am JevCode.\nAsk me to change something in this workspace.');
  });

  it('an agent follow-up carries a seed without the legacy `seeded from run …: plan done=… · window …` notice; a legacy run still prints it', async () => {
    const seed = {
      parentRunId: '20260923-235400-c2x5negk',
      plan: { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [] },
      window: [],
      createdThisRun: [],
      lastTestRun: null,
      undoLog: [],
      pinnedFiles: [],
    };
    const h = await agent([{ text: 'Sure.' }], { engine: { seed } });
    await h.engine.run();
    expect(h.of('notice').filter((n) => n.kind === 'seeded')).toEqual([]);
    const legacy = await makeEngine({ turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 1 }, engine: { seed } });
    harnesses.push(legacy);
    await legacy.engine.run();
    expect(legacy.of('notice').filter((n) => n.kind === 'seeded').map((n) => n.text)).toEqual(['seeded from run 20260923-235400-c2x5negk: plan done=0 remaining=0 unverified=0 · window 0 entries · 0 created files']);
  });

  it('a run that used a tool and then answered stops generator_done, never `answered`', async () => {
    const h = await agent([{ toolCalls: [{ name: 'read_file', input: { path: 'src/a.py' } }] }, { text: 'f() returns 1.' }]);
    const r = await h.engine.run();
    expect(r.stopReason).toBe('generator_done');
    expect(h.of('run:end')[0]!.exitCode).toBe(0);
  });

  it('without an injected driver the run loads the real driver from src/agent/index.ts (the S1 stub is gone)', async () => {
    const h = await makeEngine({ mode: 'agent', autonomyDefault: true });
    harnesses.push(h);
    const r = await h.engine.run();
    // the default fake provider repeats one legacy reply; the real driver's loop detector ends it as `stuck` (§3.6) — never the stub's ConfigError
    expect(r.stopReason).not.toBe('error');
    expect(h.of('error').some((e) => e.error.message.includes('agent mode is not built yet'))).toBe(false);
  });

  it('§A1: the first provider request goes out before any sandbox command, workspace listing or extra git read; harness time p95 ≤ 50 ms', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 12; i++) {
      const workspace = createFakeWorkspace({ gitState: repoState() });
      let listings = 0;
      const list = workspace.listCandidates.bind(workspace);
      workspace.listCandidates = async () => {
        listings += 1;
        return list();
      };
      const h = await agent([{ text: 'Hello!' }], { workspace, probeGitState: repoState() });
      let atFirstRequest: { commands: number; listings: number } | null = null;
      h.tools.generate = ((inner) => async (req, o) => {
        atFirstRequest ??= { commands: h.sandbox.commands.length, listings };
        return inner(req, o);
      })(h.tools.generate.bind(h.tools));
      const t0 = performance.now();
      await h.engine.run();
      expect(atFirstRequest).toEqual({ commands: 0, listings: 0 });
      samples.push(h.tools.firstRequestAt! - t0);
    }
    // the first run pays module warm-up; the gate is on the steady state
    const steady = samples.slice(2);
    const p95 = percentile(steady, 95) ?? Number.POSITIVE_INFINITY;
    const p50 = percentile(steady, 50) ?? Number.POSITIVE_INFINITY;
    console.info(`agent seam: run() → first generate() harness time p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms over ${steady.length} runs`);
    expect(p95).toBeLessThanOrEqual(budgetMs(50));
  });

  it('§A1: createEngine() → run() → first generate() with the REAL checkpoint store, workspace and sandbox (a git repo on disk): p95 ≤ 50 ms', async () => {
    const samples: number[] = [];
    const runOnly: number[] = [];
    for (let i = 0; i < 8; i++) {
      const root = mkdtempSync(join(tmpdir(), 'jevcode-agent-real-'));
      const ws = join(root, 'ws');
      mkdirSync(join(ws, 'src'), { recursive: true });
      writeFileSync(join(ws, 'package.json'), '{"name":"x","type":"module","scripts":{"test":"node --test"}}\n');
      writeFileSync(join(ws, 'src', 'math.js'), 'export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\n');
      // a committed repository, as a real workspace is (the harness's git probe is part of what is timed)
      const git = (...args: string[]): void => void execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: ws, stdio: 'ignore' });
      git('init', '-q');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      const tools = createFakeToolProvider([{ text: 'Hello!' }]);
      // the clock starts BEFORE createEngine: the store, the workspace probe and the sandbox are the part of the harness that costs
      const t0 = performance.now();
      const engine = await createEngine({
        task: 'hi',
        mode: 'agent',
        workspace: ws,
        runsDir: join(root, 'runs'),
        provider: tools,
        decider: createFakeDecider(),
        confirmer: alwaysDecline,
        meter: createFakeMeter(2),
        limits: DEFAULT_LIMITS,
        sandboxProfile: 'none',
        noNetwork: false,
        configRecord: {},
        redact: (s) => s,
        secretPaths: [],
        generation: { temperature: null, maxTokens: 4096 },
        deciderModel: { configured: 'typesafe/jev-1.13-20260917', pinned: true },
        agent: createScriptedAgentDriver(),
      });
      const t1 = performance.now();
      const r = await engine.run();
      expect(r.stopReason).toBe('answered');
      samples.push(tools.firstRequestAt! - t0);
      runOnly.push(tools.firstRequestAt! - t1);
      rmSync(root, { recursive: true, force: true });
    }
    const steady = samples.slice(2);
    const p95 = percentile(steady, 95) ?? Number.POSITIVE_INFINITY;
    const p50 = percentile(steady, 50) ?? Number.POSITIVE_INFINITY;
    const runP95 = percentile(runOnly.slice(2), 95) ?? Number.POSITIVE_INFINITY;
    console.info(`agent seam (real store/workspace/sandbox, git repo): createEngine() → first generate() p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms over ${steady.length} runs (run() → first generate() p95 ${runP95.toFixed(2)} ms)`);
    expect(p95).toBeLessThanOrEqual(budgetMs(50));
  });
});
