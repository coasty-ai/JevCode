/**
 * Per-site token vocabulary: the option set every next-token and slot Choice is drawn from.
 * Code proposes (identifiers in scope, attributes seen on receivers, keywords, operators,
 * punctuation, literals from the function and the failing tests, END_OF_LINE); Jev only ever
 * picks from this list. Measured coverage of fix-line tokens with this recipe: 386/386
 * (probe-token-synthesis.md §1). Order is stable so option lists are deterministic.
 */
import type { Json } from '../../../core/types.js';
import { functionAt } from '../py/index.js';
import type { EnumerateOptions, Site } from '../types.js';
import { LITERAL_KEYWORDS, OPERATOR_TEXTS, PUNCT_TEXTS, keyAndDescription, toks } from './tokens.js';
import type { Tok } from './tokens.js';

export const END_KEY = 'end_of_line';
export const END_DESCRIPTION: Json = { kind: 'end', meaning: 'the partial line is already the complete correct line; nothing more to add' };

/** Keywords a single-line statement or expression can contain (measured list). */
export const KEYWORDS: readonly string[] = [
  'and', 'or', 'not', 'in', 'is', 'if', 'else', 'elif', 'for', 'while', 'return', 'yield', 'lambda', 'def', 'break', 'continue', 'pass', 'import', 'from', 'as', 'del', 'assert', 'with', 'class', 'try', 'except', 'raise', 'global',
];
/** Builtins worth offering even when the function does not use them yet (measured list). */
export const COMMON_BUILTINS: readonly string[] = [
  'len', 'max', 'min', 'range', 'enumerate', 'list', 'set', 'dict', 'tuple', 'all', 'any', 'abs', 'sum', 'sorted', 'reversed', 'zip', 'map', 'str', 'int', 'float', 'isinstance', 'print', 'iter', 'next',
];
/** Method names common enough to offer after a `.` even when unseen (`.add` was the one uncovered token). */
export const COMMON_METHODS: readonly string[] = ['add', 'append', 'pop', 'extend', 'update', 'get', 'items', 'keys', 'values', 'remove', 'insert', 'join', 'split', 'sort', 'copy'];

/** Hard limits: a Choice holds at most 255 options including the escape and END_OF_LINE. */
export const MAX_VOCAB_TOKENS = 250;
export const MAX_LITERALS = 40;
export const MAX_STRING_LITERAL_CHARS = 20;

const IDENT_RE = /^[A-Za-z_]\w*$/;

export interface VocabToken {
  key: string;
  tok: Tok;
  description: Json;
  /** Only legal after a `.`: an attribute or method name never seen as a bare name. */
  attributeOnly: boolean;
}

export interface Vocabulary {
  tokens: VocabToken[];
  byKey: Map<string, VocabToken>;
  byText: Map<string, VocabToken>;
}

class VocabBuilder {
  readonly tokens: VocabToken[] = [];
  readonly byText = new Map<string, VocabToken>();
  private readonly keys = new Set<string>();

  add(tok: Tok, kind: string | undefined, attributeOnly: boolean): void {
    const existing = this.byText.get(tok.text);
    if (existing !== undefined) {
      // a name seen bare as well as after a dot is legal everywhere
      if (!attributeOnly) existing.attributeOnly = false;
      return;
    }
    const { key, description } = keyAndDescription(tok, kind);
    let k = key;
    let n = 2;
    while (this.keys.has(k)) k = `${key}_${n++}`;
    this.keys.add(k);
    const vt: VocabToken = { key: k, tok, description, attributeOnly };
    this.tokens.push(vt);
    this.byText.set(tok.text, vt);
  }
}

function isIdentifier(s: string): boolean {
  return IDENT_RE.test(s) && !KEYWORDS.includes(s) && !LITERAL_KEYWORDS.has(s);
}

/** Number and string tokens of a free-text literal ("17", "'abc'", "[1, 2]" yields 1 and 2). */
function literalToks(text: string): Tok[] {
  return toks(text).filter((t) => t.cls === 'number' || t.cls === 'string');
}

