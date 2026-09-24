/**
 * Composite source (design §3 source 4): the ladder `table` signature + call-site unit and the
 * ladder `units` donor body unit reproduce the gold files as ONE candidate each (applied through
 * the real applyCandidate); depth-2 pairs compose two token edits, never repeat a single edit,
 * stay under the cap and are deterministic.
 */
import { describe, expect, it } from 'vitest';
import {
  CALL_SITE_STATEMENT_CAP,
  DONOR_UNIT_LIMIT,
  SECOND_ORDER_LIMIT,
  SECOND_ORDER_SEEDS,
  UNIT_DEADLINE_MS,
  addedParameter,
  callIndexOf,
  createCompositeSource,
  derivedSite,
  donorWindows,
  enumerateSignatureUnits,
  scanBudget,
  statementRuns,
} from '../../../../../src/jev-modes/synth/search/composite.js';
import { createMutationSource } from '../../../../../src/jev-modes/synth/mutate/index.js';
import { createTemplateSource } from '../../../../../src/jev-modes/synth/templates/index.js';
import type { Candidate, SourceFile } from '../../../../../src/jev-modes/synth/types.js';
import { applyCandidate } from '../../../../../src/jev-modes/synth/verify/apply.js';
import { enumerateOptions, ladderTask, sf, siteAt } from './sites-composite.helpers.js';

const source = createCompositeSource();

function appliesToGold(c: Candidate, files: ReadonlyMap<string, SourceFile>, gold: ReadonlyMap<string, string>): boolean {
  const applied = applyCandidate(c, files);
  return applied.files.every((f) => f.after === gold.get(f.path));
}

describe('ladder `table`: signature + call-site unit across two files', () => {
  const { files, gold } = ladderTask('table', ['src/fmt.py', 'src/table.py']);
  const fmt = files.get('src/fmt.py')!;
  const table = files.get('src/table.py')!;
  const opts = enumerateOptions(files, { testLiterals: ['"-"', '"."'], taskIdentifiers: ['pad', 'fill', 'render'] });
  /** `                cells.append(pad(cell, width))` */
  const CALL_LINE = table.mod.lines.findIndex((l) => l.includes('cells.append(pad(cell, width))')) + 1;
  /** `    return text + " " * (width - len(text))` */
  const BODY_LINE = fmt.mod.lines.findIndex((l) => l.includes('return text + " " *')) + 1;

  it('from the call site in table.py: the site passes `fill`, the header and body of fmt.pad travel as extra edits', () => {
    const cands = source.enumerateSignatureUnits(siteAt(table, CALL_LINE), opts);
    const golds = cands.filter((c) => appliesToGold(c, files, gold));
    expect(golds).toHaveLength(1);
    const g = golds[0]!;
    expect(g.text).toBe('                cells.append(pad(cell, width, fill))');
    expect(g.op).toBe('signature_unit:add_param_sibling_with_edits:from_call');
    expect(g.source).toBe('composite');
    expect(g.extraEdits).toEqual([
      { path: 'src/fmt.py', line: 6, kind: 'replace', text: 'def pad(text: str, width: int, fill: str = " ") -> str:' },
      { path: 'src/fmt.py', line: 10, kind: 'replace', text: '    return text + fill * (width - len(text))' },
    ]);
    // the gold is the first unit: the sibling `pad_left` shares `text` and `width`, so its `fill` outranks test-named parameters
    expect(cands[0]!.id).toBe(g.id);
    // the composite source as a whole offers it too
    expect(source.enumerate(siteAt(table, CALL_LINE), opts).some((c) => c.id === g.id)).toBe(true);
  });

  it('from the body line in fmt.py: the site line is rewritten, the header and the table.py call site travel', () => {
    const cands = source.enumerateSignatureUnits(siteAt(fmt, BODY_LINE), opts);
    const golds = cands.filter((c) => appliesToGold(c, files, gold));
    expect(golds).toHaveLength(1);
    const g = golds[0]!;
    expect(g.text).toBe('    return text + fill * (width - len(text))');
    expect(g.op).toBe('signature_unit:add_param_sibling_with_edits:from_body');
    expect(g.extraEdits?.map((e) => `${e.path}:${e.line}`)).toEqual(['src/fmt.py:6', 'src/table.py:43']);
    expect(g.extraEdits?.[1]?.text).toBe('                cells.append(pad(cell, width, fill))');
  });

  it('from another body line of pad: the site line is left as is and the whole unit rides on extraEdits', () => {
    const cands = source.enumerateSignatureUnits(siteAt(fmt, BODY_LINE - 1), opts);
    const golds = cands.filter((c) => appliesToGold(c, files, gold));
    expect(golds).toHaveLength(1);
    expect(golds[0]!.text).toBe(fmt.mod.lines[BODY_LINE - 2]);
    expect(golds[0]!.extraEdits).toHaveLength(3);
  });

  it('only threads a value that is in scope at the call site; `pad_left` already has `fill`', () => {
    // render_dicts calls render(...) with **kwargs: no `fill` in scope there, so no call-site edit for it
    const cands = source.enumerateSignatureUnits(siteAt(fmt, BODY_LINE), opts);
    for (const c of cands) for (const e of c.extraEdits ?? []) expect(e.path === 'src/table.py' ? e.line : 43).toBe(43);
    // a site inside pad_left (which has `fill`) yields no unit whose header re-adds `fill`
    const padLeftBody = fmt.mod.lines.findIndex((l) => l.includes('return fill * (width - len(text)) + text')) + 1;
    expect(source.enumerateSignatureUnits(siteAt(fmt, padLeftBody), opts).some((c) => (c.extraEdits ?? []).some((e) => e.text?.includes('fill: str = " ", fill')))).toBe(false);
  });

  it('addedParameter names the one new parameter and whether it has a default', () => {
    const pad = fmt.mod.blocks.find((b) => b.name === 'pad')!;
    expect(addedParameter(pad, 'def pad(text: str, width: int, fill: str = " ") -> str:')).toEqual({ name: 'fill', hasDefault: true });
    expect(addedParameter(pad, 'def pad(text: str, width: int, sep) -> str:')).toEqual({ name: 'sep', hasDefault: false });
    expect(addedParameter(pad, 'def pad(text: str, width: int) -> str:')).toBeNull();
    expect(addedParameter(pad, 'def pad(text: str, width: int, a, b) -> str:')).toBeNull();
  });
});

