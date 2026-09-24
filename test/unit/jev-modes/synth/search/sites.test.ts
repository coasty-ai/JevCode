/**
 * Site list construction (design §2.5) on a two-function single-file fixture: the real
 * localizer with a scripted Q5, a scripted Q5n, a fake SBFL ranking and per-test coverage.
 * Checks the union (never score-combined), the ordering (Jev evidence by p, then SBFL-only by
 * rank), `def` exclusion, insert gaps after and before the top-3 anchors, Q6 gaps, the trace-tail
 * gap, the 6 + 6 cut, insert-first routing, the Q5 escape capture and the WIDENED cursor.
 */
import { describe, expect, it } from 'vitest';
import type { Question } from '../../../../../src/core/types.js';
import { LINE_QUESTION_ID, createLocalizer } from '../../../../../src/jev-modes/synth/localize/index.js';
import type { LocalizeResult, Site } from '../../../../../src/jev-modes/synth/types.js';
import {
  GAP_FUNCTION_MAX_LINES,
  GAP_QUESTION,
  GAP_QUESTION_ID,
  IMPORT_GAP_NOTE,
  INSERT_SITES_MAX,
  LINE_NOUL_CRITERIA,
  Q5N_SHORT_CIRCUIT_P,
  Q5_ESCAPE_INSERT_FIRST,
  Q6_FALLBACK_STATEMENTS,
  REPLACE_SITES_MAX,
  WIDENED_SITES_MAX,
  buildGoalSites,
  captureLineChoiceEscape,
  functionGapSites,
  functionWeight,
  gapBatchRequest,
  gapRequest,
  importGapSite,
  insertSitesFirst,
  isImportGap,
  lineEvidenceOf,
  lineNoulRequest,
  loopExitGap,
  LOOP_EXIT_GAP_NOTE,
  nextWidenChunk,
  orderGapSlots,
  orderGoalSites,
  orderWidenedSites,
  q5Anchors,
  q6FallbackApplies,
  siteKey,
  topStatementTemplates,
  traceTailGap,
  widenedSites,
} from '../../../../../src/jev-modes/synth/search/sites.js';
import { HISTORY_SITES_MAX, INTROSPECTION_SITES_MAX, INTROSPECTION_SITE_NOTE, RAISING_GAP_NOTE, historySites, introspectionSites, isHistorySite, isIntrospectionSite, isRaisingGap, mergeIntrospectionSites, replaceSiteAt, statementSiteFor } from '../../../../../src/jev-modes/synth/search/sites.js';
import { CLASS_BODY_GAP_NOTE, isClassBodyGapSite } from '../../../../../src/jev-modes/synth/templates/introspect.js';
import { enumerateHistory, sameSpan } from '../../../../../src/jev-modes/synth/history/index.js';
import { applyCandidate } from '../../../../../src/jev-modes/synth/verify/apply.js';
import { COMPILER_PATH, HISTORY_LINE, RANKED_LINE, compilerFixture, compilerFixtureWithOlderFarCommit } from '../history/fixtures.js';
import { emptyIntrospection } from '../../../../../src/jev-modes/synth/introspect/index.js';
import type { IntrospectedNames } from '../../../../../src/jev-modes/synth/introspect/index.js';
import { functionGapSlots } from '../../../../../src/jev-modes/synth/localize/sites.js';
import { createTemplateSource } from '../../../../../src/jev-modes/synth/templates/index.js';
import { quixbugsProgram } from './helpers.js';
import type { GoalSiteContext, LineEvidence, SbflEvidence } from '../../../../../src/jev-modes/synth/search/sites.js';
import type { Goal } from '../../../../../src/jev-modes/synth/search/types.js';
import type { PerTestResult, RankedLine } from '../../../../../src/jev-modes/synth/sbfl/types.js';
import { ESCAPE_KEY, WRAP_FAILURE, answerAll, enumerateOptions, fixtureFile, goal, ladderTask, scriptedAsk, sf, signal, siteAt, stateObject } from './sites-composite.helpers.js';
import type { AskCall } from './sites-composite.helpers.js';

const file = fixtureFile('twofn.py');
const files = new Map([[file.path, file]]);
/** wrap: def 1, body 2–9; gcd: def 12, body 13–15 */
const WRAP = { file, name: 'wrap', startLine: 1, endLine: 9 };
const GCD = { file, name: 'gcd', startLine: 12, endLine: 15 };

function ranked(rows: readonly [line: number, score: number][]): RankedLine[] {
  return rows.map(([line, score], i) => ({ rank: i + 1, file: file.path, line, ef: 1, ep: 0, score, scores: { ochiai: score, tarantula: score, dstar: score } }));
}

/** The real localizer on the one-file workspace with a scripted Q5 answer (`line_<n>` masses). */
async function localizeWith(q5: Record<string, number>): Promise<{ result: LocalizeResult; escape: () => number | null }> {
  const { ask } = scriptedAsk((call) => answerAll(call, () => 0.05, (id) => (id === LINE_QUESTION_ID ? q5 : {})));
  const captured = captureLineChoiceEscape(ask);
  const result = await createLocalizer().localize({ ask: captured.ask, task: 'Fix wrap so the tests pass', files, failures: [WRAP_FAILURE], signal: signal(), budget: { maxRequests: 4 } });
  return { result, escape: captured.escape };
}

function ctxWith(script: (call: AskCall) => Record<string, import('../../../../../src/core/types.js').Answer>): { ctx: GoalSiteContext; calls: AskCall[] } {
  const { ask, calls } = scriptedAsk((call) => script(call));
  return { ctx: { ask, task: 'Fix wrap so the tests pass', signal: signal(), files }, calls };
}

const lines = (sites: readonly { line: number }[]): number[] => sites.map((s) => s.line);

