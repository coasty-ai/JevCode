/**
 * Harvest the repository history that may hold the fix (design §3 last row; capability 3 of
 * swebench-reach-oracle-9.md). Once per run, read-only git through the caller's `run` (the
 * engine's sandbox in production), bounded to HISTORY_MAX_COMMANDS commands of
 * HISTORY_COMMAND_TIMEOUT_MS each:
 *
 * 1. references the issue names: a ticket / PR number (`#31750`) is matched against commit
 *    subjects (`git log --grep`), a commit hash is resolved (`git log -1 <sha>`), both restricted
 *    to the localised files (≤ HISTORY_MAX_REF_QUERIES);
 * 2. identifiers the issue names (the localiser's `taskIdentifiers`), those that occur in the
 *    localised files first, longest first: `git log -S<ident> -n 5 -- <files>` (≤ the commands left
 *    minus one);
 * 3. one `git show -U3 <shas> -- <files>` over the ≤ HISTORY_MAX_COMMITS most recent commits found.
 *
 * The diff is split into contiguous change runs (one `@@` hunk may hold several, separated by
 * context), each with up to three verbatim context lines on both sides, so the reverse of one run
 * is one candidate (history/source.ts). A partial clone may fetch on `-S` (measured 64 s on the
 * django checkout of the reach study): the per-command timeout drops that query, never the run.
 */
import type { SourceFile } from '../types.js';
import type { VerifyRunFn } from '../verify/types.js';
import type { HistoryCommit, HistoryFacts, HistoryHunk } from './types.js';

export const HISTORY_MAX_COMMANDS = 8;
export const HISTORY_COMMAND_TIMEOUT_MS = 10_000;
export const HISTORY_MAX_COMMITS = 5;
export const HISTORY_LOG_PER_QUERY = 5;
export const HISTORY_MAX_REF_QUERIES = 2;
export const HISTORY_MAX_IDENT_QUERIES = 4;
export const HISTORY_OUTPUT_BYTES = 512 * 1024;
/** Context lines kept on each side of a change run (matches `-U3`). */
export const HISTORY_CONTEXT = 3;

const TICKET_RE = /#(\d{3,7})\b/g;
/** 7–40 hex chars with at least one letter and one digit: a commit hash, not a plain number or a word. */
const SHA_RE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g;
const RECORD_SEP = '\u001e';
const FIELD_SEP = '\u001f';

export interface HistoryRef {
  kind: 'ticket' | 'sha';
  value: string;
}

