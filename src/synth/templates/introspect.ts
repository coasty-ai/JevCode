/**
 * Two productions fed by runtime facts (src/synth/introspect; experiments/results/
 * swebench-reach-oracle-9.md, missing capability 2), inert without `EnumerateOptions.introspected`:
 *
 * - `attribute_predicate_guard`: `if not <subject>.<is_attr>:` / `<sibling return>` inserted before
 *   the guarded statement, where `<subject>` is an operand of the raising line whose root name is
 *   in scope at the site, `<is_attr>` one of the `is_*` predicates the introspection read on that
 *   very object, and the body a `returnDefaults` value of the enclosing function (or `continue`
 *   in a loop). Predicates that were falsy at the failing call come first (the guard fires on the
 *   failing input for exactly those); a predicate that was truthy is offered in the positive form.
 * - `mro_method_alias`: `<prefix><MroClass> = <existing method>` at a class-body gap (or appended
 *   after the last line of a method, at the class indent), for a class whose methods share a
 *   dispatch prefix (introspect/prefixes.ts: `_print_`, `visit_`, `_eval_`) and every class name
 *   of the operands' MROs the class does not handle yet, aliased to each existing prefixed method
 *   (nearest to the site first). Jev chooses among the ≤ INTROSPECT_ALIAS_DRAFTS_MAX combinations.
 *
 * Both are generic: no name here comes from a benchmark; the unit test guards the module text and
 * `INTROSPECT_EXAMPLES` against bench/data (test/unit/synth/templates/introspect.test.ts).
 */
import { indentOf } from '../py/edits.js';
import { blockAt } from '../py/structure.js';
import type { Block } from '../py/structure.js';
import { indentWidth } from '../py/tokenize.js';
import { classMethodPrefixes } from '../introspect/prefixes.js';
import type { MethodPrefix } from '../introspect/prefixes.js';
import type { Draft, StatementForms, TemplateContext } from './common.js';
import { FAMILY_PRIOR, currentLineText, returnDefaults, statementDrafts, uniq } from './common.js';

/** Guard drafts kept per site after prior ordering (the templates' cap is 254 across families; this leaves the others their room). */
export const INTROSPECT_GUARD_DRAFTS_MAX = 150;
/** Alias combinations offered per site (the Choice limit minus the escape). */
export const INTROSPECT_ALIAS_DRAFTS_MAX = 254;
/** Guard bodies per predicate: the first return defaults of the function. */
export const GUARD_BODIES_MAX = 3;
/** Generic examples of the two shapes (documentation and the leakage test; not Jev wordings). */
export const INTROSPECT_EXAMPLES: readonly string[] = ['if not node.is_leaf:\n    return acc', 'visit_Compare = visit_BinOp'];

/** A guard protects what follows it: before the current line, or first in the body the current line opens. */
const GUARD_FORMS: StatementForms = { after: 'header', dedent: false };
const IDENT_RE = /^[A-Za-z_]\w*$/;
const DOTTED_RE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

interface Body {
  body: string;
  p: number;
}

/** `return <default>` for the function's first return defaults, `continue` in a loop; [] outside a function body. */
function guardBodies(ctx: TemplateContext): Body[] {
  const out: Body[] = [];
  if (ctx.inFunction) {
    returnDefaults(ctx)
      .slice(0, GUARD_BODIES_MAX)
      .forEach((d, k) => out.push({ body: `return ${d}`, p: 1 - 0.1 * k }));
  }
  if (ctx.inLoop) out.push({ body: 'continue', p: 0.8 });
  return out;
}

/** `attribute_predicate_guard` drafts (see the module header), prior-ordered, ≤ INTROSPECT_GUARD_DRAFTS_MAX. */
export function attributePredicateGuardDrafts(ctx: TemplateContext): Draft[] {
  const names = ctx.opts.introspected;
  if (names === undefined || names.operands.length === 0) return [];
  const bodies = guardBodies(ctx);
  if (bodies.length === 0) return [];
  const visible = new Set(ctx.site.scope.all);
  const base = FAMILY_PRIOR.introspect;
  const out: Draft[] = [];
  const seen = new Set<string>();
  for (const operand of names.operands) {
    if (!DOTTED_RE.test(operand.expr) || operand.predicates.length === 0) continue;
    const root = operand.expr.split('.')[0] ?? '';
    if (!visible.has(root)) continue;
    // the operand was read in the site's own function: its name means the same thing here
    const frameFactor = operand.frame === null ? 0.9 : operand.frame.path === ctx.site.file.path && operand.frame.fn === (ctx.block?.name ?? null) ? 1 : 0.8;
    const receiverFactor = operand.raisingReceiver ? 1 : 0.9;
    const falsy = new Set(operand.falsyPredicates);
    operand.predicates.forEach((pred, k) => {
      if (!IDENT_RE.test(pred)) return;
      const cond = falsy.has(pred) ? `not ${operand.expr}.${pred}` : `${operand.expr}.${pred}`;
      const key = `${operand.expr}.${pred}`;
      if (seen.has(key)) return;
      seen.add(key);
      const predFactor = falsy.has(pred) ? 1 : 0.85;
      for (const b of bodies) {
        const prior = base * frameFactor * receiverFactor * predFactor * b.p * (1 - 0.0005 * k);
        out.push(...statementDrafts(ctx, `if ${cond}:\n${ctx.unit}${b.body}`, 'attribute_predicate_guard', prior, GUARD_FORMS));
      }
    });
  }
  return out.sort((a, b) => b.prior - a.prior).slice(0, INTROSPECT_GUARD_DRAFTS_MAX);
}

