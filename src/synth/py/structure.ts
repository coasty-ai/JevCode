/**
 * Token-level structural analysis of a Python module: logical statements with kinds, def/class
 * blocks with signatures and body spans, per-function facts (identifiers, literals, calls,
 * attribute accesses, comparisons, returns), an imports table and per-line in-scope names.
 *
 * Everything is derived from the tokenizer (no AST), so it works on files that do not parse
 * as long as they tokenize, and every fact carries the line it came from so candidate
 * sources can point Jev at the code.
 */
import { PY_KEYWORDS, indentWidth, isKeyword, renderTokens, tokenize } from './tokenize.js';
import type { Token } from './tokenize.js';

export type StatementKind =
  | 'def'
  | 'class'
  | 'if'
  | 'elif'
  | 'else'
  | 'for'
  | 'while'
  | 'try'
  | 'except'
  | 'finally'
  | 'with'
  | 'return'
  | 'assign'
  | 'augassign'
  | 'expr'
  | 'import'
  | 'from_import'
  | 'pass'
  | 'break'
  | 'continue'
  | 'raise'
  | 'assert'
  | 'global'
  | 'nonlocal'
  | 'decorator'
  | 'other';

const COMPOUND_KINDS: ReadonlySet<StatementKind> = new Set(['def', 'class', 'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with']);
const AUG_OPS: ReadonlySet<string> = new Set(['+=', '-=', '*=', '/=', '//=', '%=', '**=', '>>=', '<<=', '&=', '|=', '^=', '@=']);
const COMPARISON_OPS: ReadonlySet<string> = new Set(['<', '<=', '>', '>=', '==', '!=']);

export interface AttrAssign {
  receiver: string;
  attr: string;
  line: number;
}

export interface Statement {
  /** Index into `PyModule.statements`. */
  index: number;
  /** Physical line range of the logical line, inclusive. */
  startLine: number;
  endLine: number;
  /** Tab-expanded column of the first token. */
  indent: number;
  kind: StatementKind;
  /** The leading keyword when there is one (`async def` reports `def`). */
  keyword: string | null;
  /** Code tokens of the statement (no NEWLINE/NL/COMMENT/INDENT/DEDENT). */
  tokens: Token[];
  /** Exact source from the first to the last token. */
  text: string;
  /** Compound statement header (`if ...:`, `def ...:`); `colonIndex` is the header colon in `tokens`. */
  header: boolean;
  colonIndex: number | null;
  /** Names this statement binds in its own scope (assign targets, loop variables, `as` names, imports, def/class names, walrus targets). */
  binds: string[];
  /** `receiver.attr = ...` / `receiver.attr += ...` targets. */
  attrAssigns: AttrAssign[];
  /** Innermost enclosing def/class block, null at module level. */
  blockIndex: number | null;
}

export interface Param {
  name: string;
  /** '' for a normal parameter, '*' for *args, '**' for **kwargs. */
  star: '' | '*' | '**';
  annotation: string | null;
  default: string | null;
  /** Exact source of the parameter. */
  text: string;
}

export interface Block {
  index: number;
  kind: 'def' | 'class';
  name: string;
  isAsync: boolean;
  params: Param[];
  /** Class bases and keywords (`Base`, `metaclass=Meta`), rendered. */
  bases: string[];
  returns: string | null;
  /** Decorator expressions without the `@`, in source order. */
  decorators: string[];
  /** First line of the first decorator (or the header when undecorated). */
  startLine: number;
  /** The `def`/`class` logical line. */
  headerLine: number;
  headerEndLine: number;
  /** Body lines, inclusive; a one-liner body sits on the header line. */
  bodyStart: number;
  bodyEnd: number;
  /** Same as bodyEnd; the last line of the block. */
  endLine: number;
  indent: number;
  bodyIndent: number;
  depth: number;
  parent: number | null;
  /** Raw docstring literal (with quotes) when the body starts with one. */
  docstring: string | null;
  statementIndex: number;
}

export interface CallFact {
  callee: string;
  argCount: number;
  line: number;
}

export interface AttrFact {
  receiver: string;
  attr: string;
  line: number;
}

export interface ReturnFact {
  line: number;
  expr: string | null;
}

export interface FunctionFacts {
  blockIndex: number;
  name: string;
  /** Distinct non-keyword identifiers read or written in the body (attribute names excluded). */
  identifiers: string[];
  literals: { numbers: string[]; strings: string[] };
  calls: CallFact[];
  attributes: AttrFact[];
  /** Distinct comparison operators present: `<`, `<=`, `>`, `>=`, `==`, `!=`, `in`, `not in`, `is`, `is not`. */
  comparisons: string[];
  /** Distinct operator tokens present (brackets and punctuation included). */
  operators: string[];
  keywords: string[];
  returns: ReturnFact[];
}

export interface ImportEntry {
  line: number;
  kind: 'import' | 'from';
  /** Module path (`os.path`, `.sibling`, `..pkg.mod`). */
  module: string;
  /** Imported name for `from` imports (`*` for star), null for plain imports. */
  name: string | null;
  alias: string | null;
  /** The name bound in the importing scope (`*` for star imports). */
  bound: string;
  /** Relative-import dots. */
  level: number;
  scope: 'module' | 'local';
  statementIndex: number;
}

export interface LineScope {
  line: number;
  /** Parameters of every enclosing function, outermost first. */
  params: string[];
  /** Names bound in the enclosing functions (innermost: only on lines at or before `line`). */
  locals: string[];
  /** Attributes of the enclosing class: methods, class-level names and `self.x` assignments. */
  classAttrs: string[];
  /** First parameter of the enclosing method (`self`, `cls`), null outside methods. */
  selfName: string | null;
  /** Module-level names other than imports (all of them inside a function; up to `line` at module level). */
  module: string[];
  /** Names bound by visible import statements. */
  imports: string[];
  builtins: string[];
  /** params + locals + module + imports + builtins, de-duplicated in that order. */
  all: string[];
}

export interface PyModule {
  src: string;
  /** Physical lines without their line endings. */
  lines: string[];
  tokens: Token[];
  statements: Statement[];
  blocks: Block[];
  functions: FunctionFacts[];
  imports: ImportEntry[];
  /** Module-level bound names, imports included, in order of first binding. */
  moduleNames: string[];
}

export const PY_BUILTINS: readonly string[] = [
  'abs', 'aiter', 'all', 'anext', 'any', 'ascii', 'bin', 'bool', 'breakpoint', 'bytearray', 'bytes', 'callable', 'chr',
  'classmethod', 'compile', 'complex', 'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec', 'filter',
  'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash', 'help', 'hex', 'id', 'input', 'int',
  'isinstance', 'issubclass', 'iter', 'len', 'list', 'locals', 'map', 'max', 'memoryview', 'min', 'next', 'object',
  'oct', 'open', 'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice',
  'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip', '__import__',
  'True', 'False', 'None', 'NotImplemented', 'Ellipsis', '__name__', '__file__', '__doc__', '__debug__',
  'BaseException', 'Exception', 'ArithmeticError', 'AssertionError', 'AttributeError', 'BufferError', 'EOFError',
  'FloatingPointError', 'GeneratorExit', 'ImportError', 'ModuleNotFoundError', 'IndexError', 'KeyError',
  'KeyboardInterrupt', 'LookupError', 'MemoryError', 'NameError', 'NotImplementedError', 'OSError', 'OverflowError',
  'RecursionError', 'ReferenceError', 'RuntimeError', 'StopIteration', 'StopAsyncIteration', 'SyntaxError',
  'IndentationError', 'TabError', 'SystemError', 'SystemExit', 'TypeError', 'UnboundLocalError', 'UnicodeError',
  'UnicodeEncodeError', 'UnicodeDecodeError', 'UnicodeTranslateError', 'ValueError', 'ZeroDivisionError',
  'EnvironmentError', 'IOError', 'BlockingIOError', 'ChildProcessError', 'ConnectionError', 'BrokenPipeError',
  'ConnectionAbortedError', 'ConnectionRefusedError', 'ConnectionResetError', 'FileExistsError', 'FileNotFoundError',
  'InterruptedError', 'IsADirectoryError', 'NotADirectoryError', 'PermissionError', 'ProcessLookupError', 'TimeoutError',
  'Warning', 'UserWarning', 'DeprecationWarning', 'PendingDeprecationWarning', 'SyntaxWarning', 'RuntimeWarning',
  'FutureWarning', 'ImportWarning', 'UnicodeWarning', 'BytesWarning', 'ResourceWarning',
];

// ---------------------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------------------

