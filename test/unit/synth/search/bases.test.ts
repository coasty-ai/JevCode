import { describe, expect, it } from 'vitest';

import type { Answer, Question } from '../../../../src/core/types.js';
import {
  MAX_BASE_DEPTH,
  MAX_PARTIAL_PAIRS,
  MAX_PARTIALS_REMEMBERED,
  appliedOnCommitted,
  commitPartial,
  createGuardMemory,
  forgetGoal,
  guardState,
  holdBestPartial,
  improvedBase,
  improvedBaseFor,
  isPartial,
  pairsOfPartials,
  siteKeyOf,
} from '../../../../src/synth/search/bases.js';
import type { Base } from '../../../../src/synth/search/types.js';
import type { Candidate, SourceFile } from '../../../../src/synth/types.js';
import { applyCandidate } from '../../../../src/synth/verify/index.js';
import { candidate, committedBase, failure, goal, outcome, partialOutcome, scoreAnswer, scriptedAsk, siteAt, sourceFile, summary, throwingAsk } from './helpers.js';

// A program with four failing tests, so partials can fix disjoint subsets.
const SRC = ['def prog(xs, k):', '    a = xs[0]', '    b = xs[1]', '    c = xs[2]', '    d = xs[3]', '    return a + b + c + d + k', ''].join('\n');
const FILE: SourceFile = sourceFile('prog.py', SRC);
const TESTS = ['prog([1, 2, 3, 4], 0)', 'prog([1, 2, 3, 4], 1)', 'prog([0, 0, 0, 0], 2)', 'prog([5, 5, 5, 5], 3)'];
const BASELINE = summary({ passed: 2, failing: TESTS, failures: TESTS.map((t) => failure(t)) });
const BASE: Base = committedBase(FILE, BASELINE);
const GOAL = goal(TESTS.map((t) => failure(t)));
const at = (line: number, text: string, id: string): Candidate => candidate(siteAt(FILE, line), text, { id });

/** Score answers for Q17: `closeness` gets the given level mass, the Nouls echo the code verdicts. */
function q17(level: number): (questions: Record<string, Question>) => Record<string, Answer> {
  return (questions) => {
    const out: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === 'score') {
        const w = [0, 0, 0, 0, 0];
        w[level] = 1;
        out[id] = scoreAnswer(q, w);
      } else out[id] = { type: 'noul', noul: id === 'made_progress' ? 0.95 : 0.05 };
    }
    return out;
  };
}

