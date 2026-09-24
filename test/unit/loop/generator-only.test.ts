import { afterEach, describe, expect, it } from 'vitest';
import { createGeneratorOnlyEngine, loopTripText } from '../../../src/loop/generator-only.js';
import type { Harness } from './fakes.js';
import { createFakeSandbox, failingTests, makeEngine, passingTests, turn } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine({ ...args[0], mode: 'jev-off' });
  harnesses.push(h);
  return h;
}

describe('generator-only engine (§13)', () => {
  it('happy path: candidate list instead of context, no Jev calls, verbatim plan acceptance, done -> generator_done', async () => {
    const h = await build({
      turns: [
        turn({ kind: 'read', paths: ['src/a.py'] }, { remaining: ['fix', 'test'] }),
        turn({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' }, { done: ['fix'], remaining: ['test'] }),
        turn({ kind: 'run', command: 'pytest -q' }, { done: ['fix', 'test'], remaining: [] }),
        turn({ kind: 'done', summary: 'done' }, { done: ['fix', 'test'], remaining: [] }),
      ],
      sandbox: createFakeSandbox(() => passingTests),
    });
    const r = await h.engine.run();
    expect(r.mode).toBe('jev-off');
    expect(r.stopReason).toBe('generator_done');
    expect(r.steps).toBe(4);
    expect(h.decider.calls).toHaveLength(0);
    expect(h.of('decision')).toHaveLength(0);
    expect(h.of('intent')).toHaveLength(0);
    expect(h.of('risk')).toHaveLength(0);
    expect(h.of('judge')).toHaveLength(0);
    expect(h.of('exec:start')).toHaveLength(4);
    const prompt = h.provider.requests[0]!.messages[0]!.content;
    expect(prompt).toContain('## Workspace files (path, bytes)');
    expect(prompt).toContain('src/a.py ');
    expect(prompt).not.toContain('Intent for this step');
    expect(prompt).not.toContain('Context files');
    expect(r.finalPlan.done).toEqual([
      { text: 'fix', evidence: { step: 2, judged: -1 } },
      { text: 'test', evidence: { step: 3, judged: -1 } },
    ]);
    for (const s of h.store.steps) {
      expect(s.intent).toBeNull();
      expect(s.risk).toBeNull();
      expect(s.judge).toBeNull();
      expect(s.completion).toBeNull();
      expect(s.decisions).toEqual([]);
    }
    expect(h.store.steps[3]!.outcome?.status).toBe('noop');
    expect(r.counters.blocked).toBe(0);
    expect(r.counters.reviews).toBe(0);
    expect(r.jevLatencyMs).toEqual([]);
    expect(r.usage.jev.calls).toBe(0);
    expect(r.jevQuestions).toBe(0);
    expect(h.store.last()!.jevQuestions).toBe(0);
  });

  it('loop trip injects the fixed text into the next prompt and harnessProblems; failed outcomes recorded as in jev-on', async () => {
    const h = await build({
      turns: [turn({ kind: 'run', command: 'pytest -q' }), turn({ kind: 'run', command: 'pytest -q' }), turn({ kind: 'run', command: 'pytest -q' }), turn({ kind: 'edit', path: 'src/a.py', old: 'zzz', new: 'y' })],
      sandbox: createFakeSandbox(() => failingTests),
      limits: { maxSteps: 4 },
    });
    const r = await h.engine.run();
    expect(h.of('loop:tripped')).toHaveLength(1);
    expect(h.of('replan')).toHaveLength(0);
    const text = loopTripText(h.of('loop:tripped')[0]!.signature);
    expect(text).toMatch(/^You have repeated the same run command with the same result 3 times\. Change approach/);
    expect(h.provider.requests[3]!.messages[0]!.content).toContain(text);
    expect(r.finalPlan.harnessProblems).toEqual([{ kind: 'replan', text, step: 3 }]);
    expect(r.counters.loops).toBe(1);
    expect(h.store.steps[3]!.outcome?.status).toBe('failed');
    expect(r.counters.failed).toBe(1);
    expect(h.store.last()!.loopDetector.tripped).toBe(false);
  });

  it('createGeneratorOnlyEngine forces jev-off even when opts say jev-on', async () => {
    const h = await build({});
    const engine = await createGeneratorOnlyEngine(
      {
        task: 't',
        mode: 'jev-on',
        workspace: h.runsDir,
        runsDir: h.runsDir,
        provider: h.provider,
        decider: h.decider,
        confirmer: { identity: 'x', confirm: async () => false },
        meter: h.meter,
        limits: { maxSteps: 1, maxWallMs: 60_000, maxReplans: 1, completeThreshold: 0.85, impossibleThreshold: 0.85, commandTimeoutMs: 1000, maxCommandTimeoutMs: 1000, maxOutputBytes: 1000, spendCapUsd: 1 },
        sandboxProfile: 'none',
        noNetwork: false,
        configRecord: {},
        redact: (s) => s,
        secretPaths: [],
        generation: { temperature: null, maxTokens: 100 },
        deciderModel: { configured: 'typesafe/jev-1.13-20260917', pinned: true },
      },
      { createCheckpointStore: () => h.store, createWorkspace: async () => h.workspace, createSandbox: () => h.sandbox, newRunId: () => '20260919-120000-zzzzzzzz' },
    );
    const r = await engine.run();
    expect(r.mode).toBe('jev-off');
    expect(r.stopReason).toBe('generator_done');
  });
});
