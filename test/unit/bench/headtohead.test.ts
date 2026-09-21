/**
 * The head-to-head arithmetic of docs/LLM-JEV-DESIGN.md §1.3 / §10.4 on synthetic records: Wilson intervals, the exact
 * one-sided sign test at the design's quoted values, the exact Wilcoxon signed-rank test, discordant pairs, verdict
 * parsing, and the pre-registered criteria evaluated on a QuixBugs-shaped pair that passes and one that fails.
 */
import { describe, expect, it } from 'vitest';
import { evaluateAttribution, evaluateCriteria, pairArms, parseVerdictsMarkdown, suiteHeadToHead, verdictParagraph, type Verdict, type Verdicts } from '../../../src/bench/headtohead.js';
import { buildRecord } from '../../../src/bench/runner.js';
import { binomialTailOneSided, discordantPairs, signTestOneSided, wilcoxonSignedRankOneSided, wilson } from '../../../src/bench/stats.js';
import type { BenchRecord } from '../../../src/bench/types.js';
import type { BenchCondition } from '../../../src/core/types.js';
import { fakeRunResult, syntheticSource } from './helpers.js';

describe('stats', () => {
  it('Wilson 95 % interval', () => {
    const w = wilson(7, 10)!;
    expect(w.lo).toBeCloseTo(0.3968, 3);
    expect(w.hi).toBeCloseTo(0.8922, 3);
    expect(wilson(0, 0)).toBeNull();
    expect(wilson(0, 10)!.lo).toBe(0);
    expect(wilson(10, 10)!.hi).toBe(1);
  });

  it('one-sided exact sign test at the values §1.3 quotes', () => {
    expect(signTestOneSided(8, 0)).toBeCloseTo(0.0039, 4);
    expect(signTestOneSided(10, 2)).toBeCloseTo(0.0193, 4);
    expect(signTestOneSided(5, 0)).toBeCloseTo(0.03125, 6);
    expect(signTestOneSided(0, 0)).toBeNull();
    expect(binomialTailOneSided(0, 4)).toBe(1);
  });

  it('exact one-sided Wilcoxon signed-rank (ties averaged, zeros dropped)', () => {
    expect(wilcoxonSignedRankOneSided([-3, -5, -2, 1])).toEqual({ n: 4, wPlus: 1, p: 0.125 });
    expect(wilcoxonSignedRankOneSided([-1, -2, -3, -4, -5]).p).toBeCloseTo(1 / 32, 9);
    expect(wilcoxonSignedRankOneSided([-2, -2, 2, 0])).toEqual({ n: 3, wPlus: 2, p: 0.5 });
    expect(wilcoxonSignedRankOneSided([0, 0]).p).toBeNull();
  });

  it('discordant pairs', () => {
    const d = discordantPairs([
      { candidate: true, baseline: false },
      { candidate: true, baseline: false },
      { candidate: false, baseline: true },
      { candidate: true, baseline: true },
      { candidate: false, baseline: false },
    ]);
    expect(d).toMatchObject({ b: 2, c: 1, both: 1, neither: 1, n: 5 });
    expect(d.p).toBeCloseTo(0.5, 9);
  });
});

// ---------------------------------------------------------------------------------------
// synthetic QuixBugs-shaped records
// ---------------------------------------------------------------------------------------

interface Spec {
  pass: boolean;
  wallMs: number;
  costUsd: number;
  steps?: number;
  blocked?: number;
  patchEmpty?: boolean;
}

function rec(task: string, condition: BenchCondition, s: Spec): BenchRecord {
  const base = buildRecord({
    source: syntheticSource({ id: task }),
    condition,
    result: fakeRunResult({ runId: `r-${task}-${condition}`, mode: condition === 'llm-sieve' ? 'llm-jev' : condition === 'jev-off-tuned' ? 'jev-off' : condition, steps: s.steps ?? 2, wallMs: s.wallMs, usage: { generator: { inputTokens: 10, outputTokens: 10, costUsd: s.costUsd, calls: 1 }, jev: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 } }, counters: { blocked: s.blocked ?? 0, reviews: 0, declined: 0, failed: 0, loops: 0, replans: 0, reads: 0 } }),
    evaluation: { pass: s.pass, evaluator: 'local' },
    patch: { modelPatch: s.pass ? 'd' : '', patchBytes: s.pass ? 1 : 0, patchEmpty: s.patchEmpty ?? !s.pass },
    capFired: null,
  });
  return { ...base, suite: 'quixbugs' };
}

const tasks = Array.from({ length: 12 }, (_, i) => `p${String(i).padStart(2, '0')}`);

/** candidate solves 11/12 in 10 s at $0.002; baseline solves 3/12 in 100 s at $0.009 → b = 9, c = 1 */
function winningPair(): { records: BenchRecord[]; verdicts: Verdicts } {
  const records: BenchRecord[] = [];
  const vc = new Map<string, Verdict>();
  const vb = new Map<string, Verdict>();
  tasks.forEach((t, i) => {
    const candPass = i !== 11; // misses the last one, which the baseline solves (c = 1)
    const basePass = i < 2 || i === 11;
    records.push(rec(t, 'llm-jev', { pass: candPass, wallMs: 10_000, costUsd: 0.002 }));
    records.push(rec(t, 'jev-off', { pass: basePass, wallMs: 100_000, costUsd: 0.009, steps: 5 }));
    vc.set(t, candPass ? 'gold-identical' : 'miss');
    vb.set(t, basePass ? (i === 0 ? 'equivalent' : 'gold-identical') : 'miss');
  });
  return { records, verdicts: new Map([['llm-jev', vc], ['jev-off', vb]]) };
}

