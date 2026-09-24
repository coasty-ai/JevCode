/**
 * Condition templates (TBar FP6.3, SPR condition refinement; Defects4J "Conditional Block"
 * 42.8 %, the dominant real-world pattern; QuixBugs `detect_cycle`, `possible_change`,
 * `is_valid_parenthesization`): extend an `if`/`elif`/`while` condition with `and`/`or` and a
 * predicate over an in-scope name, and turn `return True|False` into `return <predicate>`.
 * Predicates are enumerated from scope; Jev picks the disjunct, so the set is kept small and
 * idiomatic (`x is None or C`, `C or not xs`, `C and i < len(xs)`).
 */
import type { Draft, TemplateContext } from './common.js';
import { FAMILY_PRIOR, attrRefsIn, boundOnLine, fragmentTokens, isBareLiteral, lineDraft, lineShape, localityFactor, sliceBody, spliceBody, uniq } from './common.js';

/**
 * Whether the condition already says what the predicate says: the predicate's tokens occur in
 * it as a run of whole tokens (`x is None` in `x is None or y`; `i` is not part of `items`). A
 * bare name only counts when it is the whole condition, since `i` inside `xs[i] > 0` is a
 * subscript, not the truth test `and i` would add.
 */
function alreadySays(condition: string, predicate: string): boolean {
  const render = (text: string): string => ` ${fragmentTokens(text).map((t) => t.text).join(' ')} `;
  const p = render(predicate);
  if (p.trim().split(' ').length === 1) return render(condition) === p;
  return render(condition).includes(p);
}

interface Predicate {
  text: string;
  /** prior of the idiomatic connective for this predicate: [or, and] */
  or: number;
  and: number;
  /** prior factor when the predicate comes first (`x is None or C`) */
  first: number;
  names: string[];
}

function predicates(ctx: TemplateContext, bound: ReadonlySet<string>): Predicate[] {
  const out: Predicate[] = [];
  const names = ctx.names.visible.filter((n) => !bound.has(n));
  const collections = new Set(ctx.names.collections);
  const counters = new Set(ctx.names.counters);
  for (const n of names) {
    out.push({ text: `${n} is None`, or: 1, and: 0.4, first: 1, names: [n] });
    out.push({ text: `${n} is not None`, or: 0.4, and: 0.9, first: 0.9, names: [n] });
    out.push({ text: `not ${n}`, or: 1, and: 0.6, first: 0.8, names: [n] });
    out.push({ text: n, or: 0.6, and: 0.9, first: 0.7, names: [n] });
    if (counters.has(n)) out.push({ text: `${n} == 0`, or: 0.7, and: 0.5, first: 0.7, names: [n] }, { text: `${n} > 0`, or: 0.5, and: 0.7, first: 0.7, names: [n] });
    if (collections.has(n)) out.push({ text: `len(${n}) == 0`, or: 0.6, and: 0.3, first: 0.6, names: [n] });
  }
  for (const r of attrRefsIn(ctx.lineTokens)) {
    if (r.call) continue;
    const a = `${r.receiver}.${r.attr}`;
    out.push({ text: `${a} is None`, or: 0.9, and: 0.4, first: 0.9, names: [r.receiver] }, { text: `${a} is not None`, or: 0.4, and: 0.8, first: 0.8, names: [r.receiver] });
  }
  for (const i of ctx.names.indices) {
    for (const q of ctx.names.collections) {
      if (i === q || q.includes('.')) continue;
      out.push({ text: `${i} < len(${q})`, or: 0.5, and: 0.9, first: 0.8, names: [i, q] }, { text: `${i} >= len(${q})`, or: 0.8, and: 0.4, first: 0.7, names: [i, q] });
    }
  }
  return out;
}

export function conditionDrafts(ctx: TemplateContext): Draft[] {
  if (ctx.site.kind !== 'replace') return [];
  const shape = lineShape(ctx);
  const base = FAMILY_PRIOR.condition;
  const bound = boundOnLine(ctx);
  const out: Draft[] = [];

  if (shape.kind === 'condition') {
    const c = sliceBody(ctx, shape.from, shape.to);
    for (const p of predicates(ctx, bound)) {
      if (alreadySays(c, p.text)) continue;
      const loc = localityFactor(ctx, ...p.names);
      const forms: [string, string, number][] = [
        [`${c} or ${p.text}`, 'cond_or', p.or],
        [`${c} and ${p.text}`, 'cond_and', p.and],
        [`${p.text} or ${c}`, 'cond_or_first', p.or * p.first],
        [`${p.text} and ${c}`, 'cond_and_first', p.and * p.first],
      ];
      for (const [text, op, prior] of forms) out.push(...lineDraft(ctx, spliceBody(ctx, shape.from, shape.to, text), op, base * prior * loc));
    }
    return out;
  }

  if (shape.kind === 'return' && isBareLiteral(ctx, shape.from, shape.to)) {
    const lit = ctx.lineTokens[shape.from]!.text;
    if (lit !== 'True' && lit !== 'False') return out;
    const names = ctx.names.visible.filter((n) => !bound.has(n));
    const numbers = uniq([...(ctx.fn?.literals.numbers ?? []), ...ctx.opts.testLiterals.filter((l) => /^-?\d+$/.test(l))]).slice(0, 3);
    const emit = (expr: string, p: number, ...slots: string[]): void => {
      out.push(...lineDraft(ctx, spliceBody(ctx, shape.from, shape.to, expr), 'return_condition', base * 0.8 * p * localityFactor(ctx, ...slots)));
    };
    for (const n of names) {
      emit(`${n} == 0`, 1, n);
      emit(`${n} != 0`, 0.9, n);
      emit(`not ${n}`, 0.9, n);
      emit(n, 0.8, n);
      emit(`${n} is None`, 0.7, n);
      emit(`${n} is not None`, 0.7, n);
      if (ctx.names.collections.includes(n)) emit(`len(${n}) == 0`, 0.7, n);
      for (const k of numbers) if (k !== '0') emit(`${n} == ${k}`, 0.6, n);
    }
    for (const a of names) for (const b of names) if (a < b && ctx.nearby.has(a) && ctx.nearby.has(b)) emit(`${a} == ${b}`, 0.6, a, b);
  }
  return out;
}
