/**
 * `~/.jevcode/sessions/index.jsonl` (TUI-DESIGN §8.2, A55): the append-only, ≤ 512-byte-per-line, `v:1` session index
 * that the picker, `-c/--continue`, `--resume <title>` and the session meter fold once per session open, `/resume`,
 * `run:end` and `budget:override`. Writer: one `appendFileSync` under `O_APPEND` (no lock file, P11; `jevcode sessions
 * reindex` is the repair path). `task60` / `title60` / `text60` are `clip(oneLine(redact(x)), 60)` (judge-safety E13).
 * `foldIndex` is pure; `readIndex` / `appendIndexLine` / `reindex` are the only I/O.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isJsonObject, parseJson } from '../core/json.js';
import { clip } from '../core/text.js';
import type { EngineMode, RunMeta, RunRow, RunSource, SessionRow, StopReason } from '../core/types.js';
import { isRunMeta, parseEnvelope } from '../checkpoint/store.js';
import { exitCodeFor } from '../loop/stop.js';
import { oneLine } from '../tui/plain.js';

/** TUI-DESIGN §8.2: the write-side line cap; longer lines are dropped with a warning, never truncated on disk. */
export const INDEX_LINE_MAX_BYTES = 512;
export const INDEX_VERSION = 1 as const;
export const INDEX_FILE = 'index.jsonl';

export type IndexLine =
  | { v: 1; t: string; kind: 'run:start'; sessionId: string; runId: string; parentRunId: string | null; workspace: string; task60: string; mode: EngineMode; source: RunSource; branch: string | null; resumeOf: string | null }
  | { v: 1; t: string; kind: 'run:end'; sessionId: string; runId: string; stopReason: StopReason; steps: number; costUsd: { generator: number; jev: number }; wallMs: number; changedFiles: number; exitCode: number; resumable: boolean; degraded: boolean }
  | { v: 1; t: string; kind: 'rename'; sessionId: string; title60: string }
  | { v: 1; t: string; kind: 'steer'; sessionId: string; runId: string; step: number; text60: string }
  | { v: 1; t: string; kind: 'undo'; sessionId: string; runId: string; step: number; by: 'undo' | 'rewind'; files: number; skipped: number }
  | { v: 1; t: string; kind: 'pause'; sessionId: string; runId: string; step: number }
  | { v: 1; t: string; kind: 'budget'; sessionId: string; runId: string | null; setting: string; from: string; to: string };

export type IndexKind = IndexLine['kind'];
const INDEX_KINDS: readonly string[] = ['run:start', 'run:end', 'rename', 'steer', 'undo', 'pause', 'budget'];

/** Bidi controls (LRM/RLM, embeddings, isolates): never in an index field a picker row renders (E13). */
const BIDI_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * The one-line, control-free form of an index text field: `tui/plain.ts` `oneLine` (newlines → ` ⏎ `, tabs → space,
 * C0/DEL/C1 dropped) plus the Unicode line/paragraph separators folded the same way and bidi controls dropped, trimmed.
 */
export function indexOneLine(s: string): string {
  return oneLine(s.replace(/\u2028|\u2029/g, '\n')).replace(BIDI_RE, '').trim();
}

/** TUI-DESIGN §8.2 / E13: `clip(oneLine(redact(x)), 60)`. */
export function text60(s: string, redact: (s: string) => string): string {
  return clip(indexOneLine(redact(s)), 60);
}

/**
 * TUI-DESIGN §8.1: legacy `run.json` reads as `{ sessionId: runId, parentRunId: null, source: 'bench' | 'cli', instructions: [] }`
 * (`isRunMeta` checks v1 fields only, so old files load unchanged).
 */
export function sessionFieldsOf(meta: RunMeta): { sessionId: string; parentRunId: string | null; source: RunSource; instructions: RunMeta['instructions'] & object } {
  return {
    sessionId: meta.sessionId ?? meta.runId,
    parentRunId: meta.parentRunId ?? null,
    source: meta.source ?? (meta.workspace.includes('/bench-work/') ? 'bench' : 'cli'),
    instructions: meta.instructions ?? [],
  };
}

