import { describe, expect, it } from 'vitest';

import type { Json } from '../../../../src/core/types.js';
import { AbortError } from '../../../../src/errors.js';
import { ESCAPE_KEY } from '../../../../src/jev/questions.js';
import {
  CHOICE_MAX_CANDIDATES,
  CHOICE_QUESTION_ID,
  CHUNK_MAX_CANDIDATES,
  HYBRID_MAX_CANDIDATES,
  SHORTLIST_SIZE,
  candidateKey,
  choiceFlagsAbsent,
  chunkSizes,
  createRanker,
  noulsFlagAbsent,
} from '../../../../src/synth/rank/index.js';
import { GCD_BUGGY_LINE, GCD_FILE, GCD_FIX, candidate, choiceOptions, context, distractors, noulIds, scriptedAsk, siteAt, sourceFile } from './helpers.js';

const site = siteAt(GCD_FILE, GCD_BUGGY_LINE);
const preferFix = (t: string): number => (t.trim() === GCD_FIX.trim() ? 10 : 1);
const noulFix = (t: string): number => (t.trim() === GCD_FIX.trim() ? 0.92 : 0.08);

/** `n` unique candidates with the fix at `fixAt`. */
function pool(n: number, fixAt: number): ReturnType<typeof candidate>[] {
  const cs = distractors(site, n - 1);
  cs.splice(fixAt, 0, candidate(site, GCD_FIX, { id: 'fix' }));
  return cs;
}

