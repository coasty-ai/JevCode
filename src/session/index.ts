/**
 * `~/.jevcode/sessions/index.jsonl` (TUI-DESIGN §8.2, A55): the append-only, ≤ 512-byte-per-line, `v:1` session index
 * that the picker, `-c/--continue`, `--resume <title>` and the session meter fold once per session open, `/resume`,
 * `run:end` and `budget:override`. Writer: one `appendFileSync` under `O_APPEND` (no lock file, P11; `jevcode sessions
 * reindex` is the repair path). `task60` / `title60` / `text60` are `clip(oneLine(redact(x)), 60)` (judge-safety E13).
 * `foldIndex` is pure; `readIndex` / `appendIndexLine` / `reindex` are the only I/O.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isJsonObject, parseJson } from '../core/json.js';
import { clip } from '../core/text.js';
import type { EngineMode, IntakeKind, JevProvider, RunEnded, RunMeta, RunRow, RunSource, SessionRow, StopReason } from '../core/types.js';
import type { ChatRoute } from '../chat/intake.js';
import { isRunMeta, parseEnvelope, refuseNewerRunMeta } from '../checkpoint/store.js';
import { exitCodeFor } from '../loop/stop.js';
import { oneLine } from '../tui/plain.js';

/** TUI-DESIGN §8.2: the write-side line cap; longer lines are dropped with a warning, never truncated on disk. */
export const INDEX_LINE_MAX_BYTES = 512;
export const INDEX_VERSION = 1 as const;
export const INDEX_FILE = 'index.jsonl';

/**
 * contract 1.8 item 9 (TUI-DESIGN-5 §8.1, D-AS): **ONE commit, seven kinds, one owner (slot R5-1, on behalf of all
 * six slots)** — `'session:end'`, `'relocate'`, `'handoff'` (§2.7, §2.10, R5-2), `'agent:start'`, `'agent:end'`,
 * `'land'` (§4, R5-4) and `'import'` (§5, R5-5). The names are final (`CD §E` item 7); no renames.
 *
 * Two EXISTING arms widen, both with an **optional** field and a stated reader default (§8.1 item 9, review #17):
 * every `pause` line already on disk lacks `by` and every `run:start` lacks `parentSessionId`, so a REQUIRED field
 * would fail the arm's shape for every historical session. `parseIndexBody` applies the defaults — `by ?? 'self'`,
 * `parentSessionId ?? null` — so a pre-round-5 line folds and READS BACK with them (§2.6, §14.2 #17).
 */
