/**
 * docs/IMPORT-DESIGN.md §2.10.4 / §2.5 / §2.8 (`rulePatterns`, `ruleFiles` **[G1.6]**) — rule activation.
 *
 * `matchRules` runs once per step on the hot path, so the properties are about cost as much as about
 * correctness: memoised per step (a repeat is free), `ruleFiles`-capped, one glob test per new
 * `(pattern, path)` pair — and a pathological pattern must not blow up, which the single-backtrack
 * matcher makes structural rather than a timeout.
 */
import { describe, expect, it } from 'vitest';

import { IMPORT_LIMITS } from '../../../src/core/limits.js';
import { createRuleMatcher, expandBraces, globMatch, matchRules } from '../../../src/import/rules.js';
import type { MemoryItem } from '../../../src/import/types.js';

function rule(name: string, paths: readonly string[] | null, trigger?: MemoryItem['trigger']): MemoryItem {
  return {
    name,
    description: `${name} rule`,
    kind: 'rule',
    scope: 'project',
    ...(paths !== null ? { paths } : {}),
    ...(trigger !== undefined ? { trigger } : {}),
    source: { tool: 'cursor', path: `~/.cursor/rules/${name}.mdc`, sha256: 'a'.repeat(64), imported: '2026-09-21T12:00:00.000Z', importId: 'imp_20260921T120000Z_a1b2c3' },
    redacted: 0,
    clipped: 0,
    body: `body of ${name}`,
  };
}

