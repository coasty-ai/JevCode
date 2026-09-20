/**
 * Shared machinery for the fix-template candidate source: the per-site context (scope pools,
 * the statement being edited, the tokens of the current line), expression slicing on one
 * line, the insertion forms (insert site vs. prepend/append at a replace site), the syntactic
 * filter and deterministic ids. Every template family builds on this and nothing here knows
 * about a particular template.
 */
import { createHash } from 'node:crypto';
import type { Candidate, EnumerateOptions, LineEdit, Site } from '../types.js';
import { indentOf, reindent } from '../py/edits.js';
import { blockAt, functionAt } from '../py/structure.js';
import type { Block, FunctionFacts, PyModule, Statement } from '../py/structure.js';
import { PY_BUILTINS } from '../py/structure.js';
import { isKeyword, tokenizeFragment } from '../py/tokenize.js';
import type { Token } from '../py/tokenize.js';

// ---------------------------------------------------------------------------------------
// Template families and their priors (ordering only; Jev ranks, tests decide)
// ---------------------------------------------------------------------------------------

/**
 * Family priors follow the literature ranking in experiments/results/lit-search-based-repair.md
 * §8: condition extension is the dominant real-world pattern (Defects4J "Conditional Block"
 * 42.8 %), None/empty guards are "Missing Null-Check" 12.7 %, identifier/attribute substitution
 * is the largest SStuB bucket (12.8 %), missing-statement insertion is ~30 % of Defects4J
 * patches, call-argument changes ~3 %, max/min wraps are niche, branch copies rare.
 */
export const FAMILY_PRIOR = {
  condition: 0.9,
  guard: 0.85,
  attribute: 0.8,
  statement: 0.75,
  signature: 0.7,
  import: 0.7,
  wrap: 0.55,
  branch: 0.3,
} as const;

export type TemplateFamily = keyof typeof FAMILY_PRIOR;

export const TEMPLATE_FAMILIES: readonly TemplateFamily[] = ['guard', 'statement', 'wrap', 'condition', 'signature', 'attribute', 'import', 'branch'];

// ---------------------------------------------------------------------------------------
// Site context
// ---------------------------------------------------------------------------------------

/** Names grouped by the role the code gives them; all derived from tokens, never from types. */
export interface NamePools {
  /** parameters of the enclosing functions */
  params: string[];
  /** params + locals of the enclosing functions, without builtins/module names */
  visible: string[];
  /** receivers of `.append` / `.extend` / `.insert` / `.pop` (when not a set or dict) or bound to `[]` / `list(...)` */
  lists: string[];
  /** receivers of `.add` / `.discard` or bound to `set()` */
  sets: string[];
  /** names bound to `{}` / `dict(...)` or receivers of `.items` / `.keys` / `.values` / `.get` */
  dicts: string[];
  /** lists ∪ sets ∪ dicts ∪ subscripted ∪ `len(x)` arguments ∪ iterated ∪ params */
  collections: string[];
  /** names bound to a number or targets of `+=` / `-=` */
  counters: string[];
  /** names used as a direct subscript `x[i]`, loop variables of `range(...)`, or bound to `0` */
  indices: string[];
  /** names that appear as `name.attr` receivers */
  receivers: string[];
  /** every `receiver -> attrs` pair seen in the whole file (accesses and assignments) */
  attrsByReceiver: Map<string, string[]>;
  /** class name -> names its body binds (fields, methods) */
  classFields: Map<string, string[]>;
  /** parameter/local name -> annotation text, when annotated on the enclosing def */
  annotations: Map<string, string>;
}