describe('regimes: method and request count', () => {
  it('N ≤ 10: one Choice, method choice, 1 request, escape present, ranked by P', async () => {
    const jev = scriptedAsk({ weight: preferFix });
    const r = await createRanker().rank(pool(CHOICE_MAX_CANDIDATES, 3), context(jev.ask));
    expect(r.method).toBe('choice');
    expect(r.requests).toBe(1);
    expect(jev.calls).toHaveLength(1);
    expect(Object.keys(jev.calls[0]!.questions)).toEqual([CHOICE_QUESTION_ID]);
    const q = jev.calls[0]!.questions[CHOICE_QUESTION_ID]!;
    expect(q.type === 'choice' && Object.keys(q.criteria)).toHaveLength(CHOICE_MAX_CANDIDATES + 1);
    expect(q.type === 'choice' && ESCAPE_KEY in q.criteria).toBe(true);
    expect(jev.calls[0]!.state).not.toHaveProperty('candidates');
    expect(jev.calls[0]!.stage).toBe('propose');
    expect(r.ranked[0]!.candidate.id).toBe('fix');
    expect(r.ranked[0]!.rank).toBe(1);
    expect(r.ranked.map((x) => x.rank)).toEqual(r.ranked.map((_, i) => i + 1));
    expect(r.escapeProbability).toBeCloseTo(0.2 / (10 + 9 + 0.2), 6);
    expect(r.fixProbablyAbsent).toBe(false);
    expect(r.signals.chunks).toBe(0);
  });

  it('10 < N ≤ 60: one request with the Choice AND a compact Noul per candidate; ranked by Noul; method nouls', async () => {
    const jev = scriptedAsk({ weight: () => 1, noul: noulFix });
    const r = await createRanker().rank(pool(HYBRID_MAX_CANDIDATES, 41), context(jev.ask));
    expect(r.method).toBe('nouls');
    expect(r.requests).toBe(1);
    expect(jev.calls).toHaveLength(1);
    const call = jev.calls[0]!;
    expect(noulIds(call)).toHaveLength(HYBRID_MAX_CANDIDATES);
    expect(call.questions[CHOICE_QUESTION_ID]?.type).toBe('choice');
    const state = call.state as Record<string, Json>;
    expect(Object.keys(state['candidates'] as Record<string, Json>)).toEqual(noulIds(call));
    expect(state).toHaveProperty('correct_fix_criteria');
    // The flat Choice was indifferent (all weights 1); the Nouls put the fix first.
    expect(r.ranked[0]!.candidate.id).toBe('fix');
    expect(r.ranked[0]!.probability).toBeCloseTo(0.92, 6);
    expect(r.ranked[0]!.noulProbability).toBeCloseTo(0.92, 6);
    expect(r.ranked[0]!.choiceProbability).toBeCloseTo(1 / (60 + 0.2), 6);
    expect(r.signals.maxNoul).toBeCloseTo(0.92, 6);
    expect(r.fixProbablyAbsent).toBe(false);
  });

  it('N = 11 is already the hybrid regime and N = 61 is already two-stage', async () => {
    const a = scriptedAsk({ weight: preferFix, noul: noulFix });
    expect((await createRanker().rank(pool(11, 0), context(a.ask))).method).toBe('nouls');
    const b = scriptedAsk({ weight: preferFix, noul: noulFix });
    const r = await createRanker().rank(pool(61, 60), context(b.ask));
    expect(r.method).toBe('two_stage');
    expect(r.requests).toBe(2);
    expect(b.calls).toHaveLength(2);
  });

  it('N > 60: chunked Nouls (one request per ≤ 254) then one Choice over the top-5; method two_stage', async () => {
    const jev = scriptedAsk({ weight: preferFix, noul: noulFix });
    const r = await createRanker().rank(pool(200, 150), context(jev.ask));
    expect(r.method).toBe('two_stage');
    expect(r.requests).toBe(2);
    expect(jev.calls).toHaveLength(2);
    expect(noulIds(jev.calls[0]!)).toHaveLength(200);
    expect(jev.calls[0]!.questions).not.toHaveProperty(CHOICE_QUESTION_ID);
    const stageTwo = jev.calls[1]!;
    expect(Object.keys(stageTwo.questions)).toEqual([CHOICE_QUESTION_ID]);
    expect(choiceOptions(stageTwo).size).toBe(SHORTLIST_SIZE);
    expect([...choiceOptions(stageTwo).values()]).toContain(GCD_FIX);
    expect(stageTwo.state).not.toHaveProperty('candidates');
    expect(r.ranked[0]!.candidate.id).toBe('fix');
    expect(r.ranked[0]!.choiceProbability).toBeDefined();
    expect(r.ranked[SHORTLIST_SIZE]!.choiceProbability).toBeUndefined();
    expect(r.ranked[SHORTLIST_SIZE]!.noulProbability).toBeCloseTo(0.08, 6);
    expect(r.ranked).toHaveLength(200);
    expect(r.ranked.map((x) => x.rank)).toEqual(r.ranked.map((_, i) => i + 1));
  });
});

describe('option keys ↔ candidate ids round-trip', () => {
  it('every option key names the candidate whose text is its description, and every non-unchanged candidate is ranked once', async () => {
    const jev = scriptedAsk({ weight: preferFix });
    const cands = pool(8, 5);
    const r = await createRanker().rank(cands, context(jev.ask));
    const options = choiceOptions(jev.calls[0]!);
    expect(options.size).toBe(8);
    for (const row of r.ranked) {
      expect(options.get(row.optionKey)).toBe(row.candidate.text);
    }
    expect(r.ranked.map((x) => x.candidate.id).sort()).toEqual(cands.map((c) => c.id).sort());
    expect([...options.keys()]).toEqual(cands.map((_, i) => candidateKey(i)));
  });

  it('two-stage: stage-two keys restart at candidate_aa and map back to the shortlisted candidates', async () => {
    const jev = scriptedAsk({ weight: preferFix, noul: noulFix });
    const r = await createRanker().rank(pool(70, 69), context(jev.ask));
    const stageTwo = choiceOptions(jev.calls[1]!);
    expect([...stageTwo.keys()]).toEqual(Array.from({ length: SHORTLIST_SIZE }, (_, i) => candidateKey(i)));
    expect(stageTwo.get('candidate_aa')).toBe(r.ranked[0]!.candidate.text);
  });
});

