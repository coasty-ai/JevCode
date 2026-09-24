/**
 * From ranked line anchors to Sites: a ±window of code lines around every anchor (clipped to the
 * enclosing function, or to module-level code outside every def), plus an insert gap before and
 * after each anchor so insertion bugs (4/40 QuixBugs, missed by every line question) still get
 * candidates. Evidence is code-computed: the line's own Choice probability, its SBFL rank and
 * score, and notes such as "in traceback". Order: anchors first, then their insert gaps, then
 * neighbours by distance, so a consumer that stops after k sites gets the best k.
 *
 * Statement-level sites (experiments/results/swebench-reach-oracle-9.md capability 4): when a
 * replace line belongs to a multi-line logical statement, the statement joined onto one line is a
 * site of its own (`Site.endLine` marks the span, verify/apply.ts replaces it whole), so the
 * sources see `return hash((a, b, c))` instead of `return hash((` and a candidate cannot leave the
 * continuation lines dangling (django-15315: 1,143 of 2,171 physical-line candidates broke the
 * module import). At the statement's first line the statement site stands IN PLACE of the
 * physical-line site (search/sites.ts keys sites by path:line:kind, so two sites at one line would
 * be one there and the physical one would win); at a later line of the statement it is added once.
 */
import { indentOf } from '../py/edits.js';
import { blockAt, scopeAt, statementAt } from '../py/structure.js';
import type { PyModule, Statement } from '../py/structure.js';
import type { RankedLine } from '../sbfl/types.js';
import type { Site, SiteEvidence, SourceFile } from '../types.js';
import { codeLines, entryAt, functionEntries, moduleCodeLines } from './outline.js';
import type { FunctionEntry, TracebackFrame } from './types.js';

/**
 * SBFL lines unioned with the Jev anchors as replace sites, never score-combined (Ochiai is
 * top-1 on 7/38 QuixBugs programs with heavy ties but top-5 on 34/38; `lis` Einspect 3.0,
 * `mergesort` 5.0: experiments/results/lit-search-based-repair.md §6). Single-file workspaces
 * take five because the two localisation misses of the prototype sat at Ochiai rank 3–5;
 * repositories take three because a repo-wide spectrum has far more tied lines per rank.
 */
export const SBFL_ANCHORS_SINGLE_FILE = 5;
export const SBFL_ANCHORS_REPO = 3;

/** How many SBFL lines to union for a workspace of `fileCount` Python files. */
export function sbflAnchorsFor(fileCount: number): number {
  return fileCount <= 1 ? SBFL_ANCHORS_SINGLE_FILE : SBFL_ANCHORS_REPO;
}

export interface Anchor {
  file: SourceFile;
  line: number;
  /** enclosing flattened function, or null for module-level code */
  entry: FunctionEntry | null;
  /** P(line) from the line Choice when this anchor came from Jev */
  jevProbability?: number;
  /** P(line) of every option line of the same Choice, for the neighbours' evidence */
  lineProbabilities: ReadonlyMap<number, number>;
  notes: string[];
}

export interface SiteBuildInput {
  anchors: readonly Anchor[];
  /** `${path}:${line}` -> SBFL row */
  sbfl: ReadonlyMap<string, RankedLine>;
  frames: readonly TracebackFrame[];
  window: number;
  /**
   * When set, the `sbflAnchors` best-ranked SBFL lines that are not already anchors become
   * replace sites of their own (after every Jev-derived site, by Ochiai rank; `def` lines and
   * lines outside the given files skipped). Resolved by `files` (path -> file); an SBFL row
   * whose path is not in `files` is ignored.
   */
  sbflAnchors?: number;
  files?: ReadonlyMap<string, SourceFile>;
}

export function sbflKey(path: string, line: number): string {
  return `${path}:${line}`;
}

// ---------------------------------------------------------------------------------------
// Gaps: where a statement may legally go, and at which indentation
// ---------------------------------------------------------------------------------------

/**
 * Control-flow position of a gap, for ordering: the first line of a block after its header
 * (`else:` → `nodesvisited.add(node)`, depth_first_search), the end of a block where the next
 * statement dedents (`shunting_yard`'s `opstack.append(token)` after the inner `while`,
 * `wrap`'s `lines.append(text)` after the loop), or between two statements of one block
 * (`reverse_linked_list`'s `prevnode = node`).
 */
export type GapPosition = 'after_header' | 'block_end' | 'mid_block';

