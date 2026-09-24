import { describe, expect, it } from 'vitest';
import { analyse, scopeAt } from '../../../../../src/jev-modes/synth/py/structure.js';
import { ATTRIBUTE_FAMILIES, distinctNames, familySiblings, isFamilyPair, nameOccurrences, namesLookAlike, roleOf, scopeNamesForRole, substituteNames } from '../../../../../src/jev-modes/synth/donor/names.js';

describe('nameOccurrences', () => {
  it('classifies identifiers, attributes and keyword-argument labels; skips keywords but keeps the constants True/False/None', () => {
    const occ = nameOccurrences('for unit in sorted(SIZE_UNITS, key=len, reverse=True):');
    expect(occ.map((o) => [o.name, o.kind])).toEqual([
      ['unit', 'identifier'],
      ['sorted', 'identifier'],
      ['SIZE_UNITS', 'identifier'],
      ['key', 'keyword_arg'],
      ['len', 'identifier'],
      ['reverse', 'keyword_arg'],
      ['True', 'identifier'],
    ]);
    // the measured changed slot `while True:` → `while queue:` (breadth_first_search) needs True as a hole
    expect(nameOccurrences('while True:').map((o) => [o.name, o.kind])).toEqual([['True', 'identifier']]);
    expect(nameOccurrences('return None if x is None else x').map((o) => o.name)).toEqual(['None', 'x', 'None', 'x']);
    expect(substituteNames('while True:', new Map([['True', 'queue']]))).toBe('while queue:');
    expect(nameOccurrences('text = text.strip().upper().replace(" ", "")').map((o) => `${o.kind}:${o.name}`)).toEqual(['identifier:text', 'identifier:text', 'attribute:strip', 'attribute:upper', 'attribute:replace']);
  });
  it('does not treat assignment `=` outside parentheses as a keyword argument, and keeps spans exact', () => {
    const occ = nameOccurrences('x = f(a=1)[b]');
    expect(occ.map((o) => [o.name, o.kind])).toEqual([['x', 'identifier'], ['f', 'identifier'], ['a', 'keyword_arg'], ['b', 'identifier']]);
    for (const o of occ) expect('x = f(a=1)[b]'.slice(o.start, o.end)).toBe(o.name);
  });
  it('distinctNames keeps first-occurrence order per kind', () => {
    expect(distinctNames(nameOccurrences('a.b(a, c).b'), 'identifier')).toEqual(['a', 'c']);
    expect(distinctNames(nameOccurrences('a.b(a, c).b'), 'attribute')).toEqual(['b']);
  });
});

describe('substituteNames', () => {
  it('rebinds every occurrence of an identifier and leaves attributes and labels alone', () => {
    expect(substituteNames('node = nextnode', new Map([['node', 'prevnode'], ['nextnode', 'node']]))).toBe('prevnode = node');
    expect(substituteNames('f(len=len, x=len)', new Map([['len', 'size']]))).toBe('f(len=size, x=size)');
    expect(substituteNames('text.upper()', new Map([['upper', 'lower']]))).toBe('text.upper()');
    expect(substituteNames('text.upper()', new Map(), new Map([['upper', 'lower']]))).toBe('text.lower()');
  });
});

describe('roles', () => {
  const mod = analyse('import os\nLIMIT = 3\n\ndef f(a, b):\n    total = a + b\n    return total\n');
  const scope = scopeAt(mod, 6);
  it('reads params and locals as variables, module names and imports as module-level, else builtin/unknown', () => {
    expect(roleOf('a', scope)).toBe('variable');
    expect(roleOf('total', scope)).toBe('variable');
    expect(roleOf('LIMIT', scope)).toBe('module');
    expect(roleOf('os', scope)).toBe('module');
    expect(roleOf('len', scope)).toBe('builtin');
    expect(roleOf('nothing', scope)).toBe('unknown');
  });
  it('offers same-role names; unknown names may take any user-defined name; builtins none', () => {
    expect(scopeNamesForRole('variable', scope)).toEqual(['a', 'b', 'total']);
    expect(scopeNamesForRole('module', scope)).toEqual(['LIMIT', 'f', 'os']);
    expect(scopeNamesForRole('builtin', scope)).toEqual([]);
    expect(scopeNamesForRole('unknown', scope)).toEqual(['a', 'b', 'total', 'LIMIT', 'f', 'os']);
  });
});

describe('families', () => {
  it('lists siblings without the name itself', () => {
    expect(familySiblings('upper', ATTRIBUTE_FAMILIES)).toEqual(['lower']);
    expect(familySiblings('strip', ATTRIBUTE_FAMILIES)).toEqual(['lstrip', 'rstrip']);
    expect(familySiblings('pop', ATTRIBUTE_FAMILIES)).toEqual(['popleft', 'get']);
    expect(familySiblings('nothing', ATTRIBUTE_FAMILIES)).toEqual([]);
  });
  it('pairs single letters, table rows and two parameters', () => {
    const mod = analyse('def gcd(a, b):\n    return gcd(a % b, b)\n');
    const scope = scopeAt(mod, 2);
    expect(isFamilyPair('i', 'j')).toBe(true);
    expect(isFamilyPair('lo', 'hi')).toBe(true);
    expect(isFamilyPair('node', 'nextnode')).toBe(false);
    expect(isFamilyPair('a', 'a')).toBe(false);
    expect(isFamilyPair('gcd', 'a', scope)).toBe(false);
    expect(isFamilyPair('a', 'b', scope)).toBe(true);
  });
  it('namesLookAlike needs a shared prefix or suffix of three characters', () => {
    expect(namesLookAlike('SIZE_UNITS', 'DURATION_UNITS')).toBe(true);
    expect(namesLookAlike('nodesseen', 'nodesvisited')).toBe(true);
    expect(namesLookAlike('arr', 'counts')).toBe(false);
    expect(namesLookAlike('ab', 'ab')).toBe(true);
  });
});
