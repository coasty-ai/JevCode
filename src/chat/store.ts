/**
 * The conversation store (TUI-DESIGN-4 §5.5 P-C15, D-Y): `~/.jevcode/sessions/<id>/chat.jsonl`, one JSON line per
 * turn, so a conversation-only session survives a restart. Before round 4 `sessionId` stayed `null` until a run, the
 * ledger had no I/O at all, and `/resume` restored spend but never a single sentence of what was said.
 *
 * The scheme is `composer/history.ts`'s, deliberately: a bounded synchronous tail read at construction, parsing on
 * first access, `O_APPEND` line writes (two processes in one session interleave safely), and one atomic rewrite once
 * the file has grown `CHAT_REWRITE_SLACK` lines past the cap. Writes are off under `--no-history` /
 * `JEVCODE_NO_HISTORY` and for non-CLI sources; **reads still work**. Nothing here throws: a write failure reports
 * `could not write chat.jsonl: <code>` through `onWriteError`, and the redactor is the only path text takes to disk.
 *
 * Pure of the process otherwise: no clock, no home directory and no redactor of its own — all three are injected.
 */
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { writeFileAtomicSync } from '../core/atomic.js';
import type { IntakeKind } from '../core/types.js';
import { LEDGER_MAX_TURNS, type ChatTurn } from './ledger.js';

/** §5.5 P-C15 (c) / §14.1 row 10: 6 is what Jev sees (`LEDGER_RECENT`), 20 is what a human wants to re-read. */
export const CHAT_REPLAY_TURNS = 20;
/** Lines the file may grow past `LEDGER_MAX_TURNS` before one atomic rewrite (the `history.ts:56–58` scheme). */
export const CHAT_REWRITE_SLACK = 100;
/** Per-line cap in UTF-8 bytes (§5.5 P-C15 b). */
export const CHAT_MAX_ENTRY_BYTES = 4096;
/** §5.5 edge (c): a 20 MB chat file is tail-read, never slurped. */
export const CHAT_MAX_READ_BYTES = 4 * 1024 * 1024;
export const CHAT_FILE_MODE = 0o600;
export const CHAT_DIR_MODE = 0o700;
export const CHAT_FILE_NAME = 'chat.jsonl';
/** `onWriteError` code when the injected redactor throws: the turn is dropped, never written unredacted. */
export const CHAT_REDACT_ERROR = 'EREDACT';

/** `<sessionsDir>/<id>/chat.jsonl` — the session's own directory, so `/new` (a new id) starts a new file (edge i). */
export function chatStorePath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, sessionId, CHAT_FILE_NAME);
}

/** One JSONL line. `workspace` is not in §5.5's sketch but edge (g) needs it: a resumed conversation whose workspace moved must degrade loudly. */
export interface ChatLine {
  readonly t: string;
  readonly role: 'you' | 'jevcode';
  readonly text: string;
  readonly workspace: string;
  readonly kind?: IntakeKind;
  readonly p?: number;
  readonly costUsd?: number;
}

export interface ChatStoreOptions {
  readonly path: string;
  /** realpath of the current workspace; a stored line from elsewhere makes `workspaceMoved` true */
  readonly workspace: string;
  /** the session redactor (`SessionHost.redact`); every stored text passes through it */
  readonly redact: (s: string) => string;
  /** false for `--no-history`, `JEVCODE_NO_HISTORY=1` and `source !== 'cli'`; reads still work */
  readonly writes: boolean;
  readonly now?: () => string;
  readonly onWriteError?: (info: { file: string; code: string }) => void;
  readonly maxTurns?: number;
  readonly maxEntryBytes?: number;
  readonly maxReadBytes?: number;
  readonly rewriteSlack?: number;
}

