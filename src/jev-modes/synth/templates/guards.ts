/**
 * Guard insertion (TBar FP2 null-pointer checker, FP3 range checker; Defects4J "Missing
 * Null-Check" 12.7 %): `if <x> is None: ...`, `if not <collection>: ...`,
 * `if <idx> >= len(<seq>): ...` inserted before the guarded statement. Subjects come from the
 * guarded line first (probe-donor-and-templates item 4: placement is easy once the content is
 * known), then the parameters; bodies come from the return annotation, sibling `raise`
 * statements with the function name substituted, and the failing tests' literals.
 */
import type { Draft, TemplateContext } from './common.js';
import { FAMILY_PRIOR, attrRefsIn, boundOnLine, fragmentTokens, identifiersIn, localityFactor, returnDefaults, statementDrafts, uniq } from './common.js';
import type { StatementForms } from './common.js';

/** A guard protects what follows it: before the current line, or first in the body the current line opens. */
const GUARD_FORMS: StatementForms = { after: 'header', dedent: false };
import { blockAt } from '../py/structure.js';

interface Body {
  body: string;
  op: string;
  p: number;
}

/** `raise ...` statements of the file, with the donor function's name swapped for the current one inside strings. */
export function raiseStatements(ctx: TemplateContext, limit = 3): string[] {
  const { mod } = ctx;
  const me = ctx.block?.name ?? null;
  const out: string[] = [];
  for (const st of mod.statements) {
    if (st.kind !== 'raise' || st.tokens.length < 2 || st.startLine !== st.endLine) continue;
    if (ctx.block !== undefined && st.startLine >= ctx.block.bodyStart && st.startLine <= ctx.block.bodyEnd) continue; // our own raises are not donors
    const donor = blockAt(mod, st.startLine);
    let text = st.text;
    if (me !== null && donor !== undefined && donor.kind === 'def' && donor.name !== me) {
      // rename inside string literals only: "mean of empty sequence" -> "median of empty sequence"
      text = st.tokens.map((t) => (t.type === 'STRING' ? t.text.replace(new RegExp(`\\b${donor.name}\\b`, 'g'), me) : t.text)).reduce((acc, piece, k) => acc + (k > 0 && st.tokens[k]!.pre.length > 0 ? ' ' : '') + piece, '');
    }
    out.push(text);
  }
  return uniq(out).slice(0, limit);
}