describe('holdBestPartial: ≤ 1 improved base, strictly-more-passed replacement, closeness tie-break', () => {
  it('the first partial is held: improved base at depth 1 with the edited file and the candidate', async () => {
    const mem = createGuardMemory(BASE);
    const p = partialOutcome(at(2, '    a = xs[0] + 1', 'p1'), BASE, [TESTS[0]!]);
    const r = await holdBestPartial(mem, [p], GOAL);
    expect(r.replaced).toBe(true);
    expect(r.requests).toBe(0);
    const held = improvedBase(mem);
    expect(held).toBe(r.held);
    expect(held?.origin).toBe('improved');
    expect(held?.fromGoal).toBe('g1');
    expect(held?.depth).toBe(1);
    expect(held?.summary.passed).toBe(3);
    expect(held?.candidate).toBe(p.applied);
    expect(held?.files.get('prog.py')?.src).toContain('    a = xs[0] + 1');
    expect(held?.files.get('prog.py')?.mod.lines).toHaveLength(FILE.mod.lines.length);
    expect(mem.bases.map((b) => b.origin)).toEqual(['committed', 'improved']);
  });
  it('replaced only by strictly more passed tests; fewer or equal (without Jev) keeps the incumbent', async () => {
    const mem = createGuardMemory(BASE);
    await holdBestPartial(mem, [partialOutcome(at(2, '    a = xs[0] + 1', 'two'), BASE, [TESTS[0]!, TESTS[1]!])], GOAL);
    const fewer = await holdBestPartial(mem, [partialOutcome(at(3, '    b = xs[1] + 1', 'one'), BASE, [TESTS[2]!])], GOAL);
    expect(fewer.replaced).toBe(false);
    expect(improvedBase(mem)?.candidate?.candidate.id).toBe('two');
    const equal = await holdBestPartial(mem, [partialOutcome(at(3, '    b = xs[1] + 2', 'two_b'), BASE, [TESTS[2]!, TESTS[3]!])], GOAL);
    expect(equal.replaced).toBe(false);
    expect(equal.requests).toBe(0);
    expect(improvedBase(mem)?.candidate?.candidate.id).toBe('two');
    const more = await holdBestPartial(mem, [partialOutcome(at(4, '    c = xs[2] + 1', 'three'), BASE, [TESTS[0]!, TESTS[1]!, TESTS[2]!])], GOAL);
    expect(more.replaced).toBe(true);
    expect(improvedBase(mem)?.candidate?.candidate.id).toBe('three');
    expect(mem.bases.filter((b) => b.origin === 'improved')).toHaveLength(1);
  });
  it('a tie is broken by the Q17 closeness E[level]: strictly closer replaces, otherwise the incumbent stays; the incumbent is judged once', async () => {
    const mem = createGuardMemory(BASE);
    await holdBestPartial(mem, [partialOutcome(at(2, '    a = xs[0] + 1', 'inc'), BASE, [TESTS[0]!, TESTS[1]!])], GOAL);
    // challenger judged "nearly correct" (3), incumbent "half way" (2) → replaced
    const ask1 = scriptedAsk((questions, _state, call) => q17(call === 1 ? 3 : 2)(questions));
    const r1 = await holdBestPartial(mem, [partialOutcome(at(3, '    b = xs[1] + 1', 'closer'), BASE, [TESTS[2]!, TESTS[3]!])], GOAL, { ask: ask1, subject: 'the Python function `prog`' });
    expect(ask1.calls).toHaveLength(2);
    expect(ask1.calls[0]?.stage).toBe('propose');
    expect(Object.keys(ask1.calls[0]!.questions).sort()).toEqual(['broke_something', 'closeness', 'made_progress', 'program_correct']);
    expect(String((ask1.calls[0]!.state as { task: string }).task)).toContain('the Python function `prog`');
    expect(r1.replaced).toBe(true);
    expect(r1.requests).toBe(2);
    expect(improvedBase(mem)?.candidate?.candidate.id).toBe('closer');
    expect(guardState(mem).closeness.get(improvedBase(mem)!.id)).toBe(3);
    // a challenger judged equal (3) does not displace; the incumbent's closeness is cached, so one request
    const ask2 = scriptedAsk((questions) => q17(3)(questions));
    const r2 = await holdBestPartial(mem, [partialOutcome(at(4, '    c = xs[2] + 1', 'equal'), BASE, [TESTS[0]!, TESTS[1]!])], GOAL, { ask: ask2 });
    expect(ask2.calls).toHaveLength(1);
    expect(r2.replaced).toBe(false);
    expect(improvedBase(mem)?.candidate?.candidate.id).toBe('closer');
    // a lower one neither
    const ask3 = scriptedAsk((questions) => q17(1)(questions));
    const r3 = await holdBestPartial(mem, [partialOutcome(at(5, '    d = xs[3] + 1', 'worse'), BASE, [TESTS[0]!, TESTS[1]!])], GOAL, { ask: ask3 });
    expect(r3.replaced).toBe(false);
  });
  it('several tied challengers in one batch: closeness picks among them before the incumbent comparison', async () => {
    const mem = createGuardMemory(BASE);
    const a = partialOutcome(at(2, '    a = xs[0] + 1', 'tie_a'), BASE, [TESTS[0]!, TESTS[1]!]);
    const b = partialOutcome(at(3, '    b = xs[1] + 1', 'tie_b'), BASE, [TESTS[2]!, TESTS[3]!]);
    const ask = scriptedAsk((questions, state) => {
      const after = (state as { after: { failing_tests: { test: string }[] } }).after;
      const fixedThird = !after.failing_tests.some((t) => t.test === TESTS[2]);
      return q17(fixedThird ? 4 : 1)(questions);
    });
    const r = await holdBestPartial(mem, [a, b], GOAL, { ask });
    expect(r.replaced).toBe(true);
    expect(improvedBase(mem)?.candidate?.candidate.id).toBe('tie_b');
    expect(r.requests).toBe(2);
  });
  it('never held: regressions, unchanged runs, timeouts, all-pass, and partials on a base already at MAX_BASE_DEPTH', async () => {
    const mem = createGuardMemory(BASE);
    const regressed = outcome(at(2, '    a = xs[0] + 1', 'reg'), BASE, { subset: summary({ passed: 3, failing: [TESTS[1]!, 'prog_other()'] }) });
    const unchanged = outcome(at(2, '    a = xs[0] + 2', 'same'), BASE, { subset: BASELINE });
    const timedOut = outcome(at(2, '    a = xs[0] + 3', 'slow'), BASE, { subset: summary({ passed: 3, failing: [TESTS[1]!], timedOut: true }), status: 'timeout' });
    const allPass = outcome(at(2, '    a = xs[0] + 4', 'all'), BASE, { subset: summary({ passed: 6, failing: [] }) });
    for (const o of [regressed, unchanged, timedOut, allPass]) expect(isPartial(o)).toBe(false);
    const r = await holdBestPartial(mem, [regressed, unchanged, timedOut, allPass], GOAL, { ask: throwingAsk });
    expect(r.held).toBeNull();
    expect(guardState(mem).partials).toEqual([]);
    const deep: Base = { ...BASE, id: 'deep', origin: 'improved', fromGoal: 'g1', depth: MAX_BASE_DEPTH };
    const tooDeep = partialOutcome(at(2, '    a = xs[0] + 5', 'deep1'), deep, [TESTS[0]!]);
    expect(isPartial(tooDeep)).toBe(true);
    const r2 = await holdBestPartial(mem, [tooDeep], GOAL);
    expect(r2.held).toBeNull();
  });
  it('remembers partials per goal (deduplicated, bounded) whether or not they became the base', async () => {
    const mem = createGuardMemory(BASE);
    const many = Array.from({ length: MAX_PARTIALS_REMEMBERED + 5 }, (_, i) => partialOutcome(at(2, `    a = xs[0] + ${i + 1}`, `m${i}`), BASE, [TESTS[0]!]));
    await holdBestPartial(mem, many, GOAL);
    await holdBestPartial(mem, many.slice(0, 3), GOAL);
    expect(guardState(mem).partials).toHaveLength(MAX_PARTIALS_REMEMBERED);
    expect(guardState(mem).partials.every((p) => p.goalId === 'g1')).toBe(true);
    expect(new Set(guardState(mem).partials.map((p) => p.outcome.applied.candidate.id)).size).toBe(MAX_PARTIALS_REMEMBERED);
  });
});

