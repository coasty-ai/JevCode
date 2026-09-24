import { describe, expect, it } from 'vitest';
import type { Decision } from '../../../../src/core/types.js';
import { annotateChoiceRows, resolveChoice } from '../../../../src/jev-modes/stages/choose.js';
import { choiceOver, noulA } from '../../loop/fakes.js';

const OPTIONS = ['investigate', 'edit', 'verify', 'fix_environment', 'finish'] as const;
const KEYS = [...OPTIONS, 'none_of_these'];

function nouls(values: Partial<Record<(typeof OPTIONS)[number], number>>): Record<string, ReturnType<typeof noulA>> {
  const out: Record<string, ReturnType<typeof noulA>> = {};
  for (const o of OPTIONS) out[`can_${o}`] = noulA(values[o] ?? 0.1);
  return out;
}

describe('Choice resolution (§6)', () => {
  it('takes the argmax when its paired Noul >= 0.5 (verdict chosen)', () => {
    const r = resolveChoice({ choiceId: 'intent', answers: { intent: choiceOver(KEYS, 'edit', 0.7), ...nouls({ edit: 0.5 }) }, options: OPTIONS, escape: 'none_of_these', fallback: 'investigate' });
    expect(r).toMatchObject({ option: 'edit', verdict: 'chosen', probability: 0.7, pairedNoul: 0.5, answer: 'edit' });
  });
  it('overrides the argmax with the highest paired Noul >= 0.5', () => {
    const r = resolveChoice({ choiceId: 'intent', answers: { intent: choiceOver(KEYS, 'edit', 0.6), ...nouls({ edit: 0.3, verify: 0.8, investigate: 0.6 }) }, options: OPTIONS, escape: 'none_of_these', fallback: 'investigate' });
    expect(r).toMatchObject({ option: 'verify', verdict: 'overridden', pairedNoul: 0.8, answer: 'edit' });
    const rows = [{ id: 'intent' }, { id: 'can_verify' }, { id: 'can_edit' }] as Decision[];
    annotateChoiceRows(rows, 'intent', r);
    expect(rows.map((x) => x.verdict)).toEqual(['overridden', 'chosen', undefined]);
  });
  it('falls back when every paired Noul < 0.5', () => {
    const r = resolveChoice({ choiceId: 'intent', answers: { intent: choiceOver(KEYS, 'edit', 0.9), ...nouls({ edit: 0.49 }) }, options: OPTIONS, escape: 'none_of_these', fallback: 'investigate' });
    expect(r).toMatchObject({ option: 'investigate', verdict: 'fallback', answer: 'edit' });
  });
  it('escape chosen with one paired Noul >= 0.5 -> that option; escape with none -> fallback', () => {
    const r = resolveChoice({ choiceId: 'intent', answers: { intent: choiceOver(KEYS, 'none_of_these', 0.6), ...nouls({ fix_environment: 0.55 }) }, options: OPTIONS, escape: 'none_of_these', fallback: 'investigate' });
    expect(r).toMatchObject({ option: 'fix_environment', verdict: 'overridden', answer: 'none_of_these' });
    const f = resolveChoice({ choiceId: 'intent', answers: { intent: choiceOver(KEYS, 'none_of_these', 0.6), ...nouls({}) }, options: OPTIONS, escape: 'none_of_these', fallback: 'investigate' });
    expect(f).toMatchObject({ option: 'investigate', verdict: 'fallback', answer: 'none_of_these' });
  });
  it('ties between paired Nouls resolve to the first option in order; a missing Choice answer falls back', () => {
    const r = resolveChoice({ choiceId: 'intent', answers: { intent: choiceOver(KEYS, 'finish', 0.9), ...nouls({ edit: 0.7, verify: 0.7 }) }, options: OPTIONS, escape: 'none_of_these', fallback: 'investigate' });
    expect(r.option).toBe('edit');
    expect(resolveChoice({ choiceId: 'intent', answers: {}, options: OPTIONS, escape: 'none_of_these', fallback: 'investigate' }).verdict).toBe('fallback');
  });
});
