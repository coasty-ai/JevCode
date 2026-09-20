/**
 * Wrap-expression templates on the current line (TBar FP4.1 / FP12 / FP13.2; QuixBugs `lis`
 * and `max_sublist_sum` are `max(...)` wraps): the assignment's right-hand side or the return
 * expression is wrapped in `max(0, e)`, `max(<target>, e)`, `min(e, <n>)`, `abs(e)`, `e ** 2`,
 * `e[k:]`, `(e)`, `list(e)`, and single identifiers inside it get the same treatment.
 */
import type { Draft, TemplateContext } from './common.js';
import { FAMILY_PRIOR, isBareLiteral, isName, isOp, lineDraft, lineShape, localityFactor, sliceBody, spliceBody, uniq } from './common.js';

interface Wrap {
  text: string;
  op: string;
  p: number;
}

export function wrapDrafts(ctx: TemplateContext): Draft[] {
  if (ctx.site.kind !== 'replace') return [];
  const shape = lineShape(ctx);
  if (shape.kind !== 'assign' && shape.kind !== 'return' && shape.kind !== 'condition') return [];
  if (isBareLiteral(ctx, shape.from, shape.to)) return [];
  const base = FAMILY_PRIOR.wrap;
  const e = sliceBody(ctx, shape.from, shape.to);
  const atomic = shape.to - shape.from === 1 || (isOp(ctx.lineTokens[shape.from], '(') && ctx.lineTokens[shape.to - 1]?.text === ')');
  const paren = atomic ? e : `(${e})`;
  const target = shape.kind === 'assign' && shape.targetTo - shape.targetFrom === 1 && isName(ctx.lineTokens[shape.targetFrom]) ? ctx.lineTokens[shape.targetFrom]!.text : null;
  const wraps: Wrap[] = [];
  const numeric = uniq([...ctx.names.counters, ...ctx.names.params]).filter((x) => x !== target && ctx.nearby.has(x));
  const seqs = ctx.names.collections.filter((x) => ctx.nearby.has(x));
  const numLits = ctx.opts.testLiterals.filter((l) => /^-?\d+(\.\d+)?$/.test(l)).slice(0, 2);

  if (shape.kind !== 'condition') {
    wraps.push({ text: `max(0, ${e})`, op: 'wrap_max_zero', p: 1 });
    if (target !== null) wraps.push({ text: `max(${target}, ${e})`, op: 'wrap_max_target', p: 1 }, { text: `min(${target}, ${e})`, op: 'wrap_min_target', p: 0.9 });
    for (const x of numeric) wraps.push({ text: `max(${x}, ${e})`, op: 'wrap_max_name', p: 0.8 * localityFactor(ctx, x) }, { text: `min(${e}, ${x})`, op: 'wrap_min_name', p: 0.8 * localityFactor(ctx, x) });
    for (const q of seqs) wraps.push({ text: `min(${e}, len(${q}))`, op: 'wrap_min_len', p: 0.7 }, { text: `min(${e}, len(${q}) - 1)`, op: 'wrap_min_len', p: 0.6 });
    for (const l of numLits) wraps.push({ text: `min(${e}, ${l})`, op: 'wrap_min_literal', p: 0.6 }, { text: `max(${l}, ${e})`, op: 'wrap_max_literal', p: 0.6 });
    wraps.push(
      { text: `abs(${e})`, op: 'wrap_abs', p: 0.7 },
      { text: `${paren} ** 2`, op: 'wrap_square', p: 0.6 },
      { text: `list(${e})`, op: 'wrap_list', p: 0.6 },
      { text: `sorted(${e})`, op: 'wrap_sorted', p: 0.5 },
      { text: `len(${e})`, op: 'wrap_len', p: 0.5 },
      { text: `${paren}[1:]`, op: 'wrap_slice_tail', p: 0.6 },
      { text: `${paren}[:-1]`, op: 'wrap_slice_init', p: 0.5 },
      { text: `str(${e})`, op: 'wrap_str', p: 0.4 },
      { text: `int(${e})`, op: 'wrap_int', p: 0.4 },
    );
    for (const k of ctx.names.indices.filter((x) => ctx.nearby.has(x))) wraps.push({ text: `${paren}[${k}:]`, op: 'wrap_slice_from', p: 0.5 });
    if (!atomic) wraps.push({ text: `(${e})`, op: 'wrap_paren', p: 0.4 });
    if (shape.kind === 'return') {
      wraps.push({ text: `not ${paren}`, op: 'wrap_not', p: 0.5 });
      for (const x of ctx.names.visible.filter((v) => ctx.nearby.has(v) && v !== e)) wraps.push({ text: `${e} or not ${x}`, op: 'wrap_or_not', p: 0.5 }, { text: `${e} or ${x}`, op: 'wrap_or', p: 0.45 }, { text: `${e} and ${x}`, op: 'wrap_and', p: 0.45 });
    }
  } else {
    wraps.push({ text: `not (${e})`, op: 'wrap_not', p: 0.5 });
  }

  const out: Draft[] = [];
  for (const w of wraps) out.push(...lineDraft(ctx, spliceBody(ctx, shape.from, shape.to, w.text), w.op, base * w.p));

  // single identifiers inside the expression: `approx` -> `approx ** 2`, `x` -> `abs(x)`, `s` -> `s[1:]`
  const visible = new Set(ctx.names.visible);
  for (let k = shape.from; k < shape.to; k++) {
    const t = ctx.lineTokens[k]!;
    if (!isName(t) || !visible.has(t.text) || isOp(ctx.lineTokens[k - 1], '.')) continue;
    const next = ctx.lineTokens[k + 1];
    if (isOp(next, '(') || isOp(next, '.') || isOp(next, '[')) continue;
    if (shape.to - shape.from === 1) continue; // the whole-expression wraps above already cover it
    const idWraps: Wrap[] = [
      { text: `abs(${t.text})`, op: 'wrap_ident_abs', p: 0.55 },
      { text: `${t.text} ** 2`, op: 'wrap_ident_square', p: 0.5 },
      { text: `${t.text}[1:]`, op: 'wrap_ident_slice', p: 0.45 },
    ];
    if (ctx.names.collections.includes(t.text)) idWraps.push({ text: `len(${t.text})`, op: 'wrap_ident_len', p: 0.55 });
    for (const w of idWraps) out.push(...lineDraft(ctx, spliceBody(ctx, k, k + 1, w.text), w.op, base * w.p));
  }
  return out;
}