/**
 * Build the vocabulary for a site. Identifier priority (for the cap): scope (params, locals,
 * class attributes, imports, module names), names used in the enclosing function, task
 * identifiers, common builtins; then attributes seen on receivers and common method
 * names (dot-only); keywords; True/False/None; operators and punctuation; literals from the
 * function, the rest of the module and the failing tests (numbers and short strings, ≤ 40).
 */
export function buildVocabulary(site: Site, opts: EnumerateOptions): Vocabulary {
  const b = new VocabBuilder();
  const mod = site.file.mod;
  const fn = functionAt(mod, site.line);
  const name = (s: string, kind?: string): void => {
    if (isIdentifier(s)) b.add({ text: s, cls: 'identifier' }, kind, false);
  };

  // scope categories first so a name's description says what it is (parameter, import, ...)
  for (const id of site.scope.params) name(id, 'parameter');
  for (const id of site.scope.locals) name(id, 'local variable');
  if (site.scope.selfName !== null) name(site.scope.selfName, 'parameter');
  for (const id of site.scope.classAttrs) name(id, 'class attribute');
  for (const id of site.scope.imports) name(id, 'imported name');
  for (const id of site.scope.module) name(id, 'module-level name');
  for (const id of fn?.identifiers ?? []) name(id);
  for (const id of opts.taskIdentifiers) name(id, 'identifier named by the task or test');
  for (const bi of COMMON_BUILTINS) name(bi, 'builtin');

  for (const a of fn?.attributes ?? []) if (isIdentifier(a.attr)) b.add({ text: a.attr, cls: 'identifier' }, 'attribute or method name', true);
  for (const m of COMMON_METHODS) b.add({ text: m, cls: 'identifier' }, 'common method name', true);

  for (const k of KEYWORDS) b.add({ text: k, cls: 'keyword' }, undefined, false);
  for (const l of LITERAL_KEYWORDS) b.add({ text: l, cls: 'literal' }, undefined, false);
  for (const o of OPERATOR_TEXTS) b.add({ text: o, cls: 'operator' }, undefined, false);
  for (const p of PUNCT_TEXTS) b.add({ text: p, cls: 'punct' }, undefined, false);

  const literalSources: Tok[] = [];
  const pushLiterals = (numbers: readonly string[], strings: readonly string[]): void => {
    for (const n of numbers) literalSources.push({ text: n, cls: 'number' });
    for (const s of strings) literalSources.push({ text: s, cls: 'string' });
  };
  if (fn !== undefined) pushLiterals(fn.literals.numbers, fn.literals.strings);
  for (const other of mod.functions) if (other !== fn) pushLiterals(other.literals.numbers, other.literals.strings);
  for (const lit of opts.testLiterals) literalSources.push(...literalToks(lit));
  let literals = 0;
  for (const t of literalSources) {
    if (literals >= MAX_LITERALS) break;
    if (t.cls === 'string' && t.text.length > MAX_STRING_LITERAL_CHARS) continue;
    if (b.byText.has(t.text)) continue;
    b.add(t, undefined, false);
    literals++;
  }

  // Cap: drop literals first, then the lowest-priority identifiers, never syntax tokens.
  let tokens = b.tokens;
  if (tokens.length > MAX_VOCAB_TOKENS) {
    const syntax = tokens.filter((t) => t.tok.cls !== 'identifier' && t.tok.cls !== 'number' && t.tok.cls !== 'string');
    const identifiers = tokens.filter((t) => t.tok.cls === 'identifier');
    const lits = tokens.filter((t) => t.tok.cls === 'number' || t.tok.cls === 'string');
    const room = Math.max(0, MAX_VOCAB_TOKENS - syntax.length);
    const keptIds = identifiers.slice(0, room);
    const keptLits = lits.slice(0, Math.max(0, room - keptIds.length));
    tokens = [...keptIds, ...syntax, ...keptLits];
  }
  const byKey = new Map(tokens.map((t) => [t.key, t]));
  const byText = new Map(tokens.map((t) => [t.tok.text, t]));
  return { tokens, byKey, byText };
}

/** Identifier/literal subset a template slot can take. */
export function slotTokens(vocab: Vocabulary): VocabToken[] {
  return vocab.tokens.filter((t) => t.tok.cls === 'identifier' || t.tok.cls === 'number' || t.tok.cls === 'string' || t.tok.cls === 'literal');
}
