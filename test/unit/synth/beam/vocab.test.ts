import { describe, expect, it } from 'vitest';
import { choice } from '../../../../src/jev/questions.js';
import { COMMON_BUILTINS, COMMON_METHODS, END_KEY, KEYWORDS, MAX_LITERALS, MAX_VOCAB_TOKENS, buildVocabulary, slotTokens } from '../../../../src/synth/beam/vocab.js';
import { filterOptions } from '../../../../src/synth/beam/beam.js';
import { OP_NAMES, keyAndDescription, sanitise, toks } from '../../../../src/synth/beam/tokens.js';
import { asChoice, enumerateOptions, gcdSite, knapsackSite, siteAt, sourceFile } from './helpers.js';

const KEY_SHAPE = /^[a-z][a-z0-9_]{1,63}$/;

describe('vocabulary: gcd', () => {
  const { site } = gcdSite();
  const vocab = buildVocabulary(site, enumerateOptions({ testLiterals: ['17', '600', "'x'"] }));

  it('holds the function identifiers, parameters, keywords, literals, operators, punctuation and test literals', () => {
    const keys = new Set(vocab.tokens.map((t) => t.key));
    for (const k of ['name_gcd', 'name_a', 'name_b', 'keyword_return', 'keyword_if', 'literal_none', 'literal_true', 'op_modulo', 'op_equal', 'punct_open_paren', 'punct_comma', 'number_0', 'number_17', 'number_600', 'string_x']) {
      expect(keys.has(k), k).toBe(true);
    }
    for (const b of COMMON_BUILTINS) expect(vocab.byText.get(b)?.attributeOnly).toBe(false);
    for (const m of COMMON_METHODS) expect(vocab.byText.get(m)?.attributeOnly, m).toBe(true);
    for (const k of KEYWORDS) expect(vocab.byText.get(k)?.tok.cls).toBe('keyword');
    for (const o of Object.keys(OP_NAMES)) expect(vocab.byText.has(o), o).toBe(true);
  });
  it('keys are unique, snake_case, never positional, and the option set fits a Choice with END and the escape', () => {
    const keys = vocab.tokens.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) {
      expect(k).toMatch(KEY_SHAPE);
      expect(k).not.toMatch(/^(tok|option)_\d+$/);
    }
    expect(vocab.tokens.length).toBeLessThanOrEqual(MAX_VOCAB_TOKENS);
    const options = filterOptions(vocab, [], 'simple');
    expect(() => choice('q', options)).not.toThrow();
    expect(Object.keys(asChoice(choice('q', options)).criteria).length).toBeLessThanOrEqual(255);
  });
  it('descriptions carry the token text (Jev reads descriptions more than keys)', () => {
    expect(vocab.byKey.get('name_gcd')?.description).toEqual({ kind: 'module-level name', token: 'gcd' });
    expect(vocab.byKey.get('name_a')?.description).toEqual({ kind: 'parameter', token: 'a' });
    expect(vocab.byKey.get('op_modulo')?.description).toEqual({ kind: 'operator', token: '%', meaning: 'modulo' });
    expect(vocab.byKey.get('punct_open_paren')?.description).toEqual({ kind: 'punctuation', token: '(', meaning: 'open parenthesis' });
  });
  it('every token of the fix line is offered at its position under the grammar filter', () => {
    const target = toks('return gcd(b, a % b)');
    for (let k = 0; k < target.length; k++) {
      const options = filterOptions(vocab, target.slice(0, k), 'simple');
      const key = vocab.byText.get(target[k]!.text)?.key;
      expect(key, target[k]!.text).toBeDefined();
      expect(options[key!], `${target[k]!.text} at ${k}`).toBeDefined();
    }
    expect(filterOptions(vocab, target, 'simple')[END_KEY]).toBeDefined();
  });
});

describe('vocabulary: knapsack', () => {
  const { site } = knapsackSite();
  const vocab = buildVocabulary(site, enumerateOptions({ testLiterals: ['[(60, 10), (50, 8)]', '19'] }));
  it('includes locals, loop variables, the local import and literals from the tests', () => {
    for (const k of ['name_memo', 'name_weight', 'name_value', 'name_capacity', 'name_items', 'name_i', 'name_j', 'name_defaultdict', 'name_max', 'name_len', 'name_range', 'number_1', 'number_60', 'number_19']) {
      expect(vocab.byKey.has(k), k).toBe(true);
    }
    expect(vocab.byKey.get('name_defaultdict')?.description).toEqual({ kind: 'imported name', token: 'defaultdict' });
  });
  it('the slot subset holds identifiers and literals only', () => {
    for (const t of slotTokens(vocab)) expect(['identifier', 'number', 'string', 'literal']).toContain(t.tok.cls);
    expect(slotTokens(vocab).some((t) => t.tok.cls === 'operator')).toBe(false);
  });
});

