/**
 * Call-signature templates (TBar FP10.2-FP10.4, SStuB "Same Function More/Less Args" 3.7 %):
 * on a `def` line, add a parameter taken from a sibling def in the file (with its annotation
 * and default), from the failing test's identifiers, or from a free name in the body; when the
 * new parameter's default is a literal the body uses, the body lines are rewritten to use the
 * parameter (the `pad(text, width, fill=" ")` shape of the ladder `table` task) and, for
 * parameters without a default, same-file call sites gain `name=name`. On any line, add an
 * argument to a call (from a sibling call with the same leading arguments, from the callee's
 * definition, or from nearby names) or remove one.
 */
import type { LineEdit } from '../types.js';
import type { Block, PyModule } from '../py/structure.js';
import type { Draft, TemplateContext } from './common.js';
import { BUILTIN_SET, FAMILY_PRIOR, boundOnLine, dottedEndingAt, findTopLevel, fragmentTokens, isName, isOp, lineDraft, matchClose, sliceBody, spliceBody, splitTopLevel, uniq } from './common.js';
import type { Token } from '../py/tokenize.js';

interface NewParam {
  name: string;
  text: string;
  /** default literal token text when the default is a plain string/number literal */
  defaultLiteral: string | null;
  hasDefault: boolean;
  op: string;
  p: number;
}

/** Render the parameter list with `param` inserted where Python's ordering rules allow. */
function withParam(ctx: TemplateContext, open: number, close: number, param: NewParam): string {
  const parts = splitTopLevel(ctx.lineTokens, ',', open + 1, close).filter(([a, b]) => b > a).map(([a, b]) => sliceBody(ctx, a, b));
  const isStar = (t: string): boolean => t.startsWith('*') || t === '/';
  const hasDefault = (t: string): boolean => findTopLevel(fragmentTokens(t), (u) => isOp(u, '=')) >= 0;
  let at = parts.length;
  if (param.hasDefault) {
    const star = parts.findIndex(isStar);
    at = star >= 0 ? star : parts.length;
  } else {
    // after the last positional parameter without a default
    at = 0;
    parts.forEach((t, k) => {
      if (!isStar(t) && !hasDefault(t)) at = k + 1;
    });
  }
  const next = [...parts.slice(0, at), param.text, ...parts.slice(at)];
  return next.join(', ');
}

function blockAtHeader(mod: PyModule, line: number): Block | undefined {
  return mod.blocks.find((b) => b.kind === 'def' && b.headerLine === line);
}

/** Body lines of `block` that contain literal token `lit`, rewritten to use `name` instead. */
function bodyLiteralEdits(ctx: TemplateContext, block: Block, lit: string, name: string): LineEdit[] {
  const edits: LineEdit[] = [];
  for (let l = block.bodyStart; l <= block.bodyEnd; l++) {
    if (l === block.headerLine) continue;
    const text = ctx.mod.lines[l - 1] ?? '';
    const toks = fragmentTokens(text);
    const hits = toks.filter((t) => (t.type === 'STRING' || t.type === 'NUMBER') && t.text === lit);
    if (hits.length === 0) continue;
    let rebuilt = '';
    let pos = 0;
    for (const h of hits) {
      rebuilt += text.slice(pos, h.start) + name;
      pos = h.end;
    }
    rebuilt += text.slice(pos);
    edits.push({ path: ctx.site.file.path, line: l, kind: 'replace', text: rebuilt });
  }
  return edits;
}

/** Same-file single-line call sites of `fname`, each given `name=name` as a trailing keyword argument. */
function callSiteKeywordEdits(ctx: TemplateContext, fname: string, name: string, headerLine: number): LineEdit[] {
  const edits: LineEdit[] = [];
  for (const st of ctx.mod.statements) {
    if (st.startLine !== st.endLine || st.startLine === headerLine) continue;
    const text = ctx.mod.lines[st.startLine - 1] ?? '';
    const toks = fragmentTokens(text);
    let changed = text;
    let delta = 0;
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k]!;
      if (!isName(t) || t.text !== fname || !isOp(toks[k + 1], '(') || isOp(toks[k - 1], '.')) continue;
      const close = matchClose(toks, k + 1);
      if (close < 0) continue;
      const empty = close === k + 2;
      const insert = `${empty ? '' : ', '}${name}=${name}`;
      const at = toks[close]!.start + delta;
      changed = changed.slice(0, at) + insert + changed.slice(at);
      delta += insert.length;
    }
    if (changed !== text) edits.push({ path: ctx.site.file.path, line: st.startLine, kind: 'replace', text: changed });
  }
  return edits;
}

