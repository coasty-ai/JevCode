import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { Json } from '../../../../src/core/types.js';
import { ESCAPE_KEY, QuestionBuildError, assertQuestionBatch, choice } from '../../../../src/jev/questions.js';
import {
  CHOICE_INSTRUCTIONS,
  CHOICE_QUESTION_ID,
  CORRECT_FIX_CRITERIA_STATE,
  ESCAPE_DESCRIPTION,
  LITERAL_SUFFIX,
  MAX_PROGRAM_LINES,
  MAX_TESTS_IN_STATE,
  MODULE_WINDOW_LINES,
  anchorLine,
  buildChoiceQuestion,
  buildCompactNouls,
  buildRankState,
  candidateDescription,
  candidateKey,
  compactNoulInstruction,
  isUnchanged,
  lineSignature,
  programRange,
  rankMode,
  taskSentence,
} from '../../../../src/synth/rank/index.js';
import { FIXTURES, GCD_BUGGY_LINE, GCD_FAILURES, GCD_FILE, GCD_FIX, candidate, context, siteAt, sourceFile } from './helpers.js';
import { statementSiteAt } from '../../../../src/synth/localize/sites.js';

const site = siteAt(GCD_FILE, GCD_BUGGY_LINE);

describe('candidateKey', () => {
  it('is candidate_<xx> in base 26 with at least two letters (probe-question-design key form)', () => {
    expect(candidateKey(0)).toBe('candidate_aa');
    expect(candidateKey(25)).toBe('candidate_az');
    expect(candidateKey(26)).toBe('candidate_ba');
    expect(candidateKey(253)).toBe('candidate_jt');
    expect(candidateKey(675)).toBe('candidate_zz');
    expect(candidateKey(676)).toBe('candidate_baa');
  });
  it('is injective over a 254-chunk and accepted by the choice builder', () => {
    const keys = Array.from({ length: 254 }, (_, i) => candidateKey(i));
    expect(new Set(keys).size).toBe(254);
    const q = choice('x', Object.fromEntries(keys.map((k) => [k, 'line'])));
    if (q.type !== 'choice') throw new Error('expected a choice');
    expect(Object.keys(q.criteria)).toHaveLength(255);
  });
  it('rejects negative or fractional indices', () => {
    expect(() => candidateKey(-1)).toThrow(RangeError);
    expect(() => candidateKey(1.5)).toThrow(RangeError);
  });
});

describe('lineSignature / isUnchanged', () => {
  it('ignores whitespace inside the line but not the tokens', () => {
    expect(lineSignature('return gcd(b,a%b)')).toBe(lineSignature('        return gcd(b, a % b)'));
    expect(lineSignature('return gcd(a % b, a)')).not.toBe(lineSignature('return gcd(a % b, b)'));
    expect(lineSignature('x = "a  b"')).not.toBe(lineSignature('x = "a b"'));
  });
  it('flags the current line (any spacing) as unchanged on replace sites only', () => {
    expect(isUnchanged(candidate(site, '        return gcd(a % b, b)'), site)).toBe(true);
    expect(isUnchanged(candidate(site, 'return gcd(a%b,b)'), site)).toBe(true);
    expect(isUnchanged(candidate(site, GCD_FIX), site)).toBe(false);
    expect(isUnchanged(candidate(site, '        return gcd(a % b, b)', { extraEdits: [{ path: 'gcd.py', line: 2, kind: 'delete' }] }), site)).toBe(false);
    const insertSite = siteAt(GCD_FILE, 3, 'insert');
    expect(isUnchanged(candidate(insertSite, '        return gcd(a % b, b)'), insertSite)).toBe(false);
  });
});

