import { describe, expect, it } from 'vitest';
import { LINE_QUESTION_ID, buildSites, createLocalizer, functionEntries, indentAfter, sbflKey } from '../../../../src/synth/localize/index.js';
import type { Anchor } from '../../../../src/synth/localize/index.js';
import type { RankedLine } from '../../../../src/synth/sbfl/types.js';
import { GEOMETRY_FAILURE, GEOMETRY_TRACEBACK, answerAll, fixture, scriptedAsk, sf, signal, twoFileWorkspace } from './helpers.js';

const geometry = sf('pkg/geometry.py', fixture('pkg/geometry.py'));
const entries = functionEntries(geometry);
const distance = entries.find((e) => e.qualname === 'Point.distance')!;

function anchor(line: number, p: number, probs: [number, number][] = []): Anchor {
  return { file: geometry, line, entry: distance, jevProbability: p, lineProbabilities: new Map([[line, p], ...probs]), notes: ['jev anchor #1 in Point.distance'] };
}

describe('site windows', () => {
  it('builds replace sites within the function bounds and insert gaps around the anchor', () => {
    const sites = buildSites({ anchors: [anchor(17, 0.6, [[15, 0.15], [16, 0.1], [14, 0.05]])], sbfl: new Map(), frames: [], window: 3 });
    // anchor, insert before, insert after, then neighbours by distance; nothing past line 17 (function end) or before 14
    expect(sites.map((s) => [s.line, s.kind])).toEqual([
      [17, 'replace'],
      [17, 'insert'],
      [18, 'insert'],
      [16, 'replace'],
      [15, 'replace'],
      [14, 'replace'],
    ]);
    const a = sites[0]!;
    expect(a.currentLine).toBe('        return math.sqrt(dx * dx - dy * dy)');
    expect(a.indent).toBe('        ');
    expect(a.block).toEqual({ name: 'Point.distance', startLine: 14, endLine: 17 });
    expect(a.evidence).toEqual({ jevProbability: 0.6, notes: ['jev anchor #1 in Point.distance'] });
    const before = sites[1]!;
    expect(before).toMatchObject({ kind: 'insert', line: 17, currentLine: '', indent: '        ' });
    // names bound on line 17 are not visible before it; dx/dy (lines 15-16) are
    expect(before.scope.locals).toEqual(expect.arrayContaining(['dx', 'dy']));
    const after = sites[2]!;
    expect(after).toMatchObject({ kind: 'insert', line: 18, indent: '        ' });
    expect(after.evidence.notes).toContain('insert after anchor L17');
    // neighbours carry their own Choice probability
    expect(sites[3]!.evidence.jevProbability).toBe(0.1);
    expect(sites[3]!.evidence.notes).toEqual(['within 1 of anchor L17']);
    expect(sites[5]!.line).toBe(14);
    expect(sites[5]!.currentLine).toBe('    def distance(self, other):');
    expect(sites[5]!.indent).toBe('    ');
  });

  it('indents an insert after a compound header one level deeper', () => {
    const utils = sf('pkg/utils.py', fixture('pkg/utils.py'));
    expect(indentAfter(utils, 5)).toBe('        '); // after `    if v < lo:`
    expect(indentAfter(utils, 6)).toBe('        '); // after `        return lo`
    expect(indentAfter(utils, 4)).toBe('    '); // after `def clamp(v, lo, hi):`
  });

  it('places the insert-after gap after the whole multi-line statement', () => {
    const mid = entries.find((e) => e.qualname === 'midpoint')!;
    const a: Anchor = { file: geometry, line: 25, entry: mid, jevProbability: 0.5, lineProbabilities: new Map([[25, 0.5]]), notes: [] };
    const sites = buildSites({ anchors: [a], sbfl: new Map(), frames: [], window: 3 });
    const after = sites.find((s) => s.kind === 'insert' && s.line !== 25)!;
    expect(after.line).toBe(27); // statement spans 25-26
    // window includes the continuation line 26 (a code line inside the function) and the header 24
    expect(sites.filter((s) => s.kind === 'replace').map((s) => s.line).sort((x, y) => x - y)).toEqual([24, 25, 26]);
  });

  it('skips blank and comment-only lines inside the window and dedupes overlapping windows', () => {
    const cp = entries.find((e) => e.qualname === 'clamp_point')!;
    const a1: Anchor = { file: geometry, line: 31, entry: cp, jevProbability: 0.5, lineProbabilities: new Map([[31, 0.5], [29, 0.2]]), notes: [] };
    const a2: Anchor = { file: geometry, line: 29, entry: cp, jevProbability: 0.2, lineProbabilities: new Map([[31, 0.5], [29, 0.2]]), notes: [] };
    const sites = buildSites({ anchors: [a1, a2], sbfl: new Map(), frames: [], window: 3 });
    const keys = sites.map((s) => `${s.line}:${s.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(sites.some((s) => s.kind === 'replace' && s.line === 30)).toBe(false); // the comment line is never a replace site
    expect(keys).toEqual(['31:replace', '29:replace', '31:insert', '32:insert', '29:insert', '30:insert']);
  });

  it('module-level anchors have a null block and windows over module code only', () => {
    const a: Anchor = { file: geometry, line: 4, entry: null, jevProbability: 0.4, lineProbabilities: new Map([[4, 0.4]]), notes: [] };
    const sites = buildSites({ anchors: [a], sbfl: new Map(), frames: [], window: 3 });
    expect(sites[0]!.block).toBeNull();
    expect(sites.filter((s) => s.kind === 'replace').map((s) => s.line).sort((x, y) => x - y)).toEqual([2, 4, 7]); // import math, from-import, class header
  });

  it('attaches SBFL rank/score and traceback notes as evidence', () => {
    const sbfl = new Map<string, RankedLine>();
    const row = (line: number, rank: number, score: number): RankedLine => ({ rank, file: 'pkg/geometry.py', line, ef: 1, ep: 0, score, scores: { ochiai: score, tarantula: score, dstar: score } });
    sbfl.set(sbflKey('pkg/geometry.py', 17), row(17, 1, 1));
    sbfl.set(sbflKey('pkg/geometry.py', 16), row(16, 2, 0.7));
    const sites = buildSites({ anchors: [anchor(17, 0.6, [[16, 0.1]])], sbfl, frames: [{ path: 'pkg/geometry.py', line: 17, fn: 'distance' }], window: 1 });
    expect(sites[0]!.evidence).toEqual({ jevProbability: 0.6, sbflRank: 1, sbflScore: 1, notes: ['jev anchor #1 in Point.distance', 'in traceback'] });
    const l16 = sites.find((s) => s.line === 16 && s.kind === 'replace')!;
    expect(l16.evidence).toEqual({ jevProbability: 0.1, sbflRank: 2, sbflScore: 0.7, notes: ['within 1 of anchor L17'] });
  });
});

describe('union with SBFL in the pipeline', () => {
  it('adds the SBFL top-3 lines as anchors when Jev picked elsewhere', async () => {
    const files = twoFileWorkspace();
    const { ask } = scriptedAsk((call) =>
      answerAll(
        call,
        (id) => (id === 'pkg/geometry.py' ? 0.9 : 0.1),
        (id, q) => {
          const keys = Object.keys(q.type === 'choice' ? q.criteria : {}).filter((k) => k !== 'none_of_these');
          if (id === LINE_QUESTION_ID && keys.includes('line_15')) return { line_15: 0.7 }; // Jev: dx line
          if (keys.includes('point_distance')) return { point_distance: 0.9 };
          return { [keys[0]!]: 0.6 };
        },
      ),
    );
    const row = (file: string, line: number, rank: number): RankedLine => ({ rank, file, line, ef: 1, ep: 0, score: 1 / rank, scores: { ochiai: 1 / rank, tarantula: 0, dstar: 0 } });
    const sbfl = [row('pkg/geometry.py', 17, 1), row('pkg/geometry.py', 16, 2), row('pkg/utils.py', 12, 3), row('pkg/geometry.py', 11, 4), row('not/in/workspace.py', 1, 5)];
    const res = await createLocalizer().localize({ ask, task: 'fix distance', files, failures: [GEOMETRY_FAILURE], traceback: GEOMETRY_TRACEBACK, sbfl, signal: signal(), budget: { maxRequests: 20 } });
    const replace = res.sites.filter((s) => s.kind === 'replace');
    // Jev anchors first (line 15 top), then the SBFL top-3 (17, 16 in geometry; 12 in utils; rank 4 excluded)
    expect(`${replace[0]!.file.path}:${replace[0]!.line}`).toBe('pkg/geometry.py:15');
    const sbflAnchored = replace.filter((s) => s.evidence.notes.some((n) => n.startsWith('sbfl rank'))).map((s) => `${s.file.path}:${s.line}`);
    expect(sbflAnchored.sort()).toEqual(['pkg/geometry.py:16', 'pkg/geometry.py:17', 'pkg/utils.py:12']);
    // the SBFL anchors come right after the Jev anchors, before any window neighbour
    const firstNeighbour = res.sites.findIndex((s) => s.evidence.notes.some((n) => n.startsWith('within ')));
    const lastSbflAnchor = Math.max(...res.sites.map((s, i) => (s.kind === 'replace' && s.evidence.notes.some((n) => n.startsWith('sbfl rank')) ? i : -1)));
    expect(lastSbflAnchor).toBeLessThan(firstNeighbour);
    const l17 = replace.find((s) => s.line === 17 && s.file.path === 'pkg/geometry.py')!;
    expect(l17.evidence.sbflRank).toBe(1);
    expect(l17.evidence.notes).toContain('sbfl rank 1');
    expect(l17.evidence.notes).toContain('in traceback');
    expect(l17.evidence.jevProbability).toBeDefined(); // it was an option of the same Choice
    expect(l17.block!.name).toBe('Point.distance');
    const u12 = replace.find((s) => s.file.path === 'pkg/utils.py' && s.line === 12)!;
    expect(u12.block!.name).toBe('mean');
    expect(u12.evidence.jevProbability).toBeUndefined();
    // rank 4 is outside the SBFL top-3: never an anchor (no note), though a site that happens to cover it still shows its rank as evidence
    expect(res.sites.some((s) => s.evidence.notes.includes('sbfl rank 4'))).toBe(false);
    const l11 = res.sites.find((s) => s.file.path === 'pkg/geometry.py' && s.line === 11 && s.kind === 'replace');
    if (l11 !== undefined) expect(l11.evidence.sbflRank).toBe(4);
    // insert gaps exist around every anchor
    expect(res.sites.filter((s) => s.kind === 'insert' && s.file.path === 'pkg/geometry.py').map((s) => s.line)).toEqual(expect.arrayContaining([15, 16, 17, 18]));
  });
});
