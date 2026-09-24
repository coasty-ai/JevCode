/**
 * What the operators may draw on at a site: in-scope names by role (values, callables,
 * attributes), literal pools (function, file, failing tests) and comparison expressions from
 * sibling statements. Built once per `enumerate` call from the frozen `Site` + `EnumerateOptions`
 * so every operator stays a pure function of (tokens, context).
 */
import { isKeyword } from '../py/tokenize.js';
import type { PyModule, Statement } from '../py/structure.js';
import { functionAt } from '../py/structure.js';
import type { EnumerateOptions, Site } from '../types.js';
import { RELATIONAL_OPS, binaryOps, isIdent, primaryEnd, primaryStart, render, toToks } from './tokens.js';
import type { Tok } from './tokens.js';

export interface MutationContext {
  /** identifiers usable as values (params, locals, class attrs via self), task identifiers first */
  valueNames: readonly string[];
  /** identifiers usable as call targets (functions defined/imported in the file, common builtins) */
  callNames: readonly string[];
  /** attribute names seen in the file (`.successors` -> `successors`) plus common container methods */
  attrNames: readonly string[];
  /**
   * The subset of `attrNames` known to be callable: methods of the file's classes, the tails of
   * dotted callees (`self.history.append` -> `append`) and the common container methods. Used to
   * put role-compatible names first when the anchor is a method call (`dst.withdraw(x)` ->
   * `dst.deposit(x)`) and last when it is a plain attribute read.
   */
  methodNames: readonly string[];
  /** integer literals (as source text): defaults, function, file, tests */
  intLiterals: readonly string[];
  /** float literals (as source text): function, file, tests; `500.0` -> `50.0` style constant bugs */
  floatLiterals: readonly string[];
  /** string literals with quotes: function, file, tests */
  strLiterals: readonly string[];
  /** comparison expressions found in other lines of the enclosing block, rendered (`x is None`, `k < n`) */
  comparisons: readonly string[];
}

/** Names that commonly get confused with one another; substitution tries these first. */
const FAMILIES: readonly (readonly string[])[] = [
  ['i', 'j', 'k'],
  ['a', 'b', 'c'],
  ['x', 'y', 'z'],
  ['lo', 'hi'],
  ['low', 'high'],
  ['left', 'right'],
  ['start', 'end'],
  ['begin', 'end'],
  ['first', 'last'],
  ['min', 'max'],
  ['row', 'col'],
  ['src', 'dst'],
  ['source', 'target'],
  ['prev', 'next'],
  ['node', 'nextnode', 'prevnode'],
  ['u', 'v'],
  ['n', 'm'],
  ['key', 'value'],
  ['head', 'tail'],
  ['any', 'all'],
  ['append', 'add', 'extend', 'insert'],
  ['pop', 'popleft', 'remove'],
  ['incoming_nodes', 'outgoing_nodes'],
  ['successor', 'successors', 'predecessor', 'predecessors'],
];

/** Builtins a wrong call target is most often confused with; substitution keeps builtins with builtins. */
export const COMMON_CALLS: readonly string[] = ['len', 'max', 'min', 'abs', 'any', 'all', 'sum', 'sorted', 'reversed', 'list', 'set', 'tuple', 'dict', 'str', 'int', 'range', 'enumerate', 'zip'];
const COMMON_METHODS: readonly string[] = ['append', 'add', 'extend', 'insert', 'remove', 'pop', 'popleft', 'appendleft', 'update', 'discard', 'keys', 'values', 'items', 'get'];

function uniq(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

/** Sibling names of `name` in the family table (never `name` itself). */
export function familyOf(name: string): string[] {
  const out: string[] = [];
  for (const fam of FAMILIES) if (fam.includes(name)) out.push(...fam.filter((n) => n !== name));
  return uniq(out);
}

/** Shared stem heuristic: `weight_by_edge`/`weight_by_node`, `num_less`/`num_lessoreq`, `node`/`nextnode`. */
export function sharesStem(a: string, b: string): boolean {
  if (a === b) return false;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la.includes(lb) || lb.includes(la)) return Math.min(la.length, lb.length) >= 2;
  const pa = la.split('_');
  const pb = lb.split('_');
  if (pa.length > 1 && pb.length > 1 && (pa[0] === pb[0] || pa[pa.length - 1] === pb[pb.length - 1])) return true;
  return false;
}