function isOpen(t: Token): boolean {
  return t.type === 'OP' && (t.text === '(' || t.text === '[' || t.text === '{');
}
function isClose(t: Token): boolean {
  return t.type === 'OP' && (t.text === ')' || t.text === ']' || t.text === '}');
}
function isOp(t: Token | undefined, text: string): boolean {
  return t !== undefined && t.type === 'OP' && t.text === text;
}
function isName(t: Token | undefined, text?: string): boolean {
  return t !== undefined && t.type === 'NAME' && (text === undefined ? !isKeyword(t.text) : t.text === text);
}
function isKw(t: Token | undefined, text: string): boolean {
  return t !== undefined && t.type === 'NAME' && t.text === text;
}

/** Index of the matching close bracket for the open bracket at `open`, or tokens.length - 1. */
function matchClose(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (isOpen(t)) depth++;
    else if (isClose(t)) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return tokens.length - 1;
}

/** Split a token span at depth-0 occurrences of an operator. */
function splitTopLevel(tokens: readonly Token[], sep: string): Token[][] {
  const parts: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (isOpen(t)) depth++;
    else if (isClose(t)) depth = Math.max(0, depth - 1);
    if (depth === 0 && isOp(t, sep)) {
      parts.push(cur);
      cur = [];
      continue;
    }
    cur.push(t);
  }
  parts.push(cur);
  return parts;
}

/** Index of the first depth-0 token satisfying `pred`, or -1. */
function findTopLevel(tokens: readonly Token[], pred: (t: Token, k: number) => boolean, from = 0): number {
  let depth = 0;
  for (let k = from; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (isClose(t)) depth = Math.max(0, depth - 1);
    if (depth === 0 && pred(t, k)) return k;
    if (isOpen(t)) depth++;
  }
  return -1;
}

function uniq(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/**
 * Names bound by a target expression: `a`, `a, b`, `(a, b)`, `[a, *rest]`, `a: int`.
 * Subscripts (`x[0]`) and attributes (`x.y`) bind nothing; a name directly before `[` or `(`
 * is the receiver of a subscript/call, not a target.
 */
function targetNames(tokens: readonly Token[]): string[] {
  const names: string[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type !== 'NAME' || isKeyword(t.text)) continue;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    if (isOp(prev, '.')) continue;
    if (next !== undefined && (isOp(next, '.') || isOp(next, '[') || isOp(next, '('))) {
      // skip the whole primary: name, subscripts, calls and attribute chain
      let j = k + 1;
      while (j < tokens.length) {
        const u = tokens[j]!;
        if (isOp(u, '.') && tokens[j + 1]?.type === 'NAME') j += 2;
        else if (isOp(u, '[') || isOp(u, '(')) j = matchClose(tokens, j) + 1;
        else break;
      }
      k = j - 1;
      continue;
    }
    names.push(t.text);
  }
  return names;
}

/** `receiver.attr` targets (`self.x = 1`, `obj.a.b += 1` reports receiver `obj.a`). */
function attrTargets(tokens: readonly Token[], line: number): AttrAssign[] {
  const out: AttrAssign[] = [];
  for (const part of splitTopLevel(tokens, ',')) {
    const dot = part.length - 2;
    if (dot < 1 || !isOp(part[dot], '.') || part[dot + 1]?.type !== 'NAME') continue;
    const receiver = part.slice(0, dot);
    if (!receiver.every((t) => t.type === 'NAME' || isOp(t, '.'))) continue;
    out.push({ receiver: renderTokens(receiver), attr: part[dot + 1]!.text, line });
  }
  return out;
}

/** The dotted name ending at token `k` (`a.b.c`), or null when the primary is not a plain dotted name. */
function dottedNameEndingAt(tokens: readonly Token[], k: number): { text: string; start: number } | null {
  const t = tokens[k];
  if (t === undefined || t.type !== 'NAME' || isKeyword(t.text)) return null;
  let s = k;
  while (s >= 2 && isOp(tokens[s - 1], '.') && tokens[s - 2]?.type === 'NAME' && !isKeyword(tokens[s - 2]!.text)) s -= 2;
  return { text: tokens.slice(s, k + 1).map((u) => u.text).join(''), start: s };
}

// ---------------------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------------------

function classify(tokens: readonly Token[]): { kind: StatementKind; keyword: string | null } {
  const first = tokens[0];
  if (first === undefined) return { kind: 'other', keyword: null };
  if (isOp(first, '@')) return { kind: 'decorator', keyword: null };
  let head = first;
  if (isKw(first, 'async') && tokens[1] !== undefined && tokens[1].type === 'NAME') head = tokens[1];
  if (head.type === 'NAME' && PY_KEYWORDS.has(head.text)) {
    switch (head.text) {
      case 'def': case 'class': case 'if': case 'elif': case 'else': case 'for': case 'while': case 'try':
      case 'except': case 'finally': case 'with': case 'return': case 'import': case 'pass': case 'break':
      case 'continue': case 'raise': case 'assert': case 'global': case 'nonlocal':
        return { kind: head.text, keyword: head.text };
      case 'from':
        return { kind: 'from_import', keyword: 'from' };
      case 'del': case 'yield':
        return { kind: 'other', keyword: head.text };
      default:
        break; // await / not / lambda / None ... start an expression statement
    }
  }
  const eq = findTopLevel(tokens, (t) => t.type === 'OP' && (t.text === '=' || AUG_OPS.has(t.text)));
  if (eq >= 0) return { kind: tokens[eq]!.text === '=' ? 'assign' : 'augassign', keyword: null };
  // annotation without a value (`x: int`, `self.x: int`) and soft-keyword headers (`match x:`)
  if (findTopLevel(tokens, (t) => isOp(t, ':')) >= 0) return { kind: 'other', keyword: null };
  return { kind: 'expr', keyword: null };
}

/** Names bound by walrus operators anywhere in the statement (they bind in the enclosing scope). */
function walrusNames(tokens: readonly Token[]): string[] {
  const out: string[] = [];
  tokens.forEach((t, k) => {
    if (isOp(t, ':=') && isName(tokens[k - 1])) out.push(tokens[k - 1]!.text);
  });
  return out;
}

function importBinds(kind: StatementKind, tokens: readonly Token[]): string[] {
  if (kind === 'import') {
    return splitTopLevel(tokens.slice(1), ',').flatMap((part) => {
      const as = part.findIndex((t) => isKw(t, 'as'));
      if (as >= 0) return part[as + 1] !== undefined ? [part[as + 1]!.text] : [];
      return part[0] !== undefined && part[0].type === 'NAME' ? [part[0].text] : [];
    });
  }
  const imp = tokens.findIndex((t) => isKw(t, 'import'));
  if (imp < 0) return [];
  let rest = tokens.slice(imp + 1);
  if (isOp(rest[0], '(')) rest = rest.slice(1, rest.length - (isOp(rest[rest.length - 1], ')') ? 1 : 0));
  return splitTopLevel(rest, ',').flatMap((part) => {
    if (part.length === 0) return [];
    if (isOp(part[0], '*')) return ['*'];
    const as = part.findIndex((t) => isKw(t, 'as'));
    if (as >= 0) return part[as + 1] !== undefined ? [part[as + 1]!.text] : [];
    return part[0]!.type === 'NAME' ? [part[0]!.text] : [];
  });
}

/**
 * Target spans of an assignment: everything before each depth-0 `=`, stopping at the first
 * span that starts the value (`x = lambda a, b=1: ...` has one target, not three). An
 * annotation (`x: int = 1`) is dropped from its span.
 */
function assignTargetSpans(tokens: readonly Token[]): Token[][] {
  const parts = splitTopLevel(tokens, '=');
  const spans: Token[][] = [];
  for (const part of parts.slice(0, -1)) {
    if (findTopLevel(part, (t) => isKw(t, 'lambda') || isKw(t, 'yield') || isKw(t, 'await')) >= 0) break;
    const ann = findTopLevel(part, (t) => isOp(t, ':'));
    spans.push(ann >= 0 ? part.slice(0, ann) : part);
  }
  return spans;
}

