/**
 * Missing-statement insertion (TBar FP4; ~30 % of Defects4J patches are pure additions; all
 * four QuixBugs insertion fixes are `{x}.add({y})`, `{x}.append({y})` or `{x} = {y}`). The
 * catalogue is keyed by the role scope gives each name: sets get `.add`, lists `.append`,
 * counters `+= 1`, attribute receivers `.attr = None`, and any pair of names an assignment or a
 * swap. Slot values are restricted to names near the site so the pool stays in the tens.
 */
import type { Draft, TemplateContext } from './common.js';
import { FAMILY_PRIOR, localityFactor, returnDefaults, statementDrafts, uniq } from './common.js';

function attrsAssignedOn(ctx: TemplateContext, receiver: string): string[] {
  const out: string[] = [];
  for (const s of ctx.mod.statements) for (const a of s.attrAssigns) if (a.receiver === receiver) out.push(a.attr);
  return uniq(out);
}

/** True when the previous statement closes an `if`/`elif` chain at the site's indent (a place for `else:`). */
function ifChainEndsHere(ctx: TemplateContext): boolean {
  const { mod, site, lead } = ctx;
  const before = mod.statements.filter((s) => s.startLine < site.line);
  const prev = before[before.length - 1];
  if (prev === undefined || prev.indent <= lead.length) return false;
  const header = [...before].reverse().find((s) => s.indent === lead.length);
  return header !== undefined && (header.kind === 'if' || header.kind === 'elif');
}

export function statementInsertDrafts(ctx: TemplateContext): Draft[] {
  const out: Draft[] = [];
  const base = FAMILY_PRIOR.statement;
  const n = ctx.names;
  const values = n.visible;
  const near = (...names: string[]): boolean => names.some((x) => ctx.nearby.has(x));
  const emit = (stmt: string, op: string, p: number, ...slots: string[]): void => {
    out.push(...statementDrafts(ctx, stmt, op, base * p * localityFactor(ctx, ...slots)));
  };

  for (const s of n.sets) for (const x of values) if (x !== s && (near(x) || n.params.includes(x))) emit(`${s}.add(${x})`, 'insert_add', 1, s, x);
  for (const l of n.lists) for (const x of values) if (x !== l && (near(x) || n.params.includes(x))) emit(`${l}.append(${x})`, 'insert_append', 1, l, x);
  for (const l of n.lists) for (const x of values) if (x !== l && near(l, x) && n.collections.includes(x)) emit(`${l}.extend(${x})`, 'insert_extend', 0.6, l, x);

  const locals = ctx.site.scope.locals.filter((x) => values.includes(x));
  // both names near the site, or a nearby local taking a parameter: `prevnode = node`
  for (const x of locals) for (const y of values) if (x !== y && near(x) && (near(y) || n.params.includes(y))) emit(`${x} = ${y}`, 'insert_assign', 0.8, x, y);
  for (const x of locals) if (near(x)) emit(`${x} = None`, 'insert_assign_none', 0.5, x);

  for (const c of n.counters) {
    emit(`${c} += 1`, 'insert_increment', 0.7, c);
    emit(`${c} -= 1`, 'insert_decrement', 0.5, c);
  }

  for (const r of n.receivers) {
    for (const a of attrsAssignedOn(ctx, r)) {
      emit(`${r}.${a} = None`, 'insert_attr_none', 0.6, r);
      for (const y of values) if (y !== r && near(r, y)) emit(`${r}.${a} = ${y}`, 'insert_attr_assign', 0.5, r, y);
    }
  }

  if (ctx.inFunction) for (const x of uniq([...values.filter((v) => near(v)), ...returnDefaults(ctx).slice(0, 4)])) emit(`return ${x}`, 'insert_return', 0.8, x);

  for (let i = 0; i < locals.length; i++) {
    for (let j = i + 1; j < locals.length; j++) {
      const x = locals[i]!;
      const y = locals[j]!;
      if (near(x) && near(y)) emit(`${x}, ${y} = ${y}, ${x}`, 'insert_swap', 0.45, x, y);
    }
  }

  if (ctx.site.kind === 'insert' && ctx.inFunction && ifChainEndsHere(ctx)) {
    for (const x of returnDefaults(ctx).slice(0, 4)) emit(`else:\n${ctx.unit}return ${x}`, 'insert_else_return', 0.4);
  }
  return out;
}