/** One legal insertion slot: the gap before physical `line`, at `indent`. */
export interface GapSlot {
  /** the line the new statement goes before (`Site.line` of an insert site) */
  line: number;
  indent: string;
  /** first line of the statement the gap follows (the `def` line for the gap before the first body statement) */
  afterLine: number;
  /** first line of the next statement of the function, or null at the function's end */
  nextLine: number | null;
  position: GapPosition;
  /** blocks the slot closes relative to the statement it follows (0 = same block, 1 = the enclosing block, ...) */
  dedent: number;
}

const TERMINAL_KINDS: ReadonlySet<Statement['kind']> = new Set(['return', 'raise', 'break', 'continue']);
const CLAUSE_KINDS: ReadonlySet<Statement['kind']> = new Set(['else', 'elif', 'except', 'finally']);

function isHeaderStatement(st: Statement): boolean {
  return st.header && st.colonIndex !== null && st.colonIndex === st.tokens.length - 1;
}

/** Indent unit of the file (smallest header → body step; 4 spaces when the file has no block). */
function indentUnitOf(file: SourceFile): string {
  let best = Number.POSITIVE_INFINITY;
  for (const b of file.mod.blocks) {
    const d = b.bodyIndent - b.indent;
    if (d > 0 && d < best) best = d;
  }
  if (!Number.isFinite(best)) best = 4;
  return file.mod.lines.some((l) => l.startsWith('\t')) && best === 8 ? '\t' : ' '.repeat(best);
}

/** Body indent (columns) of the innermost def/class containing `line`; 0 at module level. */
function bodyIndentAt(file: SourceFile, line: number): number {
  const b = blockAt(file.mod, line);
  return b === undefined ? 0 : b.bodyIndent;
}

export interface GapIndents {
  /** legal indents for a statement inserted right after the statement at `afterLine`, most likely first; [] when nothing legal (dead code after a `return` that closes no block) */
  indents: string[];
  position: GapPosition;
  /** `indents[k]` closes this many blocks */
  dedents: number[];
  /** end line of the statement the gap follows */
  endLine: number;
  /** first line of the next statement inside the span, or null */
  nextLine: number | null;
}

/**
 * The indents a new statement may take directly after the statement at `line`, most likely
 * first, from the structure alone:
 *   - after a compound header (`if c:`, `else:`, `for ...:`): the body indent only;
 *   - otherwise every block open there — the statement's own indent and the indent of each
 *     enclosing compound statement down to the function body (`spanEnd` bounds the function) —
 *     minus the levels the NEXT statement forbids: nothing shallower than the next statement,
 *     nothing at or above a clause header (`else:` / `elif` / `except` / `finally`, which must
 *     follow its block directly), and never the same indent after `return` / `raise` / `break` /
 *     `continue` (dead code).
 * Order: the enclosing block first when the next statement dedents (both measured QuixBugs
 * block-end insertions, `shunting_yard` and `wrap`, sit one level out of the block that ends),
 * then the statement's own block, then the further enclosing levels.
 */
export function gapIndentsAfter(file: SourceFile, line: number, spanEnd: number = file.mod.lines.length): GapIndents {
  const mod = file.mod;
  const st = statementAt(mod, line);
  const text = mod.lines[line - 1] ?? '';
  if (st === undefined) return { indents: [indentOf(text)], position: 'mid_block', dedents: [0], endLine: line, nextLine: null };
  const lead = indentOf(mod.lines[st.startLine - 1] ?? '');
  const next = mod.statements.find((s) => s.startLine > st.endLine && s.startLine <= spanEnd && s.kind !== 'decorator');
  const nextLine = next?.startLine ?? null;
  if (isHeaderStatement(st)) {
    const body = next !== undefined && next.indent > st.indent ? indentOf(mod.lines[next.startLine - 1] ?? '') : `${lead}${indentUnitOf(file)}`;
    return { indents: [body], position: 'after_header', dedents: [0], endLine: st.endLine, nextLine };
  }
  const floor = bodyIndentAt(file, st.startLine);
  // enclosing compound statements, innermost first: a statement after their block sits at their indent
  const levels: string[] = [];
  let cur = st.indent;
  for (let k = st.index - 1; k >= 0; k--) {
    const t = mod.statements[k]!;
    if (t.indent >= cur || t.kind === 'decorator') continue;
    if (t.indent < floor) break;
    if (t.header) levels.push(indentOf(mod.lines[t.startLine - 1] ?? ''));
    cur = t.indent;
  }
  let minIndent = floor;
  if (next !== undefined) minIndent = CLAUSE_KINDS.has(next.kind) ? next.indent + 1 : next.indent;
  const legal = levels.filter((l) => l.length >= minIndent);
  const terminal = TERMINAL_KINDS.has(st.kind);
  const indents: string[] = [];
  const dedents: number[] = [];
  if (legal.length > 0) {
    indents.push(legal[0]!);
    dedents.push(1);
  }
  if (!terminal && lead.length >= minIndent) {
    indents.push(lead);
    dedents.push(0);
  }
  legal.slice(1).forEach((l, i) => {
    indents.push(l);
    dedents.push(i + 2);
  });
  const dedentsHere = next !== undefined && next.indent < st.indent;
  return { indents, position: dedentsHere ? 'block_end' : 'mid_block', dedents, endLine: st.endLine, nextLine };
}

