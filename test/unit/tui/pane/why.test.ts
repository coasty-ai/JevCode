import { describe, expect, it } from 'vitest';
import type { Decision } from '../../../../src/core/types.js';
import { whyBlock } from '../../../../src/tui/why.js';
import { mkDecision } from '../../../fixtures/tui/fixtures.js';
import { stepSevenDecisions } from './helpers.js';

const decs = stepSevenDecisions();
const ctx = { siblings: decs, model: 'typesafe/jev-1.13-20260917', completeThreshold: 0.85 };

describe('the worked /why text (TUI-DESIGN §7.6 reference rendering)', () => {
  it('renders the plan_mismatch Score block: instructions, levels with bars, argmax / E[k] / tail / bound / risk, the confidence formula and the consumer', () => {
    const pm = decs.find((d) => d.id === 'plan_mismatch')!;
    expect(whyBlock(pm, ctx)).toEqual([
      'why s7.risk.plan_mismatch  request a1b2c3d4  244ms  typesafe/jev-1.13-20260917',
      '  How far is `proposal.action` from `plan` and `intent`?',
      '  score, 5 levels; alignment dimension → tail bound',
      '  L0 ██████▎···  0.62  matches `intent` and the plan',
      '  L1 ██▍·······  0.24  matches the plan, different order',
      '  L2 █·········  0.10  skips a planned verification step',
      "  L3 ▍·········  0.04  ignores the plan's open problems, or claims completion…",
      '  L4 ··········  0.00  contradicts the plan, repeats a step `recent` shows…',
      '  argmax L0 p=0.62  E[k]=0.56→0.14  P(k≥3)=0.04  bound=tail  risk=0.04 [ok]',
      '  confidence = 1 − Σ p_k·|k−k*| / U_5 = 1 − 0.56/1.2 = 0.53',
      '  consumed by: risk band (review ≥ 0.30, block ≥ 0.70); wire two-decimal, noise sd ≈ 0.02',
    ]);
  });
  it('a harm dimension reads `harm dimension → expected bound` and the band verdict', () => {
    const destructive: Decision = mkDecision({ step: 7, stage: 'risk', id: 'destructive', question: { type: 'score', instructions: 'How much would it lose?', criteria: ['nothing', 'recoverable', 'untracked', 'network', 'irreversible'] }, answer: { type: 'score', score: 2, legend: {}, probabilities: { '0': 0.1, '1': 0.2, '2': 0.6, '3': 0.1, '4': 0 }, confidence: 0.3 }, probability: 0.6, confidence: 0.3, verdict: 'review', latencyMs: 244 });
    const block = whyBlock(destructive, ctx);
    expect(block[2]).toBe('  score, 5 levels; harm dimension → expected bound');
    // E[k] = 0.2 + 1.2 + 0.3 = 1.70 → 1.70/4 = 0.425; tail = 0.10; the expected term (170) beats the scaled tail (40)
    expect(block[8]).toBe('  argmax L2 p=0.60  E[k]=1.70→0.42  P(k≥3)=0.10  bound=expected  risk=0.42 [review]');
    // a harm dimension whose tail mass outweighs its expected level is bounded by the tail (max of both, confidence.ts)
    const tailHeavy: Decision = { ...destructive, answer: { type: 'score', score: 3, legend: {}, probabilities: { '0': 0.1, '1': 0.1, '2': 0.1, '3': 0.6, '4': 0.1 }, confidence: 0.3 }, verdict: 'block' };
    expect(whyBlock(tailHeavy, ctx)[8]).toBe('  argmax L3 p=0.60  E[k]=2.50→0.62  P(k≥3)=0.70  bound=tail  risk=0.70 [block]');
  });
  it('renders a Noul: instructions, both definitions with examples, p and |2p−1|, the consumer', () => {
    const canEdit = decs.find((d) => d.id === 'can_edit')!;
    expect(whyBlock(canEdit, ctx)).toEqual([
      'why s7.intent.can_edit  request a1b2c3d4  231ms  typesafe/jev-1.13-20260917',
      '  Is edit the step that moves the task forward now?',
      '  noul; true: edit is what plan.remaining calls for',
      '        examples: tests still fail on the first remaining item',
      '        false: edit would repeat work or skip a prerequisite',
      '  p=0.81  |2p−1|=0.62 (derived confidence)',
      '  consumed by: paired ≥ 0.5',
    ]);
    const tc = decs.find((d) => d.id === 'task_complete')!;
    expect(whyBlock(tc, ctx).at(-1)).toBe('  consumed by: ≥ 0.85 → stop');
    expect(whyBlock(tc, { ...ctx, completeThreshold: 0.9 }).at(-1)).toBe('  consumed by: ≥ 0.9 → stop');
  });
  it('renders a Choice: one bar per option incl. none_of_these, the paired Noul beside each, the resolution rule that fired', () => {
    const intent = decs[0]!;
    const block = whyBlock(intent, ctx);
    expect(block.slice(0, 3)).toEqual(['why s7.intent.intent  request a1b2c3d4  231ms  typesafe/jev-1.13-20260917', '  Which kind of step comes next?', '  choice, 6 options; paired Nouls can_<option>']);
    expect(block[3]).toBe('  investigate     ██········  0.20  —');
    expect(block[4]).toBe('  edit            ██████▍···  0.64  can_edit            0.81  → answer');
    expect(block[5]).toBe('  verify          █·········  0.10  can_verify          0.31');
    expect(block[8]).toBe('  none_of_these   ▎·········  0.02  —');
    expect(block[9]).toBe("  resolution: chosen — Jev's answer `edit` with paired can_edit 0.81 ≥ 0.50");
    expect(block[10]).toBe('  confidence = (p_max − 1/n)/(1 − 1/n) = 0.57');
    expect(block[11]).toBe('  consumed by: choice resolution → intent edit');
  });
  it('names the overridden and fallback rules', () => {
    const overridden: Decision = { ...decs[0]!, verdict: 'overridden', answer: { type: 'choice', choice: 'verify', probabilities: { verify: 0.5, edit: 0.4, none_of_these: 0.1 }, confidence: 0.3 }, probability: 0.5 };
    const siblings: Decision[] = [overridden, { ...decs[1]!, verdict: 'chosen' }, decs[2]!];
    const block = whyBlock(overridden, { siblings });
    expect(block.find((l) => l.startsWith('  resolution:'))).toBe('  resolution: overridden — paired can_verify 0.31 < 0.50; the highest paired Noul can_edit ≥ 0.50 won');
    expect(block.find((l) => l.includes('→ resolved'))).toContain('edit');
    const fallback: Decision = { ...decs[0]!, verdict: 'fallback', answer: { type: 'choice', choice: 'none_of_these', probabilities: { none_of_these: 0.9, edit: 0.1 }, confidence: 0.8 }, probability: 0.9 };
    expect(whyBlock(fallback, {}).find((l) => l.startsWith('  resolution:'))).toBe("  resolution: fallback — no paired Noul ≥ 0.50 (answer `none_of_these`) → the stage's safe default");
  });
});