describe('replace sites: Q5 ∪ Q5n ∪ SBFL, unioned and ordered', () => {
  // Q5: wrap L9 0.40, L8 0.25, L3 0.06, gcd L15 0.10, L13 0.04 (below the 0.05 floor); escape 0.15
  const Q5 = { line_9: 0.4, line_8: 0.25, line_15: 0.1, line_3: 0.06, line_13: 0.04, [ESCAPE_KEY]: 0.15 };
  // Q5n: L9 0.92 (the only line ≥ 0.9), L7 0.55, L15 0.5, the rest 0.05
  const Q5N: Record<string, number> = { line_9: 0.92, line_7: 0.55, line_15: 0.5 };
  // SBFL: L9, L8, the `def wrap` line (never a site), L2, L4, then L15
  const sbfl: SbflEvidence = { ranked: ranked([[9, 1], [8, 0.9], [1, 0.9], [2, 0.6], [4, 0.5], [15, 0.3]]) };

  it('reconstructs the Q5 top-3 with p ≥ 0.05, best first (L3 at 0.06 lies outside every anchor window, so the localizer never exposed it)', async () => {
    const { result } = await localizeWith(Q5);
    const anchors = q5Anchors(result);
    expect(lines(anchors)).toEqual([9, 8, 15]);
    expect(anchors.every((a) => a.kind === 'replace')).toBe(true);
  });

  it('unions the three lists, never combines scores, excludes def lines and cuts at 6', async () => {
    const { result } = await localizeWith(Q5);
    const { ctx, calls } = ctxWith((call) => answerAll(call, (id) => Q5N[id] ?? 0.05, () => ({})));
    const g = await buildGoalSites(ctx, goal(), result, sbfl);
    expect(g.requests).toBe(1); // the one Q5n request; Q5 was the localizer's
    // Q5n request: one Noul per code line of both beam functions (def lines never), criteria on each, measured wording naming each line's function
    const q5n = calls[0]!;
    expect(Object.keys(q5n.questions)).toEqual(['line_2', 'line_3', 'line_4', 'line_5', 'line_6', 'line_7', 'line_8', 'line_9', 'line_13', 'line_14', 'line_15']);
    const q = q5n.questions['line_9']!;
    expect(q.type).toBe('noul');
    expect(q.instructions).toBe('Is line `program.L9` the line that must change to fix the bug in `wrap`? Judge this line only; other lines are judged separately.');
    expect(q5n.questions['line_15']!.instructions).toContain('fix the bug in `gcd`');
    expect(q.criteria).toEqual(LINE_NOUL_CRITERIA);
    const state = stateObject(q5n);
    expect(Object.keys(state['program'] as Record<string, unknown>)).toContain('L9');
    expect(state).toHaveProperty('failing_test_run');
    expect(state).not.toHaveProperty('function'); // two functions listed

    // order: short-circuit L9; Jev evidence by p: L7 (0.55 Q5n), L15 (max(0.10, 0.50)), L8 (0.25); SBFL-only by rank: L2 (rank 4), L4 (rank 5)
    // (the SBFL top-5 editable rows are L9, L8, L2, L4, L15: the def line never counts, covered lines do)
    expect(lines(g.replace)).toEqual([9, 7, 15, 8, 2, 4]);
    expect(g.replace).toHaveLength(REPLACE_SITES_MAX);
    expect(g.shortCircuit?.line).toBe(9);
    expect(g.notes).toContain('q5n short-circuit on L9');
    // evidence is kept side by side, not combined
    const l15 = g.replace.find((s) => s.line === 15)!;
    expect(l15.evidence.jevProbability).toBeCloseTo(0.1, 6);
    expect(l15.evidence.notes.some((n) => n.startsWith('q5n noul 0.50'))).toBe(true);
    const l2 = g.replace.find((s) => s.line === 2)!;
    expect(l2.evidence.jevProbability).toBeUndefined();
    expect(l2.evidence).toMatchObject({ sbflRank: 4, sbflScore: 0.6 });
    // def lines never, whatever the spectrum says
    expect(lines(g.replace)).not.toContain(1);
    expect(lines(g.replace)).not.toContain(12);
    expect(g.replace.every((s) => s.kind === 'replace' && s.currentLine === file.mod.lines[s.line - 1])).toBe(true);
    expect(g.lineNouls.get('twofn.py:9')).toBeCloseTo(0.92, 6);
  });

  it('insert gaps after and before each of the top-3 anchors, cut at 6, visited after their anchor', async () => {
    const { result } = await localizeWith(Q5);
    const { ctx } = ctxWith((call) => answerAll(call, (id) => Q5N[id] ?? 0.05, () => ({})));
    const g = await buildGoalSites(ctx, goal(), result, sbfl);
    // anchors by Q5 p: L9, L8, L15 → after L9 = gap at 10, before L9 = gap at 9, after L8 = 9, before L8 = 8, after L15 = 16, before L15 = 15;
    // then wrap's remaining gap slots by neighbour probability and control flow: the gap after L6 (before L7, Q5n 0.55 on L7,
    // the block end of `if end == -1:`) is the one the 6-cut keeps; the gaps before L9 / L8 are the anchors' already
    expect(g.insert.map((s) => [s.line, s.kind])).toEqual([
      [10, 'insert'],
      [9, 'insert'],
      [8, 'insert'],
      [16, 'insert'],
      [15, 'insert'],
      [7, 'insert'],
    ]);
    expect(g.insert[5]!.indent).toBe('        ');
    expect(g.insert[5]!.evidence.notes).toEqual(['gap after L6 (block_end, dedent 1)', 'in wrap']);
    expect(g.notes).toContain('8 gap slots of wrap');
    expect(g.insert.length).toBeLessThanOrEqual(INSERT_SITES_MAX);
    const after9 = g.insert[0]!;
    expect(after9.indent).toBe('    ');
    expect(after9.evidence.notes).toContain('insert after anchor L9');
    expect(after9.evidence.jevProbability).toBeCloseTo(0.4, 6);
    expect(after9.block).toEqual({ name: 'wrap', startLine: 1, endLine: 9 });
    // the gap after L9 (`return lines`) is also the gap before L8's successor: one key, the first anchor owns it
    expect(g.insertAnchors.get(siteKey(after9))).toBe(siteKey(g.replace[0]!));
    // visiting order: replace site, then its gaps; Jev-only lines without gaps; remaining gaps last
    expect(g.insertFirst).toBe(false);
    expect(g.ordered.map((s) => `${s.line}${s.kind === 'insert' ? 'i' : 'r'}`)).toEqual(['9r', '10i', '9i', '7r', '15r', '16i', '15i', '8r', '8i', '2r', '4r', '7i']);
  });

  /**
   * OOS iteration 3, item 4 — the third and deepest `--jev off` hole, and the one that survived
   * iteration 2's localiser fallback and this iteration's wider escaped code order.
   *
   * `jevProbability` is ABSENT on an anchor the code order produced (localize/index.ts sets it
   * only on a Jev anchor, on purpose: "these anchors carry no Jev evidence and say so"). The
   * `p ≥ Q5_ANCHOR_MIN_P` filter then dropped every one of them, so with every Choice escaped the
   * goal's site list had NO REPLACE SITE AT ALL. The recorded `--jev off` `kth` run
   * (`20260922-155658-35hfmbqm`) is exactly that: nine sites, every one an insert gap
   * (`kth.py:2 (gap), kth.py:10 (gap), kth.py:12 (gap), kth.py:15 (gap), +5 more`), `plausible 0`
   * on every step, `replan_stop` at 11 — while the gold REPLACES L12. `p ≥ 0.05` is a filter on a
   * FLAT answer ("below 0.05 a line is noise"); it cannot also mean "no answer at all".
   */
  it('a localisation with NO Jev probability anywhere still yields replace sites: the code order is the fallback, not the empty list', async () => {
    const { result } = await localizeWith({ [ESCAPE_KEY]: 1 });
    // the localiser answered in code: every anchor says so and none carries a probability
    const replaceSites = result.sites.filter((s) => s.kind === 'replace');
    expect(replaceSites.length).toBeGreaterThan(0);
    expect(replaceSites.every((s) => s.evidence.jevProbability === undefined)).toBe(true);
    const anchors = q5Anchors(result);
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.every((a) => a.kind === 'replace')).toBe(true);
    // `def` lines are still never anchors, and the whole located function is offered rather than
    // a top-3 of an order nothing ranked
    expect(anchors.some((a) => a.line === 1)).toBe(false);
    expect(anchors.length).toBeGreaterThan(3);
    // and the goal's site list has them, so the search has something to replace
    const { ctx } = ctxWith((call) => answerAll(call, () => 0.05, () => ({})));
    const g = await buildGoalSites(ctx, goal(), result, undefined, {});
    expect(g.replace.length).toBeGreaterThan(0);
    expect(g.ordered.some((s) => s.kind === 'replace')).toBe(true);
  });

  it('a Jev that DID answer keeps the top-3-per-function cut: the fallback is the no-answer case only', async () => {
    const { result } = await localizeWith(Q5);
    expect(lines(q5Anchors(result))).toEqual([9, 8, 15]);
  });

  /**
   * Review finding 5. `evidenced` was a GLOBAL predicate over the whole localisation, so the
   * fallback died the moment ANY one Choice answered — which is the normal Jev-on case, one
   * function ranked and another escaped or unasked. The review's probe: a two-file localisation
   * with `a.py:3` answered 0.8 and `b.py` fully escaped returned ONE anchor (`a.py:3`), dropping
   * b.py's five code-order replace sites. It is now decided per function group.
   */
  it('a MIXED localisation keeps the escaped group`s code order and still cuts the answered group to its top-3', () => {
    const a = fixtureFile('twofn.py');
    const b = sf('other.py', ['def fb(x):', '    y = x + 1', '    z = y + 2', '    w = z + 3', '    return w', ''].join('\n'));
    const replaceAt = (file: typeof a, line: number, p?: number): Site => {
      const site = siteAt(file, line);
      return p === undefined ? site : { ...site, evidence: { ...site.evidence, jevProbability: p } };
    };
    // a.py: one answered line plus two more the Choice ranked; b.py: five code-order lines, no probability
    const localized: LocalizeResult = {
      files: [{ path: a.path, probability: 1 }, { path: b.path, probability: 1 }],
      functions: [],
      requests: 1,
      sites: [replaceAt(a, 3, 0.8), replaceAt(a, 4, 0.2), replaceAt(a, 5, 0.1), replaceAt(a, 6, 0.01), replaceAt(b, 2), replaceAt(b, 3), replaceAt(b, 4), replaceAt(b, 5)],
    };
    const anchors = q5Anchors(localized);
    // b.py's four code-order sites all survive — they did before this fix only when a.py escaped too
    expect(anchors.filter((x) => x.file.path === 'other.py').map((x) => x.line)).toEqual([2, 3, 4, 5]);
    // and a.py, which DID get an answer, keeps its measured top-3 and drops the 0.01 noise line
    expect(anchors.filter((x) => x.file.path === a.path).map((x) => x.line)).toEqual([3, 4, 5]);
  });

  it('insert sites come first when Q5 put ≥ 0.3 on none_of_these or Q7 puts ≥ 0.5 on insert_new_line', async () => {
    const { result, escape } = await localizeWith({ line_9: 0.3, line_8: 0.2, [ESCAPE_KEY]: 0.35 });
    expect(escape()).toBeCloseTo(0.35, 6);
    expect(escape()!).toBeGreaterThanOrEqual(Q5_ESCAPE_INSERT_FIRST);
    const { ctx } = ctxWith((call) => answerAll(call, () => 0.05, () => ({})));
    const g = await buildGoalSites(ctx, goal(), result, sbfl, { q5EscapeProbability: escape() ?? 0 });
    expect(g.insertFirst).toBe(true);
    expect(g.ordered.slice(0, g.insert.length).every((s) => s.kind === 'insert')).toBe(true);
    // the controller re-orders after Q7 without rebuilding
    expect(orderGoalSites(g, false)[0]!.kind).toBe('replace');
    expect(insertSitesFirst(0.1, 0.6)).toBe(true);
    expect(insertSitesFirst(0.29, 0.49)).toBe(false);
  });

  it('single-file only: on a repository no Q5n request is made and SBFL takes three', async () => {
    const { result } = await localizeWith(Q5);
    const other = fixtureFile('twofn.py', 'other.py');
    const twoFiles = new Map([[file.path, file], [other.path, other]]);
    const { ctx, calls } = ctxWith((call) => answerAll(call, () => 0.05, () => ({})));
    const g = await buildGoalSites({ ...ctx, files: twoFiles }, goal(), result, { ranked: ranked([[9, 1], [2, 0.9], [4, 0.8], [5, 0.7], [6, 0.6]]) });
    expect(calls).toHaveLength(0);
    expect(g.requests).toBe(0);
    // SBFL top-3 rows: L9 (already an anchor), L2, L4; L5 and L6 are beyond the repo cut
    expect(lines(g.replace)).toEqual([9, 8, 15, 2, 4]);
  });
});