/**
 * Order the value pool for substituting `name`: family names, names sharing a stem, then the
 * rest in scope order. Deterministic and never contains `name`.
 */
export function substitutesFor(name: string, pool: readonly string[]): string[] {
  const fam = familyOf(name).filter((n) => pool.includes(n));
  const stem = pool.filter((n) => !fam.includes(n) && sharesStem(name, n));
  const rest = pool.filter((n) => n !== name && !fam.includes(n) && !stem.includes(n));
  return [...fam, ...stem, ...rest];
}

/**
 * Order the callable pool for substituting the call head `name`: family/stem names first, then
 * names of the same role (builtin for a builtin head, user-defined for a user-defined head), then
 * the rest. Without this a file with a dozen functions pushes `sum` past the per-anchor cap when
 * the anchor is `len`.
 */
export function substitutesForCall(name: string, pool: readonly string[]): string[] {
  const builtin = COMMON_CALLS.includes(name);
  const ordered = substitutesFor(name, pool);
  const same = ordered.filter((n) => COMMON_CALLS.includes(n) === builtin);
  const other = ordered.filter((n) => COMMON_CALLS.includes(n) !== builtin);
  return [...same, ...other];
}

/** Order the attribute pool for `.name`: when the attribute is called, method-like names first, otherwise last. */
export function substitutesForAttr(name: string, ctx: MutationContext, called: boolean): string[] {
  const ordered = substitutesFor(name, ctx.attrNames);
  const methods = new Set(ctx.methodNames);
  const like = ordered.filter((n) => methods.has(n) === called);
  const unlike = ordered.filter((n) => methods.has(n) !== called);
  return [...like, ...unlike];
}