/** Ticket / PR numbers and commit hashes the issue text names, in order of appearance, deduplicated. */
export function issueRefs(task: string): HistoryRef[] {
  const out: HistoryRef[] = [];
  const seen = new Set<string>();
  for (const m of task.matchAll(TICKET_RE)) {
    const v = `#${m[1] ?? ''}`;
    if (!seen.has(v)) {
      seen.add(v);
      out.push({ kind: 'ticket', value: v });
    }
  }
  for (const m of task.matchAll(SHA_RE)) {
    const v = m[0];
    if (!seen.has(v)) {
      seen.add(v);
      out.push({ kind: 'sha', value: v });
    }
  }
  return out;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Identifiers worth a `-S` query: present in one of the files first, then longest first; bare short words last. */
export function rankIdentifiers(identifiers: readonly string[], files: readonly SourceFile[]): string[] {
  const inFiles = new Set<string>();
  for (const f of files) for (const t of f.mod.tokens) if (t.type === 'NAME') inFiles.add(t.text);
  const ok = [...new Set(identifiers)].filter((id) => /^[A-Za-z_]\w*$/.test(id) && id.length >= 3);
  return ok.sort((a, b) => Number(inFiles.has(b)) - Number(inFiles.has(a)) || b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

export interface HarvestOptions {
  /** absolute path of the checkout (the committed workspace; git is only read) */
  workspace: string;
  /** workspace-relative paths the queries are restricted to (the localised module files) */
  files: readonly string[];
  /** the issue text (for `#N` and hash references) */
  task: string;
  /** the localiser's task identifiers (search/subgoal.ts taskIdentifiers) */
  identifiers: readonly string[];
  /** the analysed localised files, to prefer identifiers they contain */
  sources?: readonly SourceFile[];
  maxCommands?: number;
  timeoutMs?: number;
}

interface LogRow {
  sha: string;
  time: number;
  subject: string;
}

function parseLogRows(stdout: string): LogRow[] {
  const out: LogRow[] = [];
  for (const line of stdout.split('\n')) {
    const [sha, time, subject] = line.split(FIELD_SEP);
    if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha.trim())) continue;
    out.push({ sha: sha.trim(), time: Number(time ?? '0') || 0, subject: (subject ?? '').trim() });
  }
  return out;
}

/** Split one commit's `git show -U<n>` diff into per-file change runs with context. */
export function parseShowDiff(diff: string): HistoryHunk[] {
  const out: HistoryHunk[] = [];
  interface Run {
    oldStart: number;
    newStart: number;
    oldLines: string[];
    newLines: string[];
    before: string[];
  }
  // one mutable record (not closed-over `let`s) so the control-flow narrowing sees every assignment
  const st: { file: string; oldNo: number; newNo: number; context: string[]; run: Run | null; pendingAfter: { hunk: HistoryHunk; count: number } | null } = { file: '', oldNo: 0, newNo: 0, context: [], run: null, pendingAfter: null };
  const flush = (): void => {
    const run = st.run;
    if (run === null) return;
    const hunk: HistoryHunk = { file: st.file, oldStart: run.oldStart, oldLines: run.oldLines, newStart: run.newStart, newLines: run.newLines, before: run.before, after: [] };
    out.push(hunk);
    st.pendingAfter = { hunk, count: 0 };
    st.run = null;
  };
  const endHunk = (): void => {
    flush();
    st.pendingAfter = null;
    st.context = [];
  };
  const openRun = (): Run => {
    if (st.run === null) st.run = { oldStart: st.oldNo, newStart: st.newNo, oldLines: [], newLines: [], before: st.context.slice(-HISTORY_CONTEXT) };
    return st.run;
  };
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      endHunk();
      const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(raw);
      st.file = m?.[2] ?? '';
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('index ') || raw.startsWith('\\')) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h !== null) {
      endHunk();
      st.oldNo = Number(h[1]);
      st.newNo = Number(h[2]);
      continue;
    }
    if (st.file === '') continue;
    if (raw.startsWith('-')) {
      openRun().oldLines.push(raw.slice(1));
      st.oldNo += 1;
      st.pendingAfter = null;
    } else if (raw.startsWith('+')) {
      openRun().newLines.push(raw.slice(1));
      st.newNo += 1;
      st.pendingAfter = null;
    } else if (raw.startsWith(' ') || raw === '') {
      flush();
      const text = raw.startsWith(' ') ? raw.slice(1) : '';
      const pending = st.pendingAfter;
      if (pending !== null && pending.count < HISTORY_CONTEXT) {
        pending.hunk.after.push(text);
        pending.count += 1;
      }
      st.context.push(text);
      if (st.context.length > HISTORY_CONTEXT) st.context.shift();
      st.oldNo += 1;
      st.newNo += 1;
    }
  }
  endHunk();
  return out;
}

/** Split a `git show` over several commits (records start with RECORD_SEP) into commits with their runs. */
export function parseShowOutput(stdout: string, reasons: ReadonlyMap<string, string>): HistoryCommit[] {
  const out: HistoryCommit[] = [];
  for (const record of stdout.split(RECORD_SEP)) {
    const nl = record.indexOf('\n');
    const header = (nl < 0 ? record : record.slice(0, nl)).trim();
    const [sha, time, subject] = header.split(FIELD_SEP);
    if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) continue;
    out.push({ sha, subject: (subject ?? '').trim(), time: Number(time ?? '0') || 0, reason: reasons.get(sha) ?? '', hunks: parseShowDiff(nl < 0 ? '' : record.slice(nl + 1)) });
  }
  return out;
}

/** Run one git command; a non-zero exit, a timeout or an exception yields '' (the query is dropped, never the harvest). */
async function git(run: VerifyRunFn, workspace: string, args: string, timeoutMs: number): Promise<string> {
  try {
    const res = await run(`git ${args}`, { cwd: workspace, timeoutMs, maxOutputBytes: HISTORY_OUTPUT_BYTES });
    if (res.timedOut === true || res.killedBy === 'timeout' || res.exitCode !== 0) return '';
    return res.stdout;
  } catch {
    return '';
  }
}

