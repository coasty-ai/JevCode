/**
 * Composite candidate source (docs/JEV-ONLY-DESIGN.md §3 source 4): edits no single source
 * proposes, enumerated at one site as one `Candidate` whose follow-up lines travel as
 * `extraEdits` so the patch applies atomically and the tests judge the unit, not its parts.
 *
 *   1. depth-2 pairs — the top-10 single edits at the site (mutation, templates, donors) each
 *      re-enumerated through the same sources on the mutated line, ≤ SECOND_ORDER_LIMIT (100):
 *      `mergesort` (`== 0` → `<= 1`) and `shortest_paths` need depth 2 (coverage-study.md).
 *   2. signature + call-site unit — a `def` gains a parameter (the templates' `add_param_*`
 *      drafts, with their body rewrites) and every call site where a same-named value is in
 *      scope passes it, across files: the ladder `table` task, where the signature hunk alone
 *      fixes nothing and the body hunk alone breaks six tests (bench/data/ladder/README.md).
 *   3. multi-line donor body unit — 3–5 consecutive statements of a sibling function, adapted
 *      as one block with ≤ 2 identifier/attribute substitutions, replacing the statement run
 *      that starts at the site: the ladder `units` task (parse_size → parse_duration).
 *
 * Everything is code, deterministic and pure; priors order enumeration only. This source is
 * unmeasured at this size (design §9 R3): the ladder experiment retires it.
 */
import { createHash } from 'node:crypto';
import { adaptIdentifiers } from '../donor/adapt.js';
import { NON_DONOR_KINDS } from '../donor/corpus.js';
import { createDonorSource } from '../donor/source.js';
import { createMutationSource } from '../mutate/index.js';
import { indentOf, reindent, replaceLine } from '../py/edits.js';
import { jaccard, normaliseLine } from '../py/similarity.js';
import { codeTokens, tokenizeFragment } from '../py/tokenize.js';
import { analyse, blockAt, functionAt, scopeAt } from '../py/structure.js';
import type { Block, LineScope, PyModule, Statement } from '../py/structure.js';
import { dottedEndingAt, fragmentTokens, isName, isOp, matchClose, splitTopLevel } from '../templates/common.js';
import { createTemplateSource, enumerateTemplates } from '../templates/index.js';
import type { Candidate, CandidateSource, EnumerateOptions, LineEdit, Site, SourceFile } from '../types.js';

// ---------------------------------------------------------------------------------------
// Constants (design §3 row 4 and the sizes the ladder tasks need)
// ---------------------------------------------------------------------------------------

/** Depth-2 pairs kept per site (design: `SECOND_ORDER_LIMIT` 100; they are many and rarely the fix). */
export const SECOND_ORDER_LIMIT = 100;
/** Single edits used as depth-2 seeds (design: "the top-10 single edits at one site"). */
export const SECOND_ORDER_SEEDS = 10;
/** Per-source cap while collecting seeds and their second edits (the 255-option bound of one rank request). */
export const SEED_ENUMERATION_CAP = 254;
/** Prior of a pair: the mutation module's own second-order prior (`SECOND_ORDER_PRIOR` 0.3). */
export const PAIR_PRIOR = 0.3;
/** Signature units per site: a def has few plausible new parameters; ladder `table` has one. */
export const SIGNATURE_UNIT_LIMIT = 20;
/** Header drafts asked of the templates per def (the signature family yields tens at most). */
export const HEADER_DRAFT_CAP = 60;
/** Signature units sit below the template family prior (0.7) that produced their header. */
export const SIGNATURE_UNIT_PRIOR = 0.6;
/** Donor body windows: "three-line donor bodies" (design) up to the five gold lines of ladder `units`. */
export const DONOR_UNIT_MIN_LINES = 3;
export const DONOR_UNIT_MAX_LINES = 5;
/** The statement run replaced at the site spans at most this many physical lines (a function tail). */
export const DONOR_UNIT_TARGET_MAX_LINES = 8;
/** Statements of a run replaced at once (ladder `units` replaces three). */
export const DONOR_UNIT_TARGET_MAX_STATEMENTS = 5;
/**
 * Units kept per site: the best (run, window) pair alone yields up to DONOR_UNIT_MAPPINGS
 * adaptations, and the two-substitution gold of ladder `units` sits behind every one-substitution
 * rebinding of the same window, so the cap must hold a whole window's mappings.
 */
