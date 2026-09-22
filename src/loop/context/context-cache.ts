/**
 * Files in view (docs/COORDINATION-DESIGN.md §8.4). Two parts:
 *
 *   - the PURE bookkeeping the checkpoint persists: `fileCache` (≤ 16 entries: rel, pin, lastUsedStep, bytesShown) with LRU
 *     eviction ordered by pin (human > jev > seed > edit > read), and `fileMemory` (≤ 64: sha12, bytes, readAt, editedAt);
 *   - `FilesInView`, the in-process content cache behind the prompt section: at prompt build every cached path is `stat`ed
 *     (size + mtime); only a path whose stat changed — or that was never loaded — is read again through the workspace's
 *     guarded `read` (path escapes, secret paths and redaction stay the workspace's), so an unchanged file costs one stat and
 *     no generator tokens beyond its (unchanged) content. `unchanged(rel)` is the §8.4 zero-cost `read`: the file is in view
 *     and its stat is unchanged (on a stat mismatch its content hash decides) → the read executes without touching the file.
 *
 * Invalidation: the engine calls `invalidate(paths)` at commit for every edit / write / patch target and every path a `run`
 * changed; a change nobody reported (the human editing between steps, §11 row 20) is caught by the stat at the next build.
 */
import { stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';
import { normaliseRelPath } from '../../checkpoint/images.js';
import { sha256Hex } from '../../core/hash.js';
import type { FileView, Workspace } from '../../core/types.js';
import { FILE_CACHE_BYTES, FILE_CACHE_MAX_ENTRIES, FILE_HASH_MAX_BYTES, FILE_MEMORY_MAX_ENTRIES, FILE_VIEW_MAX_CHARS, READ_MAX_TOTAL_CHARS } from './limits.js';
import type { FileCacheEntry, FileMemory, FileMemoryEntry, FilePin } from './types.js';

// ---------------------------------------------------------------------------------------
// fileCache (pure)
// ---------------------------------------------------------------------------------------

/** §8.4 eviction order: the lowest rank goes first. */
export const PIN_RANK: Readonly<Record<FilePin, number>> = { read: 0, edit: 1, seed: 2, jev: 3, human: 4 };

/** Upsert a path: a stronger pin wins, `lastUsedStep` only moves forward. Returns a new array. */
export function touchFile(cache: readonly FileCacheEntry[], rel: string, pinnedBy: FilePin, step: number): FileCacheEntry[] {
  const i = cache.findIndex((e) => e.rel === rel);
  if (i === -1) return [...cache, { rel, pinnedBy, lastUsedStep: step, bytesShown: 0 }];
  const cur = cache[i]!;
  const next = [...cache];
  next[i] = { ...cur, pinnedBy: PIN_RANK[pinnedBy] > PIN_RANK[cur.pinnedBy] ? pinnedBy : cur.pinnedBy, lastUsedStep: Math.max(cur.lastUsedStep, step) };
  return next;
}

export function dropFile(cache: readonly FileCacheEntry[], rel: string): FileCacheEntry[] {
  return cache.filter((e) => e.rel !== rel);
}

/** Record what a prompt build showed of each path (`bytesShown`), so the byte bound of the next eviction is honest. */
export function noteShown(cache: readonly FileCacheEntry[], shown: ReadonlyMap<string, number>): FileCacheEntry[] {
  return cache.map((e) => {
    const n = shown.get(e.rel);
    return n === undefined || n === e.bytesShown ? e : { ...e, bytesShown: n };
  });
}

function byEviction(a: FileCacheEntry, b: FileCacheEntry): number {
  return PIN_RANK[a.pinnedBy] - PIN_RANK[b.pinnedBy] || a.lastUsedStep - b.lastUsedStep || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
}

/** Least valuable first: lowest pin, then least recently used, then by path (stable). */
export function evictionOrder(cache: readonly FileCacheEntry[]): FileCacheEntry[] {
  return [...cache].sort(byEviction);
}

/** Most valuable first — the order the prompt shows them in. */
export function viewOrder(cache: readonly FileCacheEntry[]): FileCacheEntry[] {
  return evictionOrder(cache).reverse();
}

export interface EvictBounds {
  maxEntries?: number;
  /** bound on Σ bytesShown */
  maxBytes?: number;
}

/**
 * LRU by `lastUsedStep` with pins ordered human > jev > seed > edit > read, until both bounds hold (the single most valuable
 * entry is never evicted). Keeps the input order.
 */
export function evictFiles(cache: readonly FileCacheEntry[], bounds: EvictBounds = {}): { kept: FileCacheEntry[]; evicted: FileCacheEntry[] } {
  const maxEntries = bounds.maxEntries ?? FILE_CACHE_MAX_ENTRIES;
  const maxBytes = bounds.maxBytes ?? FILE_CACHE_BYTES;
  const gone = new Set<FileCacheEntry>();
  let bytes = cache.reduce((n, e) => n + e.bytesShown, 0);
  let count = cache.length;
  for (const victim of evictionOrder(cache)) {
    if (count <= maxEntries && bytes <= maxBytes) break;
    // the most valuable path always stays: one file bigger than the byte bound must not empty the view (the prompt's own
    // fill order lists what it cannot show by name, §8.5, so nothing is dropped silently either way)
    if (count <= 1) break;
    gone.add(victim);
    bytes -= victim.bytesShown;
    count -= 1;
  }
  return { kept: cache.filter((e) => !gone.has(e)), evicted: cache.filter((e) => gone.has(e)) };
}

// ---------------------------------------------------------------------------------------
// fileMemory (pure)
// ---------------------------------------------------------------------------------------

export type FileMemoryPatch = Partial<FileMemoryEntry>;

/** Upsert one path (`sha12` stays null until a hash is known). Returns a new object. */
export function rememberFile(memory: FileMemory, rel: string, patch: FileMemoryPatch): FileMemory {
  const cur = memory[rel];
  const entry: FileMemoryEntry = {
    sha12: patch.sha12 !== undefined ? patch.sha12 : (cur?.sha12 ?? null),
    bytes: patch.bytes ?? cur?.bytes ?? 0,
    readAt: patch.readAt !== undefined ? patch.readAt : (cur?.readAt ?? null),
    editedAt: patch.editedAt !== undefined ? patch.editedAt : (cur?.editedAt ?? null),
  };
  return { ...memory, [rel]: entry };
}

export function forgetFile(memory: FileMemory, rel: string): FileMemory {
  if (!(rel in memory)) return memory;
  const { [rel]: _dropped, ...rest } = memory;
  void _dropped;
  return rest;
}

function lastTouched(e: FileMemoryEntry): number {
  return Math.max(e.readAt ?? 0, e.editedAt ?? 0);
}

/** Keep the `max` most recently touched paths (ties by path). */
export function boundMemory(memory: FileMemory, max: number = FILE_MEMORY_MAX_ENTRIES): FileMemory {
  const entries = Object.entries(memory);
  if (entries.length <= max) return memory;
  entries.sort((a, b) => lastTouched(b[1]) - lastTouched(a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: FileMemory = {};
  for (const [rel, e] of entries.slice(0, max)) out[rel] = e;
  return out;
}

// ---------------------------------------------------------------------------------------
// FilesInView (in-process content cache)
// ---------------------------------------------------------------------------------------

export interface FileStatInfo {
  size: number;
  mtimeMs: number;
}

export interface FilesInViewDeps {
  /** size + mtime of a workspace-relative path; null when it cannot be stat'ed (missing, escaped, or no disk behind the workspace) */
  stat(rel: string): Promise<FileStatInfo | null>;
  /** the workspace's guarded read; PathEscapeError / SecretPathError / FileNotFoundError propagate and drop the path from view */
  read(rel: string, maxBytes: number): Promise<FileView>;
  /** sha256 hex of the raw bytes (for fileMemory); null when unavailable; called only when a file (re)loads and is small */
  hash?(rel: string): Promise<string | null>;
  /** a file larger than this is never streamed for its raw hash (the step stays cheap); its shown window's hash is the detector */
  maxHashBytes?: number;
  /** §8.5: the most one `read` may pull, which bounds how far the `[lines a–b of N]` windows can walk */
  maxReadChars?: number;
  /** ≤ 32 KiB of one file in the prompt */
  maxFileChars?: number;
}

export interface LoadedFile {
  rel: string;
  stat: FileStatInfo | null;
  /** the shown slice (redacted by the workspace), `[windowStart, windowStart + content.length)` of the file */
  content: string;
  /** the whole file's size in bytes, as the workspace reported it */
  bytes: number;
  /** bytes of the file NOT in `content` */
  truncatedBytes: number;
  /** char offset of `content` within the file (0 = the head window) */
  windowStart: number;
  /** 1-based line numbers of the shown slice, and the file's total line count when the whole file was read */
  lineFrom: number;
  lineTo: number;
  lineTotal: number | null;
  /** sha12 of the shown slice — the change detector when no stat is available */
  contentSha12: string;
  /** sha12 of the raw bytes when `hash` is available AND the whole file was read */
  rawSha12: string | null;
  loadedAtStep: number;
}

export interface ViewedFile {
  rel: string;
  /** the shown content (the prompt adds the `[lines a–b of N]` / `[N more bytes …]` marker) */
  content: string;
  bytes: number;
  truncatedBytes: number;
  windowStart: number;
  lineFrom: number;
  lineTo: number;
  lineTotal: number | null;
  /** content.length, 0 when omitted */
  shownChars: number;
  pinnedBy: FilePin;
  lastUsedStep: number;
  /** raw sha12 when known, else the content sha12 */
  sha12: string;
  /** dropped for the files byte budget at this build: listed by name only */
  omitted: boolean;
}

export interface RefreshResult {
  /** most valuable first */
  files: ViewedFile[];
  stats: number;
  reads: number;
  hashes: number;
  /** paths that could not be loaded (gone, secret, escaped): the caller drops them from the cache */
  failed: { rel: string; reason: string }[];
  ms: number;
}

export function sameStat(a: FileStatInfo, b: FileStatInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function countLines(s: string): number {
  let n = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n += 1;
  return n;
}

/** What the last prompt build actually rendered of a path — the only thing the zero-cost read may stand on (review D2). */
export interface ShownFile {
  chars: number;
  /** the shown slice is not the whole file */
  truncated: boolean;
  windowStart: number;
}

/** §8.4: the answer of a `read` the context policy can serve without going to the workspace. */
export interface ServedRead {
  text: string;
  /** chars the generator is charged for (0 for the unchanged line's pointer) */
  chars: number;
  kind: 'unchanged' | 'window';
}

export class FilesInView {
  private readonly loaded = new Map<string, LoadedFile>();
  /** what the last `refresh()` rendered (rel → the slice actually shown); cleared at every refresh */
  private shown = new Map<string, ShownFile>();
  private readonly maxFileChars: number;
  private readonly maxHashBytes: number;
  private readonly maxWindowStart: number;
  private readonly deps: FilesInViewDeps;
  private readonly now: () => number;

  constructor(deps: FilesInViewDeps, now: () => number = () => performance.now()) {
    this.deps = deps;
    this.now = now;
    this.maxFileChars = deps.maxFileChars ?? FILE_VIEW_MAX_CHARS;
    this.maxHashBytes = deps.maxHashBytes ?? FILE_HASH_MAX_BYTES;
    this.maxWindowStart = Math.max(0, (deps.maxReadChars ?? READ_MAX_TOTAL_CHARS) - this.maxFileChars);
  }

  /** Forget the loaded content of these paths (an edit / write / patch / run touched them); the next build re-reads. */
  invalidate(rels: Iterable<string>): void {
    for (const r of rels) {
      this.loaded.delete(r);
      this.shown.delete(r);
    }
  }

  clear(): void {
    this.loaded.clear();
    this.shown.clear();
  }

  has(rel: string): boolean {
    return this.loaded.has(rel);
  }

  get(rel: string): LoadedFile | undefined {
    return this.loaded.get(rel);
  }

  /** What the last build rendered of `rel` (undefined when it was not shown). */
  shownAt(rel: string): ShownFile | undefined {
    return this.shown.get(rel);
  }

  get size(): number {
    return this.loaded.size;
  }

  /**
   * Fresh content for every cached path, most valuable first, within `maxBytes` of shown content (the rest listed by name):
   * one stat per path, a read only where the stat changed or nothing is loaded yet.
   */
  async refresh(cache: readonly FileCacheEntry[], step: number, maxBytes: number = FILE_CACHE_BYTES): Promise<RefreshResult> {
    const t0 = this.now();
    const counters = { stats: 0, reads: 0, hashes: 0 };
    const files: ViewedFile[] = [];
    const failed: { rel: string; reason: string }[] = [];
    let budget = maxBytes;
    // §8.9: one round trip for the whole view, not one per path — the order below is `viewOrder`'s, so the result is the
    // same as a sequential refresh would produce
    const order = viewOrder(cache);
    const loads = await Promise.all(order.map(async (e): Promise<LoadedFile | Error> => this.load(e.rel, step, counters).catch((err: unknown) => (err instanceof Error ? err : new Error(describe(err))))));
    const shown = new Map<string, ShownFile>();
    for (const [i, entry] of order.entries()) {
      const result = loads[i]!;
      if (result instanceof Error) {
        failed.push({ rel: entry.rel, reason: result.message });
        continue;
      }
      const loaded = result;
      const chars = loaded.content.length;
      const fits = chars <= budget;
      if (fits) {
        budget -= chars;
        shown.set(entry.rel, { chars, truncated: loaded.truncatedBytes > 0, windowStart: loaded.windowStart });
      }
      files.push({
        rel: entry.rel,
        content: fits ? loaded.content : '',
        bytes: loaded.bytes,
        truncatedBytes: loaded.truncatedBytes,
        windowStart: loaded.windowStart,
        lineFrom: loaded.lineFrom,
        lineTo: loaded.lineTo,
        lineTotal: loaded.lineTotal,
        shownChars: fits ? chars : 0,
        pinnedBy: entry.pinnedBy,
        lastUsedStep: entry.lastUsedStep,
        sha12: loaded.rawSha12 ?? loaded.contentSha12,
        omitted: !fits,
      });
    }
    this.shown = shown;
    return { files, ...counters, failed, ms: Math.max(0, this.now() - t0) };
  }

  /**
   * The prompt shrank below what `refresh()` offered (a section floor, §8.2): only these paths were really rendered, so
   * only these may answer a `read` for free (review D2).
   */
  keepShown(rels: Iterable<string>): void {
    const keep = new Set(rels);
    for (const rel of [...this.shown.keys()]) if (!keep.has(rel)) this.shown.delete(rel);
  }

  private async slice(rel: string, windowStart: number, counters: { stats: number; reads: number; hashes: number }): Promise<{ view: FileView; start: number }> {
    const start = Math.max(0, Math.min(Math.floor(windowStart), this.maxWindowStart));
    const view = await this.deps.read(rel, start + this.maxFileChars);
    counters.reads += 1;
    return { view, start };
  }

  private build(rel: string, view: FileView, start: number, st: FileStatInfo | null, step: number, rawSha12: string | null): LoadedFile {
    const prefix = start > 0 ? view.content.slice(0, start) : '';
    const content = start > 0 ? view.content.slice(start) : view.content;
    // what the workspace could not give us at all: the bytes past `start + maxFileChars`
    const truncatedBytes = view.truncatedBytes;
    const whole = truncatedBytes === 0 && start === 0;
    const lineFrom = countLines(prefix) + 1;
    const lineTo = lineFrom + Math.max(0, countLines(content) - (content.endsWith('\n') ? 1 : 0));
    return {
      rel,
      stat: st,
      content,
      bytes: view.bytes,
      truncatedBytes,
      windowStart: start,
      lineFrom,
      lineTo,
      lineTotal: whole ? Math.max(lineTo, countLines(view.content) + (view.content.endsWith('\n') ? 0 : 1)) : null,
      contentSha12: sha256Hex(content).slice(0, 12),
      rawSha12: whole ? rawSha12 : null,
      loadedAtStep: step,
    };
  }

  private async load(rel: string, step: number, counters: { stats: number; reads: number; hashes: number }): Promise<LoadedFile> {
    const cur = this.loaded.get(rel);
    // nothing is held yet: the read is certain, so it goes out with the stat instead of after it (one round trip, §8.9)
    let st: FileStatInfo | null;
    let view: FileView;
    let start = 0;
    if (cur === undefined) {
      const [statResult, readResult] = await Promise.all([this.deps.stat(rel), this.slice(rel, 0, counters)]);
      counters.stats += 1;
      st = statResult;
      view = readResult.view;
    } else {
      st = await this.deps.stat(rel);
      counters.stats += 1;
      if (st !== null && cur.stat !== null && sameStat(cur.stat, st)) return cur;
      // a changed file always re-opens at its head window: the old offset may not mean anything any more
      const readResult = await this.slice(rel, 0, counters);
      view = readResult.view;
      start = readResult.start;
    }
    const loaded = this.build(rel, view, start, st, step, await this.rawHash(rel, view, st, counters));
    this.loaded.set(rel, loaded);
    return loaded;
  }

  private async rawHash(rel: string, view: FileView, st: FileStatInfo | null, counters: { stats: number; reads: number; hashes: number }): Promise<string | null> {
    // §8.9: nothing unbounded is added to the step — a big file is never streamed for its raw hash, its shown window's
    // hash (with the stat) is the change detector
    if (view.truncatedBytes > 0 || this.deps.hash === undefined) return null;
    if (st !== null && st.size > this.maxHashBytes) return null;
    counters.hashes += 1;
    return (await this.deps.hash(rel))?.slice(0, 12) ?? null;
  }

  /**
   * §8.4 zero-cost `read`: the output line when `rel` was rendered WHOLE in the last build and is unchanged. Null in every
   * other case — the read must run (reviews D1/D2/D3):
   *   - the path was not rendered last build (omitted for the files budget, or shrunk out of the prompt);
   *   - the shown slice is a window of a bigger file (its tail would be unreachable — `nextWindow` serves that);
   *   - the stat moved and the whole file's digest does not match (the entry is invalidated, never re-stamped).
   */
  async unchanged(rel: string, memory: FileMemory): Promise<ServedRead | null> {
    const shown = this.shown.get(rel);
    const cur = this.loaded.get(rel);
    if (shown === undefined || cur === undefined || cur.stat === null) return null;
    if (shown.truncated || cur.truncatedBytes > 0 || cur.windowStart > 0) return null;
    const st = await this.deps.stat(rel);
    if (st === null) return null;
    if (!sameStat(cur.stat, st)) {
      let view: FileView;
      try {
        view = await this.deps.read(rel, this.maxFileChars);
      } catch {
        this.invalidate([rel]);
        return null;
      }
      // only a whole-file match may re-stamp the stat; anything else invalidates, or the next build keeps stale content
      if (view.truncatedBytes > 0 || sha256Hex(view.content).slice(0, 12) !== cur.contentSha12) {
        this.invalidate([rel]);
        return null;
      }
      cur.stat = st;
    }
    const m = memory[rel];
    const sinceStep = m !== undefined && lastTouched(m) > 0 ? lastTouched(m) : cur.loadedAtStep;
    const sha = cur.rawSha12 ?? cur.contentSha12;
    return { text: `unchanged since step ${sinceStep} (sha ${sha.slice(0, 4)}…); the whole file is under Files in view`, chars: 0, kind: 'unchanged' };
  }

  /**
   * §8.4 / review D1: a `read` of a path already in view but shown as a window serves the NEXT window rather than
   * repeating or refusing, so the tail of a big file is always reachable and the loop detector never sees three
   * identical steps. Null when the path is not in view or the whole file is already shown.
   */
  async nextWindow(rel: string, step: number): Promise<ServedRead | null> {
    const cur = this.loaded.get(rel);
    if (cur === undefined || (cur.truncatedBytes === 0 && cur.windowStart === 0)) return null;
    const counters = { stats: 0, reads: 0, hashes: 0 };
    const atEnd = cur.truncatedBytes === 0;
    const wanted = atEnd ? 0 : cur.windowStart + cur.content.length;
    let next: LoadedFile;
    try {
      const st = await this.deps.stat(rel);
      counters.stats += 1;
      const { view, start } = await this.slice(rel, wanted, counters);
      next = this.build(rel, view, start, st, step, null);
    } catch {
      return null;
    }
    this.loaded.set(rel, next);
    const capped = wanted > this.maxWindowStart;
    const where = next.lineTotal === null ? `lines ${next.lineFrom}–${next.lineTo}, bytes ${next.windowStart}–${next.windowStart + next.content.length} of ${next.bytes}` : `lines ${next.lineFrom}–${next.lineTo} of ${next.lineTotal}`;
    const more = next.truncatedBytes > 0 ? (capped ? `\n[${next.truncatedBytes} bytes past the ${this.maxWindowStart + this.maxFileChars}-char read cap; narrow the read or grep ${rel}]` : `\n[${next.truncatedBytes} more bytes; read ${rel} again for the next window]`) : `\n[end of ${rel}]`;
    const head = atEnd ? `[back at the start of ${rel}] ` : '';
    return { text: `${head}[${where}]\n${next.content}${more}`, chars: next.content.length, kind: 'window' };
  }
}

/**
 * The production deps: one `stat` of `<root>/<rel>` (validated relative paths only) and, when it moved, the workspace's
 * guarded read. No raw hash is taken here — §8.4 fills `fileMemory.sha12` from the post image's hashes, which are already
 * computed at commit, so the step never streams a file for a second digest (§8.9).
 */
export function workspaceFilesInViewDeps(workspace: Workspace): FilesInViewDeps {
  return {
    async stat(rel) {
      const n = normaliseRelPath(rel);
      if (n === null) return null;
      try {
        const st = await fsStat(join(workspace.root, n));
        return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
      } catch {
        return null;
      }
    },
    read: (rel, maxBytes) => workspace.read(rel, maxBytes),
  };
}