interface AliasPlacement {
  cls: Block;
  /** turn one alias statement into the drafts at this site */
  emit(alias: string, op: string, prior: number): Draft[];
}

/** The innermost class whose body the gap or the end of the current method belongs to, with how an alias lands there; null elsewhere. */
function aliasPlacement(ctx: TemplateContext): AliasPlacement | null {
  const { mod, site } = ctx;
  if (site.kind === 'insert') {
    let b = blockAt(mod, Math.max(1, site.line - 1));
    while (b !== undefined && b.kind !== 'class') b = b.parent === null ? undefined : mod.blocks[b.parent];
    if (b === undefined || indentWidth(site.indent) !== b.bodyIndent) return null;
    const cls = b;
    return { cls, emit: (alias, op, prior) => [{ text: `${site.indent}${alias}`, op, prior }] };
  }
  const def = ctx.block;
  if (def === undefined || def.parent === null) return null;
  const cls = mod.blocks[def.parent];
  if (cls === undefined || cls.kind !== 'class') return null;
  // only at the last physical line of the last statement of the method: the alias is appended at the class indent
  if (ctx.stmt === undefined || ctx.stmt.endLine !== (site.endLine ?? site.line)) return null;
  let next: string | undefined;
  for (let l = (site.endLine ?? site.line) + 1; l <= mod.lines.length; l++) {
    const text = mod.lines[l - 1] ?? '';
    if (text.trim() !== '' && !text.trim().startsWith('#')) {
      next = text;
      break;
    }
  }
  if (next !== undefined && indentWidth(indentOf(next)) > cls.bodyIndent) return null;
  const classLead = indentOf(mod.lines[cls.bodyStart - 1] ?? '') || ' '.repeat(cls.bodyIndent);
  return { cls, emit: (alias, op, prior) => [{ text: `${currentLineText(ctx)}\n${classLead}${alias}`, op: `${op}_after_dedent`, prior }] };
}

/** `mro_method_alias` drafts (see the module header), ≤ INTROSPECT_ALIAS_DRAFTS_MAX, nearest method × most specific class first. */
export function mroMethodAliasDrafts(ctx: TemplateContext): Draft[] {
  const names = ctx.opts.introspected;
  if (names === undefined || names.classes.length === 0) return [];
  const placement = aliasPlacement(ctx);
  if (placement === null) return [];
  const conv: MethodPrefix | undefined = classMethodPrefixes(ctx.mod).find((p) => p.classIndex === placement.cls.index);
  if (conv === undefined) return [];
  const fileNames = new Set<string>();
  for (const t of ctx.mod.tokens) if (t.type === 'NAME') fileNames.add(t.text);
  const classes = uniq(names.classes).filter((c) => IDENT_RE.test(c) && !fileNames.has(`${conv.prefix}${c}`));
  if (classes.length === 0) return [];
  // nearest method first; an alias is appended after the method it names, so the method ending just before the site wins a tie with the one starting just after it
  const distance = (b: Block): number => (b.endLine < ctx.site.line ? ctx.site.line - b.endLine : b.startLine - ctx.site.line + 1);
  const methods = [...conv.methods].sort((a, b) => distance(a.block) - distance(b.block) || b.block.startLine - a.block.startLine);
  const base = FAMILY_PRIOR.introspect;
  const total = Math.max(1, classes.length * methods.length);
  const out: Draft[] = [];
  for (const [j, m] of methods.entries()) {
    for (const [k, c] of classes.entries()) {
      if (out.length >= INTROSPECT_ALIAS_DRAFTS_MAX) return out;
      const rank = j * classes.length + k;
      const prior = base * (1 - (0.9 * rank) / total);
      out.push(...placement.emit(`${conv.prefix}${c} = ${m.name}`, 'mro_method_alias', prior));
    }
  }
  return out;
}

/** Both introspection-fed productions; [] without introspection facts. */
export function introspectDrafts(ctx: TemplateContext): Draft[] {
  if (ctx.opts.introspected === undefined) return [];
  return [...attributePredicateGuardDrafts(ctx), ...mroMethodAliasDrafts(ctx)];
}