describe('module-level import gap from goal.missingNames (ladder tagcloud: NameError on `Counter`)', () => {
  const tagcloud = ladderTask('tagcloud', ['src/tagcloud.py']).files.get('src/tagcloud.py')!;
  const init = sf('src/__init__.py', '');
  const twoFiles = new Map([[tagcloud.path, tagcloud], [init.path, init]]);
  const TOP_TAGS = 'tests/test_tagcloud.py::test_top_tags';
  const nameError = { testId: TOP_TAGS, call: TOP_TAGS, expected: '', actual: "NameError: name 'Counter' is not defined" };
  // the traceback's innermost frame: L28 `counts: Counter = Counter()` in tag_counts (def 26, body 28–31)
  const anchor = { ...siteAt(tagcloud, 28), evidence: { jevProbability: 0.6, notes: ['q5 top-1'] } };
  const localized: LocalizeResult = { files: [{ path: tagcloud.path, probability: 1 }], functions: [{ file: tagcloud, name: 'tag_counts', startLine: 26, endLine: 31, probability: 0.8 }], sites: [anchor], requests: 0 };
  const tagcloudGoal = (over: Partial<Goal> = {}): Goal => goal({ tests: [TOP_TAGS], failures: [nameError], suspectedFiles: ['src/tagcloud.py', 'src/__init__.py'], missingNames: ['Counter'], ...over });
  const ctxOf = (): { ctx: GoalSiteContext; calls: AskCall[] } => {
    const { ask, calls } = scriptedAsk((call) => answerAll(call, () => 0.05, () => ({})));
    return { ctx: { ask, task: 'Some tests fail with a NameError coming from src/tagcloud.py.', signal: signal(), files: twoFiles }, calls };
  };

  it('importGapSite: the gap before the first non-import line after the last top-level import, module indentation, no block; null when the file binds the name', () => {
    const site = importGapSite(tagcloud, ['Counter'])!;
    expect(site).toMatchObject({ line: 8, kind: 'insert', currentLine: '', indent: '', block: null });
    expect(tagcloud.mod.lines[6]).toBe('from typing import Dict, Iterable, List, Tuple');
    expect(site.scope.line).toBe(8);
    expect(site.evidence.notes).toEqual([`${IMPORT_GAP_NOTE} for Counter`]);
    expect(isImportGap(site)).toBe(true);
    // `Post` is defined in the file, `combinations` imported: neither is missing here; unknown names are not mentioned
    expect(importGapSite(tagcloud, ['Post'])).toBeNull();
    expect(importGapSite(tagcloud, ['combinations'])).toBeNull();
    expect(importGapSite(tagcloud, ['nothing', 'Counter'])?.evidence.notes).toEqual([`${IMPORT_GAP_NOTE} for Counter`]);
    // an empty module uses nothing
    expect(importGapSite(init, ['Counter'])).toBeNull();
    // a module without imports or docstring: line 1
    expect(importGapSite(sf('m.py', 'def f():\n    return slugify("a")\n'), ['slugify'])?.line).toBe(1);
    expect(isImportGap(anchor)).toBe(false);
  });

  it('buildGoalSites adds the gap once per suspected file that uses the name unbound, visited before every other site, no Jev request', async () => {
    const { ctx, calls } = ctxOf();
    const g = await buildGoalSites(ctx, tagcloudGoal(), localized);
    expect(calls).toHaveLength(0); // two files: no Q5n; the gap costs nothing
    const gaps = g.insert.filter(isImportGap);
    expect(gaps).toHaveLength(1); // src/__init__.py does not use Counter
    expect(gaps[0]).toMatchObject({ file: tagcloud, line: 8, kind: 'insert', indent: '', block: null });
    expect(g.insert[0]).toBe(gaps[0]);
    expect(g.ordered[0]).toBe(gaps[0]);
    expect(g.notes).toContain('import gap src/tagcloud.py:8 for Counter');
    // the anchor's own gaps still follow it; tag_counts' other two gap slots (after the def line, after the `for` header) come last
    expect(g.ordered.map((s) => `${s.line}${s.kind === 'insert' ? 'i' : 'r'}`)).toEqual(['8i', '28r', '29i', '28i', '30i', '31i']);
    expect(g.insertAnchors.has(siteKey(gaps[0]!))).toBe(false);
    // the gap stays first whichever way Q7 later re-orders, and survives the insert cut
    expect(orderGoalSites(g, true)[0]).toBe(gaps[0]);
    expect(orderGoalSites(g, false)[0]).toBe(gaps[0]);
    const cut = await buildGoalSites(ctxOf().ctx, tagcloudGoal(), localized, undefined, { maxInsertSites: 1 });
    expect(cut.insert).toEqual([gaps[0]]);
  });

  it('no missingNames, no import gap; a name the file already binds adds none either', async () => {
    const plain = await buildGoalSites(ctxOf().ctx, tagcloudGoal({ missingNames: [] }), localized);
    expect(plain.insert.some(isImportGap)).toBe(false);
    expect(plain.ordered[0]?.kind).toBe('replace');
    const bound = await buildGoalSites(ctxOf().ctx, tagcloudGoal({ missingNames: ['Post'] }), localized);
    expect(bound.insert.some(isImportGap)).toBe(false);
    // a beam function's file counts even when the goal suspects no file
    const viaBeam = await buildGoalSites(ctxOf().ctx, tagcloudGoal({ suspectedFiles: [] }), localized);
    expect(viaBeam.ordered[0]).toMatchObject({ line: 8, kind: 'insert', block: null });
  });
});

describe('Q6 gaps and the trace-tail gap', () => {
  // anchors L8, L3 (wrap) and L15 (gcd): gaps 9/8, 4/3, 16/15
  const Q5 = { line_8: 0.4, line_3: 0.3, line_15: 0.2 };
  const perTest: PerTestResult[] = [
    // the failing test runs the loop but never reaches `end = cols` (L6): the fix is a statement after the last executed line
    { id: 'wrap[1]', outcome: 'fail', lines: { 'twofn.py': [1, 2, 3, 4, 5, 7, 8, 9] }, exception: null, durationMs: 3 },
    { id: 'wrap[2]', outcome: 'pass', lines: { 'twofn.py': [1, 2, 3, 4, 5, 6, 7, 8, 9] }, exception: null, durationMs: 3 },
  ];

  it('asks Q6 per known statement with the measured wording and adds its top-3 gaps; the tail gap follows', async () => {
    const { result } = await localizeWith(Q5);
    const { ctx, calls } = ctxWith((call) =>
      answerAll(
        call,
        () => 0.05,
        (id) => (id === GAP_QUESTION_ID ? { after_l2: 0.6, after_l7: 0.3, before_l1: 0.1 } : {}),
      ),
    );
    const g = await buildGoalSites(ctx, goal(), result, { ranked: [], perTest }, { missingStatements: ['lines.append(text)', ''], maxInsertSites: 10 });
    // one Q5n request (single file) + one Q6 request
    expect(g.requests).toBe(2);
    const q6 = calls.find((c) => GAP_QUESTION_ID in c.questions)!;
    const q = q6.questions[GAP_QUESTION_ID]!;
    expect(q.type).toBe('choice');
    expect(q.instructions).toBe(GAP_QUESTION);
    const state = stateObject(q6);
    expect(state['missing_statement']).toBe('lines.append(text)');
    expect(state['task']).toContain('`missing_statement` is the statement to insert');
    // options: before the first line, then after every code line of wrap (the def line included: a gap after it is the first body line)
    const keys = Object.keys((q as Extract<Question, { type: 'choice' }>).criteria);
    expect(keys).toEqual(['before_l1', 'after_l1', 'after_l2', 'after_l3', 'after_l4', 'after_l5', 'after_l6', 'after_l7', 'after_l8', 'after_l9', ESCAPE_KEY]);
    expect((q as Extract<Question, { type: 'choice' }>).criteria['after_l8']).toBe('insert directly after L8: lines.append(line)');

    // anchors' gaps: 9, 8, 4, 3, 16, 15; Q6: after L2 → 3 (dup), after L7 → 8 (dup), before L1 → 1 (new); trace tail: after L9 → 10 (new);
    // then wrap's gap slots not yet present, by neighbour probability (all 0.05 here) and control flow: after the def line (2) and after `if end == -1:` (6) fit the 10-cut
    expect(lines(g.insert)).toEqual([9, 8, 4, 3, 16, 15, 1, 10, 2, 6]);
    const q6Site = g.insert.find((s) => s.line === 1)!;
    expect(q6Site.evidence.jevProbability).toBeCloseTo(0.1, 6);
    expect(q6Site.evidence.notes[0]).toMatch(/^q6 before_l1 p=0\.10 for `lines\.append\(text\)`/);
    expect(q6Site.indent).toBe('');
    // a gap before the `def` line lies outside the function: module-level block and scope
    expect(q6Site.block).toBeNull();
    const tail = g.insert.find((s) => s.line === 10)!;
    expect(tail.evidence.notes).toEqual(['after last executed line L9 of failing test wrap[1]', '1 statements of wrap never reached']);
    expect(tail.indent).toBe('    ');
    // Q6 gaps, the tail gap and the slot gaps have no anchor: they are visited after every anchored site
    expect(g.ordered.slice(-4).map((s) => s.line)).toEqual([1, 10, 2, 6]);
  });

  it('skips Q6 when the function has ≤ 6 gaps and reports why', async () => {
    const { result } = await localizeWith({ line_15: 0.6, line_13: 0.2 });
    const { ctx, calls } = ctxWith((call) => answerAll(call, () => 0.05, () => ({})));
    const g = await buildGoalSites(ctx, goal({ tests: ['gcd[1]'] }), result, undefined, { missingStatements: ['return a'] });
    // gcd has 4 code lines → 5 gaps: no Q6; the Q5n request is the only one
    expect(calls.filter((c) => GAP_QUESTION_ID in c.questions)).toHaveLength(0);
    expect(g.notes).toContain('q6 skipped: 5 gaps ≤ 6');
  });

  it('traceTailGap: null without unreached statements or without the goal’s failing test', () => {
    const allRun: PerTestResult[] = [{ id: 'wrap[1]', outcome: 'fail', lines: { 'twofn.py': [1, 2, 3, 4, 5, 6, 7, 8, 9] }, exception: null, durationMs: 1 }];
    expect(traceTailGap(WRAP, goal(), allRun)).toBeNull();
    expect(traceTailGap(WRAP, goal({ tests: ['other'] }), perTest)).toBeNull();
    const site = traceTailGap(WRAP, goal(), perTest)!;
    expect(site).toMatchObject({ line: 10, kind: 'insert', indent: '    ' });
    // the multi-line-aware gap: after the statement that starts at the last executed line
    expect(traceTailGap(GCD, goal({ tests: ['gcd[1]'] }), [{ id: 'gcd[1]', outcome: 'error', lines: { 'twofn.py': [12, 13, 15] }, exception: null, durationMs: 1 }])?.line).toBe(16);
  });
});