function addParamDrafts(ctx: TemplateContext, nameIndex: number, open: number, close: number): Draft[] {
  const out: Draft[] = [];
  const base = FAMILY_PRIOR.signature;
  const block = blockAtHeader(ctx.mod, ctx.site.line);
  if (block === undefined) return out;
  const fname = ctx.lineTokens[nameIndex]!.text;
  const existing = new Set(block.params.map((p) => p.name));
  const candidates: NewParam[] = [];
  // (a) parameters of sibling defs; siblings sharing a parameter name are the better donors
  for (const sib of ctx.mod.blocks) {
    if (sib.kind !== 'def' || sib.index === block.index) continue;
    const shared = sib.params.some((p) => existing.has(p.name) && p.name !== 'self' && p.name !== 'cls');
    for (const p of sib.params) {
      if (existing.has(p.name) || p.star !== '' || p.name === 'self' || p.name === 'cls') continue;
      const defToks = p.default === null ? [] : fragmentTokens(p.default);
      const lit = defToks.length === 1 && (defToks[0]!.type === 'STRING' || defToks[0]!.type === 'NUMBER') ? defToks[0]!.text : null;
      candidates.push({ name: p.name, text: p.text, defaultLiteral: lit, hasDefault: p.default !== null, op: 'add_param_sibling', p: shared ? 1 : 0.6 });
    }
  }
  // (b) identifiers named by the failing test
  for (const n of ctx.opts.taskIdentifiers) {
    if (existing.has(n) || BUILTIN_SET.has(n) || ctx.mod.moduleNames.includes(n) || !/^[a-z_][a-z0-9_]*$/.test(n)) continue;
    candidates.push({ name: n, text: `${n}=None`, defaultLiteral: null, hasDefault: true, op: 'add_param_from_test', p: 0.7 });
  }
  // (c) free names the body uses
  const bodyNames = new Set(ctx.fn?.identifiers ?? []);
  const bound = new Set<string>([...ctx.mod.moduleNames, ...block.params.map((p) => p.name)]);
  for (const st of ctx.mod.statements) if (st.startLine >= block.bodyStart && st.startLine <= block.bodyEnd) for (const b of st.binds) bound.add(b);
  for (const n of bodyNames) if (!bound.has(n) && !BUILTIN_SET.has(n)) candidates.push({ name: n, text: n, defaultLiteral: null, hasDefault: false, op: 'add_param_free_name', p: 0.6 });

  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.text)) continue;
    seen.add(c.text);
    const header = spliceBody(ctx, open + 1, close, withParam(ctx, open, close, c));
    const extra: LineEdit[] = [];
    if (c.defaultLiteral !== null) extra.push(...bodyLiteralEdits(ctx, block, c.defaultLiteral, c.name));
    if (!c.hasDefault) extra.push(...callSiteKeywordEdits(ctx, fname, c.name, block.headerLine));
    // the signature alone, and the signature with its consequences in the body / at call sites
    out.push(...lineDraft(ctx, header, c.op, base * c.p * (extra.length > 0 ? 0.9 : 1)));
    if (extra.length > 0) out.push(...lineDraft(ctx, header, `${c.op}_with_edits`, base * c.p, extra));
  }
  return out;
}

interface CallOnLine {
  callee: string;
  open: number;
  close: number;
  args: string[];
  argRanges: [number, number][];
}

function callsOnLine(ctx: TemplateContext): CallOnLine[] {
  const t = ctx.lineTokens;
  const out: CallOnLine[] = [];
  for (let k = 0; k < t.length; k++) {
    if (!isOp(t[k], '(')) continue;
    const callee = dottedEndingAt(t, k - 1);
    if (callee === null) continue;
    const before = t[callee.start - 1];
    if (before !== undefined && before.type === 'NAME' && (before.text === 'def' || before.text === 'class')) continue;
    const close = matchClose(t, k);
    if (close < 0) continue;
    const argRanges = close === k + 1 ? [] : splitTopLevel(t, ',', k + 1, close).filter(([a, b]) => b > a);
    out.push({ callee: callee.text, open: k, close, args: argRanges.map(([a, b]) => sliceBody(ctx, a, b)), argRanges });
  }
  return out;
}

/** Argument lists of every call in the file, rendered token-by-token (for donor matching). */
function fileCallArgs(mod: PyModule): { callee: string; args: string[] }[] {
  const out: { callee: string; args: string[] }[] = [];
  const render = (toks: readonly Token[]): string => toks.map((u) => u.text).join(' ');
  for (const st of mod.statements) {
    const t = st.tokens;
    for (let k = 0; k < t.length; k++) {
      if (!isOp(t[k], '(')) continue;
      const callee = dottedEndingAt(t, k - 1);
      if (callee === null) continue;
      const before = t[callee.start - 1];
      if (before !== undefined && before.type === 'NAME' && (before.text === 'def' || before.text === 'class')) continue;
      let depth = 0;
      let close = -1;
      for (let j = k; j < t.length; j++) {
        const u = t[j]!;
        if (u.type === 'OP' && (u.text === '(' || u.text === '[' || u.text === '{')) depth++;
        else if (u.type === 'OP' && (u.text === ')' || u.text === ']' || u.text === '}')) {
          depth--;
          if (depth === 0) {
            close = j;
            break;
          }
        }
      }
      if (close < 0) continue;
      const parts: string[] = [];
      let start = k + 1;
      depth = 0;
      for (let j = k + 1; j < close; j++) {
        const u = t[j]!;
        if (u.type === 'OP' && (u.text === '(' || u.text === '[' || u.text === '{')) depth++;
        else if (u.type === 'OP' && (u.text === ')' || u.text === ']' || u.text === '}')) depth--;
        else if (depth === 0 && isOp(u, ',')) {
          parts.push(render(t.slice(start, j)));
          start = j + 1;
        }
      }
      if (close > start) parts.push(render(t.slice(start, close)));
      out.push({ callee: callee.text, args: parts });
    }
  }
  return out;
}