function bindsOf(kind: StatementKind, tokens: readonly Token[], colonIndex: number | null): string[] {
  const walrus = walrusNames(tokens);
  switch (kind) {
    case 'assign':
      return uniq([...assignTargetSpans(tokens).flatMap(targetNames), ...walrus]);
    case 'augassign': {
      const op = findTopLevel(tokens, (t) => t.type === 'OP' && AUG_OPS.has(t.text));
      return uniq([...targetNames(tokens.slice(0, op)), ...walrus]);
    }
    case 'for': {
      const start = isKw(tokens[0], 'async') ? 2 : 1;
      const inIdx = findTopLevel(tokens, (t) => isKw(t, 'in'), start);
      return uniq([...targetNames(tokens.slice(start, inIdx >= 0 ? inIdx : tokens.length)), ...walrus]);
    }
    case 'with': {
      const header = colonIndex === null ? tokens : tokens.slice(0, colonIndex);
      const names: string[] = [];
      header.forEach((t, k) => {
        if (!isKw(t, 'as')) return;
        // `as (a, b)` or `as name`: take names until the next comma at this depth or the end
        let j = k + 1;
        const span: Token[] = [];
        let depth = 0;
        while (j < header.length) {
          const u = header[j]!;
          if (depth === 0 && (isOp(u, ',') || isOp(u, ')'))) break;
          if (isOpen(u)) depth++;
          else if (isClose(u)) depth--;
          span.push(u);
          j++;
        }
        names.push(...targetNames(span));
      });
      return uniq([...names, ...walrus]);
    }
    case 'except': {
      const as = tokens.findIndex((t) => isKw(t, 'as'));
      return as >= 0 && tokens[as + 1] !== undefined ? [tokens[as + 1]!.text] : [];
    }
    case 'import':
    case 'from_import':
      return uniq(importBinds(kind, tokens));
    case 'def':
    case 'class': {
      const nameTok = tokens[isKw(tokens[0], 'async') ? 2 : 1];
      return nameTok !== undefined && nameTok.type === 'NAME' ? [nameTok.text] : [];
    }
    case 'global':
    case 'nonlocal':
      return tokens.slice(1).filter((t) => t.type === 'NAME').map((t) => t.text);
    case 'other': {
      // annotation-only declaration `x: int` declares a name; `del`/`yield` bind nothing
      if (tokens[0]?.type === 'NAME' && !isKeyword(tokens[0].text) && isOp(tokens[1], ':')) return uniq([tokens[0].text, ...walrus]);
      return walrus;
    }
    default:
      return uniq(walrus);
  }
}

function attrAssignsOf(kind: StatementKind, tokens: readonly Token[], line: number): AttrAssign[] {
  if (kind === 'assign') return assignTargetSpans(tokens).flatMap((span) => attrTargets(span, line));
  if (kind === 'augassign') {
    const op = findTopLevel(tokens, (t) => t.type === 'OP' && AUG_OPS.has(t.text));
    return attrTargets(tokens.slice(0, op), line);
  }
  return [];
}

/** Group tokens into logical lines (split on NEWLINE), then into statements (split on `;`). */
function buildStatements(tokens: readonly Token[], lines: readonly string[]): Statement[] {
  const statements: Statement[] = [];
  let cur: Token[] = [];
  const flush = (): void => {
    if (cur.length === 0) return;
    // `if x: a = 1; b = 2` is one compound statement whose inline body has two parts;
    // `a = 1; b = 2` is two statements.
    const headerColon = COMPOUND_KINDS.has(classify(cur).kind) && findTopLevel(cur, (t) => isOp(t, ':')) >= 0;
    for (const part of headerColon ? [cur] : splitTopLevel(cur, ';')) {
      if (part.length === 0) continue;
      const first = part[0]!;
      const last = part[part.length - 1]!;
      const { kind, keyword } = classify(part);
      const header = COMPOUND_KINDS.has(kind);
      const colon = header ? findTopLevel(part, (t) => isOp(t, ':')) : -1;
      const colonIndex = colon >= 0 ? colon : null;
      const lineText = lines[first.line - 1] ?? '';
      const binds = bindsOf(kind, part, colonIndex);
      const attrAssigns = attrAssignsOf(kind, part, first.line);
      if (colonIndex !== null && colonIndex < part.length - 1) {
        // one-liner compound statement: the inline body binds in the same scope
        for (const inline of splitTopLevel(part.slice(colonIndex + 1), ';')) {
          if (inline.length === 0) continue;
          const inlineKind = classify(inline).kind;
          binds.push(...bindsOf(inlineKind, inline, null));
          attrAssigns.push(...attrAssignsOf(inlineKind, inline, inline[0]!.line));
        }
      }
      statements.push({
        index: statements.length,
        startLine: first.line,
        endLine: last.endLine,
        indent: indentWidth(lineText.slice(0, first.col)),
        kind,
        keyword,
        tokens: part,
        text: '',
        header,
        colonIndex,
        binds: uniq(binds),
        attrAssigns,
        blockIndex: null,
      });
    }
    cur = [];
  };
  for (const t of tokens) {
    switch (t.type) {
      case 'NEWLINE':
        flush();
        break;
      case 'NL': case 'COMMENT': case 'INDENT': case 'DEDENT': case 'ENDMARKER':
        break;
      default:
        cur.push(t);
    }
  }
  flush();
  return statements;
}

// ---------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------

function parseParams(tokens: readonly Token[], src: string): Param[] {
  const out: Param[] = [];
  for (const part of splitTopLevel(tokens, ',')) {
    if (part.length === 0) continue;
    if (part.length === 1 && (isOp(part[0], '*') || isOp(part[0], '/'))) continue; // bare markers
    let k = 0;
    let star: Param['star'] = '';
    if (isOp(part[0], '**')) {
      star = '**';
      k = 1;
    } else if (isOp(part[0], '*')) {
      star = '*';
      k = 1;
    }
    const nameTok = part[k];
    if (nameTok === undefined || nameTok.type !== 'NAME') continue;
    const rest = part.slice(k + 1);
    const colon = findTopLevel(rest, (t) => isOp(t, ':'));
    const eq = findTopLevel(rest, (t) => isOp(t, '='));
    const annotation = colon >= 0 ? renderTokens(rest.slice(colon + 1, eq >= 0 ? eq : rest.length)) : null;
    const def = eq >= 0 ? renderTokens(rest.slice(eq + 1)) : null;
    out.push({ name: nameTok.text, star, annotation: annotation === '' ? null : annotation, default: def === '' ? null : def, text: src.slice(part[0]!.start, part[part.length - 1]!.end) });
  }
  return out;
}

interface OpenBlock {
  index: number;
  lastLine: number;
  firstBody: number | null;
  bodyIndent: number;
}

