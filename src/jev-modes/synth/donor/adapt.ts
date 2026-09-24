/**
 * Code-side identifier adaptation of a donor line to a site (SimFix-style variable mapping):
 * every donor identifier is a hole whose options are the site's in-scope names of the same role;
 * attribute names get their family siblings (`upper` → `lower`); builtins only swap inside a
 * builtin family (`any` → `all`). Mappings are enumerated bijectively up to `maxChanges`
 * substitutions, identity first, then ordered by a preference score so the cap keeps the likely
 * ones: targets already used in the site's function, named in the task/test, of the exact same
 * sub-role, or lexically akin to the donor name (`SIZE_UNITS` → `DURATION_UNITS`).
 *
 * This is the enumerator behind `createDonorSource`; Jev's per-hole Choice (holes.ts) is the
 * alternative when the enumeration would be too wide.
 */
import type { LineScope } from '../py/structure.js';
import { ATTRIBUTE_FAMILIES, builtinSiblings, distinctNames, familySiblings, isFamilyPair, isInScope, nameOccurrences, namesLookAlike, roleOf, scopeNamesForRole, substituteNames } from './names.js';
import type { IdentifierRole } from './names.js';

export interface AdaptOptions {
  /** maximum substitutions per adaptation (default 2) */
  maxChanges?: number;
  /** optional-hole targets kept per hole after ranking (default 4); must-change holes keep up to 12 */
  maxPerHole?: number;
  /** adaptations returned per donor (default 32) */
  maxMappings?: number;
  /** identifiers of the site's enclosing function: strongest target preference */
  preferred?: readonly string[];
  /** identifiers from the task text / failing test (EnumerateOptions.taskIdentifiers) */
  taskIdentifiers?: readonly string[];
  /** scope at the donor line, to read each donor name's role; null → roles read from the site scope */
  donorScope?: LineScope | null;
  /** allow attribute family swaps (default true) */
  attributeFamilies?: boolean;
}

export interface Substitution {
  from: string;
  to: string;
  kind: 'identifier' | 'attribute';
}

export interface Adaptation {
  text: string;
  substitutions: readonly Substitution[];
  changes: number;
  /** Σ target preference (0 for the identity); ordering only, never a Jev substitute */
  score: number;
}

interface Hole {
  name: string;
  kind: 'identifier' | 'attribute';
  mustChange: boolean;
  /** ranked targets with their preference score */
  targets: readonly { to: string; score: number }[];
}

const DEFAULTS = { maxChanges: 2, maxPerHole: 4, maxMappings: 32, mustChangeTargets: 12 } as const;

/** Preference of rebinding donor name `from` to site name `to`. */
export function targetScore(from: string, to: string, ctx: { preferred: ReadonlySet<string>; task: ReadonlySet<string>; exactRole: boolean; lookAlike: boolean }): number {
  let s = 0;
  if (ctx.preferred.has(to)) s += 4;
  if (ctx.task.has(to)) s += 2;
  if (ctx.exactRole) s += 1;
  if (ctx.lookAlike || namesLookAlike(from, to)) s += 1;
  return s;
}

function subRole(name: string, scope: LineScope): 'param' | 'local' | 'module' | 'import' | 'other' {
  if (scope.params.includes(name)) return 'param';
  if (scope.locals.includes(name)) return 'local';
  if (scope.module.includes(name)) return 'module';
  if (scope.imports.includes(name)) return 'import';
  return 'other';
}

function identifierHole(name: string, scope: LineScope, opts: Required<Pick<AdaptOptions, 'maxPerHole'>> & AdaptOptions, preferred: ReadonlySet<string>, task: ReadonlySet<string>): Hole | null {
  const donorScope = opts.donorScope ?? null;
  const inScope = isInScope(name, scope);
  // The donor's own scope says what kind of thing the name is; without it, the site scope is
  // the best guess and an unknown name falls back to "any user-defined name".
  const role: IdentifierRole = donorScope !== null ? roleOf(name, donorScope) : roleOf(name, scope);
  let pool: string[];
  if (role === 'builtin') pool = builtinSiblings(name, scope);
  else pool = scopeNamesForRole(role, scope).filter((n) => n !== name);
  if (role !== 'builtin' && role !== 'unknown' && !inScope && pool.length === 0) pool = scopeNamesForRole('unknown', scope).filter((n) => n !== name);
  const donorSub = donorScope !== null ? subRole(name, donorScope) : null;
  const ranked = pool
    .map((to, order) => ({ to, order, score: targetScore(name, to, { preferred, task, exactRole: donorSub !== null && donorSub === subRole(to, scope), lookAlike: false }) }))
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const mustChange = !inScope && role !== 'builtin';
  const keep = mustChange ? DEFAULTS.mustChangeTargets : opts.maxPerHole;
  const targets = ranked.slice(0, keep).map(({ to, score }) => ({ to, score }));
  if (mustChange && targets.length === 0) return null; // nothing in scope can take the name: donor unusable
  if (targets.length === 0) return { name, kind: 'identifier', mustChange: false, targets: [] };
  return { name, kind: 'identifier', mustChange, targets };
}