describe('question builders', () => {
  it('lineNoulRequest keys lines by their original numbers and shows the failing run', () => {
    const req = lineNoulRequest({ task: 'fix it', failures: [WRAP_FAILURE], functionName: 'wrap', lines: [{ line: 8, text: '        lines.append(line)' }, { line: 9, text: '    return lines' }] });
    expect(Object.keys(req.questions)).toEqual(['line_8', 'line_9']);
    const s = req.state as Record<string, unknown>;
    expect(s['program']).toEqual({ L8: '        lines.append(line)', L9: '    return lines' });
    expect(s['function']).toBe('wrap');
    expect(s['tests']).toEqual([{ call: WRAP_FAILURE.call, expected: WRAP_FAILURE.expected }]);
    expect(s['failing_test_run']).toEqual({ call: WRAP_FAILURE.call, expected: WRAP_FAILURE.expected, actual: WRAP_FAILURE.actual });
    expect(Q5N_SHORT_CIRCUIT_P).toBe(0.9);
  });

  it('gapRequest describes every gap and appends the escape automatically', () => {
    const req = gapRequest({ task: 'fix it', failures: [WRAP_FAILURE], functionName: 'wrap', lines: [{ line: 1, text: 'def wrap(text, cols):' }, { line: 2, text: '    lines = []' }], missingStatement: '  lines.append(text)  ' });
    const q = req.questions[GAP_QUESTION_ID] as Extract<Question, { type: 'choice' }>;
    expect(q.criteria).toEqual({
      before_l1: 'insert as the new first line, before L1: def wrap(text, cols):',
      after_l1: 'insert directly after L1: def wrap(text, cols):',
      after_l2: 'insert directly after L2: lines = []',
      [ESCAPE_KEY]: null,
    });
    expect((req.state as Record<string, unknown>)['missing_statement']).toBe('lines.append(text)');
  });

  it('captureLineChoiceEscape records only the line Choice and passes the answer through', async () => {
    const { ask } = scriptedAsk((call) => answerAll(call, () => 0.2, (id) => (id === LINE_QUESTION_ID ? { [ESCAPE_KEY]: 0.42 } : {})));
    const c = captureLineChoiceEscape(ask);
    expect(c.escape()).toBeNull();
    await c.ask('propose', {}, { other: { type: 'noul', instructions: 'x' } });
    expect(c.escape()).toBeNull();
    const r = await c.ask('propose', {}, { [LINE_QUESTION_ID]: { type: 'choice', instructions: 'q', criteria: { line_1: null, line_2: null, [ESCAPE_KEY]: null } } });
    expect(r.answers[LINE_QUESTION_ID]?.type).toBe('choice');
    expect(c.escape()).toBeCloseTo(0.42, 6);
  });

  it('captureLineChoiceEscape keeps the maximum over several line Choices, whatever order they resolve in', async () => {
    const escapes = [0.1, 0.5, 0.2];
    let n = 0;
    const { ask } = scriptedAsk((call) => answerAll(call, () => 0.2, (id) => (id === LINE_QUESTION_ID ? { [ESCAPE_KEY]: escapes[n++]! } : {})));
    const c = captureLineChoiceEscape(ask);
    const q = { [LINE_QUESTION_ID]: { type: 'choice' as const, instructions: 'q', criteria: { line_1: null, line_2: null, [ESCAPE_KEY]: null } } };
    await Promise.all([c.ask('propose', {}, q), c.ask('propose', {}, q), c.ask('propose', {}, q)]);
    expect(c.escape()).toBeCloseTo(0.5, 6);
  });
});

describe('WIDENED: every code line of the beam functions, cursor-carried across steps', () => {
  const tag = (s: { line: number; kind: string; indent: string }): string => `${s.line}${s.kind === 'insert' ? `i@${s.indent.length}` : 'r'}`;

  it('enumerates all code lines except def lines plus every gap slot, in beam order and line order (the gap before a line ahead of the line), and hands out chunks', () => {
    const all = widenedSites([WRAP, GCD]);
    // wrap: 8 code lines and 8 gap slots (none after the trailing `return lines`); gcd: 3 code lines and 3 slots
    expect(all.map(tag)).toEqual(['2i@4', '2r', '3i@4', '3r', '4i@8', '4r', '5i@8', '5r', '6i@12', '6r', '7i@8', '7r', '8i@8', '8r', '9i@4', '9r', '13i@4', '13r', '14i@8', '14r', '15i@4', '15r']);
    expect(all.every((s) => s.evidence.notes.some((n) => n.startsWith('widened over')))).toBe(true);
    expect(all.filter((s) => s.kind === 'replace').map((s) => s.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 13, 14, 15]);
    expect(all[17]!.evidence.notes).toEqual(['widened over gcd (beam #2)']);
    expect(all[16]!.evidence.notes).toEqual(['gap after L12 (after_header)', 'in gcd', 'widened over gcd (beam #2)']);
    expect(all[0]!.block).toEqual({ name: 'wrap', startLine: 1, endLine: 9 });
    // the block-end slot after `lines.append(line)` (L8) sits one level out, where `lines.append(text)` belongs; after `return a` (L14, terminal) only the enclosing level is legal
    expect(all.find((s) => s.line === 9 && s.kind === 'insert')!.indent).toBe('    ');
    expect(all.find((s) => s.line === 15 && s.kind === 'insert')!.indent).toBe('    ');
    // step 1 takes four, step 2 the next four, ... the last chunk reports done
    const c1 = nextWidenChunk(all, 0, 4);
    expect(c1.sites.map(tag)).toEqual(['2i@4', '2r', '3i@4', '3r']);
    expect(c1).toMatchObject({ cursor: 4, done: false });
    const c2 = nextWidenChunk(all, c1.cursor, 4);
    expect(c2.sites.map(tag)).toEqual(['4i@8', '4r', '5i@8', '5r']);
    const last = nextWidenChunk(all, 20, 4);
    expect(last.sites.map(tag)).toEqual(['15i@4', '15r']);
    expect(last).toMatchObject({ cursor: 22, done: true });
    expect(nextWidenChunk(all, last.cursor, 4)).toEqual({ sites: [], cursor: 22, done: true });
    // a non-positive size takes everything that is left; an overshooting cursor is clamped
    expect(nextWidenChunk(all, 19, 0).sites).toHaveLength(3);
    expect(nextWidenChunk(all, 99, 4)).toEqual({ sites: [], cursor: 22, done: true });
  });

  it('excludes the sites the SEEDS phase already searched, gaps included', () => {
    const seeds = new Set([siteKey({ file, line: 9, kind: 'replace' }), siteKey({ file, line: 8, kind: 'replace' }), siteKey({ file, line: 9, kind: 'insert' })]);
    expect(widenedSites([WRAP], seeds).map(tag)).toEqual(['2i@4', '2r', '3i@4', '3r', '4i@8', '4r', '5i@8', '5r', '6i@12', '6r', '7i@8', '7r', '8i@8']);
  });

  it('a function longer than GAP_FUNCTION_MAX_LINES gets its code lines only', () => {
    const body = Array.from({ length: GAP_FUNCTION_MAX_LINES }, (_, i) => `    x = ${i}`).join('\n');
    const long = sf('long.py', `def long(x):\n${body}\n    return x\n`);
    const fn = { file: long, name: 'long', startLine: 1, endLine: GAP_FUNCTION_MAX_LINES + 2 };
    expect(functionGapSites(fn)).toEqual([]);
    expect(widenedSites([fn]).every((s) => s.kind === 'replace')).toBe(true);
    const short = { ...fn, endLine: GAP_FUNCTION_MAX_LINES };
    expect(functionGapSites(short).length).toBeGreaterThan(0);
  });

  it("orderWidenedSites: line evidence first (a gap scores its better neighbour), then distance from the top-1 line, cut at WIDENED_SITES_MAX — wrap's gap before `return lines` is second once the SEEDS sites are excluded", () => {
    // the Nouls of the live wrap runs (jev-only-rungs-1-2.md §13.4): L7 0.61–0.67, L4 0.36, L6 and `return lines` 0.16–0.21 (L9 of this fixture, which has no blank line before it)
    const nouls: Record<number, number> = { 7: 0.61, 4: 0.36, 6: 0.21, 9: 0.21 };
    const evidence: LineEvidence = (_f, line) => nouls[line] ?? 0;
    const top = { file, line: 7 };
    const all = widenedSites([WRAP]);
    expect(orderWidenedSites(all, evidence, top).map(tag)).toEqual(['7i@8', '7r', '8i@8', '5i@8', '4i@8', '4r', '6i@12', '6r', '9i@4', '9r', '8r', '5r', '3i@4', '3r', '2i@4', '2r']);
    expect(orderWidenedSites(all, evidence, top, 4).map(tag)).toEqual(['7i@8', '7r', '8i@8', '5i@8']);
    expect(WIDENED_SITES_MAX).toBe(24);
    // the live SEEDS list (replace L3–L8, the gaps around L7, L4 and L5 at indent 8) excluded: the gold gap is second, right after L6's inner gap
    const seeds = new Set([...[3, 4, 5, 6, 7, 8].map((l) => siteKey({ file, line: l, kind: 'replace' })), ...[4, 5, 7, 8].map((l) => siteKey({ file, line: l, kind: 'insert' }))]);
    expect(orderWidenedSites(widenedSites([WRAP], seeds), evidence, top).map(tag)).toEqual(['6i@12', '9i@4', '9r', '3i@4', '2i@4', '2r']);
    // without evidence or a top line the line order stands
    expect(orderWidenedSites(all, () => 0, null).map(tag)).toEqual(all.map(tag));
  });

  it("loopExitGap: the block-end slot at the loop's indent for a line inside (or heading) the loop, none outside a loop; buildGoalSites makes it the anchor's third gap, inside the 6-cut", async () => {
    // wrap: L4–L8 are the while body, L3 its header: all exit into the slot before `return lines` (L9 here, indent 4); gcd has no loop
    for (const line of [3, 4, 6, 7, 8]) expect(loopExitGap(file, line, WRAP)).toMatchObject({ line: 9, indent: '    ', position: 'block_end', dedent: 1, afterLine: 8 });
    expect(loopExitGap(file, 2, WRAP)).toBeNull();
    expect(loopExitGap(file, 9, WRAP)).toBeNull();
    expect(loopExitGap(file, 14, GCD)).toBeNull();
    // the shipped program: the blank line before `return lines` carries the dedented slot (L9, indent 4), the gold's position
    const shipped = sf('wrap.py', quixbugsProgram('wrap'));
    expect(loopExitGap(shipped, 7, { startLine: 1, endLine: 10 })).toMatchObject({ line: 9, indent: '    ', afterLine: 8 });
    // nested loops exit into the innermost: shunting_yard's inner `while` body exits one level out of it, not out of the `for`
    const sy = sf('shunting_yard.py', quixbugsProgram('shunting_yard'));
    const inner = loopExitGap(sy, 17, { startLine: 1, endLine: sy.mod.lines.length });
    expect(inner).not.toBeNull();
    expect(inner?.indent.length).toBe(12);
    // the live wrap localisation (Q5 mass on L7, then L4 and L3): the exit gap is L7's third gap and makes the cut
    const { result } = await localizeWith({ line_7: 0.6, line_4: 0.2, line_3: 0.1, [ESCAPE_KEY]: 0.1 });
    const { ctx } = ctxWith((call) => answerAll(call, () => 0.05, () => ({})));
    const g = await buildGoalSites(ctx, goal(), result);
    const exit = g.insert.find((s) => s.line === 9 && s.indent === '    ');
    expect(exit).toBeDefined();
    expect(exit?.evidence.notes[0]).toBe(`${LOOP_EXIT_GAP_NOTE} L7`);
    expect(g.insertAnchors.get(siteKey(exit!))).toBe(siteKey({ file, line: 7, kind: 'replace' }));
    expect(g.insert.length).toBeLessThanOrEqual(INSERT_SITES_MAX);
    // visited right after L7's own two gaps: site 4 of the ordered list
    expect(g.ordered.slice(0, 4).map((s) => `${s.line}${s.kind === 'insert' ? `i@${s.indent.length}` : 'r'}`)).toEqual(['7r', '8i@8', '7i@8', '9i@4']);
  });

  it("lineEvidenceOf: the Q5 p and Q5n Nouls behind a buildGoalSites list travel with its `ordered` array; a copy falls back to the replace sites' jevProbability", async () => {
    const { result } = await localizeWith({ line_9: 0.4, line_8: 0.25, line_15: 0.1, line_3: 0.06, line_13: 0.04, [ESCAPE_KEY]: 0.15 });
    const q5n: Record<string, number> = { line_9: 0.92, line_7: 0.55, line_15: 0.5 };
    const { ctx } = ctxWith((call) => answerAll(call, (id) => q5n[id] ?? 0.05, () => ({})));
    const g = await buildGoalSites(ctx, goal(), result);
    const p = lineEvidenceOf(g.ordered);
    expect(p(file, 9)).toBeCloseTo(0.92, 6); // max(Q5 0.40, Q5n 0.92)
    expect(p(file, 7)).toBeCloseTo(0.55, 6); // Q5n only
    expect(p(file, 15)).toBeCloseTo(0.5, 6); // max(Q5 0.10, Q5n 0.50)
    expect(p(file, 2)).toBeCloseTo(0.05, 6); // every judged line carries its Noul
    expect(p(file, 1)).toBe(0); // the def line is never judged
    const copy = lineEvidenceOf([...g.ordered]);
    expect(copy(file, 15)).toBeCloseTo(0.1, 6); // the Q5 p the site's evidence carries
    expect(copy(file, 7)).toBe(0); // a Q5n-only site has no jevProbability
  });
});