/** Parameters of the callee's def in this file or the corpus (by the last dotted component). */
function calleeParams(ctx: TemplateContext, callee: string): string[] | null {
  const short = callee.split('.').pop()!;
  const mods: PyModule[] = [ctx.mod, ...[...ctx.opts.corpus.values()].map((f) => f.mod)];
  for (const m of mods) {
    const def = m.blocks.find((b) => b.kind === 'def' && b.name === short);
    if (def !== undefined) return def.params.filter((p) => p.star === '' && p.name !== 'self' && p.name !== 'cls').map((p) => p.name);
  }
  return null;
}

function callArgDrafts(ctx: TemplateContext): Draft[] {
  const out: Draft[] = [];
  const base = FAMILY_PRIOR.signature;
  const calls = callsOnLine(ctx);
  if (calls.length === 0) return out;
  const donors = fileCallArgs(ctx.mod);
  const norm = (s: string): string => fragmentTokens(s).map((u) => u.text).join(' ');
  // names this line binds are not yet values the call can take (`total = f(v, total)`)
  const bound = boundOnLine(ctx);
  const visible = ctx.names.visible.filter((v) => (ctx.nearby.has(v) || ctx.names.params.includes(v)) && !bound.has(v));
  for (const call of calls) {
    const emitAdd = (arg: string, op: string, p: number): void => {
      const inner = call.args.length === 0 ? arg : `${sliceBody(ctx, call.open + 1, call.close)}, ${arg}`;
      out.push(...lineDraft(ctx, spliceBody(ctx, call.open + 1, call.close, inner), op, base * p));
    };
    const mine = call.args.map(norm);
    // (a) a sibling call with the same leading arguments and one more: `pad_left(cell, width, fill)` for `pad(cell, width)`
    const extras = new Set<string>();
    for (const d of donors) {
      if (d.args.length !== mine.length + 1 || mine.length === 0) continue;
      if (mine.every((a, k) => a === d.args[k])) extras.add(d.args[mine.length]!);
    }
    for (const x of extras) if (!call.args.some((a) => norm(a) === x)) emitAdd(x, 'call_add_arg_sibling', 1);
    // (b) parameters of the callee's definition beyond the arguments given, when a same-named variable is visible
    const params = calleeParams(ctx, call.callee);
    if (params !== null) for (const p of params.slice(call.args.length)) if (ctx.names.visible.includes(p) && !call.args.includes(p)) emitAdd(p, 'call_add_arg_param', 0.9);
    // (c) nearby names as a trailing argument (positional; keyword when the callee has a matching parameter)
    for (const v of visible) {
      if (call.args.includes(v) || v === call.callee) continue;
      emitAdd(v, 'call_add_arg', 0.5);
      if (params !== null && params.includes(v)) emitAdd(`${v}=${v}`, 'call_add_kwarg', 0.6);
    }
    // (d) remove an argument
    if (call.args.length >= 1) {
      call.argRanges.forEach(([, ], idx) => {
        const kept = call.args.filter((_, j) => j !== idx).join(', ');
        out.push(...lineDraft(ctx, spliceBody(ctx, call.open + 1, call.close, kept), 'call_remove_arg', base * (call.args.length >= 2 ? 0.4 : 0.3)));
      });
    }
  }
  return uniq(out.map((d) => JSON.stringify([d.text, d.op]))).map((k) => out.find((d) => JSON.stringify([d.text, d.op]) === k)!);
}

export function signatureDrafts(ctx: TemplateContext): Draft[] {
  if (ctx.site.kind !== 'replace') return [];
  const t = ctx.lineTokens;
  const first = t[0];
  const out: Draft[] = [];
  const isDef = first !== undefined && first.type === 'NAME' && (first.text === 'def' || (first.text === 'async' && t[1]?.text === 'def'));
  if (isDef) {
    const nameIndex = first.text === 'def' ? 1 : 2;
    const open = nameIndex + 1;
    if (isName(t[nameIndex]) && isOp(t[open], '(')) {
      const close = matchClose(t, open);
      if (close > 0) out.push(...addParamDrafts(ctx, nameIndex, open, close));
    }
    return out;
  }
  out.push(...callArgDrafts(ctx));
  return out;
}
