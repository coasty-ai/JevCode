/**
 * Branch templates (TBar FP4.4 / FP14, SPR "copy and replace"): clone a sibling `if`/`elif`
 * branch as a new `elif` with one identifier substituted for another in-scope name, inserted
 * right after the donor branch. Rare in the literature (Defects4J "Copy/Paste" 12.2 % but
 * mostly larger), so the prior is low and the pairs are capped.
 */
import type { LineEdit } from '../types.js';
import type { Statement } from '../py/structure.js';
import type { Draft, TemplateContext } from './common.js';
import { FAMILY_PRIOR, fragmentTokens, identifiersIn, isName, isOp, localityFactor } from './common.js';
import { indentOf, reindent } from '../py/edits.js';

/** Last line of the body of the compound statement `header`. */
export function branchEnd(ctx: TemplateContext, header: Statement): number {
  let end = header.endLine;
  for (const s of ctx.mod.statements) {
    if (s.startLine <= header.endLine) continue;
    if (s.indent <= header.indent) break;
    end = Math.max(end, s.endLine);
  }
  return end;
}

function lastNonBlankBefore(ctx: TemplateContext, line: number): number {
  for (let l = line - 1; l >= 1; l--) {
    const text = ctx.mod.lines[l - 1] ?? '';
    if (text.trim() !== '' && !text.trim().startsWith('#')) return l;
  }
  return 0;
}

/** Replace identifier `from` with `to` in a line (not attributes, not inside strings). */
export function substituteIdentifier(line: string, from: string, to: string): string {
  const toks = fragmentTokens(line);
  let out = '';
  let pos = 0;
  toks.forEach((t, k) => {
    if (!isName(t) || t.text !== from || isOp(toks[k - 1], '.')) return;
    out += line.slice(pos, t.start) + to;
    pos = t.end;
  });
  return out + line.slice(pos);
}

export function branchDrafts(ctx: TemplateContext): Draft[] {
  const { site, mod, lead } = ctx;
  const out: Draft[] = [];
  const base = FAMILY_PRIOR.branch;
  let header: Statement | undefined;
  if (site.kind === 'replace') {
    const st = ctx.stmt;
    if (st !== undefined && (st.kind === 'if' || st.kind === 'elif') && st.startLine === site.line && st.colonIndex !== null && st.colonIndex === st.tokens.length - 1) header = st;
  } else {
    const prevLine = lastNonBlankBefore(ctx, site.line);
    const candidates = mod.statements.filter((s) => (s.kind === 'if' || s.kind === 'elif') && s.indent === lead.length && s.startLine < site.line);
    header = candidates.reverse().find((s) => branchEnd(ctx, s) === prevLine);
  }
  if (header === undefined || header.colonIndex === null) return out;
  const end = branchEnd(ctx, header);
  if (end === header.endLine) return out; // one-liner branches have no body to clone
  const lines = mod.lines.slice(header.startLine - 1, end);
  const ids = identifiersIn(header.tokens.slice(1, header.colonIndex)).filter((n) => ctx.names.visible.includes(n));
  const bodyIds = identifiersIn(lines.slice(1).flatMap((l) => fragmentTokens(l))).filter((n) => ctx.names.visible.includes(n));
  const pairs: [string, string][] = [];
  for (const x of [...ids, ...bodyIds.filter((b) => !ids.includes(b))]) for (const y of ctx.names.visible) if (x !== y && (ctx.nearby.has(y) || ctx.names.params.includes(y))) pairs.push([x, y]);
  const headerIndent = indentOf(lines[0] ?? '');
  for (const [x, y] of pairs.slice(0, 24)) {
    const cloned = lines.map((l) => substituteIdentifier(l, x, y));
    cloned[0] = cloned[0]!.replace(/^(\s*)(if|elif)\b/, '$1elif');
    const block = reindent(cloned.join('\n'), headerIndent);
    const prior = base * localityFactor(ctx, x, y) * (ids.includes(x) ? 1 : 0.8);
    if (site.kind === 'insert') out.push({ text: reindent(block, site.indent), op: 'branch_clone', prior });
    else {
      const edit: LineEdit = { path: site.file.path, line: end + 1, kind: 'insert', text: block };
      out.push({ text: site.currentLine, op: 'branch_clone_after', prior, extraEdits: [edit] });
    }
  }
  return out;
}
