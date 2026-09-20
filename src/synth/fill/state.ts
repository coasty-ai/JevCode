/**
 * Slot-fill state for the Q13 prefix-mode Choice (docs/JEV-ONLY-DESIGN.md §2.7 Q13, §6
 * `fill/state.ts`; measured in experiments/results/lit-guided-synthesis.md §5.1, script
 * experiments/lit-synthesis/slot-probe.mts): the per-class option sets code proposes for a hole,
 * the partial-line rendering (`return kth(<HOLE>, ? - ?)`), the measured question wording, and
 * the compile gate that drops a partial the tokenizer would not accept.
 *
 * Measured (156 slots, 100 % option coverage): identifiers 29 options on average, top-1 89–91 %;
 * attributes 24, 100 %; the 24 operators, 89–97 %; numbers 12.5, 100 %. Keys are the measured
 * `name_<id>`, `attr_<name>`, `op_plus`, `num_2` / `num_neg1` (REPORT §10: semantic snake_case,
 * never a positional index); descriptions carry the token and its role.
 */
import type { Json } from '../../core/types.js';
import { looksSyntactic } from '../mutate/index.js';
import { lineToks } from '../mutate/tokens.js';
import { functionAt } from '../py/structure.js';
import { MARK, baseState } from '../beam/state.js';
import { detokenize, sanitise } from '../beam/tokens.js';
import type { Tok } from '../beam/tokens.js';
import { HOLE, OP_HOLE, isHoleText } from '../sketch/productions.js';
import type { EnumerateOptions, FailureView, Site } from '../types.js';

// ---------------------------------------------------------------------------------------
// Measured caps and option tables
// ---------------------------------------------------------------------------------------

/** Identifier options per Choice (lit-guided-synthesis §3.1 D4: "identifiers ≤ 60"; measured mean 29). */
export const MAX_IDENTIFIER_OPTIONS = 60;
/** Attribute options after a `.` (§3.1: "attributes ≤ 40"; measured 24). */
export const MAX_ATTRIBUTE_OPTIONS = 40;
/** Literal options: numbers and short strings from tests and file (§3.1: "numbers ≤ 30"; measured mean 12.5). */
export const MAX_LITERAL_OPTIONS = 30;
/** Test integers beyond this magnitude are not offered (slot-probe.mts: `Math.abs(v) <= 100`). */
export const MAX_TEST_INTEGER = 100;
/** String literals longer than this never make a useful slot value (beam/vocab.ts MAX_STRING_LITERAL_CHARS). */
export const MAX_STRING_LITERAL_CHARS = 20;
/** Numbers always offered first (slot-probe.mts seeds; every QuixBugs number slot was covered with them). */
export const SEED_NUMBERS: readonly string[] = ['0', '1', '2', '3', '10'];

/** The measured 24 operators with their measured keys (slot-probe.mts OPERATORS), in that order. */
export const SLOT_OPERATORS: readonly (readonly [key: string, text: string])[] = [
  ['op_plus', '+'], ['op_minus', '-'], ['op_times', '*'], ['op_divide', '/'], ['op_floordiv', '//'], ['op_mod', '%'], ['op_power', '**'],
  ['op_eq', '=='], ['op_ne', '!='], ['op_lt', '<'], ['op_le', '<='], ['op_gt', '>'], ['op_ge', '>='],
  ['op_and', 'and'], ['op_or', 'or'], ['op_not', 'not'], ['op_in', 'in'], ['op_is', 'is'],
  ['op_bitand', '&'], ['op_bitor', '|'], ['op_xor', '^'], ['op_shl', '<<'], ['op_shr', '>>'], ['op_invert', '~'],
];
/**
 * Assignment operators, offered only when the `<op>` hole sits where a statement's assignment
 * operator can be (bitcount's `n <op> n - 1` needs `&=`; the measured 24 have no augmented
 * assignments because the probe's tokenizer classed them as punctuation, lit-guided §5.1).
 */
export const ASSIGNMENT_OPERATORS: readonly (readonly [key: string, text: string])[] = [
  ['op_assign', '='], ['op_plus_assign', '+='], ['op_minus_assign', '-='], ['op_times_assign', '*='], ['op_divide_assign', '/='],
  ['op_floordiv_assign', '//='], ['op_mod_assign', '%='], ['op_power_assign', '**='], ['op_bitand_assign', '&='], ['op_bitor_assign', '|='], ['op_xor_assign', '^='],
];
/** Builtins offered as identifiers even when the function does not use them (slot-probe.mts BUILTINS). */
export const SLOT_BUILTINS: readonly string[] = ['len', 'range', 'enumerate', 'min', 'max', 'abs', 'sum', 'sorted', 'reversed', 'list', 'set', 'dict', 'tuple', 'str', 'int', 'float', 'all', 'any', 'zip', 'isinstance'];
/** The three constants are identifier slots to the probe (`while True:` → `while queue:` was one of the measured slots). */
export const SLOT_CONSTANTS: readonly string[] = ['None', 'True', 'False'];
/** Method names common enough to offer after a `.` even when unseen (slot-probe.mts COMMON_ATTRS). */
export const COMMON_ATTRIBUTES: readonly string[] = ['append', 'pop', 'extend', 'insert', 'remove', 'keys', 'values', 'items', 'get', 'add', 'join', 'split', 'strip', 'lower', 'upper', 'popleft', 'appendleft', 'sort', 'index', 'count', 'isdigit', 'isalpha', 'startswith', 'endswith'];