describe('the unchanged line and duplicates', () => {
  it('never offers the current line (in any spacing) as an option and counts the exclusion', async () => {
    const jev = scriptedAsk({ weight: preferFix });
    const cands = [candidate(site, '        return gcd(a % b, b)', { id: 'same' }), candidate(site, 'return gcd(a%b,b)', { id: 'same_spaced' }), ...pool(4, 1)];
    const r = await createRanker().rank(cands, context(jev.ask));
    const texts = [...choiceOptions(jev.calls[0]!).values()];
    expect(texts).not.toContain('        return gcd(a % b, b)');
    expect(texts).not.toContain('return gcd(a%b,b)');
    expect(texts).toHaveLength(4);
    expect(r.signals.excludedUnchanged).toBe(2);
    expect(r.ranked.map((x) => x.candidate.id)).not.toContain('same');
    expect(r.ranked).toHaveLength(4);
  });

  it('folds duplicate candidates into one option and ranks the duplicate right after its representative', async () => {
    const jev = scriptedAsk({ weight: preferFix });
    const cands = [...pool(3, 0), candidate(site, 'return gcd(b, a%b)', { id: 'fix_dup', source: 'donor' })];
    const r = await createRanker().rank(cands, context(jev.ask));
    expect(choiceOptions(jev.calls[0]!).size).toBe(3);
    expect(r.signals.duplicatesFolded).toBe(1);
    expect(r.ranked.slice(0, 2).map((x) => x.candidate.id)).toEqual(['fix', 'fix_dup']);
    expect(r.ranked[0]!.probability).toBe(r.ranked[1]!.probability);
    expect(r.ranked[1]!.optionKey).toBe(r.ranked[0]!.optionKey);
    expect(r.ranked.map((x) => x.rank)).toEqual([1, 2, 3, 4]);
  });

  it('candidates that differ only in follow-up edits are distinct options', async () => {
    const jev = scriptedAsk();
    const cands = [candidate(site, GCD_FIX, { id: 'plain' }), candidate(site, GCD_FIX, { id: 'with_edit', extraEdits: [{ path: 'gcd.py', line: 2, kind: 'delete' }] })];
    const r = await createRanker().rank(cands, context(jev.ask));
    expect(choiceOptions(jev.calls[0]!).size).toBe(2);
    expect(r.signals.duplicatesFolded).toBe(0);
  });

  it('returns an empty result without asking when every candidate is the current line, or there are none', async () => {
    const jev = scriptedAsk();
    const only = await createRanker().rank([candidate(site, '        return gcd(a % b, b)')], context(jev.ask));
    expect(only).toMatchObject({ ranked: [], requests: 0, fixProbablyAbsent: true, escapeProbability: 1, method: 'choice' });
    const none = await createRanker().rank([], context(jev.ask));
    expect(none.requests).toBe(0);
    expect(jev.calls).toHaveLength(0);
  });
});