describe('ladder `units`: multi-line donor body unit from the sibling parse_size', () => {
  const { files, gold } = ladderTask('units', ['src/units.py']);
  const units = files.get('src/units.py')!;
  const opts = enumerateOptions(files, { taskIdentifiers: ['parse_duration', 'parse_size'] });
  /** `    text = text.strip()`, the first body line of parse_duration */
  const START = units.mod.lines.indexOf('    text = text.strip()') + 1;

  it('one candidate replaces the three-line body with the adapted five-line sibling body and reproduces the gold file', () => {
    const cands = source.enumerateDonorBodyUnits(siteAt(units, START), opts);
    expect(cands.length).toBeLessThanOrEqual(DONOR_UNIT_LIMIT);
    const golds = cands.filter((c) => appliesToGold(c, files, gold));
    expect(golds).toHaveLength(1);
    const g = golds[0]!;
    expect(g.text.split('\n')).toEqual([
      '    text = text.strip().lower().replace(" ", "")',
      '    for unit in sorted(DURATION_UNITS, key=len, reverse=True):',
      '        if text.endswith(unit):',
      '            return int(float(text[: -len(unit)]) * DURATION_UNITS[unit])',
      '    return int(text)',
    ]);
    // the run's other two lines are deleted; numbers refer to the file before the edit
    expect(g.extraEdits).toEqual([
      { path: 'src/units.py', line: START + 1, kind: 'delete' },
      { path: 'src/units.py', line: START + 2, kind: 'delete' },
    ]);
    expect(g.op).toBe('donor_body_unit:parse_size:3stmt');
    // every unit of the best window shares the structural match: same statement count, both function tails
    expect(cands[0]!.op).toBe('donor_body_unit:parse_size:3stmt');
    expect(cands.every((c) => c.source === 'composite' && c.site.line === START)).toBe(true);
  });

  it('statement runs and donor windows are the structural units behind it', () => {
    const parseDuration = units.mod.blocks.find((b) => b.name === 'parse_duration')!;
    const runs = statementRuns(units.mod, parseDuration, START, 5);
    expect(runs.map((r) => [r.statements.length, r.startLine, r.endLine, r.isTail])).toEqual([
      [1, START, START, false],
      [2, START, START + 1, false],
      [3, START, START + 2, true],
    ]);
    const parseSize = units.mod.blocks.find((b) => b.name === 'parse_size')!;
    const windows = donorWindows(units, parseSize, '    ');
    // 3–5 code lines: the for-block alone (3), text+for (4), for+return (4), the whole body (5); the docstring never donates
    expect(windows.map((w) => [w.startLine, w.endLine, w.statementCount, w.isTail])).toEqual([
      [15, 18, 2, false],
      [15, 19, 3, true],
      [16, 18, 1, false],
      [16, 19, 2, true],
    ]);
    expect(windows.every((w) => !w.text.includes('"""'))).toBe(true);
    // a site that does not start a statement of the def yields nothing
    expect(statementRuns(units.mod, parseDuration, START + 100, 5)).toEqual([]);
    expect(source.enumerateDonorBodyUnits(siteAt(units, 1), opts)).toEqual([]);
  });
});

