import { describe, expect, it } from 'vitest';

import type { Json } from '../../../../../src/core/types.js';
import {
  MAX_BASE_DEPTH,
  MAX_PARTIAL_PAIRS,
  MAX_PARTIALS_REMEMBERED,
  appliedOnCommitted,
  commitPartial,
  compareTieKeys,
  createGuardMemory,
  diffSize,
  dropHeldPartial,
  forgetGoal,
  forgetHeld,
  heldPartialOutcome,
  freshPairsOfPartials,
  guardState,
  holdBestPartial,
  improvedBase,
  improvedBaseFor,
  isPartial,
  pairsOfPartials,
  partialsFromPersisted,
  partialsOf,
  persistPartials,
  restorePartials,
  siteKeyOf,
  tieKeyOf,
} from '../../../../../src/jev-modes/synth/search/bases.js';
import { sha12 } from '../../../../../src/core/hash.js';
import type { Base } from '../../../../../src/jev-modes/synth/search/types.js';
import type { Candidate, SourceFile } from '../../../../../src/jev-modes/synth/types.js';
import { applyCandidate } from '../../../../../src/jev-modes/synth/verify/index.js';
import { candidate, committedBase, failure, goal, outcome, partialOutcome, siteAt, sourceFile, summary } from './helpers.js';

// A program with four failing tests, so partials can fix disjoint subsets.
const SRC = ['def prog(xs, k):', '    a = xs[0]', '    b = xs[1]', '    c = xs[2]', '    d = xs[3]', '    return a + b + c + d + k', ''].join('\n');
const FILE: SourceFile = sourceFile('prog.py', SRC);
const TESTS = ['prog([1, 2, 3, 4], 0)', 'prog([1, 2, 3, 4], 1)', 'prog([0, 0, 0, 0], 2)', 'prog([5, 5, 5, 5], 3)'];
const BASELINE = summary({ passed: 2, failing: TESTS, failures: TESTS.map((t) => failure(t)) });
const BASE: Base = committedBase(FILE, BASELINE);
const GOAL = goal(TESTS.map((t) => failure(t)));
const at = (line: number, text: string, id: string): Candidate => candidate(siteAt(FILE, line), text, { id });