// ---------------------------------------------------------------------------------------
// Gap slots at every statement boundary: the four QuixBugs insertion bugs
// ---------------------------------------------------------------------------------------

describe('gap slots at every statement boundary (the four QuixBugs insertions)', () => {
  const template = createTemplateSource();
  const opts = enumerateOptions(new Map(), { cap: 254 });
  const program = (name: string): { file: ReturnType<typeof sf>; fn: { file: ReturnType<typeof sf>; name: string; startLine: number; endLine: number } } => {
    const file = sf(`${name}.py`, quixbugsProgram(name));
    const b = file.mod.blocks.find((x) => x.kind === 'def')!;
    return { file, fn: { file, name, startLine: b.startLine, endLine: b.endLine } };
  };
  /** the gold insertion of each program: the line the statement goes before and its indent (bench/data/quixbugs/correct) */
  const GOLD: { name: string; line: number; indent: number; fix: string; position: string }[] = [
    { name: 'depth_first_search', line: 10, indent: 12, fix: 'nodesvisited.add(node)', position: 'gap after L9 (after_header)' },
    { name: 'reverse_linked_list', line: 6, indent: 8, fix: 'prevnode = node', position: 'gap after L5 (mid_block)' },
    { name: 'shunting_yard', line: 18, indent: 12, fix: 'opstack.append(token)', position: 'gap after L17 (block_end, dedent 1)' },
    // the gold puts `lines.append(text)` after the blank L9; before it (L9) is the same program
    { name: 'wrap', line: 9, indent: 4, fix: 'lines.append(text)', position: 'gap after L8 (block_end, dedent 1)' },
  ];

  it.each(GOLD)('$name: the gold gap is a slot with the gold indent and its template pool holds the gold statement', ({ name, line, indent, fix, position }) => {
    const { fn } = program(name);
    const sites = functionGapSites(fn);
    const gap = sites.find((s) => s.line === line)!;
    expect(gap, `no gap before L${line} among ${sites.map((s) => `${s.line}@${s.indent.length}`).join(' ')}`).toBeDefined();
    expect(gap.indent).toBe(' '.repeat(indent));
    expect(gap.evidence.notes[0]).toBe(position);
    const pool = template.enumerate(gap, opts);
    const hit = pool.find((c) => c.text.trim() === fix);
    expect(hit, `pool at L${line}@${indent}: ${pool.slice(0, 8).map((c) => c.text.trim()).join(' | ')}`).toBeDefined();
    expect(hit!.text).toBe(' '.repeat(indent) + fix);
    // one slot per physical line: the sieve queue keys a job by (line, kind, code tokens), so a second indent at the same line would be a duplicate there
    expect(new Set(sites.map((s) => s.line)).size).toBe(sites.length);
    expect(pool.length).toBeLessThan(120);
  });

  it('shunting_yard: `opstack.append(token)` is enumerated inside the `else:` branch after the inner `while` (one level out of the loop body), and the gap keeps the pool small', () => {
    const { file, fn } = program('shunting_yard');
    const slots = functionGapSlots(file, fn.startLine, fn.endLine);
    // after L17 (the `while` body's only statement, indent 16): the `else:` body level 12 takes the line right after; the blank L18 gives the loop's own level a slot before L19
    expect(slots.filter((g) => g.afterLine === 17).map((g) => [g.line, g.indent.length, g.dedent])).toEqual([[18, 12, 1], [19, 16, 0]]);
    const gap = functionGapSites(fn).find((s) => s.line === 18)!;
    const pool = template.enumerate(gap, opts).filter((c) => c.op.startsWith('insert_'));
    const texts = pool.map((c) => c.text.trim());
    expect(texts).toContain('opstack.append(token)');
    // the loop variable outranks collection-typed elements (`opstack.append(precedence)`), which stay in the pool
    expect(texts.indexOf('opstack.append(token)')).toBeLessThan(texts.indexOf('opstack.append(precedence)'));
    expect(texts).toContain('opstack.append(precedence)');
    // before `else:` (L15) only the `if` body's indent is legal: a statement at the clause's indent is a SyntaxError
    expect(slots.find((g) => g.line === 15)!.indent).toBe('            ');
  });

  it('reverse_linked_list: `prevnode = node` is enumerated at the loop-body gap after `node.successor = prevnode`', () => {
    const { fn } = program('reverse_linked_list');
    const gap = functionGapSites(fn).find((s) => s.line === 6)!;
    expect(gap.indent).toBe('        ');
    expect(gap.scope.locals).toEqual(expect.arrayContaining(['prevnode', 'nextnode']));
    const texts = template.enumerate(gap, opts).map((c) => c.text.trim());
    expect(texts).toContain('prevnode = node');
    // the gap after the loop (before `return prevnode`) is one level out
    expect(functionGapSites(fn).find((s) => s.line === 7)!.indent).toBe('    ');
  });

  it('orderGapSlots: neighbour Jev probability first, then after-header > block-end > mid-block, then line', () => {
    const { file, fn } = program('wrap');
    const slots = functionGapSlots(file, fn.startLine, fn.endLine);
    const p = new Map<number, number>([[8, 0.4], [10, 0.3], [3, 0.1]]);
    const ordered = orderGapSlots(slots, (line) => p.get(line) ?? 0);
    // the three slots touching L8 (0.4): the two block-end slots after L8 (before L9 at 4, before L10 at 8) ahead of the mid-block slot before L8;
    // then the slots touching L3 (0.1): after L3 (header) ahead of after L2 (mid); then the zero group by tier, then line
    expect(ordered.slice(0, 5).map((g) => `${g.line}@${g.indent.length}`)).toEqual(['9@4', '10@8', '8@8', '4@8', '3@4']);
    const zero = ordered.slice(5);
    expect(zero.map((g) => `${g.line}:${g.position}`)).toEqual(['2:after_header', '6:after_header', '7:block_end', '5:mid_block']);
  });

  it('topStatementTemplates: the top-5 statements of a function by prior include the gold insertions', () => {
    for (const { name, fix } of GOLD) {
      const { file, fn } = program(name);
      const slots = functionGapSlots(file, fn.startLine, fn.endLine);
      const top = topStatementTemplates(file, fn, slots, new Map(), 12);
      expect(top.length).toBeLessThanOrEqual(12);
      expect(top.map((t) => t.text), name).toContain(fix);
      for (let k = 1; k < top.length; k++) expect(top[k - 1]!.prior).toBeGreaterThanOrEqual(top[k]!.prior);
    }
    const sy = program('shunting_yard');
    expect(topStatementTemplates(sy.file, sy.fn, functionGapSlots(sy.file, sy.fn.startLine, sy.fn.endLine), new Map()).map((t) => t.text)).toContain('opstack.append(token)');
  });
});