export type IndexLine =
  | { v: 1; t: string; kind: 'run:start'; sessionId: string; runId: string; parentRunId: string | null; workspace: string; task60: string; mode: EngineMode; source: RunSource; branch: string | null; resumeOf: string | null; parentSessionId?: string | null }
  | { v: 1; t: string; kind: 'run:end'; sessionId: string; runId: string; stopReason: StopReason; steps: number; costUsd: { generator: number; jev: number }; wallMs: number; changedFiles: number; exitCode: number; resumable: boolean; degraded: boolean }
  | { v: 1; t: string; kind: 'rename'; sessionId: string; title60: string }
  | { v: 1; t: string; kind: 'steer'; sessionId: string; runId: string; step: number; text60: string }
  | { v: 1; t: string; kind: 'undo'; sessionId: string; runId: string; step: number; by: 'undo' | 'rewind'; files: number; skipped: number }
  | { v: 1; t: string; kind: 'pause'; sessionId: string; runId: string; step: number; by?: IndexActor }
  | { v: 1; t: string; kind: 'budget'; sessionId: string; runId: string | null; setting: string; from: string; to: string }
  // TUI-DESIGN-2 §3.9 / §6 item 17: one chat request (intake, lookup or LLM turn) and what it cost, so `seedMeterFromIndex` restores chat spend on /resume
  | { v: 1; t: string; kind: 'chat'; sessionId: string; intake: IntakeKind; route: ChatRoute; costUsd: number; provider: JevProvider | 'generator' }
  // contract 1.8 item 9 / §2.7: `/end` and `jevcode sessions end` — the session is over; `/resume <id> --force` reopens it
  | { v: 1; t: string; kind: 'session:end'; sessionId: string; runId: string | null; by: IndexActor; at: 'step' | 'now'; step: number | null }
  // contract 1.8 item 9 / §12.1 S30: the session moved to another checkout (a session worktree, a second clone)
  | { v: 1; t: string; kind: 'relocate'; sessionId: string; runId: string | null; workspace: string; slug: string | null; branch: string | null }
  // contract 1.8 item 9 / §2.9: the session was handed to another device; `to` is a DEVICE LABEL, never a path or a key
  | { v: 1; t: string; kind: 'handoff'; sessionId: string; runId: string | null; to: string; workspace: string }
  // contract 1.8 item 9 / §4 (ORCHESTRATION-DESIGN §4.6): one delegated agent started
  | { v: 1; t: string; kind: 'agent:start'; sessionId: string; runId: string; manifestId: string; slug: string; role: string; baseSha: string | null }
  // contract 1.8 item 9 / §4: one delegated agent finished; `state` is the `AgentState` word it ended in
  | { v: 1; t: string; kind: 'agent:end'; sessionId: string; runId: string; manifestId: string; slug: string; state: string; costUsd: number }
  // contract 1.8 item 9 / §4.5: a land attempt and what it did to the base
  | { v: 1; t: string; kind: 'land'; sessionId: string; runId: string; manifestId: string; slug: string; outcome: string; head: string | null }
  // contract 1.8 item 9 / §5.3: one import apply; `sources` / `applied` / `skipped` are COUNTS — never a path, never a secret
  | { v: 1; t: string; kind: 'import'; sessionId: string; importId: string; sources: number; applied: number; skipped: number; undoable: boolean };

/**
 * contract 1.8 item 9 (§2.6, §2.7): who asked for a `pause` / `session:end`. The same three-arm shape
 * `PauseOptions.by` carries (`src/core/types.ts`, via `PausePoint['by']`), so a remote verb that reaches the engine
 * and the index line it writes cannot spell the actor two ways. Reader default: `'self'`.
 */
export type IndexActor = 'self' | `peer:${string}` | `device:${string}`;

export type IndexKind = IndexLine['kind'];


/**
 * contract 1.8 item 9 / D-AS / gate G-R5-10 (review #18, #55): **exported** and typed `readonly IndexKind[]`, which
 * it can be now that `IndexKind = IndexLine['kind']` exists one line above. Before round 5 this was a module-private
 * `readonly string[]`, so nothing type-checked a bad kind and §10's membership test had nothing to import; a kind
 * absent from the union is now a compile error. Appending is safe — the array is read by MEMBERSHIP, never by
 * position (`parseIndexRecord`, `indexSkipReason`).
 */
export const INDEX_KINDS: readonly IndexKind[] = [
  'run:start',
  'run:end',
  'rename',
  'steer',
  'undo',
  'pause',
  'budget',
  'chat',
  'session:end',
  'relocate',
  'handoff',
  'agent:start',
  'agent:end',
  'land',
  'import',
];

/**
 * contract 1.8 item 9: membership over the exported array — the one narrowing every reader uses. A **Set**, not
 * `Array.includes`: the fold runs it once per physical line (§18's 200,000-line gate), and the array went 8 → 15
 * members, so a linear scan per line is a measurable regression on exactly the path the gate measures.
 */
const INDEX_KIND_SET: ReadonlySet<string> = new Set<string>(INDEX_KINDS);
export function isIndexKind(v: unknown): v is IndexKind {
  return typeof v === 'string' && INDEX_KIND_SET.has(v);
}

/** TUI-DESIGN-2 §3.9: the chat spend of one session folded from its `chat` lines (the meter's `jev` / `generator` sources) */
export interface ChatSpendRow {
  jev: number;
  generator: number;
  /** `chat` lines whose route was not `run` — the `you` turns answered without a run */
  messages: number;
}

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
 * (`isRunMeta` checks v1 fields only, so *older* files load unchanged; TUI-DESIGN-4 §7.9's `refuseNewerRunMeta`
 * is what stops a **newer** one loading silently).
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

