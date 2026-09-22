/**
 * contract 1.4 (docs/COORDINATION-DESIGN.md §7.3 step 3, §12.0.2 P2 / P3, §11 row 30): the replay path — `EngineOptions.resume.replay`
 * restores the paused proposal (intent / context / propose skipped, risk re-run, no generator call) behind the hash gate; a
 * target that changed since the pause makes the step fresh at intent; a mid-LLM-round pause (llm-jev) resumes and serves the
 * arrived samples from the round cache without a generator call for them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GenerateOptions, GenerateRequest, GenerateResult, Proposal, Synthesizer } from '../../../src/core/types.js';
import { stepCacheRel } from '../../../src/checkpoint/replay.js';
import type { FakeProvider, Harness } from './fakes.js';
import { createFakeDecider, createFakeWorkspace, makeEngine, turn } from './fakes.js';

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
/** a decider whose risk stage hangs until the signal aborts (the pause-now window) on the given step only */
const slowRiskAt = (step: number) => createFakeDecider({ delayMs: (ctx) => (ctx.stage === 'risk' && ctx.step === step ? 5_000 : 0) });

describe('replay of a paused proposal (P2 → /resume --replay)', () => {
  it('skips intent, context and propose, re-runs risk, commits the step; no generator call', async () => {
    const h = await build({ decider: slowRiskAt(1), turns: [read()], limits: { maxSteps: 2 } });
    h.engine.events.on('stage:start', (e) => {
      if (e.stage === 'risk') h.engine.pause({ at: 'now' });
    });
    const r1 = await h.engine.run();
    expect(r1.stopReason).toBe('human_pause');
    expect(h.provider.requests).toHaveLength(1);
    expect(h.store.last()!.interruptedDetail).toMatchObject({ cache: 'cache/step-1.json', replayable: true, targetsSha: {} });

    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false, replay: true }, turns: [read()], limits: { maxSteps: 1 } });
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('max_steps');
    expect(r2.steps).toBe(1);
    // no generator call, no intent / context request; risk asked again; the proposal announced as replayed
    expect(h2.provider.requests).toHaveLength(0);
    expect(h2.decider.callsAt('intent')).toEqual([]);
    expect(h2.decider.callsAt('context')).toEqual([]);
    expect(h2.decider.callsAt('risk')).toHaveLength(1);
    expect(h2.of('stage:start').map((e) => e.stage)).toEqual(['risk', 'execute', 'judge']);
    expect(h2.of('proposal')).toHaveLength(1);
    expect(h2.of('proposal')[0]!.proposal.action).toEqual({ kind: 'read', paths: ['src/a.py'] });
    expect(h2.of('transcript').some((t) => /^replaying step 1 from cache\/step-1\.json: the paused proposal \(risk re-checked\)$/.test(t.text))).toBe(true);
    expect(h2.of('transcript').some((t) => /step 1: replaying the paused proposal from cache\/step-1\.json/.test(t.text))).toBe(true);
    const rec = h.store.steps.at(-1)!;
    expect(rec.step).toBe(1);
    expect(rec.outcome?.status).toBe('executed');
    expect(h.store.last()!.window.at(-1)?.notes).toContain('replayed the paused proposal (risk re-checked)');
    // the detail is gone with the commit; the resumed run's checkpoint carries no stale point
    expect(h.store.last()!.interrupted).toBeNull();
    expect(h.store.last()!.interruptedDetail).toBeUndefined();
    expect(h.store.last()!.pausePoint).toBeUndefined();
  });

  it('a resume WITHOUT replay is a fresh step at intent (the default, as today)', async () => {
    const h = await build({ decider: slowRiskAt(1), turns: [read()], limits: { maxSteps: 2 } });
    h.engine.events.on('stage:start', (e) => {
      if (e.stage === 'risk') h.engine.pause({ at: 'now' });
    });
    await h.engine.run();
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [read()], limits: { maxSteps: 1 } });
    await h2.engine.run();
    expect(h2.provider.requests).toHaveLength(1);
    expect(h2.decider.callsAt('intent')).toHaveLength(1);
    expect(h2.of('transcript').some((t) => /replay/.test(t.text))).toBe(false);
  });

  it('the hash gate: a target that changed since the pause refuses the replay — fresh step at intent, one line says why', async () => {
    const h = await build({ decider: slowRiskAt(1), turns: [turn({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' })], limits: { maxSteps: 2 } });
    // the fake workspace's root is the harness's temp dir: put the real file there so the gate hashes bytes, not a missing path
    mkdirSync(join(h.workspace.root, 'src'), { recursive: true });
    writeFileSync(join(h.workspace.root, 'src/a.py'), 'def f():\n    return 1\n');
    h.engine.events.on('stage:start', (e) => {
      if (e.stage === 'risk') h.engine.pause({ at: 'now' });
    });
    await h.engine.run();
    const sha = h.store.last()!.interruptedDetail!.targetsSha['src/a.py'];
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    // the human edits the file by hand while paused
    writeFileSync(join(h.workspace.root, 'src/a.py'), 'def f():\n    return 3\n');
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false, replay: true }, turns: [read()], limits: { maxSteps: 1 }, workspace: createFakeWorkspace({ root: h.workspace.root }) });
    const r2 = await h2.engine.run();
    expect(r2.steps).toBe(1);
    expect(h2.of('transcript').some((t) => t.level === 'warn' && /^replay unavailable: targets changed since the proposal \(src\/a\.py\); fresh step 1 at intent$/.test(t.text))).toBe(true);
    expect(h2.provider.requests).toHaveLength(1);
    expect(h2.decider.callsAt('intent')).toHaveLength(1);
    expect(h2.of('proposal')[0]!.proposal.action.kind).toBe('read');
  });

  it('an unchanged target passes the gate; a missing cache file or a boundary pause makes the replay unavailable without an error', async () => {
    const h = await build({ decider: slowRiskAt(1), turns: [turn({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' })], limits: { maxSteps: 2 } });
    mkdirSync(join(h.workspace.root, 'src'), { recursive: true });
    writeFileSync(join(h.workspace.root, 'src/a.py'), 'def f():\n    return 1\n');
    h.engine.events.on('stage:start', (e) => {
      if (e.stage === 'risk') h.engine.pause({ at: 'now' });
    });
    await h.engine.run();
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false, replay: true }, turns: [read()], limits: { maxSteps: 1 }, workspace: createFakeWorkspace({ root: h.workspace.root }) });
    await h2.engine.run();
    expect(h2.provider.requests).toHaveLength(0);
    expect(h2.of('proposal')[0]!.proposal.action.kind).toBe('edit');
    expect(h.workspace.files.get('src/a.py')).toBe('def f():\n    return 1\n'); // the first harness's in-memory workspace is untouched
    expect(h2.workspace.files.get('src/a.py')).toContain('return 2');

    // a boundary pause has nothing to replay
    const h3 = await build({ turns: [read(), read()], limits: { maxSteps: 3 } });
    h3.engine.events.on('step:end', () => h3.engine.pause());
    await h3.engine.run();
    const h4 = await build({ store: h3.store, runsDir: h3.runsDir, resume: { runId: h3.engine.runId, force: false, replay: true }, turns: [read()], limits: { maxSteps: 2 } });
    await h4.engine.run();
    expect(h4.of('transcript').some((t) => /^replay unavailable: no paused proposal for step 2; fresh step at intent$/.test(t.text))).toBe(true);

    // the cache file vanished: unavailable, warn line, fresh step
    const h5 = await build({ decider: slowRiskAt(1), turns: [read()], limits: { maxSteps: 2 } });
    h5.engine.events.on('stage:start', (e) => {
      if (e.stage === 'risk') h5.engine.pause({ at: 'now' });
    });
    await h5.engine.run();
    h5.store.cache.clear();
    const h6 = await build({ store: h5.store, runsDir: h5.runsDir, resume: { runId: h5.engine.runId, force: false, replay: true }, turns: [read()], limits: { maxSteps: 1 } });
    await h6.engine.run();
    expect(h6.of('transcript').some((t) => t.level === 'warn' && /replay unavailable: cache\/step-1\.json is missing or unreadable/.test(t.text))).toBe(true);
    expect(h6.provider.requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------
// P3 — mid-LLM-round (llm-jev)
// ---------------------------------------------------------------------------------------

interface Pending {
  o: GenerateOptions;
  req: GenerateRequest;
  resolve: (r: GenerateResult) => void;
  reject: (e: unknown) => void;
}
/** a provider whose calls stay pending until the test settles them; rejects with the signal's reason on abort */
function deferredProvider(): FakeProvider & { pending: Pending[] } {
  const requests: GenerateRequest[] = [];
  const pending: Pending[] = [];
  return {
    name: 'mock',
    model: 'z-ai/glm-5.3-flash',
    requests,
    pending,
    generate(req, o) {
      requests.push(req);
      return new Promise<GenerateResult>((resolve, reject) => {
        if (o.signal.aborted) {
          reject(o.signal.reason);
          return;
        }
        o.signal.addEventListener('abort', () => reject(o.signal.reason), { once: true });
        pending.push({ o, req, resolve, reject });
      });
    },
  };
}
function result(k: number): GenerateResult {
  return { text: `sample ${k}`, toolCalls: [{ name: 'propose_action', input: { k }, rawJson: JSON.stringify({ k }) }], usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.004, calls: 1 }, model: 'z-ai/glm-5.3-flash', stopReason: 'tool_use', latencyMs: 100, generationId: `gen-${k}` };
}
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!cond()) throw new Error('condition not met');
}

/** a synthesizer that fires one round of three samples through the sanctioned channel and proposes from what arrived */
function roundSynth(seen: GenerateResult[][]): Synthesizer {
  return {
    name: 'round-scripted',
    async synthesize(ctx) {
      const gen = ctx.generate;
      if (gen === undefined) throw new Error('llm-jev must expose SynthesisContext.generate');
      ctx.emit({ type: 'synth', step: ctx.step, phase: 'llm:fire', detail: 'goal g1 round 1: 3 samples' });
      const req: GenerateRequest = { system: 'sys', messages: [{ role: 'user', content: 'fix f' }], maxTokens: 1500, temperature: 0.7, reasoning: { enabled: false } };
      // contract 1.4 (§12.0.2 P3): the samples name their goal and round, so the pause point is typed data, not the `synth` line
      const results = await Promise.all([0, 1, 2].map((k) => gen({ ...req, seed: k }, { sample: k, purpose: 'propose_fix', signal: new AbortController().signal, goalId: 'g1', goalRound: 1 })));
      seen.push(results);
      const p: Proposal = { goal: 'read after the round', action: { kind: 'read', paths: ['src/a.py'] }, plan: { done: [], remaining: ['fix f'], openProblems: [] }, rawText: '' };
      return p;
    },
  };
}

describe('P3 — a mid-LLM-round pause resumes and replays the arrived samples', () => {
  it('pause now with two of three samples arrived: the round cache holds them, the point names the round; the replay asks the generator for the third only', async () => {
    const provider = deferredProvider();
    const seen: GenerateResult[][] = [];
    const h = await build({ mode: 'llm-jev', synthesizer: roundSynth(seen), provider, limits: { maxSteps: 2 } });
    const running = h.engine.run();
    await until(() => provider.pending.length === 3);
    provider.pending[0]!.resolve(result(0));
    provider.pending[1]!.resolve(result(1));
    await until(() => h.of('generator:end').length === 2);
    // the third sample streamed a little, then the human pauses now
    provider.pending[2]!.o.onToolDelta?.('{"k":');
    h.engine.pause({ at: 'now' });
    const r = await running;
    expect(r.stopReason).toBe('human_pause');
    expect(r.steps).toBe(0);
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 4, resumable: true });
    const p = h.of('pause:point')[0]!.point;
    // the round and the arrived ids are the synthesizer's own facts, read back from what the cache file recorded
    expect(p).toEqual({ step: 1, round: 1, phase: 'propose', reason: 'now', resumableAt: 'cache/step-1.json', replayable: true, llm: { goalId: 'g1', round: 1, arrived: [0, 1] }, by: 'self', end: false });
    // the cache: the two arrived samples with their prompt hash; a sample's streamed chars are NOT a partial proposal (D13)
    const cache = h.store.cache.get('step-1.json') as { llmRound: { goalId: string; round: number; arrived: { sample: number; promptHash: string }[] }; partial: { chars: number } | null; proposal: null };
    expect(cache.proposal).toBeNull();
    expect(cache.llmRound).toMatchObject({ goalId: 'g1', round: 1 });
    expect(cache.llmRound.arrived.map((a) => a.sample)).toEqual([0, 1]);
    expect(new Set(cache.llmRound.arrived.map((a) => a.promptHash)).size).toBe(1);
    expect(cache.partial).toBeNull();
    expect(h.store.last()!.interruptedDetail).toEqual({ cache: 'cache/step-1.json', resumes: 1, at: expect.any(String), targetsSha: {}, replayable: true, partialChars: 0 });
    // the discarded attempt's rows: 2 completed + 1 cancelled, all marked discarded, under the step the replay reuses
    const rows = h.store.generator.filter((g) => g.step === 1);
    expect(rows.map((g) => [g.sample, g.cancelled ?? false, g.stopReason, g.discarded])).toEqual([
      [0, false, 'tool_use', true],
      [1, false, 'tool_use', true],
      [2, true, 'cancelled', true],
    ]);
    expect(provider.requests).toHaveLength(3);

    // --replay: the synthesizer fires the same round; samples 0 and 1 are served from the cache, only sample 2 reaches the provider
    const provider2 = deferredProvider();
    const seen2: GenerateResult[][] = [];
    const h2 = await build({ mode: 'llm-jev', synthesizer: roundSynth(seen2), provider: provider2, store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false, replay: true }, limits: { maxSteps: 1 } });
    const running2 = h2.engine.run();
    await until(() => provider2.pending.length === 1);
    expect(provider2.requests).toHaveLength(1);
    expect(provider2.pending[0]!.o.sample).toBe(2);
    provider2.pending[0]!.resolve(result(2));
    const r2 = await running2;
    expect(r2.stopReason).toBe('max_steps');
    expect(r2.steps).toBe(1);
    expect(seen2[0]!.map((x) => x.text)).toEqual(['sample 0', 'sample 1', 'sample 2']);
    expect(seen2[0]![0]!.generationId).toBe('gen-0');
    expect(h2.of('generator:end').map((e) => [e.sample, e.finishReason])).toEqual([[0, 'replayed'], [1, 'replayed'], [2, 'tool_use']]);
    expect(h2.of('transcript').some((t) => /^replaying step 1 from cache\/step-1\.json: 2 arrived LLM sample\(s\), no generator call for them$/.test(t.text))).toBe(true);
    expect(h2.of('transcript').filter((t) => /replayed from cache\/step-1\.json \(no generator call\)/.test(t.text))).toHaveLength(2);
    // only the fresh sample was metered and recorded for the replayed step; the two replayed ones cost nothing
    const rows2 = h.store.generator.filter((g) => g.step === 1 && g.discarded === undefined);
    expect(rows2.map((g) => g.sample)).toEqual([2]);
    expect(h.store.steps.at(-1)!.verify?.samples).toBe(1);
    // the meter restored the first attempt's 3 calls; the replayed samples added nothing — only the fresh third call was metered
    expect(h2.meter.snapshot().generator.calls).toBe(3 + 1);
    expect(stepCacheRel(1)).toBe('cache/step-1.json');
  });

  it('a pause now before any sample arrived is not replayable: the resume is a fresh round', async () => {
    const provider = deferredProvider();
    const h = await build({ mode: 'llm-jev', synthesizer: roundSynth([]), provider, limits: { maxSteps: 2 } });
    const running = h.engine.run();
    await until(() => provider.pending.length === 3);
    h.engine.pause({ at: 'now' });
    const r = await running;
    expect(r.stopReason).toBe('human_pause');
    // the round is reported even when nothing arrived (P3 reports the real round and arrived set), but it is not replayable
    expect(h.of('pause:point')[0]!.point).toMatchObject({ step: 1, round: 1, phase: 'propose', reason: 'now', replayable: false, resumableAt: 'cache/step-1.json', llm: { goalId: 'g1', round: 1, arrived: [] } });
    expect(h.store.last()!.interruptedDetail).toMatchObject({ replayable: false, partialChars: 0 });
  });
});