export interface TemplateContext {
  site: Site;
  opts: EnumerateOptions;
  mod: PyModule;
  /** facts of the innermost def containing the site, if any */
  fn: FunctionFacts | undefined;
  /** innermost def block containing the site, if any */
  block: Block | undefined;
  /** statement whose line range contains the site line (replace) / starts at the site line (insert) */
  stmt: Statement | undefined;
  /** the line a guard would protect: the current line, or for inserts the line inserted before */
  guardedLine: string;
  /** leading whitespace for generated lines at this site */
  lead: string;
  /** the indent unit of the file (4 spaces unless the file says otherwise) */
  unit: string;
  /** code tokens of `currentLine` (fragment-tokenized; offsets index into `body`) */
  lineTokens: Token[];
  /** `currentLine` without its leading whitespace */
  body: string;
  /** identifiers on the current/guarded line and its two neighbours, for the locality boost */
  nearby: Set<string>;
  names: NamePools;
  /** true when the site is inside a `for` / `while` body */
  inLoop: boolean;
  /** true when the site is inside a def body (not on its header, not at module level): `return` is legal */
  inFunction: boolean;
}

export const BUILTIN_SET: ReadonlySet<string> = new Set(PY_BUILTINS);

export function isOp(t: Token | undefined, text: string): boolean {
  return t !== undefined && t.type === 'OP' && t.text === text;
}

export function isName(t: Token | undefined): t is Token {
  return t !== undefined && t.type === 'NAME' && !isKeyword(t.text);
}

export function isKw(t: Token | undefined, text: string): boolean {
  return t !== undefined && t.type === 'NAME' && t.text === text;
}

function isOpen(t: Token): boolean {
  return t.type === 'OP' && (t.text === '(' || t.text === '[' || t.text === '{');
}
function isClose(t: Token): boolean {
  return t.type === 'OP' && (t.text === ')' || t.text === ']' || t.text === '}');
}

/** Code tokens of a one-line fragment (comments and line breaks dropped). */
export function fragmentTokens(text: string): Token[] {
  return tokenizeFragment(text).filter((t) => t.type === 'NAME' || t.type === 'NUMBER' || t.type === 'STRING' || t.type === 'OP');
}

/** Index of the matching close bracket for `open`, or -1 when unbalanced. */
export function matchClose(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (isOpen(t)) depth++;
    else if (isClose(t)) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** Index of the first depth-0 token satisfying `pred` in [from, to), or -1. */
export function findTopLevel(tokens: readonly Token[], pred: (t: Token, k: number) => boolean, from = 0, to = tokens.length): number {
  let depth = 0;
  for (let k = from; k < to; k++) {
    const t = tokens[k]!;
    if (isClose(t)) depth = Math.max(0, depth - 1);
    if (depth === 0 && pred(t, k)) return k;
    if (isOpen(t)) depth++;
  }
  return -1;
}

/** Split [from, to) at depth-0 occurrences of `sep`; returns index ranges [start, end). */
export function splitTopLevel(tokens: readonly Token[], sep: string, from = 0, to = tokens.length): [number, number][] {
  const out: [number, number][] = [];
  let start = from;
  let depth = 0;
  for (let k = from; k < to; k++) {
    const t = tokens[k]!;
    if (isOpen(t)) depth++;
    else if (isClose(t)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && isOp(t, sep)) {
      out.push([start, k]);
      start = k + 1;
    }
  }
  out.push([start, to]);
  return out;
}

export function uniq<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** The dotted name (`a.b.c`) ending at token `k`, with its start index, or null. */
export function dottedEndingAt(tokens: readonly Token[], k: number): { text: string; start: number } | null {
  if (!isName(tokens[k])) return null;
  let s = k;
  while (s >= 2 && isOp(tokens[s - 1], '.') && isName(tokens[s - 2])) s -= 2;
  return { text: tokens.slice(s, k + 1).map((t) => t.text).join(''), start: s };
}

/** Plain identifiers used on a line (attribute names and keyword-argument names excluded). */
export function identifiersIn(tokens: readonly Token[]): string[] {
  const out: string[] = [];
  tokens.forEach((t, k) => {
    if (!isName(t) || isOp(tokens[k - 1], '.')) return;
    out.push(t.text);
  });
  return uniq(out);
}

/** `recv.attr` occurrences (receiver a plain dotted name) with token positions. */
export function attrRefsIn(tokens: readonly Token[]): { receiver: string; attr: string; start: number; attrIndex: number; call: boolean }[] {
  const out: { receiver: string; attr: string; start: number; attrIndex: number; call: boolean }[] = [];
  for (let k = 1; k < tokens.length - 1; k++) {
    if (!isOp(tokens[k], '.') || !isName(tokens[k + 1])) continue;
    const recv = dottedEndingAt(tokens, k - 1);
    if (recv === null) continue;
    out.push({ receiver: recv.text, attr: tokens[k + 1]!.text, start: recv.start, attrIndex: k + 1, call: isOp(tokens[k + 2], '(') });
  }
  return out;
}

function statementsInSpan(mod: PyModule, start: number, end: number): Statement[] {
  return mod.statements.filter((s) => s.startLine >= start && s.startLine <= end);
}

function valueIs(tokens: readonly Token[], eq: number, ...shapes: string[]): boolean {
  const rest = tokens.slice(eq + 1).map((t) => t.text).join('');
  return shapes.some((s) => rest === s || rest.startsWith(`${s}(`));
}

/** True when the brace literal opening at `open` holds a `:` at depth 1 (a dict), false for a set literal. */
function braceLiteralIsDict(tokens: readonly Token[], open: number): boolean {
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (isOpen(t)) depth++;
    else if (isClose(t)) {
      depth--;
      if (depth === 0) return false;
    } else if (depth === 1 && isOp(t, ':')) return true;
  }
  return false;
}