export interface ChatStore {
  /** every loaded / appended turn, oldest first (≤ `maxTurns`) */
  readonly turns: readonly ChatTurn[];
  /** true when the file carries turns recorded against a different workspace (§5.5 edge g) */
  readonly workspaceMoved: boolean;
  readonly writesEnabled: boolean;
  /** true once the tail has been decoded and parsed (it happens on the first `turns` / `append`) */
  readonly loaded: boolean;
  append(turn: ChatTurn): void;
}

const ROLES: ReadonlySet<string> = new Set(['you', 'jevcode']);

/** Clip to at most `maxBytes` UTF-8 bytes on a code point boundary, appending `…` when cut. */
export function clipEntryBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const budget = Math.max(0, maxBytes - Buffer.byteLength('…', 'utf8'));
  let bytes = 0;
  let out = '';
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > budget) break;
    bytes += b;
    out += ch;
  }
  return out + '…';
}

/** Parse one JSONL line; null for a torn or wrong-shaped line (tolerated exactly like `steps.jsonl`). */
export function parseChatLine(line: string): ChatLine | null {
  if (line.length === 0) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const t = o['t'];
  const role = o['role'];
  const text = o['text'];
  const workspace = o['workspace'];
  if (typeof t !== 'string' || typeof role !== 'string' || typeof text !== 'string' || !ROLES.has(role)) return null;
  const kind = o['kind'];
  const p = o['p'];
  const costUsd = o['costUsd'];
  return {
    t,
    role: role as 'you' | 'jevcode',
    text,
    workspace: typeof workspace === 'string' ? workspace : '',
    ...(typeof kind === 'string' ? { kind: kind as IntakeKind } : {}),
    ...(typeof p === 'number' && Number.isFinite(p) ? { p } : {}),
    ...(typeof costUsd === 'number' && Number.isFinite(costUsd) ? { costUsd } : {}),
  };
}

function toTurn(l: ChatLine): ChatTurn {
  return { role: l.role, text: l.text, at: l.t, ...(l.kind !== undefined ? { kind: l.kind } : {}), ...(l.p !== undefined ? { probability: l.p } : {}), ...(l.costUsd !== undefined ? { costUsd: l.costUsd } : {}) };
}

function errorCode(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string') return (e as { code: string }).code;
  return e instanceof Error ? e.name : 'EUNKNOWN';
}

