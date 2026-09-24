/**
 * Hole questions: REPORT-compliant Choices (escape, semantic keys, backticked paths), the measured
 * state shape with the buggy line visible, leak-free one-template requests, width-2 sequential
 * filling with scripted answers, and both orders for same-family pairs.
 */
import { describe, expect, it } from 'vitest';
import { ESCAPE_KEY } from '../../../../../src/jev/questions.js';
import { AbortError } from '../../../../../src/errors.js';
import { COMMON_BUILTINS, HOLE_MARKER, MAX_HOLE_OPTIONS, fillHolesSequentially, holeIdentifierOptions, holeQuestion, holeQuestions, holeState, holeTemplate, identifierHoles, optionKey } from '../../../../../src/jev-modes/synth/donor/holes.js';
import type { HoleContext } from '../../../../../src/jev-modes/synth/donor/holes.js';
import type { Json, Question } from '../../../../../src/core/types.js';
import { enumerateOptions, holeTemplateOf, makeSite, quixbugsCorpus, scriptedAsk, sourceFile } from './helpers.js';

const corpus = quixbugsCorpus();
const bucketsort = corpus.get('bucketsort.py')!;
const BUGGY_LINE = bucketsort.mod.lines.findIndex((l) => l.includes('enumerate(arr)')) + 1;

function ctxFor(site: HoleContext['site'], ask: HoleContext['ask'], donor?: HoleContext['donor']): HoleContext {
  const ctx: HoleContext = {
    ask,
    task: 'The function `bucketsort` in `bucketsort.py` has a bug that makes some tests in tests/ fail.',
    failures: [{ testId: 'bucketsort_0', call: 'bucketsort([3, 11, 2, 9, 1, 5], 12)', expected: '[1, 2, 3, 5, 9, 11]', actual: '[]' }],
    functionListing: '',
    signal: new AbortController().signal,
    site,
  };
  if (donor !== undefined) ctx.donor = donor;
  return ctx;
}

function optionsOf(q: Question): Record<string, Json | null> {
  if (q.type !== 'choice') throw new Error('not a choice');
  return q.criteria;
}

describe('identifierHoles', () => {
  const site = makeSite(bucketsort, { kind: 'replace', line: BUGGY_LINE });
  it('one hole per distinct identifier over the in-scope names plus the common builtins; attributes only with a family', () => {
    const holes = identifierHoles('for i, count in enumerate(counts):', site.scope);
    expect(holes.map((h) => [h.key, h.name, h.kind, h.mustChange])).toEqual([
      ['hole_1', 'i', 'identifier', false],
      ['hole_2', 'count', 'identifier', false],
      ['hole_3', 'enumerate', 'identifier', false],
      ['hole_4', 'counts', 'identifier', false],
    ]);
    const values = Object.values(holes[0]!.options);
    expect(values).toEqual(expect.arrayContaining(['arr', 'k', 'counts', 'sorted_arr', 'i', 'count', 'x', ...COMMON_BUILTINS]));
    expect(new Set(values).size).toBe(values.length);
    for (const key of Object.keys(holes[0]!.options)) expect(key).toMatch(/^ident_[a-z0-9_]+$/);
    expect(identifierHoles('total = text.upper()', site.scope).map((h) => [h.name, h.kind])).toEqual([['total', 'identifier'], ['text', 'identifier'], ['upper', 'attribute']]);
    expect(identifierHoles('x.strip()', site.scope, { attributeFamilies: false }).map((h) => h.kind)).toEqual(['identifier']);
  });
  it('flags out-of-scope donor names as must-change and does not offer them', () => {
    const holes = identifierHoles('nodesseen.add(startnode)', site.scope);
    expect(holes.filter((h) => h.kind === 'identifier').every((h) => h.mustChange)).toBe(true);
    expect(Object.values(holes[0]!.options)).not.toContain('nodesseen');
  });
  it('treats True/False/None as holes over the in-scope names (the measured `while True:` → `while queue:` slot)', () => {
    const bfs = corpus.get('breadth_first_search.py')!;
    const line = bfs.mod.lines.findIndex((l) => l.includes('while True')) + 1;
    const bsite = makeSite(bfs, { kind: 'replace', line });
    const holes = identifierHoles('while True:', bsite.scope);
    expect(holes.map((h) => [h.name, h.mustChange])).toEqual([['True', false]]);
    expect(Object.values(holes[0]!.options)).toEqual(expect.arrayContaining(['queue', 'True']));
    expect(holeTemplate('while True:', holes, null, { hole_1: 'queue' })).toBe('while queue:');
  });
  it('caps the options at MAX_HOLE_OPTIONS keeping params, locals and builtins, so the Choice builder never overflows', () => {
    const big = `import os\n${Array.from({ length: 300 }, (_, i) => `NAME_${i} = ${i}`).join('\n')}\ndef f(a):\n    total = a\n    return total\n`;
    const f = sourceFile('big.py', big);
    const bsite = makeSite(f, { kind: 'replace', line: 304 });
    const options = holeIdentifierOptions(bsite.scope);
    expect(options.length).toBe(MAX_HOLE_OPTIONS);
    expect(options.slice(0, 2)).toEqual(['a', 'total']);
    expect(options).toEqual(expect.arrayContaining([...COMMON_BUILTINS, 'os', 'NAME_0']));
    expect(options).not.toContain('NAME_299');
    const holes = identifierHoles('return total + 1', bsite.scope);
    const q = holeQuestion(holes[0]!, bsite);
    expect(Object.keys(optionsOf(q)).length).toBe(MAX_HOLE_OPTIONS + 1);
    // under the cap the measured order is unchanged: params, locals, module names, imports, builtins
    expect(holeIdentifierOptions(site.scope).slice(0, 3)).toEqual([...site.scope.params, ...site.scope.locals].slice(0, 3));
  });
  it('optionKey is snake_case, unique and never a bare letter', () => {
    const used = new Set<string>();
    expect(optionKey('ident', 'i', used)).toBe('ident_i');
    expect(optionKey('ident', 'I', used)).toBe('ident_i_2');
    expect(optionKey('ident', 'SIZE_UNITS', used)).toBe('ident_size_units');
    expect(optionKey('ident', 'ünïcode', used)).toBe('ident__n_code');
  });
});

