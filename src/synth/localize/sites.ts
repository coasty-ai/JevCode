/**
 * From ranked line anchors to Sites: a ±window of code lines around every anchor (clipped to the
 * enclosing function, or to module-level code outside every def), plus an insert gap before and
 * after each anchor so insertion bugs (4/40 QuixBugs, missed by every line question) still get
 * candidates. Evidence is code-computed: the line's own Choice probability, its SBFL rank and
 * score, and notes such as "in traceback". Order: anchors first, then their insert gaps, then
 * neighbours by distance, so a consumer that stops after k sites gets the best k.
 */
import { indentOf } from '../py/edits.js';
import { scopeAt, statementAt } from '../py/structure.js';
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

/** Body indent for a gap after `line`: one level deeper after a compound header, else the same. */
export function indentAfter(file: SourceFile, line: number): string {
  const text = file.mod.lines[line - 1] ?? '';
  const st = statementAt(file.mod, line);
  const base = indentOf(text);
  if (st !== undefined && st.header && st.colonIndex !== null && st.colonIndex === st.tokens.length - 1) return `${base}    `;
  return base;
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
  const anchorText = a.file.mod.lines[a.line - 1] ?? '';
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
    indent: where === 'before' ? indentOf(anchorText) : indentAfter(a.file, a.line),
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
  // pass 1: the anchors themselves
  for (const a of input.anchors) push(replaceSite(input, a, a.line, a.notes));
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
        push(replaceSite(input, a, line, [`within ${d} of anchor L${a.line}`]));
      }
    });
  }
  // pass 4: SBFL-only lines, unioned after every Jev-derived site (design §2.5 item 1)
  if (input.sbflAnchors !== undefined) for (const s of sbflOnlySites(input, input.sbflAnchors, seen)) push(s);
  return out;
}
