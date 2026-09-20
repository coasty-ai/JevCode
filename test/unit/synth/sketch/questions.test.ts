/** Q12 + Q7 request building and the K rule (src/synth/sketch/questions.ts). */
import { describe, expect, it } from 'vitest';
import type { Answer } from '../../../../src/core/types.js';
import { choiceAnswer } from '../../../../src/jev/mock.js';
import { ESCAPE_KEY } from '../../../../src/jev/questions.js';
import { MARK } from '../../../../src/synth/beam/state.js';
import { sketchPool, sketchText } from '../../../../src/synth/sketch/pool.js';
import { EDIT_CLASSES, EDIT_CLASS_INSTRUCTIONS, EDIT_CLASS_QUESTION_ID, KEEP_BASE, KEEP_WIDE, SKETCH_INSTRUCTIONS, SKETCH_QUESTION_ID, editClassQuestion, keepCount, keepK, optionMap, orderByEditClass, sketchOptionKey, sketchQuestions } from '../../../../src/synth/sketch/questions.js';
import type { SketchRequest } from '../../../../src/synth/sketch/questions.js';
import { GCD_FAILURES, asChoice, enumerateOptions, gcdSite, keyForShape, massOn, massOver, siteAt, stateString } from './helpers.js';

const KEY_SHAPE = /^[a-z][a-z0-9_]{1,63}$/;

function gcdRequest(): SketchRequest {
  const { site } = gcdSite();
  return sketchQuestions(site, sketchPool(site, enumerateOptions()), { task: 'Fix the bug in gcd.py', failures: GCD_FAILURES });
}

function answers(req: SketchRequest, sketchMass: Record<string, number>, editMass?: Record<string, number>): Record<string, Answer> {
  const out: Record<string, Answer> = { [SKETCH_QUESTION_ID]: choiceAnswer(asChoice(req.questions[SKETCH_QUESTION_ID]), sketchMass) };
  if (editMass !== undefined) out[EDIT_CLASS_QUESTION_ID] = choiceAnswer(asChoice(req.questions[EDIT_CLASS_QUESTION_ID]), editMass);
  return out;
}