describe('fix-absent detector', () => {
  it('Choice: flags when P(escape) − p_max ≥ 0.10, including the 0.50 − 0.40 floating-point case', () => {
    expect(choiceFlagsAbsent(0.5, 0.4)).toBe(true);
    expect(choiceFlagsAbsent(0.46, 0.35)).toBe(true);
    expect(choiceFlagsAbsent(0.45, 0.4)).toBe(false);
    expect(choiceFlagsAbsent(0.9, 0.05)).toBe(true);
    expect(choiceFlagsAbsent(0.3, 0.6)).toBe(false);
  });
  it('Nouls: flags when the highest Noul is below 0.5', () => {
    expect(noulsFlagAbsent(0.49)).toBe(true);
    expect(noulsFlagAbsent(0.5)).toBe(false);
    expect(noulsFlagAbsent(0.9)).toBe(false);
  });

  it('a Choice where the escape dominates sets fixProbablyAbsent and reports the signals', async () => {
    const jev = scriptedAsk({ weight: () => 1, escapeWeight: 20 });
    const r = await createRanker().rank(pool(5, 0), context(jev.ask));
    expect(r.escapeProbability).toBeCloseTo(20 / 25, 6);
    expect(r.signals.pMax).toBeCloseTo(1 / 25, 6);
    expect(r.fixProbablyAbsent).toBe(true);
    expect(r.signals.choiceFlags).toBe(true);
    expect(r.signals.noulFlags).toBeNull();
  });

  it('a Choice with a clear winner and small escape does not flag', async () => {
    const jev = scriptedAsk({ weight: preferFix, escapeWeight: 0.5 });
    const r = await createRanker().rank(pool(5, 0), context(jev.ask));
    expect(r.fixProbablyAbsent).toBe(false);
  });

  it('hybrid: either detector firing flags the set (Nouls all below 0.5 with an indifferent Choice)', async () => {
    const jev = scriptedAsk({ weight: () => 1, escapeWeight: 1, noul: () => 0.3 });
    const r = await createRanker().rank(pool(20, 0), context(jev.ask));
    expect(r.signals.choiceFlags).toBe(false);
    expect(r.signals.noulFlags).toBe(true);
    expect(r.fixProbablyAbsent).toBe(true);
  });

  it('hybrid: a high Noul with a non-dominant escape does not flag', async () => {
    const jev = scriptedAsk({ weight: preferFix, escapeWeight: 1, noul: noulFix });
    const r = await createRanker().rank(pool(20, 7), context(jev.ask));
    expect(r.fixProbablyAbsent).toBe(false);
  });
});

describe('chunking', () => {
  it('chunkSizes splits evenly under the cap', () => {
    expect(chunkSizes(500, CHUNK_MAX_CANDIDATES)).toEqual([250, 250]);
    expect(chunkSizes(254, 254)).toEqual([254]);
    expect(chunkSizes(255, 254)).toEqual([128, 127]);
    expect(chunkSizes(1000, 254)).toEqual([250, 250, 250, 250]);
    expect(chunkSizes(0, 254)).toEqual([]);
  });

  it('500 candidates: two concurrent Noul requests of 250 each, keys restarting per chunk, merged by probability, then one Choice', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => (release = res));
    const inner = scriptedAsk({ weight: preferFix, noul: noulFix, gate });
    const ask: typeof inner.ask = async (stage, state, questions) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await inner.ask(stage, state, questions);
      } finally {
        inFlight--;
      }
    };
    // The fix sits in the second chunk; merging by Noul must still put it first.
    const pending = createRanker().rank(pool(500, 480), context(ask));
    await new Promise((res) => setTimeout(res, 0));
    expect(inFlight).toBe(2);
    release();
    const r = await pending;
    expect(maxInFlight).toBe(2);
    expect(r.method).toBe('two_stage');
    expect(r.requests).toBe(3);
    expect(r.signals.chunks).toBe(2);
    expect(inner.calls).toHaveLength(3);
    const [c1, c2, c3] = inner.calls as [(typeof inner.calls)[number], (typeof inner.calls)[number], (typeof inner.calls)[number]];
    expect(noulIds(c1)).toHaveLength(250);
    expect(noulIds(c2)).toHaveLength(250);
    expect(noulIds(c1)[0]).toBe('candidate_aa');
    expect(noulIds(c2)[0]).toBe('candidate_aa');
    expect(Object.keys(c3.questions)).toEqual([CHOICE_QUESTION_ID]);
    expect(r.ranked[0]!.candidate.id).toBe('fix');
    expect(r.ranked).toHaveLength(500);
    expect(new Set(r.ranked.map((x) => x.candidate.id)).size).toBe(500);
    expect(r.ranked.map((x) => x.rank)).toEqual(r.ranked.map((_, i) => i + 1));
  });

  it('bounds concurrency at maxConcurrentRequests', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const inner = scriptedAsk({ noul: noulFix });
    const ask: typeof inner.ask = async (stage, state, questions) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((res) => setTimeout(res, 1));
      try {
        return await inner.ask(stage, state, questions);
      } finally {
        inFlight--;
      }
    };
    const r = await createRanker({ maxConcurrentRequests: 2 }).rank(pool(1000, 999), context(ask));
    expect(r.requests).toBe(5);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(r.ranked[0]!.candidate.id).toBe('fix');
  });
});

