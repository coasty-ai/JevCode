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
import { codeLines, moduleCodeLines } from './outline.js';
import type { FunctionEntry, TracebackFrame } from './types.js';

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
  return out;
}