function buildPools(mod: PyModule, site: Site, block: Block | undefined): NamePools {
  const scope = site.scope;
  const params = [...scope.params];
  const visible = uniq([...scope.params, ...scope.locals]).filter((n) => !BUILTIN_SET.has(n));
  // roles are read over the outermost enclosing def so a nested function sees `visited = set()` of its parent
  let outermost = block;
  while (outermost !== undefined && outermost.parent !== null && mod.blocks[outermost.parent]!.kind === 'def') outermost = mod.blocks[outermost.parent];
  const span = outermost !== undefined ? statementsInSpan(mod, outermost.bodyStart, outermost.bodyEnd) : mod.statements.filter((s) => s.blockIndex === null);
  const tokens = span.flatMap((s) => s.tokens);
  const lists: string[] = [];
  const sets: string[] = [];
  const dicts: string[] = [];
  const collections: string[] = [];
  const counters: string[] = [];
  const indices: string[] = [];
  const receivers: string[] = [];
  /** `x.pop(...)` receivers: lists unless the code also treats them as sets or dicts (shunting_yard's `opstack`) */
  const popReceivers: string[] = [];
  const attrsByReceiver = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, key: string, value: string): void => {
    const cur = m.get(key);
    if (cur === undefined) m.set(key, [value]);
    else if (!cur.includes(value)) cur.push(value);
  };
  // roles from how the enclosing function uses each name
  for (const s of span) {
    const t = s.tokens;
    if ((s.kind === 'assign' || s.kind === 'augassign') && isName(t[0])) {
      const eq = findTopLevel(t, (u) => u.type === 'OP' && (u.text === '=' || u.text.endsWith('=')) && u.text !== '==' && u.text !== '!=' && u.text !== '<=' && u.text !== '>=');
      if (eq === 1 || (eq === 3 && isOp(t[1], ':'))) {
        const name = t[0]!.text;
        if (s.kind === 'augassign') counters.push(name);
        else if (valueIs(t, eq, '[]', 'list') || isOp(t[eq + 1], '[')) lists.push(name);
        else if (valueIs(t, eq, 'set')) sets.push(name);
        else if (valueIs(t, eq, '{}', 'dict')) dicts.push(name);
        // a brace literal is a dict when a `:` sits at depth 1 (`{'+': 1, ...}`, shunting_yard's `precedence`), a set otherwise
        else if (isOp(t[eq + 1], '{')) (braceLiteralIsDict(t, eq + 1) ? dicts : sets).push(name);
        else if (t[eq + 1]?.type === 'NUMBER' && t.length === eq + 2) {
          counters.push(name);
          if (t[eq + 1]!.text === '0') indices.push(name);
        }
      }
    }
    if (s.kind === 'for') {
      const inIdx = findTopLevel(t, (u) => isKw(u, 'in'), 1);
      if (inIdx > 0) {
        const iter = t[inIdx + 1];
        if (isName(iter) && !isOp(t[inIdx + 2], '(') && !isOp(t[inIdx + 2], '.')) collections.push(iter.text);
        if (isKw(iter, 'range') || (isName(iter) && iter.text === 'range')) for (let k = 1; k < inIdx; k++) if (isName(t[k])) indices.push(t[k]!.text);
      }
    }
  }
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (isOp(t, '.') && isName(tokens[k + 1])) {
      const recv = dottedEndingAt(tokens, k - 1);
      if (recv === null) continue;
      const attr = tokens[k + 1]!.text;
      receivers.push(recv.text);
      if (attr === 'append' || attr === 'extend' || attr === 'insert') lists.push(recv.text);
      if (attr === 'add' || attr === 'discard') sets.push(recv.text);
      if (attr === 'items' || attr === 'keys' || attr === 'values' || attr === 'get') dicts.push(recv.text);
      if (attr === 'pop' || attr === 'update' || attr === 'remove') collections.push(recv.text);
      if (attr === 'pop') popReceivers.push(recv.text);
    }
    if (isOp(t, '[') && isName(tokens[k - 1]) && !isOp(tokens[k - 2], '.')) {
      collections.push(tokens[k - 1]!.text);
      const close = matchClose(tokens, k);
      if (close === k + 2 && isName(tokens[k + 1])) indices.push(tokens[k + 1]!.text);
    }
    if (isName(t) && t.text === 'len' && isOp(tokens[k + 1], '(') && isName(tokens[k + 2]) && isOp(tokens[k + 3], ')')) collections.push(tokens[k + 2]!.text);
  }
  // attribute table over the whole file (accesses and assignments in every function and at module level)
  for (const f of mod.functions) for (const a of f.attributes) if (a.receiver !== '<expr>') push(attrsByReceiver, a.receiver, a.attr);
  for (const s of mod.statements) for (const a of s.attrAssigns) push(attrsByReceiver, a.receiver, a.attr);
  for (let k = 1; k < mod.tokens.length - 1; k++) {
    // module-level accesses are not in any function's facts
    const t = mod.tokens[k]!;
    if (!isOp(t, '.') || !isName(mod.tokens[k + 1])) continue;
    const recv = dottedEndingAt(mod.tokens, k - 1);
    if (recv !== null) push(attrsByReceiver, recv.text, mod.tokens[k + 1]!.text);
  }
  const classFields = new Map<string, string[]>();
  for (const b of mod.blocks) {
    if (b.kind !== 'class') continue;
    const fields: string[] = [];
    // fields only (annotations, class-level assignments, self.x writes); methods are not attribute alternatives
    for (const s of mod.statements) if (s.blockIndex === b.index && s.kind !== 'def' && s.kind !== 'class') fields.push(...s.binds.filter((n) => n !== '*'));
    for (const m of mod.blocks) {
      if (m.parent !== b.index || m.kind !== 'def') continue;
      const self = m.params[0]?.name;
      if (self === undefined) continue;
      for (const s of mod.statements) if (s.blockIndex === m.index) for (const a of s.attrAssigns) if (a.receiver === self) fields.push(a.attr);
    }
    classFields.set(b.name, uniq(fields));
  }
  const annotations = new Map<string, string>();
  if (block !== undefined) for (const p of block.params) if (p.annotation !== null) annotations.set(p.name, p.annotation);
  const inScope = (n: string): boolean => visible.includes(n) || scope.module.includes(n);
  for (const r of popReceivers) if (!sets.includes(r) && !dicts.includes(r)) lists.push(r);
  return {
    params,
    visible,
    lists: uniq(lists).filter(inScope),
    sets: uniq(sets).filter(inScope),
    dicts: uniq(dicts).filter(inScope),
    collections: uniq([...lists, ...sets, ...dicts, ...collections, ...params]).filter(inScope),
    counters: uniq(counters).filter(inScope),
    indices: uniq(indices).filter(inScope),
    receivers: uniq(receivers).filter((r) => !r.includes('.') && inScope(r)),
    attrsByReceiver,
    classFields,
    annotations,
  };
}

