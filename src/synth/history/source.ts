/**
 * The `history` candidate source: the reverse of each change run of the harvested commits
 * (harvest.ts, once per run; handed in as `EnumerateOptions.history`) that touches the site's
 * file at or near the site. A run whose added lines are still in the file verbatim becomes a
 * replace candidate on those lines (the removed lines come back; a pure addition is deleted); a
 * run whose lines were only removed comes back as an insert after its leading context. Nothing
 * is guessed: a run whose text is no longer in the file yields nothing. Candidates are ranked by
 * distance to the site, then commit recency; ≤ `opts.cap` (254). Ordinary `Candidate`s with
 * `source: 'history'` and a `provenance` line naming the commit, so the queue, the ranker and the
 * trace treat them like any other source.
 */
import { createHash } from 'node:crypto';
import { indentOf } from '../py/edits.js';
import { blockAt, scopeAt } from '../py/structure.js';
import type { Candidate, CandidateSource, EnumerateOptions, LineEdit, Site, SourceFile } from '../types.js';
import type { HistoryCommit, HistoryHunk } from './types.js';

/** A change run whose current location is farther than this from the site (and outside its block) is not "near" it. */
export const HISTORY_WINDOW_LINES = 80;

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

function replaceSiteAt(file: SourceFile, line: number): Site {
  const text = file.mod.lines[line - 1] ?? '';
  return { file, line, kind: 'replace', currentLine: text, indent: indentOf(text), block: blockOf(file, line), scope: scopeAt(file.mod, line), evidence: { notes: ['history: the lines a past commit added'] } };
}

function insertSiteAt(file: SourceFile, line: number, indent: string): Site {
  const anchor = Math.max(1, Math.min(line - 1, file.mod.lines.length));
  return { file, line, kind: 'insert', currentLine: '', indent, block: blockOf(file, anchor), scope: scopeAt(file.mod, anchor), evidence: { notes: ['history: where a past commit removed lines'] } };
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

interface Placed {
  candidate: Candidate;
  distance: number;
}

/** The reverse of one change run at its current location in `site.file`, or null when the run's text is gone. */
export function reverseHunk(site: Site, commit: HistoryCommit, hunk: HistoryHunk, index: number): Placed | null {
  const file = site.file;
  const lines = file.mod.lines;
  const provenance = `reverse of ${commit.sha.slice(0, 10)}${commit.subject === '' ? '' : ` "${commit.subject.slice(0, 70)}"`}${commit.reason === '' ? '' : ` (${commit.reason})`}`;
  const added = codeLines(hunk.newLines);
  const removed = hunk.oldLines;
  const id = (text: string, line: number): string => `hist_${commit.sha.slice(0, 8)}_${index}_${shortHash(`${file.path}:${line}:${text}`)}`;
  if (added.length > 0) {
    const start = locateLines(lines, added, hunk.newStart);
    if (start < 0) return null;
    const end = start + added.length - 1;
    const distance = site.line < start ? start - site.line : site.line > end ? site.line - end : 0;
    const at = replaceSiteAt(file, start);
    const text = removed.join('\n');
    // a candidate that changes nothing is not a candidate
    if (removed.length === added.length && removed.every((l, k) => norm(l) === norm(added[k] ?? ''))) return null;
    const extraEdits: LineEdit[] = [];
    for (let l = start + 1; l <= end; l++) extraEdits.push({ path: file.path, line: l, kind: 'delete' });
    const candidate: Candidate = { id: id(text, start), site: at, text, source: 'history', op: removed.length === 0 ? 'history_revert_addition' : 'history_revert_change', prior: distance === 0 ? 0.6 : 0.45, provenance };
    if (extraEdits.length > 0) candidate.extraEdits = extraEdits;
    return { candidate, distance };
  }
  // a pure deletion in the commit: the removed lines come back after their leading context
  const before = codeLines(hunk.before);
  if (before.length === 0 || removed.length === 0) return null;
  const ctxStart = locateLines(lines, before, hunk.newStart - before.length);
  if (ctxStart < 0) return null;
  const line = ctxStart + before.length;
  const distance = Math.abs(line - site.line);
  const indent = indentOf(removed.find((l) => l.trim() !== '') ?? '');
  const at = insertSiteAt(file, line, indent);
  const text = removed.join('\n');
  return { candidate: { id: id(text, line), site: at, text, source: 'history', op: 'history_revert_deletion', prior: distance === 0 ? 0.6 : 0.45, provenance }, distance };
}

/** Enumerate the reversals near `site` from `opts.history`; [] without history facts. */
export function enumerateHistory(site: Site, opts: EnumerateOptions): Candidate[] {
  const facts = opts.history;
  if (facts === undefined || facts.commits.length === 0) return [];
  const placed: (Placed & { recency: number; index: number })[] = [];
  const seen = new Set<string>();
  facts.commits.forEach((commit, recency) => {
    commit.hunks.forEach((hunk, index) => {
      if (hunk.file !== site.file.path) return;
      const p = reverseHunk(site, commit, hunk, index);
      if (p === null) return;
      const sameBlock = site.block !== null && p.candidate.site.line >= site.block.startLine && p.candidate.site.line <= site.block.endLine;
      if (p.distance > HISTORY_WINDOW_LINES && !sameBlock) return;
      const key = `${p.candidate.site.line}|${p.candidate.site.kind}|${p.candidate.text}`;
      if (seen.has(key)) return;
      seen.add(key);
      placed.push({ ...p, recency, index });
    });
  });
  placed.sort((a, b) => a.distance - b.distance || a.recency - b.recency || a.index - b.index);
  return placed.slice(0, Math.max(0, opts.cap)).map((p) => p.candidate);
}

export function createHistorySource(): CandidateSource {
  return {
    name: 'history',
    enumerate(site: Site, opts: EnumerateOptions): Candidate[] {
      return enumerateHistory(site, opts);
    },
  };
}