describe('depth-2 pairs', () => {
  const f = sf('m.py', ['def f(xs, k):', '    total = 0', '    for x in xs:', '        total = total + k', '    return total', ''].join('\n'));
  const opts = enumerateOptions(new Map([[f.path, f]]), { testLiterals: ['1'] });
  const site = siteAt(f, 4);
  const mutation = createMutationSource();

  it('composes two token edits on disjoint spans, never repeats a single edit, stays under the cap and is deterministic', () => {
    const pairs = source.enumeratePairs(site, opts);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.length).toBeLessThanOrEqual(SECOND_ORDER_LIMIT);
    // `total = total + k` → `total = total - x`: an arithmetic swap plus an identifier substitution
    const gold = pairs.find((c) => c.text === '        total = total - x');
    expect(gold).toBeDefined();
    expect(gold!.op).toMatch(/^pair:[a-z_]+>[a-z_]+$/);
    expect(gold!.source).toBe('composite');
    expect(gold!.prior).toBeLessThan(0.5);
    const singles = new Set([mutation, createTemplateSource()].flatMap((s) => s.enumerate(site, { ...opts, cap: 254 })).map((c) => c.text));
    expect(pairs.every((c) => !singles.has(c.text) && c.text !== site.currentLine)).toBe(true);
    expect(new Set(pairs.map((c) => c.text)).size).toBe(pairs.length);
    expect(source.enumeratePairs(site, opts).map((c) => c.id)).toEqual(pairs.map((c) => c.id));
    // at most SECOND_ORDER_SEEDS distinct first edits, taken round-robin across the sources
    expect(new Set(pairs.map((c) => c.op.split('>')[0])).size).toBeLessThanOrEqual(SECOND_ORDER_SEEDS);
  });

  it('a second edit on the same token span as the first is just another single and is dropped', () => {
    const pairs = source.enumeratePairs(site, opts);
    // `+` → `-` then `-` → `*` would land on `total = total * k`, a first-order mutant
    expect(pairs.some((c) => c.text === '        total = total * k')).toBe(false);
  });

  it('derivedSite re-analyses the file with the new line; multi-line texts and insert sites are not seeds', () => {
    const d = derivedSite(site, '        total = total - k')!;
    expect(d.currentLine).toBe('        total = total - k');
    expect(d.file.mod.lines[3]).toBe('        total = total - k');
    expect(d.file.path).toBe(site.file.path);
    expect(d.line).toBe(site.line);
    expect(derivedSite(site, 'a\nb')).toBeNull();
    expect(derivedSite(siteAt(f, 4, 'insert'), 'x = 1')).toBeNull();
    expect(source.enumeratePairs(siteAt(f, 4, 'insert'), opts)).toEqual([]);
  });

  it('honours the options: limit, seeds and disabled parts', () => {
    const small = createCompositeSource({ secondOrderLimit: 7, secondOrderSeeds: 2 });
    const pairs = small.enumeratePairs(site, opts);
    expect(pairs.length).toBeLessThanOrEqual(7);
    expect(new Set(pairs.map((c) => c.op.split('>')[0])).size).toBeLessThanOrEqual(2);
    const noPairs = createCompositeSource({ pairs: false, donorUnits: false, signatureUnits: false });
    expect(noPairs.enumerate(site, opts)).toEqual([]);
    expect(noPairs.name).toBe('composite');
    // `opts.cap` cuts the combined enumeration
    expect(source.enumerate(site, { ...opts, cap: 3 })).toHaveLength(3);
  });
});