/** Other attributes on the same receiver (`user.nickname` -> `user.full_name`), or sibling parameters for a plain name. */
function sameReceiverAlternatives(ctx: TemplateContext, subject: string): string[] {
  const dot = subject.lastIndexOf('.');
  if (dot < 0) return ctx.names.params.filter((p) => p !== subject).slice(0, 4);
  const receiver = subject.slice(0, dot);
  const attr = subject.slice(dot + 1);
  const attrs = [...(ctx.names.attrsByReceiver.get(receiver) ?? [])];
  const ann = ctx.names.annotations.get(receiver);
  if (ann !== undefined) {
    const cls = /^(?:Optional\[)?([A-Za-z_][A-Za-z0-9_]*)/.exec(ann)?.[1];
    if (cls !== undefined) attrs.push(...(ctx.names.classFields.get(cls) ?? []));
  }
  if (receiver === ctx.site.scope.selfName) attrs.push(...ctx.site.scope.classAttrs);
  return uniq(attrs).filter((a) => a !== attr && !a.startsWith('__')).slice(0, 6).map((a) => `${receiver}.${a}`);
}

export function guardDrafts(ctx: TemplateContext): Draft[] {
  const out: Draft[] = [];
  const base = FAMILY_PRIOR.guard;
  const unit = ctx.unit;
  const bound = boundOnLine(ctx);
  const gtoks = fragmentTokens(ctx.guardedLine);
  const visible = new Set(ctx.names.visible);
  const lineNames = identifiersIn(gtoks).filter((n) => visible.has(n) && !bound.has(n));
  const attrExprs = attrRefsIn(gtoks)
    .filter((r) => !r.call && visible.has(r.receiver.split('.')[0]!))
    .map((r) => `${r.receiver}.${r.attr}`);
  const subjects = uniq([...lineNames, ...attrExprs, ...ctx.names.params.filter((p) => !bound.has(p))]);
  const defaults = returnDefaults(ctx).slice(0, 4);
  const raises = raiseStatements(ctx, 2);
  const collections = new Set(ctx.names.collections);

  for (const s of subjects) {
    const loc = localityFactor(ctx, s);
    const onLine = lineNames.includes(s) || attrExprs.includes(s) ? 1 : 0.8;
    const bodies: Body[] = [];
    if (ctx.inFunction) {
      for (const alt of sameReceiverAlternatives(ctx, s)) bodies.push({ body: `return ${alt}`, op: 'guard_none_return_alt', p: 1 });
      bodies.push({ body: 'return None', op: 'guard_none_return', p: 0.95 });
      for (const d of defaults) if (d !== 'None') bodies.push({ body: `return ${d}`, op: 'guard_none_return_default', p: 0.9 });
    }
    if (ctx.inLoop) bodies.push({ body: 'continue', op: 'guard_none_continue', p: 0.8 });
    for (const r of raises) bodies.push({ body: r, op: 'guard_none_raise', p: 0.7 });
    bodies.push({ body: `raise ValueError("${s} is required")`, op: 'guard_none_raise', p: 0.6 });
    if (!s.includes('.') && onLine === 1) for (const alt of ['[]', '""', '0']) bodies.push({ body: `${s} = ${alt}`, op: 'guard_none_assign', p: 0.5 });
    for (const b of bodies) out.push(...statementDrafts(ctx, `if ${s} is None:\n${unit}${b.body}`, b.op, base * b.p * loc * onLine, GUARD_FORMS));

    // empty-collection guard: parameters and names the code treats as containers
    const plain = !s.includes('.');
    if ((plain && collections.has(s)) || (!plain && attrExprs.includes(s))) {
      const empty: Body[] = [];
      for (const r of raises) empty.push({ body: r, op: 'guard_empty_raise', p: 1 });
      empty.push({ body: `raise ValueError("${s} must not be empty")`, op: 'guard_empty_raise', p: 0.8 });
      if (ctx.inFunction) for (const d of defaults) empty.push({ body: `return ${d}`, op: 'guard_empty_return', p: 0.9 });
      if (ctx.inLoop) empty.push({ body: 'continue', op: 'guard_empty_continue', p: 0.8 }, { body: 'break', op: 'guard_empty_break', p: 0.7 });
      for (const b of empty) out.push(...statementDrafts(ctx, `if not ${s}:\n${unit}${b.body}`, b.op, base * 0.95 * b.p * loc * onLine, GUARD_FORMS));
    }
  }

  // range guard (FP3): index/sequence pairs, nearest names first
  const seqs = ctx.names.collections.filter((c) => !c.includes('.'));
  const pairs: [string, string][] = [];
  for (const i of ctx.names.indices) for (const q of seqs) if (i !== q && !bound.has(i)) pairs.push([i, q]);
  pairs.sort((a, b) => localityFactor(ctx, b[0], b[1]) - localityFactor(ctx, a[0], a[1]));
  for (const [i, q] of pairs.slice(0, 6)) {
    const loc = localityFactor(ctx, i, q);
    const bodies: Body[] = [];
    if (ctx.inLoop) bodies.push({ body: 'break', op: 'guard_index_break', p: 1 }, { body: 'continue', op: 'guard_index_continue', p: 0.7 });
    if (ctx.inFunction) for (const d of defaults.slice(0, 2)) bodies.push({ body: `return ${d}`, op: 'guard_index_return', p: 0.9 });
    bodies.push({ body: `raise IndexError("${i} out of range")`, op: 'guard_index_raise', p: 0.6 });
    for (const b of bodies) out.push(...statementDrafts(ctx, `if ${i} >= len(${q}):\n${unit}${b.body}`, b.op, base * 0.8 * b.p * loc, GUARD_FORMS));
  }
  return out;
}