describe('pairsOfPartials: disjoint fixes at different sites become one composite candidate', () => {
  it('pairs partials whose newly passing sets are disjoint and whose sites differ; applies as one diff', async () => {
    const mem = createGuardMemory(BASE);
    const a = partialOutcome(at(2, '    a = xs[0] + 1', 'a'), BASE, [TESTS[0]!]);
    const b = partialOutcome(at(3, '    b = xs[1] + 1', 'b'), BASE, [TESTS[1]!, TESTS[2]!]);
    const sameSiteAsA = partialOutcome(at(2, '    a = xs[0] + 2', 'a2'), BASE, [TESTS[3]!]);
    const overlapsB = partialOutcome(at(4, '    c = xs[2] + 1', 'c'), BASE, [TESTS[2]!]);
    await holdBestPartial(mem, [a, b, sameSiteAsA, overlapsB], GOAL);
    const pairs = pairsOfPartials(mem, GOAL);
    const ids = pairs.map((p) => p.id);
    expect(ids).toContain('pair:a+b');
    expect(ids).toContain('pair:b+a2');
    expect(ids).toContain('pair:a+c');
    expect(ids).toContain('pair:a2+c');
    expect(ids).not.toContain('pair:a+a2');
    expect(ids).not.toContain('pair:b+c');
    // most tests covered first (a+b and b+a2 cover 3), then smaller edit
    expect(ids.slice(0, 2).sort()).toEqual(['pair:a+b', 'pair:b+a2']);
    const ab = pairs.find((p) => p.id === 'pair:a+b')!;
    expect(ab.source).toBe('composite');
    expect(ab.op).toBe('pair_of_partials');
    expect(siteKeyOf(ab)).toBe(siteKeyOf(a.applied.candidate));
    expect(ab.extraEdits).toEqual([{ path: 'prog.py', line: 3, kind: 'replace', text: '    b = xs[1] + 1' }]);
    const applied = applyCandidate(ab, BASE.files);
    expect(applied.files[0]?.after).toContain('    a = xs[0] + 1\n    b = xs[1] + 1\n');
    expect(applied.diff).toContain('+    a = xs[0] + 1');
    expect(applied.diff).toContain('+    b = xs[1] + 1');
  });
  it('carries both partials\' extra edits and skips pairs whose edits touch the same line', async () => {
    const mem = createGuardMemory(BASE);
    const withExtra = partialOutcome(candidate(siteAt(FILE, 2), '    a = xs[0] + 1', { id: 'x', extraEdits: [{ path: 'prog.py', line: 5, kind: 'replace', text: '    d = xs[3] + 1' }] }), BASE, [TESTS[0]!]);
    const touchesLine5 = partialOutcome(at(5, '    d = xs[3] + 2', 'y'), BASE, [TESTS[1]!]);
    const clean = partialOutcome(at(3, '    b = xs[1] + 1', 'z'), BASE, [TESTS[2]!]);
    await holdBestPartial(mem, [withExtra, touchesLine5, clean], GOAL);
    const ids = pairsOfPartials(mem, GOAL).map((p) => p.id);
    expect(ids).not.toContain('pair:x+y');
    expect(ids).toContain('pair:x+z');
    expect(ids).toContain('pair:y+z');
    const xz = pairsOfPartials(mem, GOAL).find((p) => p.id === 'pair:x+z')!;
    expect(xz.extraEdits?.map((e) => e.line)).toEqual([5, 3]);
  });
  it('only partials run on the committed base pair (same coordinates); other goals are ignored; ≤ 10 pairs', async () => {
    const mem = createGuardMemory(BASE);
    const improved: Base = { ...BASE, id: 'imp', origin: 'improved', fromGoal: 'g1', depth: 1 };
    const onImproved = partialOutcome(at(2, '    a = xs[0] + 1', 'imp1'), improved, [TESTS[0]!]);
    const onCommitted = partialOutcome(at(3, '    b = xs[1] + 1', 'com1'), BASE, [TESTS[1]!]);
    await holdBestPartial(mem, [onImproved, onCommitted], GOAL);
    expect(pairsOfPartials(mem, GOAL)).toEqual([]);
    expect(pairsOfPartials(mem, goal([failure('other()')], { id: 'g2' }))).toEqual([]);

    // six sites each fixing one distinct test → C(6,2) = 15 disjoint pairs, cut to 10
    const six = ['t1', 't2', 't3', 't4', 't5', 't6'];
    const wide = summary({ passed: 0, failing: six, failures: six.map((t) => failure(t)) });
    const wideBase = committedBase(FILE, wide);
    const wideGoal = goal(six.map((t) => failure(t)), { id: 'g3' });
    const mem2 = createGuardMemory(wideBase);
    const parts = six.map((t, i) => partialOutcome(at(2 + (i % 5), `    v${i} = ${i}`, `w${i}`), wideBase, [t]));
    await holdBestPartial(mem2, parts, wideGoal);
    const pairs = pairsOfPartials(mem2, wideGoal);
    expect(pairs.length).toBe(MAX_PARTIAL_PAIRS);
    expect(new Set(pairs.map((p) => p.id)).size).toBe(MAX_PARTIAL_PAIRS);
  });
});

