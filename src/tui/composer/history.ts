/**
 * Prompt history store (TUI-DESIGN §4.6, §10.7, §15 item 16; A7, A60, 16 §4.6): the file-backed `HistoryStore`.
 *
 * File `~/.jevcode/history.jsonl`, one line `{ "t": iso, "workspace": realpath, "kind": "prompt" | "steer" | "command", "text" }`.
 * `text` is written only through the injected `redact` (after the host's `addSecret` on `y`, §10.2), 4 KiB per entry,
 * 1,000 entries in memory; consecutive duplicates within a workspace dropped. The file is read once, synchronously, at
 * construction (≤ 4 MiB tail, ≈ 1 ms: only the bytes) and decoded + parsed on the first access, still synchronously, so
 * Up/Ctrl-R never see an empty store by timing and the first-frame tick pays for the read alone. Appends are `O_APPEND`
 * writes; the file is allowed to grow `HISTORY_REWRITE_SLACK` lines past the cap before one atomic rewrite of the newest
 * 1,000 compacts it, so a long-term user at the cap pays a 4 MiB rewrite once per 100 submits instead of on every one.
 * Writes are off for `source !== 'cli'` (bench/perf), `--no-history` and `JEVCODE_NO_HISTORY=1`; reads and in-memory
 * recall still work. Write failures (and a throwing redactor, code `EREDACT`, which drops the entry rather than
 * ever storing unredacted text) report `could not write history.jsonl: <code>` through `onWriteError`; nothing here throws.
 */
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { writeFileAtomicSync } from '../../core/atomic.js';
import type { HistoryStore } from '../../core/types.js';
import { normaliseChunk } from './filter.js';

/** The three kinds a history line records (TUI-DESIGN §4.6). */
export type HistoryKind = 'prompt' | 'steer' | 'command';

/** One JSONL line of the history file (TUI-DESIGN §4.6). */
export interface HistoryEntry {
  readonly t: string;
  readonly workspace: string;
  readonly kind: HistoryKind;
  readonly text: string;
}

/** Construction options for the file-backed store (TUI-DESIGN §4.6, §15 item 16); the clock and redactor are injected. */
export interface HistoryStoreOptions {
  /** `~/.jevcode/history.jsonl` */
  readonly path: string;
  /** realpath of the current workspace; the `workspace` filter compares against it */
  readonly workspace: string;
  /** the session redactor (`SessionHost.redact`); every stored text passes through it */
  readonly redact: (s: string) => string;
  /** false for `--no-history`, `JEVCODE_NO_HISTORY=1` and `source !== 'cli'`; reads still work */
  readonly writes: boolean;
  /** ISO clock, injected so the store stays deterministic in tests */
  readonly now?: () => string;
  /** toast + log hook for `could not write <file>: <code>` (TUI-DESIGN §4.6, judge-safety rule d) */
  readonly onWriteError?: (info: { file: string; code: string }) => void;
  readonly maxEntries?: number;
  readonly maxEntryBytes?: number;
  readonly maxReadBytes?: number;
  /** lines the file may hold beyond `maxEntries` before the one atomic rewrite (0 = rewrite as soon as the cap is exceeded) */
  readonly rewriteSlack?: number;
}

/** Marker replacing a detected secret span in a cleared draft (TUI-DESIGN §10.7). */
export const DRAFT_REDACTED = '[REDACTED:draft]';
/** Entry cap kept in memory and after a rewrite (TUI-DESIGN §4.6). */
export const HISTORY_MAX_ENTRIES = 1000;
/** Lines the file may grow past the cap before one atomic rewrite of the newest `HISTORY_MAX_ENTRIES` (TUI-DESIGN §4.6, the ≈ 3 ms budget). */
export const HISTORY_REWRITE_SLACK = 100;
/** Per-entry cap in UTF-8 bytes; longer texts are clipped with `…` (TUI-DESIGN §4.6). */
export const HISTORY_MAX_ENTRY_BYTES = 4096;
/** The synchronous load reads at most this much from the file's tail (TUI-DESIGN §1, §4.6: ≤ 4 MiB, ≈ 3 ms). */
export const HISTORY_MAX_READ_BYTES = 4 * 1024 * 1024;
/** `history.jsonl` is created 0600 inside a 0700 `~/.jevcode` (TUI-DESIGN §4.6; the seatbelt denies it to sandboxed commands). */
export const HISTORY_FILE_MODE = 0o600;
/** Mode of the `~/.jevcode` directory the store creates on first write (TUI-DESIGN §4.6). */
export const HISTORY_DIR_MODE = 0o700;
/** `onWriteError` code when the injected redactor throws: the entry is dropped, never written unredacted (TUI-DESIGN §4.6, §10). */
export const HISTORY_REDACT_ERROR = 'EREDACT';

