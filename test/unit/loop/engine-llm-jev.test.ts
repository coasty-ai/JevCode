/**
 * llm-jev mode (docs/LLM-JEV-DESIGN.md §3, §4.8, §6.3, §6.6): the synth propose stage with the sanctioned generator
 * channel — no intent or context request, per-sample generator rows (a cancelled sample metered from an estimate),
 * the batch wall in `timing.generatorMs`, code-`ok` risk before any Jev request for a verified patch and a
 * verification run, the code judge with Q21/Q22 recorded only, and completion as a code fact on the claiming run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './fakes.js';
import { createFakeSandbox, makeEngine, passingTests, type FakeProvider } from './fakes.js';
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

/** A provider whose calls stay pending until the test resolves them; rejects with the signal's reason on abort. */
interface Pending {
  o: GenerateOptions;
  resolve: (r: GenerateResult) => void;
}
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
        // the sample that will be cancelled streamed 8 tool-argument chars before its deadline
        if (o.sample === 2) o.onToolDelta?.('{"a":1}}');
        pending.push({ o, resolve });
      });
    },
  };
}

function result(latencyMs: number, k: number): GenerateResult {
  return { text: '', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.004, calls: 1 }, model: 'z-ai/glm-5.3-flash', stopReason: 'tool_use', latencyMs, generationId: `gen-${k}` };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
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
          // sample 2 hits its deadline after the siblings finished: no result, an estimate, the round's wall stays 250
          controllers[2]!.abort(new Error('sample deadline 20000 ms exceeded'));
          await expect(calls[2]).rejects.toThrow('sample deadline');
          ctx.emit({ type: 'synth', step: ctx.step, phase: 'llm:round', detail: '2 valid, 1 timeout' });
          const p: Proposal = { goal: 'fix f: return 2 (LLM sample 0)', action: { kind: 'patch', diff: DIFF }, plan: { done: [], remaining: [LEDGER_ITEM], openProblems: [] }, rawText: '' };
          p.evidence = evidence();
          return p;
        }
        // the claiming run (§6.6): the synthesizer declares it on the evidence and claims the fixed goal
        const run: Proposal = { goal: 'verify the suite after fixing test_f', action: { kind: 'run', command: 'pytest -q' }, plan: { done: [LEDGER_ITEM], remaining: [], openProblems: [] }, rawText: '' };
        run.evidence = evidence({ completion: { command: 'pytest -q', allPassed: true, total: 2, step: 1 } });
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
    expect(h.of('intent').map((e) => [e.step, e.intent, e.probability])).toEqual([[1, 'edit', 1], [2, 'verify', 1]]);
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
});