/**
 * Whether `line` sits inside the body of a `for` / `while` statement of the innermost def/class
 * block (`inner`, null at module level). Loops of an outer function do not count: `break` and
 * `continue` inside a nested def are SyntaxErrors even when the def itself sits in a loop.
 */
function insideLoop(mod: PyModule, line: number, indent: number, inner: number | null): boolean {
  for (const s of mod.statements) {
    if ((s.kind !== 'for' && s.kind !== 'while') || s.blockIndex !== inner || s.startLine >= line || s.indent >= indent) continue;
    // the loop encloses `line` when no statement at or below its indent intervenes
    const closer = mod.statements.find((u) => u.startLine > s.endLine && u.startLine < line && u.indent <= s.indent);
    if (closer === undefined) return true;
  }
  return false;
}

/** Indent unit of the file: the smallest positive difference between a block header and its body. */
function indentUnit(mod: PyModule): string {
  let best = Infinity;
  for (const b of mod.blocks) {
    const d = b.bodyIndent - b.indent;
    if (d > 0 && d < best) best = d;
  }
  if (!Number.isFinite(best)) best = 4;
  const usesTabs = mod.lines.some((l) => l.startsWith('\t'));
  return usesTabs && best === 8 ? '\t' : ' '.repeat(best);
}

export function buildContext(site: Site, opts: EnumerateOptions): TemplateContext {
  const mod = site.file.mod;
  const outer = blockAt(mod, site.line);
  let block: Block | undefined = outer;
  while (block !== undefined && block.kind !== 'def') block = block.parent === null ? undefined : mod.blocks[block.parent];
  const fn = functionAt(mod, site.line);
  const stmt = site.kind === 'replace' ? mod.statements.find((s) => s.startLine <= site.line && site.line <= s.endLine) : mod.statements.find((s) => s.startLine === site.line);
  const guardedLine = site.kind === 'replace' ? site.currentLine : (mod.lines[site.line - 1] ?? '');
  const lead = site.kind === 'replace' ? indentOf(site.currentLine) || site.indent : site.indent;
  const body = site.kind === 'replace' ? site.currentLine.slice(indentOf(site.currentLine).length) : '';
  const lineTokens = body === '' ? [] : fragmentTokens(body);
  const nearby = new Set<string>();
  for (let l = site.line - 2; l <= site.line + 2; l++) {
    const text = mod.lines[l - 1];
    if (text !== undefined) for (const n of identifiersIn(fragmentTokens(text))) nearby.add(n);
  }
  for (const n of identifiersIn(fragmentTokens(guardedLine))) nearby.add(n);
  return {
    site,
    opts,
    mod,
    fn,
    block,
    stmt,
    guardedLine,
    lead,
    unit: indentUnit(mod),
    lineTokens,
    body,
    nearby,
    names: buildPools(mod, site, block),
    inLoop: insideLoop(mod, site.line, lead.length, outer?.index ?? null),
    inFunction: block !== undefined && site.line > block.headerEndLine,
  };
}