describe('holeTemplate and holeState', () => {
  const site = makeSite(bucketsort, { kind: 'replace', line: BUGGY_LINE });
  const donor = 'for i, count in enumerate(counts):';
  const holes = identifierHoles(donor, site.scope);
  it('writes the asked hole as the marker, earlier fills as chosen and later holes as the donor names', () => {
    expect(holeTemplate(donor, holes, holes[3]!, {})).toBe(`for i, count in enumerate(${HOLE_MARKER}):`);
    expect(holeTemplate(donor, holes, holes[1]!, { hole_1: 'k' })).toBe(`for k, ${HOLE_MARKER} in enumerate(counts):`);
    expect(holeTemplate(donor, holes, null, { hole_1: 'k', hole_2: 'count', hole_3: 'enumerate', hole_4: 'arr' })).toBe('for k, count in enumerate(arr):');
    expect(holeTemplate('x = x + 1', identifierHoles('x = x + 1', site.scope), null, { hole_1: 'k' })).toBe('k = k + 1');
  });
  it('builds the measured state: task, program with the buggy line visible, faulty_line, tests, replacement_templates', () => {
    const ctx = ctxFor(site, scriptedAsk(() => ({})), { path: 'bucketsort.py', line: 5, block: 'bucketsort' });
    const state = holeState(ctx, { hole_4: `for i, count in enumerate(${HOLE_MARKER}):` }) as Record<string, Json>;
    expect(state['task']).toBe(`The function \`bucketsort\` has a single-line bug at \`program.L${BUGGY_LINE}\`. Each entry of \`replacement_templates\` is the proposed replacement for that line with one identifier removed and written as \`${HOLE_MARKER}\`. The filled line must make every case in \`tests\` pass.`);
    expect(state['faulty_line']).toBe(`L${BUGGY_LINE}`);
    const program = state['program'] as Record<string, string>;
    expect(program[`L${BUGGY_LINE}`]).toBe(bucketsort.mod.lines[BUGGY_LINE - 1]);
    expect(Object.keys(program)[0]).toBe(`L${site.block!.startLine}`);
    expect(state['tests']).toEqual([{ test: 'bucketsort_0', call: 'bucketsort([3, 11, 2, 9, 1, 5], 12)', expected: '[1, 2, 3, 5, 9, 11]', actual: '[]' }]);
    expect(state['replacement_templates']).toEqual({ hole_4: `for i, count in enumerate(${HOLE_MARKER}):` });
    expect(state['template_origin']).toContain('`bucketsort.py` line 5 (function `bucketsort`)');
    expect(state['task_description']).toBe(ctx.task);
  });
  it('marks insert sites with the missing-line marker and insert_before', () => {
    const wrap = corpus.get('wrap.py')!;
    const insert = makeSite(wrap, { kind: 'insert', line: 10, indent: '    ' });
    const state = holeState(ctxFor(insert, scriptedAsk(() => ({}))), { hole_1: `lines.append(${HOLE_MARKER})` }) as Record<string, Json>;
    expect(state['insert_before']).toBe('L10');
    expect(state['faulty_line']).toBeUndefined();
    expect((state['program'] as Record<string, string>)['L10']).toBe('<<< MISSING LINE >>>\n    return lines');
    expect(state['task']).toContain('is missing one statement, which belongs directly before `program.L10`');
  });
});