const MODES: readonly string[] = ['jev-on', 'jev-off', 'jev-only', 'llm-jev', 'agent'];
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
  stuck: true,
};
export const STOP_REASONS: readonly StopReason[] = Object.keys(STOP_REASON_SET) as StopReason[];

/** Every `IntakeKind` (TUI-DESIGN-2 §6 item 2), so a `chat` line with an unknown reading is skipped rather than folded (a compile error here when the union changes). */
const INTAKE_KIND_SET: Readonly<Record<IntakeKind, true>> = { greeting_or_smalltalk: true, question_about_this_tool: true, question_about_the_code: true, coding_task: true, ambiguous: true };
/** Every `ChatRoute` (TUI-DESIGN-2 §3.3). */
const CHAT_ROUTE_SET: Readonly<Record<ChatRoute, true>> = { run: true, asked: true, reply: true, facts: true, lookup: true, llm: true };
const CHAT_PROVIDER_SET: Readonly<Record<JevProvider | 'generator', true>> = { typesafe: true, openrouter: true, generator: true };
function isIntakeKind(v: unknown): v is IntakeKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(INTAKE_KIND_SET, v);
}
function isChatRoute(v: unknown): v is ChatRoute {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(CHAT_ROUTE_SET, v);
}
function isChatProvider(v: unknown): v is JevProvider | 'generator' {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(CHAT_PROVIDER_SET, v);
}

/** Type guard over the `StopReason` union. */
export function isStopReason(v: unknown): v is StopReason {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(STOP_REASON_SET, v);
}

/** A parsed line with its stamp's millisecond value (parsed once; the fold orders on it). */
interface IndexRecord {
  line: IndexLine;
  ms: number;
}

/**
 * TUI-DESIGN-4 §7.6 item 1: why a physical line was skipped, so `jevcode sessions` can say
 * `<n> index lines were unreadable and skipped — run jevcode sessions reindex` instead of printing the
 * fresh-install sentence over a corrupt index.
 */
export type IndexSkipReason = 'not-json' | 'bad-shape' | 'over-length' | 'unknown-kind';

/** TUI-DESIGN-4 §7.6: the per-reason tally `foldIndex` returns beside the total. */
export type IndexSkips = Readonly<Record<IndexSkipReason, number>>;

export const NO_INDEX_SKIPS: IndexSkips = { 'not-json': 0, 'bad-shape': 0, 'over-length': 0, 'unknown-kind': 0 };

/** Parse one physical line into an IndexLine; null for JSON that is torn, not `v:1`, an unknown kind, or missing its keys. */
export function parseIndexLine(line: string): IndexLine | null {
  const r = parseIndexRecord(line);
  return r === null || 'reason' in r ? null : r.line;
}

/**
 * TUI-DESIGN-4 §7.6: classify a line the fold could not use. `over-length` wins over everything (a line past the
 * write-side cap was never produced by this build), then JSON, then the kind, then the shape.
 */
export function indexSkipReason(line: string): IndexSkipReason {
  if (Buffer.byteLength(line, 'utf8') > INDEX_LINE_MAX_BYTES) return 'over-length';
  const parsed = parseJson(line);
  if (!parsed.ok || !isJsonObject(parsed.value)) return 'not-json';
  const kind = parsed.value['kind'];
  if (!isIndexKind(kind)) return 'unknown-kind';
  return 'bad-shape';
}