describe('sketchQuestions (Q12 + Q7 in one request)', () => {
  it('builds the measured request for gcd: verbatim wordings, sketch_aa… keys with { shape, change }, six edit classes, escapes', () => {
    const req = gcdRequest();
    const sketch = asChoice(req.questions[SKETCH_QUESTION_ID]);
    const edit = asChoice(req.questions[EDIT_CLASS_QUESTION_ID]);
    expect(sketch.instructions).toBe(SKETCH_INSTRUCTIONS);
    expect(SKETCH_INSTRUCTIONS).toBe(
      'Each option is a sketch of the corrected line for the `<<<FIX THIS LINE>>>` marker in `program`. In a sketch, `_` stands for one identifier, number, string or True/False/None still to be chosen, `<op>` stands for one operator still to be chosen, and every other token is shown literally. Which sketch is the shape of the correct replacement line, so that with the right tokens in its holes every entry of `tests` passes? Read the sketches literally and compare them with `buggy_line`. Choose `none_of_these` if no listed sketch fits the correct line.',
    );
    expect(edit.instructions).toBe(EDIT_CLASS_INSTRUCTIONS);
    expect(EDIT_CLASS_INSTRUCTIONS).toBe('Which kind of edit turns `buggy_line` into the correct line for the `<<<FIX THIS LINE>>>` marker in `program`, so that every entry of `tests` passes? Judge the edit that would be written. Answer carefully and literally.');
    const keys = Object.keys(sketch.criteria);
    expect(keys).toHaveLength(76 + 1);
    expect(keys[0]).toBe('sketch_aa');
    expect(keys[26]).toBe('sketch_ba');
    expect(keys[keys.length - 1]).toBe(ESCAPE_KEY);
    expect(sketch.criteria['sketch_aa']).toEqual({ shape: 'return _(a % b, b)', change: 'change one name or literal' });
    expect(keyForShape(sketch, 'return gcd(b, a % b)')).toBeDefined();
    for (const k of keys) expect(k).toMatch(KEY_SHAPE);
    expect(Object.keys(edit.criteria)).toEqual(['substitute_one_token', 'insert_fragment', 'delete_fragment', 'reorder_tokens', 'reshape_line', 'insert_new_line', ESCAPE_KEY]);
    expect(edit.criteria['reorder_tokens']).toBe(EDIT_CLASSES.reorder_tokens);
    expect(EDIT_CLASSES.substitute_one_token).toContain('`while lo <= hi` -> `while lo < hi`');
    expect(req.byKey.size).toBe(76);
    expect(sketchText(req.byKey.get('sketch_aa')!)).toBe('return _(a % b, b)');
  });

  it('state: the measured task sentence, the marked program, buggy_line, tests, plus the user goal', () => {
    const req = gcdRequest();
    expect(stateString(req.state, 'task')).toBe(`The Python function \`gcd\` has a one-line bug. In \`program\` the faulty position is marked \`${MARK}\` (the marker keeps the correct indentation). The original wrong line at that position is \`buggy_line\`; the correct line is usually a small edit of it. The corrected program must make every entry of \`tests\` pass.`);
    expect(stateString(req.state, 'program')).toContain(`        ${MARK}`);
    expect(stateString(req.state, 'program')).not.toContain('return gcd(a % b, b)');
    expect(stateString(req.state, 'buggy_line')).toBe('return gcd(a % b, b)');
    expect(stateString(req.state, 'goal')).toBe('Fix the bug in gcd.py');
    expect(req.state).toMatchObject({ tests: [{ test: 'gcd[13,13]', expected: '13' }, { test: 'gcd[37,600]' }] });
  });

  it('snapshot of the gcd request (wording and option construction)', () => {
    const req = gcdRequest();
    expect({ state: req.state, questions: req.questions }).toMatchSnapshot();
  });

  it('at an insert site buggy_line is null and the statement templates are the options', () => {
    const { file } = gcdSite();
    const site = siteAt(file, 5, 'insert');
    const req = sketchQuestions(site, sketchPool(site, enumerateOptions()), { task: '', failures: GCD_FAILURES });
    expect(req.state).toMatchObject({ buggy_line: null });
    expect(stateString(req.state, 'task')).toContain('No line existed there: a new line must be inserted.');
    expect(asChoice(req.questions[SKETCH_QUESTION_ID]).criteria['sketch_aa']).toEqual({ shape: '_._(_)', change: 'call a method with one argument (e.g. `xs.append(x)`)' });
    expect(keyForShape(asChoice(req.questions[SKETCH_QUESTION_ID]), 'if _ <op> _:\n    return _')).toBeDefined();
  });

  it('leaves Q7 out when the controller already asked it alone; editClassQuestion is the standalone form', () => {
    const { site } = gcdSite();
    const pool = sketchPool(site, enumerateOptions());
    const req = sketchQuestions(site, pool, { task: '', failures: GCD_FAILURES, withEditClass: false });
    expect(Object.keys(req.questions)).toEqual([SKETCH_QUESTION_ID]);
    const alone = asChoice(editClassQuestion());
    expect(alone.instructions).toBe(EDIT_CLASS_INSTRUCTIONS);
    expect(Object.keys(alone.criteria)).toHaveLength(7);
  });

  it('rejects an empty or oversized pool', () => {
    const { site } = gcdSite();
    expect(() => sketchQuestions(site, [], { task: '', failures: [] })).toThrow(RangeError);
    expect(sketchOptionKey(0)).toBe('sketch_aa');
    expect(sketchOptionKey(253)).toBe('sketch_jt');
  });
});