describe('vocabulary: attributes, task identifiers, caps', () => {
  it('attributes seen on receivers are dot-only unless also used as a bare name', () => {
    const file = sourceFile('m.py', 'class Q:\n    def run(self, items):\n        self.items.extend(items)\n        seen = set()\n        seen.add(items[0])\n        return self.count\n');
    const vocab = buildVocabulary(siteAt(file, 5), enumerateOptions({ taskIdentifiers: ['visited', 'items'] }));
    expect(vocab.byText.get('extend')?.attributeOnly).toBe(true);
    expect(vocab.byText.get('count')?.attributeOnly).toBe(true);
    expect(vocab.byText.get('items')?.attributeOnly).toBe(false);
    expect(vocab.byText.get('self')?.attributeOnly).toBe(false);
    expect(vocab.byText.get('visited')?.description).toEqual({ kind: 'identifier named by the task or test', token: 'visited' });
    expect(vocab.byKey.has('name_self')).toBe(true);
  });
  it('an insert site still gets the enclosing scope', () => {
    const { file } = gcdSite();
    const vocab = buildVocabulary(siteAt(file, 3, 'insert'), enumerateOptions());
    expect(vocab.byKey.has('name_a')).toBe(true);
    expect(vocab.byKey.has('name_gcd')).toBe(true);
  });
  it('caps literals at MAX_LITERALS and drops over-long strings', () => {
    const lits = Array.from({ length: 60 }, (_, i) => String(1000 + i));
    const { site } = gcdSite();
    const vocab = buildVocabulary(site, enumerateOptions({ testLiterals: [...lits, "'this string literal is far too long to offer'"] }));
    const numbers = vocab.tokens.filter((t) => t.tok.cls === 'number');
    expect(numbers.length).toBeLessThanOrEqual(MAX_LITERALS);
    expect(vocab.tokens.some((t) => t.tok.text.includes('far too long'))).toBe(false);
  });
  it('caps the whole vocabulary without losing syntax tokens', () => {
    const names = Array.from({ length: 400 }, (_, i) => `v${i}`);
    const { site } = gcdSite();
    const vocab = buildVocabulary(site, enumerateOptions({ taskIdentifiers: names }));
    expect(vocab.tokens.length).toBeLessThanOrEqual(MAX_VOCAB_TOKENS);
    for (const k of KEYWORDS) expect(vocab.byText.has(k), k).toBe(true);
    for (const o of Object.keys(OP_NAMES)) expect(vocab.byText.has(o), o).toBe(true);
    expect(vocab.byText.has('gcd')).toBe(true); // scope and function identifiers come before task identifiers
    expect(vocab.tokens.length).toBe(vocab.byKey.size);
  });
  it('key collisions after sanitising get a numeric suffix, never a positional key', () => {
    const { site } = gcdSite();
    const vocab = buildVocabulary(site, enumerateOptions({ taskIdentifiers: ['foo_bar', 'foo__bar', 'Foo_Bar'] }));
    const keys = vocab.tokens.filter((t) => t.key.startsWith('name_foo_bar')).map((t) => t.key).sort();
    expect(keys).toEqual(['name_foo_bar', 'name_foo_bar_2', 'name_foo_bar_3']);
  });
  it('sanitise and keyAndDescription produce measured key shapes', () => {
    expect(sanitise('Hello World!')).toBe('hello_world');
    expect(sanitise('***')).toBe('x');
    expect(keyAndDescription({ text: "''", cls: 'string' }).key).toBe('string_empty');
    expect(keyAndDescription({ text: "'abc'", cls: 'string' }).key).toBe('string_abc');
    expect(keyAndDescription({ text: '<=', cls: 'operator' }).key).toBe('op_less_equal');
    expect(keyAndDescription({ text: '...', cls: 'operator' }).key).toBe('op_x');
  });
});