function parseIndexRecord(line: string): IndexRecord | { reason: IndexSkipReason } | null {
  if (Buffer.byteLength(line, 'utf8') > INDEX_LINE_MAX_BYTES) return { reason: 'over-length' };
  const parsed = parseJson(line);
  if (!parsed.ok || !isJsonObject(parsed.value)) return { reason: 'not-json' };
  const o = parsed.value;
  const t = o['t'];
  if (!isIndexKind(o['kind'])) return { reason: 'unknown-kind' };
  if (o['v'] !== INDEX_VERSION || typeof t !== 'string' || !hasCanonicalIsoShape(t)) return { reason: 'bad-shape' };
  const stamp = Date.parse(t);
  if (!Number.isFinite(stamp)) return { reason: 'bad-shape' };
  const sessionId = o['sessionId'];
  if (typeof sessionId !== 'string') return { reason: 'bad-shape' };
  const parsedLine = parseIndexBody(o, o['kind'], t, sessionId);
  return parsedLine === null ? { reason: 'bad-shape' } : { line: parsedLine, ms: stamp };
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
        // contract 1.8 item 9: the stated reader default — a pre-round-5 `run:start` has no `parentSessionId`
        parentSessionId: str('parentSessionId'),
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
      // contract 1.8 item 9: the stated reader default — a pre-round-5 `pause` line has no `by`, and an unparseable
      // one is `'self'` too (a malformed actor must not make a whole historical line unreadable).
      return { v: 1, t, kind: 'pause', sessionId, runId, step: num(o['step'], 0), by: indexActorOf(o['by']) };
    }
    case 'budget':
      return { v: 1, t, kind: 'budget', sessionId, runId: str('runId'), setting: str('setting') ?? '', from: str('from') ?? '', to: str('to') ?? '' };
    case 'chat': {
      // TUI-DESIGN-2 §3.9: an unknown reading, route or provider skips the line (never folded into a typed row)
      const intake = o['intake'];
      const route = o['route'];
      const provider = o['provider'];
      if (!isIntakeKind(intake) || !isChatRoute(route) || !isChatProvider(provider)) return null;
      return { v: 1, t, kind: 'chat', sessionId, intake, route, costUsd: Math.max(0, num(o['costUsd'], 0)), provider };
    }
    // ── contract 1.8 item 9 (D-AS): the seven round-5 kinds ──────────────────────────────────────────────────────
    case 'session:end': {
      const at = o['at'];
      const step = o['step'];
      return { v: 1, t, kind: 'session:end', sessionId, runId: str('runId'), by: indexActorOf(o['by']), at: at === 'now' ? 'now' : 'step', step: typeof step === 'number' && Number.isFinite(step) ? step : null };
    }
    case 'relocate':
      return { v: 1, t, kind: 'relocate', sessionId, runId: str('runId'), workspace: str('workspace') ?? '', slug: str('slug'), branch: str('branch') };
    case 'handoff': {
      const to = str('to');
      if (to === null) return null;
      return { v: 1, t, kind: 'handoff', sessionId, runId: str('runId'), to, workspace: str('workspace') ?? '' };
    }
    case 'agent:start': {
      const runId = str('runId');
      const slug = str('slug');
      if (runId === null || slug === null) return null;
      return { v: 1, t, kind: 'agent:start', sessionId, runId, manifestId: str('manifestId') ?? '', slug, role: str('role') ?? '', baseSha: str('baseSha') };
    }
    case 'agent:end': {
      const runId = str('runId');
      const slug = str('slug');
      if (runId === null || slug === null) return null;
      return { v: 1, t, kind: 'agent:end', sessionId, runId, manifestId: str('manifestId') ?? '', slug, state: str('state') ?? '', costUsd: Math.max(0, num(o['costUsd'], 0)) };
    }
    case 'land': {
      const runId = str('runId');
      const slug = str('slug');
      if (runId === null || slug === null) return null;
      return { v: 1, t, kind: 'land', sessionId, runId, manifestId: str('manifestId') ?? '', slug, outcome: str('outcome') ?? '', head: str('head') };
    }
    case 'import': {
      const importId = str('importId');
      if (importId === null) return null;
      return { v: 1, t, kind: 'import', sessionId, importId, sources: num(o['sources'], 0), applied: num(o['applied'], 0), skipped: num(o['skipped'], 0), undoable: o['undoable'] === true };
    }
    default:
      return null;
  }
}

