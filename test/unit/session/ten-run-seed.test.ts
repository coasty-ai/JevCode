/**
 * TUI-DESIGN §19.7, the pure half (O6, wave 1): rows 1, 2, 4b, 6, 8, 9, 10 asserted on the seed / index / meter
 * functions alone — no controller, no engine. The controller-driven scenario is `test/unit/cli/ten-run.test.ts` (O10).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCliArgs } from '../../../src/cli/args.js';
import { reconcileResumeConfig, type ResumeCurrentInputs } from '../../../src/config/resolve.js';
import type { ConfigRecordValue, RunLimits, SpendMeter, StopReason } from '../../../src/core/types.js';
import { exportSession, type ExportRun } from '../../../src/session/export.js';
import { appendIndexLine, foldIndex, readIndex, type IndexLine } from '../../../src/session/index.js';
import { buildSeed, carriedSteers, seedSource, type SeedParent } from '../../../src/session/seed.js';
import { createSpendMeter } from '../../../src/spend/meter.js';
import { childCapUsd, followUpDecision, sessionCapReachedItem } from '../../../src/tui/budget/lines.js';
import { makeMeta, makeState, runId, spend, windowEntry } from './helpers.js';

const R = (n: number): string => runId(n);
const S = R(1);
const WS = '/Users/me/proj';
const T = (n: number): string => `2026-09-20T14:${String(n).padStart(2, '0')}:00.000Z`;
const noRedact = (s: string): string => s;
const SESSION_CAP = 10;
const RUN_CAP = 2;

const startLine = (n: number, parent: number | null, task: string, t: number): IndexLine => ({ v: 1, t: T(t), kind: 'run:start', sessionId: S, runId: R(n), parentRunId: parent === null ? null : R(parent), workspace: WS, task60: task, mode: 'jev-on', source: 'cli', branch: 'main', resumeOf: null });
const endLine = (n: number, stop: StopReason, steps: number, gen: number, jev: number, exitCode: number, t: number): IndexLine => ({ v: 1, t: T(t), kind: 'run:end', sessionId: S, runId: R(n), stopReason: stop, steps, costUsd: { generator: gen, jev }, wallMs: 1000 * steps, changedFiles: 1, exitCode, resumable: stop !== 'complete', degraded: false });

let dir: string;
let indexPath: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jevcode-ten-run-'));
  indexPath = join(dir, 'sessions', 'index.jsonl');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the ten-run session, pure assertions (TUI-DESIGN §19.7)', () => {
  const sessionMeter: SpendMeter = createSpendMeter(SESSION_CAP);
  const runMeters: SpendMeter[] = [];
  const childFor = (): SpendMeter => {
    const remaining = SESSION_CAP - sessionMeter.snapshot().totalUsd;
    const m = sessionMeter.child(Math.min(RUN_CAP, remaining));
    runMeters.push(m);
    return m;
  };

  it('row 1: R1 has sessionId = R1 and parentRunId null; index run:start + run:end fold; meters $0.115 / $0.115; exit 0', async () => {
    expect(appendIndexLine(indexPath, startLine(1, null, 'fix parse_date tz handling', 1), noRedact)).toBe(true);
    const m = childFor();
    expect(m.snapshot().capUsd).toBe(2);
    m.add('generator', { inputTokens: 1000, outputTokens: 100, costUsd: 0.104, calls: 3 });
    m.add('jev', { inputTokens: 500, outputTokens: 50, costUsd: 0.011, calls: 40 });
    expect(m.snapshot().totalUsd).toBeCloseTo(0.115, 12);
    expect(sessionMeter.snapshot().totalUsd).toBeCloseTo(0.115, 12);
    expect(m.snapshot().parent).toEqual({ totalUsd: expect.closeTo(0.115, 12), capUsd: 10 });
    expect(appendIndexLine(indexPath, endLine(1, 'complete', 9, 0.104, 0.011, 0, 2), noRedact)).toBe(true);
    const idx = await readIndex(indexPath);
    expect(idx.sessions).toHaveLength(1);
    const s = idx.sessions[0]!;
    expect(s.sessionId).toBe(R(1));
    expect(s.runs).toEqual([expect.objectContaining({ runId: R(1), parentRunId: null, stopReason: 'complete', exitCode: 0, steps: 9, live: false })]);
    expect(s.totalUsd).toBeCloseTo(0.115, 12);
  });

  const r1: SeedParent = {
    meta: makeMeta({ runId: R(1), sessionId: S, parentRunId: null, source: 'cli', createdAt: T(1) }),
    state: makeState({
      runId: R(1),
      step: 9,
      stopReason: 'complete',
      plan: { done: [{ text: 'tz offsets parsed', evidence: { step: 4, judged: 0.9 } }], remaining: ['docs'], unverified: [], openProblems: ['x'], harnessProblems: [] },
      window: [5, 6, 7, 8, 9].map((n) => windowEntry(n)),
      spend: spend(0.104, 0.011),
    }),
  };

  it('row 2: R2 is seeded from R1 (plan.done carried, window notes `from run R1`); the steer line joins the index', async () => {
    const seed = buildSeed(r1, { humanNotes: [], pinnedFiles: [] });
    expect(seed.parentRunId).toBe(R(1));
    expect(seed.plan.done).toEqual(r1.state!.plan.done);
    expect(seed.plan.openProblems).toEqual([]);
    expect(seed.window.map((e) => e.step)).toEqual([6, 7, 8, 9]);
    expect(seed.window.every((e) => e.notes.includes(`from run ${R(1)}`))).toBe(true);
    // the seed framing is a step-0 human problem — never superseded by a steer (§8.6)
    expect(seed.plan.harnessProblems.map((h) => [h.kind, h.step])).toEqual([['human', 0]]);
    appendIndexLine(indexPath, startLine(2, 1, 'now update the docs', 3), noRedact);
    expect(appendIndexLine(indexPath, { v: 1, t: T(4), kind: 'steer', sessionId: S, runId: R(2), step: 4, text60: 'keep CHANGELOG format' }, noRedact)).toBe(true);
    childFor().add('generator', { inputTokens: 1, outputTokens: 1, costUsd: 0.2, calls: 1 });
    appendIndexLine(indexPath, endLine(2, 'complete', 6, 0.2, 0, 0, 5), noRedact);
    const idx = await readIndex(indexPath);
    expect(idx.sessions[0]!.lastUsed).toBe(T(5));
    expect(idx.sessions[0]!.runs.map((r) => [r.runId, r.parentRunId])).toEqual([
      [R(1), null],
      [R(2), R(1)],
    ]);
  });

  it('row 4b: `/budget spend-cap 3` then `/resume` → overrides gain { limits.spendCapUsd 2 → 3, atStep 23 } and no immediate stop', () => {
    const config: Record<string, ConfigRecordValue> = {};
    for (const [k, v] of Object.entries({ 'generator.provider': 'anthropic', 'generator.model': 'claude-sonnet-5', 'limits.spendCapUsd': '2', 'limits.maxSteps': '40', 'limits.maxWall': '30m', 'limits.maxReplans': '5', 'limits.completeThreshold': '0.85', 'limits.impossibleThreshold': '0.85' })) {
      config[k] = { value: v, source: 'default' };
    }
    const meta = makeMeta({ runId: R(4), sessionId: S, parentRunId: R(3), source: 'cli', task: 'refactor date helpers', config });
    const limits: RunLimits = { maxSteps: 40, maxWallMs: 30 * 60_000, maxReplans: 5, completeThreshold: 0.85, impossibleThreshold: 0.85, commandTimeoutMs: 120_000, maxCommandTimeoutMs: 600_000, maxOutputBytes: 200 * 1024, spendCapUsd: 3 };
    const current: ResumeCurrentInputs = { limits, workspaceRealpath: null, state: { step: 23, spendTotalUsd: 2.03, wallMsUsed: 5000, replanCount: 1, stopReason: 'spend_cap', generatorTokens: 0 } };
    const rec = reconcileResumeConfig(current, meta, parseCliArgs(['run', '--resume', R(4), '--spend-cap', '3']));
    expect(rec.errors).toEqual([]);
    expect(rec.overrides).toEqual([{ setting: 'limits.spendCapUsd', from: '2', to: '3', atStep: 23 }]);
    expect(rec.immediateStop).toBeNull();
    // without the raise the stored stop still holds
    const stuck = reconcileResumeConfig({ ...current, limits: { ...limits, spendCapUsd: 2 } }, meta, parseCliArgs(['run', '--resume', R(4)]));
    expect(stuck.immediateStop?.reason).toBe('spend_cap');
  });

  it('row 6: R6 is seeded from R5\'s committed plan — the discarded (interrupted) proposal is not in the seed', () => {
    const r5: SeedParent = {
      meta: makeMeta({ runId: R(5), sessionId: S, parentRunId: R(4), source: 'cli', task: 'migrate loader to TOML', createdAt: T(10) }),
      state: makeState({
        runId: R(5),
        step: 5,
        stopReason: 'human_abort',
        plan: { done: [{ text: 'loader reads TOML', evidence: { step: 3, judged: 0.8 } }], remaining: ['drop legacy/'], unverified: [], openProblems: [], harnessProblems: [] },
        window: [1, 2, 3, 4, 5].map((n) => windowEntry(n)),
        interrupted: { step: 6, stage: 'propose', proposal: null },
      }),
    };
    const seed = buildSeed(r5, { humanNotes: [], pinnedFiles: [] });
    expect(seed.plan.done.map((d) => d.text)).toEqual(['loader reads TOML']);
    expect(seed.window.map((e) => e.step)).toEqual([2, 3, 4, 5]);
    expect(JSON.stringify(seed)).not.toContain('"step":6');
    expect(seed.plan.harnessProblems[0]!.text).toContain(`Follow-up to run ${R(5)} (stopped: human_abort)`);
  });

  it('row 8: the seed source skips the step-0 run R7; R8 carries R6\'s undoLog', () => {
    const undoLog = [{ runId: R(6), step: 13, at: T(20), by: 'undo' as const, restored: ['a', 'b', 'c'], skipped: [{ path: 'd', reason: 'not-recoverable' as const }] }];
    const r6: SeedParent = { meta: makeMeta({ runId: R(6), sessionId: S, createdAt: T(15) }), state: makeState({ runId: R(6), step: 13, stopReason: 'complete', undoLog }) };
    const r7: SeedParent = { meta: makeMeta({ runId: R(7), sessionId: S, createdAt: T(21), task: 'rerun the suite' }), state: makeState({ runId: R(7), step: 0, stopReason: 'error' }) };
    const src = seedSource([r1, r6, r7]);
    expect(src).toBe(r6);
    const seed = buildSeed(src!, { humanNotes: [], pinnedFiles: [] });
    expect(seed.parentRunId).toBe(R(6));
    expect(seed.undoLog).toEqual(undoLog);
    // a pending steer left in R6 would be carried too
    const withSteer: SeedParent = { ...r6, state: { ...r6.state!, pendingDirectives: [{ text: 'skip legacy/', at: T(19), index: 1 }] } };
    expect(carriedSteers(withSteer)).toBe(1);
    expect(buildSeed(withSteer, { humanNotes: [], pinnedFiles: [] }).plan.harnessProblems.at(-1)).toEqual({ kind: 'human', step: 0, text: 'skip legacy/' });
  });

  it('rows 9 and 10: remaining 3.85 and 2.14 ≥ 2 → no confirm; the session cap trips through the child (parentExceeded)', () => {
    expect(followUpDecision(RUN_CAP, SESSION_CAP, SESSION_CAP - 3.85)).toBe('start');
    expect(followUpDecision(RUN_CAP, SESSION_CAP, SESSION_CAP - 2.14)).toBe('start');
    // bring the session meter to $7.86 spent (remaining 2.14), then start R10 with the full run cap
    const root = createSpendMeter(SESSION_CAP);
    root.add('generator', { inputTokens: 0, outputTokens: 0, costUsd: 7.86, calls: 9 });
    const cap10 = childCapUsd(RUN_CAP, SESSION_CAP, root.snapshot().totalUsd);
    expect(cap10).toBe(2);
    const r10 = root.child(cap10);
    for (let step = 1; step <= 18; step++) r10.add('generator', { inputTokens: 0, outputTokens: 0, costUsd: 0.1, calls: 1 });
    expect(r10.exceeded()).toBe(false);
    expect(r10.snapshot().parentExceeded).toBe(false);
    // step 19: the run is at $1.80 of $2.00 and the session at $9.66; one $0.35 call crosses $10.00
    const snap = r10.add('generator', { inputTokens: 0, outputTokens: 0, costUsd: 0.35, calls: 1 });
    expect(snap.totalUsd).toBeCloseTo(2.15, 9);
    expect(snap.parent?.totalUsd).toBeCloseTo(10.01, 9);
    expect(snap.parentExceeded).toBe(true);
    expect(snap.exceeded).toBe(true);
    expect(r10.exceeded()).toBe(true);
    // row 10b: the follow-up is refused, /budget session-spend-cap 15 applies at once, R11 starts clamped to min(2, 5)
    expect(followUpDecision(RUN_CAP, SESSION_CAP, root.snapshot().totalUsd)).toBe('refuse');
    expect(sessionCapReachedItem(root.snapshot().totalUsd, SESSION_CAP)).toBe('session cap reached ($10.01 of $10.00). Raise it with /budget session-spend-cap <usd>, or /new for a fresh session with its own cap.');
    root.setCap!(15);
    expect(r10.snapshot().parent?.capUsd).toBe(15);
    expect(r10.snapshot().capUsd).toBe(2);
    expect(r10.exceeded()).toBe(true); // its own cap: $2.15 ≥ $2.00
    expect(followUpDecision(RUN_CAP, 15, root.snapshot().totalUsd)).toBe('start');
    expect(childCapUsd(RUN_CAP, 15, root.snapshot().totalUsd)).toBe(2);
    expect(appendIndexLine(indexPath, { v: 1, t: T(40), kind: 'budget', sessionId: S, runId: R(10), setting: 'session.spendCapUsd', from: '10', to: '15' }, noRedact)).toBe(true);
  });

  it('row 10b: /export writes one header per run (11 runs)', async () => {
    const runs: ExportRun[] = [];
    for (let n = 1; n <= 11; n++) {
      const runDir = join(dir, 'runs', R(n));
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, 'transcript.log'), `[run] start run ${n}\n[run] end complete steps=1\n`);
      runs.push({ runId: R(n), runDir, startedAt: T(n), task60: `task ${n}`, stopReason: n === 11 ? null : 'complete', costUsd: 0.1 });
    }
    const out = join(dir, 'exports', `${S}.log`);
    const res = await exportSession(runs, out);
    expect(res.truncated).toBe(false);
    expect(res.missing).toEqual([]);
    const text = await readFile(out, 'utf8');
    expect(text.split('\n').filter((l) => l.startsWith('==== run ')).length).toBe(11);
    expect(text).toContain(`==== run ${R(11)} · ${T(11)} · task 11 · in progress · $0.100 ====`);
    // the index folded once more: still one session, the budget line moved lastUsed
    const idx = await readIndex(indexPath);
    expect(idx.sessions).toHaveLength(1);
    expect(idx.sessions[0]!.lastUsed).toBe(T(40));
    expect(foldIndex(['{"v":1']).skipped).toBe(1);
    expect(runMeters.length).toBeGreaterThan(0);
  });
});