/** Names bound by the current line itself (assignment targets, loop variables): not guard subjects. */
export function boundOnLine(ctx: TemplateContext): Set<string> {
  const st = ctx.stmt;
  return new Set(st !== undefined && ctx.site.kind === 'replace' ? st.binds : []);
}

/** Locality boost: names on or around the site are the likely slot values (probe-token-synthesis §4). */
export function localityFactor(ctx: TemplateContext, ...names: string[]): number {
  return names.every((n) => ctx.nearby.has(n.split('.')[0]!)) ? 1 : 0.7;
}

// ---------------------------------------------------------------------------------------
// Emitting candidates
// ---------------------------------------------------------------------------------------

export interface Draft {
  text: string;
  op: string;
  prior: number;
  extraEdits?: readonly LineEdit[];
}

/** Bracket balance and string termination of every line of a candidate text. */
export function isBalanced(text: string): boolean {
  for (const line of text.split('\n')) {
    let depth = 0;
    for (const t of tokenizeFragment(line)) {
      if (t.type === 'ERRORTOKEN') return false;
      if (isOpen(t)) depth++;
      else if (isClose(t)) {
        depth--;
        if (depth < 0) return false;
      }
    }
    if (depth !== 0) return false;
  }
  return true;
}

/** Net bracket depth change, the lowest depth reached and whether a token failed to scan, over a whole text. */
function bracketProfile(text: string): { delta: number; min: number; error: boolean } {
  let depth = 0;
  let min = 0;
  let error = false;
  for (const t of tokenizeFragment(text)) {
    if (t.type === 'ERRORTOKEN') error = true;
    if (isOpen(t)) depth++;
    else if (isClose(t)) depth--;
    if (depth < min) min = depth;
  }
  return { delta: depth, min, error };
}

