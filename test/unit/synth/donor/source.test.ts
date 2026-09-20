/**
 * Donor source acceptance: the 4 QuixBugs insertion fixes have a donor/statement candidate,
 * the ladder `units` body is rebuilt from its sibling parse_size after identifier adaptation,
 * candidates are capped, deterministic, indented and syntactically filtered.
 */
import { describe, expect, it } from 'vitest';
import { createDonorSource } from '../../../../src/synth/donor/source.js';
import type { Candidate } from '../../../../src/synth/types.js';
import { applyCandidate } from '../../../../src/synth/verify/apply.js';
import { enumerateOptions, ladderTasks, makeSite, quixbugsCorpus, quixbugsCorrect, quixbugsIndex, sourceFile } from './helpers.js';

const source = createDonorSource();
const corpus = quixbugsCorpus();

function indentOfFixed(correct: string, fixed: string): string {
  const line = correct.split('\n').find((l) => l.trim() === fixed);
  if (line === undefined) throw new Error(`fixed line not in correct program: ${fixed}`);
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

function rankOf(cands: readonly Candidate[], text: string): number {
  return cands.findIndex((c) => c.text === text) + 1;
}

describe('QuixBugs insertion fixes have a donor / statement candidate', () => {
  const insertions = quixbugsIndex().filter((r) => r.buggyLine === null);
  it('covers the four insertion programs', () => {
    expect(insertions.map((r) => r.name).sort()).toEqual(['depth_first_search', 'reverse_linked_list', 'shunting_yard', 'wrap']);
  });
  for (const r of insertions) {
    it(`${r.name}: ${r.fixedLine}`, () => {
      const file = corpus.get(`${r.name}.py`)!;
      const indent = indentOfFixed(quixbugsCorrect(r.name), r.fixedLine);
      const site = makeSite(file, { kind: 'insert', line: r.bugLine, indent });
      const cands = source.enumerate(site, enumerateOptions(corpus, { cap: 400 }));
      const want = indent + r.fixedLine;
      const rank = rankOf(cands, want);
      expect(rank, `${r.name}: ${want} not among ${cands.length} candidates; first: ${cands.slice(0, 5).map((c) => c.text.trim()).join(' | ')}`).toBeGreaterThan(0);
      const c = cands[rank - 1]!;
      expect(c.source).toBe('donor');
      expect(['statement_donor', 'same_shape_rebind', 'near_duplicate_rebind']).toContain(c.op);
      expect(c.extraEdits).toBeUndefined();
    });
  }
  it('own-function donors come before corpus donors (reverse_linked_list, wrap, shunting_yard need no other file)', () => {
    for (const name of ['reverse_linked_list', 'wrap', 'shunting_yard']) {
      const r = insertions.find((x) => x.name === name)!;
      const file = corpus.get(`${name}.py`)!;
      const indent = indentOfFixed(quixbugsCorrect(name), r.fixedLine);
      const own = new Map([[file.path, file]]);
      const cands = source.enumerate(makeSite(file, { kind: 'insert', line: r.bugLine, indent }), enumerateOptions(own, { cap: 60 }));
      expect(rankOf(cands, indent + r.fixedLine), name).toBeGreaterThan(0);
    }
  });
});

describe('ladder `units`: parse_duration body from the sibling parse_size', () => {
  const units = ladderTasks().find((t) => t.name === 'units')!;
  const file = units.files.get('src/units.py')!;
  const gold = units.gold.get('src/units.py')!.split('\n');
  const goldBody = gold.slice(gold.indexOf('def parse_duration(text: str) -> int:') + 2, gold.indexOf('def parse_duration(text: str) -> int:') + 7);
  const buggyStart = file.mod.lines.indexOf('    text = text.strip()') + 1;
  const opts = enumerateOptions(units.files, { cap: 200, taskIdentifiers: ['parse_duration', 'parse_size'] });

  it('locates the buggy body and the five gold lines', () => {
    expect(buggyStart).toBe(24);
    expect(goldBody).toEqual([
      '    text = text.strip().lower().replace(" ", "")',
      '    for unit in sorted(DURATION_UNITS, key=len, reverse=True):',
      '        if text.endswith(unit):',
      '            return int(float(text[: -len(unit)]) * DURATION_UNITS[unit])',
      '    return int(text)',
    ]);
  });

  it('gold line 1 (upper → lower) is a near-duplicate rebind of the first parse_size line', () => {
    const cands = source.enumerate(makeSite(file, { kind: 'replace', line: buggyStart }), opts);
    const rank = rankOf(cands, goldBody[0]!);
    expect(rank).toBeGreaterThan(0);
    const c = cands[rank - 1]!;
    expect(c.op).toBe('near_duplicate_rebind');
    expect(rank).toBeLessThanOrEqual(10);
  });

  it('gold lines 2–4 (SIZE_UNITS → DURATION_UNITS) come as one for-block statement donor replacing the second line', () => {
    const cands = source.enumerate(makeSite(file, { kind: 'replace', line: buggyStart + 1 }), opts);
    const rank = rankOf(cands, goldBody[1]!);
    expect(rank).toBeGreaterThan(0);
    const c = cands[rank - 1]!;
    expect(c.op).toBe('statement_donor');
    expect(c.extraEdits?.map((e) => e.text)).toEqual([goldBody[2], goldBody[3]]);
    // applyCandidate numbers edits against the original file and keeps list order at one line: the
    // whole body goes right after the replaced header (original line buggyStart + 2), in order
    expect(c.extraEdits?.map((e) => [e.kind, e.line])).toEqual([['insert', buggyStart + 2], ['insert', buggyStart + 2]]);
    // the identity copy (still SIZE_UNITS) is also offered, ranked ahead: the tests, not the enumeration, decide
    expect(rankOf(cands, '    for unit in sorted(SIZE_UNITS, key=len, reverse=True):')).toBeGreaterThan(0);
  });

  it('gold lines 3–4 replace the wrong return with the adapted if-block (at the site indent)', () => {
    const cands = source.enumerate(makeSite(file, { kind: 'replace', line: buggyStart + 2 }), opts);
    const matches = cands.filter((c) => c.text === `    ${goldBody[2]!.trim()}`);
    expect(matches.length).toBeGreaterThan(0);
    // the body travels one level deeper than the header, with the same SIZE_UNITS → DURATION_UNITS mapping
    expect(matches.map((c) => c.extraEdits?.map((e) => e.text))).toContainEqual([`        ${goldBody[3]!.trim()}`]);
    expect(matches.every((c) => c.op === 'statement_donor')).toBe(true);
  });

  it('gold line 5 is an insert candidate after the body (identity statement donor)', () => {
    const cands = source.enumerate(makeSite(file, { kind: 'insert', line: buggyStart + 3, indent: '    ', scopeLine: buggyStart + 2 }), opts);
    const rank = rankOf(cands, goldBody[4]!);
    expect(rank).toBeGreaterThan(0);
    expect(cands[rank - 1]!.op).toBe('statement_donor');
  });
});

describe('enumeration contract', () => {
  const file = corpus.get('wrap.py')!;
  it('never returns the unchanged line, indents with the site, dedupes texts and is deterministic', () => {
    const site = makeSite(file, { kind: 'replace', line: 8 });
    const a = source.enumerate(site, enumerateOptions(corpus, { cap: 100 }));
    const b = createDonorSource().enumerate(site, enumerateOptions(corpus, { cap: 100 }));
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(a.length).toBeLessThanOrEqual(100);
    expect(a.length).toBeGreaterThan(10);
    expect(new Set(a.map((c) => c.text)).size).toBe(a.length);
    for (const c of a) {
      expect(c.text).not.toBe(site.currentLine);
      expect(c.text.startsWith('        ')).toBe(true);
      expect(c.site).toBe(site);
      expect(c.source).toBe('donor');
      expect(c.prior).toBeGreaterThan(0);
      expect(c.prior).toBeLessThanOrEqual(1);
    }
    expect(a[0]!.op).toBe('same_shape_rebind');
    expect(a.map((c) => c.text.trim())).toContain('lines.append(text)');
  });
  it('caps and keeps the prefix order under a smaller cap; ids are stable across caps', () => {
    const site = makeSite(file, { kind: 'replace', line: 8 });
    const big = source.enumerate(site, enumerateOptions(corpus, { cap: 80 }));
    const small = source.enumerate(site, enumerateOptions(corpus, { cap: 7 }));
    expect(small.length).toBe(7);
    expect(small.map((c) => c.id)).toEqual(big.slice(0, 7).map((c) => c.id));
    expect(source.enumerate(site, enumerateOptions(corpus, { cap: 0 }))).toEqual([]);
  });
  it('drops a bodiless compound header where the next line is not indented under it', () => {
    const f = sourceFile('t.py', 'def f(xs):\n    total = 0\n    for x in xs:\n        total += x\n    return total\n\n\ndef g(ys):\n    n = 0\n    for y in ys:\n        n += y\n    return n\n');
    const own = new Map([[f.path, f]]);
    const cands = source.enumerate(makeSite(f, { kind: 'replace', line: 5 }), enumerateOptions(own, { cap: 100 }));
    expect(cands.some((c) => /^\s*for\b.*:$/.test(c.text))).toBe(true);
    for (const c of cands) {
      if (/^\s*(for|if|while)\b.*:$/.test(c.text)) expect(c.extraEdits?.length ?? 0, c.text).toBeGreaterThan(0);
    }
    // a header site accepts bodiless header donors (same-shape rebinds of g's loop header)
    const hc = source.enumerate(makeSite(f, { kind: 'replace', line: 3 }), enumerateOptions(own, { cap: 100 }));
    expect(hc.some((c) => /^\s*for .*:$/.test(c.text) && c.extraEdits === undefined && c.op === 'same_shape_rebind')).toBe(true);
  });
  it('carries the continuation lines of a bracketed statement donor as extraEdits, and skips it when too long', () => {
    const src = ['LIMIT = 10', '', 'def f(xs):', '    total = min(', '        len(xs),', '        LIMIT)', '    return total', '', '', 'def g(ys):', '    n = 0', '    return n', ''].join('\n');
    const f = sourceFile('m.py', src);
    const own = new Map([[f.path, f]]);
    const site = makeSite(f, { kind: 'insert', line: 12, indent: '    ' });
    const cands = source.enumerate(site, enumerateOptions(own, { cap: 200 }));
    const heads = cands.filter((c) => c.text === '    n = min(');
    expect(heads.length).toBeGreaterThan(0);
    expect(heads.map((c) => c.extraEdits?.map((e) => e.text))).toContainEqual(['        len(ys),', '        LIMIT)']);
    // every continuation line is numbered against the ORIGINAL file at the insert line itself
    // (applyCandidate keeps list order there), so the statement lands whole before original line 12
    expect(heads[0]!.extraEdits?.map((e) => [e.kind, e.line, e.path])).toEqual([['insert', 12, 'm.py'], ['insert', 12, 'm.py']]);
    const applied = applyCandidate(heads[0]!);
    expect(applied.files[0]!.after.split('\n').slice(9, 14)).toEqual(['def g(ys):', '    n = 0', '    n = min(', '        len(ys),', '        LIMIT)']);
    // no candidate is ever the bare first line of a multi-line statement
    for (const c of cands) if (c.text.trimEnd().endsWith('(')) expect(c.extraEdits?.length ?? 0, c.text).toBeGreaterThan(0);
    const tight = createDonorSource({ maxBodyLines: 1 }).enumerate(site, enumerateOptions(own, { cap: 200 }));
    expect(tight.some((c) => c.text.includes('min('))).toBe(false);
  });
  it('bounds own-file statement donors by maxFileStatements and keeps the enclosing function unbounded', () => {
    const fns = Array.from({ length: 30 }, (_, i) => `def h${i}(v):\n    w = v + ${i}\n    return w\n`).join('\n');
    const src = `${fns}\ndef target(v):\n    w = v\n    return w\n`;
    const f = sourceFile('many.py', src);
    const own = new Map([[f.path, f]]);
    const line = f.mod.lines.lastIndexOf('    return w') + 1; // `    return w` of target
    const site = makeSite(f, { kind: 'insert', line, indent: '    ' });
    const loose = source.enumerate(site, enumerateOptions(own, { cap: 1000 })).filter((c) => c.op === 'statement_donor');
    const bounded = createDonorSource({ maxFileStatements: 2 }).enumerate(site, enumerateOptions(own, { cap: 1000 })).filter((c) => c.op === 'statement_donor');
    expect(loose.length).toBeGreaterThan(bounded.length);
    // the own-function donor (`w = v`, adapted) survives any file bound
    expect(bounded.map((c) => c.text)).toContain('    v = w');
    expect(bounded.length).toBeLessThanOrEqual(1 + 2 * 12 + 12);
  });
  it('adds same-family swaps after the primaries', () => {
    const gcd = corpus.get('gcd.py')!;
    const line = gcd.mod.lines.findIndex((l) => l.includes('return gcd(')) + 1;
    const cands = source.enumerate(makeSite(gcd, { kind: 'replace', line }), enumerateOptions(new Map([[gcd.path, gcd]]), { cap: 200 }));
    const swaps = cands.filter((c) => c.op === 'family_swap');
    expect(swaps.length).toBeGreaterThan(0);
    const firstSwap = cands.findIndex((c) => c.op === 'family_swap');
    expect(cands.slice(0, firstSwap).every((c) => c.op !== 'family_swap')).toBe(true);
  });
  it('uses the site file over a stale corpus copy under the same path', () => {
    const stale = new Map(corpus);
    stale.set('wrap.py', sourceFile('wrap.py', 'def wrap(text, cols):\n    return None\n'));
    const site = makeSite(file, { kind: 'replace', line: 8 });
    const cands = source.enumerate(site, enumerateOptions(stale, { cap: 100 }));
    expect(cands.map((c) => c.text.trim())).toContain('lines.append(text)');
  });
});