function attributeHole(name: string, preferred: ReadonlySet<string>, task: ReadonlySet<string>): Hole {
  const targets = familySiblings(name, ATTRIBUTE_FAMILIES).map((to) => ({ to, score: targetScore(name, to, { preferred, task, exactRole: false, lookAlike: false }) }));
  return { name, kind: 'attribute', mustChange: false, targets };
}

/** k-combinations of indices 0..n-1 in lexicographic order. */
function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const rec = (start: number): void => {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    for (let i = start; i < n; i++) {
      cur.push(i);
      rec(i + 1);
      cur.pop();
    }
  };
  rec(0);
  return out;
}

/**
 * Every adaptation of `donorText` to `scope` with at most `maxChanges` substitutions, identity
 * first (when every donor identifier already resolves), then by changes ascending and score
 * descending. Returns [] when the donor needs more out-of-scope names replaced than allowed.
 */
export function adaptIdentifiers(donorText: string, scope: LineScope, options: AdaptOptions = {}): Adaptation[] {
  const opts = { ...options, maxPerHole: options.maxPerHole ?? DEFAULTS.maxPerHole };
  const maxChanges = options.maxChanges ?? DEFAULTS.maxChanges;
  const maxMappings = options.maxMappings ?? DEFAULTS.maxMappings;
  const preferred = new Set(options.preferred ?? []);
  const task = new Set(options.taskIdentifiers ?? []);
  const occurrences = nameOccurrences(donorText);
  const identifiers = distinctNames(occurrences, 'identifier');
  const attributes = options.attributeFamilies === false ? [] : distinctNames(occurrences, 'attribute');

  const holes: Hole[] = [];
  for (const name of identifiers) {
    const h = identifierHole(name, scope, opts, preferred, task);
    if (h === null) return [];
    if (h.targets.length > 0) holes.push(h);
  }
  for (const name of attributes) {
    const h = attributeHole(name, preferred, task);
    if (h.targets.length > 0) holes.push(h);
  }
  const must = holes.filter((h) => h.mustChange);
  if (must.length > maxChanges) return [];
  const optional = holes.filter((h) => !h.mustChange);

  const results: Adaptation[] = [];
  const seen = new Set<string>();
  const emit = (subs: Substitution[]): void => {
    // bijective: two distinct donor identifiers never collapse onto one site name, and a
    // substituted identifier never lands on a name the line still uses unchanged (`node = node`)
    const idMap = new Map<string, string>();
    const attrMap = new Map<string, string>();
    for (const s of subs) (s.kind === 'identifier' ? idMap : attrMap).set(s.from, s.to);
    const finalNames = identifiers.map((n) => idMap.get(n) ?? n);
    if (new Set(finalNames).size !== finalNames.length) return;
    const text = substituteNames(donorText, idMap, attrMap);
    if (seen.has(text)) return;
    seen.add(text);
    results.push({ text, substitutions: subs, changes: subs.length, score: subs.reduce((acc, s) => acc + scoreOf(s), 0) });
  };
  const scoreOf = (s: Substitution): number => holes.find((h) => h.name === s.from && h.kind === s.kind)?.targets.find((t) => t.to === s.to)?.score ?? 0;

  for (let changes = must.length; changes <= maxChanges; changes++) {
    const batch: Adaptation[] = [];
    const before = results.length;
    for (const combo of combinations(optional.length, changes - must.length)) {
      const chosen = [...must, ...combo.map((i) => optional[i]!)];
      // cartesian product over the chosen holes' targets
      const rec = (k: number, acc: Substitution[]): void => {
        if (k === chosen.length) {
          emit(acc);
          return;
        }
        const h = chosen[k]!;
        for (const t of h.targets) rec(k + 1, [...acc, { from: h.name, to: t.to, kind: h.kind }]);
      };
      rec(0, []);
    }
    batch.push(...results.splice(before));
    batch.sort((a, b) => b.score - a.score || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
    results.push(...batch);
    if (results.length >= maxMappings) break;
  }
  return results.slice(0, maxMappings);
}

/** Apply a recorded substitution list to another line (a donor statement's body lines share the header's mapping). */
export function applySubstitutions(text: string, substitutions: readonly Substitution[]): string {
  const idMap = new Map<string, string>();
  const attrMap = new Map<string, string>();
  for (const s of substitutions) (s.kind === 'identifier' ? idMap : attrMap).set(s.from, s.to);
  return substituteNames(text, idMap, attrMap);
}

export interface FamilySwap {
  text: string;
  pair: readonly [string, string];
}

/**
 * Both orders of every same-family identifier pair in `text` (`i`/`j`, `a`/`b`, two
 * parameters): swapping two names of the same type is the position judgement Jev gets wrong
 * most (probe-donor §2, probe-token-synthesis §T5), so the search tests both instead of asking.
 */
export function swapFamilyPairs(text: string, scope?: LineScope): FamilySwap[] {
  const names = distinctNames(nameOccurrences(text), 'identifier');
  const out: FamilySwap[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i]!;
      const b = names[j]!;
      if (!isFamilyPair(a, b, scope)) continue;
      const swapped = substituteNames(text, new Map([[a, b], [b, a]]));
      if (swapped !== text) out.push({ text: swapped, pair: [a, b] });
    }
  }
  return out;
}