describe('globMatch (§2.10.4)', () => {
  it('matches `**`, `*`, `?`, `{a,b}` and character classes', () => {
    // `**` crosses separators, `*` does not
    expect(globMatch('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
    expect(globMatch('src/**/*.ts', 'src/c.ts')).toBe(true);
    expect(globMatch('src/*/c.ts', 'src/a/b/c.ts')).toBe(false);
    expect(globMatch('src/*.ts', 'src/a.ts')).toBe(true);
    expect(globMatch('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(globMatch('**', 'anything/at/all.md')).toBe(true);
    expect(globMatch('**/*', 'a')).toBe(true);
    expect(globMatch('src/**', 'src')).toBe(true);
    expect(globMatch('src/**', 'other/x.ts')).toBe(false);

    // `?` is exactly one character, within a segment
    expect(globMatch('src/?.ts', 'src/a.ts')).toBe(true);
    expect(globMatch('src/?.ts', 'src/ab.ts')).toBe(false);
    expect(globMatch('src/a?c', 'src/a/c')).toBe(false);

    // braces, including nesting and a brace beside a star
    expect(globMatch('src/**/*.{ts,tsx}', 'src/tui/App.tsx')).toBe(true);
    expect(globMatch('src/**/*.{ts,tsx}', 'src/tui/App.jsx')).toBe(false);
    expect(globMatch('{src,test}/**/*.ts', 'test/unit/a.ts')).toBe(true);
    expect(globMatch('a{b,{c,d}}e.md', 'ade.md')).toBe(true);
    expect(globMatch('a{b,{c,d}}e.md', 'aee.md')).toBe(false);

    // character classes, ranges and negation
    expect(globMatch('src/[abc].ts', 'src/b.ts')).toBe(true);
    expect(globMatch('src/[abc].ts', 'src/d.ts')).toBe(false);
    expect(globMatch('src/[a-z]*.ts', 'src/zoo.ts')).toBe(true);
    expect(globMatch('src/[!a-z]*.ts', 'src/Zoo.ts')).toBe(true);
    expect(globMatch('src/[!a-z]*.ts', 'src/zoo.ts')).toBe(false);
    expect(globMatch('src/[^a-z]*.ts', 'src/9.ts')).toBe(true);
    // an unterminated class is a literal bracket, not a crash
    expect(globMatch('src/[ab.ts', 'src/[ab.ts')).toBe(true);

    // a pattern with no `/` matches the basename at any depth — what a Cursor `globs:`, a Copilot
    // `applyTo:` and a Claude `paths:` all mean
    expect(globMatch('*.ts', 'src/deep/a.ts')).toBe(true);
    expect(globMatch('*.ts', 'src/deep/a.tsx')).toBe(false);
    expect(globMatch('README.md', 'docs/README.md')).toBe(true);
    // …while anything with a `/` is anchored at the path root
    expect(globMatch('docs/*.md', 'deep/docs/a.md')).toBe(false);

    // separators normalise, `./` is not a segment, and the empty cases are false rather than a throw
    expect(globMatch('src/**/*.ts', './src/a.ts')).toBe(true);
    expect(globMatch('src\\**\\*.ts', 'src/a/b.ts')).toBe(true);
    expect(globMatch('', 'a.ts')).toBe(false);
    expect(globMatch('*.ts', '')).toBe(false);
  });

  it('a pathological pattern does not blow up — the matcher has one backtrack pointer, not a stack', () => {
    const pattern = `${'*/'.repeat(24)}**/*a*a*a*a*a*a*a*a*a*a*a*a*b`;
    const path = `${'x/'.repeat(24)}${'a'.repeat(4000)}`;
    const started = Date.now();
    expect(globMatch(pattern, path)).toBe(false);
    expect(globMatch(`${'a*'.repeat(50)}b`, 'a'.repeat(2000))).toBe(false);
    expect(globMatch(`${'**/'.repeat(40)}z.ts`, `${'d/'.repeat(40)}y.ts`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('expandBraces (§2.8 rulePatterns)', () => {
  it('expands, dedupes and stops at the cap rather than allocating', () => {
    expect(expandBraces('a{b,c}d')).toEqual(['abd', 'acd']);
    expect(expandBraces('{a,b}{c,d}')).toEqual(['ac', 'ad', 'bc', 'bd']);
    expect(expandBraces('a{b,b}c')).toEqual(['abc']);
    expect(expandBraces('no braces')).toEqual(['no braces']);
    expect(expandBraces('unclosed {a,b')).toEqual(['unclosed {a,b']);
    const exploded = expandBraces('{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}');
    expect(exploded.length).toBeLessThanOrEqual(IMPORT_LIMITS.rulePatterns);
    expect(expandBraces('{a,b}{c,d}', 2)).toHaveLength(2);
  });
});

describe('matchRules / createRuleMatcher (§2.10.4)', () => {
  it('activates a rule when any pattern matches any path in view, and never a manual one', () => {
    const rules = [rule('style', ['src/**/*.ts']), rule('docs', ['docs/**/*.md']), rule('always', ['**'], 'always'), rule('manual', ['**'], 'manual')];
    expect(matchRules(rules, ['src/tui/App.ts']).map((r) => r.name)).toEqual(['style', 'always']);
    expect(matchRules(rules, ['docs/a.md']).map((r) => r.name)).toEqual(['docs', 'always']);
    expect(matchRules(rules, ['README']).map((r) => r.name)).toEqual(['always']);
    expect(matchRules(rules, []).map((r) => r.name)).toEqual(['always']);
    // a rule with no `paths` and no trigger is index-only: it is never activated by a path
    expect(matchRules([rule('bare', null)], ['a.ts'])).toEqual([]);
    // `trigger: paths` with an empty list is the same
    expect(matchRules([rule('empty', [], 'paths')], ['a.ts'])).toEqual([]);
  });

  it('a rule with no match costs exactly one glob test, and a repeat costs none', () => {
    const rules = [rule('nope', ['docs/**/*.md'])];
    const m = createRuleMatcher(rules);
    expect(m.size).toBe(1);
    expect(m.tests).toBe(0);
    expect(m.match(['src/a.ts'])).toEqual([]);
    expect(m.tests).toBe(1);
    // the step memo: the identical path set is answered from cache, by reference
    const first = m.match(['src/a.ts']);
    const second = m.match(['src/a.ts']);
    expect(second).toBe(first);
    expect(m.tests).toBe(1);
    // a different path set re-asks, but the `(pattern, path)` memo is shared across steps
    expect(m.match(['src/a.ts', 'docs/b.md']).map((r) => r.name)).toEqual(['nope']);
    expect(m.tests).toBe(2);
    expect(m.match(['docs/b.md', 'src/a.ts']).map((r) => r.name)).toEqual(['nope']);
    expect(m.tests).toBe(2);
  });

  it('matchRules memoises on the rules array itself, so a run compiles once and re-asks for free', () => {
    const rules = [rule('style', ['src/**/*.ts'])];
    const a = matchRules(rules, ['src/a.ts']);
    const b = matchRules(rules, ['src/a.ts']);
    expect(b).toBe(a);
    // a different array is a different matcher, even with equal contents
    expect(matchRules([...rules], ['src/a.ts'])).not.toBe(a);
    // narrowing a bound rebuilds rather than reusing a matcher built under a wider one
    expect(matchRules(rules, ['src/a.ts'], { maxRules: 0 })).toEqual([]);
    expect(matchRules(rules, ['src/a.ts'])).toHaveLength(1);
  });

  it('is capped at ruleFiles rules and rulePatterns patterns [G1.6]', () => {
    const many = Array.from({ length: IMPORT_LIMITS.ruleFiles + 50 }, (_, i) => rule(`r${i}`, ['**'], 'always'));
    expect(createRuleMatcher(many).size).toBe(IMPORT_LIMITS.ruleFiles);
    expect(matchRules(many, ['a.ts'])).toHaveLength(IMPORT_LIMITS.ruleFiles);

    // the patterns beyond the cap are not consulted: the only matching one is last
    const wide = [rule('wide', [...Array.from({ length: IMPORT_LIMITS.rulePatterns }, (_, i) => `never-${i}/**`), 'src/**/*.ts'])];
    expect(matchRules(wide, ['src/a.ts'])).toEqual([]);
    expect(matchRules(wide, ['src/a.ts'], { maxPatterns: IMPORT_LIMITS.rulePatterns + 1 })).toHaveLength(1);

    // a caller may narrow a bound but the default is the ceiling
    expect(createRuleMatcher(many, { maxRules: 3 }).size).toBe(3);
  });

  it('the returned list is frozen, so a caller cannot mutate one step’s answer into the next', () => {
    const m = createRuleMatcher([rule('style', ['**'], 'always')]);
    const out = m.match(['a.ts']);
    expect(Object.isFrozen(out)).toBe(true);
  });
});
