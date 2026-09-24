/**
 * Intent stage: the jev-only ledger rule over §6 Choice resolution (stages/intent.ts) and the
 * ledger-flavoured question set. jev-on resolution is choose.test.ts; nothing here changes it.
 */
import { describe, expect, it } from 'vitest';
import type { Answer, Intent, JsonObject } from '../../../../src/core/types.js';
import { assertQuestionBatch } from '../../../../src/jev/questions.js';
import { resolveChoice } from '../../../../src/jev-modes/stages/choose.js';
import { INTENT_FALLBACK, INTENT_LIST, INTENT_OPTIONS, INTENT_OPTIONS_LEDGER, LEDGER_CHOICE_FLOOR, buildIntentQuestions, intentLedger, resolveIntentWithLedger } from '../../../../src/jev-modes/stages/intent.js';
import { choiceOver, noulA } from '../../loop/fakes.js';

const KEYS = [...INTENT_LIST, 'none_of_these'];

function answers(choice: string, p: number, nouls: Partial<Record<Intent, number>> = {}): Record<string, Answer> {
  const out: Record<string, Answer> = { intent: choiceOver(KEYS, choice, p) };
  for (const o of INTENT_LIST) out[`can_${o}`] = noulA(nouls[o] ?? 0.2);
  return out;
}

function resolve(a: Record<string, Answer>, ledgerOpen: boolean, changeUnverified: boolean): ReturnType<typeof resolveIntentWithLedger> {
  const base = resolveChoice<Intent>({ choiceId: 'intent', answers: a, options: INTENT_LIST, escape: 'none_of_these', fallback: INTENT_FALLBACK });
  return resolveIntentWithLedger(base, a, { ledgerOpen, changeUnverified });
}

describe('resolveIntentWithLedger (jev-only, docs/JEV-ONLY-DESIGN.md §5.2)', () => {
  it('without a ledger the §6 resolution is returned as is (fallback to investigate on all-low paired Nouls)', () => {
    const a = answers('edit', 0.6);
    const r = resolve(a, false, false);
    expect(r).toMatchObject({ option: 'investigate', verdict: 'fallback', answer: 'edit' });
    // same object: the rule did not run
    const base = resolveChoice<Intent>({ choiceId: 'intent', answers: a, options: INTENT_LIST, escape: 'none_of_these', fallback: INTENT_FALLBACK });
    expect(resolveIntentWithLedger(base, a, { ledgerOpen: false, changeUnverified: true })).toBe(base);
  });
  it('a fallback whose raw answer is edit/verify with p >= 0.3 takes that answer with verdict chosen', () => {
    expect(resolve(answers('edit', 0.6), true, false)).toEqual({ option: 'edit', verdict: 'chosen', answer: 'edit', probability: 0.6, pairedNoul: 0.2 });
    expect(resolve(answers('verify', LEDGER_CHOICE_FLOOR), true, false)).toMatchObject({ option: 'verify', verdict: 'chosen', answer: 'verify', probability: LEDGER_CHOICE_FLOOR });
    expect(resolve(answers('verify', 0.5), true, true)).toMatchObject({ option: 'verify', verdict: 'chosen' });
  });
  it('below the floor, or a non-action answer, the fallback stands', () => {
    expect(resolve(answers('edit', 0.25), true, false)).toMatchObject({ option: 'investigate', verdict: 'fallback' });
    expect(resolve(answers('investigate', 0.4), true, false)).toMatchObject({ option: 'investigate', verdict: 'fallback' });
    expect(resolve(answers('none_of_these', 0.9), true, true)).toMatchObject({ option: 'investigate', verdict: 'fallback' });
    expect(resolve(answers('finish', 0.9), true, true)).toMatchObject({ option: 'investigate', verdict: 'fallback' });
  });
  it('Fix 1(b): in jev-only a fallback whose answer is `finish` (p >= floor) is rescued when the engine\'s last run is green and current, whatever the plan text still lists', () => {
    // units step 13 of the ladder-4 run: finish 0.63, can_finish 0.31, every other Noul lower; the plan still listed a stale `fix …` item
    const a = answers('finish', 0.63, { finish: 0.31, investigate: 0.2 });
    const base = resolveChoice<Intent>({ choiceId: 'intent', answers: a, options: INTENT_LIST, escape: 'none_of_these', fallback: INTENT_FALLBACK });
    expect(base).toMatchObject({ option: 'investigate', verdict: 'fallback', answer: 'finish' });
    expect(resolveIntentWithLedger(base, a, { ledgerOpen: true, changeUnverified: false, jevOnly: true, runGreen: true })).toEqual({ option: 'finish', verdict: 'chosen', answer: 'finish', probability: 0.63, pairedNoul: 0.31 });
    expect(resolveIntentWithLedger(base, a, { ledgerOpen: false, changeUnverified: false, jevOnly: true, runGreen: true })).toMatchObject({ option: 'finish', verdict: 'chosen' });
    // not green (a failing run, or a change since the run), not jev-only, or below the floor: the §6 fallback stands
    expect(resolveIntentWithLedger(base, a, { ledgerOpen: false, changeUnverified: false, jevOnly: true, runGreen: false })).toBe(base);
    expect(resolveIntentWithLedger(base, a, { ledgerOpen: true, changeUnverified: true, jevOnly: true, runGreen: false })).toBe(base);
    expect(resolveIntentWithLedger(base, a, { ledgerOpen: false, changeUnverified: false, jevOnly: false, runGreen: true })).toBe(base);
    const low = answers('finish', LEDGER_CHOICE_FLOOR - 0.01, { finish: 0.31 });
    const lowBase = resolveChoice<Intent>({ choiceId: 'intent', answers: low, options: INTENT_LIST, escape: 'none_of_these', fallback: INTENT_FALLBACK });
    expect(resolveIntentWithLedger(lowBase, low, { ledgerOpen: false, changeUnverified: false, jevOnly: true, runGreen: true })).toBe(lowBase);
    // a chosen finish (paired Noul >= 0.5) needs no rescue and is untouched
    const chosen = answers('finish', 0.8, { finish: 0.9 });
    const chosenBase = resolveChoice<Intent>({ choiceId: 'intent', answers: chosen, options: INTENT_LIST, escape: 'none_of_these', fallback: INTENT_FALLBACK });
    expect(resolveIntentWithLedger(chosenBase, chosen, { ledgerOpen: false, changeUnverified: false, jevOnly: true, runGreen: true })).toBe(chosenBase);
  });
  it('right after an unverified change an effective edit becomes verify (verdict overridden: the paired verify row is the chosen one)', () => {
    // rescued fallback
    expect(resolve(answers('edit', 0.6), true, true)).toEqual({ option: 'verify', verdict: 'overridden', answer: 'edit', probability: expect.any(Number), pairedNoul: 0.2 });
    // a §6 chosen edit (paired Noul >= 0.5)
    expect(resolve(answers('edit', 0.7, { edit: 0.8 }), true, true)).toMatchObject({ option: 'verify', verdict: 'overridden', answer: 'edit' });
    // with the tests current the chosen edit stands, untouched
    const a = answers('edit', 0.7, { edit: 0.8 });
    const base = resolveChoice<Intent>({ choiceId: 'intent', answers: a, options: INTENT_LIST, escape: 'none_of_these', fallback: INTENT_FALLBACK });
    expect(resolveIntentWithLedger(base, a, { ledgerOpen: true, changeUnverified: false })).toBe(base);
    // other intents are Jev's whatever the workspace says
    expect(resolve(answers('investigate', 0.8, { investigate: 0.9 }), true, true)).toMatchObject({ option: 'investigate', verdict: 'chosen' });
    expect(resolve(answers('finish', 0.8, { finish: 0.9 }), true, true)).toMatchObject({ option: 'finish', verdict: 'chosen' });
  });
});

