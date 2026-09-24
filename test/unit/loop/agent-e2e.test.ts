/**
 * docs/AGENT-LOOP-DESIGN.md §15 S6 — the agent loop end to end with nothing scripted but the model: the REAL engine, the REAL driver
 * (src/agent, loaded by the seam when no driver is injected), the REAL checkpoint store, workspace and sandbox (profile `none`, so
 * `npm test` really runs `node --test`), and the mock provider (src/provider/mock.ts) answering with native tool calls that carry ids.
 * No Jev key: the decider is `createAbsentDecider()`, as a session builds it when no Jev key resolves (§14.2).
 *
 * The workspace is a failing node:test project (`mean` divides by `length - 1`). The model reads the code and its test in ONE turn
 * (two parallel `read_file` calls → one observe step), edits the bug (an act step), runs the detected test command (`npm test`, an act
 * step whose green unscoped run is current) and answers — the run stops `complete` (exit 0), every tool result is threaded back by
 * its call id on the next request's `agent.messages`, and not one `jev:request` is made. A greeting is one prose-only turn that stops
 * `answered` in one step with no sandbox command.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage, EngineEvent, GenerateRequest, GitState, MockTurn } from '../../../src/core/types.js';
import { createAbsentDecider } from '../../../src/jev/absent.js';
import { createEngine } from '../../../src/loop/engine.js';
import { createMockProvider, type MockProvider } from '../../../src/provider/mock.js';
import { applyUndo, prepareUndo } from '../../../src/undo/apply.js';
import { probeGitState } from '../../../src/workspace/gitstate.js';
import { DEFAULT_LIMITS, alwaysDecline, createFakeMeter, everyToolUsePaired } from './fakes.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const BUGGY = 'export function mean(xs) {\n  return xs.reduce((a, b) => a + b, 0) / (xs.length - 1);\n}\n';
const TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { mean } from '../src/math.js';\n\ntest('mean of 1, 2, 3 is 2', () => {\n  assert.equal(mean([1, 2, 3]), 2);\n});\n";

/** a committed git workspace whose `npm test` (`node --test`) fails on the `mean` bug */
function failingNodeWorkspace(): { root: string; ws: string } {
  const root = mkdtempSync(join(tmpdir(), 'jevcode-agent-e2e-'));
  roots.push(root);
  const ws = join(root, 'ws');
  mkdirSync(join(ws, 'src'), { recursive: true });
  mkdirSync(join(ws, 'test'), { recursive: true });
  writeFileSync(join(ws, 'package.json'), '{\n  "name": "e2e",\n  "private": true,\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n');
  writeFileSync(join(ws, 'src', 'math.js'), BUGGY);
  writeFileSync(join(ws, 'test', 'math.test.js'), TEST);
  const git = (...args: string[]): void => void execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: ws, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { root, ws };
}

const USAGE = { inputTokens: 1200, outputTokens: 150, costUsd: 0, calls: 1 } as const;
const call = (id: string, name: string, input: Record<string, string>): NonNullable<MockTurn['toolCalls']>[number] => ({ id, name, input, rawJson: JSON.stringify(input) });

/** the model's four turns: parallel reads, the edit, the detected test command, the answer */
const FIX_TURNS: MockTurn[] = [
  { text: "I'll read the function and its test first.\n", toolCalls: [call('call_read_src', 'read_file', { path: 'src/math.js' }), call('call_read_test', 'read_file', { path: 'test/math.test.js' })], usage: USAGE, stopReason: 'tool_use' },
  { text: '`mean` divides by `xs.length - 1`; it should divide by `xs.length`.\n', toolCalls: [call('call_edit', 'edit_file', { path: 'src/math.js', old_string: '/ (xs.length - 1)', new_string: '/ xs.length' })], usage: USAGE, stopReason: 'tool_use' },
  { toolCalls: [call('call_test', 'bash', { command: 'npm test', description: 'run the tests' })], usage: USAGE, stopReason: 'tool_use' },
  { text: 'Fixed `mean` in src/math.js: it divides by the length now, and `npm test` passes.', usage: USAGE, stopReason: 'end_turn' },
];

