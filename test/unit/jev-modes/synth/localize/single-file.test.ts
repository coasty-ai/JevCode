import { describe, expect, it } from 'vitest';
import { LINE_QUESTION_ID, createLocalizer } from '../../../../../src/jev-modes/synth/localize/index.js';
import type { FailureView } from '../../../../../src/jev-modes/synth/types.js';
import { answerAll, fixture, scriptedAsk, sf, signal, workspace } from './helpers.js';

const GCD_TASK = 'The Python function `gcd` has a single-line bug. `tests` give inputs and the expected output (or, for graph programs, the test source); at least one of them fails on the buggy program. Exactly one line of `program` must change to fix it.';
const failures: FailureView[] = [
  { testId: 'gcd[1]', call: 'gcd(13, 13)', expected: '13', actual: 'RecursionError: maximum recursion depth exceeded' },
  { testId: 'gcd[2]', call: 'gcd(37, 600)', expected: '1', actual: 'RecursionError: maximum recursion depth exceeded' },
  { testId: 'gcd[3]', call: 'gcd(20, 100)', expected: '20', actual: 'RecursionError: maximum recursion depth exceeded' },
  { testId: 'gcd[4]', call: 'gcd(624129, 2061517)', expected: '18913', actual: 'RecursionError: maximum recursion depth exceeded' },
];

describe('single-file workspace (QuixBugs path)', () => {
  it('asks one flat line Choice with exactly the measured variant-D state shape for gcd', async () => {
    const { ask, calls } = scriptedAsk((call) => answerAll(call, () => 0, () => ({ line_5: 0.86, line_2: 0.08, line_3: 0.03 })));
    const files = workspace([sf('gcd.py', fixture('gcd.py'))]);
    const res = await createLocalizer().localize({ ask, task: GCD_TASK, files, failures, signal: signal(), budget: { maxRequests: 8 } });

    expect(calls).toHaveLength(1);
    expect(res.requests).toBe(1);
    const call = calls[0]!;
    expect(call.stage).toBe('context');
    // Snapshot of the measured state (probe-localization.md §2, variant D): the trailing QuixBugs
    // docstring is stripped, keys are original line numbers, three tests plus the failing run.
    expect(call.state).toEqual({
      task: `${GCD_TASK} \`failing_test_run\` shows what the buggy program actually did on one failing test.`,
      program: { L1: 'def gcd(a, b):', L2: '    if b == 0:', L3: '        return a', L4: '    else:', L5: '        return gcd(a % b, b)' },
      tests: [
        { call: 'gcd(13, 13)', expected: '13' },
        { call: 'gcd(37, 600)', expected: '1' },
        { call: 'gcd(20, 100)', expected: '20' },
      ],
      failing_test_run: { call: 'gcd(13, 13)', expected: '13', actual: 'RecursionError: maximum recursion depth exceeded' },
    });
    expect(call.questions).toEqual({
      [LINE_QUESTION_ID]: {
        type: 'choice',
        instructions: 'Which line of `program` contains the bug? Pick the single line that must change so that the function is correct. Choose `none_of_these` only if no listed line is faulty.',
        criteria: { line_1: 'def gcd(a, b):', line_2: '    if b == 0:', line_3: '        return a', line_4: '    else:', line_5: '        return gcd(a % b, b)', none_of_these: null },
      },
    });

    expect(res.files).toEqual([{ path: 'gcd.py', probability: 1, outline: ['gcd()'] }]);
    // functions derived in code from the line mass: gcd holds all of it
    expect(res.functions).toHaveLength(1);
    expect(res.functions[0]).toMatchObject({ name: 'gcd', startLine: 1, endLine: 5 });
    // 0.86 + 0.08 + 0.03 plus the even remainder on lines 1 and 4; the escape option's 0.01 is not line mass
    expect(res.functions[0]!.probability).toBeCloseTo(0.99, 5);

    // top-3 anchors by rank; the whole 5-line function is the window; insert gaps around each anchor
    expect(res.sites.slice(0, 3).map((s) => [s.line, s.kind, s.evidence.jevProbability])).toEqual([
      [5, 'replace', 0.86],
      [2, 'replace', 0.08],
      [3, 'replace', 0.03],
    ]);
    expect(res.sites[0]!.evidence.notes).toEqual(['jev anchor #1']);
    expect(res.sites[0]!.block).toEqual({ name: 'gcd', startLine: 1, endLine: 5 });
    expect(res.sites[0]!.scope.params).toEqual(['a', 'b']);
    // gaps before/after anchors 5, 2, 3: the gap at line 3 (after 2 and before 3) is one site
    expect(res.sites.filter((s) => s.kind === 'insert').map((s) => s.line).sort((x, y) => x - y)).toEqual([2, 3, 4, 5, 6]);
    // no site outside the program's lines (1..5 for replace, up to 6 for an insert after line 5)
    for (const s of res.sites) expect(s.line).toBeLessThanOrEqual(s.kind === 'insert' ? 6 : 5);
    const replaceLines = res.sites.filter((s) => s.kind === 'replace').map((s) => s.line).sort((x, y) => x - y);
    expect(replaceLines).toEqual([1, 2, 3, 4, 5]);
  });

  it('omits tests and the failing run when no failure is known, without changing the wording', async () => {
    const { ask, calls } = scriptedAsk((call) => answerAll(call, () => 0, () => ({ line_5: 0.5 })));
    const files = workspace([sf('gcd.py', fixture('gcd.py'))]);
    await createLocalizer().localize({ ask, task: 'fix gcd', files, failures: [], signal: signal(), budget: { maxRequests: 8 } });
    expect(Object.keys(calls[0]!.state as object)).toEqual(['task', 'program']);
    expect((calls[0]!.state as { task: string }).task).toBe('fix gcd');
  });

  it('splits module-level and function mass into separate function candidates', async () => {
    const src = 'LIMIT = 10\n\n\ndef f(x):\n    return x + LIMIT\n\n\ndef g(y):\n    return y * 2\n';
    const { ask } = scriptedAsk((call) => answerAll(call, () => 0, () => ({ line_1: 0.5, line_5: 0.3, line_9: 0.2 })));
    const res = await createLocalizer().localize({ ask, task: 'fix', files: workspace([sf('m.py', src)]), failures: [], signal: signal(), budget: { maxRequests: 8 } });
    expect(res.functions.map((f) => [f.name, f.probability])).toEqual([
      ['<module>', 0.5],
      ['f', 0.3],
      ['g', 0.2],
    ]);
    expect(res.sites[0]!.block).toBeNull();
    expect(res.sites[0]!.line).toBe(1);
  });
});