export const DONOR_UNIT_LIMIT = 48;
/**
 * Adaptations kept per (target run, donor window): identity, every one-change rebinding, then
 * two-change combinations by preference. Ladder `units` needs `SIZE_UNITS → DURATION_UNITS`
 * together with `upper → lower`; the attribute swap carries no preference score, so the gold
 * sits behind ~35 better-scored mappings of the same window and 32 (the donor default) cuts it.
 */
export const DONOR_UNIT_MAPPINGS = 48;
/** ≤ 2 substitutions per unit: the measured donor coverage bound (SWE ≤ 2 subs 109/199 lines). */
export const DONOR_UNIT_MAX_CHANGES = 2;
export const DONOR_UNIT_PRIOR = 0.5;
/** Ordering bonuses for donor windows (structural priors, ordering only). */
const SAME_STATEMENT_COUNT_BONUS = 0.5;
const BOTH_TAILS_BONUS = 0.5;
const PER_CHANGE_PENALTY = 0.1;

export interface CompositeSourceOptions {
  /** the single-edit sources whose top candidates seed the depth-2 pairs (default: mutation, templates, donors) */
  singles?: readonly CandidateSource[];
  /** the sources applied on top of a seed (default: mutation only, the cheap token operators the design composes) */
  secondSources?: readonly CandidateSource[];
  secondOrderLimit?: number;
  secondOrderSeeds?: number;
  pairs?: boolean;
  signatureUnits?: boolean;
  donorUnits?: boolean;
}

export interface CompositeSource extends CandidateSource {
  enumeratePairs(site: Site, opts: EnumerateOptions): Candidate[];
  enumerateSignatureUnits(site: Site, opts: EnumerateOptions): Candidate[];
  enumerateDonorBodyUnits(site: Site, opts: EnumerateOptions): Candidate[];
}

// ---------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 10);
}

function editsKey(edits: readonly LineEdit[] | undefined): string {
  return JSON.stringify((edits ?? []).map((e) => [e.path, e.line, e.kind, e.text ?? null]));
}

/** Identity of a composite candidate: the site text plus every follow-up edit. */
function candidateKeyOf(text: string, extraEdits: readonly LineEdit[] | undefined): string {
  return `${text}\u0001${editsKey(extraEdits)}`;
}

function makeCandidate(site: Site, text: string, op: string, prior: number, extraEdits: readonly LineEdit[]): Candidate {
  const c: Candidate = {
    id: `composite:${op.split(':')[0]}:${shortHash(`${site.file.path}:${site.line}:${site.kind}:${candidateKeyOf(text, extraEdits)}`)}`,
    site,
    text,
    source: 'composite',
    op,
    prior: Math.max(0, Math.min(1, prior)),
  };
  if (extraEdits.length > 0) c.extraEdits = extraEdits;
  return c;
}

/** A replace site at `line` of `file` built from the analysis alone (for synthetic def-header sites). */
function replaceSiteFor(file: SourceFile, line: number): Site {
  const text = file.mod.lines[line - 1] ?? '';
  const b = blockAt(file.mod, line);
  return {
    file,
    line,
    kind: 'replace',
    currentLine: text,
    indent: indentOf(text),
    block: b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine },
    scope: scopeAt(file.mod, line),
    evidence: { notes: ['composite synthetic site'] },
  };
}

/** Innermost `def` block whose body (not header) contains `line`. */
function enclosingDef(mod: PyModule, line: number): Block | undefined {
  let b = blockAt(mod, line);
  while (b !== undefined && b.kind !== 'def') b = b.parent === null ? undefined : mod.blocks[b.parent];
  return b !== undefined && line > b.headerEndLine ? b : undefined;
}

function isDocstring(st: Statement): boolean {
  return st.kind === 'expr' && st.tokens.length > 0 && st.tokens.every((t) => t.type === 'STRING');
}

