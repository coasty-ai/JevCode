/**
 * Standard-library sibling substitution for a builtin callee, the import carried along
 * (experiments/results/swebench-reach-oracle-9.md capability 5, sympy-11618: `zip(` ->
 * `zip_longest(..., fillvalue=0)` plus `from itertools import zip_longest` passes the F2P test;
 * no source substituted a callee by a name the module does not bind). The table is small and
 * generic: each entry is a drop-in callable of the same call shape (or a shape the entry states:
 * `arity`, extra keyword drafts), from a module `importLinesFor` knows. When the sibling is not
 * bound at the site the candidate carries the module-level import as an `extraEdits` insert at
 * `importInsertLine`, the way the import family's `import_insert_top` does; when it is bound
 * (already imported) the line alone is the candidate. Deterministic, at most a few lines per call.
 */
import type { LineEdit } from '../types.js';
import type { Draft, TemplateContext } from './common.js';
import { FAMILY_PRIOR, isName, isOp, lineDraft, matchClose, replaceToken, splitTopLevel } from './common.js';
import { importInsertLine, importLinesFor } from './imports.js';

export interface StdlibSibling {
  /** the sibling's bare name (also the name the import binds) */
  name: string;
  /** ordering prior (0..1) within the callee's family */
  p: number;
  /** only for calls with exactly this many positional arguments (a one-argument `round(x)` -> `floor(x)`) */
  arity?: number;
  /** keyword arguments appended as further drafts (`fillvalue=0`: the family's characteristic keyword) */
  keywords?: readonly string[];
}

/**
 * Builtin callee -> standard-library siblings. Kept to same-shape callables whose confusion is a
 * known bug class: pairing vs. padding vs. cartesian product (`zip`), mapping over tuples (`map`),
 * float-exact / product sums (`sum`), ordered / counting / defaulting dicts (`dict`), a queue for a
 * list (`list`), rounding direction (`round`). `sorted` -> `heapq.nsmallest` needs an `n` and is
 * left out on purpose (not a drop-in).
 */
export const STDLIB_SIBLINGS: Readonly<Record<string, readonly StdlibSibling[]>> = {
  zip: [
    { name: 'zip_longest', p: 1, keywords: ['fillvalue=0', 'fillvalue=None'] },
    { name: 'product', p: 0.6 },
  ],
  map: [{ name: 'starmap', p: 0.9 }],
  sum: [
    { name: 'fsum', p: 0.8 },
    { name: 'prod', p: 0.7 },
  ],
  dict: [
    { name: 'OrderedDict', p: 0.8 },
    { name: 'Counter', p: 0.7 },
    { name: 'defaultdict', p: 0.9, arity: 0, keywords: ['list', 'int', 'set'] },
  ],
  list: [{ name: 'deque', p: 0.7 }],
  round: [
    { name: 'floor', p: 0.8, arity: 1 },
    { name: 'ceil', p: 0.8, arity: 1 },
    { name: 'trunc', p: 0.6, arity: 1 },
  ],
};

/** Names bound at the site (imports, module names, locals, parameters): a sibling among them needs no import. */
function isBound(ctx: TemplateContext, name: string): boolean {
  const s = ctx.site.scope;
  return s.imports.includes(name) || s.module.includes(name) || s.locals.includes(name) || s.params.includes(name);
}

/** Body with `text` appended to the argument list of the call closing at token `close` (`, ` before it when `afterArgs`). */
function withKeyword(ctx: TemplateContext, _open: number, close: number, text: string, afterArgs: boolean): string {
  const closeTok = ctx.lineTokens[close];
  if (closeTok === undefined) return ctx.body;
  return `${ctx.body.slice(0, closeTok.start)}${afterArgs ? ', ' : ''}${text}${ctx.body.slice(closeTok.start)}`;
}

export function stdlibSiblingDrafts(ctx: TemplateContext): Draft[] {
  const { site, mod } = ctx;
  if (site.kind !== 'replace') return [];
  const out: Draft[] = [];
  const base = FAMILY_PRIOR.attribute * 0.85;
  const t = ctx.lineTokens;
  const at = importInsertLine(mod);
  // the import cannot go inside the statement span a statement-level site replaces
  const importable = !(site.endLine !== undefined && at > site.line && at <= site.endLine);
  for (let k = 0; k < t.length - 1; k++) {
    const tok = t[k]!;
    if (!isName(tok) || !isOp(t[k + 1], '(') || isOp(t[k - 1], '.')) continue;
    const siblings = STDLIB_SIBLINGS[tok.text];
    if (siblings === undefined || isBound(ctx, tok.text)) continue; // a rebound builtin is not the builtin
    const open = k + 1;
    const close = matchClose(t, open);
    if (close < 0) continue;
    const args = close === open + 1 ? [] : splitTopLevel(t, ',', open + 1, close).filter(([a, b]) => b > a);
    const positional = args.filter(([a]) => !(isName(t[a]) && isOp(t[a + 1], '=')));
    const hasKeyword = positional.length < args.length;
    for (const sib of siblings) {
      if (sib.arity !== undefined && positional.length !== sib.arity) continue;
      if (sib.name === tok.text) continue;
      const imports = isBound(ctx, sib.name) ? [] : importLinesFor(ctx, sib.name);
      if (!isBound(ctx, sib.name) && (imports.length === 0 || !importable)) continue;
      // the first choice module only: the table names one home per sibling (itertools, math, collections)
      const imp = imports[0];
      const extra: LineEdit[] = imp === undefined ? [] : [{ path: site.file.path, line: at, kind: 'insert', text: imp.text }];
      const prior = base * sib.p;
      const renamed = replaceToken(ctx, k, sib.name);
      out.push(...lineDraft(ctx, renamed, 'callee_stdlib_subst', prior, extra));
      // the family's characteristic keyword (`fillvalue=0`) or factory argument (`defaultdict(list)`);
      // the callee token precedes the closing bracket, so its offsets still hold after the append
      for (const kw of sib.keywords ?? []) {
        if (hasKeyword && !kw.includes('=')) continue;
        const appended = withKeyword(ctx, open, close, kw, kw.includes('=') && args.length > 0);
        const body = appended.slice(0, tok.start) + sib.name + appended.slice(tok.end);
        out.push(...lineDraft(ctx, body, 'callee_stdlib_subst_kw', prior * 0.9, extra));
      }
    }
  }
  return out;
}
