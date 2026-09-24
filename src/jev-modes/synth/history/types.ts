/**
 * Types of the `history` candidate source (docs/JEV-ONLY-DESIGN.md §3 last row; measured need in
 * experiments/results/swebench-reach-oracle-9.md, missing capability 3: django-15315's gold line
 * is the pre-#31750 body verbatim, and the issue names the ticket). Code harvests the repository's
 * git history once per run, bounded (≤ 8 read-only git commands, 10 s each), and each change run
 * of each found commit becomes at most one candidate: its reverse, applied where the changed lines
 * sit in the current file. Tests decide; Jev ranks when the set is large.
 */

/** One contiguous change run inside a commit's diff of one file (old and new numbering of the commit's own diff). */
export interface HistoryHunk {
  /** workspace-relative path */
  file: string;
  /** 1-based old-file line of the first removed line (or where the insertion went) */
  oldStart: number;
  /** removed lines, verbatim (indentation kept) */
  oldLines: string[];
  /** 1-based new-file line of the first added line */
  newStart: number;
  /** added lines, verbatim */
  newLines: string[];
  /** up to 3 unchanged lines immediately before / after the run, verbatim (for placing a reversal whose added lines are gone) */
  before: string[];
  after: string[];
}

export interface HistoryCommit {
  sha: string;
  subject: string;
  /** unix seconds of the committer date */
  time: number;
  /** why it was picked: `ticket:#31750`, `sha:502e75f`, `ident:__hash__` (first reason wins) */
  reason: string;
  hunks: HistoryHunk[];
}

export interface HistoryFacts {
  /** most recent first, ≤ HISTORY_MAX_COMMITS */
  commits: HistoryCommit[];
  /** the files the queries were restricted to */
  files: string[];
  /** git commands run (≤ HISTORY_MAX_COMMANDS) */
  commands: number;
  durationMs: number;
  note: string;
}