const KEYWORD_OPERATORS: ReadonlySet<string> = new Set(['and', 'or', 'not', 'in', 'is']);
const IDENT_RE = /^[A-Za-z_]\w*$/;

// ---------------------------------------------------------------------------------------
// Option sets
// ---------------------------------------------------------------------------------------

export interface SlotOption {
  key: string;
  tok: Tok;
  /** the measured description style: the token in backticks plus its role */
  description: Json;
}

/** The per-site option pools a hole draws from by class. */
export interface SlotVocabulary {
  identifiers: SlotOption[];
  attributes: SlotOption[];
  operators: SlotOption[];
  assignments: SlotOption[];
  literals: SlotOption[];
}

/**
 * Hole classes by position: `<op>` is an operator (an assignment operator too at statement
 * level), `_` after `.` an attribute, `_` right before `(` a callable name, any other `_` a value
 * (identifier or literal). Code decides the class from the grammar; Jev only picks the token.
 */
export type SlotClass = 'value' | 'callable' | 'attribute' | 'operator' | 'assignment_operator';

class Options {
  readonly list: SlotOption[] = [];
  private readonly keys = new Set<string>();
  private readonly texts = new Set<string>();
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  /** Add one option under `keyBase` (collisions get `_2`, `_3`…); the same token text is never offered twice. */
  add(keyBase: string, tok: Tok, role: string | null): boolean {
    if (this.list.length >= this.max || this.texts.has(tok.text)) return false;
    const base = keyBase.slice(0, 60);
    let key = base;
    let n = 2;
    while (this.keys.has(key)) key = `${base.slice(0, 56)}_${n++}`;
    this.keys.add(key);
    this.texts.add(tok.text);
    this.list.push({ key, tok, description: role === null ? `\`${tok.text}\`` : `\`${tok.text}\` (${role})` });
    return true;
  }
}

function isIdentifier(s: string): boolean {
  return IDENT_RE.test(s) && !KEYWORD_OPERATORS.has(s) && !SLOT_CONSTANTS.includes(s);
}

/** `num_2`, `num_neg1`, `num_0_5`: a sanitised number key with the sign spelled out. */
function numberKey(text: string): string {
  return text.startsWith('-') ? `neg${sanitise(text.slice(1))}` : sanitise(text);
}