/**
 * contract 1.8 item 9: `'self'` · `peer:<sessionId>` · `device:<label>`, with the stated reader default `'self'`
 * for an absent or malformed value. The two prefixed forms must carry a non-empty tail: a bare `"peer:"` names
 * nobody and would render as `paused by peer:` in the picker.
 */
function indexActorOf(v: unknown): IndexActor {
  if (typeof v !== 'string') return 'self';
  if (v === 'self') return 'self';
  if (v.startsWith('peer:') && v.length > 5) return v as `peer:${string}`;
  if (v.startsWith('device:') && v.length > 7) return v as `device:${string}`;
  return 'self';
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
  /** contract 1.8 item 3 (§2.7): the last `session:end`, or null */
  ended: RunEnded | null;
  /** contract 1.8 item 3 (§2.8): the session that delegated this one — the FIRST non-null `run:start` wins */
  parentSessionId: string | null;
  /** contract 1.8 item 3 (§2.8): every checkout this session was seen in, in first-seen order */
  workspaces: string[];
  /** TUI-DESIGN-2 §3.9: Σ `chat` lines by meter source */
  chat: ChatSpendRow;
}

/**
 * TUI-DESIGN §8.2 fold (pure): group by sessionId; per runId the last `run:start` / `run:end` win (a resume's
 * `run:start` with `resumeOf` counts as a resume, not a new run); title = last rename else the first task60;
 * lastUsed = max t over all kinds; `live` = started and not ended in the index (the picker ANDs it with `run.lock`);
 * torn, non-`v:1` and unknown lines are skipped and counted. TUI-DESIGN-2 §3.9: `chat` lines add their cost to the
 * session's `totalUsd` and are summed per source in `chat` (what `seedMeterFromIndex` restores on /resume).
 */