describe('holdBestPartial: ≤ 1 improved base, strictly-more-passed replacement, code tie-break', () => {
  it('the first partial is held: improved base at depth 1 with the edited file and the candidate', () => {
    const mem = createGuardMemory(BASE);
    const p = partialOutcome(at(2, '    a = xs[0] + 1', 'p1'), BASE, [TESTS[0]!]);
    const r = holdBestPartial(mem, [p], GOAL);
    expect(r).toEqual({ held: improvedBase(mem), replaced: true });
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
  it('replaced only by strictly more passed tests; fewer keeps the incumbent', () => {
    const mem = createGuardMemory(BASE);
    holdBestPartial(mem, [partialOutcome(at(2, '    a = xs[0] + 1', 'two'), BASE, [TESTS[0]!, TESTS[1]!])], GOAL);
    const fewer = holdBestPartial(mem, [partialOutcome(at(3, '    b = xs[1] + 1', 'one'), BASE, [TESTS[2]!])], GOAL);
    expect(fewer.replaced).toBe(false);
    expect(improvedBase(mem)?.candidate?.candidate.id).toBe('two');
    const more = holdBestPartial(mem, [partialOutcome(at(4, '    c = xs[2] + 1', 'three'), BASE, [TESTS[0]!, TESTS[1]!, TESTS[2]!])], GOAL);
    expect(more.replaced).toBe(true);
    expect(improvedBase(mem)?.candidate?.candidate.id).toBe('three');
    expect(mem.bases.filter((b) => b.origin === 'improved')).toHaveLength(1);
  });
  it('a tie on passed against the incumbent is broken in code: a strictly smaller diff on the committed workspace replaces, an equal or larger one keeps the incumbent (the earlier one)', () => {
    const mem = createGuardMemory(BASE);
    // incumbent: two tests, a 2-digit edit
    holdBestPartial(mem, [partialOutcome(at(3, '    b = xs[1] + 10', 'inc'), BASE, [TESTS[0]!, TESTS[1]!])], GOAL);
    const inc = improvedBase(mem)!;
    // same passed, a larger diff → the incumbent stays
    const bigger = partialOutcome(at(3, '    b = xs[1] + 1000', 'bigger'), BASE, [TESTS[2]!, TESTS[3]!]);
    expect(holdBestPartial(mem, [bigger], GOAL)).toEqual({ held: inc, replaced: false });
    // same passed, the same diff size (a different 2-digit edit) → the incumbent stays: it was held first
    const sameSize = partialOutcome(at(3, '    b = xs[1] + 20', 'same_size'), BASE, [TESTS[2]!, TESTS[3]!]);
    expect(tieKeyOf(mem, sameSize)).toEqual({ newlyFailing: 0, ...diffSize(inc.candidate!.diff) });
    expect(holdBestPartial(mem, [sameSize], GOAL)).toEqual({ held: inc, replaced: false });
    expect(improvedBase(mem)?.candidate?.candidate.id).toBe('inc');
    // same passed, a strictly smaller diff → replaces
    const smaller = partialOutcome(at(3, '    b = xs[1] + 1', 'smaller'), BASE, [TESTS[2]!, TESTS[3]!]);
    expect(tieKeyOf(mem, smaller).diffChars).toBeLessThan(diffSize(inc.candidate!.diff).diffChars);
    const r = holdBestPartial(mem, [smaller], GOAL);
    expect(r.replaced).toBe(true);
    expect(improvedBase(mem)?.candidate?.candidate.id).toBe('smaller');
    expect(mem.bases.filter((b) => b.origin === 'improved')).toHaveLength(1);
    // strictly more passed still wins whatever the diff size
    const more = holdBestPartial(mem, [partialOutcome(at(4, '    c = xs[2] + 123456', 'three'), BASE, [TESTS[0]!, TESTS[1]!, TESTS[2]!])], GOAL);
    expect(more.replaced).toBe(true);
    expect(improvedBase(mem)?.candidate?.candidate.id).toBe('three');
  });
  it('several tied challengers in one batch: the smaller diff wins (changed lines, then their characters — never the context), an exact tie goes to the earlier one in the list', () => {
    const mem = createGuardMemory(BASE);
    // the longer edit sits at line 2 where the unified diff has LESS context; the changed lines decide, not the diff text
    const long = partialOutcome(at(2, '    a = xs[0] + 1000', 'tie_long'), BASE, [TESTS[0]!, TESTS[1]!]);
    const short = partialOutcome(at(3, '    b = xs[1] + 1', 'tie_short'), BASE, [TESTS[2]!, TESTS[3]!]);
    expect(long.applied.diff.length).toBeLessThan(short.applied.diff.length);
    expect(compareTieKeys(tieKeyOf(mem, short), tieKeyOf(mem, long))).toBeLessThan(0);
    expect(holdBestPartial(mem, [long, short], GOAL).replaced).toBe(true);
    expect(improvedBase(mem)?.candidate?.candidate.id).toBe('tie_short');
    // a two-line edit loses to a one-line edit even when its changed lines total fewer characters
    const twoLines = partialOutcome(candidate(siteAt(FILE, 2), '    a = 1', { id: 'two_lines', extraEdits: [{ path: 'prog.py', line: 3, kind: 'replace', text: '    b = 1' }] }), BASE, [TESTS[0]!, TESTS[1]!]);
    const oneLong = partialOutcome(at(3, `    b = xs[1] + ${'9'.repeat(40)}`, 'one_long'), BASE, [TESTS[2]!, TESTS[3]!]);
    expect(tieKeyOf(mem, twoLines).diffLines).toBe(4);
    expect(tieKeyOf(mem, oneLong).diffLines).toBe(2);
    expect(tieKeyOf(mem, twoLines).diffChars).toBeLessThan(tieKeyOf(mem, oneLong).diffChars);
    const mem3 = createGuardMemory(BASE);
    holdBestPartial(mem3, [twoLines, oneLong], GOAL);
    expect(improvedBase(mem3)?.candidate?.candidate.id).toBe('one_long');
    // equal-size diffs at the same site: list order, both ways round
    const first = partialOutcome(at(4, '    c = xs[2] + 1', 'first'), BASE, [TESTS[0]!, TESTS[1]!, TESTS[2]!]);
    const second = partialOutcome(at(4, '    c = xs[2] + 2', 'second'), BASE, [TESTS[1]!, TESTS[2]!, TESTS[3]!]);
    expect(tieKeyOf(mem, first)).toEqual(tieKeyOf(mem, second));
    expect(holdBestPartial(mem, [first, second], GOAL).replaced).toBe(true);
    expect(improvedBase(mem)?.candidate?.candidate.id).toBe('first');
    const mem2 = createGuardMemory(BASE);
    holdBestPartial(mem2, [second, first], GOAL);
    expect(improvedBase(mem2)?.candidate?.candidate.id).toBe('second');
  });
  it('the tie key: fewer newly-failing tests before any diff size, fewer changed lines before fewer characters; a partial has 0 newly failing by construction and its diff is measured on the committed workspace', () => {
    expect(compareTieKeys({ newlyFailing: 0, diffLines: 8, diffChars: 900 }, { newlyFailing: 1, diffLines: 2, diffChars: 10 })).toBeLessThan(0);
    expect(compareTieKeys({ newlyFailing: 0, diffLines: 2, diffChars: 90 }, { newlyFailing: 0, diffLines: 4, diffChars: 10 })).toBeLessThan(0);
    expect(compareTieKeys({ newlyFailing: 0, diffLines: 2, diffChars: 10 }, { newlyFailing: 0, diffLines: 2, diffChars: 11 })).toBeLessThan(0);
    expect(compareTieKeys({ newlyFailing: 0, diffLines: 2, diffChars: 11 }, { newlyFailing: 0, diffLines: 2, diffChars: 10 })).toBeGreaterThan(0);
    expect(compareTieKeys({ newlyFailing: 2, diffLines: 2, diffChars: 5 }, { newlyFailing: 2, diffLines: 2, diffChars: 5 })).toBe(0);
    // diffSize reads the `+`/`-` bodies only: no headers, no context, no hunk lines, no newline marker
    expect(diffSize('')).toEqual({ diffLines: 0, diffChars: 0 });
    expect(diffSize(['diff --git a/p.py b/p.py', '--- a/p.py', '+++ b/p.py', '@@ -1,2 +1,2 @@', ' ctx', '-old line', '+new', '\\ No newline at end of file', ''].join('\n'))).toEqual({ diffLines: 2, diffChars: 11 });
    const mem = createGuardMemory(BASE);
    const onCommitted = partialOutcome(at(2, '    a = xs[0] + 1', 'k1'), BASE, [TESTS[0]!]);
    expect(onCommitted.progress.newlyFailing).toEqual([]);
    expect(tieKeyOf(mem, onCommitted)).toEqual({ newlyFailing: 0, diffLines: 2, diffChars: '    a = xs[0]'.length + '    a = xs[0] + 1'.length });
    // a partial on the improved base is measured by its cumulative edit over the committed files
    holdBestPartial(mem, [onCommitted], GOAL);
    const held = improvedBase(mem)!;
    const onHeld = partialOutcome(candidate(siteAt(held.files.get('prog.py')!, 3), '    b = xs[1] + 1', { id: 'k2' }), held, [TESTS[1]!]);
    expect(diffSize(onHeld.applied.diff).diffLines).toBe(2);
    expect(tieKeyOf(mem, onHeld)).toEqual({ newlyFailing: 0, ...diffSize(appliedOnCommitted(mem, onHeld).diff) });
    expect(tieKeyOf(mem, onHeld).diffLines).toBe(4);
  });
  it('never held: regressions, unchanged runs, timeouts, all-pass, and partials on a base already at MAX_BASE_DEPTH', () => {
    const mem = createGuardMemory(BASE);
    const regressed = outcome(at(2, '    a = xs[0] + 1', 'reg'), BASE, { subset: summary({ passed: 3, failing: [TESTS[1]!, 'prog_other()'] }) });
    const unchanged = outcome(at(2, '    a = xs[0] + 2', 'same'), BASE, { subset: BASELINE });
    const timedOut = outcome(at(2, '    a = xs[0] + 3', 'slow'), BASE, { subset: summary({ passed: 3, failing: [TESTS[1]!], timedOut: true }), status: 'timeout' });
    const allPass = outcome(at(2, '    a = xs[0] + 4', 'all'), BASE, { subset: summary({ passed: 6, failing: [] }) });
    for (const o of [regressed, unchanged, timedOut, allPass]) expect(isPartial(o)).toBe(false);
    const r = holdBestPartial(mem, [regressed, unchanged, timedOut, allPass], GOAL);
    expect(r.held).toBeNull();
    expect(guardState(mem).partials).toEqual([]);
    const deep: Base = { ...BASE, id: 'deep', origin: 'improved', fromGoal: 'g1', depth: MAX_BASE_DEPTH };
    const tooDeep = partialOutcome(at(2, '    a = xs[0] + 5', 'deep1'), deep, [TESTS[0]!]);
    expect(isPartial(tooDeep)).toBe(true);
    const r2 = holdBestPartial(mem, [tooDeep], GOAL);
    expect(r2.held).toBeNull();
  });
  it('remembers partials per goal (deduplicated, bounded) whether or not they became the base', () => {
    const mem = createGuardMemory(BASE);
    const many = Array.from({ length: MAX_PARTIALS_REMEMBERED + 5 }, (_, i) => partialOutcome(at(2, `    a = xs[0] + ${i + 1}`, `m${i}`), BASE, [TESTS[0]!]));
    holdBestPartial(mem, many, GOAL);
    holdBestPartial(mem, many.slice(0, 3), GOAL);
    expect(guardState(mem).partials).toHaveLength(MAX_PARTIALS_REMEMBERED);
    expect(guardState(mem).partials.every((p) => p.goalId === 'g1')).toBe(true);
    expect(new Set(guardState(mem).partials.map((p) => p.outcome.applied.candidate.id)).size).toBe(MAX_PARTIALS_REMEMBERED);
  });
});

describe('pairsOfPartials: disjoint fixes at different sites become one composite candidate', () => {
  it('pairs partials whose newly passing sets are disjoint and whose sites differ; applies as one diff', () => {
    const mem = createGuardMemory(BASE);
    const a = partialOutcome(at(2, '    a = xs[0] + 1', 'a'), BASE, [TESTS[0]!]);
    const b = partialOutcome(at(3, '    b = xs[1] + 1', 'b'), BASE, [TESTS[1]!, TESTS[2]!]);
    const sameSiteAsA = partialOutcome(at(2, '    a = xs[0] + 2', 'a2'), BASE, [TESTS[3]!]);
    const overlapsB = partialOutcome(at(4, '    c = xs[2] + 1', 'c'), BASE, [TESTS[2]!]);
    holdBestPartial(mem, [a, b, sameSiteAsA, overlapsB], GOAL);
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
  it('carries both partials\' extra edits and skips pairs whose edits touch the same line', () => {
    const mem = createGuardMemory(BASE);
    const withExtra = partialOutcome(candidate(siteAt(FILE, 2), '    a = xs[0] + 1', { id: 'x', extraEdits: [{ path: 'prog.py', line: 5, kind: 'replace', text: '    d = xs[3] + 1' }] }), BASE, [TESTS[0]!]);
    const touchesLine5 = partialOutcome(at(5, '    d = xs[3] + 2', 'y'), BASE, [TESTS[1]!]);
    const clean = partialOutcome(at(3, '    b = xs[1] + 1', 'z'), BASE, [TESTS[2]!]);
    holdBestPartial(mem, [withExtra, touchesLine5, clean], GOAL);
    const ids = pairsOfPartials(mem, GOAL).map((p) => p.id);
    expect(ids).not.toContain('pair:x+y');
    expect(ids).toContain('pair:x+z');
    expect(ids).toContain('pair:y+z');
    const xz = pairsOfPartials(mem, GOAL).find((p) => p.id === 'pair:x+z')!;
    expect(xz.extraEdits?.map((e) => e.line)).toEqual([5, 3]);
  });
  it('only partials run on the committed base pair (same coordinates); other goals are ignored; ≤ 10 pairs', () => {
    const mem = createGuardMemory(BASE);
    const improved: Base = { ...BASE, id: 'imp', origin: 'improved', fromGoal: 'g1', depth: 1 };
    const onImproved = partialOutcome(at(2, '    a = xs[0] + 1', 'imp1'), improved, [TESTS[0]!]);
    const onCommitted = partialOutcome(at(3, '    b = xs[1] + 1', 'com1'), BASE, [TESTS[1]!]);
    holdBestPartial(mem, [onImproved, onCommitted], GOAL);
    expect(pairsOfPartials(mem, GOAL)).toEqual([]);
    expect(pairsOfPartials(mem, goal([failure('other()')], { id: 'g2' }))).toEqual([]);

    // six sites each fixing one distinct test → C(6,2) = 15 disjoint pairs, cut to 10
    const six = ['t1', 't2', 't3', 't4', 't5', 't6'];
    const wide = summary({ passed: 0, failing: six, failures: six.map((t) => failure(t)) });
    const wideBase = committedBase(FILE, wide);
    const wideGoal = goal(six.map((t) => failure(t)), { id: 'g3' });
    const mem2 = createGuardMemory(wideBase);
    const parts = six.map((t, i) => partialOutcome(at(2 + (i % 5), `    v${i} = ${i}`, `w${i}`), wideBase, [t]));
    holdBestPartial(mem2, parts, wideGoal);
    const pairs = pairsOfPartials(mem2, wideGoal);
    expect(pairs.length).toBe(MAX_PARTIAL_PAIRS);
    expect(new Set(pairs.map((p) => p.id)).size).toBe(MAX_PARTIAL_PAIRS);
  });
});

describe('appliedOnCommitted: every commit is a patch of the committed workspace', () => {
  it('a partial on the improved base becomes a depth-2 base whose candidate carries both edits; commitPartial proposes that', () => {
    const mem = createGuardMemory(BASE);
    const first = partialOutcome(at(2, '    a = xs[0] + 1', 'first'), BASE, [TESTS[0]!]);
    holdBestPartial(mem, [first], GOAL);
    const held1 = improvedBase(mem)!;
    expect(held1.candidate).toBe(first.applied);
    const fileOnHeld = held1.files.get('prog.py')!;
    const second = partialOutcome(candidate(siteAt(fileOnHeld, 3), '    b = xs[1] + 1', { id: 'second' }), held1, [TESTS[1]!, TESTS[2]!]);
    expect(second.applied.files[0]?.before).toBe(fileOnHeld.src);
    const r = holdBestPartial(mem, [second], GOAL);
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
    // the commit carries the base's summary as the evidence's `after` (search/proposal.ts commitEvidence): the base leaves the beam here
    const held = improvedBaseFor(mem, GOAL)!;
    const d = commitPartial(mem, GOAL);
    expect(d).toEqual({ kind: 'commit', applied: composed, allGoalTestsPass: false, note: 'partial', after: held.summary });
  });
  it('an outcome on the committed base is returned as is', () => {
    const mem = createGuardMemory(BASE);
    const p = partialOutcome(at(2, '    a = xs[0] + 1', 'p'), BASE, [TESTS[0]!]);
    expect(appliedOnCommitted(mem, p)).toBe(p.applied);
  });
});

describe('commitPartial and forgetGoal', () => {
  it('commits the held partial for the goal as note "partial" and removes it from the beam', () => {
    const mem = createGuardMemory(BASE);
    expect(commitPartial(mem, GOAL)).toBeNull();
    const p = partialOutcome(at(2, '    a = xs[0] + 1', 'held'), BASE, [TESTS[0]!]);
    holdBestPartial(mem, [p], GOAL);
    expect(improvedBaseFor(mem, GOAL)?.candidate).toBe(p.applied);
    expect(improvedBaseFor(mem, goal([failure('other()')], { id: 'g2' }))).toBeUndefined();
    expect(commitPartial(mem, goal([failure('other()')], { id: 'g2' }))).toBeNull();
    const held = improvedBaseFor(mem, GOAL)!;
    const d = commitPartial(mem, GOAL);
    expect(d).toEqual({ kind: 'commit', applied: p.applied, allGoalTestsPass: false, note: 'partial', after: held.summary });
    expect(mem.bases.map((b) => b.origin)).toEqual(['committed']);
    expect(commitPartial(mem, GOAL)).toBeNull();
  });
  it('forgetGoal drops the goal\'s partials and its improved base', () => {
    const mem = createGuardMemory(BASE);
    holdBestPartial(mem, [partialOutcome(at(2, '    a = xs[0] + 1', 'f1'), BASE, [TESTS[0]!])], GOAL);
    forgetGoal(mem, GOAL);
    expect(guardState(mem).partials).toEqual([]);
    expect(improvedBase(mem)).toBeUndefined();
  });
});

describe('partials across a park and a checkpoint (jev-only-ladder-4-analysis.md §1.2, the `account` partial trap)', () => {
  it('forgetHeld keeps the remembered partials (the held passers, fallbacks and the improved base go); freshPairsOfPartials lists the untested pairs', () => {
    const mem = { ...createGuardMemory(BASE), tried: new Set<string>() };
    const a = partialOutcome(at(2, '    a = xs[0] + 1', 'a'), BASE, [TESTS[0]!]);
    const b = partialOutcome(at(3, '    b = xs[1] + 1', 'b'), BASE, [TESTS[1]!]);
    holdBestPartial(mem, [a, b], GOAL);
    guardState(mem).suspect = { goalId: GOAL.id, outcome: a };
    expect(freshPairsOfPartials(mem, GOAL)).toHaveLength(1);
    forgetHeld(mem, GOAL);
    expect(guardState(mem).partials.map((p) => p.outcome.applied.candidate.id)).toEqual(['a', 'b']);
    expect(partialsOf(mem, GOAL)).toHaveLength(2);
    expect(guardState(mem).suspect).toBeNull();
    expect(improvedBase(mem)).toBeUndefined();
    // once the pair's diff was run it is no longer fresh; a commit forgets everything
    const pair = freshPairsOfPartials(mem, GOAL)[0]!;
    mem.tried.add(sha12(applyCandidate(pair, BASE.files).diff));
    expect(freshPairsOfPartials(mem, GOAL)).toEqual([]);
    forgetGoal(mem, GOAL);
    expect(guardState(mem).partials).toEqual([]);
  });

  it('persistPartials / restorePartials: ≤ 4 records per unfixed goal (most tests covered first), restored as committed-base partials whose pairs apply; stale, fixed or malformed records are dropped', () => {
    const mem = createGuardMemory(BASE);
    const outs = [
      partialOutcome(at(2, '    a = xs[0] + 1', 'p2'), BASE, [TESTS[0]!]),
      partialOutcome(at(3, '    b = xs[1] + 1', 'p3'), BASE, [TESTS[1]!, TESTS[2]!]),
      partialOutcome(at(4, '    c = xs[2] + 1', 'p4'), BASE, [TESTS[2]!]),
      partialOutcome(at(5, '    d = xs[3] + 1', 'p5'), BASE, [TESTS[3]!]),
      partialOutcome(at(6, '    return a + b + c + d + k + 1', 'p6'), BASE, [TESTS[3]!]),
    ];
    holdBestPartial(mem, outs, GOAL);
    const g2 = goal([failure('other()')], { id: 'g2' });
    holdBestPartial(mem, [partialOutcome(at(2, '    a = xs[0] + 2', 'q2'), BASE, [TESTS[0]!])], g2);
    // g2 is fixed: nothing of it is written; g1 keeps four of five, the two-test partial first, then the smaller edits by id
    const recs = persistPartials(mem, [GOAL, { id: 'g2', status: 'fixed' }]);
    expect(recs.map((r) => `${r.goalId}:${r.line}`)).toEqual([`${GOAL.id}:3`, `${GOAL.id}:2`, `${GOAL.id}:4`, `${GOAL.id}:5`]);
    expect(recs[0]).toMatchObject({ path: 'prog.py', line: 3, kind: 'replace', text: '    b = xs[1] + 1', newlyPassing: [TESTS[1], TESTS[2]], passed: 4, source: 'mutation' });
    expect(recs.every((r) => r.extraEdits === undefined)).toBe(true);
    // JSON round trip into a fresh memory over the same baseline: four committed-base partials, their pairs enumerable
    const state = JSON.parse(JSON.stringify({ version: 1, tried: [], partials: recs })) as Json;
    const fresh = createGuardMemory(BASE);
    expect(restorePartials(fresh, partialsFromPersisted(state), [GOAL])).toBe(4);
    expect(guardState(fresh).partials.every((p) => p.outcome.status === 'partial' && p.outcome.job.base === BASE && isPartial(p.outcome))).toBe(true);
    expect(guardState(fresh).partials.map((p) => p.outcome.progress.newlyPassing.length)).toEqual([2, 1, 1, 1]);
    expect(pairsOfPartials(fresh, GOAL).length).toBeGreaterThan(0);
    // restoring twice adds nothing (same diffs)
    expect(restorePartials(fresh, partialsFromPersisted(state), [GOAL])).toBe(0);
    // stale: the tests a record passed no longer fail (or it would now pass everything), or its goal is fixed
    const greener = committedBase(FILE, summary({ passed: 5, failing: [TESTS[3]!], failures: [failure(TESTS[3]!)] }));
    expect(restorePartials(createGuardMemory(greener), partialsFromPersisted(state), [GOAL])).toBe(0);
    expect(restorePartials(createGuardMemory(BASE), partialsFromPersisted(state), [{ id: GOAL.id, status: 'fixed' }])).toBe(0);
    // malformed records and older checkpoints carry none
    expect(partialsFromPersisted(null)).toEqual([]);
    expect(partialsFromPersisted({ version: 1, tried: [] })).toEqual([]);
    expect(partialsFromPersisted({ version: 1, tried: [], partials: [{ goalId: 'g1' }, 'junk', { ...recs[0], source: 'nope' }] })).toEqual([]);
  });
});

describe('pairsOfPartials never pairs beyond MAX_PATCH_FILES files (ladder `six_hunks` run 3: a pair of a pair was refused by proposePatch after the ledger recorded it)', () => {
  it('a pair whose halves together edit three files is skipped; two-file pairs are built', () => {
    const other = sourceFile('other.py', 'y = 1\n');
    const third = sourceFile('third.py', 'z = 1\n');
    const base = committedBase(FILE, BASELINE, [other, third]);
    const mem = createGuardMemory(base);
    const a = partialOutcome(candidate(siteAt(FILE, 2), '    a = xs[0] + 1', { id: 'a' }), base, [TESTS[0]!]);
    const b = partialOutcome(candidate(siteAt(FILE, 4), '    c = xs[2] + 1', { id: 'b', extraEdits: [{ path: 'other.py', line: 1, kind: 'replace', text: 'y = 2' }] }), base, [TESTS[1]!]);
    const c = partialOutcome(candidate(siteAt(FILE, 3), '    b = xs[1] + 1', { id: 'c', extraEdits: [{ path: 'third.py', line: 1, kind: 'replace', text: 'z = 2' }] }), base, [TESTS[2]!]);
    guardState(mem).partials.push({ goalId: GOAL.id, outcome: a }, { goalId: GOAL.id, outcome: b }, { goalId: GOAL.id, outcome: c });
    const pairs = pairsOfPartials(mem, GOAL);
    // a+b (prog.py, other.py) and a+c (prog.py, third.py) fit two files; b+c would touch three
    expect(pairs.map((p) => p.id).sort()).toEqual(['pair:a+b', 'pair:a+c']);
    for (const p of pairs) expect(new Set([p.site.file.path, ...(p.extraEdits ?? []).map((e) => e.path)]).size).toBeLessThanOrEqual(2);
  });
});

describe('the outcome behind the improved base (progress commits, jev-only-rungs-1-2.md §19.7)', () => {
  it('holdBestPartial records the outcome; heldPartialOutcome returns it for the goal (and falls back to the remembered partial of a base installed by hand); commitPartial with a verified run carries it as `after` and `outcome`', () => {
    const mem = createGuardMemory(BASE);
    const o = partialOutcome(at(2, '    a = xs[0] + 1', 'p1'), BASE, [TESTS[0]!, TESTS[1]!]);
    expect(heldPartialOutcome(mem, GOAL)).toBeNull();
    holdBestPartial(mem, [o], GOAL);
    expect(heldPartialOutcome(mem, GOAL)).toBe(o);
    expect(heldPartialOutcome(mem, { id: 'other' })).toBeNull();
    const full = summary({ passed: 4, failing: [TESTS[2]!, TESTS[3]!], total: 6 });
    const d = commitPartial(mem, GOAL, { outcome: o, after: full });
    expect(d).toMatchObject({ kind: 'commit', note: 'partial', allGoalTestsPass: false, after: full, outcome: o });
    expect(improvedBase(mem)).toBeUndefined();
    expect(heldPartialOutcome(mem, GOAL)).toBeNull();
    // a base pushed by hand (no holdBestPartial): the remembered partial carrying its candidate is the outcome
    const mem2 = createGuardMemory(BASE);
    const o2 = partialOutcome(at(3, '    b = xs[1] + 1', 'p2'), BASE, [TESTS[2]!]);
    guardState(mem2).partials.push({ goalId: GOAL.id, outcome: o2 });
    mem2.bases.push({ id: 'improved-by-hand', origin: 'improved', fromGoal: GOAL.id, files: BASE.files, summary: o2.subset, candidate: o2.applied, depth: 1 });
    expect(heldPartialOutcome(mem2, GOAL)).toBe(o2);
  });

  it('dropHeldPartial (a regression on the full suite): the base leaves the beam and the remembered partial goes with it, so no pair is built on it; forgetHeld clears the recorded outcome too', () => {
    const mem = createGuardMemory(BASE);
    const bad = partialOutcome(at(2, '    a = xs[0] + 1', 'bad'), BASE, [TESTS[0]!]);
    const good = partialOutcome(at(4, '    c = xs[2] + 1', 'good'), BASE, [TESTS[2]!]);
    holdBestPartial(mem, [bad, good], GOAL); // equal passed: the earlier one (bad) is the base, both remembered
    expect(heldPartialOutcome(mem, GOAL)).toBe(bad);
    expect(pairsOfPartials(mem, GOAL)).toHaveLength(1);
    dropHeldPartial(mem, GOAL);
    expect(improvedBase(mem)).toBeUndefined();
    expect(heldPartialOutcome(mem, GOAL)).toBeNull();
    expect(partialsOf(mem, GOAL).map((p) => p.applied.candidate.id)).toEqual(['good']);
    expect(pairsOfPartials(mem, GOAL)).toHaveLength(0);
    // forgetHeld (a park) drops the base and its recorded outcome, keeps the remembered partials
    holdBestPartial(mem, [good], GOAL);
    expect(heldPartialOutcome(mem, GOAL)).toBe(good);
    forgetHeld(mem, GOAL);
    expect(heldPartialOutcome(mem, GOAL)).toBeNull();
    expect(guardState(mem).improvedOutcome).toBeNull();
    expect(partialsOf(mem, GOAL)).toHaveLength(1);
  });
});
