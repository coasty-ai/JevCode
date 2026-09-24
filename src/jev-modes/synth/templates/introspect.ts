/**
 * Two productions fed by runtime facts (src/jev-modes/synth/introspect; experiments/results/
 * swebench-reach-oracle-9.md, missing capability 2), inert without `EnumerateOptions.introspected`:
 *
 * - `attribute_predicate_guard`: `if not <subject>.<is_attr>:` / `<sibling return>` inserted before
 *   the guarded statement, where `<subject>` is an operand of the raising line whose root name is
 *   in scope at the site, `<is_attr>` one of the `is_*` predicates the introspection read on that
 *   very object, and the body a `returnDefaults` value of the enclosing function (or `continue`
 *   in a loop). Predicates that were falsy at the failing call come first (the guard fires on the
 *   failing input for exactly those); a predicate that was truthy is offered in the positive form.
 *   The guard protects the statement the operand was read in: when the operand's frame is in the
 *   site's file, the production fires ONLY at the gap immediately before that statement (written at
 *   the statement's own indent, whatever the site's) or at the statement itself (`_before` form),
 *   never at the other gaps of the file (jev-only-rungs-1-2.md §21.5: sympy-17139's guard was
 *   tested at the gap inside the body of the raising `if`, dead code, and never before it).
 *   Operands without a frame in this file fall back to every gap where their root is visible.
 * - `mro_method_alias`: `<prefix><MroClass> = <existing method>` at a class-body gap (or appended
 *   after the last line of a method, at the class indent), for a class whose methods share a
 *   dispatch prefix (introspect/prefixes.ts: `_print_`, `visit_`, `_eval_`) and every class name
 *   of the operands' MROs the class does not handle yet, aliased to each existing prefixed method
 *   (nearest to the site first). Jev chooses among the ≤ INTROSPECT_ALIAS_DRAFTS_MAX combinations.
 *   A gap search/sites.ts marked as the class-body gap (`CLASS_BODY_GAP_NOTE`, merged onto a located
 *   gap at the same line when the two collided) counts as one whatever its own indent: the alias is
 *   written at the class body's indent (§21.5: sympy-15345's `MCodePrinter` gap was deduplicated
 *   against the method's block-end slot and the alias reached Jev only in its `_after` form).
 *
 * Both are generic: no name here comes from a benchmark; the unit test guards the module text and
 * `INTROSPECT_EXAMPLES` against bench/data (test/unit/jev-modes/synth/templates/introspect.test.ts).
 */
import { indentOf, reindent } from '../py/edits.js';
import { blockAt, statementAt } from '../py/structure.js';
import type { Block } from '../py/structure.js';
import { indentWidth } from '../py/tokenize.js';
import { classMethodPrefixes } from '../introspect/prefixes.js';
import type { MethodPrefix } from '../introspect/prefixes.js';
import type { IntrospectFrame, IntrospectOperand } from '../introspect/types.js';
import type { Site } from '../types.js';
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
/**
 * Prefix of the evidence note search/sites.ts puts on the class-body gap of the class the failing
 * call's objects point at (`introspection: class-body gap of <Class> after <method> (L..)`); a
 * located gap the note was merged onto is a class-body gap for `mro_method_alias`.
 */
export const CLASS_BODY_GAP_NOTE = 'introspection: class-body gap of';

/** True for a site carrying the class-body mark (built or merged by search/sites.ts). */
export function isClassBodyGapSite(site: Pick<Site, 'evidence'>): boolean {
  return site.evidence.notes.some((n) => n.startsWith(CLASS_BODY_GAP_NOTE));
}

/** A guard protects what follows it: before the current line, or first in the body the current line opens. */
const GUARD_FORMS: StatementForms = { after: 'header', dedent: false };
/** At the raising statement itself only the `_before` form protects it (inside its body the guard is dead code). */
const GUARD_AT_TARGET_FORMS: StatementForms = { after: 'never', dedent: false };
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

/** True when a frame path (as CPython prints it, possibly absolute) names the workspace-relative `path`. */
export function framePathMatches(framePath: string, path: string): boolean {
  const a = framePath.replace(/^\.\//, '');
  const b = path.replace(/^\.\//, '');
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/**
 * The first line of the statement `frame` raised in, in the site's file; null when the frame is in
 * another file (or absent), i.e. when the production has no target here and falls back.
 */
export function guardTargetLine(ctx: Pick<TemplateContext, 'mod' | 'site'>, frame: IntrospectFrame | null): number | null {
  if (frame === null || !framePathMatches(frame.path, ctx.site.file.path)) return null;
  if (frame.line < 1 || frame.line > ctx.mod.lines.length) return null;
  return statementAt(ctx.mod, frame.line)?.startLine ?? frame.line;
}

/** The guard drafts of one statement for one operand at this site: at the target gap / statement, or (no target in this file) the general forms. */
function guardDraftsFor(ctx: TemplateContext, operand: IntrospectOperand, stmt: string, prior: number): Draft[] {
  const target = guardTargetLine(ctx, operand.frame);
  if (target === null) return statementDrafts(ctx, stmt, 'attribute_predicate_guard', prior, GUARD_FORMS);
  const { site } = ctx;
  if (site.kind === 'insert') {
    if (site.line !== target) return [];
    const indent = indentOf(ctx.mod.lines[target - 1] ?? '');
    return [{ text: reindent(stmt, indent), op: 'attribute_predicate_guard', prior }];
  }
  const startsAtTarget = (ctx.stmt?.startLine ?? site.line) === target;
  return startsAtTarget ? statementDrafts(ctx, stmt, 'attribute_predicate_guard', prior, GUARD_AT_TARGET_FORMS) : [];
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
    const frameFactor = operand.frame === null ? 0.9 : framePathMatches(operand.frame.path, ctx.site.file.path) && operand.frame.fn === (ctx.block?.name ?? null) ? 1 : 0.8;
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
        out.push(...guardDraftsFor(ctx, operand, `if ${cond}:\n${ctx.unit}${b.body}`, prior));
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

/** The indentation of a class body as the file writes it (the first body line's, else `bodyIndent` spaces). */
function classLeadOf(ctx: Pick<TemplateContext, 'mod'>, cls: Block): string {
  return indentOf(ctx.mod.lines[cls.bodyStart - 1] ?? '') || ' '.repeat(cls.bodyIndent);
}

/**
 * The innermost class whose body the gap or the end of the current method belongs to, with how an
 * alias lands there; null elsewhere. A gap is a class-body gap when its indent is the body's, or
 * when search/sites.ts marked it as one (`isClassBodyGapSite`): the alias then carries the class
 * body's indent itself (verify/apply.ts inserts indented text verbatim).
 */
function aliasPlacement(ctx: TemplateContext): AliasPlacement | null {
  const { mod, site } = ctx;
  if (site.kind === 'insert') {
    let b = blockAt(mod, Math.max(1, site.line - 1));
    while (b !== undefined && b.kind !== 'class') b = b.parent === null ? undefined : mod.blocks[b.parent];
    if (b === undefined || (indentWidth(site.indent) !== b.bodyIndent && !isClassBodyGapSite(site))) return null;
    const cls = b;
    const lead = classLeadOf(ctx, cls);
    return { cls, emit: (alias, op, prior) => [{ text: `${lead}${alias}`, op, prior }] };
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
  const classLead = classLeadOf(ctx, cls);
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
