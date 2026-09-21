/**
 * llm-jev mode (docs/LLM-JEV-DESIGN.md §3, §4.8, §6.3, §6.6): the synth propose stage with the sanctioned generator
 * channel — no intent or context request, per-sample generator rows (a cancelled sample metered from an estimate),
 * the batch wall in `timing.generatorMs`, code-`ok` risk before any Jev request for a verified patch and a
 * verification run, the code judge with Q21/Q22 recorded only, and completion as a code fact on the claiming run. The
 * accounting of samples that yield no result (§4.8, §8): sibling / prompt-chars estimates, the table rate, unpriced
 * fail-closed, a never-dispatched sample, a provider failure after streaming; and `retryNow()` over the per-sample wakers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './fakes.js';
import { createFakeSandbox, driveRetries, makeEngine, passingTests, type FakeProvider } from './fakes.js';
import { ProviderHttpError } from '../../../src/errors.js';
import type { GenerateOptions, GenerateRequest, GenerateResult, Proposal, ProposalEvidence, SynthesisContext, Synthesizer } from '../../../src/core/types.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

const GOAL_TEST = 'tests/test_a.py::test_f';
const LEDGER_ITEM = `fix ${GOAL_TEST} in src/a.py`;
const DIFF = '--- a/src/a.py\n+++ b/src/a.py\n@@ -1,2 +1,2 @@\n def f():\n-    return 1\n+    return 2\n';

function evidence(over: Partial<ProposalEvidence> = {}): ProposalEvidence {
  return {
    kind: 'shadow_test_run',
    command: 'pytest -q',
    before: { passed: 1, failed: 1, errors: 0, total: 2 },
    after: { passed: 2, failed: 0, errors: 0, total: 2 },
    newlyPassing: [GOAL_TEST],
    newlyFailing: [],
    goalTests: [GOAL_TEST],
    selection: 'llm',
    candidatesTested: 3,
    arbitrated: false,
    ...over,
  };
}

/** A provider whose calls stay pending until the test settles them (the test streams through `o.onToolDelta`); rejects with the signal's reason on abort. */
interface Pending {
  o: GenerateOptions;
  resolve: (r: GenerateResult) => void;
  reject: (e: unknown) => void;
}
function deferredProvider(model = 'z-ai/glm-5.3-flash'): FakeProvider & { pending: Pending[] } {
  const requests: GenerateRequest[] = [];
  const pending: Pending[] = [];
  return {
    name: 'mock',
    model,
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
        pending.push({ o, resolve, reject });
      });
    },
  };
}

function generateOf(ctx: SynthesisContext): NonNullable<SynthesisContext['generate']> {
  const gen = ctx.generate;
  if (gen === undefined) throw new Error('llm-jev must expose SynthesisContext.generate');
  return gen;
}

const PARTIAL_DONE: Proposal = { goal: 'partial', action: { kind: 'done', summary: 'partial: test_f still open' }, plan: { done: [], remaining: [LEDGER_ITEM], openProblems: [] }, rawText: '' };
/** a §6.6 claiming-run declaration with every fact holding (pytest class: no reproduction, no oracle) */
const COMPLETE: NonNullable<ProposalEvidence['completion']> = { ledgerFixed: true, testsChanged: [], guardPending: false, repro: 'none', oracle: null, command: 'pytest -q' };

function result(latencyMs: number, k: number): GenerateResult {
  return { text: '', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.004, calls: 1 }, model: 'z-ai/glm-5.3-flash', stopReason: 'tool_use', latencyMs, generationId: `gen-${k}` };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!cond()) throw new Error('condition not met');
}