describe('abort signal', () => {
  it('a pre-aborted signal rejects with the controller reason before any request', async () => {
    const jev = scriptedAsk();
    const ac = new AbortController();
    const reason = new AbortError('human_abort');
    ac.abort(reason);
    await expect(createRanker().rank(pool(3, 0), context(jev.ask, { signal: ac.signal }))).rejects.toBe(reason);
    expect(jev.calls).toHaveLength(0);
  });

  it('aborting while a request is in flight rejects promptly with an AbortError and stops the pipeline', async () => {
    const gate = new Promise<void>(() => undefined); // never resolves: the "request" hangs
    const jev = scriptedAsk({ gate, noul: noulFix });
    const ac = new AbortController();
    const pending = createRanker().rank(pool(100, 0), context(jev.ask, { signal: ac.signal }));
    await new Promise((res) => setTimeout(res, 0));
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
    expect(jev.calls).toHaveLength(1); // stage two never started
  });

  it('abort between stages is honoured', async () => {
    const ac = new AbortController();
    const inner = scriptedAsk({ noul: noulFix });
    const ask: typeof inner.ask = async (stage, state, questions) => {
      const r = await inner.ask(stage, state, questions);
      ac.abort(new AbortError('signal'));
      return r;
    };
    await expect(createRanker().rank(pool(80, 0), context(ask, { signal: ac.signal }))).rejects.toBeInstanceOf(AbortError);
    expect(inner.calls).toHaveLength(1);
  });
});

describe('errors', () => {
  it('propagates a failing ask', async () => {
    const boom = new Error('network down');
    const jev = scriptedAsk({ fail: boom });
    await expect(createRanker().rank(pool(3, 0), context(jev.ask))).rejects.toBe(boom);
  });

  it('stops launching stage-one chunks once one has failed', async () => {
    const boom = new Error('network down');
    const inner = scriptedAsk({ noul: noulFix });
    let started = 0;
    const ask: typeof inner.ask = async (stage, state, questions) => {
      started++;
      await new Promise((res) => setTimeout(res, 1));
      if (started === 1) throw boom;
      return inner.ask(stage, state, questions);
    };
    // 1000 candidates = 4 chunks; with one request at a time the failure of the first must end it.
    await expect(createRanker({ maxConcurrentRequests: 1 }).rank(pool(1000, 999), context(ask))).rejects.toBe(boom);
    expect(started).toBe(1);
  });

  it('rejects candidates from different sites', async () => {
    const other = siteAt(GCD_FILE, 2);
    const jev = scriptedAsk();
    await expect(createRanker().rank([candidate(site, GCD_FIX), candidate(other, '    if b == 1:')], context(jev.ask))).rejects.toThrow(/not at the site/);
  });

  it('rejects a malformed answer set (missing choice)', async () => {
    const ask: ReturnType<typeof scriptedAsk>['ask'] = async () => ({ answers: {}, rows: [], latencyMs: 0 });
    await expect(createRanker().rank(pool(3, 0), context(ask))).rejects.toThrow(TypeError);
  });

  it('validates its own options', () => {
    expect(() => createRanker({ choiceMax: 20, hybridMax: 10 })).toThrow(RangeError);
    expect(() => createRanker({ chunkMax: 300 })).toThrow(RangeError);
  });
});