/**
 * Indent for the anchor gap after `line`: the most likely legal indent (`gapIndentsAfter`),
 * falling back to the statement's own indent when nothing is legal (a trailing `return`).
 */
export function indentAfter(file: SourceFile, line: number): string {
  const g = gapIndentsAfter(file, line);
  const first = g.indents[0];
  if (first !== undefined) return first;
  const st = statementAt(file.mod, line);
  return indentOf(file.mod.lines[(st?.startLine ?? line) - 1] ?? '');
}

/**
 * Indent for the gap before `line`: the line's own indent, except before a clause header
 * (`else:`, `elif`, `except`, `finally`), where only the preceding block's indent is legal (a
 * statement at the clause's indent between an `if` body and its `else:` is a SyntaxError).
 */
export function indentBefore(file: SourceFile, line: number): string {
  const mod = file.mod;
  const text = mod.lines[line - 1] ?? '';
  const st = statementAt(mod, line);
  if (st === undefined || !CLAUSE_KINDS.has(st.kind)) return indentOf(text);
  const prev = [...mod.statements].reverse().find((s) => s.endLine < st.startLine && s.kind !== 'decorator');
  if (prev === undefined) return indentOf(text);
  const g = gapIndentsAfter(file, prev.startLine);
  return g.indents[0] ?? indentOf(mod.lines[prev.startLine - 1] ?? '');
}

/**
 * Every legal insertion slot of the function spanning [startLine, endLine] (the `def` line
 * included: the gap after it is the first body line; nested defs' bodies included), one slot
 * per physical line. The k-th legal indent of the gap after a statement goes to the k-th
 * physical line between that statement and the next (a blank line gives a block-end gap a second
 * slot for a second level); indents without a line of their own are dropped — the sieve's queue
 * keys a candidate by (line, kind, code tokens), so two indentations of one statement at one
 * line would be one job there. Dead slots (the same indent after `return`) are never built.
 * Slots are in line order; `orderGapSlots` in search/sites.ts ranks them.
 */
