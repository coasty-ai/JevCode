/**
 * TUI-DESIGN §19.4 engine/session integration: run:ready and the workspace event, the seed (§8.3) and the step-1 rule (b),
 * planAfter (§8.7), run.json session fields and VERSION (§15 item 10), the createEngine order with the probe handed to the
 * sandbox and the workspace (§12.1), the HEAD-drift warning (§12.2), run.lock (§8.5), confirmDetailed (§6.4), run:end's
 * extension fields (§13.5), the loop team's three requests, bench source, and the parity replay (§15.1, §15.3).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent, EngineSeed, GitState, JsonObject } from '../../../src/core/types.js';
import { ConfigError } from '../../../src/errors.js';
import { alwaysDecline as benchDecline, buildEngineOptions } from '../../../src/bench/conditions.js';
import { createFakeMeter as benchMeter } from './fakes.js';
import { readRunLock } from '../../../src/session/lock.js';
import { seedNoticeText } from '../../../src/session/seed.js';
import { formatTranscriptItem, itemsFromEvent } from '../../../src/tui/plain.js';
import { VERSION } from '../../../src/version.js';
import type { Harness } from './fakes.js';
import { FIXED_RUN_ID, answer, createFakeProvider, createFakeSandbox, createFakeWorkspace, detailedConfirmer, failingTests, intentIs, makeEngine, noRepoState, noulA, passingTests, repoState, riskAll, turn } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}
const read = () => turn({ kind: 'read', paths: ['src/a.py'] });

function seedOf(over: Partial<EngineSeed> = {}): EngineSeed {
  return {
    parentRunId: '20260919-100000-aaaaaaaa',
    plan: { done: [{ text: 'read the code', evidence: { step: 2, judged: 0.9 } }], remaining: ['fix f', 'run tests'], unverified: [], openProblems: ['stale problem'], harnessProblems: [{ kind: 'human', step: 0, text: 'Follow-up to run 20260919-100000-aaaaaaaa (stopped: max_steps) whose task was "old task"; the task above is the human\'s next instruction' }] },
    window: [{ step: 9, intent: 'edit', action: 'edit src/a.py', outcome: 'executed', shownFiles: ['src/a.py'], notes: ['from run 20260919-100000-aaaaaaaa'] }],
    createdThisRun: ['src/new.py'],
    lastTestRun: { step: 8, command: 'pytest -q', passed: 1, failed: 1, errors: 0, allPassed: false },
    undoLog: [{ runId: '20260919-100000-aaaaaaaa', step: 7, at: '2026-09-20T00:00:00.000Z', by: 'undo', restored: ['src/a.py'], skipped: [] }],
    pinnedFiles: ['src/a.py'],
    carriedDirectives: 1,
    ...over,
  };
}

describe('run:ready, the workspace event and the run:start items (§15.2 main() row)', () => {
  it('run:ready carries the session fields, sandbox and maxReplans; workspace follows at once; clamp, seeded, secret-ack and the initial steer come next', async () => {
    const seed = seedOf();
    const h = await build({
      turns: [read()],
      limits: { maxSteps: 1, maxReplans: 3 },
      engine: {
        seed,
        session: { sessionId: 'sess-1', parentRunId: seed.parentRunId, source: 'cli', title: 'my title', clamp: { runCapUsd: 2, clampedToUsd: 0.75, sessionSpentUsd: 9.25, sessionCapUsd: 10 } },
        instructions: { files: [{ path: 'AGENTS.md', sha256: 'ab'.repeat(32), bytes: 120 }], text: 'Use tabs.' },
        secretsAcked: 2,
        humanDirective: 'start with the tests',
      },
    });
    await h.engine.run();
    const types = h.events.map((e) => e.type);
    expect(types.slice(0, 7)).toEqual(['run:start', 'run:ready', 'workspace', 'budget:clamp', 'notice', 'secret-ack', 'steer:queued']);
    expect(h.of('run:ready')[0]).toEqual({ type: 'run:ready', runId: h.engine.runId, step: 0, maxSteps: 1, task: expect.any(String), resumed: false, sessionId: 'sess-1', parentRunId: seed.parentRunId, sandbox: 'none', noNetwork: false, maxReplans: 3 });
    expect(h.of('workspace')[0]).toEqual({ type: 'workspace', git: expect.objectContaining({ repo: false, reason: 'not-a-repo', dirtyAtStart: { modified: 0, staged: 0, untracked: 0, unmerged: 0 }, ahead: null, behind: null }), instructions: [{ path: 'AGENTS.md', sha256: 'ab'.repeat(32), bytes: 120 }], sandbox: 'none' });
    expect(h.of('budget:clamp')).toEqual([{ type: 'budget:clamp', runCapUsd: 2, clampedToUsd: 0.75, sessionSpentUsd: 9.25, sessionCapUsd: 10 }]);
    expect(h.of('notice')[0]).toEqual({ type: 'notice', step: null, kind: 'seeded', level: 'info', text: seedNoticeText(seed, 1) });
    expect(h.of('notice')[0]!.text).toBe('seeded from run 20260919-100000-aaaaaaaa: plan done=1 remaining=2 unverified=0 · window 1 entries · 1 created files · 1 pending steer carried');
    expect(h.of('secret-ack')).toEqual([{ type: 'secret-ack', step: null, count: 2 }]);
    // AGENTS.md text reaches the generator system prompt only (D6) and never Jev's state
    expect(h.provider.requests[0]!.system).toContain('## Project instructions\nUse tabs.');
    expect(JSON.stringify(h.decider.calls.map((c) => c.state))).not.toContain('Use tabs.');
    // the pinned file is named in the prompt
    expect(h.provider.requests[0]!.messages[0]!.content).toContain('The human pinned these files for this task (@-mentions): src/a.py');
  });

  it('defaults: sessionId = runId, parentRunId null, source cli, no clamp/seeded/secret-ack lines, an unseeded run has no seed notice', async () => {
    const h = await build({ turns: [read()], limits: { maxSteps: 1 } });
    await h.engine.run();
    expect(h.of('run:ready')[0]).toMatchObject({ sessionId: h.engine.runId, parentRunId: null });
    expect(h.events.map((e) => e.type).slice(0, 3)).toEqual(['run:start', 'run:ready', 'workspace']);
    expect(h.of('budget:clamp')).toEqual([]);
    expect(h.of('notice')).toEqual([]);
    expect(h.of('secret-ack')).toEqual([]);
    expect(h.store.meta).toMatchObject({ sessionId: h.engine.runId, parentRunId: null, source: 'cli', versions: { jevcode: VERSION } });
    expect(h.store.meta!.title).toBeUndefined();
    expect(h.store.meta!.instructions).toBeUndefined();
  });
});

describe('seed (§8.3) and planAfter (§8.7)', () => {
  it('plan/window/createdThisRun/lastTestRun/undoLog come from the seed, lastChangeStep is null, step 1 may drop remaining items (rule b) and step 2 may not', async () => {
    const seed = seedOf();
    const h = await build({
      turns: [turn({ kind: 'read', paths: ['src/a.py'] }, { remaining: ['fix f'] }), turn({ kind: 'read', paths: ['src/a.py'] }, { remaining: [] })],
      limits: { maxSteps: 2 },
      engine: { seed, undoLog: [{ runId: seed.parentRunId, step: 9, at: '2026-09-20T00:00:01.000Z', by: 'rewind', restored: [], skipped: [] }] },
    });
    // before the run: the snapshot already carries the seed
    const snap0 = h.engine.snapshotState()!;
    expect(snap0.plan.done.map((d) => d.text)).toEqual(['read the code']);
    expect(snap0.plan.openProblems).toEqual([]);
    expect(snap0.window.map((w) => w.step)).toEqual([9]);
    expect(snap0.createdThisRun).toEqual(['src/new.py']);
    expect(snap0.lastTestRun).toEqual(seed.lastTestRun);
    expect(snap0.lastChangeStep).toBeNull();
    expect(snap0.undoLog?.map((u) => [u.step, u.by])).toEqual([[7, 'undo'], [9, 'rewind']]);
    expect(snap0.spend.totalUsd).toBe(0);
    expect(snap0.loopDetector.replanCount).toBe(0);
    const r = await h.engine.run();
    expect(r.steps).toBe(2);
    const s1 = h.store.steps[0]!;
    const s2 = h.store.steps[1]!;
    // step 1: 'run tests' dropped without a retained note (human rule); step 2: 'fix f' retained
    expect(s1.planAfter!.remaining).toEqual(['fix f']);
    expect(h.store.states.find((s) => s.step === 1)!.window.at(-1)!.notes.some((n) => /retained by the harness/.test(n))).toBe(false);
    expect(s2.planAfter!.remaining).toEqual(['fix f']);
    expect(h.store.last()!.window.at(-1)!.notes.some((n) => /'fix f' was dropped from remaining .* retained/.test(n))).toBe(true);
    // the window carried the parent's entry first, then the new steps
    expect(h.provider.requests[0]!.messages[0]!.content).toContain('### step 9: edit src/a.py');
    expect(h.provider.requests[0]!.messages[0]!.content).toContain('[human, step 0] Follow-up to run 20260919-100000-aaaaaaaa');
    // planAfter is bounded and matches the committed plan
    expect(s2.planAfter).toEqual({ done: h.store.last()!.plan.done, remaining: h.store.last()!.plan.remaining, unverified: [], harnessProblems: h.store.last()!.plan.harnessProblems });
    // the undo log is carried into every checkpoint of this run
    expect(h.store.last()!.undoLog).toHaveLength(2);
  });

  it('planAfter clips long items at 200 chars and 20 per list', async () => {
    const remaining = Array.from({ length: 25 }, (_, i) => `item ${i} ${'x'.repeat(300)}`);
    const h = await build({ turns: [turn({ kind: 'read', paths: ['src/a.py'] }, { remaining })], limits: { maxSteps: 1 } });
    await h.engine.run();
    const after = h.store.steps[0]!.planAfter!;
    expect(after.remaining.length).toBeLessThanOrEqual(20);
    for (const r of after.remaining) expect(r.length).toBeLessThanOrEqual(200);
  });
});

describe('createEngine order and the git probe (§12.1, §15 items 8/10/12/18)', () => {
  it('probe → sandbox (gitDir, gitCommonDir, configDirs) → workspace (gitState) → run.json with the bounded git meta and the session fields', async () => {
    const git: GitState = repoState({ oid: '7d731c0e9f1e4b2a8c6d5e4f3a2b1c0d9e8f7a6b', dirty: ['src/a.py'], untracked: ['x.txt'], ahead: 2, behind: 1, unmerged: 1, gitDir: '/repo/.git/worktrees/wt', commonDir: '/repo/.git' });
    const h = await build({ probeGitState: git, turns: [read()], limits: { maxSteps: 1 }, engine: { configDirs: ['/home/me/.config/jevcode'], session: { sessionId: 's', parentRunId: null, source: 'perf', title: 't' } } });
    expect(h.calls.order).toEqual(['probeGitState', 'createSandbox', 'createWorkspace']);
    expect(h.calls.sandboxOptions).toMatchObject({ gitDir: '/repo/.git/worktrees/wt', gitCommonDir: '/repo/.git', configDirs: ['/home/me/.config/jevcode'] });
    expect(h.calls.workspaceDeps?.gitState).toBe(git);
    expect(h.store.meta!.git).toEqual({ repo: true, head: { kind: 'branch', name: 'main', oid: '7d731c0e9f1e4b2a8c6d5e4f3a2b1c0d9e8f7a6b' }, upstream: 'origin/main', linkedWorktree: true, prefix: '', dirtyAtStart: { modified: 1, staged: 0, untracked: 1, unmerged: 1 }, ahead: 2, behind: 1 });
    // no paths and no entries leak into run.json (bounded meta)
    expect(JSON.stringify(h.store.meta!.git)).not.toContain('/repo');
    expect(h.store.meta).toMatchObject({ sessionId: 's', parentRunId: null, source: 'perf', title: 't' });
    await h.engine.run();
    expect(h.of('workspace')[0]!.git).toEqual(h.store.meta!.git);
  });

  it('a probe that rejects reads as git-missing: the sandbox gets no git dirs, the workspace no gitState, run.json says so, and the run works', async () => {
    const h = await build({ probeGitState: async () => Promise.reject(new Error('probeGitState: not wired in wave 1')), turns: [read()], limits: { maxSteps: 1 } });
    expect(h.calls.sandboxOptions!.gitDir).toBeUndefined();
    expect(h.calls.workspaceDeps).toEqual({});
    expect(h.store.meta!.git).toMatchObject({ repo: false, reason: 'git-missing' });
    const r = await h.engine.run();
    expect(r.steps).toBe(1);
    expect(h.of('workspace')[0]!.git.reason).toBe('git-missing');
  });

  it('--resume on a different HEAD: a drift notice after run:ready and resumedOn recorded through updateMeta; the same HEAD leaves both alone', async () => {
    const started = repoState({ oid: '7d731c0e9f1e4b2a8c6d5e4f3a2b1c0d9e8f7a6b' });
    const h = await build({ probeGitState: started, turns: [read()], limits: { maxSteps: 1 } });
    await h.engine.run();
    const same = await build({ probeGitState: started, store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [read()], limits: { maxSteps: 2 } });
    await same.engine.run();
    expect(same.of('notice').filter((n) => n.kind === 'drift')).toEqual([]);
    expect(h.store.meta!.git!.resumedOn).toBeUndefined();
    const moved = repoState({ oid: '91ab3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d' });
    const h3 = await build({ probeGitState: moved, store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [read()], limits: { maxSteps: 3 } });
    await h3.engine.run();
    const drift = h3.of('notice').filter((n) => n.kind === 'drift');
    expect(drift).toEqual([{ type: 'notice', step: null, kind: 'drift', level: 'warn', text: 'HEAD was main at run start, now main — the plan may not apply' }]);
    expect(h.store.meta!.git!.resumedOn).toEqual({ kind: 'branch', name: 'main', oid: '91ab3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d' });
    expect(h.store.meta!.git!.head).toEqual({ kind: 'branch', name: 'main', oid: '7d731c0e9f1e4b2a8c6d5e4f3a2b1c0d9e8f7a6b' });
    const types = h3.events.map((e) => e.type);
    expect(types.indexOf('notice')).toBeGreaterThan(types.indexOf('run:ready'));
  });

  it('--resume with git unavailable on the resuming machine (probe rejects): no false drift warning and no resumedOn — a null head is not a moved HEAD', async () => {
    const started = repoState({ oid: '7d731c0e9f1e4b2a8c6d5e4f3a2b1c0d9e8f7a6b' });
    const h = await build({ probeGitState: started, turns: [read()], limits: { maxSteps: 1 } });
    await h.engine.run();
    const h2 = await build({ probeGitState: async () => Promise.reject(new Error('git: not found')), store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [read()], limits: { maxSteps: 2 } });
    await h2.engine.run();
    expect(h2.of('notice').filter((n) => n.kind === 'drift')).toEqual([]);
    expect(h.store.meta!.git!.resumedOn).toBeUndefined();
    expect(h.store.meta!.git!.head).toEqual({ kind: 'branch', name: 'main', oid: '7d731c0e9f1e4b2a8c6d5e4f3a2b1c0d9e8f7a6b' });
    // the workspace event of the resumed run reports the fallback honestly
    expect(h2.of('workspace')[0]!.git).toMatchObject({ repo: false, reason: 'git-missing' });
    // a run that started outside a repository and is resumed inside one does warn (a HEAD appeared)
    const outside = await build({ turns: [read()], limits: { maxSteps: 1 } });
    await outside.engine.run();
    const inside = await build({ probeGitState: started, store: outside.store, runsDir: outside.runsDir, resume: { runId: outside.engine.runId, force: false }, turns: [read()], limits: { maxSteps: 2 } });
    await inside.engine.run();
    expect(inside.of('notice').filter((n) => n.kind === 'drift')).toHaveLength(1);
    expect(outside.store.meta!.git!.resumedOn).toEqual(started.head);
  });
});

describe('budget:override (§9.4)', () => {
  it('one item per override the controller passes for THIS resume (EngineOptions.resumeOverrides), with its source (absent → flag); they are appended to run.json with the resumes[] entry', async () => {
    const h = await build({ turns: [read()], limits: { maxSteps: 1 } });
    await h.engine.run();
    // an entry a previous resume left in run.json is never re-announced, even at the same step
    h.store.meta!.overrides.push({ setting: 'limits.maxSteps', from: '0', to: '1', atStep: 1 });
    const mine = [
      { setting: 'limits.spendCapUsd', from: '2', to: '3', atStep: 1, source: '/budget' as const },
      { setting: 'limits.maxSteps', from: '1', to: '3', atStep: 1 },
    ];
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [read()], limits: { maxSteps: 2, spendCapUsd: 3 }, engine: { resumeOverrides: mine } });
    await h2.engine.run();
    expect(h2.of('budget:override')).toEqual([
      { type: 'budget:override', setting: 'limits.spendCapUsd', from: '2', to: '3', appliesTo: 'resume', source: '/budget' },
      { type: 'budget:override', setting: 'limits.maxSteps', from: '1', to: '3', appliesTo: 'resume', source: 'flag' },
    ]);
    const types = h2.events.map((e) => e.type);
    expect(types.indexOf('budget:override')).toBeGreaterThan(types.indexOf('workspace'));
    expect(types.indexOf('budget:override')).toBeLessThan(types.indexOf('step:start'));
    // persisted once, after the stale entry, with the resumes[] entry of this resume
    expect(h.store.meta!.overrides).toEqual([{ setting: 'limits.maxSteps', from: '0', to: '1', atStep: 1 }, ...mine]);
    expect(h.store.meta!.resumes).toHaveLength(1);
  });

  it('two resumes at the same step (a rule-1 discard in between): each announces only its own overrides; a resume without any announces nothing although run.json holds entries at this step', async () => {
    const first = await build({ turns: [turn({ kind: 'run', command: 'ls' }, {}, { delayMs: 5_000 })], limits: { maxSteps: 3 } });
    const running = first.engine.run();
    await new Promise((r) => setTimeout(r, 30));
    first.engine.abort('human_abort');
    await running;
    expect(first.store.last()!.step).toBe(0);
    const a = [{ setting: 'limits.spendCapUsd', from: '2', to: '3', atStep: 0, source: '/budget' as const }];
    const second = await build({ store: first.store, runsDir: first.runsDir, resume: { runId: first.engine.runId, force: false }, turns: [turn({ kind: 'run', command: 'ls' }, {}, { delayMs: 5_000 })], limits: { maxSteps: 3, spendCapUsd: 3 }, engine: { resumeOverrides: a } });
    const running2 = second.engine.run();
    await new Promise((r) => setTimeout(r, 30));
    second.engine.abort('human_abort');
    await running2;
    expect(second.of('budget:override')).toHaveLength(1);
    expect(first.store.meta!.overrides).toEqual(a);
    // the third resume, at the very same step, raised max-steps only: the earlier spend-cap entry is not announced again
    const b = [{ setting: 'limits.maxSteps', from: '3', to: '4', atStep: 0 }];
    const third = await build({ store: first.store, runsDir: first.runsDir, resume: { runId: first.engine.runId, force: false }, turns: [read()], limits: { maxSteps: 1, spendCapUsd: 3 }, engine: { resumeOverrides: b } });
    await third.engine.run();
    expect(third.of('budget:override')).toEqual([{ type: 'budget:override', setting: 'limits.maxSteps', from: '3', to: '4', appliesTo: 'resume', source: 'flag' }]);
    expect(first.store.meta!.overrides).toEqual([...a, ...b]);
    // a fourth resume with nothing to announce: run.json still holds two entries at step 0, none is re-derived
    const fourth = await build({ store: first.store, runsDir: first.runsDir, resume: { runId: first.engine.runId, force: false }, turns: [read()], limits: { maxSteps: 2, spendCapUsd: 3 } });
    await fourth.engine.run();
    expect(fourth.of('budget:override')).toEqual([]);
    expect(first.store.meta!.overrides).toEqual([...a, ...b]);
    expect(first.store.meta!.resumes).toHaveLength(3);
  });

  it('a fresh run ignores resumeOverrides (nothing to apply them to) and a refused resume records nothing', async () => {
    const h = await build({ turns: [read()], limits: { maxSteps: 1 }, engine: { resumeOverrides: [{ setting: 'limits.maxSteps', from: '1', to: '3', atStep: 0 }] } });
    await h.engine.run();
    expect(h.of('budget:override')).toEqual([]);
    expect(h.store.meta!.overrides).toEqual([]);
    // stored max_steps, not raised: refused before any write
    const refused = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, limits: { maxSteps: 1 }, engine: { resumeOverrides: [{ setting: 'limits.spendCapUsd', from: '2', to: '3', atStep: 1 }] } });
    const r = await refused.engine.run();
    expect(r.stopReason).toBe('max_steps');
    expect(refused.of('budget:override')).toEqual([]);
    expect(h.store.meta!.overrides).toEqual([]);
  });
});

describe('run.lock (§8.5)', () => {
  it('is written after store.create with this pid and host, and removed by finish()', async () => {
    const h = await build({ turns: [read()], limits: { maxSteps: 1 } });
    const runDir = join(h.runsDir, FIXED_RUN_ID);
    const lock = readRunLock(runDir);
    expect(lock).toEqual({ pid: process.pid, startedAt: expect.any(String), host: hostname() });
    await h.engine.run();
    expect(existsSync(join(runDir, 'run.lock'))).toBe(false);
  });

  it('a live foreign lock refuses the resume with a ConfigError (exit 2) before any work; a stale lock is replaced with a lock notice', async () => {
    const h = await build({ turns: [read()], limits: { maxSteps: 1 } });
    await h.engine.run();
    const runDir = join(h.runsDir, FIXED_RUN_ID);
    writeFileSync(join(runDir, 'run.lock'), `${JSON.stringify({ pid: 1, startedAt: '2026-09-20T10:00:00.000Z', host: hostname() })}\n`);
    await expect(makeEngine({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [read()], limits: { maxSteps: 2 } })).rejects.toMatchObject({
      code: 'config',
      exitCode: 2,
      message: `run ${FIXED_RUN_ID} is in use by pid 1 since 2026-09-20T10:00:00.000Z (another jevcode?); run 'jevcode sessions unlock ${FIXED_RUN_ID}' if that process is gone`,
    });
    expect(readFileSync(join(runDir, 'run.lock'), 'utf8')).toContain('"pid":1');
    writeFileSync(join(runDir, 'run.lock'), `${JSON.stringify({ pid: 999_999, startedAt: '2026-09-20T10:00:00.000Z', host: hostname() })}\n`);
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [read()], limits: { maxSteps: 2 } });
    expect(readRunLock(runDir)?.pid).toBe(process.pid);
    await h2.engine.run();
    expect(h2.of('notice').filter((n) => n.kind === 'lock')).toEqual([{ type: 'notice', step: null, kind: 'lock', level: 'warn', text: expect.stringMatching(/replaced a stale run\.lock from pid 999999 is gone/) }]);
    expect(existsSync(join(runDir, 'run.lock'))).toBe(false);
  });
});

describe('confirmDetailed and the reviewer note (§6.4, §15 item 6)', () => {
  it('the engine prefers confirmDetailed; matches_intent and the risk latency ride the request; a decline note reaches the reason, the window notes and confirm:resolved', async () => {
    const c = detailedConfirmer({ approved: false, note: '  do not touch\nthe build dir  ' });
    const h = await build({ turns: [turn({ kind: 'run', command: 'pip install x' })], deciderOptions: { rules: [riskAll({ 2: 1 })], latencyMs: 7 }, confirmer: c, limits: { maxSteps: 1 } });
    const r = await h.engine.run();
    expect(c.detailedCalls).toBe(1);
    expect(c.confirmCalls).toBe(0);
    const req = h.of('confirm:request')[0]!.request;
    expect(req.matchesIntent).toEqual(expect.any(Number));
    expect(req.jevLatencyMs).toBe(7);
    expect(h.of('confirm:resolved')[0]).toEqual({ type: 'confirm:resolved', step: 1, id: `${h.engine.runId}:1`, approved: false, aborted: false, note: 'do not touch the build dir' });
    expect(h.store.steps[0]!.outcome).toMatchObject({ status: 'declined', reason: expect.stringMatching(/^declined by reviewer: .* — reviewer note: do not touch the build dir$/) });
    expect(h.store.last()!.window[0]!.notes).toContain('reviewer note: do not touch the build dir');
    expect(r.counters.declined).toBe(1);
    // the next generator prompt carries the note (P6)
    expect(h.sandbox.commands).toEqual([]);
  });

  it('an approval with a note keeps the note on the window entry; a confirmer without confirmDetailed still works through confirm()', async () => {
    const c = detailedConfirmer({ approved: true, note: 'x'.repeat(700) });
    const h = await build({ turns: [turn({ kind: 'run', command: 'pip install x' })], deciderOptions: { rules: [riskAll({ 2: 1 })] }, confirmer: c, limits: { maxSteps: 1 } });
    await h.engine.run();
    expect(h.store.steps[0]!.outcome?.status).toBe('executed');
    expect(h.of('confirm:resolved')[0]!.note).toHaveLength(600);
    expect(h.of('confirm:resolved')[0]!.note!.endsWith('…')).toBe(true);
    // the window entry keeps the note under its own bound (window.ts clips notes)
    expect(h.store.last()!.window[0]!.notes[0]).toMatch(/^reviewer note: x+…$/);
    const h2 = await build({ turns: [turn({ kind: 'run', command: 'pip install x' })], deciderOptions: { rules: [riskAll({ 2: 1 })] }, limits: { maxSteps: 1 } });
    await h2.engine.run();
    expect(h2.of('confirm:resolved')[0]!.note).toBeUndefined();
    expect(h2.store.steps[0]!.outcome).toMatchObject({ status: 'declined', reason: expect.not.stringContaining('reviewer note') });
  });
});

describe('run:end extension fields (§13.5, §15 item 14) and EngineStatus (§15 item 13)', () => {
  it('exitCode, resumable and paths ride run:end; complete is not resumable; status carries the wave-2 fields', async () => {
    const h = await build({ turns: [turn({ kind: 'done', summary: 'ok' })], deciderOptions: { rules: [answer('judge', 'task_complete', noulA(0.95))] } });
    const runDir = join(h.runsDir, FIXED_RUN_ID);
    const r = await h.engine.run();
    expect(r.stopReason).toBe('complete');
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 0, resumable: false, paths: { runDir, transcript: join(runDir, 'transcript.log'), log: join(runDir, 'jevcode.log') } });
    expect(h.engine.status()).toMatchObject({ maxReplans: 5, replans: 0, pausing: false, pendingDirectives: 0, blocked: null, retrying: null, generatorTokens: { used: 1200, cap: null } });
    const h2 = await build({ turns: [read()], limits: { maxSteps: 1 } });
    h2.engine.pause();
    expect(h2.engine.status().pausing).toBe(true);
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('human_pause');
    expect(h2.of('run:end')[0]).toMatchObject({ exitCode: 4, resumable: true });
    expect(h2.engine.status().pausing).toBe(false);
  });

  it('a refused resume still reports the stored stop with its code and stays resumable', async () => {
    const h = await build({ turns: [read()], limits: { maxSteps: 1 } });
    await h.engine.run();
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, limits: { maxSteps: 1 } });
    await h2.engine.run();
    expect(h2.of('run:end')[0]).toMatchObject({ exitCode: 4, resumable: true });
    expect(h2.of('budget:stop')).toEqual([]);
  });
});

describe('the loop team\'s three requests', () => {
  it('a no-op done after a test run carries the run\'s output tail in the judge state even outside the window; the fail: signature of a failing test run keys on the failing set', async () => {
    const runs = Array.from({ length: 6 }, () => turn({ kind: 'read', paths: ['src/a.py'] }));
    const h = await build({
      turns: [turn({ kind: 'run', command: 'pytest -q' }), ...runs, turn({ kind: 'done', summary: 'x' })],
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: { rules: [intentIs('finish', 8), answer('judge', 'task_complete', noulA(0.95), 8)] },
      limits: { maxSteps: 8 },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('complete');
    const judge8 = h.decider.callsAt('judge').find((c) => c.step === 8)!.state as JsonObject & { executed: { lastRun: { output: string | null; step: number } } };
    expect(judge8.executed.lastRun.step).toBe(1);
    expect(judge8.executed.lastRun.output).toContain('2 passed');
    // the runner's parser: two failing runs with the same failing set are the same failure
    const h2 = await build({ turns: [turn({ kind: 'run', command: 'pytest -q' })], sandbox: createFakeSandbox(() => failingTests), limits: { maxSteps: 2 } });
    await h2.engine.run();
    const sigs = h2.store.steps.map((s) => s.loopSignatures.find((x) => x.startsWith('fail:')));
    expect(sigs[0]).toBeDefined();
    expect(sigs[0]).toBe(sigs[1]);
  });
});

describe('bench (§15.2 bench/conditions.ts row)', () => {
  it('buildEngineOptions passes session source bench and alwaysDecline is untouched', () => {
    const opts = buildEngineOptions(
      { mode: 'jev-on', task: 't', workspace: '/ws', provider: createFakeProvider([read()]), decider: { model: 'm', provider: 'openrouter', ask: async () => ({ answers: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, latencyMs: 0, model: 'm', requestHash: 'h', attempts: 1, id: null }) }, meter: benchMeter(1) },
      { runsDir: '/runs', limits: { maxSteps: 1, maxWallMs: 1, maxReplans: 1, completeThreshold: 0.85, impossibleThreshold: 0.85, commandTimeoutMs: 1, maxCommandTimeoutMs: 1, maxOutputBytes: 1, spendCapUsd: 1 }, taskSpendCapUsd: 1, sandboxProfile: 'none', noNetwork: false, configRecord: {}, redact: (x: string) => x, secretPaths: [], generation: { temperature: null, maxTokens: 1 }, deciderModel: { configured: 'm', pinned: true } } as never,
    );
    expect(opts.session).toEqual({ sessionId: null, parentRunId: null, source: 'bench' });
    expect(opts.confirmer).toBe(benchDecline);
    expect(benchDecline.identity).toBe('no reviewer in bench runs');
  });

  it('a bench run\'s run.json has source bench and sessionId = runId', async () => {
    const h = await build({ turns: [read()], limits: { maxSteps: 1 }, engine: { session: { sessionId: null, parentRunId: null, source: 'bench' } } });
    expect(h.store.meta).toMatchObject({ source: 'bench', sessionId: h.engine.runId, parentRunId: null });
    await h.engine.run();
    expect(h.of('run:ready')[0]!.sessionId).toBe(h.engine.runId);
  });
});

describe('parity replay (§15.1, §15.3): transcript.log = itemsFromEvent over the emitted events', () => {
  it('a run with steers, an annotate line, budget events, a review note and the workspace event agrees line for line', async () => {
    const c = detailedConfirmer({ approved: false, note: 'no' });
    const h = await build({
      probeGitState: repoState({ dirty: ['src/a.py'] }),
      turns: [turn({ kind: 'run', command: 'pip install x' }, {}, { usage: { costUsd: 0.6 } }), read(), read()],
      deciderOptions: { rules: [riskAll({ 2: 1 }, 1)] },
      confirmer: c,
      limits: { maxSteps: 3, spendCapUsd: 1 },
      engine: { session: { sessionId: 's', parentRunId: null, source: 'cli', clamp: { runCapUsd: 2, clampedToUsd: 1, sessionSpentUsd: 9, sessionCapUsd: 10 } }, secretsAcked: 1, humanDirective: 'be careful' },
    });
    h.engine.events.on('step:end', (e) => {
      if (e.record.step === 1) {
        h.engine.steer('now read');
        h.engine.annotate('/why: destructive dominated', { detail: 'destructive L2' });
      }
    });
    await h.engine.run();
    let seq = 0;
    const expected: string[] = [];
    for (const e of h.events) {
      for (const item of itemsFromEvent(e, seq)) {
        expect(item.seq).toBe(seq);
        expected.push(formatTranscriptItem(item));
        seq += 1;
      }
    }
    expect(h.store.transcript).toEqual(expected);
    expect(h.store.transcript.at(-1)).toMatch(/^\[run\] end /);
    // the event list did carry every new kind (the writers agree whatever lines O10's plain.ts gives them)
    const kinds = new Set(h.events.map((e) => e.type));
    for (const k of ['workspace', 'budget:clamp', 'secret-ack', 'steer:queued', 'steer:applied', 'notice', 'confirm:resolved', 'budget:warn'] as const) expect(kinds.has(k)).toBe(true);
    // the redacted event is what every writer sees: no raw event object escapes emit()
    const ui = h.of('notice').find((n) => n.kind === 'ui')!;
    expect(ui).toMatchObject({ label: '[ui]', text: '/why: destructive dominated', detail: 'destructive L2' });
  });

  it('the jev-only checklist: synth lines, NullProvider untouched and the directive join are covered elsewhere; here a plain jev-on run has no synth line', async () => {
    const h = await build({ turns: [read()], limits: { maxSteps: 1 }, workspace: createFakeWorkspace({ root: undefined as never }) });
    await h.engine.run();
    expect(h.store.transcript.some((l) => / synth /.test(l))).toBe(false);
    expect(noRepoState().repo).toBe(false);
    const evts: EngineEvent[] = h.events;
    expect(evts.some((e) => e.type === 'workspace')).toBe(true);
    void ConfigError;
  });
});
