import { describe, expect, it } from 'vitest';
import { buildDonorIndex, indexFile } from '../../../../src/synth/donor/corpus.js';
import { normaliseLine } from '../../../../src/synth/py/similarity.js';
import { ladderTasks, quixbugsCorpus, sourceFile } from './helpers.js';

describe('buildDonorIndex on the QuixBugs programs and the ladder tasks', () => {
  const corpus = quixbugsCorpus();
  const index = buildDonorIndex(corpus);

  it('indexes every code line of all 40 programs (+ node.py) under its normalised shape', () => {
    expect(corpus.size).toBe(41);
    expect(index.files.size).toBe(41);
    expect(index.lines.length).toBeGreaterThan(400);
    for (const l of index.lines) {
      expect(l.text).toBe(l.text.trim());
      expect(l.shape).toBe(normaliseLine(l.text).join(' '));
      expect(index.byShape.get(l.shape)).toContain(l);
    }
    const total = [...index.byShape.values()].reduce((n, b) => n + b.length, 0);
    expect(total).toBe(index.lines.length);
  });

  it('groups lines of the same shape across programs and reports the frequency', () => {
    const shape = normaliseLine('nodesseen.add(startnode)').join(' ');
    const donors = index.byShape.get(shape) ?? [];
    expect(donors.map((d) => `${d.path}:${d.text}`)).toEqual(expect.arrayContaining(['breadth_first_search.py:nodesseen.add(startnode)', 'shortest_path_length.py:visited_nodes.add(node)', 'wrap.py:lines.append(line)', 'shunting_yard.py:rpntokens.append(token)']));
    expect(index.shapeFrequency(shape)).toBe(donors.length);
    expect(index.shapeFrequency('no such shape')).toBe(0);
  });

  it('records block, statement kind, header flag and identifiers per line', () => {
    const wrap = index.files.get('wrap.py')!;
    const header = wrap.find((l) => l.text.startsWith('while len(text) > cols'))!;
    expect(header.block?.name).toBe('wrap');
    expect(header.statementKind).toBe('while');
    expect(header.isHeader).toBe(true);
    expect(header.identifiers).toEqual(['len', 'text', 'cols']);
    const append = wrap.find((l) => l.text === 'lines.append(line)')!;
    expect(append.isHeader).toBe(false);
    expect(append.startsStatement).toBe(true);
    expect(append.identifiers).toEqual(['lines', 'line']);
    expect(append.attributes).toEqual(['append']);
  });

  it('skips blank, comment-only, docstring-only and bare-bracket lines; keeps continuation lines', () => {
    const f = sourceFile('t.py', '"""Doc."""\n\n# comment\nx = [\n    1,\n    2,\n]\ndef f():\n    """Inner doc."""\n    return (\n        x\n    )\n');
    const lines = indexFile(f);
    expect(lines.map((l) => [l.line, l.text, l.startsStatement])).toEqual([
      [4, 'x = [', true],
      [8, 'def f():', true],
      [10, 'return (', true],
      [11, 'x', false],
    ]);
  });

  it('indexes every ladder task file and finds the units donor shapes', () => {
    const tasks = ladderTasks();
    expect(tasks.length).toBe(12);
    for (const t of tasks) {
      const idx = buildDonorIndex(t.files);
      expect(idx.files.size).toBe(t.files.size);
      expect(idx.lines.length).toBeGreaterThan(10);
    }
    const units = tasks.find((t) => t.name === 'units')!;
    const idx = buildDonorIndex(units.files);
    expect(idx.shapeFrequency(normaliseLine('return int(text)').join(' '))).toBe(1);
    expect(idx.byShape.get(normaliseLine('for unit in sorted(SIZE_UNITS, key=len, reverse=True):').join(' '))?.map((l) => l.line)).toEqual([16]);
  });

  it('reuses the index for an unchanged corpus map and rebuilds when a file changes', () => {
    const again = buildDonorIndex(corpus);
    expect(again).toBe(index);
    const mutated = new Map(corpus);
    mutated.set('gcd.py', sourceFile('gcd.py', 'def gcd(a, b):\n    return a\n'));
    const rebuilt = buildDonorIndex(mutated);
    expect(rebuilt).not.toBe(index);
    expect(rebuilt.files.get('gcd.py')?.map((l) => l.text)).toEqual(['def gcd(a, b):', 'return a']);
    // the first file under a path wins so the site's fresh copy beats a stale corpus entry
    const fresh = sourceFile('gcd.py', 'def gcd(a, b):\n    return b\n');
    const combined = buildDonorIndex([fresh, ...corpus.values()]);
    expect(combined.files.get('gcd.py')?.map((l) => l.text)).toEqual(['def gcd(a, b):', 'return b']);
  });
});
