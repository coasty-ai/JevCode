/**
 * jev-only with code-computed evidence (docs/JEV-ONLY-DESIGN.md §5.1): a synthesizer's verified
 * `patch` goes through the risk stage with `proposal.evidence` in the state and the evidence
 * questions, lands `ok` on level-0/1 Scores, and the ledger in the plan resolves the next intent
 * to `verify` instead of a fallback `investigate`. jev-on with the same Jev answers resolves as
 * §6 says (fallback), so the generator path gets no new latitude.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './fakes.js';
import { answer, choiceOver, createFakeSandbox, intentIs, makeEngine, noulA, passingTests, turn } from './fakes.js';
import type { Answer, JsonObject, ProposalEvidence, Synthesizer } from '../../../src/core/types.js';
import type { DeciderRule } from './fakes.js';
import { EVIDENCE_CONSISTENT_ID } from '../../../src/jev-modes/stages/risk.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

const ITEM = 'fix tests/test_a.py::test_f in src/a.py';
const VERIFY_ITEM = 'verify the full test suite passes';
const DIFF = '--- a/src/a.py\n+++ b/src/a.py\n@@ -1,2 +1,2 @@\n def f():\n-    return 1\n+    return 2\n';

const patchEvidence: ProposalEvidence = {
  kind: 'shadow_test_run',
  command: 'pytest -q',
  before: { passed: 1, failed: 1, errors: 0, total: 2 },
  after: { passed: 2, failed: 0, errors: 0, total: 2 },
  newlyPassing: ['tests/test_a.py::test_f'],
  newlyFailing: [],
  goalTests: ['tests/test_a.py::test_f'],
  selection: 'sieve',
  candidatesTested: 42,
  arbitrated: false,
};

/** Step 1: a verified patch. Step 2: the post-patch run with the same measurement. Step 3: done. */
function evidenceSynthesizer(): Synthesizer {
  return {
    name: 'evidence',
    async synthesize(ctx) {
      if (ctx.step === 1) {
        return {
          goal: 'apply verified fix: tests/test_a.py::test_f now passes (1→2 of 2), no regressions; mutation/constant at src/a.py:2',
          action: { kind: 'patch', diff: DIFF },
          plan: { done: [], remaining: [ITEM, VERIFY_ITEM], openProblems: [] },
          rawText: '{"kind":"search"}',
          evidence: patchEvidence,
        };
      }
      if (ctx.step === 2) {
        return {
          goal: 'verify the suite after fixing tests/test_a.py::test_f (src/a.py changed since the last test run; expect 2 of 2 tests to pass)',
          action: { kind: 'run', command: 'pytest -q' },
          plan: { done: [ITEM], remaining: [VERIFY_ITEM], openProblems: [] },
          rawText: '{"kind":"run"}',
          evidence: patchEvidence,
        };
      }
      return { goal: 'all 2 tests pass; 1 fix committed', action: { kind: 'done', summary: 'all 2 tests pass; 1 fix committed' }, plan: { done: [VERIFY_ITEM], remaining: [], openProblems: [] }, rawText: '{"kind":"done"}' };
    },
  };
}

/** Jev answers `edit` at p but finds no paired Noul >= 0.5: a §6 fallback to investigate. */
function lowNoulEdit(step: number, p = 0.6): DeciderRule {
  return (ctx) => {
    if (ctx.stage !== 'intent' || ctx.step !== step) return undefined;
    const keys = Object.keys((ctx.questions['intent'] as { criteria: Record<string, unknown> }).criteria);
    const out: Record<string, Answer> = { intent: choiceOver(keys, 'edit', p) };
    for (const k of keys) if (k !== 'none_of_these') out[`can_${k}`] = noulA(0.2);
    return out;
  };
}

function proposalOf(state: unknown): JsonObject {
  return (state as JsonObject)['proposal'] as JsonObject;
}

