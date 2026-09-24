/**
 * Attribute and call-target substitution (TBar FP10.1 / FP13.1; SStuB "Change Identifier Used"
 * 12.8 % and "Wrong Function Name" 5.8 %, the largest buckets in the wild; ladder `events`,
 * QuixBugs `topological_ordering`): replace `recv.attr` with another attribute seen on the same
 * receiver anywhere in the file, on the receiver's annotated class, or on a class whose fields
 * overlap the receiver's other attributes; replace a called name with another callable in
 * scope (same-file defs, imports, the builtin's own family). Alternatives are ordered by
 * character similarity to the original so near-misses (`end_at` -> `ends_at`) come first.
 */
import type { Draft, TemplateContext } from './common.js';
import { BUILTIN_SET, FAMILY_PRIOR, attrRefsIn, isName, isOp, lineDraft, replaceToken, uniq } from './common.js';
import { levenshteinSimilarity } from '../py/similarity.js';

const METHOD_GROUPS: readonly (readonly string[])[] = [
  ['append', 'extend', 'insert', 'pop', 'remove', 'sort', 'reverse', 'index', 'count'],
  ['add', 'discard', 'remove', 'update', 'pop'],
  ['get', 'keys', 'values', 'items', 'setdefault', 'update', 'pop'],
  ['strip', 'lstrip', 'rstrip', 'lower', 'upper', 'title', 'capitalize', 'casefold'],
  ['split', 'rsplit', 'splitlines', 'partition', 'join'],
  ['startswith', 'endswith', 'find', 'rfind', 'index', 'rindex', 'replace'],
  ['successor', 'successors', 'predecessors', 'incoming_nodes', 'outgoing_nodes', 'value'],
];

const BUILTIN_GROUPS: readonly (readonly string[])[] = [
  ['max', 'min'],
  ['sum', 'len'],
  ['list', 'set', 'tuple', 'sorted', 'reversed', 'frozenset'],
  ['any', 'all'],
  ['int', 'float', 'str', 'round', 'abs'],
  ['range', 'enumerate', 'zip'],
];

function similarity(a: string, b: string): number {
  return levenshteinSimilarity([...a], [...b]);
}

interface Alt {
  name: string;
  p: number;
}

function attributeAlternatives(ctx: TemplateContext, receiver: string, attr: string): Alt[] {
  const alts: Alt[] = [];
  const onReceiver = ctx.names.attrsByReceiver.get(receiver) ?? [];
  for (const a of onReceiver) alts.push({ name: a, p: 0.8 });
  const ann = ctx.names.annotations.get(receiver);
  const cls = ann === undefined ? undefined : /^(?:Optional\[)?([A-Za-z_][A-Za-z0-9_]*)/.exec(ann)?.[1];
  if (cls !== undefined) for (const f of ctx.names.classFields.get(cls) ?? []) alts.push({ name: f, p: 0.95 });
  if (receiver === ctx.site.scope.selfName) for (const f of ctx.site.scope.classAttrs) alts.push({ name: f, p: 0.9 });
  // a class whose fields overlap the receiver's other attributes is probably the receiver's class
  for (const [name, fields] of ctx.names.classFields) {
    if (name === cls) continue;
    const overlap = fields.filter((f) => f !== attr && onReceiver.includes(f)).length;
    if (overlap > 0) for (const f of fields) alts.push({ name: f, p: 0.85 });
  }
  for (const group of METHOD_GROUPS) if (group.includes(attr)) for (const g of group) alts.push({ name: g, p: 0.5 });
  const best = new Map<string, number>();
  for (const a of alts) {
    if (a.name === attr || a.name.startsWith('__')) continue;
    const prior = a.p * (0.7 + 0.3 * similarity(attr, a.name));
    if ((best.get(a.name) ?? 0) < prior) best.set(a.name, prior);
  }
  return [...best.entries()].map(([name, p]) => ({ name, p })).sort((x, y) => y.p - x.p);
}

function calleeAlternatives(ctx: TemplateContext, callee: string): Alt[] {
  const alts: Alt[] = [];
  for (const b of ctx.mod.blocks) if (b.kind === 'def' && b.parent === null && b.name !== callee) alts.push({ name: b.name, p: 0.85 });
  for (const n of ctx.site.scope.imports) if (n !== callee && n !== '*') alts.push({ name: n, p: 0.6 });
  for (const group of BUILTIN_GROUPS) if (group.includes(callee)) for (const g of group) alts.push({ name: g, p: 0.7 });
  if (!BUILTIN_SET.has(callee)) for (const n of ctx.names.visible) if (n !== callee && ctx.mod.blocks.some((b) => b.kind === 'def' && b.name === n)) alts.push({ name: n, p: 0.7 });
  const best = new Map<string, number>();
  for (const a of alts) {
    if (a.name === callee) continue;
    const prior = a.p * (0.7 + 0.3 * similarity(callee, a.name));
    if ((best.get(a.name) ?? 0) < prior) best.set(a.name, prior);
  }
  return [...best.entries()].map(([name, p]) => ({ name, p })).sort((x, y) => y.p - x.p);
}

export function attributeDrafts(ctx: TemplateContext): Draft[] {
  if (ctx.site.kind !== 'replace') return [];
  const out: Draft[] = [];
  const base = FAMILY_PRIOR.attribute;
  const t = ctx.lineTokens;
  for (const ref of attrRefsIn(t)) {
    for (const alt of attributeAlternatives(ctx, ref.receiver, ref.attr).slice(0, 12)) {
      out.push(...lineDraft(ctx, replaceToken(ctx, ref.attrIndex, alt.name), ref.call ? 'method_subst' : 'attr_subst', base * alt.p));
    }
  }
  // `recv.attr` inside f-string replacement fields is one STRING token to the tokenizer (ladder `events`)
  for (const tok of t) {
    if (tok.type !== 'STRING' || !/^[rRbBuU]*[fF]/.test(tok.text)) continue;
    for (const field of tok.text.matchAll(/\{([^{}]*)\}/g)) {
      const fieldStart = tok.start + (field.index ?? 0) + 1;
      for (const m of field[1]!.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
        const [, receiver, attr] = m;
        if (receiver === undefined || attr === undefined || !ctx.names.visible.includes(receiver)) continue;
        const attrStart = fieldStart + (m.index ?? 0) + receiver.length + 1;
        for (const alt of attributeAlternatives(ctx, receiver, attr).slice(0, 12)) {
          const body = ctx.body.slice(0, attrStart) + alt.name + ctx.body.slice(attrStart + attr.length);
          out.push(...lineDraft(ctx, body, 'attr_subst', base * alt.p));
        }
      }
    }
  }
  for (let k = 0; k < t.length - 1; k++) {
    const tok = t[k]!;
    if (!isName(tok) || !isOp(t[k + 1], '(') || isOp(t[k - 1], '.')) continue;
    const before = t[k - 1];
    if (before !== undefined && before.type === 'NAME' && (before.text === 'def' || before.text === 'class')) continue;
    for (const alt of calleeAlternatives(ctx, tok.text).slice(0, 10)) out.push(...lineDraft(ctx, replaceToken(ctx, k, alt.name), 'callee_subst', base * 0.9 * alt.p));
  }
  return uniq(out.map((d) => d.text)).map((text) => out.find((d) => d.text === text)!);
}