/** Files that may hold call sites or donors: the site's own file first, then the corpus without a stale copy of it. */
function workspaceFiles(site: Site, opts: EnumerateOptions): SourceFile[] {
  return [site.file, ...[...opts.corpus.values()].filter((f) => f.path !== site.file.path)];
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------
// 1. Depth-2 pairs
// ---------------------------------------------------------------------------------------

/** The site with `text` in place of its line: the file is re-analysed so scope-driven sources see the new line. */
export function derivedSite(site: Site, text: string): Site | null {
  if (site.kind !== 'replace' || text.includes('\n')) return null;
  try {
    const src = replaceLine(site.file.src, site.line, text);
    const mod = analyse(src);
    const file: SourceFile = { path: site.file.path, src, mod };
    return { ...site, file, currentLine: text, indent: indentOf(text), scope: scopeAt(mod, site.line) };
  } catch {
    return null;
  }
}

/** Exact code tokens of a line (whitespace-insensitive identity; `normaliseLine` would collapse `0` and `1` into one shape). */
function lineToks(text: string): string[] {
  try {
    return codeTokens(tokenizeFragment(text)).map((t) => t.text);
  } catch {
    return [text.trim()];
  }
}

function lineSig(text: string): string {
  return lineToks(text).join('\u0000');
}

/** Token range [first, last] of `text` that differs from `base` (from both ends); null when equal. */
function changedSpan(base: readonly string[], text: readonly string[]): { from: number; to: number } | null {
  let from = 0;
  while (from < base.length && from < text.length && base[from] === text[from]) from++;
  let tailB = base.length - 1;
  let tailT = text.length - 1;
  while (tailB >= from && tailT >= from && base[tailB] === text[tailT]) {
    tailB--;
    tailT--;
  }
  if (from > tailB && from > tailT) return null;
  return { from, to: Math.max(tailB, tailT) };
}

export function enumeratePairs(site: Site, opts: EnumerateOptions, singles: readonly CandidateSource[], second: readonly CandidateSource[], limit = SECOND_ORDER_LIMIT, seeds = SECOND_ORDER_SEEDS): Candidate[] {
  if (site.kind !== 'replace' || limit <= 0 || seeds <= 0) return [];
  const seedOpts: EnumerateOptions = { ...opts, cap: SEED_ENUMERATION_CAP };
  const perSource = singles.map((s) => s.enumerate(site, seedOpts));
  const firstOrder = perSource.flat();
  const baseSig = lineSig(site.currentLine);
  const baseToks = lineToks(site.currentLine);
  const known = new Set<string>([baseSig, ...firstOrder.map((c) => candidateKeyOf(c.text, c.extraEdits))]);
  // seeds: single-line, edit-free first-order candidates in each source's own (prior) order,
  // taken round-robin across the sources so the prolific template families cannot crowd out
  // the token mutations the measured depth-2 fixes are made of
  const seenSeed = new Set<string>([baseSig]);
  const chosen: Candidate[] = [];
  const queues = perSource.map((list) => list.filter((c) => !c.text.includes('\n') && (c.extraEdits === undefined || c.extraEdits.length === 0)));
  const usedOps = new Set<string>();
  // pass 1 takes one candidate per operator per source in turn (so one prolific operator such as
  // `off_by_one_atom` does not fill every seed slot); pass 2 fills what is left in source order
  for (const distinctOps of [true, false]) {
    let more = true;
    while (more && chosen.length < seeds) {
      more = false;
      for (const q of queues) {
        const next = q.find((c) => !seenSeed.has(lineSig(c.text)) && (!distinctOps || !usedOps.has(c.op)));
        if (next === undefined || chosen.length >= seeds) continue;
        seenSeed.add(lineSig(next.text));
        usedOps.add(next.op);
        chosen.push(next);
        more = true;
      }
    }
  }
  // second edits per seed on a token span disjoint from the seed's (an edit on the same span is
  // just another first-order variant), then round-robin so the cap never lets one seed take every slot
  const perSeed: { seed: Candidate; second: Candidate[] }[] = [];
  for (const seed of chosen) {
    const derived = derivedSite(site, seed.text);
    if (derived === null) continue;
    const seedToks = lineToks(seed.text);
    const seedSpan = changedSpan(baseToks, seedToks);
    const candidates = second
      .flatMap((s) => s.enumerate(derived, seedOpts))
      .filter((c) => !c.text.includes('\n'))
      .filter((c) => {
        const span = changedSpan(seedToks, lineToks(c.text));
        return span !== null && (seedSpan === null || span.to < seedSpan.from || span.from > seedSpan.to);
      });
    perSeed.push({ seed, second: candidates });
  }
  const out: Candidate[] = [];
  const cursors = perSeed.map(() => 0);
  let progressed = true;
  while (progressed && out.length < limit) {
    progressed = false;
    perSeed.forEach(({ seed, second }, i) => {
      while (cursors[i]! < second.length && out.length < limit) {
        const c = second[cursors[i]!]!;
        cursors[i]! += 1;
        progressed = true;
        const key = candidateKeyOf(c.text, c.extraEdits);
        if (known.has(key) || lineSig(c.text) === baseSig) continue;
        known.add(key);
        // extra edits of the second edit refer to the derived file, whose numbering equals the site file's
        out.push(makeCandidate(site, c.text, `pair:${seed.op}>${c.op}`, PAIR_PRIOR * Math.max(0.1, (seed.prior ?? 0.5) * (c.prior ?? 0.5)) * 2, c.extraEdits ?? []));
        break;
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// 2. Signature + call-site unit
// ---------------------------------------------------------------------------------------

export interface HeaderDraft {
  file: SourceFile;
  block: Block;
  /** the new `def` line */
  header: string;
  /** body rewrites the templates attached (same file, e.g. the default literal replaced by the parameter) */
  bodyEdits: readonly LineEdit[];
  paramName: string;
  hasDefault: boolean;
  op: string;
  prior: number;
}

/** First identifier of each top-level entry in a parameter list rendered as tokens. */
function paramNames(header: string): string[] | null {
  const t = fragmentTokens(header);
  const first = t[0];
  if (first === undefined || first.type !== 'NAME') return null;
  const nameIndex = first.text === 'def' ? 1 : first.text === 'async' ? 2 : -1;
  if (nameIndex < 0 || !isName(t[nameIndex]) || !isOp(t[nameIndex + 1], '(')) return null;
  const open = nameIndex + 1;
  const close = matchClose(t, open);
  if (close < 0) return null;
  const out: string[] = [];
  for (const [a, b] of splitTopLevel(t, ',', open + 1, close)) {
    if (b <= a) continue;
    const n = t.slice(a, b).find((u) => u.type === 'NAME');
    if (n !== undefined) out.push(n.text);
  }
  return out;
}

/** The parameter `header` adds over `block`'s own, with whether it has a default; null unless exactly one was added. */
export function addedParameter(block: Block, header: string): { name: string; hasDefault: boolean } | null {
  const names = paramNames(header);
  if (names === null) return null;
  const existing = new Set(block.params.map((p) => p.name));
  const added = names.filter((n) => !existing.has(n));
  if (added.length !== 1) return null;
  const name = added[0]!;
  const t = fragmentTokens(header);
  const open = t.findIndex((u) => isOp(u, '('));
  const close = matchClose(t, open);
  const entry = splitTopLevel(t, ',', open + 1, close).find(([a, b]) => t.slice(a, b).some((u) => u.type === 'NAME' && u.text === name));
  const hasDefault = entry !== undefined && t.slice(entry[0], entry[1]).some((u) => isOp(u, '='));
  return { name, hasDefault };
}

/**
 * New-parameter drafts for one def from the templates' signature family, deduplicated per
 * parameter name (the variant carrying body rewrites wins over the bare header).
 */
export function headerDrafts(file: SourceFile, block: Block, opts: EnumerateOptions): HeaderDraft[] {
  if (block.kind !== 'def' || block.headerLine !== block.headerEndLine) return [];
  const defSite = replaceSiteFor(file, block.headerLine);
  const cands = enumerateTemplates(defSite, { ...opts, cap: HEADER_DRAFT_CAP }, ['signature']).filter((c) => c.op.startsWith('add_param'));
  const best = new Map<string, HeaderDraft>();
  for (const c of cands) {
    const added = addedParameter(block, c.text);
    if (added === null) continue;
    const bodyEdits = (c.extraEdits ?? []).filter((e) => e.path === file.path && e.line !== block.headerLine);
    const key = `${added.name}\u0000${c.text}`;
    const cur = best.get(key);
    if (cur !== undefined && cur.bodyEdits.length >= bodyEdits.length) continue;
    best.set(key, { file, block, header: c.text, bodyEdits, paramName: added.name, hasDefault: added.hasDefault, op: c.op, prior: c.prior ?? 0.5 });
  }
  return [...best.values()];
}

function positionalBounds(block: Block): { min: number; max: number } {
  const own = block.params.filter((p) => p.star === '' && p.name !== 'self' && p.name !== 'cls');
  return { min: own.filter((p) => p.default === null).length, max: own.length };
}

function visibleAt(mod: PyModule, line: number, name: string): boolean {
  const s: LineScope = scopeAt(mod, line);
  return s.params.includes(name) || s.locals.includes(name) || s.module.includes(name);
}

interface CallOnLine {
  /** token index of the callee name */
  nameIndex: number;
  open: number;
  close: number;
  argCount: number;
  /** some argument is already a keyword argument */
  hasKeyword: boolean;
  /** the parameter is already passed (positionally beyond the old arity, or by name) */
  passesName: (name: string) => boolean;
}

/** Calls of `fname` on one line: bare `fname(`, or `alias.fname(` when `alias` is an import binding at that line. */
function callsOf(mod: PyModule, line: number, text: string, fname: string): CallOnLine[] {
  const t = fragmentTokens(text);
  const out: CallOnLine[] = [];
  const scope = scopeAt(mod, line);
  for (let k = 0; k < t.length; k++) {
    if (!isName(t[k]) || t[k]!.text !== fname || !isOp(t[k + 1], '(')) continue;
    if (isOp(t[k - 1], '.')) {
      const recv = dottedEndingAt(t, k - 2);
      if (recv === null || !scope.imports.includes(recv.text)) continue;
    }
    const open = k + 1;
    const close = matchClose(t, open);
    if (close < 0) continue;
    const ranges = close === open + 1 ? [] : splitTopLevel(t, ',', open + 1, close).filter(([a, b]) => b > a);
    const args = ranges.map(([a, b]) => t.slice(a, b));
    out.push({
      nameIndex: k,
      open,
      close,
      argCount: args.length,
      hasKeyword: args.some((arg) => arg.some((u) => isOp(u, '='))),
      passesName: (name) => args.some((arg) => arg.length >= 2 && arg[0]!.type === 'NAME' && arg[0]!.text === name && isOp(arg[1], '=')),
    });
  }
  return out;
}

/** `text` with `arg` appended to the argument list of `call`. */
function withArgument(text: string, call: CallOnLine, arg: string): string {
  const t = fragmentTokens(text);
  const closeTok = t[call.close];
  if (closeTok === undefined) return text;
  // token offsets index into `text` itself (leading whitespace included)
  const at = closeTok.start;
  const sep = call.argCount === 0 ? '' : ', ';
  return `${text.slice(0, at)}${sep}${arg}${text.slice(at)}`;
}

/**
 * The argument a call site passes for the new parameter, or null when the value is not in
 * scope there (a defaulted parameter is then left to its default; an undefaulted one cannot be
 * threaded). Positional when every existing parameter is passed positionally and in full,
 * keyword otherwise (the same rule the templates' same-file call edits follow).
 */
function threadedArgument(draft: HeaderDraft, call: CallOnLine, mod: PyModule, line: number): string | null {
  const { min, max } = positionalBounds(draft.block);
  if (call.argCount < min || call.argCount > max || call.passesName(draft.paramName)) return null;
  if (!visibleAt(mod, line, draft.paramName)) return null;
  const positional = draft.hasDefault && call.argCount === max && !call.hasKeyword;
  return positional ? draft.paramName : `${draft.paramName}=${draft.paramName}`;
}

/** Edits threading `draft.paramName` through every call of the def across `files`, except lines in `skip` (`path:line`). */
export function callSiteEdits(draft: HeaderDraft, files: readonly SourceFile[], skip: ReadonlySet<string>): LineEdit[] {
  const edits: LineEdit[] = [];
  for (const f of files) {
    for (const st of f.mod.statements) {
      if (st.startLine !== st.endLine || skip.has(`${f.path}:${st.startLine}`)) continue;
      if (f.path === draft.file.path && st.startLine === draft.block.headerLine) continue;
      const text = f.mod.lines[st.startLine - 1] ?? '';
      let changed = text;
      // right to left so earlier offsets stay valid
      for (const call of callsOf(f.mod, st.startLine, text, draft.block.name).reverse()) {
        const arg = threadedArgument(draft, call, f.mod, st.startLine);
        if (arg !== null) changed = withArgument(changed, call, arg);
      }
      if (changed !== text) edits.push({ path: f.path, line: st.startLine, kind: 'replace', text: changed });
    }
  }
  return edits;
}

/** The def a call on the site line targets: in the site's file first (not the enclosing def itself), then the corpus. */
function calleeBlocks(site: Site, opts: EnumerateOptions): { file: SourceFile; block: Block; fname: string }[] {
  const t = fragmentTokens(site.currentLine);
  const names = new Set<string>();
  for (let k = 0; k < t.length; k++) if (isName(t[k]) && isOp(t[k + 1], '(')) names.add(t[k]!.text);
  const own = enclosingDef(site.file.mod, site.line);
  const out: { file: SourceFile; block: Block; fname: string }[] = [];
  for (const fname of names) {
    for (const f of workspaceFiles(site, opts)) {
      const def = f.mod.blocks.find((b) => b.kind === 'def' && b.name === fname && !(f.path === site.file.path && own !== undefined && b.index === own.index));
      if (def === undefined) continue;
      out.push({ file: f, block: def, fname });
      break;
    }
  }
  return out;
}

export function enumerateSignatureUnits(site: Site, opts: EnumerateOptions, limit = SIGNATURE_UNIT_LIMIT): Candidate[] {
  if (site.kind !== 'replace' || limit <= 0) return [];
  const files = workspaceFiles(site, opts);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const emit = (text: string, extra: LineEdit[], draft: HeaderDraft, where: string): void => {
    if (out.length >= limit) return;
    const key = candidateKeyOf(text, extra);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(makeCandidate(site, text, `signature_unit:${draft.op}:${where}`, SIGNATURE_UNIT_PRIOR * draft.prior, extra));
  };
  const headerEdit = (d: HeaderDraft): LineEdit => ({ path: d.file.path, line: d.block.headerLine, kind: 'replace', text: d.header });

  // (A) the site is inside the def that gains the parameter: the unit is the header, the body
  //     rewrites and every call site; the site line carries its own rewrite when it has one.
  const own = enclosingDef(site.file.mod, site.line);
  if (own !== undefined) {
    for (const d of headerDrafts(site.file, own, opts)) {
      const skip = new Set<string>([`${site.file.path}:${site.line}`, ...d.bodyEdits.map((e) => `${e.path}:${e.line}`)]);
      const calls = callSiteEdits(d, files, skip);
      if (calls.length === 0) continue; // the templates alone already offer header + body; the unit exists for the threading
      const atSite = d.bodyEdits.find((e) => e.line === site.line);
      const text = atSite?.text ?? site.currentLine;
      const extra: LineEdit[] = [headerEdit(d), ...d.bodyEdits.filter((e) => e.line !== site.line), ...calls];
      emit(text, extra, d, 'from_body');
    }
  }

  // (B) the site line calls a def defined elsewhere: the site passes the new argument; the
  //     header, body rewrites and the other call sites travel as extra edits.
  for (const { file, block } of calleeBlocks(site, opts)) {
    for (const d of headerDrafts(file, block, opts)) {
      const calls = callsOf(site.file.mod, site.line, site.currentLine, block.name);
      let text = site.currentLine;
      for (const call of [...calls].reverse()) {
        const arg = threadedArgument(d, call, site.file.mod, site.line);
        if (arg !== null) text = withArgument(text, call, arg);
      }
      if (text === site.currentLine) continue;
      const skip = new Set<string>([`${site.file.path}:${site.line}`, ...d.bodyEdits.map((e) => `${e.path}:${e.line}`)]);
      const extra: LineEdit[] = [headerEdit(d), ...d.bodyEdits, ...callSiteEdits(d, files, skip)];
      emit(text, extra, d, 'from_call');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// 3. Multi-line donor body unit
// ---------------------------------------------------------------------------------------

interface StatementRun {
  statements: Statement[];
  startLine: number;
  /** last physical line, trailing blanks and comments trimmed */
  endLine: number;
  /** the run reaches the end of its block */
  isTail: boolean;
}

/** Last code line at or before `line` (blank and comment lines trimmed). */
function trimEnd(mod: PyModule, line: number, floor: number): number {
  let l = line;
  while (l > floor) {
    const t = (mod.lines[l - 1] ?? '').trim();
    if (t !== '' && !t.startsWith('#')) break;
    l--;
  }
  return l;
}

/**
 * Consecutive statements of `block` at the indent of the statement starting at `startLine`,
 * beginning there: one run per prefix length (1..max statements), each with the physical span
 * its compound bodies occupy. Empty when `startLine` does not start a statement of `block`.
 */
export function statementRuns(mod: PyModule, block: Block, startLine: number, maxStatements: number): StatementRun[] {
  const first = mod.statements.find((s) => s.startLine === startLine && s.blockIndex === block.index);
  if (first === undefined) return [];
  const later = mod.statements.filter((s) => s.blockIndex === block.index && s.startLine > startLine).sort((a, b) => a.startLine - b.startLine);
  const siblings: Statement[] = [first];
  let stop: Statement | undefined;
  for (const s of later) {
    if (s.indent < first.indent) {
      stop = s;
      break;
    }
    if (s.indent === first.indent) siblings.push(s);
  }
  const runs: StatementRun[] = [];
  for (let k = 1; k <= Math.min(siblings.length, maxStatements); k++) {
    const next = siblings[k] ?? stop;
    const rawEnd = next === undefined ? block.bodyEnd : next.startLine - 1;
    const endLine = trimEnd(mod, rawEnd, siblings[k - 1]!.endLine);
    runs.push({ statements: siblings.slice(0, k), startLine, endLine, isTail: next === undefined || (stop !== undefined && next === stop) });
  }
  return runs;
}

interface DonorWindow {
  file: SourceFile;
  block: Block;
  startLine: number;
  endLine: number;
  statementCount: number;
  isTail: boolean;
  /** the window's lines re-indented so its first line sits at `indent` */
  text: string;
}

function codeLineCount(mod: PyModule, start: number, end: number): number {
  let n = 0;
  for (let l = start; l <= end; l++) {
    const t = (mod.lines[l - 1] ?? '').trim();
    if (t !== '' && !t.startsWith('#')) n++;
  }
  return n;
}

/** Windows of consecutive direct body statements of `block` with DONOR_UNIT_MIN_LINES..MAX code lines. */
export function donorWindows(file: SourceFile, block: Block, indent: string): DonorWindow[] {
  const mod = file.mod;
  const top = mod.statements.filter((s) => s.blockIndex === block.index && s.indent === block.bodyIndent && !NON_DONOR_KINDS.has(s.kind) && !isDocstring(s)).sort((a, b) => a.startLine - b.startLine);
  const out: DonorWindow[] = [];
  for (let i = 0; i < top.length; i++) {
    for (let m = 1; i + m <= top.length; m++) {
      const next = top[i + m];
      const rawEnd = next === undefined ? block.bodyEnd : next.startLine - 1;
      const endLine = trimEnd(mod, rawEnd, top[i + m - 1]!.endLine);
      const lines = codeLineCount(mod, top[i]!.startLine, endLine);
      if (lines > DONOR_UNIT_MAX_LINES) break;
      if (lines < DONOR_UNIT_MIN_LINES) continue;
      const raw = mod.lines.slice(top[i]!.startLine - 1, endLine).join('\n');
      out.push({ file, block, startLine: top[i]!.startLine, endLine, statementCount: m, isTail: next === undefined, text: reindent(raw, indent) });
    }
  }
  return out;
}

/** Def blocks that may donate to `site`: same file (not the enclosing def nor its ancestors/descendants) first, then the corpus. */
function donorBlocks(site: Site, opts: EnumerateOptions, own: Block): { file: SourceFile; block: Block; tier: number }[] {
  const out: { file: SourceFile; block: Block; tier: number }[] = [];
  const related = (b: Block): boolean => (b.startLine <= own.startLine && b.endLine >= own.endLine) || (b.startLine >= own.startLine && b.endLine <= own.endLine);
  for (const b of site.file.mod.blocks) if (b.kind === 'def' && !related(b)) out.push({ file: site.file, block: b, tier: 0 });
  for (const f of [...opts.corpus.values()].filter((f) => f.path !== site.file.path)) for (const b of f.mod.blocks) if (b.kind === 'def') out.push({ file: f, block: b, tier: 1 });
  return out;
}

/** Site scope plus the names the transplanted block binds itself (loop variables, assignment targets). */
function unitScope(site: Site, run: StatementRun, donor: DonorWindow): LineScope {
  const bound = new Set<string>(site.scope.locals);
  for (const s of run.statements) for (const n of s.binds) if (n !== '*') bound.add(n);
  for (const s of donor.file.mod.statements) if (s.startLine >= donor.startLine && s.startLine <= donor.endLine) for (const n of s.binds) if (n !== '*') bound.add(n);
  const locals = [...bound];
  return { ...site.scope, locals, all: [...new Set([...site.scope.params, ...locals, ...site.scope.module, ...site.scope.imports, ...site.scope.builtins])] };
}

export function enumerateDonorBodyUnits(site: Site, opts: EnumerateOptions, limit = DONOR_UNIT_LIMIT): Candidate[] {
  if (site.kind !== 'replace' || limit <= 0) return [];
  const mod = site.file.mod;
  const own = enclosingDef(mod, site.line);
  if (own === undefined) return [];
  const runs = statementRuns(mod, own, site.line, DONOR_UNIT_TARGET_MAX_STATEMENTS).filter((r) => r.endLine - r.startLine + 1 <= DONOR_UNIT_TARGET_MAX_LINES);
  if (runs.length === 0) return [];
  const preferred = functionAt(mod, site.line)?.identifiers ?? mod.moduleNames;
  interface Draft {
    text: string;
    run: StatementRun;
    donor: DonorWindow;
    changes: number;
    /** how well the donor window matches the replaced run (shape similarity + structural bonuses) */
    score: number;
    /** the adaptation's Σ target preference (donor/adapt.ts), ordering inside one window */
    preference: number;
    tier: number;
  }
  const drafts: Draft[] = [];
  const seen = new Set<string>();
  for (const { file, block, tier } of donorBlocks(site, opts, own)) {
    for (const donor of donorWindows(file, block, site.indent)) {
      const donorScope = scopeAt(file.mod, donor.endLine);
      for (const run of runs) {
        const target = mod.lines.slice(run.startLine - 1, run.endLine).join('\n');
        const targetSig = normaliseLine(target);
        const similarity = jaccard(targetSig, normaliseLine(donor.text));
        const structural = (run.statements.length === donor.statementCount ? SAME_STATEMENT_COUNT_BONUS : 0) + (run.isTail && donor.isTail ? BOTH_TAILS_BONUS : 0);
        for (const a of adaptIdentifiers(donor.text, unitScope(site, run, donor), { maxChanges: DONOR_UNIT_MAX_CHANGES, maxMappings: DONOR_UNIT_MAPPINGS, preferred, taskIdentifiers: opts.taskIdentifiers, donorScope })) {
          if (normaliseLine(a.text).join(' ') === targetSig.join(' ')) continue;
          const key = `${run.endLine}\u0000${a.text}`;
          if (seen.has(key)) continue;
          seen.add(key);
          drafts.push({ text: a.text, run, donor, changes: a.changes, score: similarity + structural, preference: a.score, tier });
        }
      }
    }
  }
  // best-matching window first; inside a window the preferred rebindings, then fewer changes
  drafts.sort((x, y) => y.score - x.score || x.tier - y.tier || y.preference - x.preference || x.changes - y.changes || byCodePoint(x.donor.file.path, y.donor.file.path) || x.donor.startLine - y.donor.startLine || byCodePoint(x.text, y.text));
  const out: Candidate[] = [];
  for (const d of drafts.slice(0, limit)) {
    // the block replaces the run's first line; the run's other lines are deleted (numbers refer to the file before the edit)
    const extra: LineEdit[] = [];
    for (let l = d.run.startLine + 1; l <= d.run.endLine; l++) extra.push({ path: site.file.path, line: l, kind: 'delete' });
    out.push(makeCandidate(site, d.text, `donor_body_unit:${d.donor.block.name}:${d.donor.statementCount}stmt`, DONOR_UNIT_PRIOR - PER_CHANGE_PENALTY * d.changes - 0.1 * d.tier, extra));
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------------------

export function createCompositeSource(options: CompositeSourceOptions = {}): CompositeSource {
  const singles = options.singles ?? [createMutationSource(), createTemplateSource(), createDonorSource()];
  const second = options.secondSources ?? [createMutationSource()];
  const limit = options.secondOrderLimit ?? SECOND_ORDER_LIMIT;
  const seeds = options.secondOrderSeeds ?? SECOND_ORDER_SEEDS;
  const pairs = options.pairs ?? true;
  const signature = options.signatureUnits ?? true;
  const donors = options.donorUnits ?? true;
  const src: CompositeSource = {
    name: 'composite',
    enumeratePairs: (site, opts) => enumeratePairs(site, opts, singles, second, limit, seeds),
    enumerateSignatureUnits: (site, opts) => enumerateSignatureUnits(site, opts),
    enumerateDonorBodyUnits: (site, opts) => enumerateDonorBodyUnits(site, opts),
    enumerate(site: Site, opts: EnumerateOptions): Candidate[] {
      // units first: a handful of high-value coupled edits, then the many pairs; `opts.cap` cuts the tail
      const out: Candidate[] = [];
      const seen = new Set<string>();
      const add = (cands: readonly Candidate[]): void => {
        for (const c of cands) {
          if (out.length >= opts.cap) return;
          const k = candidateKeyOf(c.text, c.extraEdits);
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(c);
        }
      };
      if (signature) add(src.enumerateSignatureUnits(site, opts));
      if (donors) add(src.enumerateDonorBodyUnits(site, opts));
      if (pairs) add(src.enumeratePairs(site, opts));
      return out;
    },
  };
  return src;
}