/** Byte-class check for the canonical `Date#toISOString` shape `YYYY-MM-DDTHH:MM:SS(.mmm)Z` — 20 or 24 chars; a hand loop, not a regex, because the fold runs it 20,000 times at 10,000 runs (§18). */
function hasCanonicalIsoShape(t: string): boolean {
  const n = t.length;
  if (n !== 20 && n !== 24) return false;
  if (t.charCodeAt(n - 1) !== 0x5a /* Z */) return false;
  for (let i = 0; i < n - 1; i++) {
    const c = t.charCodeAt(i);
    switch (i) {
      case 4:
      case 7:
        if (c !== 0x2d /* - */) return false;
        break;
      case 10:
        if (c !== 0x54 /* T */) return false;
        break;
      case 13:
      case 16:
        if (c !== 0x3a /* : */) return false;
        break;
      case 19:
        if (c !== 0x2e /* . */) return false;
        break;
      default:
        if (c < 0x30 || c > 0x39) return false;
    }
  }
  return true;
}

/** TUI-DESIGN §8.2: true for a canonical, parseable ISO-8601 UTC stamp (`2026-09-20T14:02:11.123Z`, milliseconds optional); local offsets, `GMT` forms and junk skip the line. */
export function isIsoLike(t: unknown): t is string {
  return typeof t === 'string' && hasCanonicalIsoShape(t) && Number.isFinite(Date.parse(t));
}

/** A string property or null (module-level so the parser allocates no closure per line). */
function strOf(o: Readonly<Record<string, unknown>>, k: string): string | null {
  const v = o[k];
  return typeof v === 'string' ? v : null;
}

