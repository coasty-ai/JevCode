import { describe, expect, it } from 'vitest';
import type { Json } from '../../../../../src/core/types.js';
import { isJsonObject } from '../../../../../src/core/json.js';
import { ESCAPE_KEY } from '../../../../../src/jev/questions.js';
import { CURRENT_LINE_CORRECT_ID, HYPOTHESES_KEY, TEMPLATE_QUESTION } from '../../../../../src/jev-modes/synth/beam/state.js';
import { SLOT, fillText, mutants, runTemplateRoute, slotOptions, templateKey, templateOf, templatePool, templateText } from '../../../../../src/jev-modes/synth/beam/templates.js';
import { toks } from '../../../../../src/jev-modes/synth/beam/tokens.js';
import { buildVocabulary } from '../../../../../src/jev-modes/synth/beam/vocab.js';
import { GCD_FAILURES, asChoice, enumerateOptions, gcdSite, keyForToken, massOn, scriptedAsk, siteAt, sourceFile, stateString } from './helpers.js';
import type { ChoiceQuestion } from './helpers.js';

const KEY_SHAPE = /^[a-z][a-z0-9_]{1,63}$/;

describe('templates: masking', () => {
  it('masks identifiers and literals, keeps keywords, operators and punctuation', () => {
    expect(templateText(templateOf(toks('return gcd(a % b, b)')))).toBe('return _(_ % _, _)');
    expect(templateText(templateOf(toks("while queue and x != 'a':")))).toBe('while _ and _ != _:');
    expect(templateText(templateOf(toks('memo[i, j] = memo[i - 1, j]')))).toBe('_[_, _] = _[_ - 1, _]'.replace('1', '_'));
    expect(templateText(templateOf(toks('return None')))).toBe('return _');
    expect(templateText(templateOf(toks('break')))).toBe('break');
  });
  it('template keys spell the shape out in snake_case within the key limit', () => {
    const k = templateKey(templateOf(toks('return gcd(b, a % b)')));
    expect(k).toBe('shape_return_x_open_paren_x_comma_x_modulo_x_close_paren');
    expect(k).toMatch(KEY_SHAPE);
    const long = templateKey(templateOf(toks('memo[i, j] = max(memo[i, j], value + memo[i - 1, j - weight])')));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).toMatch(KEY_SHAPE);
  });
  it('fillText shows earlier slots filled and the rest numbered', () => {
    const tpl = templateOf(toks('return gcd(b, a % b)'));
    expect(fillText(tpl, [])).toBe('return <SLOT_1>(<SLOT_2>, <SLOT_3> % <SLOT_4>)');
    expect(fillText(tpl, [{ text: 'gcd', cls: 'identifier' }, { text: 'b', cls: 'identifier' }])).toBe('return gcd(b, <SLOT_3> % <SLOT_4>)');
  });
  it('mutants cover operator swaps, ±1 and the two-argument swap', () => {
    const m = mutants('return gcd(a % b, b)');
    expect(m).toContain('return gcd(b, a % b)');
    expect(mutants('if weight < j:')).toContain('if weight <= j:');
    expect(mutants('x = i + 1')).toContain('x = i - 1');
    expect(mutants('if a and b:')).toContain('if a or b:');
    expect(mutants('return all(x)')).not.toContain('return all(x)');
  });
});

describe('templates: pool', () => {
  it('holds the buggy line, its mutants and donor shapes, deduplicated and labelled', () => {
    const { site } = gcdSite();
    const pool = templatePool(site, enumerateOptions());
    expect(pool[0]).toMatchObject({ text: 'return _(_ % _, _)', source: 'buggy_line', slots: 4 });
    const swapped = pool.find((e) => e.text === 'return _(_, _ % _)');
    expect(swapped?.source).toBe('mutant_of_buggy_line');
    expect(pool.some((e) => e.text === 'return _' && e.source === 'gcd.py:3')).toBe(true);
    expect(pool.some((e) => e.text === 'if _ == _:' && e.source === 'gcd.py:2')).toBe(true);
    expect(new Set(pool.map((e) => e.text)).size).toBe(pool.length);
    expect(new Set(pool.map((e) => e.key)).size).toBe(pool.length);
    for (const e of pool) expect(e.key).toMatch(KEY_SHAPE);
    // def headers and docstrings are never donors
    expect(pool.some((e) => e.text.startsWith('def '))).toBe(false);
  });
  it('takes near-duplicate donors from the corpus and none for unrelated lines', () => {
    const { site } = gcdSite();
    const other = sourceFile('lcm.py', 'def lcm(a, b):\n    return lcm_helper(a // b, b)\n    total = sum(values) + 1\n');
    const pool = templatePool(site, enumerateOptions({ corpus: new Map([['lcm.py', other]]) }));
    expect(pool.some((e) => e.text === 'return _(_ // _, _)' && e.source === 'lcm.py:2')).toBe(true);
    expect(pool.some((e) => e.source === 'lcm.py:3')).toBe(false);
  });
  it('docstring lines and fragments of multi-line statements are never donors; one-liners are', () => {
    const src = 'def f(xs, n):\n    """Sum the first n.\n\n    Input:\n        xs: a list\n    """\n    if not xs: return 0\n    total = sum(\n        xs[:n],\n        0)\n    return total\n';
    const file = sourceFile('d.py', src);
    const pool = templatePool(siteAt(file, 11), enumerateOptions());
    const shapes = pool.map((e) => e.text);
    expect(shapes).toContain('if not _: return _');
    expect(shapes.some((t) => t.startsWith('_:') || t === '_')).toBe(false); // `Input:`, `xs: a list`
    expect(shapes.some((t) => t.endsWith('(') || t.endsWith(','))).toBe(false); // `total = sum(`, `xs[:n],`
    expect(pool.some((e) => ['d.py:2', 'd.py:4', 'd.py:5', 'd.py:8', 'd.py:9'].includes(e.source))).toBe(false);
  });
  it('an insert site uses the block lines only and honours the cap', () => {
    const { file } = gcdSite();
    const pool = templatePool(siteAt(file, 3, 'insert'), enumerateOptions());
    expect(pool.every((e) => e.source.startsWith('gcd.py:'))).toBe(true);
    expect(templatePool(siteAt(file, 3, 'insert'), enumerateOptions(), 1)).toHaveLength(1);
  });
});