function buildBlocks(statements: Statement[], src: string): Block[] {
  const blocks: Block[] = [];
  const open: OpenBlock[] = [];
  let pendingDecorators: { exprs: string[]; startLine: number; indent: number } | null = null;

  const finish = (ob: OpenBlock): void => {
    const b = blocks[ob.index]!;
    b.bodyEnd = ob.lastLine;
    b.endLine = ob.lastLine;
    b.bodyStart = ob.firstBody ?? b.headerLine;
    b.bodyIndent = ob.bodyIndent;
  };

  for (const st of statements) {
    // close blocks this statement is not inside of
    while (open.length > 0 && blocks[open[open.length - 1]!.index]!.indent >= st.indent) finish(open.pop()!);
    const parent = open.length > 0 ? open[open.length - 1]!.index : null;
    st.blockIndex = parent;
    for (const ob of open) {
      ob.lastLine = Math.max(ob.lastLine, st.endLine);
      if (ob.firstBody === null) {
        ob.firstBody = st.startLine;
        ob.bodyIndent = st.indent;
      }
    }
    if (st.kind === 'decorator') {
      const expr = renderTokens(st.tokens.slice(1));
      if (pendingDecorators !== null && pendingDecorators.indent === st.indent) pendingDecorators.exprs.push(expr);
      else pendingDecorators = { exprs: [expr], startLine: st.startLine, indent: st.indent };
      continue;
    }
    if (st.kind !== 'def' && st.kind !== 'class') {
      pendingDecorators = null;
      continue;
    }
    const isAsync = isKw(st.tokens[0], 'async');
    const nameTok = st.tokens[isAsync ? 2 : 1];
    const name = nameTok !== undefined && nameTok.type === 'NAME' ? nameTok.text : '';
    const headerTokens = st.colonIndex === null ? st.tokens : st.tokens.slice(0, st.colonIndex);
    const openIdx = headerTokens.findIndex((t, k) => k > (isAsync ? 2 : 1) && isOp(t, '('));
    let inner: Token[] = [];
    let afterParen = headerTokens.length;
    if (openIdx >= 0) {
      const close = matchClose(headerTokens, openIdx);
      inner = headerTokens.slice(openIdx + 1, close);
      afterParen = close + 1;
    }
    const arrow = headerTokens.findIndex((t, k) => k >= afterParen && isOp(t, '->'));
    const returns = arrow >= 0 ? renderTokens(headerTokens.slice(arrow + 1)) : null;
    const decorators = pendingDecorators !== null && pendingDecorators.indent === st.indent ? pendingDecorators : null;
    pendingDecorators = null;
    // one-liner body after the colon
    const inlineBody = st.colonIndex !== null && st.colonIndex < st.tokens.length - 1;
    const block: Block = {
      index: blocks.length,
      kind: st.kind,
      name,
      isAsync,
      params: st.kind === 'def' ? parseParams(inner, src) : [],
      bases: st.kind === 'class' ? splitTopLevel(inner, ',').filter((p) => p.length > 0).map(renderTokens) : [],
      returns: returns === '' ? null : returns,
      decorators: decorators?.exprs ?? [],
      startLine: decorators?.startLine ?? st.startLine,
      headerLine: st.startLine,
      headerEndLine: st.endLine,
      bodyStart: st.startLine,
      bodyEnd: st.endLine,
      endLine: st.endLine,
      indent: st.indent,
      bodyIndent: st.indent,
      depth: open.length,
      parent,
      docstring: null,
      statementIndex: st.index,
    };
    blocks.push(block);
    open.push({ index: block.index, lastLine: st.endLine, firstBody: inlineBody ? st.startLine : null, bodyIndent: st.indent });
  }
  while (open.length > 0) finish(open.pop()!);

  // docstrings: first body statement that is a lone string literal
  for (const b of blocks) {
    const first = statements.find((s) => s.blockIndex === b.index && s.startLine >= b.bodyStart);
    if (first !== undefined && first.kind === 'expr' && first.tokens.length > 0 && first.tokens.every((t) => t.type === 'STRING')) b.docstring = first.text;
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------
// Function facts
// ---------------------------------------------------------------------------------------

function comparisonsIn(tokens: readonly Token[]): string[] {
  const found: string[] = [];
  const pendingFor: boolean[] = [];
  let depth = 0;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (isOpen(t)) {
      depth++;
      continue;
    }
    if (isClose(t)) {
      pendingFor[depth] = false;
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (t.type === 'OP' && COMPARISON_OPS.has(t.text)) found.push(t.text);
    else if (isKw(t, 'for')) pendingFor[depth] = true;
    else if (isKw(t, 'in')) {
      if (pendingFor[depth] === true) pendingFor[depth] = false;
      else found.push(isKw(tokens[k - 1], 'not') ? 'not in' : 'in');
    } else if (isKw(t, 'is')) found.push(isKw(tokens[k + 1], 'not') ? 'is not' : 'is');
  }
  return uniq(found);
}

function callsIn(tokens: readonly Token[]): CallFact[] {
  const out: CallFact[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (!isOp(t, '(')) continue;
    const callee = dottedNameEndingAt(tokens, k - 1);
    if (callee === null) continue;
    // `def inner(...)` / `class A(Base)` headers of nested blocks are not calls
    const before = tokens[callee.start - 1];
    if (isKw(before, 'def') || isKw(before, 'class')) continue;
    // `f(x).method(...)`, `a[0].method(...)`: the receiver is an expression
    const name = isOp(before, '.') ? `<expr>.${callee.text}` : callee.text;
    const close = matchClose(tokens, k);
    const inner = tokens.slice(k + 1, close);
    let argCount = 0;
    if (inner.length > 0) {
      const parts = splitTopLevel(inner, ',');
      argCount = parts.filter((p, idx) => p.length > 0 || idx < parts.length - 1).length;
    }
    out.push({ callee: name, argCount, line: t.line });
  }
  return out;
}

function attributesIn(tokens: readonly Token[], skip: ReadonlySet<Token>): AttrFact[] {
  const out: AttrFact[] = [];
  for (let k = 1; k < tokens.length - 1; k++) {
    const dot = tokens[k]!;
    if (!isOp(dot, '.') || skip.has(dot)) continue;
    const attr = tokens[k + 1];
    if (attr === undefined || attr.type !== 'NAME') continue;
    const prev = tokens[k - 1];
    if (prev === undefined) continue;
    let receiver = '<expr>';
    if (prev.type === 'NAME' && !isKeyword(prev.text)) receiver = dottedNameEndingAt(tokens, k - 1)?.text ?? prev.text;
    else if (prev.type === 'STRING' || prev.type === 'NUMBER') receiver = prev.text;
    out.push({ receiver, attr: attr.text, line: dot.line });
  }
  return out;
}

function returnsIn(statements: readonly Statement[], block: Block, blocks: readonly Block[]): ReturnFact[] {
  const out: ReturnFact[] = [];
  for (const st of statements) {
    const isHeader = st.index === block.statementIndex;
    if (!isHeader) {
      if (st.startLine < block.bodyStart || st.startLine > block.bodyEnd) continue;
      if (innermostFunction(st.blockIndex, blocks) !== block.index) continue;
      if (st.kind === 'def' || st.kind === 'class') continue; // a nested one-liner's inline body is its own
      if (st.kind === 'return') {
        out.push({ line: st.startLine, expr: st.tokens.length > 1 ? renderTokens(st.tokens.slice(1)) : null });
        continue;
      }
    }
    // `if x: return 1`, `else: return`, `def f(): return 1`
    if (st.colonIndex !== null && isKw(st.tokens[st.colonIndex + 1], 'return')) {
      const rest = st.tokens.slice(st.colonIndex + 2);
      out.push({ line: st.startLine, expr: rest.length > 0 ? renderTokens(rest) : null });
    }
  }
  return out;
}

/** Nearest enclosing def, walking out of classes (a method's body belongs to the method). */
function innermostFunction(blockIndex: number | null, blocks: readonly Block[]): number | null {
  let idx = blockIndex;
  while (idx !== null) {
    const b = blocks[idx]!;
    if (b.kind === 'def') return idx;
    idx = b.parent;
  }
  return null;
}

function buildFunctionFacts(mod: { statements: Statement[]; blocks: Block[] }): FunctionFacts[] {
  const facts: FunctionFacts[] = [];
  for (const block of mod.blocks) {
    if (block.kind !== 'def') continue;
    const body = mod.statements.filter((s) => s.startLine >= block.bodyStart && s.startLine <= block.bodyEnd && s.index !== block.statementIndex);
    // include the inline body of a one-liner def
    const headerStmt = mod.statements[block.statementIndex]!;
    const inlineTokens = headerStmt.colonIndex !== null ? headerStmt.tokens.slice(headerStmt.colonIndex + 1) : [];
    const tokens: Token[] = [...inlineTokens, ...body.flatMap((s) => s.tokens)];
    const importDots = new Set<Token>();
    for (const s of body) if (s.kind === 'import' || s.kind === 'from_import') for (const t of s.tokens) if (isOp(t, '.')) importDots.add(t);

    const identifiers: string[] = [];
    const numbers: string[] = [];
    const strings: string[] = [];
    const operators: string[] = [];
    const keywords: string[] = [];
    tokens.forEach((t, k) => {
      if (t.type === 'NAME') {
        if (isKeyword(t.text)) keywords.push(t.text);
        else if (!isOp(tokens[k - 1], '.')) identifiers.push(t.text);
      } else if (t.type === 'NUMBER') numbers.push(t.text);
      else if (t.type === 'STRING') strings.push(t.text);
      else if (t.type === 'OP') operators.push(t.text);
    });
    facts.push({
      blockIndex: block.index,
      name: block.name,
      identifiers: uniq(identifiers),
      literals: { numbers: uniq(numbers), strings: uniq(strings) },
      calls: callsIn(tokens),
      attributes: attributesIn(tokens, importDots),
      comparisons: comparisonsIn(tokens),
      operators: uniq(operators),
      keywords: uniq(keywords),
      returns: returnsIn(mod.statements, block, mod.blocks),
    });
  }
  return facts;
}

// ---------------------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------------------

function buildImports(statements: readonly Statement[]): ImportEntry[] {
  const out: ImportEntry[] = [];
  for (const st of statements) {
    const scope: ImportEntry['scope'] = st.blockIndex === null ? 'module' : 'local';
    if (st.kind === 'import') {
      for (const part of splitTopLevel(st.tokens.slice(1), ',')) {
        const as = part.findIndex((t) => isKw(t, 'as'));
        const modToks = as >= 0 ? part.slice(0, as) : part;
        const module = modToks.map((t) => t.text).join('');
        if (module === '') continue;
        const alias = as >= 0 && part[as + 1] !== undefined ? part[as + 1]!.text : null;
        out.push({ line: st.startLine, kind: 'import', module, name: null, alias, bound: alias ?? module.split('.')[0]!, level: 0, scope, statementIndex: st.index });
      }
    } else if (st.kind === 'from_import') {
      const imp = st.tokens.findIndex((t) => isKw(t, 'import'));
      if (imp < 0) continue;
      const modToks = st.tokens.slice(1, imp);
      let level = 0;
      for (const t of modToks) {
        if (isOp(t, '.')) level += 1;
        else if (isOp(t, '...')) level += 3;
        else break;
      }
      const module = modToks.map((t) => t.text).join('');
      let rest = st.tokens.slice(imp + 1);
      if (isOp(rest[0], '(')) rest = rest.slice(1, rest.length - (isOp(rest[rest.length - 1], ')') ? 1 : 0));
      for (const part of splitTopLevel(rest, ',')) {
        if (part.length === 0) continue;
        if (isOp(part[0], '*')) {
          out.push({ line: st.startLine, kind: 'from', module, name: '*', alias: null, bound: '*', level, scope, statementIndex: st.index });
          continue;
        }
        const as = part.findIndex((t) => isKw(t, 'as'));
        const name = part[0]!.text;
        const alias = as >= 0 && part[as + 1] !== undefined ? part[as + 1]!.text : null;
        out.push({ line: st.startLine, kind: 'from', module, name, alias, bound: alias ?? name, level, scope, statementIndex: st.index });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------

/** Physical lines of a source without their line endings (`''` gives `[]`). */
export function splitPhysicalLines(src: string): string[] {
  if (src === '') return [];
  const lines = src.split(/\r?\n/);
  if (lines[lines.length - 1] === '' && /\r?\n$/.test(src)) lines.pop();
  return lines;
}

/** Analyse a module. Throws PyTokenizeError / PyIndentationError when the source does not tokenize. */
export function analyse(src: string): PyModule {
  const tokens = tokenize(src);
  const lines = splitPhysicalLines(src);
  const statements = buildStatements(tokens, lines);
  for (const st of statements) st.text = src.slice(st.tokens[0]!.start, st.tokens[st.tokens.length - 1]!.end);
  const blocks = buildBlocks(statements, src);
  const functions = buildFunctionFacts({ statements, blocks });
  const imports = buildImports(statements);
  const moduleNames = uniq(statements.filter((s) => s.blockIndex === null).flatMap((s) => s.binds).filter((n) => n !== '*'));
  return { src, lines, tokens, statements, blocks, functions, imports, moduleNames };
}

/** The statement whose line range contains `line`, if any. */
export function statementAt(mod: PyModule, line: number): Statement | undefined {
  return mod.statements.find((s) => s.startLine <= line && line <= s.endLine);
}

/** Innermost def/class whose span (decorators to body end) contains `line`. */
export function blockAt(mod: PyModule, line: number): Block | undefined {
  let best: Block | undefined;
  for (const b of mod.blocks) {
    if (b.startLine <= line && line <= b.endLine && (best === undefined || b.depth > best.depth)) best = b;
  }
  return best;
}

/** Facts for the innermost def containing `line`. */
export function functionAt(mod: PyModule, line: number): FunctionFacts | undefined {
  const b = blockAt(mod, line);
  const fn = innermostFunction(b?.index ?? null, mod.blocks);
  return fn === null ? undefined : mod.functions.find((f) => f.blockIndex === fn);
}

function enclosingChain(mod: PyModule, line: number): Block[] {
  const chain: Block[] = [];
  let b = blockAt(mod, line);
  while (b !== undefined) {
    chain.unshift(b);
    b = b.parent === null ? undefined : mod.blocks[b.parent];
  }
  return chain;
}

/** Statements directly inside `block` (not in nested def/class bodies), excluding its header. */
function directStatements(mod: PyModule, block: Block): Statement[] {
  return mod.statements.filter((s) => s.blockIndex === block.index);
}

/** In-scope identifiers for physical line `line`, by category. */
export function scopeAt(mod: PyModule, line: number): LineScope {
  const chain = enclosingChain(mod, line);
  const importStmts = new Set(mod.imports.map((i) => i.statementIndex));
  const params: string[] = [];
  const locals: string[] = [];
  const imports: string[] = [];
  const functionsInChain = chain.filter((b) => b.kind === 'def');
  functionsInChain.forEach((fn, idx) => {
    params.push(...fn.params.map((p) => p.name));
    const innermost = idx === functionsInChain.length - 1;
    for (const s of directStatements(mod, fn)) {
      if (innermost && s.startLine > line) continue;
      const names = s.binds.filter((n) => n !== '*');
      if (importStmts.has(s.index)) imports.push(...names);
      else locals.push(...names);
    }
  });
  // a one-liner def keeps its inline body on the header line: `def f(x): y = x` binds y
  const moduleStmts = mod.statements.filter((s) => s.blockIndex === null);
  const atModuleLevel = functionsInChain.length === 0;
  const module: string[] = [];
  const moduleImports: string[] = [];
  for (const s of moduleStmts) {
    if (atModuleLevel && s.startLine > line) continue;
    const names = s.binds.filter((n) => n !== '*');
    if (importStmts.has(s.index)) moduleImports.push(...names);
    else module.push(...names);
  }
  // class body names are visible while executing the class body itself
  const innermostBlock = chain[chain.length - 1];
  if (innermostBlock !== undefined && innermostBlock.kind === 'class') {
    for (const s of directStatements(mod, innermostBlock)) {
      if (s.startLine > line) continue;
      locals.push(...s.binds.filter((n) => n !== '*'));
    }
  }
  const cls = [...chain].reverse().find((b) => b.kind === 'class');
  const classAttrs: string[] = [];
  let selfName: string | null = null;
  if (cls !== undefined) {
    for (const s of directStatements(mod, cls)) classAttrs.push(...s.binds.filter((n) => n !== '*'));
    for (const m of mod.blocks) {
      if (m.parent !== cls.index || m.kind !== 'def') continue;
      const receiver = m.params[0]?.name;
      if (receiver === undefined) continue;
      for (const s of mod.statements) {
        if (s.blockIndex !== m.index) continue;
        for (const a of s.attrAssigns) if (a.receiver === receiver) classAttrs.push(a.attr);
      }
    }
    const method = functionsInChain.find((f) => f.parent === cls.index);
    selfName = method?.params[0]?.name ?? null;
  }
  const builtins = [...PY_BUILTINS];
  const uParams = uniq(params);
  const uLocals = uniq(locals);
  const uModule = uniq(module);
  const uImports = uniq([...moduleImports, ...imports]);
  return {
    line,
    params: uParams,
    locals: uLocals,
    classAttrs: uniq(classAttrs),
    selfName,
    module: uModule,
    imports: uImports,
    builtins,
    all: uniq([...uParams, ...uLocals, ...uModule, ...uImports, ...builtins]),
  };
}

/** `scopeAt` for every physical line. */
export function lineScopes(mod: PyModule): LineScope[] {
  return mod.lines.map((_, k) => scopeAt(mod, k + 1));
}

// ---------------------------------------------------------------------------------------
// Exits and parameter mutation
//
// Two structural properties of a function the overfit guard reads off the source of a patched
// file, before and after the patch (docs/research/llm-jev/oos-analysis-2026-09-22.md Q6, ranked
// change 5): does control reach the end of the body (an implicit `return None`), and which
// parameters does the body mutate in place. Both are token-level like the rest of this module —
// nothing shells out to python — and both are LOWER bounds: a construct the rules do not model
// reads as "no exit here" / "no mutation here", so a caller only ever sees what can be proved.
// ---------------------------------------------------------------------------------------

/** The inline suite of a one-liner compound statement (`if x: break`), split on `;`; empty when the body is indented under the header. */
function inlineParts(st: Statement): Token[][] {
  if (st.colonIndex === null || st.colonIndex >= st.tokens.length - 1) return [];
  return splitTopLevel(st.tokens.slice(st.colonIndex + 1), ';').filter((p) => p.length > 0);
}

interface SuiteNode {
  st: Statement;
  /** statements indented under `st` (empty for a leaf or a one-liner) */
  body: SuiteNode[];
}

/** The statements directly inside `block` (nested def/class bodies excluded), nested by indentation so a header owns the suite under it. */
function suiteOf(mod: PyModule, block: Block): SuiteNode[] {
  const roots: SuiteNode[] = [];
  const open: { node: SuiteNode; indent: number }[] = [];
  for (const st of mod.statements) {
    if (st.blockIndex !== block.index) continue;
    while (open.length > 0 && st.indent <= open[open.length - 1]!.indent) open.pop();
    const node: SuiteNode = { st, body: [] };
    const parent = open[open.length - 1];
    if (parent === undefined) roots.push(node);
    else parent.node.body.push(node);
    if (st.header) open.push({ node, indent: st.indent });
  }
  return roots;
}

/** The two statements that leave a function from anywhere inside it. */
const EXIT_KINDS: ReadonlySet<StatementKind> = new Set(['return', 'raise']);
const LOOP_KINDS: ReadonlySet<StatementKind> = new Set(['for', 'while']);

/** Does the one-liner body of a header leave the function (`if x: return 1`, `else: raise E`)? */
function inlineExits(st: Statement): boolean {
  return inlineParts(st).some((p) => EXIT_KINDS.has(classify(p).kind));
}

/** Does a branch — a header's indented suite, or its one-liner body — leave the function on every path? */
function branchExits(node: SuiteNode): boolean {
  return inlineExits(node.st) || suiteExits(node.body);
}

/** `while True:` / `while 1:` — the one loop header that cannot finish on its own, so only a `break` (or an exit) leaves it. */
function isEndlessLoop(st: Statement): boolean {
  if (st.kind !== 'while' || st.colonIndex === null) return false;
  const cond = st.tokens.slice(1, st.colonIndex);
  const only = cond.length === 1 ? cond[0] : undefined;
  return only !== undefined && ((only.type === 'NAME' && only.text === 'True') || (only.type === 'NUMBER' && only.text === '1'));
}

/** Does `node`'s body `break` out of `node` itself? A `break` inside a nested loop binds to that loop and is not one. */
function breaksOut(node: SuiteNode): boolean {
  const isBreak = (st: Statement): boolean => st.kind === 'break' || inlineParts(st).some((p) => classify(p).kind === 'break');
  const walk = (nodes: readonly SuiteNode[]): boolean =>
    nodes.some((n) => {
      if (LOOP_KINDS.has(n.st.kind)) return false;
      return isBreak(n.st) || walk(n.body);
    });
  return inlineParts(node.st).some((p) => classify(p).kind === 'break') || walk(node.body);
}

/** The sibling clauses a compound header owns at this indent: `elif`/`else` after `if`, `except`/`else`/`finally` after `try`. */
function clauseChain(nodes: readonly SuiteNode[], start: number, kinds: ReadonlySet<StatementKind>): { chain: SuiteNode[]; next: number } {
  const chain: SuiteNode[] = [nodes[start]!];
  let j = start + 1;
  while (j < nodes.length) {
    const next = nodes[j]!;
    if (!kinds.has(next.st.kind)) break;
    chain.push(next);
    j += 1;
  }
  return { chain, next: j };
}

const IF_CLAUSES: ReadonlySet<StatementKind> = new Set(['elif', 'else']);
const TRY_CLAUSES: ReadonlySet<StatementKind> = new Set(['except', 'else', 'finally']);

/**
 * Does a `try` statement leave the function on every path? Review finding 1: reading `try` as
 * "falls through" is not a conservative lower bound once the rule is a DIFFERENCE, because a
 * patch that WRAPS exiting code in `try/except` flips the answer and the wrapped function reads
 * as newly falling off its end. The real rule:
 *   - a `finally` suite that exits leaves the statement whatever the body did (it runs last and
 *     its `return`/`raise` wins, even over one propagating out of the try);
 *   - otherwise the try-suite must exit AND every `except` must exit; an `else` suite runs only
 *     when the try-suite completed, so if the try-suite exits the `else` is unreachable, and if
 *     the rule needed the `else` the try-suite did not exit and the answer is already false.
 * A bare `try` with no `except` and no exiting `finally` can still propagate, so it is false.
 */
function tryExits(chain: readonly SuiteNode[]): boolean {
  const head = chain[0]!;
  const clauses = chain.slice(1);
  if (clauses.some((c) => c.st.kind === 'finally' && branchExits(c))) return true;
  const excepts = clauses.filter((c) => c.st.kind === 'except');
  if (excepts.length === 0) return false;
  return branchExits(head) && excepts.every(branchExits);
}

/**
 * Does a `for` / `while` leave the function? Only through its `else`: the loop body may run zero
 * times, so nothing in it is guaranteed, but the `else` suite runs exactly when the loop finished
 * without `break` — so `for … else: return x` with no `break` out of the loop always exits.
 * `while True:` with no `break` is the other case (it never finishes at all) and is handled by
 * `isEndlessLoop`.
 */
function loopExits(chain: readonly SuiteNode[]): boolean {
  const head = chain[0]!;
  if (isEndlessLoop(head.st) && !breaksOut(head)) return true;
  const alt = chain.find((c) => c.st.kind === 'else');
  return alt !== undefined && branchExits(alt) && !breaksOut(head);
}

/**
 * Does this suite leave the enclosing function on EVERY path — by `return`/`raise`, by an
 * if/elif/else chain whose every branch does, by a `with` whose body does, by a `try` whose body
 * and handlers do (or whose `finally` does), by a loop whose `else` does, or by a `while True:`
 * that no `break` leaves? Statements after the first exiting one are dead code and do not change
 * the answer. Anything still unmodelled reads as "control can reach the next statement".
 */
function suiteExits(nodes: readonly SuiteNode[]): boolean {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const kind = n.st.kind;
    if (EXIT_KINDS.has(kind)) return true;
    if (kind === 'if') {
      const { chain, next } = clauseChain(nodes, i, IF_CLAUSES);
      // without an `else` the chain can fall through with no branch taken
      if (chain[chain.length - 1]!.st.kind === 'else' && chain.every(branchExits)) return true;
      i = next - 1;
      continue;
    }
    if (kind === 'try') {
      const { chain, next } = clauseChain(nodes, i, TRY_CLAUSES);
      if (tryExits(chain)) return true;
      i = next - 1;
      continue;
    }
    if (LOOP_KINDS.has(kind)) {
      const { chain, next } = clauseChain(nodes, i, IF_CLAUSES);
      if (loopExits(chain)) return true;
      i = next - 1;
      continue;
    }
    if (kind === 'with' && branchExits(n)) return true;
  }
  return false;
}

/**
 * Can control reach the END of `block`'s body — i.e. does the function have an IMPLICIT
 * `return None` exit? `def f(): pass` yes; a body ending in `return`/`raise`, a full if/else whose
 * branches all exit, and a `while True:` no `break` leaves, no. Unmodelled constructs (`try`,
 * `for`) read as "can fall through", so the answer is only ever used as a DIFFERENCE between two
 * revisions of one function, where the unmodelled part cancels out.
 */
export function fallsOffEnd(mod: PyModule, block: Block): boolean {
  if (block.kind !== 'def') return false;
  const header = mod.statements[block.statementIndex];
  if (header !== undefined && inlineExits(header)) return false; // `def f(): return 1`
  return !suiteExits(suiteOf(mod, block));
}

/**
 * Every statement kind that appears directly inside `block` (nested def/class bodies excluded).
 *
 * Review finding 1: `fallsOffEnd` is only sound as a DIFFERENCE between two revisions when the
 * constructs it does not model are in BOTH of them. A patch that introduces a construct the
 * analysis reads differently breaks that argument by itself, so the caller skips the rule when
 * the after revision of a function contains a kind its before revision did not. That is the
 * precondition of the difference argument, stated as code.
 */
export function statementKinds(mod: PyModule, block: Block): Set<StatementKind> {
  const out = new Set<StatementKind>();
  for (const st of mod.statements) {
    if (st.blockIndex !== block.index) continue;
    out.add(st.kind);
    for (const part of inlineParts(st)) out.add(classify(part).kind);
  }
  return out;
}

/**
 * Methods of the standard containers that mutate their receiver IN PLACE (list, set, dict,
 * collections.deque). The structural property is "the object the caller passed changes"; every
 * name here is a documented in-place mutator of a builtin container and none of them has a
 * non-mutating meaning on one, so the set is a property of the language, not a tuned list.
 */
const MUTATING_METHODS: ReadonlySet<string> = new Set([
  'append', 'appendleft', 'extend', 'extendleft', 'insert', 'remove', 'pop', 'popitem', 'clear', 'sort', 'reverse', 'rotate',
  'add', 'discard', 'update', 'setdefault', 'difference_update', 'intersection_update', 'symmetric_difference_update',
]);

/**
 * Parameters of `block` whose object the body mutates in place, so the CALLER sees the change:
 * an in-place method call (`values.remove(mid)`), an item or attribute assignment (`xs[i] = v`,
 * `o.field = v`) or `del xs[i]`. Deliberately excluded, so the result is a lower bound rather
 * than a guess:
 *   - `*args` / `**kwargs`, which Python rebuilds per call — mutating them cannot reach the caller;
 *   - the receiver of a method (the first parameter of a `def` inside a `class`), whose attribute
 *     assignment is ordinary object state, not an argument mutation;
 *   - a parameter the body REBINDS anywhere (`values = list(values)`), after which the name need
 *     not stand for the caller's object;
 *   - anything inside a nested `def`.
 */
export function mutatedParameters(mod: PyModule, block: Block): string[] {
  return mutatedParameterDetails(mod, block)
    .filter((m) => m.exempt === null)
    .map((m) => m.name);
}

/** Why a mutation of a parameter is ordinary rather than a change the caller did not ask for. */
export type MutationExemption = 'memoisation' | 'returns_receiver';

export interface ParameterMutation {
  name: string;
  /** what the body did: an in-place method, an item/attribute write, or `del` */
  via: 'method' | 'subscript' | 'attribute' | 'del';
  /** set when the shape is a documented, intended in-place idiom (review finding 2) */
  exempt: MutationExemption | null;
}

/**
 * Is `name` (or an element/attribute of it) handed back by a `return` of this block?
 * `ReturnFact.expr` is the source text of the returned expression, so the test is whether the
 * parameter HEADS it: `return values`, `return values[-1]`, `return values[0].x` — but not
 * `return len(values)`, which hands back a number and keeps the mutation to itself.
 */
function returnsParameter(mod: PyModule, block: Block, name: string): boolean {
  const fn = mod.functions.find((f) => f.blockIndex === block.index);
  const head = new RegExp(`^${name}\\s*(?:$|[[.])`);
  return (fn?.returns ?? []).some((r) => r.expr !== null && head.test(r.expr.trim()));
}

/**
 * Every parameter mutation the body performs, with the intended-idiom exemptions of review
 * finding 2 marked rather than silently dropped (a caller that wants the raw facts can read
 * them; `mutatedParameters` returns only the unexempted names).
 *
 * The two exemptions, both structural:
 *   - `memoisation`: the body writes a subscript of the parameter and READS a subscript of the
 *     same parameter somewhere in the body. `if k not in d: d[k] = 0` and every cache-fill is
 *     this shape; a caller passing a dict to be filled is the point of the call.
 *   - `returns_receiver`: `sort()` / `reverse()` (the two in-place methods with no return value,
 *     so the only way to use them is on an object the caller keeps) on a parameter the function
 *     then RETURNS, itself or an element of it. `values.sort(); return values[-1]` is an
 *     ordinary in-place API, not a change smuggled past the caller.
 */
export function mutatedParameterDetails(mod: PyModule, block: Block): ParameterMutation[] {
  if (block.kind !== 'def') return [];
  const parent = block.parent === null ? undefined : mod.blocks[block.parent];
  const receiver = parent !== undefined && parent.kind === 'class' ? block.params[0]?.name : undefined;
  const names = new Set(block.params.filter((p) => p.star === '' && p.name !== receiver).map((p) => p.name));
  const body = mod.statements.filter((s) => s.blockIndex === block.index);
  for (const st of body) for (const n of st.binds) names.delete(n);
  if (names.size === 0) return [];

  const mutated = new Map<string, ParameterMutation>();
  const add = (name: string, via: ParameterMutation['via'], exempt: MutationExemption | null): void => {
    const held = mutated.get(name);
    // an unexempted mutation always wins: one bad write is enough, however many good ones there are
    if (held === undefined || (held.exempt !== null && exempt === null)) mutated.set(name, { name, via, exempt });
  };
  /** does any statement READ `name[...]` outside an assignment target (the memoisation half)? */
  const readsSubscript = (name: string): boolean =>
    body.some((st) => {
      const toks = st.tokens;
      const targets = st.kind === 'assign' ? assignTargetSpans(toks) : [];
      const inTarget = new Set(targets.flatMap((span) => span.map((t) => t.start)));
      for (let k = 0; k + 1 < toks.length; k++) {
        const t = toks[k]!;
        if (t.type !== 'NAME' || t.text !== name || !isOp(toks[k + 1], '[')) continue;
        if (isOp(toks[k - 1], '.')) continue;
        if (!inTarget.has(t.start)) return true;
      }
      return false;
    });
  const addSubscriptTarget = (span: readonly Token[]): void => {
    const head = span[0];
    if (head === undefined || head.type !== 'NAME' || !names.has(head.text) || !isOp(span[1], '[')) return;
    add(head.text, 'subscript', readsSubscript(head.text) ? 'memoisation' : null);
  };
  for (const st of body) {
    for (const a of st.attrAssigns) if (names.has(a.receiver)) add(a.receiver, 'attribute', null);
    const toks = st.tokens;
    for (let k = 0; k + 3 < toks.length; k++) {
      const recv = toks[k]!;
      if (recv.type !== 'NAME' || !names.has(recv.text)) continue;
      if (isOp(toks[k - 1], '.')) continue; // `holder.values.remove(...)` is not the parameter `values`
      const method = toks[k + 2];
      if (!isOp(toks[k + 1], '.') || method === undefined || method.type !== 'NAME' || !MUTATING_METHODS.has(method.text) || !isOp(toks[k + 3], '(')) continue;
      const ordering = method.text === 'sort' || method.text === 'reverse';
      add(recv.text, 'method', ordering && returnsParameter(mod, block, recv.text) ? 'returns_receiver' : null);
    }
    if (st.kind === 'assign') for (const span of assignTargetSpans(toks)) addSubscriptTarget(span);
    if (st.kind === 'augassign') {
      const op = findTopLevel(toks, (t) => t.type === 'OP' && AUG_OPS.has(t.text));
      if (op > 0) addSubscriptTarget(toks.slice(0, op));
    }
    if (st.keyword === 'del') addSubscriptTarget(toks.slice(1));
  }
  return [...mutated.values()];
}

/** Dotted name of a block inside its module (`Outer.method`): the identity that matches one function across two revisions of a file. */
export function qualifiedName(mod: PyModule, block: Block): string {
  const parts: string[] = [];
  let b: Block | undefined = block;
  while (b !== undefined) {
    parts.unshift(b.name);
    b = b.parent === null ? undefined : mod.blocks[b.parent];
  }
  return parts.join('.');
}

// ---------------------------------------------------------------------------------------
// Guard clauses and where the patch put them (OOS iteration 3, item 1: the late-guard signal)
// ---------------------------------------------------------------------------------------

/**
 * The statements that leave a suite at once, so an `if` whose body is only these is an early-exit
 * GUARD CLAUSE rather than an ordinary branch.
 */
const GUARD_EXIT_KINDS: ReadonlySet<StatementKind> = new Set(['return', 'raise', 'break', 'continue']);

/** A guard clause of a function: an `if` with no `elif`/`else` whose body leaves the suite on every path. */
export interface GuardClause {
  /** first physical line of the `if` header */
  line: number;
  /** the condition source, exactly as the header spells it (`not ordered`, `cost > self.capacity or …`) */
  test: string;
  /**
   * The operand paths the condition reads: a dotted chain that is not a call (`ordered`, `cost`,
   * `self.capacity`, `hare.successor.successor`), builtins excluded. The ROOT of each is what the
   * placement questions below are answered on, since reading `hare.successor` reads `hare` and
   * rebinding `hare` invalidates every chain under it.
   */
  operands: string[];
  /** roots of `operands`, de-duplicated */
  roots: string[];
  /**
   * Sibling-index chain from the function body down to this clause, the declarations of each
   * suite (docstring, nested def/class) not counted. It is the clause's IDENTITY across two revisions of a function: a patch that
   * only rewrites a condition leaves every path alone, while one that inserts a statement shifts
   * the paths after it (guard.ts `newlyLateGuards` uses that to tell an edit from an insertion).
   */
  path: number[];
  /** position among its sibling statements, declarations not counted (`isDeclaration`); 0 = the top of the block */
  position: number;
  /** how many non-declaration statements its own suite holds — with `path`, the check that the suite did not change shape */
  siblings: number;
  /** siblings BEFORE it that read an operand (outside an assignment target) */
  readsBefore: number;
  /** siblings BEFORE it that bind an operand, assign an attribute of one, or mutate one in place */
  bindsBefore: number;
  /** the same two counts per operand ROOT, so a caller can ask about the operands a patch ADDED and no others */
  perRoot: Record<string, { reads: number; binds: number }>;
}

/** The chain of `.NAME` after `k`, stopping before a call; `null` when the token is not a readable operand head. */
function operandPathAt(tokens: readonly Token[], k: number): { path: string; next: number } | null {
  const head = tokens[k];
  if (head === undefined || head.type !== 'NAME' || isKeyword(head.text)) return null;
  if (isOp(tokens[k - 1], '.')) return null;
  if (isOp(tokens[k + 1], '(')) return null; // `len(...)` — the callee is not an operand, its arguments are
  const parts = [head.text];
  let j = k + 1;
  while (isOp(tokens[j], '.') && tokens[j + 1]?.type === 'NAME') {
    // `a.b(` — the chain ends at the receiver `a`; the method call is not an operand
    if (isOp(tokens[j + 2], '(')) break;
    parts.push(tokens[j + 1]!.text);
    j += 2;
  }
  return { path: parts.join('.'), next: j };
}

const BUILTIN_SET: ReadonlySet<string> = new Set(PY_BUILTINS);

/** Operand paths a condition reads (`len(ordered) % 2` → `ordered`; `self.tokens >= cost` → `self.tokens`, `cost`). */
export function conditionOperands(tokens: readonly Token[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const p = operandPathAt(tokens, k);
    if (p === null) continue;
    k = p.next - 1;
    const root = p.path.split('.')[0] ?? p.path;
    if (BUILTIN_SET.has(root)) continue;
    out.push(p.path);
  }
  return uniq(out);
}

/** A statement and every statement of the suite under it (the whole subtree a sibling owns). */
function subtreeStatements(node: SuiteNode): Statement[] {
  const out: Statement[] = [node.st];
  for (const child of node.body) out.push(...subtreeStatements(child));
  return out;
}

/** Does `st` READ `root` — an occurrence as a name that is not (only) a binding target? */
function readsName(st: Statement, root: string): boolean {
  const toks = st.tokens;
  const skip = new Set<number>();
  if (st.kind === 'assign') for (const span of assignTargetSpans(toks)) for (const t of span) skip.add(t.start);
  if (st.kind === 'augassign') {
    const op = findTopLevel(toks, (t) => t.type === 'OP' && AUG_OPS.has(t.text));
    if (op > 0) for (const t of toks.slice(0, op)) skip.add(t.start);
  }
  if (st.kind === 'for') {
    const start = isKw(toks[0], 'async') ? 2 : 1;
    const inIdx = findTopLevel(toks, (t) => isKw(t, 'in'), start);
    if (inIdx > start) for (const t of toks.slice(start, inIdx)) skip.add(t.start);
  }
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    if (t.type !== 'NAME' || t.text !== root) continue;
    if (isOp(toks[k - 1], '.')) continue;
    if (skip.has(t.start)) continue;
    return true;
  }
  return false;
}

/** Does `st` BIND `root`, assign an attribute of it, or mutate it in place with one of the container methods? */
function bindsName(st: Statement, root: string): boolean {
  if (st.binds.includes(root)) return true;
  if (st.attrAssigns.some((a) => a.receiver === root)) return true;
  const toks = st.tokens;
  for (let k = 0; k + 3 < toks.length; k++) {
    const recv = toks[k]!;
    if (recv.type !== 'NAME' || recv.text !== root || isOp(toks[k - 1], '.')) continue;
    const method = toks[k + 2];
    if (isOp(toks[k + 1], '.') && method !== undefined && method.type === 'NAME' && MUTATING_METHODS.has(method.text) && isOp(toks[k + 3], '(')) return true;
  }
  return false;
}

/** A leading `"""docstring"""` of a suite: it binds nothing, reads nothing, and is not a position. */
function isDocstring(st: Statement): boolean {
  return st.kind === 'expr' && st.tokens.length === 1 && st.tokens[0]?.type === 'STRING';
}

/**
 * Statements a guard clause's POSITION is not counted against: a docstring, and a nested `def` /
 * `class` (with its decorators). A declaration runs nothing — its body executes when it is called,
 * not where it stands — so a guard behind one is not behind any USE of its operands, and hoisting
 * the guard above it would change nothing. Measured: the one false positive of the late-guard rule
 * over iteration 1's 46 applied committed patches was `hunk_merge`, whose LLM patch defines a
 * local `within()` helper and then guards on `left` / `right` — a guard at the top of its block
 * with a helper in front of it (experiments/results/llm-jev-iter1.md §4.2, run
 * `20260922-115414-emklxk3j`).
 */
function isDeclaration(st: Statement): boolean {
  return isDocstring(st) || st.kind === 'def' || st.kind === 'class' || st.kind === 'decorator';
}

/** Is this `if` a guard clause — no `elif`/`else` beside it, and a body that leaves the suite on every path? */
function isGuardClause(nodes: readonly SuiteNode[], i: number): boolean {
  const n = nodes[i]!;
  if (n.st.kind !== 'if') return false;
  if (IF_CLAUSES.has(nodes[i + 1]?.st.kind ?? 'other')) return false;
  const inline = inlineParts(n.st);
  if (inline.length > 0) return inline.every((p) => GUARD_EXIT_KINDS.has(classify(p).kind));
  const body = n.body;
  if (body.length === 0) return false;
  const last = body[body.length - 1]!;
  return GUARD_EXIT_KINDS.has(last.st.kind) || branchExits(last);
}

/** Walk one suite level, recording its guard clauses, then recurse into the suites under it. */
function collectGuards(nodes: readonly SuiteNode[], prefix: readonly number[], out: GuardClause[]): void {
  const siblings = nodes.filter((n) => !isDeclaration(n.st));
  siblings.forEach((n, i) => {
    if (isGuardClause(siblings, i) && n.st.colonIndex !== null) {
      const operands = conditionOperands(n.st.tokens.slice(1, n.st.colonIndex));
      const roots = uniq(operands.map((p) => p.split('.')[0] ?? p));
      const priors = siblings.slice(0, i).map(subtreeStatements);
      const perRoot: Record<string, { reads: number; binds: number }> = {};
      for (const r of roots) {
        perRoot[r] = {
          reads: priors.filter((sts) => sts.some((s) => readsName(s, r))).length,
          binds: priors.filter((sts) => sts.some((s) => bindsName(s, r))).length,
        };
      }
      out.push({
        line: n.st.startLine,
        test: renderTokens(n.st.tokens.slice(1, n.st.colonIndex)),
        operands,
        roots,
        path: [...prefix, i],
        position: i,
        siblings: siblings.length,
        readsBefore: priors.filter((sts) => roots.some((r) => sts.some((s) => readsName(s, r)))).length,
        bindsBefore: priors.filter((sts) => roots.some((r) => sts.some((s) => bindsName(s, r)))).length,
        perRoot,
      });
    }
    collectGuards(n.body, [...prefix, i], out);
  });
}

/**
 * Every guard clause directly inside `block` (a nested `def`'s own guards belong to that block,
 * since `mod.statements` keys them to it), with the facts that say WHERE the patch put it.
 */
export function guardClauses(mod: PyModule, block: Block): GuardClause[] {
  if (block.kind !== 'def') return [];
  const out: GuardClause[] = [];
  collectGuards(suiteOf(mod, block), [], out);
  return out;
}

/** The clause's placement counts over a subset of its operand roots (all of them by default). */
export function guardPlacement(g: GuardClause, roots?: readonly string[]): { reads: number; binds: number } {
  if (roots === undefined) return { reads: g.readsBefore, binds: g.bindsBefore };
  let reads = 0;
  let binds = 0;
  for (const r of roots) {
    const c = g.perRoot[r];
    if (c === undefined) continue;
    reads = Math.max(reads, c.reads);
    binds = Math.max(binds, c.binds);
  }
  return { reads, binds };
}

/**
 * Is this guard clause LATE — placed behind statements it should have stood in front of?
 *
 * Two shapes, both differences of POSITION rather than thresholds (OOS iteration 3, item 1; the
 * evidence is the two overfits of experiments/results/llm-jev-iter1.md §4.2 and §5 measured
 * against their own golds, which are THE SAME GUARD at the top of the block):
 *
 *   (a) a sibling BEFORE the guard already READ one of its operands, so the guard cannot protect
 *       the code it sits behind. `stats` inserted `if not ordered: raise ValueError(…)` after
 *       `mid = len(ordered) // 2` and `if len(ordered) % 2: return float(ordered[mid])`; the gold
 *       inserts `if not values: raise ValueError(…)` as the FIRST statement of `median`.
 *       `token_bucket` added `cost > self.capacity` as a disjunct of `if self.refill_per_second
 *       <= 0.0:` — behind `if self.tokens >= cost: return 0.0`, which reads `cost` — where the gold
 *       inserts `if cost > self.capacity: return None` at the top of `wait_for`.
 *   (b) `hoistable`: no sibling before it BINDS or mutates any of its operands, so the guard could
 *       stand at the top of the block unchanged and its position is arbitrary. Only offered for a
 *       guard the patch INSERTED: a patch that rewrites the condition of a guard already standing
 *       there did not choose the position at all, and on the gold sweep (`possible_change`'s
 *       `total < 0 or not coins`, `account`'s `amount > self.balance`, `csv_schema`'s
 *       `len(row) != len(schema.columns)`) shape (b) is exactly what a condition edit looks like.
 *
 * A guard already at the top of its block (`position === 0`) is never late: that is where the golds
 * put theirs. `x = compute()` followed by `if x is None: return` is not late either — the operand is
 * produced by the statement in front of it, so (a) is false and (b) is false.
 */
export function isLateGuard(g: GuardClause, opts: { roots?: readonly string[]; hoistable?: boolean } = {}): boolean {
  if (g.position === 0) return false;
  const roots = opts.roots ?? g.roots;
  // a condition over nothing but literals and builtins (`if True:`) has no operand to be placed
  // relative to, so its position says nothing and it is never late
  if (roots.length === 0) return false;
  const p = guardPlacement(g, roots);
  return p.reads > 0 || ((opts.hoistable ?? true) && p.binds === 0);
}
