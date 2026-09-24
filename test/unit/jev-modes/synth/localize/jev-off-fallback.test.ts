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
 * 'no site located for …')". `src/jev-modes/synth/localize/index.ts` is allow-listed as "ranking only,
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
import { jevOffAnswer } from '../../../../../src/jev/off.js';
import { createLocalizer } from '../../../../../src/jev-modes/synth/localize/index.js';
import type { Answer } from '../../../../../src/core/types.js';
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
    // OOS iteration 3, item 4: the wider escaped code order is still BOUNDED — the function beam
    // caps it, so a multi-file workspace gets tens of sites, not one per line of the repository
    // (measured on the ladder sources at this commit: `units` 2 files / 57 lines → 70 sites,
    // `crossfile` 5 / 156 → 47, `six_hunks` 6 / 148 → 20)
    expect(res.sites.length).toBeLessThan(200);
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

  /**
   * OOS iteration 3, item 4 — the residual Ring 1 kept failing on.
   *
   * Iteration 2 made the escape produce SITES; it did not make them the right ones. The code
   * order fell out of `codeDerivedLines` capped at `anchorsPerFunction` = 3, a bound measured on
   * a JEV RANKING ("top-3 covers 36/40"). With no Jev opinion, no traceback frame and no coverage
   * there is no ranking — the "code order" is the file's own line order, so a top-3 of it is the
   * first three lines of the function and nothing else. The three Ring-1 losses are exactly that:
   *
   *   - `kth` — the gold REPLACES L12 (`return kth(above, k)` → `kth(above, k - num_lessoreq)`).
   *     The recorded `--jev off` run `20260922-155658-35hfmbqm` visited nine sites and every one
   *     of them was an insert gap (`kth.py:2 (gap), kth.py:10 (gap), kth.py:12 (gap), …`); no
   *     replace site anywhere in the run, `plausible 0` on every step, `replan_stop` at 11.
   *   - `mergesort` — the gold REPLACES L17 (`len(arr) == 0` → `len(arr) <= 1`), which is the
   *     first statement AFTER the nested `merge` def.
   *   - `units` — the gold rewrites L24 onwards of `parse_duration`.
   *
   * The fix is `escapedAnchors`: the escaped branch offers every line of the located function
   * (bounded), and the site budget decides how far the step gets. It applies ONLY when the Choice
   * escaped, so a Jev-on trajectory is untouched — the last assertion here pins that.
   */
  it('the escaped code order offers a replace site at the defect line, not just the first three lines of the function (kth L12, mergesort L17)', async () => {
    const kth = ['def kth(arr, k):', '    pivot = arr[0]', '    below = [x for x in arr if x < pivot]', '    above = [x for x in arr if x > pivot]', '', '    num_less = len(below)', '    num_lessoreq = len(arr) - len(above)', '', '    if k < num_less:', '        return kth(below, k)', '    elif k >= num_lessoreq:', '        return kth(above, k)', '    else:', '        return pivot', ''].join('\n');
    const { ask } = jevOffAsk();
    const res = await createLocalizer().localize({
      ask,
      task: 'Fix kth.',
      files: workspace([sf('kth.py', kth)]),
      failures: [{ testId: 'tests/test_kth.py::test_kth', call: 'kth([1, 2, 3, 4, 5, 6, 7], 4)', expected: '5', actual: 'IndexError: list index out of range' }],
      signal: signal(),
      budget: { maxRequests: 20 },
    });
    expect(res.sites.some((s) => s.line === 12 && s.kind === 'replace')).toBe(true);

    const mergesort = ['', 'def mergesort(arr):', '    def merge(left, right):', '        result = []', '        i = 0', '        j = 0', '        while i < len(left) and j < len(right):', '            if left[i] <= right[j]:', '                result.append(left[i])', '                i += 1', '            else:', '                result.append(right[j])', '                j += 1', '        result.extend(left[i:] or right[j:])', '        return result', '', '    if len(arr) == 0:', '        return arr', '    else:', '        middle = len(arr) // 2', '        left = mergesort(arr[:middle])', '        right = mergesort(arr[middle:])', '        return merge(left, right)', ''].join('\n');
    const two = jevOffAsk();
    const ms = await createLocalizer().localize({
      ask: two.ask,
      task: 'Fix mergesort.',
      files: workspace([sf('mergesort.py', mergesort)]),
      failures: [{ testId: 'tests/test_mergesort.py::test_mergesort', call: 'mergesort([1])', expected: '[1]', actual: 'RecursionError: maximum recursion depth exceeded' }],
      signal: signal(),
      budget: { maxRequests: 20 },
    });
    expect(ms.sites.some((s) => s.line === 17 && s.kind === 'replace')).toBe(true);
  });

  /**
   * OOS iteration 3, item 4, second hole — the ladder `units` Ring-1 loss, which the anchor width
   * does NOT explain (its defect lines 24–26 are anchored either way).
   *
   * Run `20260922-155631-5dprh2ue` (`--jev off`, ladder `units`): every goal parks with
   * `no site located for …` and `sites 0, requests 6, runs 0` — 12 steps, 1 s, 0 candidates
   * tested. With Jev off the file Nouls are inert and the file + confirm stages spend the whole
   * localise budget, so `stageFunctions` can afford nobody and `stageLines` can afford nobody;
   * both then returned NOTHING, and the two code fallbacks that cost no request at all —
   * `codeDerivedFunctions` and `codeDerivedLines` — were gated behind `asker.canAsk()` /
   * `affordable(0)`, i.e. behind the very budget whose exhaustion is what they exist for. §1.2
   * clause 3 says a fallback is deterministic code, not another thing the router has to pay for.
   */
  it('a spent request budget takes the code fallback instead of returning no site at all (Ring 1 ladder: `units`)', async () => {
    const { ask, calls } = jevOffAsk();
    // budget 2: the file stage and the confirmation take both, exactly as the recorded run did
    const res = await createLocalizer().localize({ ask, task: TASK, files: twoFileWorkspace(), failures: [GEOMETRY_FAILURE], traceback: GEOMETRY_TRACEBACK, signal: signal(), budget: { maxRequests: 2 } });
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(res.functions.length).toBeGreaterThan(0);
    expect(res.sites.length).toBeGreaterThan(0);
    expect(res.sites.some((s) => s.kind === 'replace')).toBe(true);
    // the traceback frame is still reachable, with no request left to ask about it
    expect(res.sites.some((s) => s.file.path === 'pkg/geometry.py' && s.line === 17)).toBe(true);
    // and with NO budget at all there is still a code order rather than an empty site list
    const zero = await createLocalizer().localize({ ask: jevOffAsk().ask, task: TASK, files: twoFileWorkspace(), failures: [GEOMETRY_FAILURE], traceback: GEOMETRY_TRACEBACK, signal: signal(), budget: { maxRequests: 0 } });
    expect(zero.requests).toBe(0);
    expect(zero.sites.length).toBeGreaterThan(0);
  });

  it('the wider code order is the ESCAPE path only: a Jev that ranks lines still gets its measured top-3 beam', async () => {
    const kth = ['def kth(arr, k):', '    pivot = arr[0]', '    below = [x for x in arr if x < pivot]', '    above = [x for x in arr if x > pivot]', '', '    num_less = len(below)', '    num_lessoreq = len(arr) - len(above)', '', '    if k < num_less:', '        return kth(below, k)', '    elif k >= num_lessoreq:', '        return kth(above, k)', '    else:', '        return pivot', ''].join('\n');
    // a Jev with an opinion: mass on L12, L11, L9 — the measured top-3 shape
    const ranked = scriptedAsk((call) => {
      const out: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(call.questions)) {
        if (q.type !== 'choice') {
          out[id] = jevOffAnswer(q);
          continue;
        }
        const keys = Object.keys(q.criteria).filter((k) => k !== 'none_of_these');
        const wanted = ['line_12', 'line_11', 'line_9'].filter((k) => keys.includes(k));
        const probabilities: Record<string, number> = { none_of_these: 0.01 };
        for (const k of keys) probabilities[k] = wanted.includes(k) ? 0.33 : 0;
        if (wanted.length === 0 && keys[0] !== undefined) probabilities[keys[0]] = 0.99;
        out[id] = { type: 'choice', choice: wanted[0] ?? keys[0] ?? 'none_of_these', probabilities, confidence: 0.8 };
      }
      return out;
    });
    const res = await createLocalizer().localize({
      ask: ranked.ask,
      task: 'Fix kth.',
      files: workspace([sf('kth.py', kth)]),
      failures: [{ testId: 'tests/test_kth.py::test_kth', call: 'kth([1, 2, 3, 4, 5, 6, 7], 4)', expected: '5', actual: 'IndexError: list index out of range' }],
      signal: signal(),
      budget: { maxRequests: 20 },
    });
    // the beam is still the measured top-3 when there is an opinion to beam over: every site
    // carries a `jev anchor` provenance, and the list is far shorter than the escaped one
    expect(res.sites.some((s) => s.line === 12 && s.kind === 'replace')).toBe(true);
    expect(res.sites.every((s) => !s.evidence.notes.some((n) => n.includes('the line Choice escaped')))).toBe(true);
    const escapedRun = await createLocalizer().localize({
      ask: jevOffAsk().ask,
      task: 'Fix kth.',
      files: workspace([sf('kth.py', kth)]),
      failures: [{ testId: 'tests/test_kth.py::test_kth', call: 'kth([1, 2, 3, 4, 5, 6, 7], 4)', expected: '5', actual: 'IndexError: list index out of range' }],
      signal: signal(),
      budget: { maxRequests: 20 },
    });
    expect(res.sites.length).toBeLessThan(escapedRun.sites.length);
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