describe('jev-only: verified patch, evidence in the risk and judge states, ledger-resolved intent', () => {
  it('a verified patch with level-0/1 Scores executes; the run after it is proposed under `verify` although Jev answered a low-Noul `edit`', async () => {
    const h = await build({
      mode: 'jev-only',
      synthesizer: evidenceSynthesizer(),
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: { rules: [intentIs('edit', 1), lowNoulEdit(2), intentIs('finish', 3), answer('judge', 'task_complete', noulA(0.95), 3)] },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('complete');
    expect(r.steps).toBe(3);
    expect(r.usage.generator.calls).toBe(0);
    const [s1, s2, s3] = h.store.steps;

    // step 1: the risk state carried the evidence with the code-computed verified flag; the evidence question was asked; the patch executed
    const risk1 = h.decider.callsAt('risk')[0]!;
    expect(proposalOf(risk1.state)['evidence']).toEqual({ ...patchEvidence, verified: true });
    expect(Object.keys(risk1.questions)).toContain(EVIDENCE_CONSISTENT_ID);
    expect(String((risk1.questions['plan_mismatch'] as { criteria: string[] }).criteria[2])).toContain('`proposal.evidence.verified`');
    expect(s1!.risk?.verdict).toBe('ok');
    expect(s1!.risk?.reason).toContain('evidence verified: 1→2 of 2 pass, no regressions (sieve, 42 tested); proposal: apply verified fix');
    expect(s1!.outcome?.status).toBe('executed');
    expect(s1!.proposal?.evidence).toEqual(patchEvidence);
    expect(h.store.decisions.some((d) => d.step === 1 && d.stage === 'risk' && d.id === EVIDENCE_CONSISTENT_ID)).toBe(true);
    // step 1 had no ledger yet (empty plan): the plain intent questions and no `ledger` in the state
    const intent1 = h.decider.callsAt('intent')[0]!;
    expect((intent1.state as JsonObject)['ledger']).toBeUndefined();
    expect((intent1.questions['intent'] as { criteria: Record<string, string> }).criteria['edit']).toBe('change source files');

    // step 2: the accepted plan carries the ledger; the state shows it; edit/verify are described as the synthesizer's steps
    const intent2 = h.decider.callsAt('intent')[1]!;
    expect((intent2.state as JsonObject)['mode']).toBe('jev-only');
    expect((intent2.state as JsonObject)['ledger']).toEqual({ items: [ITEM] });
    expect((intent2.questions['intent'] as { criteria: Record<string, string> }).criteria['edit']).toBe('apply a verified fix for an item in `plan.remaining`');
    // Jev's edit (p 0.6, every paired Noul 0.2) would be a §6 fallback to investigate; a change is unverified, so the ledger rule gives verify
    expect(s2!.intent).toBe('verify');
    expect(s2!.intentAnswer).toBe('edit');
    expect(s2!.loopSignatures).not.toContain('intent:unresolved');
    const rows2 = h.store.decisions.filter((d) => d.step === 2 && d.stage === 'intent');
    expect(rows2.find((d) => d.id === 'intent')?.verdict).toBe('overridden');
    expect(rows2.find((d) => d.id === 'can_verify')?.verdict).toBe('chosen');
    expect(h.of('intent').find((e) => e.step === 2)).toMatchObject({ intent: 'verify', answer: 'edit' });
    // the run carried evidence too: risk ok, and the judge state saw the shadow counts next to the executed run's
    expect(s2!.risk?.verdict).toBe('ok');
    expect(s2!.outcome?.status).toBe('executed');
    const judge2 = h.decider.callsAt('judge').find((c) => c.step === 2)!;
    expect(proposalOf(judge2.state)['evidence']).toMatchObject({ verified: true, after: { passed: 2 } });
    expect(((judge2.state as JsonObject)['executed'] as JsonObject)['tests']).toMatchObject({ parsed: { passed: 2, failed: 0 } });
    // the claim on the run was judged and accepted; the plan closed; done completed the run
    expect(s2!.judge?.doneClaims).toEqual([{ text: ITEM, judged: 0.9, accepted: true }]);
    expect(s3!.outcome?.status).toBe('noop');
    expect(s3!.completion).toBe(0.95);
    // a `done` carries no evidence: the plain risk questions were asked for it
    expect(Object.keys(h.decider.callsAt('risk')[2]!.questions)).not.toContain(EVIDENCE_CONSISTENT_ID);
  });

  it('jev-on is unchanged: the same low-Noul `edit` answer over a plan with fix-items falls back to investigate and trips the intent:unresolved signature', async () => {
    const h = await build({
      turns: [turn({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' }, { remaining: [ITEM, VERIFY_ITEM] }), turn({ kind: 'run', command: 'pytest -q' }, { remaining: [ITEM, VERIFY_ITEM] })],
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: { rules: [intentIs('edit', 1), lowNoulEdit(2)] },
      limits: { maxSteps: 2 },
    });
    const r = await h.engine.run();
    expect(r.mode).toBe('jev-on');
    const s2 = h.store.steps[1]!;
    expect(s2.intent).toBe('investigate');
    expect(s2.intentAnswer).toBe('edit');
    expect(s2.loopSignatures).toContain('intent:unresolved');
    expect(h.store.decisions.find((d) => d.step === 2 && d.id === 'intent')?.verdict).toBe('fallback');
    const intent2 = h.decider.callsAt('intent')[1]!;
    expect((intent2.state as JsonObject)['ledger']).toBeUndefined();
    expect((intent2.state as JsonObject)['mode']).toBeUndefined();
    expect((intent2.questions['intent'] as { criteria: Record<string, string> }).criteria['edit']).toBe('change source files');
    // a generator proposal never carries evidence: the plain risk questions
    for (const c of h.decider.callsAt('risk')) expect(Object.keys(c.questions)).not.toContain(EVIDENCE_CONSISTENT_ID);
  });

  it('jev-only without ledger items in the plan resolves as §6 (fallback) too', async () => {
    const synth: Synthesizer = {
      name: 'no-ledger',
      async synthesize(ctx) {
        if (ctx.step === 1) return { goal: 'fix f', action: { kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' }, plan: { done: [], remaining: ['run tests'], openProblems: [] }, rawText: '' };
        return { goal: 'run', action: { kind: 'run', command: 'pytest -q' }, plan: { done: [], remaining: ['run tests'], openProblems: [] }, rawText: '' };
      },
    };
    const h = await build({ mode: 'jev-only', synthesizer: synth, sandbox: createFakeSandbox(() => passingTests), deciderOptions: { rules: [intentIs('edit', 1), lowNoulEdit(2)] }, limits: { maxSteps: 2 } });
    await h.engine.run();
    const s2 = h.store.steps[1]!;
    expect(s2.intent).toBe('investigate');
    expect(s2.loopSignatures).toContain('intent:unresolved');
    expect((h.decider.callsAt('intent')[1]!.state as JsonObject)['ledger']).toBeUndefined();
  });
});