/** Millisecond value of a stamp for ordering (mixed `.123Z` / `Z` precision compares by time, not by string). */
function ms(t: string): number {
  const v = Date.parse(t);
  return Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

const MODES: readonly string[] = ['jev-on', 'jev-off', 'jev-only'];
const SOURCES: readonly string[] = ['cli', 'bench', 'perf'];
/** Every `StopReason` (a compile error here when core/types.ts gains or loses one), so an unknown `stopReason` never folds into a typed row. */
const STOP_REASON_SET: Readonly<Record<StopReason, true>> = {
  complete: true,
  max_steps: true,
  spend_cap: true,
  wall_time: true,
  max_replans: true,
  human_abort: true,
  signal: true,
  replan_stop: true,
  impossible: true,
  generator_done: true,
  error: true,
  human_pause: true,
  token_cap: true,
};
export const STOP_REASONS: readonly StopReason[] = Object.keys(STOP_REASON_SET) as StopReason[];

/** Type guard over the `StopReason` union. */
export function isStopReason(v: unknown): v is StopReason {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(STOP_REASON_SET, v);
}

/** A parsed line with its stamp's millisecond value (parsed once; the fold orders on it). */
interface IndexRecord {
  line: IndexLine;
  ms: number;
}

/** Parse one physical line into an IndexLine; null for JSON that is torn, not `v:1`, an unknown kind, or missing its keys. */
export function parseIndexLine(line: string): IndexLine | null {
  return parseIndexRecord(line)?.line ?? null;
}

function parseIndexRecord(line: string): IndexRecord | null {
  const parsed = parseJson(line);
  if (!parsed.ok || !isJsonObject(parsed.value)) return null;
  const o = parsed.value;
  const t = o['t'];
  if (o['v'] !== INDEX_VERSION || typeof t !== 'string' || !hasCanonicalIsoShape(t) || typeof o['kind'] !== 'string' || !INDEX_KINDS.includes(o['kind'])) return null;
  const stamp = Date.parse(t);
  if (!Number.isFinite(stamp)) return null;
  const sessionId = o['sessionId'];
  if (typeof sessionId !== 'string') return null;
  const parsedLine = parseIndexBody(o, o['kind'], t, sessionId);
  return parsedLine === null ? null : { line: parsedLine, ms: stamp };
}

function parseIndexBody(o: Readonly<Record<string, unknown>>, kind: string, t: string, sessionId: string): IndexLine | null {
  const str = (k: string): string | null => strOf(o, k);
  switch (kind) {
    case 'run:start': {
      const runId = str('runId');
      const mode = str('mode');
      if (runId === null || mode === null || !MODES.includes(mode)) return null;
      const source = str('source');
      return {
        v: 1,
        t,
        kind: 'run:start',
        sessionId,
        runId,
        parentRunId: str('parentRunId'),
        workspace: str('workspace') ?? '',
        task60: str('task60') ?? '',
        mode: mode as EngineMode,
        source: source !== null && SOURCES.includes(source) ? (source as RunSource) : 'cli',
        branch: str('branch'),
        resumeOf: str('resumeOf'),
      };
    }
    case 'run:end': {
      const runId = str('runId');
      const stop = o['stopReason'];
      if (runId === null || !isStopReason(stop)) return null;
      const cost = isJsonObject(o['costUsd']) ? o['costUsd'] : {};
      return {
        v: 1,
        t,
        kind: 'run:end',
        sessionId,
        runId,
        stopReason: stop,
        steps: num(o['steps'], 0),
        costUsd: { generator: num(cost['generator'], 0), jev: num(cost['jev'], 0) },
        wallMs: num(o['wallMs'], 0),
        changedFiles: num(o['changedFiles'], 0),
        exitCode: num(o['exitCode'], 0),
        resumable: o['resumable'] === true,
        degraded: o['degraded'] === true,
      };
    }
    case 'rename':
      return { v: 1, t, kind: 'rename', sessionId, title60: str('title60') ?? '' };
    case 'steer': {
      const runId = str('runId');
      if (runId === null) return null;
      return { v: 1, t, kind: 'steer', sessionId, runId, step: num(o['step'], 0), text60: str('text60') ?? '' };
    }
    case 'undo': {
      const runId = str('runId');
      if (runId === null) return null;
      return { v: 1, t, kind: 'undo', sessionId, runId, step: num(o['step'], 0), by: o['by'] === 'rewind' ? 'rewind' : 'undo', files: num(o['files'], 0), skipped: num(o['skipped'], 0) };
    }
    case 'pause': {
      const runId = str('runId');
      if (runId === null) return null;
      return { v: 1, t, kind: 'pause', sessionId, runId, step: num(o['step'], 0) };
    }
    case 'budget':
      return { v: 1, t, kind: 'budget', sessionId, runId: str('runId'), setting: str('setting') ?? '', from: str('from') ?? '', to: str('to') ?? '' };
    default:
      return null;
  }
}

function newRun(runId: string, parentRunId: string | null, startedAt: string): RunRow {
  return { runId, parentRunId, startedAt, endedAt: null, stopReason: null, steps: null, costUsd: null, exitCode: null, resumable: null, resumes: 0, live: false };
}

/** Fold bookkeeping per session: the row plus the numeric stamps the ordering rules compare (parsed once per line). */
interface SessionFold {
  row: SessionRow;
  runs: Map<string, { row: RunRow; startedMs: number }>;
  lastUsedMs: number;
  createdAtMs: number;
  renamed: boolean;
}

/**
 * TUI-DESIGN §8.2 fold (pure): group by sessionId; per runId the last `run:start` / `run:end` win (a resume's
 * `run:start` with `resumeOf` counts as a resume, not a new run); title = last rename else the first task60;
 * lastUsed = max t over all kinds; `live` = started and not ended in the index (the picker ANDs it with `run.lock`);
 * torn, non-`v:1` and unknown lines are skipped and counted.
 */
export function foldIndex(lines: readonly string[]): { sessions: Map<string, SessionRow>; skipped: number } {
  const folds = new Map<string, SessionFold>();
  let skipped = 0;
  for (const raw of lines) {
    if (raw.length === 0 || raw.trim() === '') continue;
    const rec = parseIndexRecord(raw);
    if (rec === null) {
      skipped++;
      continue;
    }
    const { line, ms: at } = rec;
    let f = folds.get(line.sessionId);
    if (f === undefined) {
      f = {
        row: { sessionId: line.sessionId, workspace: '', title: '', task60: '', runs: [], lastUsed: line.t, createdAt: line.t, totalUsd: 0, mode: 'jev-on', branch: null },
        runs: new Map(),
        lastUsedMs: at,
        createdAtMs: at,
        renamed: false,
      };
      folds.set(line.sessionId, f);
    }
    const s = f.row;
    if (at > f.lastUsedMs) {
      f.lastUsedMs = at;
      s.lastUsed = line.t;
    }
    if (at < f.createdAtMs) {
      f.createdAtMs = at;
      s.createdAt = line.t;
    }
    switch (line.kind) {
      case 'run:start': {
        const existing = f.runs.get(line.runId);
        if (existing) {
          existing.row.parentRunId = line.parentRunId;
          if (line.resumeOf !== null) existing.row.resumes += 1;
          else {
            existing.row.startedAt = line.t;
            existing.startedMs = at;
          }
          existing.row.live = true;
        } else {
          const r = newRun(line.runId, line.parentRunId, line.t);
          r.live = true;
          if (line.resumeOf !== null) r.resumes = 1;
          f.runs.set(line.runId, { row: r, startedMs: at });
        }
        if (s.workspace === '') s.workspace = line.workspace;
        if (s.task60 === '') s.task60 = line.task60;
        if (!f.renamed && s.title === '') s.title = line.task60;
        s.mode = line.mode;
        s.branch = line.branch ?? s.branch;
        break;
      }
      case 'run:end': {
        let r = f.runs.get(line.runId);
        if (!r) {
          r = { row: newRun(line.runId, null, line.t), startedMs: at };
          f.runs.set(line.runId, r);
        }
        r.row.endedAt = line.t;
        r.row.stopReason = line.stopReason;
        r.row.steps = line.steps;
        r.row.costUsd = { generator: line.costUsd.generator, jev: line.costUsd.jev };
        r.row.exitCode = line.exitCode;
        r.row.resumable = line.resumable;
        r.row.live = false;
        break;
      }
      case 'rename':
        f.renamed = true;
        s.title = line.title60;
        break;
      case 'steer':
      case 'undo':
      case 'pause':
      case 'budget':
        break;
      default:
        break;
    }
  }
  const sessions = new Map<string, SessionRow>();
  for (const f of folds.values()) {
    const runs = [...f.runs.values()].sort((a, b) => a.startedMs - b.startedMs).map((x) => x.row);
    f.row.runs = runs;
    f.row.totalUsd = runs.reduce((acc, r) => acc + (r.costUsd ? r.costUsd.generator + r.costUsd.jev : 0), 0);
    if (f.row.title === '') f.row.title = f.row.task60;
    sessions.set(f.row.sessionId, f.row);
  }
  return { sessions, skipped };
}

/** Split file text into lines, dropping the trailing empty fragment; a torn last line stays and is skipped by the fold. */
export function splitIndexText(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function errnoCode(e: unknown): string | null {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : null;
}

/**
 * TUI-DESIGN §8.2: one `readFile`, then the fold; sessions sorted by `lastUsed` descending. A missing file is an empty
 * index; any other read error (EACCES, EISDIR) is reported in `error` with an empty result — the session works without
 * its history.
 */
export async function readIndex(path: string): Promise<{ sessions: SessionRow[]; skipped: number; error?: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return { sessions: [], skipped: 0 };
    return { sessions: [], skipped: 0, error: `${errnoCode(e) ?? 'error'}: cannot read ${path}` };
  }
  const { sessions, skipped } = foldIndex(splitIndexText(text));
  const rows = [...sessions.values()].sort((a, b) => ms(b.lastUsed) - ms(a.lastUsed));
  return { sessions: rows, skipped };
}

/** Apply the E13 rule to every free-text field of a line before it is serialised. */
export function redactIndexLine(line: IndexLine, redact: (s: string) => string): IndexLine {
  switch (line.kind) {
    case 'run:start':
      return { ...line, task60: text60(line.task60, redact) };
    case 'rename':
      return { ...line, title60: text60(line.title60, redact) };
    case 'steer':
      return { ...line, text60: text60(line.text60, redact) };
    default:
      return line;
  }
}

export interface AppendIndexOptions {
  /** receives the drop / write warning (the caller's logger); silent when absent */
  warn?: (message: string) => void;
}

/**
 * TUI-DESIGN §8.2 writer: redact the text fields, `JSON.stringify`, refuse anything over 512 bytes (dropped with a
 * warning), then one `appendFileSync` under `O_APPEND` (`flag: 'a'`) — one syscall on the hot path; only an `ENOENT`
 * creates the sessions dir and retries once. Index lines exist for `cli` runs only: a `run:start` from a bench or perf
 * run is refused here (the gate is in the writer, not just the controller). Never throws — the index is bookkeeping;
 * a failed append is a warning. Returns true when the line reached the file.
 */
export function appendIndexLine(path: string, line: IndexLine, redact: (s: string) => string, opts: AppendIndexOptions = {}): boolean {
  if (line.kind === 'run:start' && line.source !== 'cli') {
    opts.warn?.(`sessions index: skipped the ${line.source} run:start for ${line.runId} (only cli runs are indexed)`);
    return false;
  }
  const text = JSON.stringify(redactIndexLine(line, redact));
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > INDEX_LINE_MAX_BYTES) {
    opts.warn?.(`sessions index: dropped a ${line.kind} line of ${bytes} bytes (limit ${INDEX_LINE_MAX_BYTES})`);
    return false;
  }
  const record = `${text}\n`;
  try {
    try {
      appendFileSync(path, record, { flag: 'a', mode: 0o600 });
    } catch (e) {
      if (errnoCode(e) !== 'ENOENT') throw e;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(path, record, { flag: 'a', mode: 0o600 });
    }
    return true;
  } catch (e) {
    opts.warn?.(`sessions index: could not append to ${path}: ${errnoCode(e) ?? (e instanceof Error ? e.message : String(e))}`);
    return false;
  }
}