describe('templates: slot options', () => {
  it('offers names only after a dot / before a call / after binding keywords; attributes only after a dot', () => {
    const file = sourceFile('m.py', 'def f(xs, n):\n    xs.append(n)\n    return len(xs)\n');
    const vocab = buildVocabulary(siteAt(file, 3), enumerateOptions({ testLiterals: ['3'] }));
    const dotted = templateOf(toks('xs.append(n)'));
    const afterDot = slotOptions(dotted, 1, vocab);
    expect(afterDot.some((v) => v.tok.text === 'append')).toBe(true);
    expect(afterDot.every((v) => v.tok.cls === 'identifier')).toBe(true);
    const receiver = slotOptions(dotted, 0, vocab);
    expect(receiver.some((v) => v.tok.text === 'append')).toBe(false);
    expect(receiver.some((v) => v.tok.text === 'xs')).toBe(true);
    const arg = slotOptions(dotted, 2, vocab);
    expect(arg.some((v) => v.tok.text === '3')).toBe(true);
    expect(arg.some((v) => v.tok.text === 'append')).toBe(false);
    const loop = slotOptions(templateOf(toks('for i in xs:')), 0, vocab);
    expect(loop.every((v) => v.tok.cls === 'identifier')).toBe(true);
  });
});

describe('templates: scripted route on gcd', () => {
  const target = ['gcd', 'b', 'a', 'b'];
  const shapeKey = (q: ChoiceQuestion, shape: string): string | undefined => Object.entries(q.criteria).find(([, d]) => isJsonObject(d) && d['shape'] === shape)?.[0];
  /** Fill from `line_with_slots`: the n-th slot of the swapped shape gets target[n]. */
  const slotScript = (id: string, q: ChoiceQuestion, state: Json): Record<string, number> | undefined => {
    const path = id === 'slot' ? '' : `${HYPOTHESES_KEY}.${id.slice('slot_'.length)}.`;
    const shape = stateString(state, `${path}line_shape`);
    const slot = stateString(state, `${path}slot_to_fill`);
    if (shape !== 'return _(_, _ % _)' || slot === undefined) return undefined;
    const n = Number(/\d+/.exec(slot)?.[0]) - 1;
    const key = keyForToken(q, target[n]!);
    return key === undefined ? undefined : massOn(q, key, 0.9);
  };

  it('picks the swapped shape, fills its slots sequentially and pairs the Choice with the correctness Noul', async () => {
    const { site } = gcdSite();
    const vocab = buildVocabulary(site, enumerateOptions());
    const ask = scriptedAsk((id, q, state) => {
      if (q.type === 'noul') return 0.05;
      if (q.type !== 'choice') return undefined;
      if (id === 'line_shape') return massOn(q, shapeKey(q, 'return _(_, _ % _)')!, 0.8);
      return slotScript(id, q, state);
    });
    const res = await runTemplateRoute(ask, site, vocab, { task: 'fix gcd', failures: GCD_FAILURES }, enumerateOptions(), { width: 3, maxTokens: 25, confidentExpandThreshold: 0.9, maxRequests: 40, signal: new AbortController().signal });
    expect(res.lines[0]?.text).toBe('        return gcd(b, a % b)');
    expect(res.lines[0]!.logProb).toBeCloseTo(Math.log(0.8) + 4 * Math.log(0.9), 6);
    expect(res.currentLineCorrectProbability).toBeCloseTo(0.05, 2);
    expect(res.templateEscapeProbability).toBe(0);
    expect(res.chosenTemplates[0]).toBe('return _(_, _ % _)');
    expect(res.poolSize).toBeGreaterThan(3);
    // one request for shape + Noul, then one per slot index for the top-3 templates side by side
    const first = ask.calls[0]!;
    expect(Object.keys(first.questions).sort()).toEqual([CURRENT_LINE_CORRECT_ID, 'line_shape'].sort());
    expect(asChoice(first.questions['line_shape']).instructions).toBe(TEMPLATE_QUESTION);
    expect(first.questions[CURRENT_LINE_CORRECT_ID]?.type).toBe('noul');
    expect(res.requests).toBe(1 + 4);
    const second = ask.calls[1]!;
    const ids = Object.keys(second.questions);
    expect(ids.length).toBeGreaterThan(1);
    for (const id of ids) {
      expect(id.startsWith('slot_shape_')).toBe(true);
      const key = id.slice('slot_'.length);
      expect(stateString(second.state, `${HYPOTHESES_KEY}.${key}.slot_to_fill`)).toBe('<SLOT_1>');
      expect(asChoice(second.questions[id]).instructions).toContain(`\`${HYPOTHESES_KEY}.${key}.line_with_slots\``);
    }
    // the buggy line's own shape is filled too but its result equals the current line and is dropped
    expect(res.lines.some((l) => l.text.trim() === 'return gcd(a % b, b)')).toBe(false);
  });
  it('uses the flat measured state when a single template remains and respects the request budget', async () => {
    const { site } = gcdSite();
    const vocab = buildVocabulary(site, enumerateOptions());
    const ask = scriptedAsk((id, q, state) => {
      if (q.type === 'noul') return 0.5;
      if (q.type !== 'choice') return undefined;
      if (id === 'line_shape') return { [shapeKey(q, 'return _(_, _ % _)')!]: 1 };
      return slotScript(id, q, state);
    });
    const res = await runTemplateRoute(ask, site, vocab, { task: '', failures: [] }, enumerateOptions(), { width: 1, maxTokens: 25, confidentExpandThreshold: 0.9, maxRequests: 3, signal: new AbortController().signal });
    expect(Object.keys(ask.calls[1]!.questions)).toEqual(['slot']);
    expect(stateString(ask.calls[1]!.state, 'line_with_slots')).toBe('return <SLOT_1>(<SLOT_2>, <SLOT_3> % <SLOT_4>)');
    expect(stateString(ask.calls[2]!.state, 'line_with_slots')).toBe('return gcd(<SLOT_2>, <SLOT_3> % <SLOT_4>)');
    expect(res.requests).toBe(3);
    expect(res.lines).toEqual([]); // budget ran out before slot 3: no half-filled line is returned
  });
  it('an insert site asks no correctness Noul and a none_of_these top pick still fills the best listed shape', async () => {
    const { file } = gcdSite();
    const site = siteAt(file, 3, 'insert');
    const vocab = buildVocabulary(site, enumerateOptions());
    const ask = scriptedAsk((id, q) => {
      if (q.type !== 'choice') return undefined;
      if (id === 'line_shape') return { [ESCAPE_KEY]: 0.6, [shapeKey(q, 'return _')!]: 0.4 };
      const k = keyForToken(q, 'b');
      return k === undefined ? undefined : massOn(q, k, 0.9);
    });
    const res = await runTemplateRoute(ask, site, vocab, { task: '', failures: [] }, enumerateOptions(), { width: 1, maxTokens: 25, confidentExpandThreshold: 0.9, maxRequests: 10, signal: new AbortController().signal });
    expect(ask.calls[0]!.questions[CURRENT_LINE_CORRECT_ID]).toBeUndefined();
    expect(res.currentLineCorrectProbability).toBeNull();
    expect(res.templateEscapeProbability).toBeCloseTo(0.6, 2);
    expect(res.lines[0]?.text).toBe('        return b');
  });
  it('a template without slots costs no slot request', async () => {
    const file = sourceFile('w.py', 'def f(xs):\n    while True:\n        xs.pop()\n        break\n    return xs\n');
    const site = siteAt(file, 3);
    const vocab = buildVocabulary(site, enumerateOptions());
    const ask = scriptedAsk((id, q) => {
      if (q.type === 'noul') return 0.1;
      if (q.type !== 'choice') return undefined;
      if (id === 'line_shape') return { [shapeKey(q, 'break')!]: 1 };
      return undefined;
    });
    const res = await runTemplateRoute(ask, site, vocab, { task: '', failures: [] }, enumerateOptions(), { width: 1, maxTokens: 25, confidentExpandThreshold: 0.9, maxRequests: 10, signal: new AbortController().signal });
    expect(res.requests).toBe(1);
    expect(res.lines[0]?.text).toBe('        break');
    expect(templateOf(toks('break')).some((t) => t.text === SLOT)).toBe(false);
  });
});