describe('site geometry', () => {
  it('anchors replace sites on the line and insert sites on the line before the insertion point', () => {
    expect(anchorLine(site)).toBe(5);
    expect(anchorLine(siteAt(GCD_FILE, 3, 'insert'))).toBe(2);
    expect(anchorLine(siteAt(GCD_FILE, 1, 'insert'))).toBe(1);
  });
  it('shows the enclosing block, or a window at module level, never more than MAX_PROGRAM_LINES', () => {
    expect(programRange(site)).toEqual({ start: 1, end: 5 });
    const big = sourceFile('big.py', Array.from({ length: 400 }, (_, i) => `x${i} = ${i}`).join('\n') + '\n');
    const moduleSite = siteAt(big, 200);
    expect(programRange(moduleSite)).toEqual({ start: 200 - MODULE_WINDOW_LINES, end: 200 + MODULE_WINDOW_LINES });
    const hugeFn = sourceFile('fn.py', 'def f():\n' + Array.from({ length: 300 }, (_, i) => `    y${i} = ${i}`).join('\n') + '\n');
    const deep = siteAt(hugeFn, 250);
    const r = programRange(deep);
    expect(r.end - r.start + 1).toBe(MAX_PROGRAM_LINES);
    expect(r.start).toBeLessThanOrEqual(250);
    expect(r.end).toBeGreaterThanOrEqual(250);
  });
});

describe('measured wording', () => {
  it('keeps the probe-select Choice instruction, escape description and criteria verbatim', () => {
    expect(CHOICE_INSTRUCTIONS.replace).toBe(
      'Which option is the corrected line that, put in place of `buggy_line`, makes every test in `tests` pass, including the tests that currently fail? Read each option literally: most options are wrong mutations of the faulty line or copies of other lines. Choose `none_of_these` if no option is a correct fix.',
    );
    expect(CHOICE_INSTRUCTIONS.insert).toContain('inserted immediately after `buggy_line`');
    expect(LITERAL_SUFFIX).toBe(' Answer carefully and literally.');
    expect(ESCAPE_DESCRIPTION).toBe('No option is a correct fix; every option leaves the tests failing or breaks the function.');
    expect(compactNoulInstruction('replace', 'candidate_ab')).toBe(
      'Is `candidates.candidate_ab` a correct fix per `correct_fix_criteria`: put in place of `buggy_line`, does it make every test in `tests` pass?',
    );
    expect(taskSentence('replace', 'gcd')).toBe(
      'The Python function `gcd` has a one-line bug. `buggy_line` (line `buggy_line_number` of `program`) is the faulty line. `tests` shows inputs, the expected output, and what the buggy program actually does.',
    );
    expect(taskSentence('insert', null)).toContain('The Python code in `program` is missing one statement.');
    expect(CORRECT_FIX_CRITERIA_STATE).toHaveProperty('correct_fix_examples');
    expect(CORRECT_FIX_CRITERIA_STATE).toHaveProperty('not_a_fix_examples');
  });
});