describe('intent questions and the ledger', () => {
  it('with a ledger, edit and verify describe the synthesizer\'s two steps; the default set is unchanged', () => {
    const qs = buildIntentQuestions({ ledger: true });
    assertQuestionBatch(qs);
    expect(Object.keys(qs)).toEqual(['intent', 'can_investigate', 'can_edit', 'can_verify', 'can_fix_environment', 'can_finish', 'plan_still_valid']);
    const c = qs['intent']!;
    if (c.type !== 'choice') throw new Error('intent is a choice');
    expect(c.criteria['edit']).toBe('apply a verified fix for an item in `plan.remaining`');
    expect(c.criteria['verify']).toBe('run the suite after a fix');
    expect(c.criteria['investigate']).toBe(INTENT_OPTIONS.investigate);
    expect(String(c.instructions)).toContain('`ledger.items`');
    expect(String(qs['can_edit']!.instructions)).toContain(INTENT_OPTIONS_LEDGER.edit);
    const plain = buildIntentQuestions();
    if (plain['intent']!.type === 'choice') expect(plain['intent']!.criteria['edit']).toBe('change source files');
    expect(String(plain['intent']!.instructions)).not.toContain('ledger');
    expect(plain).toEqual(buildIntentQuestions({ ledger: false }));
  });
  it('intentLedger reads the fixed-form items only in jev-only mode', () => {
    const common: JsonObject = { plan: { remaining: ['fix tests/test_a.py::test_x in src/a.py', 'verify the full test suite passes', 'update the docstring'] } };
    expect(intentLedger('jev-only', common)).toEqual(['fix tests/test_a.py::test_x in src/a.py']);
    expect(intentLedger('jev-on', common)).toEqual([]);
    expect(intentLedger('jev-off', common)).toEqual([]);
    expect(intentLedger('jev-only', {})).toEqual([]);
  });
});