function isIntLiteral(s: string): boolean {
  return /^-?\d+$/.test(s);
}
function isFloatLiteral(s: string): boolean {
  return /^-?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s) || /^-?\d+[eE][+-]?\d+$/.test(s);
}
function isStrLiteral(s: string): boolean {
  return /^(?:[rbuf]{0,2})(['"]).*\1$/s.test(s) && s.length <= 40;
}

/** Comparison sub-expressions (`left op right`) of a statement, rendered; used for condition extension. */
function comparisonsIn(st: Statement): string[] {
  const toks: Tok[] = toToks(st.tokens);
  const ops = binaryOps(toks, new Set([...RELATIONAL_OPS, 'is', 'is not', 'in', 'not in']));
  const out: string[] = [];
  for (const op of ops) {
    const s = primaryStart(toks, op.start);
    const e = primaryEnd(toks, op.end);
    if (s < 0 || e < 0) continue;
    out.push(render(toks.slice(s, e)));
  }
  return out;
}

function functionNames(mod: PyModule): string[] {
  return mod.blocks.filter((b) => b.kind === 'def').map((b) => b.name);
}

export function buildContext(site: Site, opts: EnumerateOptions): MutationContext {
  const mod = site.file.mod;
  const scope = site.scope;
  const fn = functionAt(mod, site.line);
  const fnNames = new Set(functionNames(mod));

  // values: task identifiers that are in scope first (they were named by the failing test or the
  // task text), then params and locals in binding order, then module-level non-function names
  const inScope = new Set(scope.all);
  const taskFirst = opts.taskIdentifiers.filter((n) => inScope.has(n) && !fnNames.has(n) && !isKeyword(n));
  const moduleValues = scope.module.filter((n) => !fnNames.has(n));
  const valueNames = uniq([...taskFirst, ...scope.params, ...scope.locals, ...moduleValues]).filter((n) => !isKeyword(n) && !scope.builtins.includes(n));

  // callables: functions of the file, imported names, callees the file already uses, common builtins
  const fileCallees = mod.functions.flatMap((f) => f.calls.map((c) => c.callee)).filter((c) => !c.includes('.'));
  const callNames = uniq([...functionNames(mod), ...scope.imports.filter((n) => n !== '*'), ...fileCallees, ...COMMON_CALLS]).filter((n) => !isKeyword(n));

  // attributes: everything accessed or assigned as `.name` anywhere in the file, class attrs, methods
  // of the file's classes (a wrong method name is called on another object: `dst.withdraw` for
  // `dst.deposit`), the tails of dotted callees, container methods
  const fileAttrs = mod.functions.flatMap((f) => f.attributes.map((a) => a.attr));
  const assignedAttrs = mod.statements.flatMap((s) => s.attrAssigns.map((a) => a.attr));
  const classIdx = new Set(mod.blocks.filter((b) => b.kind === 'class').map((b) => b.index));
  const classMethods = mod.blocks.filter((b) => b.kind === 'def' && b.parent !== null && classIdx.has(b.parent)).map((b) => b.name);
  const calleeTails = mod.functions.flatMap((f) => f.calls.map((c) => c.callee)).filter((c) => c.includes('.')).map((c) => c.slice(c.lastIndexOf('.') + 1)).filter((c) => c !== '' && !isKeyword(c));
  const methodNames = uniq([...classMethods, ...calleeTails, ...COMMON_METHODS]);
  const attrNames = uniq([...fileAttrs, ...assignedAttrs, ...scope.classAttrs, ...methodNames]);

  // literals: small defaults, then the function's own, then the file's, then the failing tests'
  const fnInts = (fn?.literals.numbers ?? []).filter(isIntLiteral);
  const fileInts = mod.functions.flatMap((f) => f.literals.numbers).filter(isIntLiteral);
  const testInts = opts.testLiterals.filter(isIntLiteral);
  const intLiterals = uniq(['0', '1', '2', '-1', ...fnInts, ...testInts, ...fileInts]).filter((x) => x.length <= 6).slice(0, 10);
  const fnFloats = (fn?.literals.numbers ?? []).filter(isFloatLiteral);
  const fileFloats = mod.functions.flatMap((f) => f.literals.numbers).filter(isFloatLiteral);
  const testFloats = opts.testLiterals.filter(isFloatLiteral);
  const floatLiterals = uniq([...fnFloats, ...testFloats, ...fileFloats]).filter((x) => x.length <= 10).slice(0, 8);
  const fnStrs = fn?.literals.strings ?? [];
  const fileStrs = mod.functions.flatMap((f) => f.literals.strings);
  const testStrs = opts.testLiterals.filter(isStrLiteral);
  const strLiterals = uniq([...fnStrs, ...testStrs, ...fileStrs, "''"]).slice(0, 8);

  // comparisons from the other statements of the enclosing block (or the module when top-level)
  const comparisons: string[] = [];
  if (site.block !== null) {
    for (const st of mod.statements) {
      if (st.startLine < site.block.startLine || st.endLine > site.block.endLine) continue;
      if (st.startLine <= site.line && site.line <= st.endLine) continue;
      comparisons.push(...comparisonsIn(st));
    }
  }
  return { valueNames, callNames, attrNames, methodNames, intLiterals, floatLiterals, strLiterals, comparisons: uniq(comparisons).slice(0, 6) };
}

/** Plain value identifiers of a line (not attribute names, not call heads), in order, de-duplicated. */
export function lineIdentifiers(toks: readonly Tok[]): string[] {
  const out: string[] = [];
  toks.forEach((t, k) => {
    const prev = toks[k - 1];
    const next = toks[k + 1];
    if (!isIdent(t) || (prev?.type === 'OP' && prev.text === '.') || (next?.type === 'OP' && next.text === '(')) return;
    out.push(t.text);
  });
  return uniq(out);
}