describe('Q6 fallback once a search reached WIDENED with nothing plausible', () => {
  const file = sf('shunting_yard.py', quixbugsProgram('shunting_yard'));
  const files = new Map([[file.path, file]]);
  const TEST = 'tests/test_shunting_yard.py::test_shunting_yard[2]';
  const failure = { testId: TEST, call: 'shunting_yard([10, "-", 5, "-", 2])', expected: '[10, 5, "-", 2, "-"]', actual: '[10, 5, 2]' };
  const anchor = { ...siteAt(file, 16), evidence: { jevProbability: 0.5, notes: ['q5 top-1'] } };
  const localized: LocalizeResult = { files: [{ path: file.path, probability: 1 }], functions: [{ file, name: 'shunting_yard', startLine: 2, endLine: 22, probability: 0.9 }], sites: [anchor], requests: 0 };
  const syGoal = (over: Partial<Goal> = {}): Goal => goal({ tests: [TEST], failures: [failure], suspectedFiles: [file.path], ...over });

  it('applies to an open goal whose last phase was WIDENED, never to a fresh or fixed one', () => {
    expect(q6FallbackApplies(syGoal({ phase: 'WIDENED' }))).toBe(true);
    expect(q6FallbackApplies(syGoal({ phase: 'WIDENED', status: 'parked' }))).toBe(true);
    expect(q6FallbackApplies(syGoal({ phase: 'SEEDS' }))).toBe(false);
    expect(q6FallbackApplies(syGoal({ phase: 'WIDENED', status: 'fixed' }))).toBe(false);
  });

  it('asks one Q6 per top statement template, puts the chosen gaps first (insert sites first) and records the placements', async () => {
    const asked: string[] = [];
    const { ask, calls } = scriptedAsk((call) => {
      const st = stateObject(call);
      if (GAP_QUESTION_ID in call.questions) asked.push(String(st['missing_statement']));
      return answerAll(
        call,
        () => 0.05,
        (id) => (id === GAP_QUESTION_ID ? (st['missing_statement'] === 'opstack.append(token)' ? { after_l17: 0.83, after_l16: 0.1 } : { after_l11: 0.6, after_l2: 0.25 }) : {}),
      );
    });
    const ctx: GoalSiteContext = { ask, task: 'Fix shunting_yard so the tests pass', signal: signal(), files };
    const g = await buildGoalSites(ctx, syGoal({ phase: 'WIDENED' }), localized);
    // one Q5n request (single file) + one Q6 per statement
    expect(calls.filter((c) => GAP_QUESTION_ID in c.questions)).toHaveLength(Q6_FALLBACK_STATEMENTS);
    expect(g.requests).toBe(1 + Q6_FALLBACK_STATEMENTS);
    expect(asked).toContain('opstack.append(token)');
    // the measured Q6 wording over every code line of the function
    const q6 = calls.find((c) => GAP_QUESTION_ID in c.questions)!;
    expect(q6.questions[GAP_QUESTION_ID]!.instructions).toBe(GAP_QUESTION);
    expect(Object.keys((q6.questions[GAP_QUESTION_ID] as Extract<Question, { type: 'choice' }>).criteria)).toContain('after_l17');
    // Jev's placement for the gold statement: after L17 → the slot before L18 at the `else:` body level, first of every site
    const first = g.insert[0]!;
    expect(first).toMatchObject({ line: 18, kind: 'insert', indent: '            ' });
    expect(first.evidence.jevProbability).toBeCloseTo(0.83, 6);
    expect(first.evidence.notes[0]).toBe('q6 fallback after_l17 p=0.83 for `opstack.append(token)`');
    expect(g.insertFirst).toBe(true);
    expect(g.ordered[0]).toBe(first);
    expect(g.ordered.slice(0, g.insert.length).every((s) => s.kind === 'insert')).toBe(true);
    expect(g.q6Fallback.get('opstack.append(token)')).toEqual(['after_l17']); // 0.1 on after_l16 is below the 0.2 keep threshold
    // the other statements' placements (after L11 0.6, after L2 0.25) are kept in Jev order after the gold's; their sites carry the statements
    const l12 = g.insert.find((s) => s.line === 12)!;
    expect(l12.evidence.jevProbability).toBeCloseTo(0.6, 6);
    expect(l12.evidence.notes.filter((n) => n.startsWith('q6 fallback after_l11')).length).toBeGreaterThanOrEqual(1);
    expect(g.notes.some((n) => n.startsWith('q6 fallback `opstack.append(token)` → after_l17 p=0.83'))).toBe(true);
    // the template pool at the chosen gap holds the statement Jev placed
    expect(createTemplateSource().enumerate(first, enumerateOptions(new Map())).some((c) => c.text === '            opstack.append(token)')).toBe(true);
  });

  it('llm-jev `batchQ6Fallback`: one request asks every statement\'s Q6 over one state; the placements match the one-per-statement shape', async () => {
    const { ask, calls } = scriptedAsk((call) => {
      const st = stateObject(call);
      const statements = (st['missing_statements'] ?? {}) as Record<string, string>;
      return answerAll(
        call,
        () => 0.05,
        (id) => {
          const k = /^insert_after_(\d+)$/.exec(id);
          if (k === null) return {};
          return statements[`stmt_${k[1]}`] === 'opstack.append(token)' ? { after_l17: 0.83, after_l16: 0.1 } : { after_l11: 0.6, after_l2: 0.25 };
        },
      );
    });
    const ctx: GoalSiteContext = { ask, task: 'Fix shunting_yard so the tests pass', signal: signal(), files };
    const g = await buildGoalSites(ctx, syGoal({ phase: 'WIDENED' }), localized, undefined, { batchQ6Fallback: true });
    const batched = calls.filter((c) => `${GAP_QUESTION_ID}_1` in c.questions);
    expect(batched).toHaveLength(1);
    expect(calls.filter((c) => GAP_QUESTION_ID in c.questions)).toHaveLength(0);
    // one Q5n request (single file) + the one batched Q6
    expect(g.requests).toBe(2);
    const call = batched[0]!;
    expect(Object.keys(call.questions)).toHaveLength(Q6_FALLBACK_STATEMENTS);
    const st = stateObject(call);
    expect(Object.keys(st['missing_statements'] as Record<string, string>)).toHaveLength(Q6_FALLBACK_STATEMENTS);
    expect(Object.values(st['missing_statements'] as Record<string, string>)).toContain('opstack.append(token)');
    // the same placements as the unbatched fallback
    const first = g.insert[0]!;
    expect(first).toMatchObject({ line: 18, kind: 'insert' });
    expect(first.evidence.jevProbability).toBeCloseTo(0.83, 6);
    expect(g.q6Fallback.get('opstack.append(token)')).toEqual(['after_l17']);
    expect(g.insertFirst).toBe(true);
  });

  it('gapBatchRequest: one Choice per statement over the same gap options, ids beside their statements, the statements in the state', () => {
    const lines = [{ line: 1, text: 'def wrap(text, cols):' }, { line: 2, text: '    lines = []' }];
    const req = gapBatchRequest({ task: 'fix it', failures: [WRAP_FAILURE], functionName: 'wrap', lines, missingStatements: ['  lines.append(text)  ', 'return lines'] });
    expect(req.ids).toEqual([
      { id: `${GAP_QUESTION_ID}_1`, statement: '  lines.append(text)  ' },
      { id: `${GAP_QUESTION_ID}_2`, statement: 'return lines' },
    ]);
    expect(Object.keys(req.questions)).toEqual(req.ids.map((x) => x.id));
    const state = req.state as Record<string, unknown>;
    expect(state['missing_statements']).toEqual({ stmt_1: 'lines.append(text)', stmt_2: 'return lines' });
    for (const q of Object.values(req.questions)) {
      expect(q.type).toBe('choice');
      if (q.type === 'choice') expect(Object.keys(q.criteria).filter((k) => k !== ESCAPE_KEY).sort()).toEqual(['after_l1', 'after_l2', 'before_l1'].sort());
    }
    expect(() => gapBatchRequest({ task: 'fix it', failures: [WRAP_FAILURE], functionName: 'wrap', lines: [], missingStatements: ['x'] })).toThrow(RangeError);
  });

  it('does not run on a fresh goal: no Q6 request, the anchors and slots stand as usual', async () => {
    const { ask, calls } = scriptedAsk((call) => answerAll(call, () => 0.05, () => ({})));
    const g = await buildGoalSites({ ask, task: 'fix', signal: signal(), files }, syGoal(), localized);
    expect(calls.filter((c) => GAP_QUESTION_ID in c.questions)).toHaveLength(0);
    expect(g.q6Fallback.size).toBe(0);
    expect(g.insertFirst).toBe(false);
    expect(g.notes).toContain('14 gap slots of shunting_yard');
  });
});