describe('llm-jev: sanctioned generator channel, mode plumbing, code-fact stages', () => {
  it('verified patch then claiming run: no intent/context/risk requests, per-sample rows incl. a cancelled estimate, batch-wall timing, code judge, complete by fact', async () => {
    const clock = { t: 1_000 };
    const provider = deferredProvider();
    const contexts: SynthesisContext[] = [];
    const synth: Synthesizer = {
      name: 'llm-scripted',
      async synthesize(ctx) {
        contexts.push(ctx);
        if (ctx.step === 1) {
          const gen = ctx.generate;
          if (gen === undefined) throw new Error('llm-jev must expose SynthesisContext.generate');
          const req: GenerateRequest = { system: 'sys', messages: [{ role: 'user', content: 'fix f' }], maxTokens: 1500, temperature: 0.7, reasoning: { enabled: false } };
          const controllers = [0, 1, 2].map(() => new AbortController());
          // three samples of one round: same prompt (one prefix), per-sample seed and signal
          const calls = controllers.map((c, k) => gen({ ...req, seed: k }, { sample: k, purpose: 'propose_fix', signal: c.signal }));
          await until(() => provider.pending.length === 3);
          clock.t += 100;
          provider.pending[0]!.resolve(result(100, 0));
          await calls[0];
          clock.t += 150;
          provider.pending[1]!.resolve(result(250, 1));
          await calls[1];
          // sample 2 streamed 8 tool-argument chars, then hits its deadline after the siblings finished: no result, an estimate, the round's wall stays 250
          provider.pending[2]!.o.onToolDelta?.('{"a":1}}');
          controllers[2]!.abort(new Error('sample deadline 20000 ms exceeded'));
          await expect(calls[2]).rejects.toThrow('sample deadline');
          ctx.emit({ type: 'synth', step: ctx.step, phase: 'llm:round', detail: '2 valid, 1 timeout' });
          const p: Proposal = { goal: 'fix f: return 2 (LLM sample 0)', action: { kind: 'patch', diff: DIFF }, plan: { done: [], remaining: [LEDGER_ITEM], openProblems: [] }, rawText: '' };
          p.evidence = evidence();
          return p;
        }
        // the claiming run (§6.6): the synthesizer declares it on the evidence and claims the fixed goal
        const run: Proposal = { goal: 'verify the suite after fixing test_f', action: { kind: 'run', command: 'pytest -q' }, plan: { done: [LEDGER_ITEM], remaining: [], openProblems: [] }, rawText: '' };
        run.evidence = evidence({ completion: COMPLETE });
        return run;
      },
    };
    const h = await build({
      mode: 'llm-jev',
      synthesizer: synth,
      provider,
      now: () => clock.t,
      sandbox: createFakeSandbox((cmd) => (cmd.startsWith('pytest') ? passingTests : { stdout: 'ok' })),
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('complete');
    expect(r.mode).toBe('llm-jev');
    expect(r.steps).toBe(2);
    const [s1, s2] = h.store.steps;

    // §3 rows 2–3, §13: no intent Choice, no context Nouls; the intent is a code fact of the proposal kind
    expect(h.decider.callsAt('intent')).toEqual([]);
    expect(h.decider.callsAt('context')).toEqual([]);
    expect(h.of('stage:start').map((e) => e.stage)).toEqual(['propose', 'risk', 'execute', 'judge', 'propose', 'risk', 'execute', 'judge']);
    expect([s1!.intent, s1!.intentAnswer]).toEqual(['edit', 'edit']);
    expect([s2!.intent, s2!.intentAnswer]).toEqual(['verify', 'verify']);
    expect(h.of('intent').map((e) => [e.step, e.intent, e.probability, e.verdict])).toEqual([[1, 'edit', 1, 'code'], [2, 'verify', 1, 'code']]);
    // §9.3: in this mode the intent follows the proposal (a fact of its kind), it does not precede it
    const order = h.events.filter((e) => e.type === 'intent' || e.type === 'proposal').map((e) => e.type);
    expect(order).toEqual(['proposal', 'intent', 'proposal', 'intent']);
    expect(s1!.proposer).toBe('synth');
    expect(contexts[0]!.contextFiles).toEqual([]);

    // §3 row 5 / §6.3: a verified patch and a verification run are `ok` by code before any Jev request
    expect(h.decider.callsAt('risk')).toEqual([]);
    expect(s1!.risk?.verdict).toBe('ok');
    expect(s1!.risk?.reason).toMatch(/^risk 0\.00 \(ok\) by code: verified patch — evidence verified: 1→2 of 2 pass, no regressions \(llm, 3 tested\)/);
    expect(s1!.risk?.reason).toContain('1 non-test workspace file (src/a.py)');
    expect(s1!.risk?.dims.out_of_scope).toMatchObject({ level: 0, risk: 0, confidence: 1 });
    expect(s2!.risk?.reason).toBe('risk 0.00 (ok) by code: verification run of the workspace test command `pytest -q`');
    expect(s1!.outcome?.status).toBe('executed');
    expect(h.workspace.files.get('src/a.py')).toContain('return 2');

    // §4.8: one generator.jsonl row per sample, the cancelled one an estimate at the sibling's served rate
    const rows = h.store.generator.filter((g) => g.step === 1);
    expect(rows.map((g) => [g.sample, g.purpose, g.cancelled ?? false, g.stopReason, g.latencyMs])).toEqual([
      [0, 'propose_fix', false, 'tool_use', 100],
      [1, 'propose_fix', false, 'tool_use', 250],
      [2, 'propose_fix', true, 'timeout', 250],
    ]);
    expect(rows.map((g) => g.generationId)).toEqual(['gen-0', 'gen-1', undefined]);
    expect(rows.map((g) => [g.temperature, g.maxTokens])).toEqual([[0.7, 1500], [0.7, 1500], [0.7, 1500]]);
    expect(new Set(rows.map((g) => g.promptHash)).size).toBe(1);
    const cancelled = rows[2]!;
    expect(cancelled.usage).toEqual({ inputTokens: 1000, outputTokens: 2, costUsd: (0.004 / 1200) * 1002, calls: 1, estimated: true });
    // the estimate reached the meter, the step usage and the token counter
    expect(s1!.usage.generator.calls).toBe(3);
    expect(s1!.usage.generator.inputTokens).toBe(3000);
    expect(s1!.usage.generator.costUsd).toBeCloseTo(0.008 + cancelled.usage.costUsd, 12);
    expect(h.meter.snapshot().generator.calls).toBe(3);
    expect(r.generatorTokensPerStep).toEqual([3000 + 402, 0]);
    // events carry the sample index; the cancelled sample ends with its stop reason
    expect(h.of('generator:start').map((e) => e.sample)).toEqual([0, 1, 2]);
    expect(h.of('generator:end').map((e) => [e.sample, e.finishReason])).toEqual([[0, 'tool_use'], [1, 'tool_use'], [2, 'timeout']]);
    expect(h.of('generator:tool-delta')).toEqual([{ type: 'generator:tool-delta', step: 1, chars: 8, sample: 2 }]);
    // §4.8 / §7.5: generatorMs is the wall of the round (250), not the sum (100 + 250 + 250); synthMs holds the synth wall
    expect(s1!.timing.generatorMs).toBe(250);
    expect(s1!.timing.synthMs).toBe(250);
    expect(s2!.timing.generatorMs).toBe(0);
    expect(r.timing.generatorMs).toBe(250);
    expect(r.timing.synthMs).toBe(250);

    // §3 row 7: the patch step judges nothing and asks nothing; the run step is judged by code with Q21/Q22 recorded only
    expect(s1!.judge).toBeNull();
    expect(s1!.completion).toBeNull();
    const judgeCalls = h.decider.callsAt('judge');
    expect(judgeCalls.map((c) => [c.step, Object.keys(c.questions)])).toEqual([[2, ['done_0', 'task_complete']]]);
    expect(s2!.judge).toMatchObject({ source: 'code', succeeded: 1, errorPresent: 0, newInfo: 0, tests: { source: 'parsed', allPassed: true, passed: 2, failed: 0, errors: 0 } });
    expect(s2!.judge?.doneClaims).toEqual([{ text: LEDGER_ITEM, judged: 1, accepted: true }]);
    expect(s2!.planAfter?.done.map((d) => d.text)).toEqual([LEDGER_ITEM]);
    // the fake decider's task_complete default (0.10) is recorded, not consulted: the stop is the code fact (§6.6)
    expect(s2!.completion).toBe(0.1);
    expect(s2!.stoppedAt).toBe('complete');
    expect(h.store.transcript).toContain('[step 1] synth llm:round: 2 valid, 1 timeout');
  });

  it('unverified best-guess patch and a partial done are gated on the two harm Scores only; the done is recorded, not complete', async () => {
    const synth: Synthesizer = {
      name: 'best-guess',
      async synthesize(ctx) {
        if (ctx.step === 1) {
          const p: Proposal = { goal: 'best guess: return 2', action: { kind: 'patch', diff: DIFF }, plan: { done: [], remaining: [LEDGER_ITEM], openProblems: [] }, rawText: '' };
          p.evidence = evidence({ after: { passed: 1, failed: 1, errors: 0, total: 2 }, newlyPassing: [], selection: 'sieve', candidatesTested: 1 });
          return p;
        }
        return { goal: 'partial', action: { kind: 'done', summary: 'partial: test_f still open' }, plan: { done: [], remaining: [LEDGER_ITEM], openProblems: ['test_f parked'] }, rawText: '' };
      },
    };
    const h = await build({ mode: 'llm-jev', synthesizer: synth, limits: { maxSteps: 2 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    const [s1, s2] = h.store.steps;
    // §5 Q20: harm dims only; `matches_intent`, `evidence_consistent`, `out_of_scope`, `plan_mismatch` are never asked
    expect(h.decider.callsAt('risk').map((c) => [c.step, Object.keys(c.questions)])).toEqual([[1, ['destructive', 'irreversible']], [2, ['destructive', 'irreversible']]]);
    expect(s1!.risk?.verdict).toBe('ok');
    expect(s1!.risk?.reason).toContain('harm-only (llm-jev): out_of_scope and plan_mismatch not asked, recorded at level 0, not gating');
    expect(s1!.risk?.reason).toContain('evidence unverified: 1→1 of 2 pass');
    expect(s1!.decisions.filter((d) => d.stage === 'risk').map((d) => [d.id, d.verdict])).toEqual([['destructive', 'ok'], ['irreversible', 'ok']]);
    expect(s1!.outcome?.status).toBe('executed');
    // the partial done: Q22 recorded (0.10 default), no code fact → not complete, note on the window entry
    expect(s2!.outcome?.status).toBe('noop');
    expect(h.decider.callsAt('judge').map((c) => [c.step, Object.keys(c.questions)])).toEqual([[2, ['task_complete']]]);
    expect(s2!.completion).toBe(0.1);
    // not complete by fact: the record stops at the step budget (max_steps 2), never `complete`
    expect(s2!.stoppedAt).toBe('step_start');
    expect(h.store.last()?.window.at(-1)?.notes).toContain('done rejected: no passing, current run verifies it (task_complete=0.10 recorded only)');
    expect(h.store.generator).toEqual([]);
  });

  it('jev-only exposes no generate; llm-jev needs a synthesizer at createEngine', async () => {
    const contexts: SynthesisContext[] = [];
    const synth: Synthesizer = {
      name: 'capture',
      async synthesize(ctx) {
        contexts.push(ctx);
        return { goal: 'done', action: { kind: 'done', summary: 'nothing' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' };
      },
    };
    const h = await build({ mode: 'jev-only', synthesizer: synth, limits: { maxSteps: 1 } });
    await h.engine.run();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.generate).toBeUndefined();
    await expect(makeEngine({ mode: 'llm-jev' })).rejects.toThrow('llm-jev mode requires a synthesizer');
  });

  it('a claiming run whose evidence fails a §6.6 fact (a test file was touched) is green but never complete', async () => {
    const synth: Synthesizer = {
      name: 'tests-changed',
      async synthesize() {
        const run: Proposal = { goal: 'verify', action: { kind: 'run', command: 'pytest -q' }, plan: { done: [LEDGER_ITEM], remaining: [], openProblems: [] }, rawText: '' };
        run.evidence = evidence({ completion: { ...COMPLETE, testsChanged: ['tests/test_a.py'] } });
        return run;
      },
    };
    const h = await build({ mode: 'llm-jev', synthesizer: synth, limits: { maxSteps: 1 }, sandbox: createFakeSandbox(() => passingTests) });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    const s1 = h.store.steps[0]!;
    expect(s1.judge).toMatchObject({ source: 'code', succeeded: 1 });
    expect(s1.stoppedAt).toBe('step_start');
  });

  it('estimates: no same-prompt sibling → prompt chars / 4 at the table rate, another prompt is never the sibling, a pre-cancelled sample is not dispatched, a failed streamed sample is metered', async () => {
    const provider = deferredProvider();
    const P: GenerateRequest = { system: 'sys', messages: [{ role: 'user', content: 'fix f please' }], maxTokens: 1500, temperature: 0.7 };
    const Q: GenerateRequest = { system: 'sys', messages: [{ role: 'user', content: 'write a reproduction script for the issue text' }], maxTokens: 1500, temperature: 0.7 };
    const inTok = Math.ceil((P.system.length + P.messages[0]!.content.length) / 4); // 15 chars → 4
    const synth: Synthesizer = {
      name: 'accounting',
      async synthesize(ctx) {
        const gen = generateOf(ctx);
        const c = [0, 1, 2, 3, 4].map(() => new AbortController());
        const s0 = gen({ ...P, seed: 0 }, { sample: 0, purpose: 'propose_fix', signal: c[0]!.signal });
        const s1 = gen({ ...P, seed: 1 }, { sample: 1, purpose: 'propose_fix', signal: c[1]!.signal });
        const s2 = gen(Q, { sample: 2, purpose: 'write_reproduction', signal: c[2]!.signal });
        await until(() => provider.pending.length === 3);
        // sample 0 streams 8 chars and times out before anything finished: no sibling, no run mean → prompt chars / 4 at the table rate
        provider.pending[0]!.o.onToolDelta?.('{"a":1}}');
        c[0]!.abort(new Error('sample deadline 20000 ms exceeded'));
        await expect(s0).rejects.toThrow('deadline');
        // the reproduction request — another prompt — finishes (1000 prompt tokens, $0.004)
        provider.pending[2]!.resolve(result(50, 2));
        await s2;
        // sample 1 is cancelled: sample 0's row is an estimate and sample 2's is another prompt — neither is its sibling
        c[1]!.abort(new Error('loser cancelled'));
        await expect(s1).rejects.toThrow('loser cancelled');
        // a sample already cancelled when it reaches the channel is never dispatched
        c[3]!.abort(new Error('cancelled before dispatch'));
        await expect(gen({ ...P, seed: 3 }, { sample: 3, purpose: 'propose_fix', signal: c[3]!.signal })).rejects.toThrow('cancelled before dispatch');
        // the provider fails a sample after it streamed 13 chars: served, so metered, stopReason 'error'
        const s4 = gen({ ...P, seed: 4 }, { sample: 4, purpose: 'propose_fix', signal: c[4]!.signal });
        await until(() => provider.pending.length === 4);
        provider.pending[3]!.o.onToolDelta?.('{"a":1,"b":2}');
        provider.pending[3]!.reject(new ProviderHttpError('HTTP 502', { status: 502, retryable: false }));
        await expect(s4).rejects.toThrow('HTTP 502');
        return PARTIAL_DONE;
      },
    };
    const h = await build({ mode: 'llm-jev', synthesizer: synth, provider, limits: { maxSteps: 1 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    // sample 3 never reached the provider and left no event or row
    expect(provider.requests).toHaveLength(4);
    expect(h.of('generator:start').map((e) => e.sample)).toEqual([0, 1, 2, 4]);
    const rows = h.store.generator;
    expect(rows.map((g) => [g.sample, g.purpose, g.cancelled ?? false, g.stopReason])).toEqual([
      [0, 'propose_fix', true, 'timeout'],
      [2, 'write_reproduction', false, 'tool_use'],
      [1, 'propose_fix', true, 'cancelled'],
      [4, 'propose_fix', true, 'error'],
    ]);
    const [r0, , r1, r4] = rows;
    // config/defaults.ts GLM 5.3 Flash row: $0.09/M in, $0.30/M out
    expect(r0!.usage).toMatchObject({ inputTokens: inTok, outputTokens: 2, calls: 1, estimated: true });
    expect(r0!.usage.costUsd).toBeCloseTo((inTok * 0.09 + 2 * 0.3) / 1e6, 15);
    // not sample 2's 1000 prompt tokens; priced at the run's mean rate over everything metered so far
    expect(r1!.usage).toMatchObject({ inputTokens: inTok, outputTokens: 0, calls: 1, estimated: true });
    expect(r1!.usage.costUsd).toBeCloseTo(((r0!.usage.costUsd + 0.004) / (inTok + 2 + 1200)) * inTok, 15);
    expect(r4!.usage).toMatchObject({ inputTokens: inTok, outputTokens: 4, calls: 1, estimated: true });
    expect(h.of('generator:end').map((e) => [e.sample, e.finishReason])).toEqual([[0, 'timeout'], [2, 'tool_use'], [1, 'cancelled'], [4, 'error']]);
    expect(h.of('budget:unpriced')).toEqual([]);
    expect(h.meter.snapshot().generator.calls).toBe(4);
    expect(h.store.steps[0]!.usage.generator.calls).toBe(4);
  });

  it('an estimate no rate can price is unpriced and fails closed; EngineOptions.generatorPricing prices it', async () => {
    const P: GenerateRequest = { system: 'sys', messages: [{ role: 'user', content: 'fix f please' }], maxTokens: 1500, temperature: 0.7 };
    const timeoutFirst = (provider: ReturnType<typeof deferredProvider>): Synthesizer => ({
      name: 'timeout-first',
      async synthesize(ctx) {
        const c = new AbortController();
        const s = generateOf(ctx)(P, { sample: 0, purpose: 'propose_fix', signal: c.signal });
        await until(() => provider.pending.length === 1);
        c.abort(new Error('sample deadline 20000 ms exceeded'));
        await expect(s).rejects.toThrow('deadline');
        return PARTIAL_DONE;
      },
    });
    // a model the table does not know, nothing served yet: budget:unpriced, the step commits, the run stops with error (as a real call without usage.cost)
    const p1 = deferredProvider('vendor/unknown-model');
    const h1 = await build({ mode: 'llm-jev', synthesizer: timeoutFirst(p1), provider: p1, limits: { maxSteps: 3 } });
    const r1 = await h1.engine.run();
    expect(h1.of('budget:unpriced')).toEqual([{ type: 'budget:unpriced', side: 'generator', model: 'vendor/unknown-model', step: 1, tokens: { input: 4, output: 0 } }]);
    expect(r1.stopReason).toBe('error');
    expect(r1.steps).toBe(1);
    expect(h1.store.transcript.at(-2)).toBe('[run] warn: stop: error at step 1 (unpriced_usage)');
    expect(h1.store.generator[0]!.usage).toEqual({ inputTokens: 4, outputTokens: 0, costUsd: 0, calls: 1, estimated: true });
    // the resolved config pricing (overrides included) prices the same estimate
    const p2 = deferredProvider('vendor/unknown-model');
    const h2 = await build({ mode: 'llm-jev', synthesizer: timeoutFirst(p2), provider: p2, limits: { maxSteps: 1 }, engine: { generatorPricing: { inputPerM: 1, outputPerM: 2, cacheReadPerM: 0, cacheWritePerM: 0 } } });
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('max_steps');
    expect(h2.of('budget:unpriced')).toEqual([]);
    expect(h2.store.generator[0]!.usage.costUsd).toBeCloseTo(4 / 1e6, 15);
  });

  it('retryNow() ends a sample\'s retry sleep through the per-sample wakers and reports true once', async () => {
    const requests: GenerateRequest[] = [];
    const provider: FakeProvider = {
      name: 'mock',
      model: 'z-ai/glm-5.3-flash',
      requests,
      async generate(req, o) {
        requests.push(req);
        // sample 1 fails once with a 503 and would sleep 60 s before its retry; only the waker ends that sleep in time
        if (o.sample === 1) await driveRetries({ count: 1, waitMs: 60_000, status: 503 }, o);
        return result(10, o.sample ?? 0);
      },
    };
    const synth: Synthesizer = {
      name: 'two-samples',
      async synthesize(ctx) {
        const gen = generateOf(ctx);
        const c = new AbortController();
        const req: GenerateRequest = { system: 'sys', messages: [{ role: 'user', content: 'fix f' }], maxTokens: 1500, temperature: 0.7 };
        await Promise.all([0, 1].map((k) => gen({ ...req, seed: k }, { sample: k, purpose: 'propose_fix', signal: c.signal })));
        return PARTIAL_DONE;
      },
    };
    const h = await build({ mode: 'llm-jev', synthesizer: synth, provider, limits: { maxSteps: 1 } });
    const run = h.engine.run();
    await until(() => h.of('retry').length === 1);
    expect(h.of('retry')[0]).toMatchObject({ side: 'generator', step: 1, stage: 'propose', info: { attempt: 1, maxAttempts: 2, waitMs: 60_000 } });
    expect(h.engine.retryNow()).toBe(true);
    // the waker is spent: a second press before the next sleep is a no-op
    expect(h.engine.retryNow()).toBe(false);
    const r = await run;
    expect(r.stopReason).toBe('max_steps');
    expect(h.of('retry:settled')).toEqual([{ type: 'retry:settled', side: 'generator', step: 1, attempts: 2, ok: true, totalWaitMs: 60_000 }]);
    expect(h.store.generator.map((g) => [g.sample, g.cancelled ?? false, g.stopReason])).toEqual([[0, false, 'tool_use'], [1, false, 'tool_use']]);
  });
});