describe('holeQuestion(s) are REPORT-compliant', () => {
  const site = makeSite(bucketsort, { kind: 'replace', line: BUGGY_LINE });
  const donor = 'for i, count in enumerate(counts):';
  const holes = identifierHoles(donor, site.scope);
  it('one Choice per hole, escape option present, semantic keys, backticked path to the template and the line', () => {
    const q = holeQuestion(holes[3]!, site);
    expect(q.type).toBe('choice');
    const opts = optionsOf(q);
    expect(opts[ESCAPE_KEY]).toBeNull();
    expect(Object.keys(opts).length).toBe(Object.keys(holes[3]!.options).length + 1);
    for (const k of Object.keys(opts)) expect(k).toMatch(/^([a-z][a-z0-9_]{1,63})$/);
    expect(Object.keys(opts).some((k) => /^([a-z]|alpha|beta|\d+)$/.test(k))).toBe(false);
    expect(q.instructions).toBe(`Which identifier, in scope in \`program\`, fills \`${HOLE_MARKER}\` in \`replacement_templates.hole_4\` so that the completed line at \`program.L${BUGGY_LINE}\` makes all \`tests\` pass?`);
    const attr = holeQuestion(identifierHoles('s.upper()', site.scope)[1]!, site);
    expect(attr.instructions).toContain('Which attribute name fills');
  });
  it('holeQuestions builds one template and one question per unfilled hole over one state', () => {
    const ctx = ctxFor(site, scriptedAsk(() => ({})));
    const set = holeQuestions(donor, holes, site.scope, ctx, { hole_1: 'i', hole_2: 'count' });
    expect(Object.keys(set.questions)).toEqual(['hole_3', 'hole_4']);
    expect(set.templates).toEqual({ hole_3: `for i, count in ${HOLE_MARKER}(counts):`, hole_4: `for i, count in enumerate(${HOLE_MARKER}):` });
    expect((set.state as Record<string, Json>)['replacement_templates']).toEqual(set.templates);
    // no holes given → computed from the donor line and the scope
    expect(Object.keys(holeQuestions(donor, [], site.scope, ctx).questions)).toEqual(['hole_1', 'hole_2', 'hole_3', 'hole_4']);
  });
});