describe('statement-level sites (Site.endLine)', () => {
  const f = sf('h.py', ['class F:', '    def __hash__(self):', '        return hash((', '            self.a,', '            self.b if x else None,', '        ))', '', '    def other(self):', '        return 1', ''].join('\n'));
  const site = { ...siteAt(f, 3), currentLine: '        return hash((self.a, self.b if x else None))', endLine: 6 };
  const opts = enumerateOptions(new Map([[f.path, f]]));

  it('derivedSite replaces the whole span and yields a one-line site', () => {
    const d = derivedSite(site, '        return hash(self.a)')!;
    expect(d.endLine).toBeUndefined();
    expect(d.file.mod.lines.slice(2, 5)).toEqual(['        return hash(self.a)', '', '    def other(self):']);
    expect(d.currentLine).toBe('        return hash(self.a)');
  });

  it('pairs are enumerated on the joined statement and carry no extra edits; signature and donor-body units are not', () => {
    const pairs = source.enumeratePairs(site, opts);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.every((c) => c.site === site && c.extraEdits === undefined && !c.text.includes('\n'))).toBe(true);
    // every pair applies through the span: one line in place of four
    for (const c of pairs.slice(0, 20)) expect(applyCandidate(c).files[0]!.after.split('\n')).toHaveLength(7);
    expect(source.enumerateSignatureUnits(site, opts)).toEqual([]);
    expect(source.enumerateDonorBodyUnits(site, opts)).toEqual([]);
    expect(source.enumerate(site, opts).every((c) => c.op.startsWith('pair:'))).toBe(true);
  });
});

describe('signature units are bounded on a large corpus (swebench-reach-oracle-9.md hazard)', () => {
  /** 300 files, each with 40 one-line statements of which 10 call `helper(...)` with names in scope, plus the def's own file. */
  function corpus(): { files: Map<string, SourceFile>; core: SourceFile } {
    const core = sf('pkg/core.py', ['def helper(text, width):', '    pad = " "', '    return text + pad * (width - len(text))', '', 'def helper_left(text, width, fill=" "):', '    return fill * (width - len(text)) + text', ''].join('\n'));
    const files = new Map<string, SourceFile>([[core.path, core]]);
    for (let i = 0; i < 300; i++) {
      const lines = ['from pkg.core import helper', '', `def use_${i}(text, width, fill):`];
      for (let k = 0; k < 40; k++) lines.push(k % 4 === 0 ? `    v${k} = helper(text, width)` : `    v${k} = other_${k}(text, ${k})`);
      lines.push('    return fill', '');
      const path = `pkg/mod_${String(i).padStart(3, '0')}.py`;
      files.set(path, sf(path, lines.join('\n')));
    }
    return { files, core };
  }

  it('returns in under 2 s with the call-site index, complete threading across every file', () => {
    const { files, core } = corpus();
    const opts = enumerateOptions(files, { taskIdentifiers: ['helper', 'fill'] });
    const site = siteAt(core, 3);
    const t0 = Date.now();
    const units = enumerateSignatureUnits(site, opts);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(2000);
    expect(units.length).toBeGreaterThan(0);
    // the sibling's `fill` parameter is threaded through all 300 files x 10 call sites (+ the header)
    const fill = units.find((c) => c.op === 'signature_unit:add_param_sibling_with_edits:from_body' || c.op.includes('add_param_sibling'));
    expect(fill).toBeDefined();
    const callEdits = (fill!.extraEdits ?? []).filter((e) => e.path !== core.path);
    expect(callEdits).toHaveLength(3000);
    expect(callEdits[0]!.text).toContain('helper(text, width, fill)');
    // the index is built once per file object and lists the callee's lines
    const idx = callIndexOf(files.get('pkg/mod_000.py')!);
    expect(idx.get('helper')).toHaveLength(10);
    expect(callIndexOf(files.get('pkg/mod_000.py')!)).toBe(idx);
  });

  it('a spent budget cuts the scan and drops the half-threaded draft instead of offering it', () => {
    const { files, core } = corpus();
    const opts = enumerateOptions(files, { taskIdentifiers: ['helper'] });
    expect(enumerateSignatureUnits(siteAt(core, 3), opts, 20, scanBudget(UNIT_DEADLINE_MS, 5))).toEqual([]);
    expect(enumerateSignatureUnits(siteAt(core, 3), opts, 20, scanBudget(-1, CALL_SITE_STATEMENT_CAP))).toEqual([]);
    expect(createCompositeSource({ unitDeadlineMs: -1, pairs: false, donorUnits: false }).enumerate(siteAt(core, 3), opts)).toEqual([]);
  });
});