describe('buildRankState', () => {
  const cands = [candidate(site, GCD_FIX), candidate(site, '        return gcd(a % b, a)')];
  const keys = ['candidate_aa', 'candidate_ab'];
  const ctx = context(async () => ({ answers: {}, rows: [], latencyMs: 0 }));

  it('has the measured shape: task, program {L<n>}, buggy_line_number, buggy_line, tests with expected AND actual', () => {
    const s = buildRankState(cands, keys, site, ctx, { withCandidates: false });
    expect(Object.keys(s).sort()).toEqual(['buggy_line', 'buggy_line_number', 'file', 'program', 'task', 'tests', 'user_task']);
    expect(s['program']).toEqual({ L1: 'def gcd(a, b):', L2: '    if b == 0:', L3: '        return a', L4: '    else:', L5: '        return gcd(a % b, b)' });
    expect(s['buggy_line_number']).toBe('L5');
    expect(s['buggy_line']).toBe('        return gcd(a % b, b)');
    const tests = s['tests'] as Json[];
    expect(tests).toHaveLength(3);
    expect(tests[0]).toEqual({ test_id: 'gcd[1]', call: 'gcd(13, 13)', expected: '13', actual_with_bug: 'RecursionError: maximum recursion depth exceeded' });
    expect(s).not.toHaveProperty('candidates');
  });

  it('adds candidates and the criteria once when asked (compact Nouls)', () => {
    const s = buildRankState(cands, keys, site, ctx, { withCandidates: true });
    expect(s['candidates']).toEqual({ candidate_aa: GCD_FIX, candidate_ab: '        return gcd(a % b, a)' });
    expect(s['correct_fix_criteria']).toEqual(CORRECT_FIX_CRITERIA_STATE);
  });

  it('bounds tests and the user task, and omits an empty user task', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ testId: `t${i}`, call: `f(${i})`, expected: 'x'.repeat(1000), actual: 'y' }));
    const s = buildRankState(cands, keys, site, context(ctx.ask, { task: '   ', failures: many }), { withCandidates: false });
    expect(s['tests']).toHaveLength(MAX_TESTS_IN_STATE);
    expect(((s['tests'] as Json[])[0] as Record<string, string>)['expected']?.length).toBeLessThanOrEqual(400);
    expect(s).not.toHaveProperty('user_task');
  });

  it('describes insert sites with the line before the insertion point as buggy_line', () => {
    const ins = siteAt(GCD_FILE, 3, 'insert');
    const s = buildRankState([candidate(ins, '        b = abs(b)')], ['candidate_aa'], ins, ctx, { withCandidates: false });
    expect(s['task']).toBe(taskSentence('insert', 'gcd'));
    expect(s['buggy_line_number']).toBe('L2');
    expect(s['buggy_line']).toBe('    if b == 0:');
  });

  it('an insertion in front of the first line anchors on line 1 and says "before", never a false "after"', () => {
    const top = siteAt(GCD_FILE, 1, 'insert');
    expect(rankMode(top)).toBe('insert_before');
    expect(rankMode(siteAt(GCD_FILE, 3, 'insert'))).toBe('insert');
    const s = buildRankState([candidate(top, 'import math')], ['candidate_aa'], top, ctx, { withCandidates: true });
    expect(s['buggy_line_number']).toBe('L1');
    expect(s['buggy_line']).toBe('def gcd(a, b):');
    expect(s['task']).toContain('It belongs immediately before `buggy_line`');
    expect(s['task']).not.toContain('after');
    const q = buildChoiceQuestion([candidate(top, 'import math')], ['candidate_aa'], rankMode(top));
    expect(q.type === 'choice' && String(q.instructions)).toContain('inserted immediately before `buggy_line`');
    expect(compactNoulInstruction('insert_before', 'candidate_aa')).toBe(
      'Is `candidates.candidate_aa` a correct fix per `correct_fix_criteria`: inserted immediately before `buggy_line`, does it make every test in `tests` pass?',
    );
    // The derived wording differs from the measured insert wording by that one word only.
    expect(CHOICE_INSTRUCTIONS.insert_before).toBe(CHOICE_INSTRUCTIONS.insert.replace('immediately after', 'immediately before'));
    expect(taskSentence('insert_before', 'gcd')).toBe(taskSentence('insert', 'gcd').replace('immediately after', 'immediately before'));
  });

  it('rejects a key/candidate length mismatch', () => {
    expect(() => buildRankState(cands, ['candidate_aa'], site, ctx, { withCandidates: false })).toThrow(RangeError);
  });
});

describe('question builders', () => {
  const cands = [candidate(site, GCD_FIX), candidate(site, '        return gcd(a % b, a)', { extraEdits: [{ path: 'gcd.py', line: 2, kind: 'replace', text: '    if b == 0 or a == 0:' }] })];
  const keys = ['candidate_aa', 'candidate_ab'];

  it('builds a Choice with candidate text as description, a described escape and the literal suffix', () => {
    const q = buildChoiceQuestion(cands, keys, 'replace');
    expect(q.type).toBe('choice');
    if (q.type !== 'choice') return;
    expect(q.instructions).toBe(CHOICE_INSTRUCTIONS.replace + LITERAL_SUFFIX);
    expect(q.criteria['candidate_aa']).toBe(GCD_FIX);
    expect(q.criteria['candidate_ab']).toEqual({ line: '        return gcd(a % b, a)', follow_up_edits: [{ path: 'gcd.py', line: 2, kind: 'replace', text: '    if b == 0 or a == 0:' }] });
    expect(q.criteria[ESCAPE_KEY]).toBe(ESCAPE_DESCRIPTION);
    expect(Object.keys(q.criteria).at(-1)).toBe(ESCAPE_KEY);
  });

  it('builds one instruction-only Noul per key, ids = keys', () => {
    const qs = buildCompactNouls(keys, 'insert');
    expect(Object.keys(qs)).toEqual(keys);
    for (const [k, q] of Object.entries(qs)) {
      expect(q.type).toBe('noul');
      expect(q.instructions).toBe(compactNoulInstruction('insert', k));
      expect(q).not.toHaveProperty('criteria');
    }
    expect(() => assertQuestionBatch({ ...qs, [CHOICE_QUESTION_ID]: buildChoiceQuestion(cands, keys, 'insert') })).not.toThrow();
  });

  it('the builders reject keys with a name prior, which is why keys are candidate_<xx>', () => {
    expect(() => choice('x', { a: 'one', option_1: 'two' })).toThrow(QuestionBuildError);
    expect(() => buildChoiceQuestion(cands, ['a', 'b'], 'replace')).toThrow(QuestionBuildError);
  });

  it('candidateDescription clips very long lines', () => {
    const d = candidateDescription(candidate(site, 'x'.repeat(2000)));
    expect(typeof d).toBe('string');
    expect((d as string).length).toBeLessThanOrEqual(400);
  });
});