const KINDS: ReadonlySet<string> = new Set<HistoryKind>(['prompt', 'steer', 'command']);

/** The `HistoryStore` contract (TUI-DESIGN §15 item 16) plus what the composer wiring and tests need beyond it. */
export interface FileHistoryStore extends HistoryStore {
  /** every loaded/appended entry, oldest first */
  readonly all: readonly HistoryEntry[];
  /** typed entries for the picker/search (`entries()` returns texts only, per the contract) */
  records(filter: 'workspace' | 'all'): readonly HistoryEntry[];
  /** a Ctrl-C / Esc Esc / secret-gate-Ctrl-C cleared draft: `spans` → `[REDACTED:draft]`, then the normal append (TUI-DESIGN §10.7) */
  appendCleared(text: string, spans: readonly { start: number; end: number }[]): void;
  /** true while `append` writes to disk */
  readonly writesEnabled: boolean;
  /** true once the tail has been decoded and parsed (it happens on the first `all`/`entries`/`records`/`append`) */
  readonly loaded: boolean;
}

/** Replace every hit span with `[REDACTED:draft]` (TUI-DESIGN §10.7); overlapping spans are merged, out-of-range ones clamped. */
export function maskDraft(text: string, spans: readonly { start: number; end: number }[]): string {
  if (spans.length === 0) return text;
  const sorted = spans
    .map((s) => ({ start: Math.max(0, Math.floor(s.start)), end: Math.min(text.length, Math.floor(s.end)) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const s of sorted) {
    if (s.start < pos) {
      if (s.end > pos) pos = s.end;
      continue;
    }
    out += text.slice(pos, s.start) + DRAFT_REDACTED;
    pos = s.end;
  }
  return out + text.slice(pos);
}

/** Clip `s` to at most `maxBytes` UTF-8 bytes on a code point boundary, appending `…` when cut (TUI-DESIGN §4.6: 4 KiB per entry). */
export function clipBytes(s: string, maxBytes: number): string {
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

/** Parse one JSONL line (TUI-DESIGN §4.6); null for torn/invalid lines or a wrong shape (tolerated like `steps.jsonl`). */
export function parseHistoryLine(line: string): HistoryEntry | null {
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
  const workspace = o['workspace'];
  const kind = o['kind'];
  const text = o['text'];
  if (typeof t !== 'string' || typeof workspace !== 'string' || typeof kind !== 'string' || typeof text !== 'string') return null;
  if (!KINDS.has(kind)) return null;
  return { t, workspace, kind: kind as HistoryKind, text };
}

function errorCode(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string') return (e as { code: string }).code;
  return e instanceof Error ? e.name : 'EUNKNOWN';
}

/** Read at most the last `maxBytes` of `path` synchronously as raw bytes; empty when missing or unreadable. */
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

/** Decode and parse a tail read: entries (valid lines only) and the number of lines the file holds (a torn first line is dropped). */
function parseAll(bytes: Buffer, truncated: boolean): { entries: HistoryEntry[]; lines: number } {
  const lines = bytes.toString('utf8').split('\n');
  const out: HistoryEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === 0 && truncated) continue; // the first line of a tail read is torn
    const e = parseHistoryLine(lines[i] ?? '');
    if (e !== null) out.push(e);
  }
  // `split` yields one extra element after the final '\n'; an empty file yields [''] = 0 lines
  const count = lines.length - (lines[lines.length - 1] === '' ? 1 : 0);
  return { entries: out, lines: count };
}

/**
 * Create the file-backed history store (TUI-DESIGN §4.6, §15 item 16). Reads the tail synchronously at construction
 * (missing file, EACCES, ENOENT → empty store) and parses it on first access, so it is called right after `firstFrame()`
 * resolves, never before, and Up/Ctrl-R still see every entry.
 */
export function createHistoryStore(opts: HistoryStoreOptions): FileHistoryStore {
  const maxEntries = Math.max(1, Math.floor(opts.maxEntries ?? HISTORY_MAX_ENTRIES));
  const maxEntryBytes = opts.maxEntryBytes ?? HISTORY_MAX_ENTRY_BYTES;
  const maxReadBytes = opts.maxReadBytes ?? HISTORY_MAX_READ_BYTES;
  const slack = Math.max(0, Math.floor(opts.rewriteSlack ?? HISTORY_REWRITE_SLACK));
  const now = opts.now ?? ((): string => new Date().toISOString());
  const file = basename(opts.path);
  const dir = dirname(opts.path);

  let tail: { bytes: Buffer; truncated: boolean } | null = readTail(opts.path, maxReadBytes);
  let entries: HistoryEntry[] = [];
  /** lines the file is believed to hold; `Infinity` when the tail read was truncated (the file is over the cap for sure) */
  let diskLines = 0;

  const load = (): void => {
    if (tail === null) return;
    const parsed = parseAll(tail.bytes, tail.truncated);
    entries = parsed.entries.length > maxEntries ? parsed.entries.slice(parsed.entries.length - maxEntries) : parsed.entries;
    diskLines = tail.truncated ? Number.POSITIVE_INFINITY : parsed.lines;
    tail = null;
  };

  const report = (code: string): void => {
    opts.onWriteError?.({ file, code });
  };

  const ensureDir = (): void => {
    mkdirSync(dir, { recursive: true, mode: HISTORY_DIR_MODE });
  };

  /** One atomic rewrite of the newest `maxEntries` (TUI-DESIGN §4.6); the directory is created 0700 first, never by the atomic helper. */
  const rewrite = (): void => {
    ensureDir();
    const body = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
    writeFileAtomicSync(opts.path, body, { mode: HISTORY_FILE_MODE });
    diskLines = entries.length;
  };

  const persist = (entry: HistoryEntry): void => {
    if (!opts.writes) return;
    try {
      if (diskLines + 1 > maxEntries + slack) {
        rewrite();
        return;
      }
      ensureDir();
      appendFileSync(opts.path, JSON.stringify(entry) + '\n', { mode: HISTORY_FILE_MODE });
      diskLines += 1;
    } catch (e) {
      report(errorCode(e));
    }
  };

  const filtered = (filter: 'workspace' | 'all'): readonly HistoryEntry[] => {
    load();
    return filter === 'all' ? entries : entries.filter((e) => e.workspace === opts.workspace);
  };

  /** The newest entry of this workspace, for the consecutive-duplicate rule (TUI-DESIGN §4.6: the list Up walks is per workspace). */
  const lastOfWorkspace = (): HistoryEntry | undefined => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e !== undefined && e.workspace === opts.workspace) return e;
    }
    return undefined;
  };

  const append = (kind: HistoryKind, raw: string): void => {
    if (!KINDS.has(kind) || typeof raw !== 'string') return;
    load();
    let redacted: string;
    try {
      redacted = opts.redact(normaliseChunk(raw));
    } catch {
      report(HISTORY_REDACT_ERROR); // never fall back to the unredacted text
      return;
    }
    if (typeof redacted !== 'string') {
      report(HISTORY_REDACT_ERROR);
      return;
    }
    const text = clipBytes(redacted, maxEntryBytes);
    if (text.trim().length === 0) return;
    const last = lastOfWorkspace();
    if (last !== undefined && last.text === text) return; // consecutive duplicate within this workspace
    const entry: HistoryEntry = { t: now(), workspace: opts.workspace, kind, text };
    entries = [...entries, entry];
    if (entries.length > maxEntries) entries = entries.slice(entries.length - maxEntries);
    persist(entry);
  };

  return {
    get all(): readonly HistoryEntry[] {
      load();
      return entries;
    },
    get writesEnabled(): boolean {
      return opts.writes;
    },
    get loaded(): boolean {
      return tail === null;
    },
    entries(filter: 'workspace' | 'all'): readonly string[] {
      return filtered(filter).map((e) => e.text);
    },
    records(filter: 'workspace' | 'all'): readonly HistoryEntry[] {
      return filtered(filter);
    },
    append,
    appendCleared(text: string, spans: readonly { start: number; end: number }[]): void {
      append('prompt', maskDraft(text, spans));
    },
    clear(): void {
      tail = null;
      entries = [];
      if (!opts.writes) return;
      try {
        rewrite();
      } catch (e) {
        report(errorCode(e));
      }
    },
  };
}