/** `str_abc`, `str_empty`: the string body without quotes and prefix. */
function stringKey(text: string): string {
  const body = text.replace(/^[a-zA-Z]*['"]/, '').replace(/['"]$/, '');
  return body.length === 0 ? 'empty' : sanitise(body);
}

/** Integers in a failing test's text (JSON or repr), bounded so a hash or id never becomes an option. */
export function testIntegers(literals: readonly string[]): string[] {
  const out: string[] = [];
  for (const lit of literals) {
    for (const m of lit.matchAll(/(?<![\w.])-?\d+(?![\w.])/g)) {
      const v = Number(m[0]);
      if (Number.isInteger(v) && Math.abs(v) <= MAX_TEST_INTEGER && !out.includes(String(v))) out.push(String(v));
    }
  }
  return out;
}

/** Short quoted strings in a failing test's text. */
export function testStrings(literals: readonly string[]): string[] {
  const out: string[] = [];
  for (const lit of literals) {
    for (const m of lit.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)) {
      const body = m[1] ?? m[2] ?? '';
      const text = `'${body}'`;
      if (body.length <= MAX_STRING_LITERAL_CHARS && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

/**
 * Build the option pools for a site. Identifier order (matters only for the cap): parameters,
 * locals, the method's self, class attributes, imports, module names, other names the enclosing
 * function uses, task/test identifiers, builtins, then the three constants; roles name the
 * source so the description reads `\`b\` (parameter of gcd)` as measured.
 */
export function buildSlotVocabulary(site: Site, opts: EnumerateOptions): SlotVocabulary {
  const mod = site.file.mod;
  const fn = functionAt(mod, site.line);
  const fnName = site.block?.name ?? fn?.name ?? null;

  const identifiers = new Options(MAX_IDENTIFIER_OPTIONS);
  const name = (s: string, role: string): void => {
    if (isIdentifier(s)) identifiers.add(`name_${sanitise(s)}`, { text: s, cls: 'identifier' }, role);
  };
  for (const id of site.scope.params) name(id, fnName === null ? 'parameter' : `parameter of ${fnName}`);
  for (const id of site.scope.locals) name(id, 'local variable');
  if (site.scope.selfName !== null) name(site.scope.selfName, 'parameter');
  for (const id of site.scope.classAttrs) name(id, 'class attribute');
  for (const id of site.scope.imports) name(id, 'imported name');
  for (const id of site.scope.module) name(id, 'module-level name');
  for (const id of fn?.identifiers ?? []) name(id, fnName === null ? 'name used in program' : `name used in ${fnName}`);
  for (const id of opts.taskIdentifiers) name(id, 'identifier named by the task or test');
  for (const id of SLOT_BUILTINS) name(id, 'Python builtin');
  for (const c of SLOT_CONSTANTS) identifiers.add(`name_${sanitise(c)}`, { text: c, cls: 'literal' }, 'Python constant');

  const attributes = new Options(MAX_ATTRIBUTE_OPTIONS);
  const attr = (s: string, role: string): void => {
    if (IDENT_RE.test(s)) attributes.add(`attr_${sanitise(s)}`, { text: s, cls: 'identifier' }, role);
  };
  for (const a of fn?.attributes ?? []) attr(a.attr, `attribute used on \`${a.receiver}\` in program`);
  for (const other of mod.functions) if (other !== fn) for (const a of other.attributes) attr(a.attr, 'attribute used in program');
  for (const a of COMMON_ATTRIBUTES) attr(a, 'common method name');

  const operators: SlotOption[] = SLOT_OPERATORS.map(([key, text]) => ({ key, tok: { text, cls: KEYWORD_OPERATORS.has(text) ? 'keyword' : 'operator' }, description: `\`${text}\`` }));
  const assignments: SlotOption[] = ASSIGNMENT_OPERATORS.map(([key, text]) => ({ key, tok: { text, cls: 'operator' }, description: `\`${text}\`` }));

  const literals = new Options(MAX_LITERAL_OPTIONS);
  const num = (s: string): void => {
    literals.add(`num_${numberKey(s)}`, { text: s, cls: 'number' }, null);
  };
  for (const n of SEED_NUMBERS) num(n);
  for (const n of fn?.literals.numbers ?? []) num(n);
  for (const n of testIntegers(opts.testLiterals)) num(n);
  for (const other of mod.functions) if (other !== fn) for (const n of other.literals.numbers) num(n);
  const str = (s: string): void => {
    if (s.length - 2 <= MAX_STRING_LITERAL_CHARS) literals.add(`str_${stringKey(s)}`, { text: s, cls: 'string' }, null);
  };
  for (const s of fn?.literals.strings ?? []) str(s);
  for (const s of testStrings(opts.testLiterals)) str(s);
  for (const other of mod.functions) if (other !== fn) for (const s of other.literals.strings) str(s);

  return { identifiers: identifiers.list, attributes: attributes.list, operators, assignments, literals: literals.list };
}

function depthBefore(ts: readonly Tok[], upto: number): number {
  let d = 0;
  for (let k = 0; k < upto; k++) {
    const t = ts[k]!.text;
    if (t === '(' || t === '[' || t === '{') d++;
    else if (t === ')' || t === ']' || t === '}') d--;
  }
  return d;
}

/**
 * Class of the hole at `index` of `line`. An `<op>` at depth 0 of a plain statement (no header
 * keyword, no other depth-0 `=`) may be the statement's assignment operator.
 */
export function slotClassAt(line: readonly Tok[], index: number): SlotClass {
  const t = line[index];
  if (t === undefined || !isHoleText(t.text)) throw new RangeError(`slotClassAt: token ${index} is not a hole`);
  const prev = line[index - 1];
  const next = line[index + 1];
  if (t.text === OP_HOLE) {
    const first = line[0];
    const statementLevel = first !== undefined && first.cls !== 'keyword' && depthBefore(line, index) === 0;
    const hasAssign = line.some((x, i) => i !== index && x.cls === 'operator' && x.text.endsWith('=') && !['==', '!=', '<=', '>='].includes(x.text) && depthBefore(line, i) === 0);
    return statementLevel && !hasAssign ? 'assignment_operator' : 'operator';
  }
  if (prev?.text === '.') return 'attribute';
  if (next?.text === '(') return 'callable';
  return 'value';
}

/** Options for a hole of `cls` (the measured per-class sets; a value hole offers identifiers and literals together). */
export function slotOptionsFor(cls: SlotClass, vocab: SlotVocabulary): SlotOption[] {
  switch (cls) {
    case 'operator':
      return vocab.operators;
    case 'assignment_operator':
      return [...vocab.operators, ...vocab.assignments];
    case 'attribute':
      return vocab.attributes;
    case 'callable':
      return vocab.identifiers.filter((o) => o.tok.cls === 'identifier');
    case 'value':
      return [...vocab.identifiers, ...vocab.literals];
  }
}

// ---------------------------------------------------------------------------------------
// Partial lines and the measured question
// ---------------------------------------------------------------------------------------

export const HOLE_MARK = '<HOLE>';
export const LATER_MARK = '?';
export const HYPOTHESES_KEY = 'hypotheses';
/** Measured hypothesis keys (`hypotheses.first`, `.second`, `.third`); K × B ≤ 15 items per request. */
export const HYPOTHESIS_KEYS: readonly string[] = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth'];

export function hypothesisKeyAt(i: number): string {
  return HYPOTHESIS_KEYS[i] ?? `item_${i + 1}`;
}

/**
 * Render a line whose hole at `holeIndex` is `<HOLE>` and whose later holes are `?`; tokens
 * before the hole are concrete. Holes are identifiers to the detokenizer so `f(<HOLE>, ? - ?)`
 * spaces like code.
 */
export function partialLine(line: readonly Tok[], holeIndex: number): string {
  return detokenize(line.map((t, i) => (i === holeIndex ? { text: HOLE_MARK, cls: 'identifier' } : isHoleText(t.text) ? { text: LATER_MARK, cls: 'identifier' } : t)));
}

/**
 * Measured Q13 wording (lit-guided-synthesis §5.1 `prefix_h` / `fill_first`), verbatim for
 * replace sites. At an insert site there is no `buggy_line` (the state holds null), so the first
 * clause names the marker instead; the rest is unchanged. That variant is unmeasured (§9 R1).
 */
export function slotQuestion(hypothesisKey: string, siteKind: Site['kind']): string {
  const path = `\`${HYPOTHESES_KEY}.${hypothesisKey}\``;
  const subject = siteKind === 'insert' ? `${path} is a partially written new line for the \`${MARK}\` marker in \`program\`.` : `${path} is a partially written replacement for \`buggy_line\` in \`program\`.`;
  return `${subject} Tokens before \`${HOLE_MARK}\` are fixed; each \`${LATER_MARK}\` is a token still to be filled in later. Which option is the correct token for \`${HOLE_MARK}\`, so that the finished line makes every entry of \`tests\` pass? Pick \`none_of_these\` if no option fits.`;
}

/** `task`, `file`, `program`, `buggy_line`, `tests` (+ `goal`): the shared state every slot request carries. */
export function fillBaseState(site: Site, task: string, failures: readonly FailureView[]): Record<string, Json> {
  return baseState(site, task, failures);
}

// ---------------------------------------------------------------------------------------
// Compile gate
// ---------------------------------------------------------------------------------------

/** Placeholder tokens a partial is checked with (a name for `_`, `+` for `<op>`: the most permissive members of each class). */
const DUMMY_NAME: Tok = { text: 'hole_', cls: 'identifier' };
const DUMMY_OP: Tok = { text: '+', cls: 'operator' };

function withDummies(line: readonly Tok[]): Tok[] {
  return line.map((t) => (t.text === HOLE ? DUMMY_NAME : t.text === OP_HOLE ? DUMMY_OP : t));
}

/** A value-ending token (name, literal, closing bracket). */
function endsValue(t: Tok | undefined): boolean {
  return t !== undefined && (t.cls === 'identifier' || t.cls === 'number' || t.cls === 'string' || t.cls === 'literal' || t.text === ')' || t.text === ']' || t.text === '}');
}

/**
 * Tokenizer-level gate on a partial or complete line (PICARD-style "parsing without guards",
 * lit-guided §3.5): holes stand in as a name / `+`, the line must keep the bracket signature of
 * the line it replaces (balanced for an inserted line), operands and operators may not touch
 * (mutate's `looksSyntactic`), and a keyword operator in binary position must be one Python
 * has there (`x not y` is never a line; `not` is offered because the slot set is the measured 24).
 */
export function compileGate(line: readonly Tok[], site: Site, isSiteLine: boolean): boolean {
  const filled = withDummies(line);
  for (let i = 1; i < filled.length; i++) {
    const t = filled[i]!;
    if (t.cls !== 'keyword' || !KEYWORD_OPERATORS.has(t.text)) continue;
    const prev = filled[i - 1]!;
    if (t.text === 'not' && endsValue(prev) && filled[i + 1]?.text !== 'in') return false;
    if ((t.text === 'and' || t.text === 'or' || t.text === 'in' || t.text === 'is') && !endsValue(prev) && prev.text !== 'not') return false;
  }
  const text = detokenize(filled);
  const base = isSiteLine && site.kind === 'replace' ? lineToks(site.currentLine) : [];
  return looksSyntactic(lineToks(text), base);
}