describe('frozen gcd request (snapshot of the exact wording sent to Jev)', () => {
  it('matches test/fixtures/synth/rank/gcd-rank-request.json', () => {
    const cands = [
      candidate(site, '        return gcd(a % b, a)'),
      candidate(site, GCD_FIX),
      candidate(site, '        return gcd(a // b, b)'),
      candidate(site, '        return gcd(a, b)'),
    ];
    const keys = cands.map((_, i) => candidateKey(i));
    const ctx = context(async () => ({ answers: {}, rows: [], latencyMs: 0 }), { task: 'Fix the bug in gcd.' });
    const request = {
      choice_only: { state: buildRankState(cands, keys, site, ctx, { withCandidates: false }), questions: { [CHOICE_QUESTION_ID]: buildChoiceQuestion(cands, keys, 'replace') } },
      choice_and_compact_nouls: { state: buildRankState(cands, keys, site, ctx, { withCandidates: true }), questions: { ...buildCompactNouls(keys, 'replace'), [CHOICE_QUESTION_ID]: buildChoiceQuestion(cands, keys, 'replace') } },
    };
    const frozen: unknown = JSON.parse(readFileSync(`${FIXTURES}gcd-rank-request.json`, 'utf8'));
    expect(request).toEqual(frozen);
  });
});

describe('statement-level sites (Site.endLine): the joined statement is what Jev compares the options with', () => {
  const SRC = ['def f(self):', '    return hash((', '        self.a,', '        self.b,', '    ))', ''].join('\n');
  const file = sourceFile('m.py', SRC);
  const span = statementSiteAt(file, 2, { notes: ['n'] })!;
  const ctx = { task: 'fix hash', failures: GCD_FAILURES };

  it('buggy_line is the statement joined onto one line and buggy_line_number names the span; the program still lists the physical lines', () => {
    const c = candidate(span, '    return hash(self.a)');
    const s = buildRankState([c], ['candidate_aa'], span, ctx, { withCandidates: true });
    expect(s['buggy_line']).toBe('    return hash((self.a, self.b))');
    expect(s['buggy_line_number']).toBe('L2-L5');
    expect(s['program']).toEqual({ L1: 'def f(self):', L2: '    return hash((', L3: '        self.a,', L4: '        self.b,', L5: '    ))' });
    expect(s['task']).toBe(taskSentence('replace', 'f'));
    expect(rankMode(span)).toBe('replace');
    // a candidate equal to the joined statement is the unchanged line, whatever its spacing
    expect(isUnchanged(candidate(span, '    return hash((self.a,self.b))'), span)).toBe(true);
    expect(isUnchanged(c, span)).toBe(false);
    // a physical-line site is unchanged: the line itself, `L<n>`
    const phys = siteAt(file, 3);
    const p = buildRankState([candidate(phys, '        self.c,')], ['candidate_aa'], phys, ctx, { withCandidates: false });
    expect(p['buggy_line_number']).toBe('L3');
    expect(p['buggy_line']).toBe('        self.a,');
  });
});