describe('keepK (K = 3, or 5 when P(top) < 0.5 or P(escape) ≥ 0.3), edit-class order', () => {
  it('keepCount implements the measured widening rule', () => {
    expect(keepCount(0.86, 0.09)).toBe(KEEP_BASE);
    expect(keepCount(0.5, 0.0)).toBe(KEEP_BASE);
    expect(keepCount(0.49, 0.0)).toBe(KEEP_WIDE);
    expect(keepCount(0.6, 0.3)).toBe(KEEP_WIDE);
    expect(keepCount(0.6, 0.29)).toBe(KEEP_BASE);
  });

  it('confident answer: keeps 3 with pSketch set, the gold swap first (the gcd measurement: P 0.86, escape 0.09)', () => {
    const req = gcdRequest();
    const q = asChoice(req.questions[SKETCH_QUESTION_ID]);
    const gold = keyForShape(q, 'return gcd(b, a % b)')!;
    const r = keepK(answers(req, massOver(q, { [gold]: 0.86, [ESCAPE_KEY]: 0.09 }), massOn(asChoice(req.questions[EDIT_CLASS_QUESTION_ID]), 'reorder_tokens', 0.7)), req);
    expect(r.k).toBe(3);
    expect(r.widened).toBe(false);
    expect(r.kept).toHaveLength(3);
    expect(sketchText(r.kept[0]!)).toBe('return gcd(b, a % b)');
    expect(r.kept[0]!.pSketch).toBeCloseTo(0.86, 5);
    expect(r.pTop).toBeCloseTo(0.86, 5);
    expect(r.pEscape).toBeCloseTo(0.09, 5);
    expect(r.editClasses[0]).toBe('reorder_tokens');
    // the pool entries are untouched (pSketch stays 0 there)
    expect(req.byKey.get(gold)!.pSketch).toBe(0);
  });

  it('unsure answer (P(top) < 0.5) keeps 5; an escape-leaning answer (P(escape) ≥ 0.3) keeps 5', () => {
    const req = gcdRequest();
    const q = asChoice(req.questions[SKETCH_QUESTION_ID]);
    const a = keepK(answers(req, massOn(q, 'sketch_ab', 0.4)), req);
    expect(a.k).toBe(5);
    expect(a.kept).toHaveLength(5);
    expect(a.widened).toBe(true);
    const b = keepK(answers(req, massOver(q, { sketch_ab: 0.6, [ESCAPE_KEY]: 0.3 })), req);
    expect(b.k).toBe(5);
    expect(b.kept.map(sketchText)[0]).toBe('return gcd(_ % b, b)');
    expect(b.editClasses).toEqual([]);
    // the pool itself stands in for the request: option keys are positional
    const { site } = gcdSite();
    const pool = sketchPool(site, enumerateOptions());
    const c = keepK(answers(req, massOver(q, { sketch_ab: 0.6, [ESCAPE_KEY]: 0.3 })), pool);
    expect(c.kept.map(sketchText)).toEqual(b.kept.map(sketchText));
    expect(optionMap(pool).get('sketch_ab')).toBe(pool[1]);
  });

  it('a pool smaller than K yields every entry (K is a cap, never padding)', () => {
    const { site } = gcdSite();
    const pool = sketchPool(site, enumerateOptions()).slice(0, 2);
    const req = sketchQuestions(site, pool, { task: '', failures: GCD_FAILURES });
    const q = asChoice(req.questions[SKETCH_QUESTION_ID]);
    expect(Object.keys(q.criteria)).toEqual(['sketch_aa', 'sketch_ab', ESCAPE_KEY]);
    // 0.4 / 0.2 / escape 0.4: P(top) < 0.5, so the rule asks for 5, and only the 2 offered come back
    const r = keepK(answers(req, massOver(q, { sketch_aa: 0.4, sketch_ab: 0.2, [ESCAPE_KEY]: 0.4 })), req);
    expect(r.k).toBe(KEEP_WIDE);
    expect(r.widened).toBe(true);
    expect(r.kept.map(sketchText)).toEqual(['return _(a % b, b)', 'return gcd(_ % b, b)']);
  });

  it('reorders the kept set so the top-2 Q7 classes come first, dropping nothing', () => {
    const req = gcdRequest();
    const q = asChoice(req.questions[SKETCH_QUESTION_ID]);
    const p3 = keyForShape(q, 'return gcd(a % b, b) <op> _')!;
    const p7 = keyForShape(q, 'return gcd(b, a % b)')!;
    const p1 = keyForShape(q, 'return gcd(_ % b, b)')!;
    const edit = asChoice(req.questions[EDIT_CLASS_QUESTION_ID]);
    const r = keepK(answers(req, massOver(q, { [p3]: 0.5, [p7]: 0.3, [p1]: 0.15 }), massOver(edit, { reorder_tokens: 0.5, substitute_one_token: 0.3, insert_fragment: 0.1 })), req);
    expect(r.kept.map((h) => h.production)).toEqual(['P7', 'P1', 'P3']);
    expect(r.kept.map((h) => h.pSketch)).toEqual([expect.closeTo(0.3, 5), expect.closeTo(0.15, 5), expect.closeTo(0.5, 5)]);
    expect(r.editClasses.slice(0, 2)).toEqual(['reorder_tokens', 'substitute_one_token']);
    // no classes → original probability order
    expect(orderByEditClass(r.kept, [], 'replace').map((h) => h.production)).toEqual(['P7', 'P1', 'P3']);
  });

  it('rejects an answer that names an unknown option or is not a choice', () => {
    const req = gcdRequest();
    expect(() => keepK({ [SKETCH_QUESTION_ID]: { type: 'noul', noul: 0.5 } }, req)).toThrow(TypeError);
    expect(() => keepK({ [SKETCH_QUESTION_ID]: { type: 'choice', choice: 'sketch_zz', probabilities: { sketch_zz: 1 }, confidence: 1 } }, req)).toThrow(/not offered/);
  });
});