/**
 * Whether `replacement` can stand where `original` stood without changing how the enclosing
 * statement's brackets close: same net depth change and never a deeper dip. A line of a
 * multi-line call (`out.append(`) is unbalanced on its own, so `isBalanced` would reject every
 * edit to it (and to any continuation line) although `out.extend(` is exactly as well-formed.
 * For a balanced original this is `isBalanced` over the whole text.
 */
export function balancedAs(original: string, replacement: string): boolean {
  const o = bracketProfile(original);
  const r = bracketProfile(replacement);
  return !r.error && r.delta === o.delta && r.min >= o.min;
}

/** True when `line` continues a statement that started on an earlier line (a gap or a line one cannot edit in isolation). */
export function continuesStatement(mod: PyModule, line: number): boolean {
  return mod.statements.some((s) => s.startLine < line && line <= s.endLine);
}

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 10);
}

/** Deterministic id from the site and the exact edit, stable across caps and enumeration order. */
export function candidateId(site: Site, draft: Draft): string {
  const extra = (draft.extraEdits ?? []).map((e) => `${e.path}:${e.line}:${e.kind}:${e.text ?? ''}`).join('|');
  return `tpl_${draft.op}_${shortHash(`${site.file.path}:${site.line}:${site.kind}:${draft.text}:${extra}`)}`;
}

export function toCandidate(site: Site, draft: Draft): Candidate {
  const c: Candidate = { id: candidateId(site, draft), site, text: draft.text, source: 'template', op: draft.op, prior: Math.max(0, Math.min(1, draft.prior)) };
  if (draft.extraEdits !== undefined && draft.extraEdits.length > 0) c.extraEdits = draft.extraEdits;
  return c;
}

/** Indents (as strings) a statement appended after the current line may sit at when the next line dedents. */
function dedentLevels(ctx: TemplateContext, lead: string): string[] {
  const { mod, site } = ctx;
  let next: string | undefined;
  for (let l = site.line + 1; l <= mod.lines.length; l++) {
    const text = mod.lines[l - 1]!;
    if (text.trim() !== '' && !text.trim().startsWith('#')) {
      next = indentOf(text);
      break;
    }
  }
  if (next === undefined || next.length >= lead.length) return [];
  const levels = new Set<string>();
  for (const s of mod.statements) {
    if (s.startLine >= site.line) continue;
    const ind = indentOf(mod.lines[s.startLine - 1] ?? '');
    if (ind.length < lead.length && ind.length >= next.length) levels.add(ind);
  }
  // the two nearest enclosing blocks are where a trailing statement plausibly belongs
  return [...levels].sort((a, b) => b.length - a.length).slice(0, 2);
}

export interface StatementForms {
  /** append after the current line: always, only when the line is a `:` header (first statement of its body), or never */
  after: 'always' | 'header' | 'never';
  /** also append at the enclosing dedent levels when the next line dedents */
  dedent: boolean;
}