async function run(ws: string, root: string, task: string, turns: MockTurn[] | ((req: GenerateRequest, i: number) => MockTurn), parentRunId?: string, extra: { gitState?: GitState; probes?: { n: number; done: boolean } } = {}): Promise<{ result: Awaited<ReturnType<Awaited<ReturnType<typeof createEngine>>['run']>>; events: EngineEvent[]; provider: MockProvider }> {
  const provider = createMockProvider({ turns }, { recordRequests: true });
  const probes = extra.probes;
  const engine = await createEngine({
    task,
    mode: 'agent',
    workspace: ws,
    runsDir: join(root, 'runs'),
    provider,
    decider: createAbsentDecider(),
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
    // a chat follow-up: the session carries its newest run (src/cli/session.ts)
    ...(parentRunId !== undefined ? { conversation: { chat: [], parent: { runId: parentRunId, runDir: join(root, 'runs', parentRunId), mode: 'agent' as const } } } : {}),
    ...(extra.gitState !== undefined ? { gitState: extra.gitState } : {}),
  }, probes !== undefined ? { probeGitState: async (r: string) => {
    probes.n += 1;
    // a slow probe (a big repository): the first request must not wait for it
    const g = await probeGitState(r);
    await new Promise((res) => setTimeout(res, 150));
    probes.done = true;
    return g;
  } } : {});
  const events: EngineEvent[] = [];
  engine.events.onAny((e) => events.push(e));
  const result = await engine.run();
  return { result, events, provider };
}

const of = <T extends EngineEvent['type']>(events: EngineEvent[], type: T): Extract<EngineEvent, { type: T }>[] => events.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type);
const toolResultIds = (req: GenerateRequest | undefined): string[] =>
  (req?.agent?.messages ?? []).flatMap((m: AgentMessage) => (m.role === 'user' ? m.content.flatMap((b) => (b.type === 'tool_result' ? [b.toolUseId] : [])) : []));
const toolUseIds = (req: GenerateRequest | undefined): string[] =>
  (req?.agent?.messages ?? []).flatMap((m: AgentMessage) => (m.role === 'assistant' ? m.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])) : []));