describe('appliedOnCommitted: every commit is a patch of the committed workspace', () => {
  it('a partial on the improved base becomes a depth-2 base whose candidate carries both edits; commitPartial proposes that', async () => {
    const mem = createGuardMemory(BASE);
    const first = partialOutcome(at(2, '    a = xs[0] + 1', 'first'), BASE, [TESTS[0]!]);
    await holdBestPartial(mem, [first], GOAL);
    const held1 = improvedBase(mem)!;
    expect(held1.candidate).toBe(first.applied);
    const fileOnHeld = held1.files.get('prog.py')!;
    const second = partialOutcome(candidate(siteAt(fileOnHeld, 3), '    b = xs[1] + 1', { id: 'second' }), held1, [TESTS[1]!, TESTS[2]!]);
    expect(second.applied.files[0]?.before).toBe(fileOnHeld.src);
    const r = await holdBestPartial(mem, [second], GOAL);
    expect(r.replaced).toBe(true);
    const held2 = improvedBase(mem)!;
    expect(held2.depth).toBe(2);
    const composed = held2.candidate!;
    expect(composed.candidate.id).toBe('second');
    expect(composed.files).toEqual([{ path: 'prog.py', before: SRC, after: second.applied.files[0]!.after }]);
    expect(composed.diff).toContain('+    a = xs[0] + 1');
    expect(composed.diff).toContain('+    b = xs[1] + 1');
    expect(composed.diff).toContain('-    a = xs[0]\n');
    expect(composed.diff).toContain('-    b = xs[1]\n');
    expect(appliedOnCommitted(mem, second)).toEqual(composed);
    const d = commitPartial(mem, GOAL);
    expect(d).toEqual({ kind: 'commit', applied: composed, allGoalTestsPass: false, note: 'partial' });
  });
  it('an outcome on the committed base is returned as is', async () => {
    const mem = createGuardMemory(BASE);
    const p = partialOutcome(at(2, '    a = xs[0] + 1', 'p'), BASE, [TESTS[0]!]);
    expect(appliedOnCommitted(mem, p)).toBe(p.applied);
  });
});