describe('repository path: anchors ordered by p × the beam function probability (depth_first_search + node.py)', () => {
  const dfs = sf('depth_first_search.py', quixbugsProgram('depth_first_search'));
  const node = sf(
    'node.py',
    ['class Node:', '    def __init__(self, value=None, successor=None, successors=[]):', '        self.value = value', '        self.successor = successor', '        self.successors = successors', '', '    def successor(self):', '        return self.successor', ''].join('\n'),
  );
  const files = new Map([[dfs.path, dfs], [node.path, node]]);
  const TEST = 'tests/depth_first_search_test.py::test5';
  const failure = { testId: TEST, call: 'depth_first_search(station1, station6)', expected: 'False', actual: 'RecursionError: maximum recursion depth exceeded' };
  // the live run of 2026-09-20: Q2 depth_first_search.py 0.93 × 1.0, node.py 0.1 × {__init__ 0.16, successor 0.02}; Q5 per function
  const withP = (file: ReturnType<typeof sf>, line: number, p: number): ReturnType<typeof siteAt> => ({ ...siteAt(file, line), evidence: { jevProbability: p, notes: [] } });
  const localized: LocalizeResult = {
    files: [{ path: dfs.path, probability: 0.93 }, { path: node.path, probability: 0.1 }],
    functions: [
      { file: dfs, name: 'depth_first_search', startLine: 1, endLine: 14, probability: 0.93 },
      { file: node, name: 'Node.__init__', startLine: 2, endLine: 5, probability: 0.016 },
      { file: node, name: 'Node.successor', startLine: 7, endLine: 8, probability: 0.002 },
    ],
    // (the live run put 0.87 on `def __init__`, a def line q5Anchors never keeps; L4 stands in for it)
    sites: [withP(dfs, 11, 0.39), withP(dfs, 9, 0.11), withP(dfs, 7, 0.09), withP(node, 4, 0.87), withP(node, 8, 0.99)],
    requests: 0,
  };

  it('functionWeight reads the function holding the line; 1 outside every beam function and on the single-file path', () => {
    const w = functionWeight(localized, false);
    expect(w({ file: dfs, line: 11 })).toBeCloseTo(0.93, 6);
    expect(w({ file: node, line: 8 })).toBeCloseTo(0.002, 6);
    expect(w({ file: node, line: 1 })).toBe(1);
    expect(functionWeight(localized, true)({ file: node, line: 8 })).toBe(1);
  });

  it('q5Anchors: unweighted, node.py’s confident lines lead; weighted, the target function’s anchors do', () => {
    expect(q5Anchors(localized).map((a) => `${a.file.path}:${a.line}`)).toEqual(['node.py:8', 'node.py:4', 'depth_first_search.py:11', 'depth_first_search.py:9', 'depth_first_search.py:7']);
    const weighted = q5Anchors(localized, 3, 0.05, functionWeight(localized, false));
    expect(weighted.map((a) => `${a.file.path}:${a.line}`)).toEqual(['depth_first_search.py:11', 'depth_first_search.py:9', 'depth_first_search.py:7', 'node.py:4', 'node.py:8']);
    // the evidence keeps the raw Q5 probability
    expect(weighted[0]!.evidence.jevProbability).toBeCloseTo(0.39, 6);
  });

  it('buildGoalSites: the top-3 anchor gaps are the target function’s, so the gap after `else:` (L10 at the body indent) is in the SEEDS cut', async () => {
    const { ask, calls } = scriptedAsk((call) => answerAll(call, () => 0.05, () => ({})));
    const g = await buildGoalSites({ ask, task: 'fix depth_first_search', signal: signal(), files }, goal({ tests: [TEST], failures: [failure], suspectedFiles: [dfs.path] }), localized);
    expect(calls).toHaveLength(0); // two files: no Q5n, no Q6
    expect(g.replace.map((s) => `${s.file.path}:${s.line}`)).toEqual(['depth_first_search.py:11', 'depth_first_search.py:9', 'depth_first_search.py:7', 'node.py:4', 'node.py:8']);
    // gaps after and before L11 (the `return any(` statement spans 10–12: after → 13, before → 11), L9 (`else:` → 10 at 12; before → 9), L7 (`elif` → 8; before → 7)
    expect(g.insert.map((s) => `${s.file.path}:${s.line}@${s.indent.length}`)).toEqual(['depth_first_search.py:13@8', 'depth_first_search.py:11@16', 'depth_first_search.py:10@12', 'depth_first_search.py:9@12', 'depth_first_search.py:8@12', 'depth_first_search.py:7@12']);
    const gold = g.insert.find((s) => s.line === 10)!;
    expect(createTemplateSource().enumerate(gold, enumerateOptions(files)).some((c) => c.text === '            nodesvisited.add(node)')).toBe(true);
    // visiting order: each anchor's replace site, then its gaps; node.py's anchors last
    expect(g.ordered.slice(0, 6).map((s) => `${s.line}${s.kind === 'insert' ? 'i' : 'r'}`)).toEqual(['11r', '13i', '11i', '9r', '10i', '9i']);
  });
});

// ---------------------------------------------------------------------------------------
// Statement-level sites from the search's own builders (capability 4 reaches the engine)
// ---------------------------------------------------------------------------------------

describe('statement-level replace sites built by replaceSiteAt / widenedSites (swebench-reach-oracle-9.md capability 4)', () => {
  const SRC = ['def f(self):', '    return hash((', '        self.a,', '        self.b,', '    ))', '    x = 1', ''].join('\n');
  const file = sf('pkg/m.py', SRC);
  const ev = { notes: ['n'] };

  it("at a multi-line statement's first line the statement site stands in place of the physical site; at a continuation line the physical site stays and statementSiteFor adds the span once", () => {
    const first = replaceSiteAt(file, 2, ev)!;
    expect(first).toMatchObject({ line: 2, endLine: 5, kind: 'replace', currentLine: '    return hash((self.a, self.b))', indent: '    ', block: { name: 'f' } });
    expect(first.evidence.notes).toEqual(['n', 'statement L2-5 joined']);
    const cont = replaceSiteAt(file, 3, ev)!;
    expect(cont).toMatchObject({ line: 3, currentLine: '        self.a,' });
    expect(cont.endLine).toBeUndefined();
    expect(statementSiteFor(file, 3, ev)).toMatchObject({ line: 2, endLine: 5, currentLine: '    return hash((self.a, self.b))' });
    // nothing to add at the first line (replaceSiteAt already returned the span) or at a one-line statement
    expect(statementSiteFor(file, 2, ev)).toBeNull();
    expect(statementSiteFor(file, 6, ev)).toBeNull();
    expect(replaceSiteAt(file, 6, ev)).toMatchObject({ line: 6, currentLine: '    x = 1' });
    expect(replaceSiteAt(file, 1, ev)).toBeNull();
  });

  it('WIDENED lists the statement site at the first line and the physical sites of the continuation lines', () => {
    const all = widenedSites([{ file, name: 'f', startLine: 1, endLine: 6 }]);
    const replaces = all.filter((s) => s.kind === 'replace').map((s) => [s.line, s.endLine ?? null]);
    expect(replaces).toEqual([[2, 5], [3, null], [4, null], [5, null], [6, null]]);
    expect(all.find((s) => s.kind === 'replace' && s.line === 2)!.currentLine).toBe('    return hash((self.a, self.b))');
  });
});

// ---------------------------------------------------------------------------------------
// Introspection-derived sites (capability 2's class-body gap reaches the live search)
// ---------------------------------------------------------------------------------------

describe('introspectionSites: the class-body gap of the class the failing call points at, plus the import gap, ≤ 2, after the located sites', () => {
  const PRINTER = ['import math', '', 'class Printer(Base):', '    """doc"""', '    def _print_Foo(self, e):', '        return "foo"', '', '    def _print_Bar(self, e):', '        return "bar"', '', '    def helper(self):', '        return 1', '', 'def free():', '    return 2', ''].join('\n');
  const printer = sf('pkg/printer.py', PRINTER);
  const other = sf('pkg/other.py', 'class Plain:\n    def a(self):\n        return 1\n\n    def b(self):\n        return 2\n');
  const corpus = new Map([[printer.path, printer], [other.path, other]]);
  const names = (over: Partial<IntrospectedNames>): IntrospectedNames => ({ ...emptyIntrospection('ran', 'test'), ...over });
  const operand = (expr: string, typeName: string, receiver: boolean, frame: IntrospectedNames['operands'][number]['frame'] = null): IntrospectedNames['operands'][number] => ({ expr, typeName, classes: [typeName], predicates: [], falsyPredicates: [], attributes: [], frame, raisingReceiver: receiver });

  it('the raising frame in a method of a localised class: the gap after that method (class indent, block = the class) and the module import gap', () => {
    const facts = names({ frames: [{ path: 'pkg/printer.py', line: 9, fn: '_print_Bar', code: 'return "bar"' }], classes: ['Baz'] });
    const out = introspectionSites(facts, corpus, ['pkg/printer.py'], []);
    expect(out.map((s) => [s.line, s.kind, s.indent, s.block?.name ?? null])).toEqual([[10, 'insert', '    ', 'Printer'], [2, 'insert', '', null]]);
    expect(out[0]!.evidence.notes[0]).toBe(`${INTROSPECTION_SITE_NOTE} class-body gap of Printer after _print_Bar (L8-9)`);
    expect(out[0]!.evidence.notes[1]).toContain('_print_Bar at pkg/printer.py:9');
    expect(out[1]!.evidence.notes[0]).toBe(`${INTROSPECTION_SITE_NOTE} module-level import gap of pkg/printer.py`);
    expect(out.every(isIntrospectionSite)).toBe(true);
    // no operand carries a frame: no raising-statement gap, two of the INTROSPECTION_SITES_MAX slots used
    expect(out).toHaveLength(2);
    expect(INTROSPECTION_SITES_MAX).toBe(3);
    // a frame path given absolute (as CPython prints it) resolves by suffix
    const abs = names({ frames: [{ path: '/work/pkg/printer.py', line: 9, fn: '_print_Bar', code: null }] });
    expect(introspectionSites(abs, corpus, ['pkg/printer.py'], []).map((s) => s.line)).toEqual([10, 2]);
  });

  it('a raising receiver whose class a localised file defines: the gap before the first method; the class enclosing a located site otherwise; nothing when no localised file defines the class', () => {
    const receiver = names({ operands: [operand('self', 'Printer', true)] });
    expect(introspectionSites(receiver, corpus, ['pkg/printer.py'], []).map((s) => [s.line, s.evidence.notes[0]])).toEqual([[5, `${INTROSPECTION_SITE_NOTE} class-body gap of Printer before _print_Foo (L5)`], [2, `${INTROSPECTION_SITE_NOTE} module-level import gap of pkg/printer.py`]]);
    // the class is not in a localised file: no site
    expect(introspectionSites(receiver, corpus, ['pkg/other.py'], [])).toEqual([]);
    // no fact points anywhere: the class around the top located site (in _print_Foo) gets the gap after that method
    const none = names({ classes: ['Baz'] });
    const located = [siteAt(printer, 6)];
    expect(introspectionSites(none, corpus, ['pkg/printer.py'], located).map((s) => s.line)).toEqual([7, 2]);
    // a prefixed class outranks a plain one when both are pointed at (the alias production writes only into the former)
    const both = names({ frames: [{ path: 'pkg/other.py', line: 3, fn: 'a', code: null }, { path: 'pkg/printer.py', line: 9, fn: '_print_Bar', code: null }] });
    expect(introspectionSites(both, corpus, ['pkg/other.py', 'pkg/printer.py'], []).map((s) => s.file.path)).toEqual(['pkg/printer.py', 'pkg/printer.py']);
    // with only the plain class localised its gap still comes (bounded, after the Jev list); the alias production is inert there
    expect(introspectionSites(both, corpus, ['pkg/other.py'], []).map((s) => [s.file.path, s.line])).toEqual([['pkg/other.py', 4], ['pkg/other.py', 1]]);
  });

  it('is bounded and deduplicated against the located sites; nothing without facts or localised files', () => {
    const facts = names({ frames: [{ path: 'pkg/printer.py', line: 9, fn: '_print_Bar', code: null }] });
    expect(introspectionSites(facts, corpus, ['pkg/printer.py'], [], 1).map((s) => s.line)).toEqual([10]);
    expect(introspectionSites(facts, corpus, ['pkg/printer.py'], [], 0)).toEqual([]);
    const already = siteAt(printer, 10, 'insert');
    expect(introspectionSites(facts, corpus, ['pkg/printer.py'], [already]).map((s) => s.line)).toEqual([2]);
    expect(introspectionSites(emptyIntrospection('no_target', 'nothing'), corpus, ['pkg/printer.py'], [])).toEqual([]);
    expect(introspectionSites(facts, corpus, [], [])).toEqual([]);
    expect(introspectionSites(facts, corpus, ['missing.py'], [])).toEqual([]);
  });
});