describe('the agent loop end to end: real engine, real driver, mock provider, a failing node:test workspace (§15 S6)', () => {
  it('parallel reads in one observe step → an edit → the detected test command → complete; results threaded by id; zero jev:request', async () => {
    const { root, ws } = failingNodeWorkspace();
    // the precondition: the workspace's own test command fails before the run
    expect(spawnSync('npm', ['test'], { cwd: ws, encoding: 'utf8' }).status).not.toBe(0);

    const t0 = Date.now();
    const { result, events, provider } = await run(ws, root, 'the mean function in src/math.js is wrong; fix it so the tests pass', FIX_TURNS);

    // the stop: `complete` after a current green run of the UNSCOPED detected command (§3.3), exit 0
    expect(result.mode).toBe('agent');
    expect(result.stopReason).toBe('complete');
    const end = of(events, 'run:end')[0]!;
    expect(end.exitCode).toBe(0);
    expect(readFileSync(join(ws, 'src', 'math.js'), 'utf8')).toBe('export function mean(xs) {\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\n');
    expect(spawnSync('npm', ['test'], { cwd: ws, encoding: 'utf8' }).status).toBe(0);

    // one step per segment: the two reads are ONE observe step; the edit and the test run are act steps; the answer finishes
    const steps = of(events, 'step:end').map((e) => e.record);
    expect(steps.map((s) => s.agent?.kind)).toEqual(['observe', 'act', 'act', 'finish']);
    expect(steps.every((s) => s.proposer === 'agent')).toBe(true);
    expect(steps[0]!.agent!.calls.map((c) => c.name)).toEqual(['read_file', 'read_file']);
    expect(steps[0]!.proposal?.action).toEqual({ kind: 'read', paths: ['src/math.js', 'test/math.test.js'] });
    expect(steps[1]!.proposal?.action).toEqual({ kind: 'edit', path: 'src/math.js', old: '/ (xs.length - 1)', new: '/ xs.length' });
    expect(steps[2]!.proposal?.action).toMatchObject({ kind: 'run', command: 'npm test' });
    expect(steps[2]!.judge?.tests).toMatchObject({ allPassed: true, passed: 1, failed: 0 });
    expect(steps[3]!.stoppedAt).toBe('complete');

    // both reads were announced before either result landed: they ran in parallel inside the observe step (§4.1)
    const turn1 = events.filter((e) => (e.type === 'tool:call' || e.type === 'tool:result') && e.turn === 1).map((e) => `${e.type}:${e.type === 'tool:call' || e.type === 'tool:result' ? e.id : ''}`);
    expect(turn1.slice(0, 2)).toEqual(['tool:call:call_read_src', 'tool:call:call_read_test']);
    expect(turn1.filter((t) => t.startsWith('tool:result'))).toHaveLength(2);

    // four model turns; each request carries the whole conversation with every tool_use paired to its tool_result BY ID
    expect(provider.requests).toHaveLength(4);
    for (const req of provider.requests) {
      expect(req.agent).toBeDefined();
      expect(everyToolUsePaired(req.agent!.messages)).toBe(true);
    }
    expect(toolResultIds(provider.requests[0])).toEqual([]);
    expect(toolResultIds(provider.requests[1])).toEqual(['call_read_src', 'call_read_test']);
    expect(toolResultIds(provider.requests[2])).toEqual(['call_read_src', 'call_read_test', 'call_edit']);
    expect(toolResultIds(provider.requests[3])).toEqual(['call_read_src', 'call_read_test', 'call_edit', 'call_test']);
    expect(toolUseIds(provider.requests[3])).toEqual(['call_read_src', 'call_read_test', 'call_edit', 'call_test']);
    // the read results carry the file text; the test result carries the run's pass line
    const results = (provider.requests[3]!.agent!.messages).flatMap((m) => (m.role === 'user' ? m.content.flatMap((b) => (b.type === 'tool_result' ? [b] : [])) : []));
    const text = (id: string): string => JSON.stringify(results.find((b) => b.toolUseId === id));
    expect(text('call_read_src')).toContain('xs.length - 1');
    expect(text('call_test')).toMatch(/pass/);

    // the prose streamed (raw deltas) and committed as lines; no Jev anywhere — no key, no request, no Jev stage
    expect(of(events, 'generator:delta').map((e) => e.text).join('')).toContain("I'll read the function and its test first.");
    expect(of(events, 'assistant:text').some((e) => e.text.includes('Fixed `mean` in src/math.js'))).toBe(true);
    expect(of(events, 'jev:request')).toHaveLength(0);
    for (const type of ['intent', 'context', 'judge', 'replan', 'risk', 'decision'] as const) expect(of(events, type), type).toHaveLength(0);

    // the transcript's `at` stamps are wall-clock times of this run (the engine's clock is monotonic: the S6 live transcripts read 1970-01-01T00:00:07Z)
    const records = readFileSync(join(root, 'runs', result.runId, 'agent', 'transcript.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { at: string });
    expect(records.length).toBeGreaterThan(4);
    for (const r of records) {
      expect(Date.parse(r.at), r.at).toBeGreaterThanOrEqual(t0 - 1_000);
      expect(Date.parse(r.at), r.at).toBeLessThanOrEqual(Date.now() + 1_000);
    }
  }, 60_000);

  it('§A2 / §A5 git_discard under full autonomy: the discard runs, its note is true, its step lists the files it put back, and /undo restores the modified AND the untracked file (S6 live L7c)', async () => {
    const { root, ws } = failingNodeWorkspace();
    // HEAD's tests pass, so the harness verify is green and the run completes; then the user's own uncommitted work
    const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: ws, encoding: 'utf8' });
    writeFileSync(join(ws, 'src', 'math.js'), BUGGY.replace('(xs.length - 1)', 'xs.length'));
    git('commit', '-q', '-am', 'fix');
    writeFileSync(join(ws, 'src', 'math.js'), `${BUGGY.replace('(xs.length - 1)', 'xs.length')}// my local note\n`);
    writeFileSync(join(ws, 'notes.txt'), 'my untracked notes\n');
    const turns: MockTurn[] = [
      { text: 'Discarding the local changes.\n', toolCalls: [call('call_discard', 'bash', { command: 'git reset --hard && git clean -fd', description: 'discard' })], usage: USAGE, stopReason: 'tool_use' },
      { text: 'Discarded: the edit to src/math.js and the untracked notes.txt.', usage: USAGE, stopReason: 'end_turn' },
      { text: 'The tests passed.', usage: USAGE, stopReason: 'end_turn' },
    ];
    const { result, events } = await run(ws, root, 'discard all local changes with git reset --hard and git clean -fd', turns);
    expect(result.stopReason).toBe('complete');
    expect(readFileSync(join(ws, 'src', 'math.js'), 'utf8')).not.toContain('my local note');
    expect(() => readFileSync(join(ws, 'notes.txt'), 'utf8')).toThrow();

    // nothing refused or asked; the note says what /undo can do, and it is true
    const notes = of(events, 'transcript').map((e) => e.text).filter((t) => t.startsWith('destructive'));
    expect(notes).toEqual(['destructive · ran git reset --hard && git clean -fd (rule git_discard) — /undo restores the workspace']);
    // the step's outcome lists what the command put back — /undo and /rewind pick the step from it (it was [] before S6c)
    const discard = of(events, 'step:end').map((e) => e.record).find((r) => r.proposal?.action.kind === 'run' && r.proposal.action.command.startsWith('git reset'))!;
    expect(discard.outcome?.status).toBe('executed');
    expect(discard.outcome?.status === 'executed' ? [...discard.outcome.changedFiles].sort() : []).toEqual(['notes.txt', 'src/math.js']);

    // /undo of that step brings both back
    const runDir = join(root, 'runs', result.runId);
    const head = git('rev-parse', 'HEAD').trim();
    const prepared = await prepareUndo(runDir, discard.step, { root: ws, headOid: head, git: true });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const undone = await applyUndo(prepared.plan, { runDir, runId: result.runId, root: ws });
    expect([...undone.restored].sort()).toEqual(['notes.txt', 'src/math.js']);
    expect(readFileSync(join(ws, 'src', 'math.js'), 'utf8')).toContain('// my local note');
    expect(readFileSync(join(ws, 'notes.txt'), 'utf8')).toBe('my untracked notes\n');
  }, 60_000);

  it('a run that fails on its first turn still carries the conversation: the next message sees run 1 and its own failed message (S6 review carry hole)', async () => {
    const { root, ws } = failingNodeWorkspace();
    const r1 = await run(ws, root, 'my name is Zanzibar', [{ text: 'Nice to meet you, Zanzibar.', usage: USAGE, stopReason: 'end_turn' }]);
    expect(r1.result.stopReason).toBe('answered');
    // run 2: the provider refuses its first request (a 4xx) — the run ends before any step
    const r2 = await run(ws, root, 'what is 2 + 2?', () => ({ error: { status: 400, retryable: false } }), r1.result.runId);
    expect(r2.result.stopReason).toBe('error');
    // its head was checkpointed at once
    const state2 = JSON.parse(readFileSync(join(root, 'runs', r2.result.runId, 'state.json'), 'utf8')) as { state?: { agentState?: { transcriptSeq?: number } } };
    expect(state2.state?.agentState?.transcriptSeq).toBeGreaterThan(0);
    // run 3 carries run 2, whose head carries run 1: the request sees both earlier messages and the reply
    const r3 = await run(ws, root, 'try again', [{ text: "Hi Zanzibar — 2 + 2 is 4.", usage: USAGE, stopReason: 'end_turn' }], r2.result.runId);
    expect(r3.result.stopReason).toBe('answered');
    const sent = JSON.stringify(r3.provider.requests[0]!.agent!.messages);
    expect(sent).toContain('my name is Zanzibar');
    expect(sent).toContain('Nice to meet you, Zanzibar.');
    expect(sent).toContain('what is 2 + 2?');
    expect(sent).toContain('try again');
  }, 60_000);

  it('the carry follows a parent that never checkpointed a driver state back through its `carry` record', async () => {
    const { root, ws } = failingNodeWorkspace();
    const r1 = await run(ws, root, 'my name is Zanzibar', [{ text: 'Nice to meet you, Zanzibar.', usage: USAGE, stopReason: 'end_turn' }]);
    const r2 = await run(ws, root, 'what is 2 + 2?', () => ({ error: { status: 400, retryable: false } }), r1.result.runId);
    // a run that died before its checkpoint landed (a crash, or a build from before the head was checkpointed at once)
    const file = join(root, 'runs', r2.result.runId, 'state.json');
    const envelope = JSON.parse(readFileSync(file, 'utf8')) as { state: Record<string, unknown> };
    delete envelope.state['agentState'];
    writeFileSync(file, JSON.stringify(envelope));
    const r3 = await run(ws, root, 'try again', [{ text: 'Hi Zanzibar.', usage: USAGE, stopReason: 'end_turn' }], r2.result.runId);
    const sent = JSON.stringify(r3.provider.requests[0]!.agent!.messages);
    expect(sent).toContain('my name is Zanzibar');
    expect(sent).toContain('try again');
  }, 60_000);

  it('a native call with no name is recorded under a wire-safe name: every later request of the run and of a carried follow-up is valid (S6 review)', async () => {
    const { root, ws } = failingNodeWorkspace();
    // the mock enforces the adapters' wire rules (http.ts messagesError), so a `''` name would fail request 2 here
    const r1 = await run(ws, root, 'show src/math.js', [
      { text: 'Reading.\n', toolCalls: [{ id: 'c1', name: '', input: { path: 'src/math.js' }, rawJson: '{"path":"src/math.js"}' }], usage: USAGE, stopReason: 'tool_use' },
      { text: 'It computes the mean.', usage: USAGE, stopReason: 'end_turn' },
    ]);
    expect(r1.result.stopReason).not.toBe('error');
    expect(r1.provider.requests).toHaveLength(2);
    const blocks = r1.provider.requests[1]!.agent!.messages.flatMap((m) => m.content as readonly { type: string; name?: string; content?: string }[]);
    expect(blocks.find((b) => b.type === 'tool_use')?.name).toBe('invalid_tool');
    const result = blocks.find((b) => b.type === 'tool_result');
    expect(result?.name).toBe('invalid_tool');
    expect(result?.content).toContain('UNKNOWN TOOL (the call had no name)');
    // the transcript itself records the wire-safe name (a resumed run and a carry read it back)
    const recs = readFileSync(join(root, 'runs', r1.result.runId, 'agent', 'transcript.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; calls?: { name: string }[]; name?: string });
    expect(recs.find((r) => r.kind === 'assistant')?.calls?.[0]?.name).toBe('invalid_tool');
    expect(recs.find((r) => r.kind === 'result')?.name).toBe('invalid_tool');
    // the follow-up carries run 1's records and is valid on the wire too
    const r2 = await run(ws, root, 'thanks', [{ text: 'You are welcome.', usage: USAGE, stopReason: 'end_turn' }], r1.result.runId);
    expect(r2.result.stopReason).toBe('answered');
    expect(JSON.stringify(r2.provider.requests[0]!.agent!.messages)).toContain('invalid_tool');
  }, 60_000);

  it('§A1: a provider error the same request would hit again (a 404: a wrong model id) ends the run at the first failed turn — one request, one step, no three-failure streak (S6 review)', async () => {
    const { root, ws } = failingNodeWorkspace();
    const { result, events, provider } = await run(ws, root, 'hi', () => ({ error: { status: 404, retryable: false } }));
    expect(result.stopReason).toBe('error');
    expect(provider.requests).toHaveLength(1);
    expect(of(events, 'step:end')).toHaveLength(1);
    expect(of(events, 'error')).toHaveLength(1);
    expect(result.error?.code).toBe('provider_http');
    // a transient one before the first committed step stops too (the chat's one retry is the session's)
    const t = await run(ws, root, 'hi', () => ({ error: { status: 503, retryable: true } }));
    expect(t.result.stopReason).toBe('error');
    expect(t.provider.requests).toHaveLength(1);
  }, 60_000);

  it('§A1: a transient provider error after the run has made progress keeps the stage-failure streak — a long task survives a blip', async () => {
    const { root, ws } = failingNodeWorkspace();
    const turns: MockTurn[] = [
      { text: 'Reading.\n', toolCalls: [call('c1', 'read_file', { path: 'src/math.js' })], usage: USAGE, stopReason: 'tool_use' },
      { error: { status: 503, retryable: true } },
      { text: 'It computes the mean of a list.', usage: USAGE, stopReason: 'end_turn' },
    ];
    const { result, provider } = await run(ws, root, 'what does src/math.js do?', turns);
    expect(result.stopReason).toBe('generator_done');
    expect(provider.requests).toHaveLength(3);
  }, 60_000);

  it('§A1 latency: a run started from the session\'s cached git probe spawns no probe before the first request, and adopts the fresh one before any call — a discard of edits made after the cached probe is still judged, pre-imaged and undoable', async () => {
    const { root, ws } = failingNodeWorkspace();
    const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: ws, encoding: 'utf8' });
    writeFileSync(join(ws, 'src', 'math.js'), BUGGY.replace('(xs.length - 1)', 'xs.length'));
    git('commit', '-q', '-am', 'fix');
    // the session's probe, taken while the tree was clean …
    const stale = await probeGitState(ws);
    expect(stale.dirty.entries).toEqual([]);
    // … then the human edits in their editor between two messages
    writeFileSync(join(ws, 'src', 'math.js'), `${BUGGY.replace('(xs.length - 1)', 'xs.length')}// my local note\n`);
    writeFileSync(join(ws, 'notes.txt'), 'my untracked notes\n');
    const probes = { n: 0, done: false };
    let probesAtFirstRequest = -1;
    let probeDoneAtFirstRequest = true;
    const turns = (_req: GenerateRequest, i: number): MockTurn => {
      if (i === 0) {
        probesAtFirstRequest = probes.n;
        probeDoneAtFirstRequest = probes.done;
      }
      if (i === 0) return { text: 'Discarding.\n', toolCalls: [call('call_discard', 'bash', { command: 'git reset --hard && git clean -fd', description: 'discard' })], usage: USAGE, stopReason: 'tool_use' };
      return { text: 'Discarded the local changes.', usage: USAGE, stopReason: 'end_turn' };
    };
    const { result, events } = await run(ws, root, 'discard all local changes', turns, undefined, { gitState: stale, probes });
    // the only probe is the background one, started beside the first request (not awaited before it)
    expect(probes.n).toBe(1);
    expect(probesAtFirstRequest).toBe(1);
    expect(probeDoneAtFirstRequest).toBe(false);
    // the fresh probe decided: the discard is `git_discard` and its note is true
    expect(of(events, 'transcript').map((e) => e.text).filter((t) => t.startsWith('destructive'))).toEqual(['destructive · ran git reset --hard && git clean -fd (rule git_discard) — /undo restores the workspace']);
    const discard = of(events, 'step:end').map((e) => e.record).find((r) => r.proposal?.action.kind === 'run')!;
    const runDir = join(root, 'runs', result.runId);
    const prepared = await prepareUndo(runDir, discard.step, { root: ws, headOid: git('rev-parse', 'HEAD').trim(), git: true });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    await applyUndo(prepared.plan, { runDir, runId: result.runId, root: ws });
    expect(readFileSync(join(ws, 'src', 'math.js'), 'utf8')).toContain('// my local note');
    expect(readFileSync(join(ws, 'notes.txt'), 'utf8')).toBe('my untracked notes\n');
  }, 60_000);

  it('a greeting is one prose-only turn: stop `answered` (exit 0) in one step, no tool call, no sandbox command, no jev:request', async () => {
    const { root, ws } = failingNodeWorkspace();
    const { result, events, provider } = await run(ws, root, 'hi', [{ text: "Hi! I'm JevCode. Tell me what to change in this workspace.", usage: USAGE, stopReason: 'end_turn' }]);
    expect(result.stopReason).toBe('answered');
    expect(of(events, 'run:end')[0]!.exitCode).toBe(0);
    const steps = of(events, 'step:end').map((e) => e.record);
    expect(steps.map((s) => s.agent?.kind)).toEqual(['finish']);
    expect(steps[0]!.agent!.calls).toEqual([]);
    expect(provider.requests).toHaveLength(1);
    expect(of(events, 'tool:call')).toHaveLength(0);
    expect(of(events, 'jev:request')).toHaveLength(0);
    // the workspace is untouched
    expect(readFileSync(join(ws, 'src', 'math.js'), 'utf8')).toBe(BUGGY);
  }, 60_000);
});
