/**
 * Token classes, semantic option keys and the detokenizer shared by the beam, template and
 * permutation routes. Built on the CPython-faithful tokenizer in ../py (never a second parser):
 * a code token becomes a `Tok` with one of seven classes, and a `Tok[]` renders back to a
 * valid Python line with minimal spacing (equality is judged on token sequences, so spacing
 * is cosmetic; experiments/results/probe-token-synthesis.md §1).
 *
 * Option keys carry a name prior in Jev (REPORT §10), so every token gets a semantic snake_case
 * key with the token itself in the description: `name_counts`, `keyword_return`, `number_1`,
 * `string_empty`, `op_less_equal`, `punct_open_paren`, `literal_none`. Never a positional index.
 */
import type { Json } from '../../../core/types.js';
import { codeTokens, isKeyword, tokenizeFragment } from '../py/index.js';
import type { Token } from '../py/index.js';

export type TokClass = 'identifier' | 'keyword' | 'literal' | 'number' | 'string' | 'operator' | 'punct';

export interface Tok {
  readonly text: string;
  readonly cls: TokClass;
}

/** `True`, `False`, `None` are keywords to the tokenizer but values to the grammar. */
export const LITERAL_KEYWORDS: ReadonlySet<string> = new Set(['True', 'False', 'None']);
export const PUNCTUATION: ReadonlySet<string> = new Set(['(', ')', '[', ']', '{', '}', ',', ':', '.', ';']);
export const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
export const CLOSERS: ReadonlySet<string> = new Set([')', ']', '}']);

/** Semantic key and plain-English meaning per operator and punctuation mark (measured shape). */
export const OP_NAMES: Readonly<Record<string, readonly [key: string, meaning: string]>> = {
  '**=': ['op_power_assign', 'power and assign'],
  '//=': ['op_floordiv_assign', 'floor-divide and assign'],
  '>>=': ['op_rshift_assign', 'right-shift and assign'],
  '<<=': ['op_lshift_assign', 'left-shift and assign'],
  '->': ['op_arrow', 'return annotation arrow'],
  ':=': ['op_walrus', 'assignment expression'],
  '**': ['op_power', 'exponentiation'],
  '//': ['op_floordiv', 'floor division'],
  '==': ['op_equal', 'equality comparison'],
  '!=': ['op_not_equal', 'inequality comparison'],
  '<=': ['op_less_equal', 'less than or equal'],
  '>=': ['op_greater_equal', 'greater than or equal'],
  '+=': ['op_plus_assign', 'add and assign'],
  '-=': ['op_minus_assign', 'subtract and assign'],
  '*=': ['op_times_assign', 'multiply and assign'],
  '/=': ['op_divide_assign', 'divide and assign'],
  '%=': ['op_modulo_assign', 'modulo and assign'],
  '&=': ['op_bitand_assign', 'bitwise-and and assign'],
  '|=': ['op_bitor_assign', 'bitwise-or and assign'],
  '^=': ['op_bitxor_assign', 'bitwise-xor and assign'],
  '<<': ['op_lshift', 'left shift'],
  '>>': ['op_rshift', 'right shift'],
  '+': ['op_plus', 'addition or concatenation'],
  '-': ['op_minus', 'subtraction or negation'],
  '*': ['op_star', 'multiplication or unpacking'],
  '/': ['op_divide', 'true division'],
  '%': ['op_modulo', 'modulo'],
  '<': ['op_less', 'less than'],
  '>': ['op_greater', 'greater than'],
  '=': ['op_assign', 'assignment'],
  '&': ['op_bitand', 'bitwise and'],
  '|': ['op_bitor', 'bitwise or'],
  '^': ['op_bitxor', 'bitwise xor'],
  '~': ['op_invert', 'bitwise not'],
  '@': ['op_matmul', 'matrix multiply'],
  '(': ['punct_open_paren', 'open parenthesis'],
  ')': ['punct_close_paren', 'close parenthesis'],
  '[': ['punct_open_bracket', 'open square bracket'],
  ']': ['punct_close_bracket', 'close square bracket'],
  '{': ['punct_open_brace', 'open curly brace'],
  '}': ['punct_close_brace', 'close curly brace'],
  ',': ['punct_comma', 'comma'],
  ':': ['punct_colon', 'colon'],
  '.': ['punct_dot', 'attribute access dot'],
  ';': ['punct_semicolon', 'semicolon'],
};

