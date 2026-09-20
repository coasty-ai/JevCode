/**
 * Name-level view of one Python line for donor adaptation: which NAME tokens are rebindable
 * identifiers (not attributes after `.`, not keyword-argument names before `=`), what role
 * each in-scope name plays (variable / module / builtin), and the small "family" tables that
 * let a donor swap `upper`↔`lower`, `any`↔`all` or `i`↔`j` when no in-scope name can.
 *
 * Roles are deliberately coarse. Parameters and locals are both "variables" because a donor
 * line `node = nextnode` (param := local) must be allowed to become `prevnode = node`
 * (local := param) — the QuixBugs `reverse_linked_list` insertion needs exactly that.
 */
import { isKeyword, tokenizeFragment } from '../py/tokenize.js';
import type { LineScope } from '../py/structure.js';

export type OccurrenceKind = 'identifier' | 'attribute' | 'keyword_arg';

/**
 * `True` / `False` / `None` are keywords to the tokenizer but NAME-shaped constants to a donor:
 * the measured hole probe (probe-donor §2) treated them as identifier slots, and one of the 13
 * changed slots is exactly `while True:` → `while queue:` (breadth_first_search). They are
 * offered as options through COMMON_BUILTINS and PY_BUILTINS, so they resolve in every scope.
 */
export const CONSTANT_NAMES: ReadonlySet<string> = new Set(['True', 'False', 'None']);

/** One NAME token of a line with its character span. */
export interface NameOccurrence {
  name: string;
  start: number;
  end: number;
  kind: OccurrenceKind;
}

/**
 * NAME tokens of a line, classified. Keywords (`for`, `in`, `return`, …) are skipped, the
 * constants `True` / `False` / `None` are not (see CONSTANT_NAMES). A name right after `.` is an
 * attribute; a name right before `=` inside parentheses is a keyword-argument label (`key=len`)
 * and must never be rebound.
 */
export function nameOccurrences(text: string): NameOccurrence[] {
  const toks = tokenizeFragment(text).filter((t) => t.type !== 'NL' && t.type !== 'COMMENT');
  const out: NameOccurrence[] = [];
  let parenDepth = 0;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    if (t.type === 'OP') {
      if (t.text === '(') parenDepth++;
      else if (t.text === ')') parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (t.type !== 'NAME' || (isKeyword(t.text) && !CONSTANT_NAMES.has(t.text))) continue;
    const prev = toks[k - 1];
    const next = toks[k + 1];
    let kind: OccurrenceKind = 'identifier';
    if (prev !== undefined && prev.type === 'OP' && prev.text === '.') kind = 'attribute';
    else if (parenDepth > 0 && next !== undefined && next.type === 'OP' && next.text === '=') kind = 'keyword_arg';
    out.push({ name: t.text, start: t.start, end: t.end, kind });
  }
  return out;
}

/** Distinct names of one kind, in first-occurrence order. */
export function distinctNames(occurrences: readonly NameOccurrence[], kind: OccurrenceKind): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of occurrences) {
    if (o.kind !== kind || seen.has(o.name)) continue;
    seen.add(o.name);
    out.push(o.name);
  }
  return out;
}