describe('fillHolesSequentially (scripted answers)', () => {
  const site = makeSite(bucketsort, { kind: 'replace', line: BUGGY_LINE });
  const donor = 'for i, count in enumerate(arr):';
  const holes = identifierHoles(donor, site.scope);

  it('asks one hole per request with earlier holes filled, keeps a width-2 beam and returns the top-2 fillings', async () => {
    // Jev "knows" the fix: keep i/count/enumerate, change arr → counts (p 0.7) with arr second (0.2).
    const ask = scriptedAsk((id, q, state) => {
      const template = holeTemplateOf(state, id);
      expect(template).toContain(HOLE_MARKER);
      const keys = Object.keys(optionsOf(q));
      const w = (name: string, p: number): Record<string, number> => ({ [keys.find((k) => k === `ident_${name}`)!]: p });
      switch (id) {
        case 'hole_1': return { ...w('i', 0.9), ...w('k', 0.1) };
        case 'hole_2': return { ...w('count', 0.95), ...w('x', 0.05) };
        case 'hole_3': return { ...w('enumerate', 0.98), [ESCAPE_KEY]: 0.02 };
        case 'hole_4': return template.startsWith('for i,') ? { ...w('counts', 0.7), ...w('arr', 0.2), [ESCAPE_KEY]: 0.1 } : { ...w('arr', 0.6), ...w('counts', 0.4) };
        default: return {};
      }
    });
    const ctx = ctxFor(site, ask);
    const r = await fillHolesSequentially(donor, holes, site.scope, ctx, { familySwaps: false });
    // 1 request for the first hole, then 2 per hole (one per beam entry)
    expect(r.requests).toBe(1 + 2 * 3);
    expect(ask.calls.length).toBe(r.requests);
    for (const call of ask.calls) {
      expect(Object.keys(call.questions).length).toBe(1); // leak-free: one template per request
      expect(call.stage).toBe('propose');
      const templates = (call.state as { replacement_templates: Record<string, string> }).replacement_templates;
      expect(Object.keys(templates)).toEqual(Object.keys(call.questions));
    }
    // the second hole's requests show the first hole already filled
    expect(holeTemplateOf(ask.calls[1]!.state, 'hole_2')).toBe(`for i, ${HOLE_MARKER} in enumerate(arr):`);
    expect(holeTemplateOf(ask.calls[2]!.state, 'hole_2')).toBe(`for k, ${HOLE_MARKER} in enumerate(arr):`);
    expect(r.fillings.length).toBe(2);
    expect(r.fillings[0]).toMatchObject({ text: 'for i, count in enumerate(counts):', assignments: { hole_1: 'i', hole_2: 'count', hole_3: 'enumerate', hole_4: 'counts' }, swapped: false });
    expect(r.fillings[1]!.text).toBe('for i, count in enumerate(arr):');
    expect(r.fillings[0]!.logProb).toBeGreaterThan(r.fillings[1]!.logProb);
    expect(r.fillings[0]!.logProb).toBeCloseTo(Math.log(0.9) + Math.log(0.95) + Math.log(0.98) + Math.log(0.7), 6);
    expect(r.fillings[0]!.minProbability).toBeCloseTo(0.7, 6);
    expect(r.fillings[0]!.maxEscapeProbability).toBeCloseTo(0.1, 6);
  });

  it('produces both orders of a same-family pair and dedupes', async () => {
    const gcd = corpus.get('gcd.py')!;
    const line = gcd.mod.lines.findIndex((l) => l.includes('return gcd(')) + 1;
    const gsite = makeSite(gcd, { kind: 'replace', line });
    const text = 'return gcd(a % b, b)';
    const gholes = identifierHoles(text, gsite.scope);
    const ask = scriptedAsk((id, q) => {
      const keys = Object.keys(optionsOf(q));
      const want = gholes.find((h) => h.key === id)!.name;
      return { [keys.find((k) => k === `ident_${want}`)!]: 1 };
    });
    const r = await fillHolesSequentially(text, gholes, gsite.scope, ctxFor(gsite, ask), { width: 1 });
    expect(r.fillings.map((f) => [f.text, f.swapped])).toEqual([
      ['return gcd(a % b, b)', false],
      ['return gcd(b % a, a)', true],
    ]);
  });

  it('keeps the donor name when Jev answers with escape-only mass or a non-choice, and stops on abort', async () => {
    const ask = scriptedAsk(() => ({ [ESCAPE_KEY]: 1 }));
    const r = await fillHolesSequentially(donor, holes, site.scope, ctxFor(site, ask), { width: 1, familySwaps: false });
    // every option had probability 0: the ranked options tie at 0 and the first key wins deterministically
    expect(r.fillings.length).toBe(1);
    expect(r.fillings[0]!.maxEscapeProbability).toBe(1);
    const ctl = new AbortController();
    ctl.abort();
    const ctx = ctxFor(site, ask);
    const before = ask.calls.length;
    await expect(fillHolesSequentially(donor, holes, site.scope, { ...ctx, signal: ctl.signal })).rejects.toThrow(AbortError);
    expect(ask.calls.length).toBe(before); // nothing is asked once the signal is aborted
  });

  it('limits the holes asked to maxHoles but always asks must-change holes first', async () => {
    const ask = scriptedAsk((_id, q) => ({ [Object.keys(optionsOf(q))[0]!]: 1 }));
    const text = 'nodesseen.add(startnode)';
    const h = identifierHoles(text, site.scope);
    const r = await fillHolesSequentially(text, h, site.scope, ctxFor(site, ask), { width: 1, maxHoles: 1, familySwaps: false });
    expect(r.requests).toBe(2); // both identifiers are out of scope: both must change even under maxHoles 1
    expect(r.fillings[0]!.text).not.toContain('nodesseen');
    expect(r.fillings[0]!.text).not.toContain('startnode');
  });

  it('a site with an insert kind gets insert wording', () => {
    const wrap = corpus.get('wrap.py')!;
    const insert = makeSite(wrap, { kind: 'insert', line: 10, indent: '    ' });
    const h = identifierHoles('lines.append(text)', insert.scope);
    const q = holeQuestion(h[0]!, insert);
    expect(q.instructions).toContain('the completed statement inserted before `program.L10`');
    expect(enumerateOptions(corpus).corpus.size).toBe(41);
  });
});