export function foldIndex(lines: readonly string[]): { sessions: Map<string, SessionRow>; skipped: number; skips: IndexSkips; chat: Map<string, ChatSpendRow> } {
  const folds = new Map<string, SessionFold>();
  let skipped = 0;
  // TUI-DESIGN-4 §7.6 item 1: the same skips, counted by reason
  const skips: Record<IndexSkipReason, number> = { ...NO_INDEX_SKIPS };
  for (const raw of lines) {
    if (raw.length === 0 || raw.trim() === '') continue;
    const rec = parseIndexRecord(raw);
    if (rec === null || 'reason' in rec) {
      skipped++;
      skips[rec === null ? 'bad-shape' : rec.reason] += 1;
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
        ended: null,
        parentSessionId: null,
        workspaces: [],
        chat: { jev: 0, generator: 0, messages: 0 },
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
        // contract 1.8 item 3 (§2.8): the first non-null wins — a session is delegated once, and a later
        // `run:start` of the same session (a resume, a follow-up) must not unset it
        if (f.parentSessionId === null && (line.parentSessionId ?? null) !== null) f.parentSessionId = line.parentSessionId ?? null;
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
      case 'chat':
        if (line.provider === 'generator') f.chat.generator += line.costUsd;
        else f.chat.jev += line.costUsd;
        if (line.route !== 'run') f.chat.messages += 1;
        break;
      // contract 1.8 item 3 / item 9 (§2.7, §2.8): `/end` is a SESSION fact the picker shows and `/resume` demands
      // `--force` past, so it folds onto `SessionRow.ended`; the last one wins, exactly like `rename`.
      case 'session:end':
        f.ended = { at: line.t, by: line.by === 'self' ? 'human' : 'remote' };
        break;
      // contract 1.8 item 3 (§2.8): one session, several checkouts — relocate and handoff both append a workspace
      case 'relocate':
      case 'handoff':
        if (line.workspace !== '' && !f.workspaces.includes(line.workspace)) f.workspaces.push(line.workspace);
        break;
      case 'steer':
      case 'undo':
      case 'pause':
      case 'budget':
      case 'agent:start':
      case 'agent:end':
      case 'land':
      case 'import':
        break;
      default:
        break;
    }
  }
  const sessions = new Map<string, SessionRow>();
  const chat = new Map<string, ChatSpendRow>();
  for (const f of folds.values()) {
    const runs = [...f.runs.values()].sort((a, b) => a.startedMs - b.startedMs).map((x) => x.row);
    f.row.runs = runs;
    // TUI-DESIGN-2 §3.9: the session total is the runs plus every chat request (the picker's `$` agrees with the meter)
    f.row.totalUsd = runs.reduce((acc, r) => acc + (r.costUsd ? r.costUsd.generator + r.costUsd.jev : 0), 0) + f.chat.jev + f.chat.generator;
    if (f.row.title === '') f.row.title = f.row.task60;
    /**
     * contract 1.8 item 3: `ended` / `workspaces` are READONLY on `SessionRow` and OPTIONAL — "absent" is the
     * honest state for every session written before round 5, so neither is spread in when nothing was seen
     * (a `workspaces: [ws]` on a session that never relocated would be a fact the index never recorded).
     */
    // the common case — no `session:end`, no relocate, no parent — allocates nothing (§18's fold gate runs this per session)
    const extras = f.workspaces.length === 0 ? f.workspaces : f.workspaces.filter((w) => w !== f.row.workspace);
    const row: SessionRow =
      f.ended === null && extras.length === 0 && f.parentSessionId === null
        ? f.row
        : {
            ...f.row,
            ...(f.ended === null ? {} : { ended: f.ended }),
            ...(f.parentSessionId === null ? {} : { parentSessionId: f.parentSessionId }),
            ...(extras.length === 0 ? {} : { workspaces: [f.row.workspace, ...extras].filter((w) => w !== '') }),
          };
    sessions.set(row.sessionId, row);
    if (f.chat.jev > 0 || f.chat.generator > 0 || f.chat.messages > 0) chat.set(row.sessionId, { ...f.chat });
  }
  return { sessions, skipped, skips, chat };
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
 * TUI-DESIGN-4 §7.6 item 3: the window `readIndex` folds, read **from the end**. The index is append-only and
 * time-ordered, so its tail is what the picker needs; older history stays on disk and is reachable through
 * `jevcode sessions reindex`. Measured before the window: a 51 MB / 200 k-line index took **581 ms** to fold,
 * once per session open, on the post-first-frame path.
 */
export const INDEX_FOLD_MAX_BYTES = 8 * 1024 * 1024;

/** TUI-DESIGN-4 §7.6 item 4: past this size the session emits one `[ui]` notice offering `jevcode sessions prune`. */
export const INDEX_PRUNE_NOTICE_BYTES = INDEX_FOLD_MAX_BYTES;

/** TUI-DESIGN-4 §7.6 item 4 / §12: `the session index is <n> MB — jevcode sessions prune keeps the recent ones`. */
export function indexTooLargeNotice(bytes: number): string {
  return `the session index is ${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB — jevcode sessions prune keeps the recent ones`;
}

/** TUI-DESIGN-4 §7.6 item 2 / §12: `<n> index lines were unreadable and skipped — run jevcode sessions reindex`. */
export function indexSkippedNotice(skipped: number): string {
  return `${skipped} index line${skipped === 1 ? '' : 's'} ${skipped === 1 ? 'was' : 'were'} unreadable and skipped — run jevcode sessions reindex`;
}

export interface ReadIndexResult {
  sessions: SessionRow[];
  skipped: number;
  /** TUI-DESIGN-4 §7.6 item 1: the same skips by reason */
  skips: IndexSkips;
  chat: Map<string, ChatSpendRow>;
  /** the file's size in bytes (0 when absent or unreadable) */
  bytes: number;
  /** TUI-DESIGN-4 §7.6 item 3: true when only the last `INDEX_FOLD_MAX_BYTES` were folded */
  windowed: boolean;
  error?: string;
}

/**
 * TUI-DESIGN-4 §7.6 edge 1: the last `max` bytes of `path`, starting at the first `\n` inside the window so a tail
 * read never begins mid-line. Files at or under the window are read whole. Returns the text and whether the read
 * was windowed.
 */
async function readTail(path: string, max: number): Promise<{ text: string; bytes: number; windowed: boolean; truncatedLine: boolean }> {
  const size = (await stat(path)).size;
  if (size <= max) return { text: await readFile(path, 'utf8'), bytes: size, windowed: false, truncatedLine: false };
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(max);
    const { bytesRead } = await fh.read(buf, 0, max, size - max);
    const window = buf.subarray(0, bytesRead);
    const nl = window.indexOf(0x0a);
    /**
     * §7.6 edge 2: no newline anywhere inside the 8 MiB window means a **single line longer than the window**.
     * The fold can never see it — the text handed on is empty — so `truncatedLine` carries the fact out and
     * `readIndex` counts it as one `over-length` skip. Without the flag `jevcode sessions` printed the
     * fresh-install sentence over exactly the pathological index the skip counter exists to expose.
     */
    const truncatedLine = nl < 0;
    const from = truncatedLine ? bytesRead : nl + 1;
    return { text: window.subarray(from).toString('utf8'), bytes: size, windowed: true, truncatedLine };
  } finally {
    await fh.close();
  }
}

