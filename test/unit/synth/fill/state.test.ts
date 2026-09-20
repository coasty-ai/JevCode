/** Slot option sets, hole classes, partial rendering, the measured Q13 wording and the compile gate (src/synth/fill/state.ts). */
import { describe, expect, it } from 'vitest';
import { MARK } from '../../../../src/synth/beam/state.js';
import { toks } from '../../../../src/synth/beam/tokens.js';
import { ASSIGNMENT_OPERATORS, HOLE_MARK, MAX_ATTRIBUTE_OPTIONS, MAX_IDENTIFIER_OPTIONS, MAX_LITERAL_OPTIONS, SLOT_OPERATORS, buildSlotVocabulary, compileGate, hypothesisKeyAt, partialLine, slotClassAt, slotOptionsFor, slotQuestion, testIntegers, testStrings } from '../../../../src/synth/fill/state.js';
import { hypothesisToks } from '../../../../src/synth/sketch/productions.js';
import { enumerateOptions, gcdSite, siteAt, sourceFile } from '../sketch/helpers.js';

const KEY_SHAPE = /^[a-z][a-z0-9_]{1,63}$/;

describe('buildSlotVocabulary: the measured per-class option sets', () => {
  const { site } = gcdSite();
  const vocab = buildSlotVocabulary(site, enumerateOptions({ testLiterals: ['{"input":[17,0],"expected":17}', "gcd('x', -1) == 'ab'"], taskIdentifiers: ['divisor'] }));

  it('identifiers carry roles and the measured keys, bounded at 60', () => {
    const byKey = new Map(vocab.identifiers.map((o) => [o.key, o]));
    expect(byKey.get('name_a')?.description).toBe('`a` (parameter of gcd)');
    expect(byKey.get('name_b')?.description).toBe('`b` (parameter of gcd)');
    expect(byKey.get('name_gcd')?.description).toBe('`gcd` (module-level name)');
    expect(byKey.get('name_divisor')?.description).toBe('`divisor` (identifier named by the task or test)');
    expect(byKey.get('name_len')?.description).toBe('`len` (Python builtin)');
    expect(byKey.get('name_none')).toMatchObject({ tok: { text: 'None', cls: 'literal' }, description: '`None` (Python constant)' });
    expect(vocab.identifiers.length).toBeLessThanOrEqual(MAX_IDENTIFIER_OPTIONS);
    expect(new Set(vocab.identifiers.map((o) => o.tok.text)).size).toBe(vocab.identifiers.length);
    for (const o of vocab.identifiers) expect(o.key).toMatch(KEY_SHAPE);
  });
  it('attributes: names used after a dot in the file, then the common methods, bounded at 40', () => {
    expect(vocab.attributes.find((o) => o.key === 'attr_append')).toMatchObject({ tok: { text: 'append' }, description: '`append` (common method name)' });
    expect(vocab.attributes.length).toBeLessThanOrEqual(MAX_ATTRIBUTE_OPTIONS);
  });
  it('operators: exactly the measured 24 with their measured keys; assignments separately', () => {
    expect(vocab.operators).toHaveLength(24);
    expect(vocab.operators.map((o) => o.key)).toEqual(SLOT_OPERATORS.map(([k]) => k));
    expect(vocab.operators.find((o) => o.key === 'op_plus')).toMatchObject({ tok: { text: '+', cls: 'operator' }, description: '`+`' });
    expect(vocab.operators.find((o) => o.key === 'op_and')).toMatchObject({ tok: { text: 'and', cls: 'keyword' } });
    expect(vocab.assignments.map((o) => o.key)).toEqual(ASSIGNMENT_OPERATORS.map(([k]) => k));
    expect(vocab.assignments.find((o) => o.key === 'op_bitand_assign')?.tok.text).toBe('&=');
  });
  it('literals: seed numbers, file numbers, test integers (|v| ≤ 100) and short strings, bounded at 30', () => {
    const keys = vocab.literals.map((o) => o.key);
    expect(keys.slice(0, 5)).toEqual(['num_0', 'num_1', 'num_2', 'num_3', 'num_10']);
    expect(keys).toContain('num_17');
    expect(keys).toContain('num_neg1');
    expect(keys).toContain('str_x');
    expect(keys).toContain('str_ab');
    expect(vocab.literals.find((o) => o.key === 'num_neg1')?.tok).toEqual({ text: '-1', cls: 'number' });
    expect(vocab.literals.length).toBeLessThanOrEqual(MAX_LITERAL_OPTIONS);
  });
  it('testIntegers / testStrings bound what a failing test contributes', () => {
    expect(testIntegers(['[1, 2, 300]', 'x=-7', 'id 12345', '0.5'])).toEqual(['1', '2', '-7']);
    expect(testStrings(['"abc"', "'', 'a very long string literal indeed'"])).toEqual(["'abc'", "''"]);
  });
  it('a class attribute site describes self and class attributes', () => {
    const file = sourceFile('c.py', 'class C:\n    size = 3\n    def add(self, item):\n        self.items.append(item)\n');
    const v = buildSlotVocabulary(siteAt(file, 4), enumerateOptions());
    expect(v.identifiers.find((o) => o.key === 'name_self')?.description).toBe('`self` (parameter of add)');
    expect(v.identifiers.find((o) => o.key === 'name_item')?.description).toBe('`item` (parameter of add)');
    expect(v.identifiers.find((o) => o.key === 'name_size')?.description).toBe('`size` (class attribute)');
    expect(v.attributes[0]?.description).toBe('`items` (attribute used on `self` in program)');
  });
});

