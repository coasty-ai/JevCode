/**
 * The `history` candidate source: the reverse of each change run of the harvested commits
 * (harvest.ts, once per run; handed in as `EnumerateOptions.history`) whose current location IS
 * the site being enumerated. A run whose added lines are still in the file verbatim is located as
 * a replace of those lines — one line, or the statement-level span `line..endLine` when the run
 * is longer (verify/apply.ts deletes the continuation lines) — where the removed lines come back
 * (a pure addition is deleted); a run whose lines were only removed is located as an insert after
 * its leading context. Nothing is guessed: a run whose text is no longer in the file, or whose
 * span does not tokenize, yields nothing.
 *
 * A reversal is emitted for a site ONLY when its located site equals that site (`sameSpan`: same
 * file, line, kind and, for replaces, the same span end), and then with `candidate.site` the
 * enumerated site itself — so what a source hands the ranker is at the ranked site, which
 * rank/index.ts asserts (jev-only-rungs-1-2.md §21.5: reversals located at their own lines rode
 * with the donor seed of whatever site was being enumerated and the ranker threw; nine rung-3
 * runs stopped on it). Reversals located elsewhere are not lost: search/sites.ts `historySites`
 * lists their sites (≤ 2 per goal, recency then proximity) after the Jev-ranked ones, and the
 * source emits them there. Ordinary `Candidate`s with `source: 'history'` and a `provenance` line
 * naming the commit, so the queue, the ranker and the trace treat them like any other source.
 */
import { createHash } from 'node:crypto';
import { indentOf } from '../py/edits.js';
import { blockAt, scopeAt } from '../py/structure.js';
import { codeTokens, renderTokens, tokenizeFragment } from '../py/tokenize.js';
import type { Candidate, CandidateSource, EnumerateOptions, Site, SourceFile } from '../types.js';
import type { HistoryCommit, HistoryFacts, HistoryHunk } from './types.js';

/**
 * The distance (lines) beyond which `reverseHunk` callers used to treat a run as not "near" a site.
 * `enumerateHistory` no longer needs a window (a reversal is at the site or it is not); the
 * constant stays for callers that report distances.
 */
export const HISTORY_WINDOW_LINES = 80;

/** Prefix of the evidence note on a site `locateReversal` built (search/sites.ts `historySites` lists such sites). */
export const HISTORY_SITE_NOTE = 'history:';

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 1-based start line of the first occurrence of `seq` in `lines` nearest `near` (exact after rstrip, then whitespace-normalised); -1 when absent. */
export function locateLines(lines: readonly string[], seq: readonly string[], near: number): number {
  if (seq.length === 0) return -1;
  const tryWith = (eq: (a: string, b: string) => boolean): number => {
    let best = -1;
    for (let i = 0; i + seq.length <= lines.length; i++) {
      let ok = true;
      for (let k = 0; k < seq.length && ok; k++) ok = eq(lines[i + k] ?? '', seq[k] ?? '');
      if (!ok) continue;
      const start = i + 1;
      if (best < 0 || Math.abs(start - near) < Math.abs(best - near)) best = start;
    }
    return best;
  };
  const exact = tryWith((a, b) => a.trimEnd() === b.trimEnd());
  if (exact > 0) return exact;
  return tryWith((a, b) => norm(a) === norm(b));
}

function blockOf(file: SourceFile, line: number): Site['block'] {
  const b = blockAt(file.mod, line);
  return b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine };
}

/** Last physical line a site's edit covers: `endLine` of a statement-level replace site, else its line. */
export function spanEndOf(site: Pick<Site, 'line' | 'kind' | 'endLine'>): number {
  return site.kind === 'replace' && site.endLine !== undefined && site.endLine > site.line ? site.endLine : site.line;
}

/**
 * True when two sites are the same place to edit: same file, line and kind, and for replaces the
 * same span end (a one-line site and the statement-level site starting at that line differ). An
 * insert site's indent is not part of the identity: the reversal's text carries its own.
 */
export function sameSpan(a: Pick<Site, 'file' | 'line' | 'kind' | 'endLine'>, b: Pick<Site, 'file' | 'line' | 'kind' | 'endLine'>): boolean {
  return a.file.path === b.file.path && a.line === b.line && a.kind === b.kind && spanEndOf(a) === spanEndOf(b);
}

/**
 * The span `start..end` of `file` as a replace site: the physical line when `end === start`, else
 * the statement-level form (`endLine`, `currentLine` the span's code tokens rendered on one line,
 * which is what verify/apply.ts's staleness check compares the span against). Null when the span
 * does not tokenize.
 */
function replaceSpanSite(file: SourceFile, start: number, end: number, note: string): Site | null {
  const lines = file.mod.lines;
  const first = lines[start - 1] ?? '';
  const indent = indentOf(first);
  const base: Site = { file, line: start, kind: 'replace', currentLine: first, indent, block: blockOf(file, start), scope: scopeAt(file.mod, start), evidence: { notes: [`${HISTORY_SITE_NOTE} the lines a past commit added`, note] } };
  if (end <= start) return base;
  let rendered: string;
  try {
    const toks = codeTokens(tokenizeFragment(lines.slice(start - 1, end).join('\n')));
    if (toks.length === 0) return null;
    rendered = renderTokens(toks);
  } catch {
    return null;
  }
  return { ...base, currentLine: indent + rendered, endLine: end, evidence: { notes: [`${HISTORY_SITE_NOTE} the lines a past commit added`, note, `span L${start}-${end}`] } };
}