describe('introspection sites merged onto colliding located sites, and the gap before the raising statement (§24)', () => {
  const PRINTER = ['import math', '', 'class Printer(Base):', '    """doc"""', '    def _print_Foo(self, e):', '        return "foo"', '', '    def _print_Bar(self, e):', '        return "bar"', '', '    def helper(self):', '        return 1', '', 'def free():', '    return 2', ''].join('\n');
  const printer = sf('pkg/printer.py', PRINTER);
  const corpus = new Map([[printer.path, printer]]);
  const names = (over: Partial<IntrospectedNames>): IntrospectedNames => ({ ...emptyIntrospection('ran', 'test'), ...over });
  const operand = (expr: string, typeName: string, receiver: boolean, frame: IntrospectedNames['operands'][number]['frame'] = null): IntrospectedNames['operands'][number] => ({ expr, typeName, classes: [typeName], predicates: ['is_x'], falsyPredicates: ['is_x'], attributes: [], frame, raisingReceiver: receiver });

  it("mergeIntrospectionSites: the class-body gap colliding with the method's block-end slot (same path:line:kind, another indent) is merged onto it — the slot keeps its indent and gains the class-body mark — and the alias production fires there at the class indent; the import gap is added", () => {
    const slot: Site = { ...siteAt(printer, 10, 'insert'), indent: '        ', evidence: { notes: ['insert after anchor L9'] } };
    const located = [siteAt(printer, 9), slot];
    const facts = names({ frames: [{ path: 'pkg/printer.py', line: 9, fn: '_print_Bar', code: 'return "bar"' }], classes: ['Baz'] });
    // the old API drops the colliding gap
    expect(introspectionSites(facts, corpus, ['pkg/printer.py'], located).map((s) => s.line)).toEqual([2]);
    const m = mergeIntrospectionSites(located, facts, corpus, ['pkg/printer.py']);
    expect(m.sites.map((s) => [s.line, s.kind, s.indent])).toEqual([[9, 'replace', '        '], [10, 'insert', '        '], [2, 'insert', '']]);
    expect(m.added.map((s) => s.line)).toEqual([2]);
    expect(m.merged).toHaveLength(1);
    const merged = m.merged[0]!;
    expect(m.sites[1]).toBe(merged);
    expect(merged.indent).toBe('        ');
    expect(merged.evidence.notes).toEqual(['insert after anchor L9', `${CLASS_BODY_GAP_NOTE} Printer after _print_Bar (L8-9)`, "the failing call's frame _print_Bar at pkg/printer.py:9"]);
    expect(isClassBodyGapSite(merged)).toBe(true);
    expect(isIntrospectionSite(merged)).toBe(true);
    // the alias production reads the mark: `_print_Baz = <method>` at the class indent, applied after `_print_Bar`
    const aliases = createTemplateSource().enumerate(merged, { ...enumerateOptions(corpus), introspected: facts }).filter((c) => c.op === 'mro_method_alias');
    expect(aliases.map((c) => c.text)).toEqual(['    _print_Baz = _print_Bar', '    _print_Baz = _print_Foo']);
    expect(applyCandidate(aliases[0]!).files[0]!.after).toContain('        return "bar"\n    _print_Baz = _print_Bar\n');
    // unmarked, the same slot offers no alias
    expect(createTemplateSource().enumerate(slot, { ...enumerateOptions(corpus), introspected: facts }).some((c) => c.op === 'mro_method_alias')).toBe(false);
    // merging twice adds nothing new
    const again = mergeIntrospectionSites(m.sites, facts, corpus, ['pkg/printer.py']);
    expect(again.added).toEqual([]);
    expect(again.merged).toEqual([]);
    expect(again.sites).toEqual(m.sites);
  });

  it("the gap before the statement an operand was read in comes first (raising receivers first, at that line's indent), then the class-body gap, then the import gap: INTROSPECTION_SITES_MAX = 3", () => {
    const facts = names({ operands: [operand('e.exp', 'Unit', true, { path: '/work/pkg/printer.py', line: 9, fn: '_print_Bar', code: null })], classes: ['Baz'] });
    const out = introspectionSites(facts, corpus, ['pkg/printer.py'], []);
    expect(out.map((s) => [s.line, s.kind, s.indent])).toEqual([[9, 'insert', '        '], [10, 'insert', '    '], [2, 'insert', '']]);
    expect(out).toHaveLength(INTROSPECTION_SITES_MAX);
    expect(isRaisingGap(out[0]!)).toBe(true);
    expect(out[0]!.evidence.notes).toEqual([`${RAISING_GAP_NOTE} L9 of pkg/printer.py`, 'the operand e.exp was read there (_print_Bar)']);
    expect(out[0]!.block?.name).toBe('Printer._print_Bar');
    // a frame in a file that is not localised adds no gap; a receiver outranks a plain operand
    expect(introspectionSites(names({ operands: [operand('e', 'T', true, { path: 'pkg/other.py', line: 3, fn: 'g', code: null })] }), corpus, ['pkg/printer.py'], []).some(isRaisingGap)).toBe(false);
    const two = names({ operands: [operand('a', 'T', false, { path: 'pkg/printer.py', line: 6, fn: '_print_Foo', code: null }), operand('b', 'T', true, { path: 'pkg/printer.py', line: 12, fn: 'helper', code: null })] });
    expect(introspectionSites(two, corpus, ['pkg/printer.py'], []).filter(isRaisingGap).map((s) => s.line)).toEqual([12, 6]);
    // the gap colliding with a located gap at the same line is merged (the mark travels), not duplicated
    const located = [siteAt(printer, 9, 'insert')];
    const m = mergeIntrospectionSites(located, facts, corpus, ['pkg/printer.py']);
    expect(m.sites.map((s) => s.line)).toEqual([9, 10, 2]);
    expect(isRaisingGap(m.sites[0]!)).toBe(true);
    expect(m.merged).toHaveLength(1);
  });
});

describe("historySites: the reversals' own sites after the located ones (§24)", () => {
  it('lists the site of a reversal that is not at a located site (the rung-3 shape: L1679 while L1686 is ranked), where the history source then emits it; nothing at a located site with the same span', () => {
    const { file, facts, siteAt: at } = compilerFixture();
    const files = new Map([[COMPILER_PATH, file]]);
    const ranked = at(RANKED_LINE);
    const hs = historySites(facts, files, [COMPILER_PATH], [ranked]);
    expect(hs.map((s) => [s.file.path, s.line, s.kind, s.endLine])).toEqual([[COMPILER_PATH, HISTORY_LINE, 'replace', undefined]]);
    const own = hs[0]!;
    expect(isHistorySite(own)).toBe(true);
    expect(own.evidence.notes).toEqual(['history: the lines a past commit added', 'reverse of 0c763317aa "Fixed #12345 -- Read the combinator from the query." (ticket:#12345)']);
    expect(own.block?.name).toBe('as_sql');
    // the source emits the reversal there, and only there
    const opts = { cap: 254, testLiterals: [], taskIdentifiers: [], corpus: files, history: facts };
    expect(enumerateHistory(ranked, opts)).toEqual([]);
    const there = enumerateHistory(own, opts);
    expect(there).toHaveLength(1);
    expect(there[0]!.site).toBe(own);
    expect(sameSpan(there[0]!.site, own)).toBe(true);
    // already a located site (same span): not listed again
    expect(historySites(facts, files, [COMPILER_PATH], [ranked, at(HISTORY_LINE)])).toEqual([]);
    // a located site under the same siteKey with another span holds the key: the reversal's site is left out (goal bookkeeping is by siteKey)
    expect(historySites(facts, files, [COMPILER_PATH], [{ ...at(HISTORY_LINE), endLine: HISTORY_LINE + 1 }])).toEqual([]);
    // bounds and absences
    expect(historySites(facts, files, [COMPILER_PATH], [ranked], 0)).toEqual([]);
    expect(historySites({ commits: [] }, files, [COMPILER_PATH], [ranked])).toEqual([]);
    expect(historySites(facts, files, [], [ranked])).toEqual([]);
    expect(historySites(facts, files, ['missing.py'], [ranked])).toEqual([]);
    expect(HISTORY_SITES_MAX).toBe(2);
  });

  it('orders by commit recency, then proximity to the located sites of the file, then run order; cut at max', () => {
    const { file, facts, siteAt: at } = compilerFixtureWithOlderFarCommit();
    const files = new Map([[COMPILER_PATH, file]]);
    const ranked = at(RANKED_LINE);
    // the newest commit's run (L1679, 7 lines away) before the older commit's (L5, far)
    expect(historySites(facts, files, [COMPILER_PATH], [ranked]).map((s) => s.line)).toEqual([HISTORY_LINE, 5]);
    expect(historySites(facts, files, [COMPILER_PATH], [ranked], 1).map((s) => s.line)).toEqual([HISTORY_LINE]);
    // two runs of one commit: the nearer first; without a located site in the file, run order
    const oneCommit = { commits: [{ ...facts.commits[0]!, hunks: [...facts.commits[1]!.hunks, ...facts.commits[0]!.hunks] }] };
    expect(historySites(oneCommit, files, [COMPILER_PATH], [ranked]).map((s) => s.line)).toEqual([HISTORY_LINE, 5]);
    expect(historySites(oneCommit, files, [COMPILER_PATH], []).map((s) => s.line)).toEqual([5, HISTORY_LINE]);
  });
});
