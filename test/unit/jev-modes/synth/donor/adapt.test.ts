import { describe, expect, it } from 'vitest';
import { adaptIdentifiers, applySubstitutions, swapFamilyPairs } from '../../../../../src/jev-modes/synth/donor/adapt.js';
import { analyse, scopeAt } from '../../../../../src/jev-modes/synth/py/structure.js';

const UNITS = [
  'SIZE_UNITS = {"B": 1}',
  'DURATION_UNITS = {"ms": 1}',
  '',
  'def parse_size(text):',
  '    text = text.strip().upper().replace(" ", "")',
  '    for unit in sorted(SIZE_UNITS, key=len, reverse=True):',
  '        if text.endswith(unit):',
  '            return int(float(text[: -len(unit)]) * SIZE_UNITS[unit])',
  '    return int(text)',
  '',
  'def parse_duration(text):',
  '    text = text.strip()',
  '    number, unit = text[:-1], text[-1]',
  '    return int(number) * DURATION_UNITS.get(unit, 1)',
  '',
].join('\n');
const mod = analyse(UNITS);

describe('adaptIdentifiers', () => {
  it('returns the identity first when every name resolves, then single substitutions ordered by preference', () => {
    const scope = scopeAt(mod, 13);
    const donorScope = scopeAt(mod, 6);
    const out = adaptIdentifiers('for unit in sorted(SIZE_UNITS, key=len, reverse=True):', scope, { donorScope, preferred: ['text', 'number', 'unit', 'DURATION_UNITS', 'int'] });
    expect(out[0]).toMatchObject({ text: 'for unit in sorted(SIZE_UNITS, key=len, reverse=True):', changes: 0, score: 0 });
    // the module-level name used by the site's own function, lexically akin, ranks first among the one-change variants
    expect(out[1]).toMatchObject({ text: 'for unit in sorted(DURATION_UNITS, key=len, reverse=True):', changes: 1 });
    expect(out[1]!.substitutions).toEqual([{ from: 'SIZE_UNITS', to: 'DURATION_UNITS', kind: 'identifier' }]);
    // keyword-argument labels are never rebound; builtins only inside their family
    for (const a of out) {
      expect(a.text).toContain('key=');
      expect(a.text).toContain('reverse=True');
      expect(a.substitutions.every((s) => s.from !== 'key' && s.from !== 'reverse')).toBe(true);
    }
    expect(out.some((a) => a.substitutions.some((s) => s.from === 'sorted' && s.to === 'reversed'))).toBe(true);
    expect(out.some((a) => a.substitutions.some((s) => s.from === 'len' && !['sum'].includes(s.to)))).toBe(false);
    expect(out.every((a, i) => i === 0 || a.changes >= out[i - 1]!.changes)).toBe(true);
  });

  it('swaps attribute families (upper → lower) as one change', () => {
    const scope = scopeAt(mod, 12);
    const out = adaptIdentifiers('text = text.strip().upper().replace(" ", "")', scope, { donorScope: scopeAt(mod, 5), maxChanges: 1 });
    expect(out.map((a) => a.text)).toContain('text = text.strip().lower().replace(" ", "")');
    const lower = out.find((a) => a.text.includes('.lower()'))!;
    expect(lower.substitutions).toEqual([{ from: 'upper', to: 'lower', kind: 'attribute' }]);
    expect(adaptIdentifiers('text = text.strip().upper()', scope, { attributeFamilies: false }).some((a) => a.text.includes('lower'))).toBe(false);
  });

  it('forces out-of-scope donor names to change and enumerates bijective mappings only', () => {
    const m = analyse('def reverse_linked_list(node):\n    prevnode = None\n    while node:\n        nextnode = node.successor\n        node.successor = prevnode\n        node = nextnode\n    return prevnode\n');
    const scope = scopeAt(m, 5);
    const out = adaptIdentifiers('node = nextnode', scope, { donorScope: scopeAt(m, 6), preferred: ['node', 'prevnode', 'nextnode'] });
    const texts = out.map((a) => a.text);
    expect(texts[0]).toBe('node = nextnode');
    expect(texts).toContain('prevnode = node');
    for (const t of texts) {
      const [lhs, rhs] = t.split(' = ');
      expect(lhs).not.toBe(rhs);
    }
    // a name that does not resolve at the site must be replaced: no identity, every result rebinds it
    const bfs = analyse('def bfs(startnode):\n    nodesseen = set()\n    nodesseen.add(startnode)\n');
    const dfs = analyse('def dfs(startnode, goalnode):\n    nodesvisited = set()\n\n    def search_from(node):\n        if node in nodesvisited:\n            return False\n        return any(search_from(n) for n in node.successors)\n');
    const forced = adaptIdentifiers('nodesseen.add(startnode)', scopeAt(dfs, 6), { donorScope: scopeAt(bfs, 3), preferred: ['node', 'nodesvisited', 'search_from'] });
    expect(forced.length).toBeGreaterThan(0);
    expect(forced.every((a) => !a.text.includes('nodesseen'))).toBe(true);
    expect(forced.every((a) => a.changes >= 1)).toBe(true);
    expect(forced[0]!.text).toBe('nodesvisited.add(startnode)');
    expect(forced.map((a) => a.text)).toContain('nodesvisited.add(node)');
  });

  it('gives up when more names are out of scope than changes allowed, and respects maxMappings', () => {
    const scope = scopeAt(mod, 12);
    expect(adaptIdentifiers('alpha.beta(gamma, delta)', scope, { maxChanges: 2 })).toEqual([]);
    const capped = adaptIdentifiers('for unit in sorted(SIZE_UNITS, key=len, reverse=True):', scopeAt(mod, 13), { maxMappings: 3 });
    expect(capped.length).toBe(3);
  });

  it('applySubstitutions replays a mapping on another line of the same statement', () => {
    expect(applySubstitutions('return int(float(text[: -len(unit)]) * SIZE_UNITS[unit])', [{ from: 'SIZE_UNITS', to: 'DURATION_UNITS', kind: 'identifier' }])).toBe('return int(float(text[: -len(unit)]) * DURATION_UNITS[unit])');
  });
});

describe('swapFamilyPairs', () => {
  it('produces the other order of single-letter, table and parameter pairs', () => {
    const gcd = analyse('def gcd(a, b):\n    if b == 0:\n        return a\n    return gcd(a % b, b)\n');
    expect(swapFamilyPairs('return gcd(a % b, b)', scopeAt(gcd, 4))).toEqual([{ text: 'return gcd(b % a, a)', pair: ['a', 'b'] }]);
    expect(swapFamilyPairs('perm[j] < perm[i]').map((s) => s.text)).toEqual(['perm[i] < perm[j]']);
    expect(swapFamilyPairs('while lo <= hi:').map((s) => s.text)).toEqual(['while hi <= lo:']);
    expect(swapFamilyPairs('node = nextnode')).toEqual([]);
  });
});