describe('paired arms and criteria', () => {
  it('a QuixBugs pair that meets every bar: discordant counts, ratios, criteria 1–4 and the secondary gates pass', () => {
    const { records, verdicts } = winningPair();
    const pair = pairArms('quixbugs', records, 'llm-jev', 'jev-off', verdicts)!;
    expect(pair.rows).toHaveLength(12);
    expect(pair.discordant).toMatchObject({ b: 9, c: 1, both: 2, neither: 0, n: 12 });
    expect(pair.discordant.p).toBeCloseTo(11 / 1024, 9);
    expect(pair.passes).toEqual({ candidate: 11, baseline: 3 });
    expect(pair.correct).toEqual({ candidate: 11, baseline: 3, candidateOverfit: 0, baselineOverfit: 0 });
    expect(pair.wall.medianRatio).toBeCloseTo(0.1, 9);
    expect(pair.wall.wilcoxon).toEqual({ n: 12, wPlus: 0, p: 1 / 4096 });
    expect(pair.cost.perTaskRatio).toBeCloseTo(0.002 / 0.009, 9);
    expect(pair.cost.perSolvedRatio).toBeCloseTo(0.024 / 11 / (0.108 / 3), 9);
    expect(pair.bothSolved.n).toBe(2);
    const results = evaluateCriteria(pair);
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ['1', 'pass'],
      ['2', 'pass'],
      ['3', 'pass'],
      ['4', 'pass'],
      ['S1', 'pass'],
      ['S2', 'pass'],
      ['S3', 'pass'],
    ]);
    expect(results[0]!.detail).toContain('b = 9');
    expect(results[0]!.detail).toContain('sign test p = 0.011');
  });

  it('a pair the baseline wins back on 3 tasks fails criterion 1 (c ≤ 2), and a missing verdict makes criterion 2 not evaluable', () => {
    const { records } = winningPair();
    // flip three more baseline-only wins: candidate fails p08..p10 while the baseline passes them
    const flipped = records.map((r) => (['p08', 'p09', 'p10'].includes(r.task) ? { ...r, pass: r.condition === 'jev-off' } : r));
    const pair = pairArms('quixbugs', flipped, 'llm-jev', 'jev-off', null)!;
    expect(pair.discordant).toMatchObject({ b: 6, c: 4 });
    const results = evaluateCriteria(pair);
    expect(results.find((r) => r.id === '1')).toMatchObject({ status: 'fail' });
    expect(results.find((r) => r.id === '2')).toMatchObject({ status: 'not_evaluable' });
    const h = suiteHeadToHead('quixbugs', flipped, ['jev-off', 'llm-jev']);
    expect(h.criteria.map((c) => c.status)).toContain('fail');
    expect(verdictParagraph([h], evaluateAttribution([h.attribution]))).toContain('Failed: quixbugs criterion 1');
  });

  it('attribution (criterion 5): llm-sieve at parity fails the strict-improvement bar; a matching jev-off-tuned is said first', () => {
    const { records, verdicts } = winningPair();
    const withArms = [...records];
    for (const r of records.filter((x) => x.condition === 'llm-jev')) {
      withArms.push({ ...r, condition: 'llm-sieve', runId: `${r.runId}-sieve` });
      withArms.push({ ...r, condition: 'jev-off-tuned', runId: `${r.runId}-tuned` });
    }
    const v: Verdicts = new Map([...verdicts, ['llm-sieve', verdicts.get('llm-jev')!], ['jev-off-tuned', verdicts.get('llm-jev')!]]);
    const h = suiteHeadToHead('quixbugs', withArms, ['jev-off', 'llm-jev', 'llm-sieve', 'jev-off-tuned'], { verdicts: v });
    expect(h.arms).toEqual(['jev-off', 'llm-jev', 'llm-sieve', 'jev-off-tuned']);
    expect(h.pairs.map((p) => p.candidate)).toEqual(['llm-jev', 'llm-sieve', 'jev-off-tuned']);
    const attribution = evaluateAttribution([h.attribution]);
    expect(attribution.find((a) => a.id === '5a')).toMatchObject({ status: 'fail' });
    expect(attribution.find((a) => a.id === '5b')!.detail.startsWith('jev-off-tuned MATCHES')).toBe(true);
    expect(verdictParagraph([h], attribution)).toContain('hygiene, not Jev');
  });

  it('parses the verdict tables of both inspect scripts', () => {
    const quix = ['# Per-program verdicts', '', '| program | solved | verdict | evidence |', '| --- | --- | --- | --- |', '| bitcount | yes | gold-identical | token-identical |', '| wrap | no | miss | a patch still fails |', '| kth | yes | overfit | differs on 1 input |', '', 'Totals: …'].join('\n');
    expect([...parseVerdictsMarkdown(quix)]).toEqual([
      ['bitcount', 'gold-identical'],
      ['wrap', 'miss'],
      ['kth', 'overfit'],
    ]);
    const ladder = ['| task | tier | solved | verdict | evidence |', '| --- | --- | --- | --- | --- |', '| profiles | short | yes | equivalent | differs from gold |', '| units | short | yes | overfit (weak only) | … |'].join('\n');
    expect([...parseVerdictsMarkdown(ladder)]).toEqual([
      ['profiles', 'equivalent'],
      ['units', 'overfit'],
    ]);
  });
});