/**
 * TUI-DESIGN §8.2: one bounded read, then the fold; sessions sorted by `lastUsed` descending. A missing file is an
 * empty index; any other read error (EACCES, EISDIR) is reported in `error` with an empty result — the session works
 * without its history. `chat` (TUI-DESIGN-2 §3.9) is the per-session chat spend the controller seeds its meter from.
 *
 * TUI-DESIGN-4 §7.6: the read is capped at `INDEX_FOLD_MAX_BYTES` **from the end**, and the result carries the file
 * size, the windowed flag and the per-reason skip tally so the caller can offer `reindex` / `prune`.
 */
export async function readIndex(path: string, opts: { maxBytes?: number } = {}): Promise<ReadIndexResult> {
  const max = opts.maxBytes ?? INDEX_FOLD_MAX_BYTES;
  let read: { text: string; bytes: number; windowed: boolean; truncatedLine: boolean };
  try {
    read = await readTail(path, max);
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return { sessions: [], skipped: 0, skips: NO_INDEX_SKIPS, chat: new Map(), bytes: 0, windowed: false };
    return { sessions: [], skipped: 0, skips: NO_INDEX_SKIPS, chat: new Map(), bytes: 0, windowed: false, error: `${errnoCode(e) ?? 'error'}: cannot read ${path}` };
  }
  const fold = foldIndex(splitIndexText(read.text));
  // §7.6 edge 2: the line that swallowed the whole window is skipped AND counted
  const skipped = fold.skipped + (read.truncatedLine ? 1 : 0);
  const skips: IndexSkips = read.truncatedLine ? { ...fold.skips, 'over-length': fold.skips['over-length'] + 1 } : fold.skips;
  const rows = [...fold.sessions.values()].sort((a, b) => ms(b.lastUsed) - ms(a.lastUsed));
  return { sessions: rows, skipped, skips, chat: fold.chat, bytes: read.bytes, windowed: read.windowed };
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
export async function reindex(runsDir: string, out: string, opts: ReindexOptions = {}): Promise<{ runs: number; skipped: number; newer: number }> {
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
  let newer = 0;
  let runs = 0;
  for (const name of names) {
    const dir = join(runsDir, name);
    let meta: RunMeta;
    try {
      const parsed = parseJson(await readFile(join(dir, 'run.json'), 'utf8'));
      // TUI-DESIGN-4 §7.9 edge: a run written by a newer build is skipped and counted separately — it is not
      // corrupt, and `jevcode report` must still be able to bundle it.
      if (parsed.ok && refuseNewerRunMeta(parsed.value, name) !== null) {
        newer++;
        skipped++;
        continue;
      }
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
  return { runs, skipped, newer };
}
