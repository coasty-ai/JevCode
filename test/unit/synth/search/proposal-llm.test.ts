/**
 * proposal.ts additions of docs/LLM-JEV-DESIGN.md §6.2 and §6.6: an `llm` winner may touch up to 4 files
 * (code sources keep 2), its evidence selection is `llm`, and `completionEvidence` states the synthesizer's
 * completion facts for the claiming run.
 */
import { describe, expect, it } from 'vitest';

import { unifiedDiff } from '../../../../src/synth/py/index.js';
import { MAX_PATCH_FILES, VERIFIED_PATCH_MAX_FILES, completionEvidence, patchMaxFiles, proposePatch, selectionOf } from '../../../../src/synth/search/proposal.js';
import type { AppliedCandidate } from '../../../../src/synth/types.js';
import { GCD_BUGGY, GCD_OTHER_TEST, GCD_TEST, cand, executedRun, siteAt, sourceFile, summary } from './controller-fakes.js';
import { makeCtx, makeGoal, makeMemory, makeTrace } from './proposal-helpers.js';

const TEST_COMMAND = 'python3 -m pytest -q';

/** A candidate of `source` whose diff touches `n` files (the site file plus n − 1 siblings). */
function appliedOver(n: number, source: 'llm' | 'mutation'): AppliedCandidate {
  const file = sourceFile('gcd.py', GCD_BUGGY);
  const candidate = cand(siteAt(file, 5), 'return gcd(b, a % b)', { source, op: source === 'llm' ? 'sample_0_0' : 'argument_swap' });
  const files: { path: string; before: string; after: string }[] = [{ path: 'gcd.py', before: GCD_BUGGY, after: GCD_BUGGY.replace('gcd(a % b, b)', 'gcd(b, a % b)') }];
  for (let i = 1; i < n; i++) files.push({ path: `helper${i}.py`, before: `X = ${i}\n`, after: `X = ${i + 1}\n` });
  const diff = files.map((f) => unifiedDiff(f.path, f.before, f.after)).join('');
  return { candidate, files, diff };
}

describe('patch file bound by source (§6.2)', () => {
  it('an llm winner may touch 4 files, a code source 2', () => {
    expect(MAX_PATCH_FILES).toBe(2);
    expect(VERIFIED_PATCH_MAX_FILES).toBe(4);
    expect(patchMaxFiles(appliedOver(1, 'llm'))).toBe(4);
    expect(patchMaxFiles(appliedOver(1, 'mutation'))).toBe(2);
    const ctx = makeCtx();
    const goal = makeGoal({ id: 'g1', tests: [GCD_TEST], suspectedFiles: ['gcd.py'], status: 'fixed' });
    const mem = makeMemory({ goals: [goal] });
    const three = appliedOver(3, 'llm');
    const p = proposePatch(ctx, three, goal, mem);
    expect(p.action).toEqual({ kind: 'patch', diff: three.diff });
    expect(() => proposePatch(ctx, appliedOver(5, 'llm'), goal, mem)).toThrow(/at most 4/);
    expect(() => proposePatch(ctx, appliedOver(3, 'mutation'), goal, mem)).toThrow(/at most 2/);
    // an explicit bound overrides the source rule
    expect(() => proposePatch(ctx, three, goal, mem, undefined, undefined, undefined, { maxFiles: 2 })).toThrow(/at most 2/);
  });
  it('selectionOf names `llm` for an llm winner whatever the run mode; the trace decides otherwise', () => {
    const trace = makeTrace({ goalId: 'g1', runMode: 'SIEVE', candidatesTested: 7, arbitrated: false });
    expect(selectionOf(trace, appliedOver(1, 'llm'))).toEqual({ selection: 'llm', candidatesTested: 7, arbitrated: false });
    expect(selectionOf(trace, appliedOver(1, 'mutation')).selection).toBe('sieve');
    expect(selectionOf({ ...trace, runMode: 'RANK' }).selection).toBe('rank');
  });
});

describe('completionEvidence (§6.6)', () => {
  it('states the ledger, test-file and guard facts with no reproduction and no oracle off the repository class', () => {
    const ctx = makeCtx({ window: [executedRun(2, TEST_COMMAND, { passed: 2, failed: 0 })] });
    const fixed = makeGoal({ id: 'g1', tests: [GCD_TEST], status: 'fixed' });
    const mem = makeMemory({ goals: [fixed], baseline: summary({ command: TEST_COMMAND, passing: [GCD_TEST, GCD_OTHER_TEST], failing: [] }) });
    expect(completionEvidence(ctx, mem, TEST_COMMAND)).toEqual({ ledgerFixed: true, testsChanged: [], guardPending: false, repro: 'none', oracle: null, command: TEST_COMMAND });
    // an open goal, a pending guard batch, an empty ledger
    expect(completionEvidence(ctx, makeMemory({ goals: [fixed, makeGoal({ id: 'g2', status: 'open' })] }), TEST_COMMAND).ledgerFixed).toBe(false);
    expect(completionEvidence(ctx, makeMemory({ goals: [fixed], guardPending: true }), TEST_COMMAND).guardPending).toBe(true);
    expect(completionEvidence(ctx, makeMemory({ goals: [] }), TEST_COMMAND).ledgerFixed).toBe(false);
  });
  it('repository class: the reproduction verdict on the workspace and the oracle outcome; a persisted string outside the union is null (never completes)', () => {
    const ctx = makeCtx();
    const mem = makeMemory({ goals: [makeGoal({ id: 'g1', status: 'fixed' })] });
    expect(completionEvidence(ctx, mem, TEST_COMMAND, { oracleOutcome: 'valid', lastRepro: { verdict: { pass: true } } })).toMatchObject({ repro: 'pass', oracle: 'valid' });
    expect(completionEvidence(ctx, mem, TEST_COMMAND, { oracleOutcome: 'llm_valid', lastRepro: { verdict: { pass: false } } })).toMatchObject({ repro: 'fail', oracle: 'llm_valid' });
    expect(completionEvidence(ctx, mem, TEST_COMMAND, { oracleOutcome: 'no_blocks', lastRepro: null })).toMatchObject({ repro: 'none', oracle: 'no_blocks' });
    expect(completionEvidence(ctx, mem, TEST_COMMAND, { oracleOutcome: 'unknown', lastRepro: null }).oracle).toBeNull();
  });
});
