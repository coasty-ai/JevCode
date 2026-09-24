/**
 * The `sbflAnchors` addition to localize/sites.ts: SBFL top-k lines the Jev anchors do not cover
 * become replace sites of their own, after every Jev-derived site, by rank; `def` lines and lines
 * outside the given files are skipped; 5 on a single file, 3 on a repository.
 */
import { describe, expect, it } from 'vitest';
import { functionEntries } from '../../../../../src/jev-modes/synth/localize/outline.js';
import { SBFL_ANCHORS_REPO, SBFL_ANCHORS_SINGLE_FILE, buildSites, isDefLine, sbflAnchorsFor, sbflKey, sbflOnlySites } from '../../../../../src/jev-modes/synth/localize/sites.js';
import type { Anchor } from '../../../../../src/jev-modes/synth/localize/sites.js';
import type { RankedLine } from '../../../../../src/jev-modes/synth/sbfl/types.js';
import { fixtureFile } from './sites-composite.helpers.js';

const file = fixtureFile('twofn.py');
const files = new Map([[file.path, file]]);
const entries = functionEntries(file);
const wrap = entries.find((e) => e.qualname === 'wrap')!;

function sbflMap(rows: readonly [line: number, score: number][], path = file.path): Map<string, RankedLine> {
  const m = new Map<string, RankedLine>();
  rows.forEach(([line, score], i) => m.set(sbflKey(path, line), { rank: i + 1, file: path, line, ef: 1, ep: 0, score, scores: { ochiai: score, tarantula: score, dstar: score } }));
  return m;
}

describe('sbflAnchors option', () => {
  const anchor: Anchor = { file, line: 9, entry: wrap, jevProbability: 0.5, lineProbabilities: new Map([[9, 0.5], [8, 0.2]]), notes: ['jev anchor #1 in wrap'] };

  it('appends SBFL-only replace sites after the Jev sites, by rank, skipping covered lines and def lines', () => {
    // rank 1 L9 (the anchor), rank 2 L1 (`def wrap`), rank 3 L4, rank 4 L13, rank 5 L2, rank 6 L7
    const sbfl = sbflMap([[9, 1], [1, 0.9], [4, 0.8], [13, 0.7], [2, 0.6], [7, 0.5]]);
    const sites = buildSites({ anchors: [anchor], sbfl, frames: [], window: 1, sbflAnchors: 4, files });
    const keys = sites.map((s) => `${s.line}:${s.kind}`);
    // anchor, its gaps, the ±1 neighbours, then SBFL-only: L4, L13 and L2 (L9 covered, L1 a def line; four rows considered → three sites)
    expect(keys).toEqual(['9:replace', '9:insert', '10:insert', '8:replace', '4:replace', '13:replace', '2:replace']);
    const l13 = sites.find((s) => s.line === 13)!;
    expect(l13.block).toEqual({ name: 'gcd', startLine: 12, endLine: 15 });
    expect(l13.evidence).toEqual({ sbflRank: 4, sbflScore: 0.7, notes: ['sbfl rank 4'] });
    expect(l13.evidence.jevProbability).toBeUndefined();
    expect(sites.find((s) => s.line === 4)!.currentLine).toBe("        end = text.rfind(' ', 0, cols + 1)");
  });

  it('without the option, or without files, buildSites is unchanged', () => {
    const sbfl = sbflMap([[4, 0.8]]);
    expect(buildSites({ anchors: [anchor], sbfl, frames: [], window: 0 }).map((s) => s.line)).toEqual([9, 9, 10]);
    expect(buildSites({ anchors: [anchor], sbfl, frames: [], window: 0, sbflAnchors: 3 }).map((s) => s.line)).toEqual([9, 9, 10]);
    expect(sbflOnlySites({ anchors: [], sbfl, frames: [], window: 0, files }, 0, new Set())).toEqual([]);
  });

  it('ignores rows whose path is not in files and takes exactly k usable rows', () => {
    const sbfl = new Map([...sbflMap([[4, 0.9], [7, 0.8], [2, 0.7]]), ...sbflMap([[3, 0.95]], 'elsewhere.py')]);
    const sites = sbflOnlySites({ anchors: [], sbfl, frames: [], window: 0, files }, 2, new Set());
    expect(sites.map((s) => [s.file.path, s.line])).toEqual([['twofn.py', 4], ['twofn.py', 7]]);
  });

  it('isDefLine covers the def header lines of both functions and nothing else', () => {
    expect([1, 12].every((l) => isDefLine(file, l))).toBe(true);
    expect([2, 9, 13, 15].some((l) => isDefLine(file, l))).toBe(false);
  });

  it('5 on a single file, 3 on a repository', () => {
    expect(sbflAnchorsFor(1)).toBe(SBFL_ANCHORS_SINGLE_FILE);
    expect(sbflAnchorsFor(2)).toBe(SBFL_ANCHORS_REPO);
    expect(sbflAnchorsFor(40)).toBe(3);
    expect(SBFL_ANCHORS_SINGLE_FILE).toBe(5);
  });
});
