import { describe, expect, it } from 'vitest';
import type { Json } from '../../../src/core/types.js';
import { ESCAPE_KEY, PAIRED_PREFIX, QuestionBuildError, assertQuestionBatch, choice, contextNoul, noul, pairedNouls, ref, score } from '../../../src/jev/questions.js';

const side = (d: string) => ({ definition: d, examples: ['one', 'two'] });
const both = { true: side('yes'), false: side('no') };

describe('questions builders (§5.4)', () => {
  it('noul requires both-sided criteria with at least two examples each', () => {
    const q = noul('Is `x` true?', both);
    expect(q.type).toBe('noul');
    expect(q.type === 'noul' && q.criteria).toEqual({ true: { definition: 'yes', examples: ['one', 'two'] }, false: { definition: 'no', examples: ['one', 'two'] } });
    expect(() => noul('', both)).toThrow(QuestionBuildError);
    expect(() => noul(null, both)).toThrow(QuestionBuildError);
    expect(() => noul('q', { true: side('yes'), false: { definition: '', examples: ['a', 'b'] } })).toThrow(/criteria\.false\.definition/);
    expect(() => noul('q', { true: { definition: 'yes', examples: ['only one'] }, false: side('no') })).toThrow(/criteria\.true\.examples/);
    // One-sided criteria are unrepresentable in the type; at runtime the builder still refuses them
    // (as a TypeError from checkSide, not a QuestionBuildError: reported to the owner of questions.ts).
    expect(() => noul('q', { true: side('yes') } as unknown as typeof both)).toThrow();
  });

  it('contextNoul carries instructions only (criteria live in the state)', () => {
    const q = contextNoul('Should the engineer be shown `src/a.py`?');
    expect(q).toEqual({ type: 'noul', instructions: 'Should the engineer be shown `src/a.py`?' });
    expect(() => contextNoul('')).toThrow(QuestionBuildError);
  });

  it('choice adds the escape option and keeps descriptive keys', () => {
    const q = choice('which?', { investigate: 'read', edit: 'change' });
    expect(q.type === 'choice' && Object.keys(q.criteria)).toEqual(['investigate', 'edit', ESCAPE_KEY]);
    expect(q.type === 'choice' && q.criteria[ESCAPE_KEY]).toBeNull();
    const custom = choice('which?', { investigate: 'read' }, { escape: 'none_of_the_above' });
    expect(custom.type === 'choice' && Object.keys(custom.criteria)).toEqual(['investigate', 'none_of_the_above']);
    const already = choice('which?', { investigate: 'read', none_of_these: null });
    expect(already.type === 'choice' && Object.keys(already.criteria)).toEqual(['investigate', 'none_of_these']);
  });

  it.each(['alpha', 'beta', 'gamma', 'option_a', 'option1', 'optionx9'])('choice rejects key %j (name prior)', (key) => {
    expect(() => choice('which?', { [key]: 'x', investigate: 'y' })).toThrow(/name prior/);
  });

  // Single letters and bare numbers carry a prior too, but the 2..64-char snake_case shape check fires first.
  it.each(['a', 'B', '1', '42', 'optionB', 'Has Space', 'kebab-case', 'CamelCase', '_lead', '9start', 'x'.repeat(65), 'emoji😀'])('choice rejects key %j (shape)', (key) => {
    expect(() => choice('which?', { [key]: 'x', investigate: 'y' })).toThrow(QuestionBuildError);
    expect(() => choice('which?', { [key]: 'x', investigate: 'y' })).toThrow(/snake_case/);
  });

  it('choice rejects zero options and more than 255', () => {
    expect(() => choice('which?', {})).toThrow(/at least one option/);
    const many: Record<string, Json> = {};
    for (let i = 0; i < 255; i++) many[`opt_${i}x`] = 'x';
    expect(() => choice('which?', many)).toThrow(/more than 255/);
    delete many['opt_254x'];
    expect(() => choice('which?', many)).not.toThrow();
  });

  it('score requires 2..10 non-empty levels', () => {
    expect(score('how?', ['a', 'b']).type).toBe('score');
    expect(score('how?', Array.from({ length: 10 }, (_, i) => `level ${i}`)).type).toBe('score');
    expect(() => score('how?', ['only'])).toThrow(/2\.\.10/);
    expect(() => score('how?', Array.from({ length: 11 }, (_, i) => `level ${i}`))).toThrow(/got 11/);
    expect(() => score('how?', ['a', ''])).toThrow(/level 1 is empty/);
    expect(() => score('how?', ['a', null])).toThrow(/level 1 is empty/);
    const objLevels = score('how?', [{ what: 'a' }, { what: 'b' }]);
    expect(objLevels.type === 'score' && objLevels.criteria.length).toBe(2);
  });

  it('pairedNouls builds can_<option> for every non-escape option', () => {
    const qs = pairedNouls({ investigate: 'read', edit: 'change', none_of_these: 'escape' }, (opt, desc) => ({ instructions: `Is \`${opt}\` (${desc}) right?`, criteria: both }));
    expect(Object.keys(qs)).toEqual([`${PAIRED_PREFIX}investigate`, `${PAIRED_PREFIX}edit`]);
    expect(qs['can_edit']?.instructions).toBe('Is `edit` (change) right?');
    const custom = pairedNouls({ investigate: 'read', other: 'escape' }, () => ({ instructions: 'x', criteria: both }), 'other');
    expect(Object.keys(custom)).toEqual(['can_investigate']);
    expect(() => pairedNouls({ investigate: 'read' }, () => ({ instructions: 'x', criteria: { true: side('y') } as unknown as typeof both }))).toThrow();
    expect(() => pairedNouls({ investigate: 'read' }, () => ({ instructions: '', criteria: both }))).toThrow(QuestionBuildError);
  });

  it('assertQuestionBatch: 1..1000 questions with non-empty ids', () => {
    expect(() => assertQuestionBatch({})).toThrow(/at least one question/);
    expect(() => assertQuestionBatch({ ' ': contextNoul('x') })).toThrow(/empty question id/);
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`q${i}`, contextNoul('x')]));
    expect(() => assertQuestionBatch(many)).toThrow(/too many questions/);
    delete many['q1000'];
    expect(() => assertQuestionBatch(many)).not.toThrow();
  });

  it('ref backticks a path', () => {
    expect(ref('proposal.action.command')).toBe('`proposal.action.command`');
  });
});