const DEFAULT_FORMS: StatementForms = { after: 'always', dedent: true };

/**
 * Turn a statement (one or more lines, relative indentation in `ctx.unit`) into candidates at
 * the site. Insert sites get the block itself; replace sites get it prepended to the current
 * line, appended after it (inside the body when the line is a `:` header), and appended at
 * the enclosing dedent levels when the following line dedents (a statement that belongs at the
 * end of the block the current line closes, as in QuixBugs `shunting_yard`).
 */
export function statementDrafts(ctx: TemplateContext, stmt: string, op: string, prior: number, forms: StatementForms = DEFAULT_FORMS): Draft[] {
  const { site, lead } = ctx;
  if (site.kind === 'insert') return [{ text: reindent(stmt, lead), op, prior }];
  // A statement can only go before the first physical line of the current statement and after
  // its last one; anything else lands inside a bracketed expression (a multi-line call).
  const startsHere = ctx.stmt === undefined || ctx.stmt.startLine === site.line;
  const endsHere = ctx.stmt === undefined || ctx.stmt.endLine === site.line;
  const current = currentLineText(ctx);
  const out: Draft[] = [];
  if (startsHere) out.push({ text: `${reindent(stmt, lead)}\n${current}`, op: `${op}_before`, prior });
  if (!endsHere) return out;
  // after the last line of a multi-line statement the next statement aligns with its first line
  const stmtLead = startsHere ? lead : indentOf(ctx.mod.lines[ctx.stmt!.startLine - 1] ?? '');
  const isHeader = ctx.body.endsWith(':') && !ctx.body.startsWith('#');
  if (forms.after === 'always' || (forms.after === 'header' && isHeader)) {
    const appendIndent = isHeader ? stmtLead + ctx.unit : stmtLead;
    out.push({ text: `${current}\n${reindent(stmt, appendIndent)}`, op: `${op}_after`, prior: prior * 0.9 });
  }
  if (forms.dedent && !isHeader) for (const level of dedentLevels(ctx, stmtLead)) out.push({ text: `${current}\n${reindent(stmt, level)}`, op: `${op}_after_dedent`, prior: prior * 0.75 });
  return out;
}

/** The current line as the candidate texts render it: the site's indentation plus the body (equals `currentLine` when that carries its own indentation). */
export function currentLineText(ctx: TemplateContext): string {
  return `${ctx.lead}${ctx.body}`;
}

/** Replacement of the current line's body (indentation kept). Returns [] for insert sites or no change. */
export function lineDraft(ctx: TemplateContext, newBody: string, op: string, prior: number, extraEdits?: readonly LineEdit[]): Draft[] {
  if (ctx.site.kind !== 'replace' || newBody === ctx.body) return [];
  const d: Draft = { text: `${ctx.lead}${newBody}`, op, prior };
  if (extraEdits !== undefined && extraEdits.length > 0) d.extraEdits = extraEdits;
  return [d];
}

/** Source text of a token range in the current line body. */
export function sliceBody(ctx: TemplateContext, from: number, to: number): string {
  const a = ctx.lineTokens[from];
  const b = ctx.lineTokens[to - 1];
  if (a === undefined || b === undefined || to <= from) return '';
  return ctx.body.slice(a.start, b.end);
}

/** Body with the token range [from, to) replaced by `text`. */
export function spliceBody(ctx: TemplateContext, from: number, to: number, text: string): string {
  const a = ctx.lineTokens[from];
  const b = ctx.lineTokens[to - 1];
  if (a === undefined || b === undefined) return ctx.body;
  return ctx.body.slice(0, a.start) + text + ctx.body.slice(b.end);
}

/** Body with a single token replaced. */
export function replaceToken(ctx: TemplateContext, k: number, text: string): string {
  return spliceBody(ctx, k, k + 1, text);
}

// ---------------------------------------------------------------------------------------
// Line shapes
// ---------------------------------------------------------------------------------------