function insertSiteAt(file: SourceFile, line: number, indent: string, note: string): Site {
  const anchor = Math.max(1, Math.min(line - 1, file.mod.lines.length));
  return { file, line, kind: 'insert', currentLine: '', indent, block: blockOf(file, anchor), scope: scopeAt(file.mod, anchor), evidence: { notes: [`${HISTORY_SITE_NOTE} where a past commit removed lines`, note] } };
}

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 10);
}

/** Non-blank lines only: blank lines around a run are not evidence of its position. */
function codeLines(lines: readonly string[]): string[] {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) return [];
  let last = lines.length - 1;
  while (last > first && (lines[last] ?? '').trim() === '') last--;
  return lines.slice(first, last + 1);
}

/** `reverse of <sha> "<subject>" (<reason>)`: the candidate's provenance and the site note. */
export function provenanceOf(commit: Pick<HistoryCommit, 'sha' | 'subject' | 'reason'>): string {
  return `reverse of ${commit.sha.slice(0, 10)}${commit.subject === '' ? '' : ` "${commit.subject.slice(0, 70)}"`}${commit.reason === '' ? '' : ` (${commit.reason})`}`;
}

/**
 * The reverse of one change run at its current location in `file`, as a candidate whose `site` is
 * that location (built here, not the caller's), or null when the run's text is gone, the span does
 * not tokenize, or the reversal would change nothing.
 */
export function locateReversal(file: SourceFile, commit: HistoryCommit, hunk: HistoryHunk, index: number): Candidate | null {
  if (hunk.file !== file.path) return null;
  const lines = file.mod.lines;
  const provenance = provenanceOf(commit);
  const added = codeLines(hunk.newLines);
  const removed = hunk.oldLines;
  const id = (text: string, line: number): string => `hist_${commit.sha.slice(0, 8)}_${index}_${shortHash(`${file.path}:${line}:${text}`)}`;
  if (added.length > 0) {
    const start = locateLines(lines, added, hunk.newStart);
    if (start < 0) return null;
    // a candidate that changes nothing is not a candidate
    if (removed.length === added.length && removed.every((l, k) => norm(l) === norm(added[k] ?? ''))) return null;
    const at = replaceSpanSite(file, start, start + added.length - 1, provenance);
    if (at === null) return null;
    const text = removed.join('\n');
    return { id: id(text, start), site: at, text, source: 'history', op: removed.length === 0 ? 'history_revert_addition' : 'history_revert_change', prior: 0.6, provenance };
  }
  // a pure deletion in the commit: the removed lines come back after their leading context
  const before = codeLines(hunk.before);
  if (before.length === 0 || removed.length === 0) return null;
  const ctxStart = locateLines(lines, before, hunk.newStart - before.length);
  if (ctxStart < 0) return null;
  const line = ctxStart + before.length;
  const indent = indentOf(removed.find((l) => l.trim() !== '') ?? '');
  const text = removed.join('\n');
  return { id: id(text, line), site: insertSiteAt(file, line, indent, provenance), text, source: 'history', op: 'history_revert_deletion', prior: 0.6, provenance };
}

/** One located reversal of `locateReversals`: the candidate at its own site, the commit's recency rank (0 = most recent) and the run's index. */
export interface LocatedReversal {
  candidate: Candidate;
  commit: HistoryCommit;
  recency: number;
  index: number;
}

/** Every reversal of `facts` that locates in `file`, most recent commit first then run order, one per (site, text). */
export function locateReversals(file: SourceFile, facts: Pick<HistoryFacts, 'commits'>): LocatedReversal[] {
  const out: LocatedReversal[] = [];
  const seen = new Set<string>();
  facts.commits.forEach((commit, recency) => {
    commit.hunks.forEach((hunk, index) => {
      const candidate = locateReversal(file, commit, hunk, index);
      if (candidate === null) return;
      const key = `${candidate.site.line}|${candidate.site.kind}|${spanEndOf(candidate.site)}|${candidate.text}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ candidate, commit, recency, index });
    });
  });
  return out;
}

interface Placed {
  candidate: Candidate;
  distance: number;
}

/** Distance in lines from `site.line` to the span a candidate's site covers (0 inside it). */
export function distanceToSite(site: Pick<Site, 'line'>, at: Pick<Site, 'line' | 'kind' | 'endLine'>): number {
  const end = spanEndOf(at);
  return site.line < at.line ? at.line - site.line : site.line > end ? site.line - end : 0;
}

/** The reverse of one change run at its current location in `site.file` with its distance to `site`, or null when the run's text is gone. */
export function reverseHunk(site: Site, commit: HistoryCommit, hunk: HistoryHunk, index: number): Placed | null {
  const candidate = locateReversal(site.file, commit, hunk, index);
  if (candidate === null) return null;
  return { candidate, distance: distanceToSite(site, candidate.site) };
}

/**
 * Enumerate the reversals located AT `site` from `opts.history` (`sameSpan`), each with `site` as
 * its site; [] without history facts. Most recent commit first, then run order; ≤ `opts.cap`.
 */
export function enumerateHistory(site: Site, opts: EnumerateOptions): Candidate[] {
  const facts = opts.history;
  if (facts === undefined || facts.commits.length === 0) return [];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const r of locateReversals(site.file, facts)) {
    if (!sameSpan(r.candidate.site, site)) continue;
    if (seen.has(r.candidate.text)) continue;
    seen.add(r.candidate.text);
    out.push({ ...r.candidate, site });
  }
  return out.slice(0, Math.max(0, opts.cap));
}

export function createHistorySource(): CandidateSource {
  return {
    name: 'history',
    enumerate(site: Site, opts: EnumerateOptions): Candidate[] {
      return enumerateHistory(site, opts);
    },
  };
}