/** Replace names in `text` by `mapping` (identifiers and attributes separately), spans from `nameOccurrences`. */
export function substituteNames(text: string, identifiers: ReadonlyMap<string, string>, attributes: ReadonlyMap<string, string> = new Map()): string {
  const occ = nameOccurrences(text);
  let out = text;
  // right-to-left so earlier spans stay valid after a replacement changes the length
  for (let k = occ.length - 1; k >= 0; k--) {
    const o = occ[k]!;
    const table = o.kind === 'identifier' ? identifiers : o.kind === 'attribute' ? attributes : null;
    const to = table?.get(o.name);
    if (to === undefined || to === o.name) continue;
    out = out.slice(0, o.start) + to + out.slice(o.end);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------------------

export type IdentifierRole = 'variable' | 'module' | 'builtin' | 'class_attr' | 'unknown';

/** Role of `name` in `scope`: params and locals are variables, module names and imports are module-level, else builtin / class attribute / unknown. */
export function roleOf(name: string, scope: LineScope): IdentifierRole {
  if (scope.params.includes(name) || scope.locals.includes(name)) return 'variable';
  if (scope.module.includes(name) || scope.imports.includes(name)) return 'module';
  if (scope.builtins.includes(name)) return 'builtin';
  if (scope.classAttrs.includes(name)) return 'class_attr';
  return 'unknown';
}

/** Names in `scope` that a donor identifier of `role` may be rebound to (builtins only via families; see `builtinSiblings`). */
export function scopeNamesForRole(role: IdentifierRole, scope: LineScope): string[] {
  const variables = uniq([...scope.params, ...scope.locals]);
  const moduleNames = uniq([...scope.module, ...scope.imports]);
  switch (role) {
    case 'variable':
      return variables;
    case 'module':
      return moduleNames;
    case 'builtin':
      return [];
    case 'class_attr':
    case 'unknown':
      // a name the donor's own scope cannot place (or a bare class attribute, which Python
      // would not resolve without `self.`): every user-defined name of the site may take its place
      return uniq([...variables, ...moduleNames]);
  }
}

/** True when a bare `name` resolves at the site (params, locals, module names, imports, builtins). */
export function isInScope(name: string, scope: LineScope): boolean {
  return scope.all.includes(name);
}

// ---------------------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------------------

/** Identifier pairs/triples that are routinely confused for one another (same type, symmetric roles). */
export const IDENTIFIER_FAMILIES: readonly (readonly string[])[] = [
  ['i', 'j', 'k'], ['a', 'b'], ['x', 'y', 'z'], ['n', 'm'], ['p', 'q'], ['u', 'v'], ['s', 't'],
  ['lo', 'hi'], ['low', 'high'], ['left', 'right'], ['start', 'end'], ['begin', 'end'], ['first', 'last'],
  ['src', 'dst'], ['source', 'target'], ['key', 'value'], ['row', 'col'], ['min', 'max'], ['lower', 'upper'],
  ['head', 'tail'], ['prev', 'next'], ['old', 'new'], ['before', 'after'], ['inner', 'outer'], ['width', 'height'],
];

/** Attribute / method names with a sibling of the same arity and receiver type. */
export const ATTRIBUTE_FAMILIES: readonly (readonly string[])[] = [
  ['upper', 'lower'], ['isupper', 'islower'], ['lstrip', 'rstrip', 'strip'], ['ljust', 'rjust'],
  ['startswith', 'endswith'], ['find', 'rfind'], ['index', 'rindex'], ['split', 'rsplit'],
  ['append', 'extend'], ['append', 'appendleft'], ['pop', 'popleft'], ['add', 'remove', 'discard'],
  ['keys', 'values', 'items'], ['get', 'pop'], ['encode', 'decode'], ['read', 'write'],
  ['union', 'intersection', 'difference'], ['isdigit', 'isalpha', 'isalnum'], ['floor', 'ceil'],
  ['successor', 'predecessor'], ['successors', 'predecessors'], ['incoming_nodes', 'outgoing_nodes'],
  ['left', 'right'], ['first', 'last'], ['min', 'max'], ['any', 'all'],
];

/** Builtins that a donor may swap for one another (the only way a builtin identifier is ever rebound). */
export const BUILTIN_FAMILIES: readonly (readonly string[])[] = [
  ['any', 'all'], ['min', 'max'], ['sum', 'len'], ['sorted', 'reversed'], ['int', 'float', 'str'],
  ['list', 'set', 'tuple', 'dict'], ['abs', 'round'], ['map', 'filter'],
];

/** Every other member of every family containing `name`, in table order, de-duplicated. */
export function familySiblings(name: string, families: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const fam of families) {
    if (!fam.includes(name)) continue;
    for (const other of fam) if (other !== name && !out.includes(other)) out.push(other);
  }
  return out;
}

/** Builtin siblings of `name` that the site's builtin list knows. */
export function builtinSiblings(name: string, scope: LineScope): string[] {
  return familySiblings(name, BUILTIN_FAMILIES).filter((s) => scope.builtins.includes(s));
}

/**
 * Two identifiers form a same-family pair when both are single letters, both sit in one
 * IDENTIFIER_FAMILIES row, or both are parameters of the enclosing function (`gcd(a % b, b)`
 * → `gcd(b, a % b)` is a position judgement Jev gets wrong; producing both orders is cheaper).
 */
export function isFamilyPair(a: string, b: string, scope?: LineScope): boolean {
  if (a === b) return false;
  if (a.length === 1 && b.length === 1 && /[a-zA-Z]/.test(a) && /[a-zA-Z]/.test(b)) return true;
  if (IDENTIFIER_FAMILIES.some((fam) => fam.includes(a) && fam.includes(b))) return true;
  if (scope !== undefined && scope.params.includes(a) && scope.params.includes(b)) return true;
  return false;
}

/** Cheap lexical kinship: shared prefix or suffix of ≥ 3 characters, case-insensitive (`SIZE_UNITS` ~ `DURATION_UNITS`, `nodesseen` ~ `nodesvisited`). */
export function namesLookAlike(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  return p >= 3 || s >= 3;
}

export function uniq(items: readonly string[]): string[] {
  return [...new Set(items)];
}