export function functionGapSlots(file: SourceFile, startLine: number, endLine: number): GapSlot[] {
  const mod = file.mod;
  const out: GapSlot[] = [];
  const taken = new Set<number>();
  const statements = mod.statements.filter((s) => s.startLine >= startLine && s.startLine <= endLine && s.kind !== 'decorator');
  for (const st of statements) {
    const g = gapIndentsAfter(file, st.startLine, endLine);
    // a docstring right after the header: the gap after the header duplicates the gap after the docstring
    if (st.kind === 'def') {
      const first = mod.statements.find((s) => s.startLine > st.endLine && s.startLine <= endLine);
      if (first !== undefined && first.kind === 'expr' && first.tokens.length > 0 && first.tokens.every((t) => t.type === 'STRING')) continue;
    }
    const lastLine = g.nextLine ?? Math.min(endLine, mod.lines.length) + 1;
    g.indents.forEach((indent, k) => {
      const line = g.endLine + 1 + k;
      if (line > lastLine || taken.has(line)) return;
      taken.add(line);
      out.push({ line, indent, afterLine: st.startLine, nextLine: g.nextLine, position: g.position, dedent: g.dedents[k] ?? 0 });
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

function evidenceFor(input: SiteBuildInput, file: SourceFile, line: number, jevProbability: number | undefined, notes: string[]): SiteEvidence {
  const ev: SiteEvidence = { notes: [...notes] };
  if (jevProbability !== undefined) ev.jevProbability = jevProbability;
  const s = input.sbfl.get(sbflKey(file.path, line));
  if (s !== undefined) {
    ev.sbflRank = s.rank;
    ev.sbflScore = s.score;
  }
  if (input.frames.some((f) => f.path === file.path && f.line === line)) ev.notes.push('in traceback');
  return ev;
}

function blockOf(entry: FunctionEntry | null): Site['block'] {
  if (entry === null || entry.blockIndex === null) return null;
  return { name: entry.qualname, startLine: entry.startLine, endLine: entry.endLine };
}

// ---------------------------------------------------------------------------------------
// Statement-level replace sites
// ---------------------------------------------------------------------------------------

const OPEN_BRACKETS: ReadonlySet<string> = new Set(['(', '[', '{']);
const CLOSE_BRACKETS: ReadonlySet<string> = new Set([')', ']', '}']);

/**
 * A multi-line statement's code tokens joined onto one line: the source spacing is kept between
 * tokens of one physical line; across a line break one space goes in, none after an open bracket
 * or before a close bracket or comma, and a trailing comma right before the closing bracket is
 * dropped (`hash((\n a,\n b,\n))` -> `hash((a, b))`). Comments and backslash continuations vanish
 * with the line breaks. Null when the statement fits one line already, or when a token itself
 * spans lines (a triple-quoted string), which no one-line site can hold.
 */
export function joinedStatementText(mod: PyModule, st: Statement): string | null {
  if (st.startLine === st.endLine) return null;
  const toks = st.tokens;
  if (toks.length === 0 || toks.some((t) => t.text.includes('\n'))) return null;
  let out = '';
  toks.forEach((t, k) => {
    const prev = toks[k - 1];
    if (prev === undefined) {
      out = t.text;
      return;
    }
    if (t.line === prev.endLine) {
      out += mod.src.slice(prev.end, t.start) + t.text;
      return;
    }
    if (prev.type === 'OP' && prev.text === ',' && t.type === 'OP' && CLOSE_BRACKETS.has(t.text)) out = out.slice(0, -1);
    const tight = (prev.type === 'OP' && OPEN_BRACKETS.has(prev.text)) || (t.type === 'OP' && (CLOSE_BRACKETS.has(t.text) || t.text === ','));
    out += (tight ? '' : ' ') + t.text;
  });
  return out;
}

/**
 * The statement-level site for the statement containing `line`, or null when that statement is
 * one physical line, a `def`/`class` header (never a replace site), a string-only statement (a
 * docstring) or cannot be joined. `line` is the statement's first line, `endLine` its last,
 * `indent` the first line's, `currentLine` the joined statement.
 */
export function statementSiteAt(file: SourceFile, line: number, evidence: SiteEvidence, block: Site['block'] = blockOf(entryOfLine(file, line))): Site | null {
  const mod = file.mod;
  const st = statementAt(mod, line);
  if (st === undefined || st.kind === 'decorator' || isDefLine(file, st.startLine)) return null;
  if (st.tokens.length > 0 && st.tokens.every((t) => t.type === 'STRING')) return null;
  const joined = joinedStatementText(mod, st);
  if (joined === null) return null;
  const first = mod.lines[st.startLine - 1] ?? '';
  const indent = indentOf(first);
  return {
    file,
    line: st.startLine,
    kind: 'replace',
    currentLine: indent + joined,
    endLine: st.endLine,
    indent,
    block,
    scope: scopeAt(mod, st.startLine),
    evidence: { ...evidence, notes: [...evidence.notes, `statement L${st.startLine}-${st.endLine} joined`] },
  };
}

/** True when `site` is a statement-level replace site (a span of physical lines). */
export function isStatementSite(site: Pick<Site, 'line' | 'kind' | 'endLine'>): boolean {
  return site.kind === 'replace' && site.endLine !== undefined && site.endLine > site.line;
}

function entryOfLine(file: SourceFile, line: number): FunctionEntry | null {
  return entryAt(functionEntries(file), line) ?? null;
}

function replaceSite(input: SiteBuildInput, a: Anchor, line: number, notes: string[]): Site {
  const text = a.file.mod.lines[line - 1] ?? '';
  return {
    file: a.file,
    line,
    kind: 'replace',
    currentLine: text,
    indent: indentOf(text),
    block: blockOf(a.entry),
    scope: scopeAt(a.file.mod, line),
    evidence: evidenceFor(input, a.file, line, a.lineProbabilities.get(line), notes),
  };
}

function insertSite(input: SiteBuildInput, a: Anchor, where: 'before' | 'after'): Site {
  // A multi-line statement ends after its first physical line; the gap "after" it follows the statement.
  const st = statementAt(a.file.mod, a.line);
  const line = where === 'before' ? a.line : (st?.endLine ?? a.line) + 1;
  // Names bound on the anchor line are visible after it, not before it.
  const scopeLine = where === 'before' ? Math.max(1, a.line - 1) : a.line;
  return {
    file: a.file,
    line,
    kind: 'insert',
    currentLine: '',
    indent: where === 'before' ? indentBefore(a.file, a.line) : indentAfter(a.file, a.line),
    block: blockOf(a.entry),
    scope: scopeAt(a.file.mod, scopeLine),
    evidence: evidenceFor(input, a.file, a.line, a.jevProbability, [...a.notes, `insert ${where} anchor L${a.line}`]),
  };
}

/** Code lines eligible as window members around `a`: inside its function, or module-level code. */
function windowLines(a: Anchor): number[] {
  const mod = a.file.mod;
  if (a.entry === null || a.entry.blockIndex === null) return moduleCodeLines(mod).map((c) => c.line);
  return codeLines(mod, a.entry.startLine, a.entry.endLine).map((c) => c.line);
}

/** True for the physical lines of a `def`/`class` header (decorators included): never a replace site. */
export function isDefLine(file: SourceFile, line: number): boolean {
  return file.mod.blocks.some((b) => line >= b.startLine && line <= b.headerEndLine);
}

/**
 * SBFL-only replace sites: of the spectrum rows that can be sites at all (`def` lines, blanks,
 * comments and rows outside `files` dropped first, since they can never be edited), the top-`k`
 * by rank; rows an anchor already covers count towards `k` (they are in the union already) but
 * yield no new site. Union, not score combination.
 */
export function sbflOnlySites(input: SiteBuildInput, k: number, covered: ReadonlySet<string>): Site[] {
  const files = input.files;
  if (files === undefined || k <= 0) return [];
  const rows = [...input.sbfl.values()]
    .filter((r) => {
      const file = files.get(r.file);
      const text = file?.mod.lines[r.line - 1];
      return file !== undefined && text !== undefined && text.trim() !== '' && !text.trim().startsWith('#') && !isDefLine(file, r.line);
    })
    .sort((a, b) => a.rank - b.rank || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line)
    .slice(0, k);
  const out: Site[] = [];
  const entriesByPath = new Map<string, FunctionEntry[]>();
  for (const r of rows) {
    if (covered.has(`${r.file}:${r.line}:replace`)) continue;
    const file = files.get(r.file)!;
    let entries = entriesByPath.get(r.file);
    if (entries === undefined) {
      entries = functionEntries(file);
      entriesByPath.set(r.file, entries);
    }
    const anchor: Anchor = { file, line: r.line, entry: entryAt(entries, r.line) ?? null, lineProbabilities: new Map(), notes: [`sbfl rank ${r.rank}`] };
    out.push(replaceSite(input, anchor, r.line, anchor.notes));
  }
  return out;
}

export function buildSites(input: SiteBuildInput): Site[] {
  const out: Site[] = [];
  const seen = new Set<string>();
  const push = (s: Site): void => {
    const k = `${s.file.path}:${s.line}:${s.kind}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  // A replace site on a multi-line statement: the statement-level site stands in for the first
  // physical line and is added once after any later line of the statement (header comment).
  const statementSpans = new Set<string>();
  const pushReplace = (s: Site): void => {
    const st = statementAt(s.file.mod, s.line);
    const spanSite = st !== undefined && st.startLine !== st.endLine ? statementSiteAt(s.file, s.line, s.evidence, s.block) : null;
    if (spanSite === null) {
      push(s);
      return;
    }
    const spanKey = `${s.file.path}:${spanSite.line}-${spanSite.endLine}`;
    if (spanSite.line === s.line) {
      if (!statementSpans.has(spanKey)) {
        statementSpans.add(spanKey);
        push(spanSite);
      }
      return;
    }
    push(s);
    if (!statementSpans.has(spanKey) && !seen.has(`${s.file.path}:${spanSite.line}:replace`)) {
      statementSpans.add(spanKey);
      push(spanSite);
    }
  };
  // pass 1: the anchors themselves
  for (const a of input.anchors) pushReplace(replaceSite(input, a, a.line, a.notes));
  // pass 2: insert gaps around each anchor
  for (const a of input.anchors) {
    push(insertSite(input, a, 'before'));
    push(insertSite(input, a, 'after'));
  }
  // pass 3: neighbours by distance, function bounds respected
  const eligible = input.anchors.map((a) => new Set(windowLines(a)));
  for (let d = 1; d <= input.window; d++) {
    input.anchors.forEach((a, i) => {
      for (const line of [a.line - d, a.line + d]) {
        if (!eligible[i]!.has(line)) continue;
        pushReplace(replaceSite(input, a, line, [`within ${d} of anchor L${a.line}`]));
      }
    });
  }
  // pass 4: SBFL-only lines, unioned after every Jev-derived site (design §2.5 item 1)
  if (input.sbflAnchors !== undefined) for (const s of sbflOnlySites(input, input.sbflAnchors, seen)) pushReplace(s);
  return out;
}