describe('slotClassAt and slotOptionsFor', () => {
  const { site } = gcdSite();
  const vocab = buildSlotVocabulary(site, enumerateOptions());
  it('classes a hole by its grammatical position', () => {
    const call = hypothesisToks(['_', '.', '_', '(', '_', ')']);
    expect(slotClassAt(call, 0)).toBe('value');
    expect(slotClassAt(call, 2)).toBe('attribute');
    expect(slotClassAt(call, 4)).toBe('value');
    expect(slotClassAt(hypothesisToks(['_', '(', 'x', ')']), 0)).toBe('callable');
    expect(slotClassAt(hypothesisToks(['n', '<op>', 'n', '-', '1']), 1)).toBe('assignment_operator');
    expect(slotClassAt(hypothesisToks(['while', 'lo', '<op>', 'hi', ':']), 2)).toBe('operator');
    expect(slotClassAt(hypothesisToks(['x', '=', '_', '<op>', '_']), 3)).toBe('operator');
    expect(() => slotClassAt(call, 1)).toThrow(RangeError);
  });
  it('offers the class option set: value = identifiers + literals, callable = names only, operator = 24 (+ assignments at statement level)', () => {
    expect(slotOptionsFor('value', vocab)).toHaveLength(vocab.identifiers.length + vocab.literals.length);
    expect(slotOptionsFor('callable', vocab).every((o) => o.tok.cls === 'identifier')).toBe(true);
    expect(slotOptionsFor('attribute', vocab)).toBe(vocab.attributes);
    expect(slotOptionsFor('operator', vocab)).toHaveLength(24);
    expect(slotOptionsFor('assignment_operator', vocab)).toHaveLength(24 + ASSIGNMENT_OPERATORS.length);
    expect(slotOptionsFor('value', vocab).length + 1).toBeLessThanOrEqual(255);
  });
});

describe('partial lines and the Q13 wording', () => {
  it('renders the measured partial: fixed prefix, <HOLE>, ? for later holes', () => {
    expect(partialLine(hypothesisToks(['return', 'kth', '(', '_', ',', '_', '-', '_', ')']), 3)).toBe('return kth(<HOLE>, ? - ?)');
    expect(partialLine(hypothesisToks(['return', 'kth', '(', 'above', ',', 'k', '<op>', '_', ')']), 6)).toBe('return kth(above, k <HOLE> ?)');
    expect(hypothesisKeyAt(0)).toBe('first');
    expect(hypothesisKeyAt(14)).toBe('fifteenth');
    expect(hypothesisKeyAt(15)).toBe('item_16');
  });
  it('uses the measured wording verbatim at a replace site and names the marker at an insert site', () => {
    expect(slotQuestion('first', 'replace')).toBe(
      '`hypotheses.first` is a partially written replacement for `buggy_line` in `program`. Tokens before `<HOLE>` are fixed; each `?` is a token still to be filled in later. Which option is the correct token for `<HOLE>`, so that the finished line makes every entry of `tests` pass? Pick `none_of_these` if no option fits.',
    );
    expect(slotQuestion('second', 'insert')).toBe(
      `\`hypotheses.second\` is a partially written new line for the \`${MARK}\` marker in \`program\`. Tokens before \`${HOLE_MARK}\` are fixed; each \`?\` is a token still to be filled in later. Which option is the correct token for \`<HOLE>\`, so that the finished line makes every entry of \`tests\` pass? Pick \`none_of_these\` if no option fits.`,
    );
  });
});

describe('compileGate', () => {
  const { file, site } = gcdSite();
  it('accepts partials and complete lines that keep the replaced line\'s bracket shape', () => {
    expect(compileGate(hypothesisToks(['return', 'gcd', '(', '_', ',', '_', '%', '_', ')']), site, true)).toBe(true);
    expect(compileGate(toks('return gcd(b, a % b)'), site, true)).toBe(true);
    expect(compileGate(hypothesisToks(['return', '_', '<op>', '_']), site, true)).toBe(true);
  });
  it('rejects unbalanced brackets, touching operands and operators, and a binary `not`', () => {
    expect(compileGate(toks('return gcd(b, a % b'), site, true)).toBe(false);
    expect(compileGate(hypothesisToks(['return', 'gcd', '(', '_', '_', ')']), site, true)).toBe(false);
    expect(compileGate(toks('return gcd(b, a % % b)'), site, true)).toBe(false);
    const header = siteAt(file, 2);
    expect(compileGate(toks('if b not 0:'), header, true)).toBe(false);
    expect(compileGate(toks('if b != 0:'), header, true)).toBe(true);
    expect(compileGate(toks('if b not in xs:'), header, true)).toBe(true);
    expect(compileGate(toks('if b and 0:'), header, true)).toBe(true);
    expect(compileGate(toks('if not b:'), header, true)).toBe(true);
    // a header must stay a header
    expect(compileGate(toks('if b == 0'), header, true)).toBe(false);
  });
  it('an inserted line only needs to balance on its own', () => {
    const gap = siteAt(file, 5, 'insert');
    expect(compileGate(hypothesisToks(['_', '.', '_', '(', '_', ')']), gap, true)).toBe(true);
    expect(compileGate(toks('return a'), gap, false)).toBe(true);
    expect(compileGate(toks('xs.append(x'), gap, true)).toBe(false);
  });
});
