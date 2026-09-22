/**
 * OOS iteration 2, question 5: the Ring-1 `--jev off` gate (HARNESS-NEXT-DESIGN §1.2 clause 3).
 *
 * The measurement. `experiments/results/llm-jev-iter1.md` §7: Ring 1 is RED — quixbugs Jev on
 * 2/3 → off 0/3 (lost `gcd`, `mergesort`), ladder on 2/2 → off 1/2 (lost `units`), and all three
 * losses carry the false-green signature (the Jev-off run ended SOONER than the Jev-on run that
 * solved the task, i.e. it replanned into the cap having tested nothing). None of the eight
 * ranked changes causes it: the cause is named in `experiments/harness-next/quick.mts`'s own
 * `ring1` docstring — "with every Choice escaped and every Noul inert, the localiser returns no
 * site at all (`GoalSearchTrace.sitesConsidered: 0`, `outcome: 'exhausted'`, the step parks with
 * 'no site located for …')". `src/synth/localize/index.ts` is allow-listed as "ranking only,
 * code order is the fallback", and that is the claim this file tests.
 *
 * The mechanism, exactly: `choiceProbs` drops the escape option, so an all-escape Choice answers
 * an EMPTY map. `stageFunctions` then contributes nothing, `stageLines` produces no anchor and
 * `singleFileFlat` produces no anchor and no function — and with no SBFL rows to union in, the
 * site list is empty and the synthesizer has nothing to enumerate. An escape is one of §1.2
 * clause 3's five named fallback triggers, so the right answer is not "no candidate" but "the
 * code order" — the traceback frames, the SBFL rank, and then the file's own defs and lines.
 *
 * The four-clause contract this restores: with Jev off every router takes its named code
 * fallback and the run still finishes, only slower.
 */
import { describe, expect, it } from 'vitest';
import { jevOffAnswer } from '../../../../src/jev/off.js';
import { createLocalizer } from '../../../../src/synth/localize/index.js';
import type { Answer } from '../../../../src/core/types.js';
import { GEOMETRY_FAILURE, GEOMETRY_TRACEBACK, scriptedAsk, sf, signal, twoFileWorkspace, workspace } from './helpers.js';

const TASK = 'Fix Point.distance in pkg/geometry.py so that test_distance passes.';

/** The decider `JEVCODE_JEV=off` installs, verbatim: every Choice on its escape, every Noul inert at 0.5. */
function jevOffAsk(): ReturnType<typeof scriptedAsk> {
  return scriptedAsk((call) => {
    const out: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(call.questions)) out[id] = jevOffAnswer(q);
    return out;
  });
}

const GCD_SRC = ['def gcd(a, b):', '    if b == 0:', '        return a', '    else:', '        return gcd(a % b, b)', ''].join('\n');
const GCD_TRACEBACK = ['Traceback (most recent call last):', '  File "/work/test_gcd.py", line 3, in test_gcd', '    assert gcd(35, 21) == 7', '  File "/work/gcd.py", line 5, in gcd', '    return gcd(a % b, b)', 'RecursionError: maximum recursion depth exceeded'].join('\n');

describe('question 5: with every Choice escaped the localiser falls through to the code order', () => {
  it('the multi-file pipeline still returns sites and functions (Ring 1 ladder: `units`)', async () => {
    const { ask } = jevOffAsk();
    const res = await createLocalizer().localize({ ask, task: TASK, files: twoFileWorkspace(), failures: [GEOMETRY_FAILURE], traceback: GEOMETRY_TRACEBACK, signal: signal(), budget: { maxRequests: 20 } });
    expect(res.files.length).toBeGreaterThan(0);
    expect(res.functions.length).toBeGreaterThan(0);
    expect(res.sites.length).toBeGreaterThan(0);
    // the traceback frame is the strongest code evidence there is, so it must be among the sites
    expect(res.sites.some((s) => s.file.path === 'pkg/geometry.py' && s.line === 17)).toBe(true);
  });

  it('the one-file pipeline still returns sites and functions (Ring 1 quixbugs: `gcd`, `mergesort`)', async () => {
    const { ask } = jevOffAsk();
    const files = workspace([sf('gcd.py', GCD_SRC)]);
    const res = await createLocalizer().localize({
      ask,
      task: 'Fix gcd so that test_gcd passes.',
      files,
      failures: [{ testId: 'test_gcd.py::test_gcd', call: 'gcd(35, 21)', expected: '7', actual: 'RecursionError: maximum recursion depth exceeded' }],
      traceback: GCD_TRACEBACK,
      signal: signal(),
      budget: { maxRequests: 20 },
    });
    expect(res.files.map((f) => f.path)).toEqual(['gcd.py']);
    expect(res.functions.length).toBeGreaterThan(0);
    expect(res.sites.length).toBeGreaterThan(0);
    expect(res.sites.some((s) => s.line === 5)).toBe(true);
  });

  it('with no traceback either, the file`s own defs and lines are still offered (a code order always exists)', async () => {
    const { ask } = jevOffAsk();
    const files = workspace([sf('gcd.py', GCD_SRC)]);
    const res = await createLocalizer().localize({
      ask,
      task: 'Fix gcd.',
      files,
      failures: [{ testId: 'test_gcd.py::test_gcd', call: 'gcd(35, 21)', expected: '7', actual: 'AssertionError' }],
      signal: signal(),
      budget: { maxRequests: 20 },
    });
    expect(res.functions.length).toBeGreaterThan(0);
    expect(res.sites.length).toBeGreaterThan(0);
  });
});
