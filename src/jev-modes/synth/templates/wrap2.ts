/**
 * Depth-2 wraps: two whitelisted wrap templates composed at one site, WIDENED phase only
 * (experiments/results/swebench-reach-oracle-9.md capability 6, sympy-19954: `for i, r in
 * enumerate(rep_blocks):` -> `for i, r in reversed(list(enumerate(rep_blocks))):` passes the F2P
 * test; the single wraps exist, the composition did not, and composite pairs compose a mutation
 * on a seed, never a template on a template). The whitelist is the eight builtins that compose
 * (each takes one iterable/value and returns one), the pairs are ordered by how often the outer
 * wrap needs the inner one to be legal (`reversed` needs a sequence: `list`/`sorted`/`tuple`
 * first) and cut at DEPTH2_WRAP_LIMIT per site. Shapes: the iterable of a `for` header (where
 * wrap.ts offers nothing), an assignment's right-hand side and a `return` expression; depth-1
 * whitelist wraps of the `for` iterable ride along so the double wrap has its singles beside it.
 * Nothing here runs in SEEDS: `EnumerateOptions.phase` must say 'WIDENED'. Priors sit at the wrap
 * family's top (a WIDENED site has already run its SEEDS set, which the queue's `tried` check
 * drops again, so the phase's new lines must land under the 254 cap to be run at all; at
 * perm_groups.py:2198 the 254th SEEDS candidate has prior 0.42 and the first pair 0.52).
 */
import type { Draft, TemplateContext } from './common.js';
import { FAMILY_PRIOR, findTopLevel, isBareLiteral, isKw, lineDraft, lineShape, sliceBody, spliceBody } from './common.js';

/** Wraps that compose: one argument in, one value out, all builtins (no import). */
export const DEPTH2_WRAPS: readonly string[] = ['list', 'reversed', 'sorted', 'enumerate', 'set', 'tuple', 'str', 'int'];
/** Depth-2 wraps per site (≤ 40, the brief's bound; 8 × 7 ordered pairs minus the pointless ones). */
export const DEPTH2_WRAP_LIMIT = 40;

/**
 * Ordered (outer, inner) pairs, most plausible first: an outer that needs a sequence over a
 * materialising inner, then the iterator combinators, then the scalar coercions. Pairs whose
 * inner is undone by the outer (`list(tuple(...))`, `str(str(...))`) or that never change the
 * value (`list(list(...))`) are left out.
 */
function orderedPairs(): [string, string][] {
  const sequenceMakers = ['list', 'sorted', 'tuple'];
  const first: [string, string][] = [];
  for (const outer of ['reversed', 'enumerate']) for (const inner of [...sequenceMakers, 'set']) first.push([outer, inner]);
  for (const outer of sequenceMakers) for (const inner of ['reversed', 'enumerate', 'set', 'sorted']) if (outer !== inner) first.push([outer, inner]);
  for (const outer of ['set']) for (const inner of ['list', 'sorted', 'tuple', 'reversed', 'enumerate']) first.push([outer, inner]);
  for (const outer of ['str', 'int']) for (const inner of DEPTH2_WRAPS) if (inner !== outer && !(outer === 'str' && inner === 'int') && !(outer === 'int' && inner === 'str')) first.push([outer, inner]);
  // anything left in the whitelist product, deterministic order, never a pair already listed
  const seen = new Set(first.map(([a, b]) => `${a}\u0000${b}`));
  const redundant = new Set(['list\u0000tuple', 'tuple\u0000list', 'list\u0000list', 'sorted\u0000sorted', 'set\u0000set', 'reversed\u0000reversed', 'enumerate\u0000enumerate', 'str\u0000str', 'int\u0000int', 'tuple\u0000tuple']);
  for (const outer of DEPTH2_WRAPS) for (const inner of DEPTH2_WRAPS) {
    const k = `${outer}\u0000${inner}`;
    if (seen.has(k) || redundant.has(k)) continue;
    seen.add(k);
    first.push([outer, inner]);
  }
  return first.filter(([a, b]) => !redundant.has(`${a}\u0000${b}`)).slice(0, DEPTH2_WRAP_LIMIT);
}

const PAIRS = orderedPairs();

/** The token range of the iterable of a `for` header (`for x, y in <iter>:`), or null. */
function forIterable(ctx: TemplateContext): { from: number; to: number } | null {
  const t = ctx.lineTokens;
  if (!isKw(t[0], 'for')) return null;
  const inIdx = findTopLevel(t, (u) => isKw(u, 'in'), 1);
  const colon = findTopLevel(t, (u) => u.type === 'OP' && u.text === ':', inIdx + 1);
  if (inIdx <= 1 || colon <= inIdx + 1) return null;
  return { from: inIdx + 1, to: colon };
}

/** Whether the expression is already `outer(...)` (the same wrap twice is not a fix). */
function outerCallee(ctx: TemplateContext, from: number, to: number): string | null {
  const t = ctx.lineTokens;
  const head = t[from];
  if (head === undefined || head.type !== 'NAME' || t[from + 1]?.text !== '(' || t[to - 1]?.text !== ')') return null;
  return head.text;
}

export function depthTwoWrapDrafts(ctx: TemplateContext): Draft[] {
  if (ctx.opts.phase !== 'WIDENED' || ctx.site.kind !== 'replace') return [];
  let range: { from: number; to: number } | null = forIterable(ctx);
  let isFor = range !== null;
  if (range === null) {
    const shape = lineShape(ctx);
    if (shape.kind !== 'assign' && shape.kind !== 'return') return [];
    range = { from: shape.from, to: shape.to };
    isFor = false;
  }
  if (isBareLiteral(ctx, range.from, range.to)) return [];
  const e = sliceBody(ctx, range.from, range.to);
  if (e === '') return [];
  const already = outerCallee(ctx, range.from, range.to);
  const base = FAMILY_PRIOR.wrap;
  const out: Draft[] = [];
  // depth-1 whitelist wraps of a `for` iterable (wrap.ts covers assign/return singles)
  if (isFor) for (const w of DEPTH2_WRAPS) if (w !== already) out.push(...lineDraft(ctx, spliceBody(ctx, range.from, range.to, `${w}(${e})`), `wrap_for_${w}`, base));
  let n = 0;
  for (const [outer, inner] of PAIRS) {
    if (n >= DEPTH2_WRAP_LIMIT) break;
    if (inner === already) continue; // `list(list(...))` again
    // plausibility order decays from the family prior to a third of it over the 40 pairs
    const drafts = lineDraft(ctx, spliceBody(ctx, range.from, range.to, `${outer}(${inner}(${e}))`), `wrap2_${outer}_${inner}`, base * (0.95 - (0.6 * n) / DEPTH2_WRAP_LIMIT));
    out.push(...drafts);
    n += drafts.length;
  }
  return out;
}