const RUN_DIR_RE = /^\d{8}-\d{6}-[a-z2-7]{8}$/;

export interface ReindexOptions {
  /** E13: applied to `task` / `title` before they become `task60` / `title60` (secrets added after the run was written, e.g. via /login); identity when absent */
  redact?: (s: string) => string;
}

/**
 * TUI-DESIGN §8.2 (P11): rebuild the index from every `<runsDir>/<run-id>/run.json` (+ `stat(state.json).mtime` as the
 * end time) for `source === 'cli'` runs, written atomically (tmp + rename) to `out`. Each `resumes[]` entry becomes a
 * `run:start` with `resumeOf` at its `resumedAt`, so the fold's `RunRow.resumes` matches run.json. Unreadable run dirs
 * are skipped and counted.
 */
export async function reindex(runsDir: string, out: string, opts: ReindexOptions = {}): Promise<{ runs: number; skipped: number }> {
  const redact = opts.redact ?? ((s: string): string => s);
  let names: string[];
  try {
    names = (await readdir(runsDir)).filter((n) => RUN_DIR_RE.test(n)).sort();
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') names = [];
    else throw e;
  }
  const lines: IndexLine[] = [];
  let skipped = 0;
  let runs = 0;
  for (const name of names) {
    const dir = join(runsDir, name);
    let meta: RunMeta;
    try {
      const parsed = parseJson(await readFile(join(dir, 'run.json'), 'utf8'));
      if (!parsed.ok || !isRunMeta(parsed.value)) {
        skipped++;
        continue;
      }
      meta = parsed.value;
    } catch {
      skipped++;
      continue;
    }
    const fields = sessionFieldsOf(meta);
    if (fields.source !== 'cli') continue;
    runs++;
    const branch = meta.git?.head?.kind === 'branch' ? meta.git.head.name : null;
    const startLine: Extract<IndexLine, { kind: 'run:start' }> = {
      v: 1,
      t: meta.createdAt,
      kind: 'run:start',
      sessionId: fields.sessionId,
      runId: meta.runId,
      parentRunId: fields.parentRunId,
      workspace: meta.workspace,
      task60: text60(meta.task, redact),
      mode: meta.mode,
      source: 'cli',
      branch,
      resumeOf: null,
    };
    lines.push(startLine);
    for (const r of meta.resumes) if (isIsoLike(r.resumedAt)) lines.push({ ...startLine, t: r.resumedAt, resumeOf: meta.runId });
    if (meta.title) lines.push({ v: 1, t: meta.createdAt, kind: 'rename', sessionId: fields.sessionId, title60: text60(meta.title, redact) });
    try {
      const statePath = join(dir, 'state.json');
      const [st, text] = await Promise.all([stat(statePath), readFile(statePath, 'utf8')]);
      const env = parseEnvelope(text);
      const stop = env.ok ? env.state.stopReason : null;
      if (env.ok && stop !== null) {
        const s = env.state;
        lines.push({
          v: 1,
          t: st.mtime.toISOString(),
          kind: 'run:end',
          sessionId: fields.sessionId,
          runId: meta.runId,
          stopReason: stop,
          steps: s.step,
          costUsd: { generator: s.spend.generator.costUsd, jev: s.spend.jev.costUsd },
          wallMs: s.wallMsUsed,
          changedFiles: s.createdThisRun.length,
          exitCode: exitCodeFor(stop, undefined, s.checkpointDegraded ?? false),
          resumable: stop !== 'complete',
          degraded: s.checkpointDegraded ?? false,
        });
      }
    } catch {
      // no state.json (a run that never got to its first checkpoint): run:start alone
    }
  }
  lines.sort((a, b) => ms(a.t) - ms(b.t));
  const body = lines
    .map((l) => JSON.stringify(l))
    .filter((s) => Buffer.byteLength(s, 'utf8') <= INDEX_LINE_MAX_BYTES)
    .map((s) => `${s}\n`)
    .join('');
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  const tmp = `${out}.${process.pid}.tmp`;
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, out);
  return { runs, skipped };
}