/** Operators (not punctuation) the vocabulary offers, in a stable order. */
export const OPERATOR_TEXTS: readonly string[] = Object.keys(OP_NAMES).filter((o) => !PUNCTUATION.has(o));
export const PUNCT_TEXTS: readonly string[] = Object.keys(OP_NAMES).filter((o) => PUNCTUATION.has(o));

/** Class of a code token from the shared tokenizer; ERRORTOKENs carry no code and map to null. */
export function classify(t: Token): Tok | null {
  switch (t.type) {
    case 'NAME':
      if (LITERAL_KEYWORDS.has(t.text)) return { text: t.text, cls: 'literal' };
      return { text: t.text, cls: isKeyword(t.text) ? 'keyword' : 'identifier' };
    case 'NUMBER':
      return { text: t.text, cls: 'number' };
    case 'STRING':
      return { text: t.text, cls: 'string' };
    case 'OP':
      return { text: t.text, cls: PUNCTUATION.has(t.text) ? 'punct' : 'operator' };
    default:
      return null;
  }
}

/** Classified code tokens of a line or fragment (lenient; comments and ERRORTOKENs dropped). */
export function toks(line: string): Tok[] {
  const out: Tok[] = [];
  for (const t of codeTokens(tokenizeFragment(line))) {
    const c = classify(t);
    if (c !== null) out.push(c);
  }
  return out;
}

export function sameTokens(a: readonly Tok[], b: readonly Tok[]): boolean {
  return a.length === b.length && a.every((t, i) => t.text === b[i]!.text);
}

export function tokenKeyText(a: readonly Tok[]): string {
  return a.map((t) => t.text).join('\u0000');
}

/** A token that can end an operand: names, literals, closing brackets. */
export function isValueTok(t: Tok | undefined): boolean {
  if (t === undefined) return false;
  return t.cls === 'identifier' || t.cls === 'number' || t.cls === 'string' || t.cls === 'literal' || CLOSERS.has(t.text);
}

/**
 * Join tokens into a valid Python line. No space before `) ] , : . ;`, none after `( [ { .`,
 * none between a callee/subscripted value and its `(`/`[`, none after a unary `-`/`~`.
 */
export function detokenize(tokens: readonly Tok[]): string {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (i === 0) {
      out += t.text;
      continue;
    }
    const p = tokens[i - 1]!;
    const pp = tokens[i - 2];
    const callLike = (t.text === '(' || t.text === '[') && (p.cls === 'identifier' || p.cls === 'string' || p.text === ')' || p.text === ']');
    // `-` / `~` is unary when nothing that can end an operand precedes it
    const unaryPrev = (p.text === '-' || p.text === '~') && !isValueTok(pp);
    const noSpace =
      t.text === ')' || t.text === ']' || t.text === ',' || t.text === ':' || t.text === '.' || t.text === ';' || p.text === '(' || p.text === '[' || p.text === '{' || p.text === '.' || callLike || unaryPrev;
    out += (noSpace ? '' : ' ') + t.text;
  }
  return out;
}

/** Lower-case snake_case fragment for an option key (ascii letters and digits only). */
export function sanitise(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : 'x';
}

/** Semantic option key (without collision suffix) and description for a token. */
export function keyAndDescription(t: Tok, kind?: string): { key: string; description: Json } {
  switch (t.cls) {
    case 'identifier':
      return { key: `name_${sanitise(t.text)}`, description: { kind: kind ?? 'identifier', token: t.text } };
    case 'keyword':
      return { key: `keyword_${sanitise(t.text)}`, description: { kind: 'keyword', token: t.text } };
    case 'literal':
      return { key: `literal_${sanitise(t.text)}`, description: { kind: 'literal', token: t.text } };
    case 'number':
      return { key: `number_${sanitise(t.text)}`, description: { kind: 'number', token: t.text } };
    case 'string': {
      const body = t.text.replace(/^[a-zA-Z]*['"]/, '').replace(/['"]$/, '');
      const name = body.length === 0 ? 'empty' : sanitise(body);
      return { key: `string_${name}`, description: { kind: 'string', token: t.text } };
    }
    case 'operator':
    case 'punct': {
      const named = OP_NAMES[t.text];
      const isPunct = t.cls === 'punct';
      if (named !== undefined) return { key: named[0], description: { kind: isPunct ? 'punctuation' : 'operator', token: t.text, meaning: named[1] } };
      return { key: `${isPunct ? 'punct' : 'op'}_${sanitise(t.text)}`, description: { kind: isPunct ? 'punctuation' : 'operator', token: t.text } };
    }
  }
}
