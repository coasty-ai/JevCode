/**
 * The guard's LLM rules (docs/LLM-JEV-DESIGN.md §6.2): a behaviour cluster holding a code seed and an
 * LLM candidate commits the LLM member by code (no Jev request); the representative of a cluster is
 * its most-agreed `llm` member; distinct clusters still go to Q15/Q16, where a Choice tie puts the
 * LLM member before the smaller edit.
 */
import { describe, expect, it } from 'vitest';

import { createGuardMemory } from '../../../../src/synth/search/bases.js';
import { arbitrate, clusterByBehaviour, decide, mixedSourceCluster, preferLlmInCluster } from '../../../../src/synth/search/guard.js';
import { GCD_BUGGY, GCD_OTHER_TEST, GCD_TEST } from './controller-fakes.js';
import { arbitrationScript, candidate, committedBase, failure, goal as goalOf, outcome, plausibleOutcome, scriptedAsk, siteAt, sourceFile, summary, throwingAsk } from './helpers.js';

const FIX = 'return gcd(b, a % b)';
const LLM_FIX = 'return gcd(b, a % b)  # llm';
const file = sourceFile('gcd.py', GCD_BUGGY);
const base = committedBase(file, summary({ failing: [GCD_TEST], passing: [GCD_OTHER_TEST] }));
const goal = goalOf([failure(GCD_TEST, '13', 'RecursionError')], { suspectedFiles: ['gcd.py'] });
const seed = candidate(siteAt(file, 5), FIX, { id: 'seed', source: 'mutation', op: 'argument_swap' });
const llm = candidate(siteAt(file, 5), LLM_FIX, { id: 'llm:abc', source: 'llm', op: 'sample_0_0', prior: 2 });

describe('preferLlmInCluster and the cluster representative', () => {
  it('the representative is the most-agreed llm member, else the min-edit member; a mixed cluster is recognised', () => {
    const s = plausibleOutcome(seed, base);
    const l1 = plausibleOutcome(candidate(siteAt(file, 5), 'return gcd(b, a % b)  # llm one', { id: 'llm:1', source: 'llm', prior: 1 }), base);
    const l3 = plausibleOutcome(candidate(siteAt(file, 5), 'return gcd(b, a % b)  # llm three, longer', { id: 'llm:3', source: 'llm', prior: 3 }), base);
    expect(preferLlmInCluster([s, l1, l3]).applied.candidate.id).toBe('llm:3');
    expect(preferLlmInCluster([s]).applied.candidate.id).toBe('seed');
    const clusters = clusterByBehaviour([s, l1, l3]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.representative.applied.candidate.id).toBe('llm:3');
    // the representative leads the members, so a single-cluster arbitration would include it
    expect(clusters[0]!.members[0]!.applied.candidate.id).toBe('llm:3');
    expect(mixedSourceCluster(clusters[0]!)).toBe(true);
    expect(mixedSourceCluster(clusterByBehaviour([l1, l3])[0]!)).toBe(false);
    // seeds alone keep the min-edit representative (jev-only unchanged)
    expect(clusterByBehaviour([s])[0]!.representative.applied.candidate.id).toBe('seed');
  });
});

describe('decide (§6.2)', () => {
  it('a seed and an LLM candidate in one behaviour cluster: the LLM member is committed by code, no Jev request, the seed is the fallback', async () => {
    const mem = createGuardMemory(base);
    const d = await decide([plausibleOutcome(seed, base), plausibleOutcome(llm, base)], mem, goal, throwingAsk);
    expect(d.kind).toBe('commit');
    if (d.kind === 'commit') {
      expect(d.applied.candidate.id).toBe('llm:abc');
      expect(d.outcome?.applied.candidate.id).toBe('llm:abc');
    }
    expect(d).toMatchObject({ plausible: 2, clusters: 1, arbitrated: false, requests: 0 });
    expect(d.fallbacks.map((o) => o.applied.candidate.id)).toEqual(['seed']);
  });

  it('distinct behaviour clusters go to Q15/Q16; on a Choice tie the LLM member wins over the smaller edit', async () => {
    // two passers with the same pass count (tests are the oracle first: `mostPassing`) but different outcome vectors → two clusters
    const X = 'tests/test_gcd.py::test_x';
    const Y = 'tests/test_gcd.py::test_y';
    const wide = committedBase(file, summary({ failing: [GCD_TEST, X, Y], passing: [GCD_OTHER_TEST] }));
    const mem = createGuardMemory(wide);
    const seedRun = summary({ passing: [GCD_OTHER_TEST, GCD_TEST, X], failing: [Y] });
    const llmRun = summary({ passing: [GCD_OTHER_TEST, GCD_TEST, Y], failing: [X] });
    // the runner classifies a goal-passing, non-regressing candidate `plausible` (the helper's default reads a still-failing base test as `partial`)
    const seedOut = outcome(seed, wide, { subset: seedRun, full: seedRun, status: 'plausible' });
    const llmOut = outcome(llm, wide, { subset: llmRun, full: llmRun, status: 'plausible' });
    expect(clusterByBehaviour([seedOut, llmOut])).toHaveLength(2);
    const ask = scriptedAsk(arbitrationScript({ choice: { [FIX]: 0.45, [LLM_FIX]: 0.45 }, escape: 0.1, noul: { [FIX]: 0.8, [LLM_FIX]: 0.8 } }));
    const d = await decide([seedOut, llmOut], mem, goal, ask);
    expect(d.kind).toBe('commit');
    if (d.kind === 'commit') expect(d.applied.candidate.id).toBe('llm:abc');
    expect(d).toMatchObject({ clusters: 2, arbitrated: true, requests: 1 });
    expect(ask.calls).toHaveLength(1);
    // the same tie through `arbitrate` directly
    const arb = await arbitrate({ goal }, clusterByBehaviour([seedOut, llmOut]), scriptedAsk(arbitrationScript({ choice: { [FIX]: 0.4, [LLM_FIX]: 0.4 }, escape: 0.2, noul: { [FIX]: 0.7, [LLM_FIX]: 0.7 } })));
    expect(arb.pick.applied.candidate.id).toBe('llm:abc');
    // a clear Choice winner is still the pick, whatever its source
    const seedWins = await arbitrate({ goal }, clusterByBehaviour([seedOut, llmOut]), scriptedAsk(arbitrationScript({ choice: { [FIX]: 0.7, [LLM_FIX]: 0.2 }, escape: 0.1, noul: { [FIX]: 0.8, [LLM_FIX]: 0.7 } })));
    expect(seedWins.pick.applied.candidate.id).toBe('seed');
  });
});