describe('determinism', () => {
  it('the same candidates and answers give byte-identical requests and outcomes in every regime', async () => {
    for (const [n, fixAt] of [
      [8, 5],
      [30, 17],
      [300, 222],
    ] as const) {
      const a = scriptedAsk({ weight: preferFix, noul: noulFix });
      const b = scriptedAsk({ weight: preferFix, noul: noulFix });
      const ra = await createRanker().rank(pool(n, fixAt), context(a.ask));
      const rb = await createRanker().rank(pool(n, fixAt), context(b.ask));
      expect(JSON.stringify(a.calls)).toBe(JSON.stringify(b.calls));
      expect(ra.ranked.map((r) => [r.candidate.id, r.probability, r.rank, r.optionKey])).toEqual(rb.ranked.map((r) => [r.candidate.id, r.probability, r.rank, r.optionKey]));
      expect(ra.signals).toEqual(rb.signals);
    }
  });

  it('ties are broken by enumeration order, not by chance', async () => {
    const jev = scriptedAsk({ weight: () => 1, noul: () => 0.5 });
    const cands = pool(6, 3);
    const r = await createRanker().rank(cands, context(jev.ask));
    expect(r.ranked.map((x) => x.candidate.id)).toEqual(cands.map((c) => c.id));
  });
});

describe('module-level and insert sites', () => {
  it('ranks at a module-level replace site with a windowed program', async () => {
    const mod = sourceFile('cfg.py', 'LIMIT = 10\nSTEP = 2\nNAME = "x"\n');
    const s = siteAt(mod, 2);
    const jev = scriptedAsk({ weight: (t) => (t.includes('3') ? 5 : 1) });
    const r = await createRanker().rank([candidate(s, 'STEP = 3'), candidate(s, 'STEP = 1')], context(jev.ask, { failures: [{ testId: 't', call: 'step()', expected: '3', actual: '2' }] }));
    const state = jev.calls[0]!.state as Record<string, Json>;
    expect(state['program']).toEqual({ L1: 'LIMIT = 10', L2: 'STEP = 2', L3: 'NAME = "x"' });
    expect(state['task']).toContain('The Python code in `program`');
    expect(r.ranked[0]!.candidate.text).toBe('STEP = 3');
  });

  it('uses the insert wording for insert sites', async () => {
    const s = siteAt(GCD_FILE, 3, 'insert');
    const jev = scriptedAsk();
    await createRanker().rank([candidate(s, '        a, b = b, a'), candidate(s, '        b = abs(b)')], context(jev.ask));
    const q = jev.calls[0]!.questions[CHOICE_QUESTION_ID]!;
    expect(q.type === 'choice' && String(q.instructions)).toContain('inserted immediately after `buggy_line`');
  });

  it('an insertion at the top of the file uses the "before" wording on the Choice, the Nouls and the task', async () => {
    const s = siteAt(GCD_FILE, 1, 'insert');
    const jev = scriptedAsk({ noul: (t) => (t.includes('math') ? 0.9 : 0.1) });
    const cands = [candidate(s, 'import math', { id: 'imp' }), ...Array.from({ length: 11 }, (_, i) => candidate(s, `import mod${i}`, { id: `m${i}` }))];
    const r = await createRanker().rank(cands, context(jev.ask));
    const call = jev.calls[0]!;
    const q = call.questions[CHOICE_QUESTION_ID]!;
    expect(q.type === 'choice' && String(q.instructions)).toContain('inserted immediately before `buggy_line`');
    expect(String(call.questions['candidate_aa']!.instructions)).toContain('inserted immediately before `buggy_line`');
    const state = call.state as Record<string, Json>;
    expect(state['buggy_line_number']).toBe('L1');
    expect(String(state['task'])).toContain('immediately before');
    expect(r.ranked[0]!.candidate.id).toBe('imp');
  });
});