describe('commitPartial and forgetGoal', () => {
  it('commits the held partial for the goal as note "partial" and removes it from the beam', async () => {
    const mem = createGuardMemory(BASE);
    expect(commitPartial(mem, GOAL)).toBeNull();
    const p = partialOutcome(at(2, '    a = xs[0] + 1', 'held'), BASE, [TESTS[0]!]);
    await holdBestPartial(mem, [p], GOAL);
    expect(improvedBaseFor(mem, GOAL)?.candidate).toBe(p.applied);
    expect(improvedBaseFor(mem, goal([failure('other()')], { id: 'g2' }))).toBeUndefined();
    expect(commitPartial(mem, goal([failure('other()')], { id: 'g2' }))).toBeNull();
    const d = commitPartial(mem, GOAL);
    expect(d).toEqual({ kind: 'commit', applied: p.applied, allGoalTestsPass: false, note: 'partial' });
    expect(mem.bases.map((b) => b.origin)).toEqual(['committed']);
    expect(commitPartial(mem, GOAL)).toBeNull();
  });
  it('forgetGoal drops the goal\'s partials, its improved base and its closeness cache', async () => {
    const mem = createGuardMemory(BASE);
    await holdBestPartial(mem, [partialOutcome(at(2, '    a = xs[0] + 1', 'f1'), BASE, [TESTS[0]!])], GOAL);
    guardState(mem).closeness.set(improvedBase(mem)!.id, 2);
    forgetGoal(mem, GOAL);
    expect(guardState(mem).partials).toEqual([]);
    expect(improvedBase(mem)).toBeUndefined();
    expect(guardState(mem).closeness.size).toBe(0);
  });
});