export type LineShape =
  | { kind: 'condition'; keyword: 'if' | 'elif' | 'while'; from: number; to: number }
  | { kind: 'return'; from: number; to: number }
  | { kind: 'assign'; targetFrom: number; targetTo: number; op: string; from: number; to: number }
  | { kind: 'def'; nameIndex: number; open: number; close: number }
  | { kind: 'expr'; from: number; to: number }
  | { kind: 'other' };

/** Classify the current line and locate its main expression as a token range [from, to). */
export function lineShape(ctx: TemplateContext): LineShape {
  const t = ctx.lineTokens;
  const first = t[0];
  if (first === undefined) return { kind: 'other' };
  if (first.type === 'NAME' && (first.text === 'if' || first.text === 'elif' || first.text === 'while')) {
    const colon = findTopLevel(t, (u) => isOp(u, ':'), 1);
    if (colon <= 1) return { kind: 'other' };
    return { kind: 'condition', keyword: first.text, from: 1, to: colon };
  }
  if (isKw(first, 'return')) return t.length > 1 ? { kind: 'return', from: 1, to: t.length } : { kind: 'other' };
  if (isKw(first, 'def') || (isKw(first, 'async') && isKw(t[1], 'def'))) {
    const nameIndex = isKw(first, 'def') ? 1 : 2;
    const open = nameIndex + 1;
    if (!isName(t[nameIndex]) || !isOp(t[open], '(')) return { kind: 'other' };
    const close = matchClose(t, open);
    return close < 0 ? { kind: 'other' } : { kind: 'def', nameIndex, open, close };
  }
  if (first.type === 'NAME' && isKeyword(first.text) && first.text !== 'not' && first.text !== 'await' && first.text !== 'lambda') return { kind: 'other' };
  const eq = findTopLevel(t, (u) => u.type === 'OP' && /^([-+*/%&|^@]|\*\*|\/\/|<<|>>)?=$/.test(u.text));
  if (eq > 0 && eq < t.length - 1) return { kind: 'assign', targetFrom: 0, targetTo: eq, op: t[eq]!.text, from: eq + 1, to: t.length };
  return { kind: 'expr', from: 0, to: t.length };
}

/** Whether a token range is a single literal or `None`/`True`/`False` (nothing to wrap). */
export function isBareLiteral(ctx: TemplateContext, from: number, to: number): boolean {
  if (to - from !== 1) return false;
  const t = ctx.lineTokens[from]!;
  return t.type === 'NUMBER' || t.type === 'STRING' || t.text === 'None' || t.text === 'True' || t.text === 'False';
}

/**
 * Default value literals for a function from its return annotation (`-> str` gives `""`), its
 * existing simple return expressions, the failing tests' literals and the usual zero values.
 */
export function returnDefaults(ctx: TemplateContext): string[] {
  const out: string[] = [];
  const ann = ctx.block?.returns ?? null;
  if (ann !== null) {
    const a = ann.replace(/\s+/g, '');
    if (a === 'str') out.push('""');
    else if (a === 'int') out.push('0');
    else if (a === 'float') out.push('0.0');
    else if (a === 'bool') out.push('False', 'True');
    else if (/^(list|List)/.test(a)) out.push('[]');
    else if (/^(dict|Dict)/.test(a)) out.push('{}');
    else if (/^(set|Set)/.test(a)) out.push('set()');
    else if (/^(tuple|Tuple)/.test(a)) out.push('()');
    else if (/^Optional/.test(a) || a === 'None') out.push('None');
  }
  if (ctx.fn !== undefined) {
    for (const r of ctx.fn.returns) {
      if (r.expr === null) continue;
      const toks = fragmentTokens(r.expr);
      // simple values only: a literal, a name or a dotted name
      if (toks.length === 1 || toks.every((u) => u.type === 'NAME' || isOp(u, '.'))) out.push(r.expr);
    }
  }
  out.push(...ctx.opts.testLiterals.slice(0, 4));
  out.push('None', '""', '0', 'False', '[]');
  return uniq(out).filter((v) => v.length <= 40);
}
