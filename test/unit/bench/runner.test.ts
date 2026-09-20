import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BENCH_WORK_DIR, IN_PROGRESS, NOT_RUN_BENCH_CAP, newBenchId, notRunRecord, readTasksJsonl, runBenchWithSources, safeName, selectSources } from '../../../src/bench/runner.js';
import { alwaysDecline, parseConditions } from '../../../src/bench/conditions.js';
import type { BenchTaskRecord } from '../../../src/core/types.js';
import type { BenchTaskSource } from '../../../src/bench/types.js';
import { baseOptions, createFakeDeps, syntheticSource, tempDir, type EngineScript } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const completeScript: EngineScript = (_task, mode) => ({
  result: { steps: mode === 'jev-on' ? 3 : 5, tokensPerStep: mode === 'jev-on' ? [100, 100, 100] : [50, 50, 50, 50, 50], jevLatencyMs: mode === 'jev-on' ? [150, 170, 190] : [], counters: { blocked: 1, reviews: 1, declined: 1, failed: 0, loops: 0, replans: 0, reads: mode === 'jev-on' ? 0 : 2 } },
  decisions: mode === 'jev-on' ? 12 : 0,
  spendUsd: 0.5,
});

describe('conditions', () => {
  it('alwaysDecline never approves and carries the bench identity', async () => {
    expect(alwaysDecline.identity).toBe('no reviewer in bench runs');
    const req = { id: 'c1', step: 1, proposal: { goal: 'g', action: { kind: 'done' as const, summary: 's' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' }, risk: { dims: {} as never, risk: 0.5, verdict: 'review' as const, reason: '' } };
    await expect(alwaysDecline.confirm(req, { signal: new AbortController().signal })).resolves.toBe(false);
    const ac = new AbortController();
    ac.abort();
    await expect(alwaysDecline.confirm(req, { signal: ac.signal })).rejects.toMatchObject({ code: 'abort' });
    expect(parseConditions('jev-off, jev-on,jev-on')).toEqual(['jev-off', 'jev-on']);
    expect(() => parseConditions('nope')).toThrow(/unknown condition/);
  });
  it('bench ids and task selection', () => {
    expect(newBenchId(new Date('2026-09-19T12:34:56Z'), () => Buffer.from('abcdef', 'hex'))).toBe('20260919-123456-abcdef');
    const srcs = ['a', 'b', 'c'].map((id) => syntheticSource({ id }));
    expect(selectSources(srcs, { tasks: 2 }).map((s) => s.id)).toEqual(['a', 'b']);
    expect(selectSources(srcs, { taskIds: ['c', 'a'] }).map((s) => s.id)).toEqual(['c', 'a']);
    expect(() => selectSources(srcs, { taskIds: ['zz'] })).toThrow(/unknown task/);
  });
});

describe('runBench (mocked, fake deps)', () => {
  it('3 tasks × 2 conditions with concurrency 2 -> 6 records, summary fields, comparison sections, predictions files', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const { deps, captured } = createFakeDeps({ script: completeScript });
    const sources = ['t1', 't2', 't3'].map((id) => syntheticSource({ id, evaluate: ({ condition }) => ({ pass: condition === 'jev-on' || id !== 't2', evaluator: 'mock' }) }));
    const out = await runBenchWithSources(sources, baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'), { concurrency: 2 }), deps);

    expect(out.records).toHaveLength(6);
    expect(captured.engines).toHaveLength(6);
    expect(captured.engines.filter((e) => e.mode === 'jev-on')).toHaveLength(3);
    // the engine receives exactly the task text and the bench confirmer
    for (const e of captured.engines) {
      expect(e.opts.task).toMatch(/^Task text for t[123]$/);
      expect(e.opts.confirmer).toBe(alwaysDecline);
      expect(e.opts.limits.spendCapUsd).toBe(2);
    }
    // mocked mode: mock provider built from the task's trajectory, no live provider
    expect(captured.mockProviders).toHaveLength(6);

    const on = out.records.filter((r) => r.condition === 'jev-on');
    expect(on.every((r) => r.pass === true && r.pairComplete && r.jevQuestions === 12 && r.jevLatencyMs.p50 === 170 && r.jevLatencyMs.p95 === 190 && r.blocked === 2)).toBe(true);
    const off = out.records.filter((r) => r.condition === 'jev-off');
    expect(off.map((r) => r.pass).sort()).toEqual([false, true, true]);
    expect(off.every((r) => r.jevLatencyMs.p50 === null && r.steps === 5 && r.reads === 2)).toBe(true);
    expect(out.records.every((r) => r.runId !== null && r.stopReason === 'complete' && r.cost.generator === 0.5)).toBe(true);

    const s = out.summary;
    expect(s.mocked).toBe(true);
    expect(s.records).toBe(6);
    expect(s.conditionOrder).toEqual(['jev-on', 'jev-off']);
    expect(s.conditions['jev-on']).toMatchObject({ mode: 'jev-on', maxSteps: 10, temperature: null, maxTokens: 4096, taskSpendCapUsd: 2, deciderModel: 'typesafe/jev-1.13-20260917' });
    expect(s.conditions['jev-off']!.deciderModel).toBeNull();
    expect(s.spentUsd.total).toBeCloseTo(3);
    expect(s.capFired).toBeNull();
    expect(s.notRun).toEqual({ count: 0, tasks: [] });
    expect(s.pairedTasks).toEqual({ swebench: 3 });
    const sw = s.perSuite['swebench']!;
    expect(sw.perCondition['jev-on']!.passRateText).toBe('3/3 (n=3)');
    expect(sw.perCondition['jev-off']!.passRateText).toBe('2/3 (n=3)');
    expect(sw.comparison.pairedTasks).toEqual(['t1', 't2', 't3']);
    expect(sw.perCondition['jev-on']!.stepsToSolve).toMatchObject({ n: 3, mean: 3, median: 3 });
    expect(sw.perCondition['jev-off']!.stepsToSolve.n).toBe(2);

    const md = out.comparisonMarkdown;
    expect(md).toContain('## Conditions');
    expect(md).toContain('receives Jev-selected file contents');
    expect(md).toContain('Mocked bench');
    expect(md).toContain('### Solve curve');
    expect(md).toContain('### Tokens per step');
    expect(md).toContain('### Stop reasons');
    expect(md).toContain('█');
    expect(md).toContain('(n=3)');
    expect(md).toContain('| t2 |');

    const files = await Promise.all(['tasks.jsonl', 'summary.json', 'comparison.md', 'predictions.jev-on.jsonl', 'predictions.jev-off.jsonl'].map((f) => readFile(join(out.outDir, f), 'utf8')));
    expect(files[0]!.trim().split('\n')).toHaveLength(6);
    expect(JSON.parse(files[1]!).mocked).toBe(true);
    for (const pf of [files[3]!, files[4]!]) {
      const lines = pf.trim().split('\n');
      expect(lines).toHaveLength(3);
      for (const l of lines) {
        const o = JSON.parse(l) as Record<string, string>;
        expect(Object.keys(o).sort()).toEqual(['instance_id', 'model_name_or_path', 'model_patch']);
        expect(o['model_patch']).toContain('diff --git');
      }
      expect((JSON.parse(lines[0]!) as Record<string, string>)['model_name_or_path']).toMatch(/^jevcode-jev-(on|off)-mock-model$/);
    }
  });

  it('bench cap fires mid-bench: siblings aborted (spend_cap, capFired bench), remaining pairs not_run, summary fields', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const script: EngineScript = (task) => (task.endsWith('a') ? { result: { steps: 2 }, spendUsd: 5 } : { result: { steps: 9 }, delayMs: 5000 });
    const { deps } = createFakeDeps({ script });
    const sources = ['a', 'b', 'c'].map((id) => syntheticSource({ id }));
    const started = Date.now();
    const out = await runBenchWithSources(sources, baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'), { concurrency: 3, spendCapUsd: 4, taskSpendCapUsd: 10 }), deps);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(out.records).toHaveLength(6);
    const a = out.records.find((r) => r.task === 'a' && r.condition === 'jev-on')!;
    expect(a).toMatchObject({ stopReason: 'spend_cap', capFired: 'bench', pairComplete: false });
    for (const id of ['b', 'c']) {
      const r = out.records.find((x) => x.task === id && x.condition === 'jev-on')!;
      expect(r).toMatchObject({ stopReason: 'spend_cap', capFired: 'bench', pairComplete: false });
      expect(r.runId).not.toBeNull();
    }
    const notRun = out.records.filter((r) => r.stopReason === 'not_run');
    expect(notRun).toHaveLength(3);
    expect(notRun.every((r) => r.condition === 'jev-off' && r.pass === null && r.evaluator === 'none' && r.reason === NOT_RUN_BENCH_CAP && r.steps === 0 && r.capFired === 'bench')).toBe(true);
    expect(out.summary.capFired).toBe('bench');
    expect(out.summary.notRun.count).toBe(3);
    expect(out.summary.spendCapUsd).toBe(4);
    expect(out.summary.taskSpendCapUsd).toBe(10);
    expect(out.summary.spentUsd.total).toBeCloseTo(5);
    expect(out.summary.pairedTasks).toEqual({ swebench: 0 });
    const sw = out.summary.perSuite['swebench']!;
    expect(sw.perCondition['jev-off']!.evaluated).toBe(0);
    expect(sw.comparison.incompletePairs).toEqual(['a', 'b', 'c']);
    expect(out.comparisonMarkdown).toContain('### Incomplete pairs');
  });

  it('--resume completes only the missing pairs, resumes an in-progress run, and does not re-spend', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const first = createFakeDeps({ script: completeScript });
    const sources = ['a', 'b'].map((id) => syntheticSource({ id }));
    const opts = baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'));
    const run1 = await runBenchWithSources(sources, opts, first.deps);
    expect(run1.records).toHaveLength(4);
    expect(run1.summary.spentUsd.total).toBeCloseTo(2);

    // simulate a bench interrupted before task b finished: b/jev-on never ran, b/jev-off was in progress
    const tasksPath = join(run1.outDir, 'tasks.jsonl');
    const records = await readTasksJsonl(tasksPath);
    const bOff = records.find((r) => r.task === 'b' && r.condition === 'jev-off')!;
    const kept: BenchTaskRecord[] = [
      ...records.filter((r) => r.task === 'a'),
      notRunRecord(sources[1]!, 'jev-on', NOT_RUN_BENCH_CAP),
      notRunRecord(sources[1]!, 'jev-off', IN_PROGRESS, bOff.runId),
    ];
    await writeFile(tasksPath, kept.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const second = createFakeDeps({ script: completeScript });
    const run2 = await runBenchWithSources(sources, { ...opts, resumeBenchId: run1.benchId }, second.deps);
    expect(second.captured.engines).toHaveLength(2);
    expect(second.captured.engines.map((e) => [e.mode, e.resumed])).toEqual(expect.arrayContaining([['jev-on', false], ['jev-off', true]]));
    expect(second.captured.engines.find((e) => e.mode === 'jev-off')!.opts.resume).toEqual({ runId: bOff.runId, force: false });
    expect(run2.records).toHaveLength(4);
    expect(run2.records.every((r) => r.pass === true && r.pairComplete)).toBe(true);
    // a's records are the first run's (same runIds), not re-run
    for (const c of ['jev-on', 'jev-off'] as const) {
      expect(run2.records.find((r) => r.task === 'a' && r.condition === c)!.runId).toBe(run1.records.find((r) => r.task === 'a' && r.condition === c)!.runId);
    }
    expect(run2.summary.resumed).toBe(true);
    // seeded with a's 1.0 USD, plus 2 × 0.5 for b: no re-spend on completed pairs
    expect(run2.summary.spentUsd.total).toBeCloseTo(2);
    expect((await readFile(tasksPath, 'utf8')).trim().split('\n')).toHaveLength(4);
  });

  it('setup failure and evaluator errors become records instead of rejections', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const { deps } = createFakeDeps({ script: completeScript });
    const sources = [
      syntheticSource({ id: 'bad-setup', setup: async () => { throw new Error('clone exploded'); } }),
      syntheticSource({ id: 'bad-eval', evaluate: () => { throw new Error('verifier crashed'); } }),
    ];
    const out = await runBenchWithSources(sources, baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'), { conditions: ['jev-on'] }), deps);
    expect(out.records).toHaveLength(2);
    const s = out.records.find((r) => r.task === 'bad-setup')!;
    expect(s).toMatchObject({ pass: null, evaluator: 'none', stopReason: 'error', runId: null });
    expect(s.reason).toMatch(/setup_failed: clone exploded/);
    const e = out.records.find((r) => r.task === 'bad-eval')!;
    expect(e).toMatchObject({ pass: null, evaluator: 'none', stopReason: 'complete' });
    expect(e.reason).toMatch(/evaluator_error: verifier crashed/);
    expect(out.summary.perSuite['swebench']!.perCondition['jev-on']!.unevaluated.sort()).toEqual(['bad-eval', 'bad-setup']);
  });

  it('rejects invalid options', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const { deps } = createFakeDeps({ script: completeScript });
    const base = baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'));
    await expect(runBenchWithSources([], { ...base, concurrency: 0 }, deps)).rejects.toMatchObject({ code: 'config' });
    await expect(runBenchWithSources([], { ...base, live: true, spendCapUsd: 0 }, deps)).rejects.toMatchObject({ code: 'config' });
    await expect(runBenchWithSources([], { ...base, live: true, spendCapUsd: 1 }, deps)).rejects.toThrow(/live provider/);
    await expect(runBenchWithSources([], { ...base, resumeBenchId: 'nope' }, deps)).rejects.toThrow(/not a bench id/);
  });
});

describe('runner hardening', () => {
  it('malformed tasks.jsonl lines (missing cost, torn JSON) are skipped on --resume, not fatal', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const first = createFakeDeps({ script: completeScript });
    const sources = ['a', 'b'].map((id) => syntheticSource({ id }));
    const opts = baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'));
    const run1 = await runBenchWithSources(sources, opts, first.deps);
    const tasksPath = join(run1.outDir, 'tasks.jsonl');
    const good = (await readFile(tasksPath, 'utf8')).trim().split('\n');
    // a record without cost/timing (shape a hand edit or an older schema could produce) plus a torn last line
    const bad = JSON.stringify({ suite: 'swebench', task: 'b', condition: 'jev-on', pass: true, evaluator: 'mock', stopReason: 'complete' });
    await writeFile(tasksPath, [good[0]!, bad, good[1]!, '{"suite": "swebench", "tas'].join('\n') + '\n');
    const logs: string[] = [];
    const parsed = await readTasksJsonl(tasksPath, (l) => logs.push(l));
    expect(parsed).toHaveLength(2);
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => /malformed record/.test(l))).toBe(true);
    const second = createFakeDeps({ script: completeScript });
    const run2 = await runBenchWithSources(sources, { ...opts, resumeBenchId: run1.benchId }, second.deps);
    expect(run2.records).toHaveLength(4);
    expect(second.captured.engines).toHaveLength(2);
  });

  it('setup timeout aborts the setup signal and records setup_failed without waiting for the setup', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const { deps } = createFakeDeps({ script: completeScript });
    let aborted = false;
    const source = syntheticSource({
      id: 'slow',
      setup: (_w, tools) =>
        new Promise<void>((_res, rej) => {
          tools.signal.addEventListener('abort', () => {
            aborted = true;
            rej(new Error('clone killed'));
          }, { once: true });
        }),
    });
    const started = Date.now();
    const out = await runBenchWithSources([source], baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'), { conditions: ['jev-on'], setupTimeoutMs: 50 }), deps);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(aborted).toBe(true);
    expect(out.records[0]).toMatchObject({ stopReason: 'error', pass: null, runId: null });
    expect(out.records[0]!.reason).toMatch(/setup_failed: setup exceeded 50 ms/);
  });

  it('--resume with a narrower selection keeps the other pairs\' records in tasks.jsonl and the summary', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const sources = ['a', 'b', 'c'].map((id) => syntheticSource({ id }));
    const opts = baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'));
    const run1 = await runBenchWithSources(sources, opts, createFakeDeps({ script: completeScript }).deps);
    expect(run1.records).toHaveLength(6);
    const second = createFakeDeps({ script: completeScript });
    const run2 = await runBenchWithSources([sources[1]!], { ...opts, resumeBenchId: run1.benchId }, second.deps);
    expect(second.captured.engines).toHaveLength(0);
    expect(run2.records).toHaveLength(6);
    expect(run2.summary.records).toBe(6);
    expect((await readFile(join(run2.outDir, 'tasks.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(6);
  });

  it('workspace runners are rooted at the pair dir with cwd = workspace; post-run runners use the engine run dir', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const source: BenchTaskSource = {
      suite: 'swebench',
      id: 'roots',
      meta: {},
      build: () => ({
        suite: 'swebench',
        id: 'roots',
        task: 'x',
        meta: {},
        setup: async (_w, tools) => {
          await tools.run('setup-cmd');
          await tools.makeRunner(join(t.dir, 'cache'))('cache-cmd');
        },
        extractPatch: async (ctx) => {
          await ctx.run('extract-cmd');
          return { modelPatch: 'd', patchBytes: 1, patchEmpty: false };
        },
        evaluate: async (ctx) => {
          await ctx.run('eval-cmd');
          return { pass: true, evaluator: 'mock' };
        },
        mockTrajectory: () => [{ text: 'm' }],
      }),
    };
    const { deps, sandbox, captured } = createFakeDeps({ script: completeScript });
    const runsDir = join(t.dir, 'runs');
    const out = await runBenchWithSources([source], baseOptions(runsDir, join(t.dir, 'out'), { conditions: ['jev-on'] }), deps);
    const pairDir = join(runsDir, BENCH_WORK_DIR, out.benchId, safeName('roots'), 'jev-on');
    const workspace = join(pairDir, 'workspace');
    expect(captured.engines[0]!.opts.workspace).toBe(workspace);
    const by = (cmd: string) => sandbox.commands.find((c) => c.command === cmd)!;
    expect(by('setup-cmd')).toMatchObject({ root: pairDir, cwd: workspace });
    expect(by('cache-cmd')).toMatchObject({ root: join(t.dir, 'cache'), cwd: undefined });
    expect(by('extract-cmd')).toMatchObject({ root: pairDir, cwd: workspace });
    expect(by('eval-cmd')).toMatchObject({ root: pairDir, cwd: workspace });
    const runDirs = sandbox.created.map((c) => c.runDir);
    expect(runDirs).toContain(join(pairDir, 'sandbox'));
    expect(runDirs).toContain(join(runsDir, out.records[0]!.runId!));
    expect(sandbox.created.every((c) => c.noNetwork === false)).toBe(true);
  });

  it('terminal-bench pairs pass the aux dir as an extra writable root; swebench pairs pass none', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const { deps, captured } = createFakeDeps({ script: completeScript });
    const runsDir = join(t.dir, 'runs');
    const sources = [syntheticSource({ id: 'tb1', suite: 'terminal-bench' }), syntheticSource({ id: 'sw1' })];
    const out = await runBenchWithSources(sources, baseOptions(runsDir, join(t.dir, 'out'), { conditions: ['jev-on'] }), deps);
    expect(out.records).toHaveLength(2);
    const tb = captured.engines.find((e) => e.opts.task.includes('tb1'))!;
    expect(tb.opts.extraWritableRoots).toEqual([join(runsDir, BENCH_WORK_DIR, out.benchId, safeName('tb1'), 'jev-on', 'aux')]);
    const sw = captured.engines.find((e) => e.opts.task.includes('sw1'))!;
    expect(sw.opts.extraWritableRoots).toBeUndefined();
  });

  it('capFired is task when the per-run cap trips and the bench cap does not', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const { deps } = createFakeDeps({ script: () => ({ result: { steps: 2 }, spendUsd: 5 }) });
    const out = await runBenchWithSources([syntheticSource({ id: 'a' })], baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'), { concurrency: 1, spendCapUsd: 100, taskSpendCapUsd: 3 }), deps);
    expect(out.records).toHaveLength(2);
    expect(out.records.every((r) => r.stopReason === 'spend_cap' && r.capFired === 'task' && r.pairComplete)).toBe(true);
    expect(out.summary.capFired).toBeNull();
    expect(out.summary.notRun.count).toBe(0);
  });

  it('comparison.md escapes pipes and newlines in reasons so tables stay well-formed', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const { deps } = createFakeDeps({ script: completeScript });
    const source = syntheticSource({ id: 'weird', evaluate: () => ({ pass: null, evaluator: 'invalid', reason: 'a | b\nsecond line' }) });
    const out = await runBenchWithSources([source], baseOptions(join(t.dir, 'runs'), join(t.dir, 'out')), deps);
    expect(out.comparisonMarkdown).toContain('a \\| b second line');
    expect(out.comparisonMarkdown).not.toContain('a | b');
  });
});
