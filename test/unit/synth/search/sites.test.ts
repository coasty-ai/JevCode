/**
 * Site list construction (design §2.5) on a two-function single-file fixture: the real
 * localizer with a scripted Q5, a scripted Q5n, a fake SBFL ranking and per-test coverage.
 * Checks the union (never score-combined), the ordering (Jev evidence by p, then SBFL-only by
 * rank), `def` exclusion, insert gaps after and before the top-3 anchors, Q6 gaps, the trace-tail
 * gap, the 6 + 6 cut, insert-first routing, the Q5 escape capture and the WIDENED cursor.
 */
import { describe, expect, it } from 'vitest';
import type { Question } from '../../../../src/core/types.js';
import { LINE_QUESTION_ID, createLocalizer } from '../../../../src/synth/localize/index.js';
import type { LocalizeResult } from '../../../../src/synth/types.js';
import {
  GAP_QUESTION,
  GAP_QUESTION_ID,
  IMPORT_GAP_NOTE,
  INSERT_SITES_MAX,
  LINE_NOUL_CRITERIA,
  Q5N_SHORT_CIRCUIT_P,
  Q5_ESCAPE_INSERT_FIRST,
  REPLACE_SITES_MAX,
  buildGoalSites,
  captureLineChoiceEscape,
  gapRequest,
  importGapSite,
  insertSitesFirst,
  isImportGap,
  lineNoulRequest,
  nextWidenChunk,
  orderGoalSites,
  q5Anchors,
  siteKey,
  traceTailGap,
  widenedSites,
} from '../../../../src/synth/search/sites.js';
import type { GoalSiteContext, SbflEvidence } from '../../../../src/synth/search/sites.js';
import type { Goal } from '../../../../src/synth/search/types.js';
import type { PerTestResult, RankedLine } from '../../../../src/synth/sbfl/types.js';
import { ESCAPE_KEY, WRAP_FAILURE, answerAll, fixtureFile, goal, ladderTask, scriptedAsk, sf, signal, siteAt, stateObject } from './sites-composite.helpers.js';
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

function ctxWith(script: (call: AskCall) => Record<string, import('../../../../src/core/types.js').Answer>): { ctx: GoalSiteContext; calls: AskCall[] } {
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
    // anchors by Q5 p: L9, L8, L15 → after L9 = gap at 10, before L9 = gap at 9, after L8 = 9, before L8 = 8, after L15 = 16, before L15 = 15
    expect(g.insert.map((s) => [s.line, s.kind])).toEqual([
      [10, 'insert'],
      [9, 'insert'],
      [8, 'insert'],
      [16, 'insert'],
      [15, 'insert'],
    ]);
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
    expect(g.ordered.map((s) => `${s.line}${s.kind === 'insert' ? 'i' : 'r'}`)).toEqual(['9r', '10i', '9i', '7r', '15r', '16i', '15i', '8r', '8i', '2r', '4r']);
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
    // the anchor's own gaps still follow it
    expect(g.ordered.map((s) => `${s.line}${s.kind === 'insert' ? 'i' : 'r'}`)).toEqual(['8i', '28r', '29i', '28i']);
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

    // anchors' gaps: 9, 8, 4, 3, 16, 15; Q6: after L2 → 3 (dup), after L7 → 8 (dup), before L1 → 1 (new); trace tail: after L9 → 10 (new)
    expect(lines(g.insert)).toEqual([9, 8, 4, 3, 16, 15, 1, 10]);
    const q6Site = g.insert.find((s) => s.line === 1)!;
    expect(q6Site.evidence.jevProbability).toBeCloseTo(0.1, 6);
    expect(q6Site.evidence.notes[0]).toMatch(/^q6 before_l1 p=0\.10 for `lines\.append\(text\)`/);
    expect(q6Site.indent).toBe('');
    // a gap before the `def` line lies outside the function: module-level block and scope
    expect(q6Site.block).toBeNull();
    const tail = g.insert.find((s) => s.line === 10)!;
    expect(tail.evidence.notes).toEqual(['after last executed line L9 of failing test wrap[1]', '1 statements of wrap never reached']);
    expect(tail.indent).toBe('    ');
    // Q6 gaps and the tail gap have no anchor: they are visited after every anchored site
    expect(g.ordered.slice(-2).map((s) => s.line)).toEqual([1, 10]);
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
  it('enumerates all code lines except def lines, in beam order, and hands out chunks', () => {
    const all = widenedSites([WRAP, GCD]);
    expect(lines(all)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 13, 14, 15]);
    expect(all.every((s) => s.kind === 'replace' && s.evidence.notes[0]?.startsWith('widened over'))).toBe(true);
    expect(all[8]!.evidence.notes).toEqual(['widened over gcd (beam #2)']);
    expect(all[0]!.block).toEqual({ name: 'wrap', startLine: 1, endLine: 9 });
    // step 1 takes four, step 2 the next four, step 3 the last three and reports done
    const c1 = nextWidenChunk(all, 0, 4);
    expect(lines(c1.sites)).toEqual([2, 3, 4, 5]);
    expect(c1).toMatchObject({ cursor: 4, done: false });
    const c2 = nextWidenChunk(all, c1.cursor, 4);
    expect(lines(c2.sites)).toEqual([6, 7, 8, 9]);
    const c3 = nextWidenChunk(all, c2.cursor, 4);
    expect(lines(c3.sites)).toEqual([13, 14, 15]);
    expect(c3).toMatchObject({ cursor: 11, done: true });
    expect(nextWidenChunk(all, c3.cursor, 4)).toEqual({ sites: [], cursor: 11, done: true });
    // a non-positive size takes everything that is left; an overshooting cursor is clamped
    expect(nextWidenChunk(all, 8, 0).sites).toHaveLength(3);
    expect(nextWidenChunk(all, 99, 4)).toEqual({ sites: [], cursor: 11, done: true });
  });

  it('excludes the lines the SEEDS phase already searched', () => {
    const seeds = new Set([siteKey({ file, line: 9, kind: 'replace' }), siteKey({ file, line: 8, kind: 'replace' })]);
    expect(lines(widenedSites([WRAP], seeds))).toEqual([2, 3, 4, 5, 6, 7]);
  });
});
