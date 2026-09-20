/**
 * jev-only mode (docs/JEV-ONLY.md): the propose stage is a Synthesizer, the generator slot is
 * never called, `synth` events reach transcript.log through the shared item model, and every
 * Jev question a synthesizer asks (ctx.ask or ctx.decider.ask) is metered and recorded.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './fakes.js';
import { answer, createFakeSandbox, intentIs, makeEngine, noulA, passingTests } from './fakes.js';
import type { GenerateRequest, SynthesisContext, Synthesizer } from '../../../src/core/types.js';
import { createNullProvider } from '../../../src/provider/null.js';
import { createSynthesizer, NOT_IMPLEMENTED_SUMMARY } from '../../../src/synth/index.js';
import { isCheckpointState } from '../../../src/checkpoint/store.js';
import { formatTranscriptItem, itemsFromEvent } from '../../../src/tui/plain.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

const SECRET = 'sk-or-v1-SECRETSECRETSECRETSECRET';

/** Step 1: one Choice through ctx.ask, then an edit. Step 2: one Noul through ctx.decider.ask, then done. */
function scriptedSynthesizer(): Synthesizer & { contexts: SynthesisContext[] } {
  const contexts: SynthesisContext[] = [];
  return {
    name: 'scripted',
    contexts,
    async synthesize(ctx) {
      contexts.push(ctx);
      if (ctx.step === 1) {
        ctx.emit({ type: 'synth', step: ctx.step, phase: 'localise', detail: 'src/a.py:2 `return 1`', candidates: 3 });
        const { answers, rows } = await ctx.ask(
          'propose',
          { task: ctx.task, line: 'return 1', candidates: { 'return 2': 'c0', 'return 0': 'c1', 'return -1': 'c2' } },
          { pick: { type: 'choice', instructions: 'Which candidate line at `candidates` makes the failing test pass?', criteria: { 'return 2': 'c0', 'return 0': 'c1', 'return -1': 'c2', none_of_these: null } } },
        );
        const pick = answers['pick'];
        const chosen = pick?.type === 'choice' ? pick.choice : 'none';
        ctx.emit({ type: 'synth', step: ctx.step, phase: 'select', detail: `chose ${chosen} (${rows.length} row)`, candidates: 3, tested: 1 });
        return {
          goal: 'fix f',
          action: { kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' },
          plan: { done: [], remaining: ['run tests'], openProblems: [] },
          rawText: `candidate return 2 (${SECRET})`,
        };
      }
      // direct decider access is the same metered, recorded path as ctx.ask
      await ctx.decider.ask({ tests: 'green' }, { verified: { type: 'noul', instructions: 'Did the last test run pass?', criteria: { true: 'all passed', false: 'a failure remains' } } }, { signal: ctx.signal, stage: 'propose', step: ctx.step });
      ctx.emit({ type: 'synth', step: ctx.step, phase: 'finish', detail: 'tests green' });
      return { goal: 'finish', action: { kind: 'done', summary: 'f returns 2' }, plan: { done: ['fix f', 'run tests'], remaining: [], openProblems: [] }, rawText: '' };
    },
  };
}

describe('jev-only happy path', () => {
  it('edit then done: zero generator usage, synth lines in transcript.log, synthesizer decisions recorded', async () => {
    const synth = scriptedSynthesizer();
    // the real NullProvider in the slot, wrapped only to satisfy the harness type
    const provider = Object.assign(createNullProvider(), { requests: [] as GenerateRequest[] });
    const h = await build({
      mode: 'jev-only',
      synthesizer: synth,
      provider,
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: { rules: [intentIs('edit', 1), intentIs('finish', 2), answer('judge', 'task_complete', noulA(0.95), 2)] },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('complete');
    expect(r.mode).toBe('jev-only');
    expect(r.steps).toBe(2);
    // no generating LLM: zero usage, no calls on the NullProvider, no generator events, no generator.jsonl rows
    expect(r.usage.generator).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });
    expect(provider.calls).toBe(0);
    expect(h.of('generator:start')).toEqual([]);
    expect(h.of('generator:end')).toEqual([]);
    expect(h.of('generator:delta')).toEqual([]);
    expect(h.store.generator).toEqual([]);
    expect(r.generatorTokensPerStep).toEqual([0, 0]);
    expect(r.tokensPerStep).toEqual(r.jevTokensPerStep);
    expect(r.jevTokensPerStep.every((t) => t > 0)).toBe(true);
    expect(r.timing.generatorMs).toBe(0);
    // the proposal flowed through risk, execute and judge like a generator proposal
    const [s1, s2] = h.store.steps;
    expect(s1!.proposal?.action).toEqual({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' });
    expect(s1!.risk?.verdict).toBe('ok');
    expect(s1!.outcome?.status).toBe('executed');
    expect(s1!.judge).not.toBeNull();
    expect(h.workspace.files.get('src/a.py')).toContain('return 2');
    expect(s2!.outcome?.status).toBe('noop');
    expect(s2!.completion).toBe(0.95);
    expect(s2!.stoppedAt).toBe('complete');
    // rawText redacted like a generator reply
    expect(s1!.proposal?.rawText).toContain('[REDACTED:test]');
    expect(JSON.stringify(h.store.steps)).not.toContain(SECRET);
    // synth events: emitted, and one transcript.log line each through the shared item model
    expect(h.of('synth').map((e) => e.phase)).toEqual(['localise', 'select', 'finish']);
    expect(h.store.transcript).toContain('[step 1] synth localise: src/a.py:2 `return 1` (candidates=3)');
    expect(h.store.transcript).toContain('[step 1] synth select: chose return 2 (1 row) (candidates=3, tested=1)');
    expect(h.store.transcript).toContain('[step 2] synth finish: tests green');
    let seq = 0;
    const expected: string[] = [];
    for (const e of h.events) for (const item of itemsFromEvent(e, seq++)) expected.push(formatTranscriptItem(item));
    expect(h.store.transcript).toEqual(expected);
    // the synthesizer's questions went through the engine: decisions.jsonl, jev.jsonl, the pane, the meter
    const proposeRows = h.store.decisions.filter((d) => d.stage === 'propose');
    expect(proposeRows.map((d) => [d.step, d.id])).toEqual([[1, 'pick'], [2, 'verified']]);
    expect(proposeRows[0]!.answer).toMatchObject({ type: 'choice', choice: 'return 2' });
    expect(s1!.decisions.some((d) => d.id === 'pick')).toBe(true);
    expect(s2!.decisions.some((d) => d.id === 'verified')).toBe(true);
    expect(h.of('decision').filter((e) => e.decision.stage === 'propose')).toHaveLength(2);
    expect(h.store.jevRequests.filter((q) => q.stage === 'propose')).toHaveLength(2);
    expect(r.usage.jev.calls).toBe(h.decider.calls.length);
    expect(r.jevQuestions).toBe(h.store.steps.reduce((n, s) => n + s.decisions.length, 0));
    // the SynthesisContext carries the step draft
    const [c1, c2] = synth.contexts;
    expect(c1).toMatchObject({ runId: h.engine.runId, step: 1, intent: 'edit', directive: null });
    expect(c1!.contextFiles.map((f) => f.path)).toContain('src/a.py');
    expect(c1!.plan.remaining).toEqual([]);
    expect(c1!.workspaceInfo.testCommand?.command).toBe('pytest -q');
    expect(c1!.signal).toBe(h.engine.signal);
    expect(c1!.limits.maxSteps).toBe(40);
    expect(c1!.redact(SECRET)).toBe('[REDACTED:test]');
    expect(c2).toMatchObject({ step: 2, intent: 'finish' });
    expect(c2!.plan.remaining).toEqual(['run tests']);
    expect(c2!.window.map((w) => w.action)).toEqual(['edit src/a.py']);
    // run.json and the checkpoint record the mode; the store's structural check accepts it
    expect(h.store.meta?.mode).toBe('jev-only');
    expect(h.store.last()?.mode).toBe('jev-only');
    expect(isCheckpointState(JSON.parse(JSON.stringify(h.store.last())))).toBe(true);
    expect(h.of('run:start')[0]?.mode).toBe('jev-only');
    // status events during propose carry the propose stage (the TUI adds the synth marker from the mode)
    expect(h.of('stage:start').map((e) => e.stage).slice(0, 5)).toEqual(['intent', 'context', 'propose', 'risk', 'execute']);
  });

  it('a jev-only run resumes as jev-only', async () => {
    const synth = scriptedSynthesizer();
    const h = await build({ mode: 'jev-only', synthesizer: synth, sandbox: createFakeSandbox(() => passingTests), limits: { maxSteps: 1 } });
    const r1 = await h.engine.run();
    expect(r1.stopReason).toBe('max_steps');
    const h2 = await build({ mode: 'jev-only', synthesizer: synth, store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, limits: { maxSteps: 2 }, deciderOptions: { rules: [answer('judge', 'task_complete', noulA(0.95), 2)] } });
    const r2 = await h2.engine.run();
    expect(r2.mode).toBe('jev-only');
    expect(r2.steps).toBe(2);
    expect(r2.usage.generator.calls).toBe(0);
    expect(synth.contexts.map((c) => c.step)).toEqual([1, 2]);
    // resuming under another mode is refused
    await expect(makeEngine({ mode: 'jev-on', store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false } })).rejects.toMatchObject({ code: 'config' });
  });
});

describe('jev-only failure policy and configuration', () => {
  it('a throwing synthesizer is a stage failure at propose; three in a row stop the run with error', async () => {
    const boom: Synthesizer = {
      name: 'boom',
      synthesize: async () => {
        throw new Error('search exhausted');
      },
    };
    const h = await build({ mode: 'jev-only', synthesizer: boom, limits: { maxSteps: 6 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('error');
    expect(r.steps).toBe(3);
    expect(r.counters.failed).toBe(3);
    expect(r.usage.generator.calls).toBe(0);
    for (const s of h.store.steps) {
      expect(s.error).toMatchObject({ stage: 'propose', code: 'internal', message: 'search exhausted' });
      expect(s.outcome).toEqual({ status: 'failed', error: 'propose: internal' });
      expect(s.proposal).toBeNull();
      expect(s.risk).toBeNull();
      expect(s.judge).toBeNull();
    }
    expect(h.of('error').filter((e) => !e.fatal)).toHaveLength(3);
    expect(h.store.last()?.error).toEqual({ stage: 'propose', code: 'internal' });
    expect(h.provider.requests).toEqual([]);
  });

  it('createEngine rejects jev-only without a synthesizer with a ConfigError', async () => {
    await expect(makeEngine({ mode: 'jev-only' })).rejects.toMatchObject({ code: 'config', setting: 'mode', message: expect.stringContaining('synthesizer') });
  });

  it('the placeholder synthesizer proposes done and emits one synth line per step', async () => {
    const h = await build({ mode: 'jev-only', synthesizer: createSynthesizer({ decider: undefined as never, redact: (s) => s }), limits: { maxSteps: 1 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    expect(r.usage.generator.calls).toBe(0);
    expect(h.store.steps[0]!.proposal?.action).toEqual({ kind: 'done', summary: NOT_IMPLEMENTED_SUMMARY });
    expect(h.store.transcript).toContain(`[step 1] synth placeholder: ${NOT_IMPLEMENTED_SUMMARY} (candidates=0, tested=0)`);
    expect(h.provider.requests).toEqual([]);
  });
});