function readTail(path: string, maxBytes: number): { bytes: Buffer; truncated: boolean } {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    return { bytes: buf.subarray(0, off), truncated: start > 0 };
  } catch {
    return { bytes: Buffer.alloc(0), truncated: false };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * §5.5 P-C15 / edge (e): the file-backed conversation store, opened **lazily** — construction touches no
 * descriptor at all, and the bounded tail read plus the parse both happen on the first `turns` / `workspaceMoved`
 * / `append`. The first frame must cost zero file I/O (§11 "first frame"), and a store is constructed while the
 * session is being assembled, before anyone has asked for a turn.
 */
export function createChatStore(opts: ChatStoreOptions): ChatStore {
  const maxTurns = Math.max(1, Math.floor(opts.maxTurns ?? LEDGER_MAX_TURNS));
  const maxEntryBytes = opts.maxEntryBytes ?? CHAT_MAX_ENTRY_BYTES;
  const maxReadBytes = opts.maxReadBytes ?? CHAT_MAX_READ_BYTES;
  const slack = Math.max(0, Math.floor(opts.rewriteSlack ?? CHAT_REWRITE_SLACK));
  const now = opts.now ?? ((): string => new Date().toISOString());
  const file = basename(opts.path);
  const dir = dirname(opts.path);

  let lines: ChatLine[] = [];
  let moved = false;
  let diskLines = 0;
  let didLoad = false;

  const load = (): void => {
    if (didLoad) return;
    didLoad = true;
    const tail = readTail(opts.path, maxReadBytes);
    const text = tail.bytes.toString('utf8');
    const raw = text.split('\n');
    const parsed: ChatLine[] = [];
    for (let i = 0; i < raw.length; i++) {
      if (i === 0 && tail.truncated) continue; // a tail read's first line is torn
      const l = parseChatLine(raw[i] ?? '');
      if (l === null) continue;
      if (l.workspace !== '' && l.workspace !== opts.workspace) moved = true;
      parsed.push(l);
    }
    lines = parsed.length > maxTurns ? parsed.slice(parsed.length - maxTurns) : parsed;
    diskLines = tail.truncated ? Number.POSITIVE_INFINITY : raw.length - (raw[raw.length - 1] === '' ? 1 : 0);
  };

  const ensureDir = (): void => {
    mkdirSync(dir, { recursive: true, mode: CHAT_DIR_MODE });
  };

  const rewrite = (): void => {
    ensureDir();
    const body = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length > 0 ? '\n' : '');
    writeFileAtomicSync(opts.path, body, { mode: CHAT_FILE_MODE });
    diskLines = lines.length;
  };

  const persist = (line: ChatLine): void => {
    if (!opts.writes) return;
    try {
      if (diskLines + 1 > maxTurns + slack) {
        rewrite();
        return;
      }
      ensureDir();
      appendFileSync(opts.path, JSON.stringify(line) + '\n', { mode: CHAT_FILE_MODE });
      diskLines += 1;
    } catch (e) {
      opts.onWriteError?.({ file, code: errorCode(e) });
    }
  };

  return {
    get turns() {
      load();
      return lines.map(toTurn);
    },
    get workspaceMoved() {
      load();
      return moved;
    },
    get writesEnabled() {
      return opts.writes;
    },
    get loaded() {
      return didLoad;
    },
    append(turn) {
      load();
      if (turn.role !== 'you' && turn.role !== 'jevcode') return;
      let text: string;
      try {
        text = opts.redact(turn.text);
      } catch {
        opts.onWriteError?.({ file, code: CHAT_REDACT_ERROR });
        return;
      }
      const line: ChatLine = {
        t: turn.at !== '' ? turn.at : now(),
        role: turn.role,
        text: clipEntryBytes(text, maxEntryBytes),
        workspace: opts.workspace,
        ...(turn.kind !== undefined ? { kind: turn.kind } : {}),
        ...(turn.probability !== undefined && Number.isFinite(turn.probability) ? { p: turn.probability } : {}),
        ...(turn.costUsd !== undefined && Number.isFinite(turn.costUsd) ? { costUsd: turn.costUsd } : {}),
      };
      lines.push(line);
      if (lines.length > maxTurns) lines.splice(0, lines.length - maxTurns);
      persist(line);
    },
  };
}

// ---------------------------------------------------------------------------------------
// Replay (§5.5 P-C15 c) and `/copy conversation` (§5.5 P-C13)
// ---------------------------------------------------------------------------------------

/** §12: the one heading above a replayed conversation — the ledger carries both numbers so it can state them. */
export function resumedConversationHeading(shown: number, total: number): string {
  return `resumed conversation — ${Math.max(0, shown)} of ${Math.max(0, total)} earlier turns`;
}

/** §5.5 edge (g): the workspace of the stored conversation is not this one. */
export const CONVERSATION_NOT_RESTORED = 'earlier conversation was recorded in another workspace — not restored';

/** §5.5 P-C15 (c): the last `n` turns to replay, with the heading that states both counts. */
export function chatReplay(turns: readonly ChatTurn[], n: number = CHAT_REPLAY_TURNS): { heading: string; turns: readonly ChatTurn[] } {
  const take = Math.max(0, Math.floor(n));
  const shown = take >= turns.length ? turns : turns.slice(turns.length - take);
  return { heading: resumedConversationHeading(shown.length, turns.length), turns: shown };
}

/** §5.5 P-C13: `/copy conversation` — the whole ledger as `you: …` / `jevcode: …` blocks, one blank row between turns. */
export function conversationText(turns: readonly ChatTurn[]): string {
  return turns.map((t) => `${t.role}: ${t.text}`).join('\n\n');
}