const LOG_FORMAT = `--format=%H%x1f%ct%x1f%s`;

/** The history facts for a run: see the module header for the query plan and bounds. */
export async function harvestHistory(run: VerifyRunFn, opts: HarvestOptions): Promise<HistoryFacts> {
  const started = Date.now();
  const files = [...new Set(opts.files)].filter((f) => f !== '');
  const maxCommands = Math.max(1, Math.min(HISTORY_MAX_COMMANDS, opts.maxCommands ?? HISTORY_MAX_COMMANDS));
  const timeoutMs = opts.timeoutMs ?? HISTORY_COMMAND_TIMEOUT_MS;
  const notes: string[] = [];
  if (files.length === 0) return { commits: [], files, commands: 0, durationMs: Date.now() - started, note: 'no localised file: no history query' };
  const pathArgs = `-- ${files.map(shellQuote).join(' ')}`;
  const found = new Map<string, LogRow & { reason: string }>();
  let commands = 0;
  const record = (rows: LogRow[], reason: string): void => {
    for (const r of rows) if (!found.has(r.sha)) found.set(r.sha, { ...r, reason });
  };
  // 1. references the issue names
  for (const ref of issueRefs(opts.task).slice(0, HISTORY_MAX_REF_QUERIES)) {
    if (commands >= maxCommands - 1) break;
    commands += 1;
    const out = ref.kind === 'ticket' ? await git(run, opts.workspace, `log --fixed-strings --grep=${shellQuote(ref.value)} ${LOG_FORMAT} -n ${HISTORY_LOG_PER_QUERY} ${pathArgs}`, timeoutMs) : await git(run, opts.workspace, `log -n 1 ${LOG_FORMAT} ${shellQuote(ref.value)} ${pathArgs}`, timeoutMs);
    const rows = parseLogRows(out);
    if (rows.length > 0) notes.push(`${ref.kind} ${ref.value}: ${rows.length} commit${rows.length === 1 ? '' : 's'}`);
    record(rows, `${ref.kind}:${ref.value}`);
  }
  // 2. identifiers the issue names
  const idents = rankIdentifiers(opts.identifiers, opts.sources ?? []).slice(0, HISTORY_MAX_IDENT_QUERIES);
  for (const ident of idents) {
    if (commands >= maxCommands - 1) break;
    commands += 1;
    const rows = parseLogRows(await git(run, opts.workspace, `log -S${shellQuote(ident)} ${LOG_FORMAT} -n ${HISTORY_LOG_PER_QUERY} ${pathArgs}`, timeoutMs));
    if (rows.length > 0) notes.push(`-S${ident}: ${rows.length}`);
    record(rows, `ident:${ident}`);
  }
  if (found.size === 0) return { commits: [], files, commands, durationMs: Date.now() - started, note: `no commit found (${commands} git command${commands === 1 ? '' : 's'}; ${issueRefs(opts.task).length} reference${issueRefs(opts.task).length === 1 ? '' : 's'}, ${idents.length} identifier${idents.length === 1 ? '' : 's'} queried)` };
  // 3. one show over the most recent commits found
  const picked = [...found.values()].sort((a, b) => b.time - a.time || (a.sha < b.sha ? -1 : 1)).slice(0, HISTORY_MAX_COMMITS);
  commands += 1;
  const show = await git(run, opts.workspace, `show --no-color --format=%x1e%H%x1f%ct%x1f%s -U${HISTORY_CONTEXT} ${picked.map((p) => p.sha).join(' ')} ${pathArgs}`, timeoutMs);
  const reasons = new Map(picked.map((p) => [p.sha, p.reason] as const));
  const commits = parseShowOutput(show, reasons).sort((a, b) => b.time - a.time);
  const hunks = commits.reduce((n, c) => n + c.hunks.length, 0);
  return { commits, files, commands, durationMs: Date.now() - started, note: `${commits.length} commit${commits.length === 1 ? '' : 's'}, ${hunks} change run${hunks === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'} (${commands} git command${commands === 1 ? '' : 's'}${notes.length > 0 ? `; ${notes.join('; ')}` : ''})` };
}
