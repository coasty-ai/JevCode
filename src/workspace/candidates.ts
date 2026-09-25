/**
 * Candidate file listing with a cache (DESIGN.md §8).
 *
 * Listed once at run start; edit/write/patch outcomes update entries from their changed
 * paths; only a `run` outcome forces a re-list, and even then only paths not already cached
 * are stat'ed and sniffed. Symlinks, binaries (NUL in the first 8 KB), files over 1 MB and
 * secret paths never become candidates. Binaries and files over 1 MB stay in the cache as excluded entries with
 * their `skip` reason, so the agent's `glob` and `grep` can name them (files.ts `listSkipped`) instead of answering
 * as though they did not exist.
 */
import { lstat, open, readdir } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';

import type { Candidate } from '../core/types.js';
import { stepTimeline } from '../perf/timeline.js';
import { isSkippedDirName } from './skip-dirs.js';

export const MAX_CANDIDATE_BYTES = 1024 * 1024;
export const MAX_LIST_ENTRIES = 20_000;
export const SNIFF_BYTES = 8 * 1024;
const STAT_CONCURRENCY = 32;

// the skip list and its predicate live in the zero-import skip-dirs.ts so git.ts can share them; re-exported for the existing importers
export { WALK_SKIP_DIRS, isSkippedDirName, underSkippedDir } from './skip-dirs.js';

export interface CandidateEntry {
  bytes: number;
  binary: boolean;
  touchedThisRun: boolean;
  /** dropped for size, type or content; kept so invalidation does not re-stat it */
  excluded: boolean;
  /**
   * Why a regular file was excluded: `binary` (a NUL in its first 8 KB) or `large` (over `MAX_CANDIDATE_BYTES`, and
   * text as far as the sniff sees). Absent on a candidate and on an excluded non-file.
   */
  skip?: 'large' | 'binary';
  /**
   * HARNESS-NEXT-DESIGN §3 M7 (wave S0): the `mtime` and `ctime` the entry's `binary` verdict was sniffed at.
   * `noteChanged` skips the 8 KB sniff only when `bytes`, `mtimeMs` **and** `ctimeMs` are all unchanged.
   *
   * mtime and size alone are not enough, and the writers that break them are ordinary agent commands: `tar -x`,
   * `cp -p`, `rsync -t`, `unzip` and anything restoring a cached build artefact all set mtime from the archive, so a
   * same-size file can gain new content under an unchanged (even an older) mtime — and a file that became binary
   * would stay a listed text candidate. `ctime` is the inode-change time: the kernel moves it on every write **and**
   * on `utimes`/`utimensat`, and no userspace API can set it backwards, so a restored mtime cannot hide behind it.
   * It rides the same `lstat` the gate already makes, so the extra field costs nothing.
   *
   * Absent on an entry that was never stat-gated (an old cache, a stat that failed), which simply sniffs.
   */
  mtimeMs?: number;
  /** the ctime of the same `lstat` — see `mtimeMs`; both must match for the sniff to be reused */
  ctimeMs?: number;
}

export interface CandidateDeps {
  /** realpath of the workspace */
  root: string;
  /** names of every tracked + untracked-not-ignored path, or null to use the readdir walk */
  gitList: (() => Promise<string[] | null>) | null;
  /** canonical absolute path of a relative path, or null when it escapes / is unreadable */
  resolveRead: (relPath: string) => Promise<string | null>;
  isSecret: (relPath: string, canonical: string) => boolean;
  warn?: ((message: string) => void) | undefined;
  /** the readdir walk's entry cap (default MAX_LIST_ENTRIES; injectable for tests) */
  maxEntries?: number;
}

export interface CandidateCache {
  list(): Promise<Candidate[]>;
  invalidate(): Promise<void>;
  noteChanged(paths: readonly string[]): Promise<void>;
  /** the raw cache, for target() and touched bookkeeping */
  entries(): ReadonlyMap<string, CandidateEntry>;
  /** true when the last listing stopped at the readdir walk's entry cap, so files beyond it are neither listed nor excluded */
  walkCapped(): boolean;
}

function toPosix(rel: string): string {
  return sep === '/' ? rel : rel.split(sep).join(posix.sep);
}

/** True when the first 8 KB contain a NUL byte. */
export async function sniffBinary(absPath: string): Promise<boolean> {
  const fh = await open(absPath, 'r');
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

/** Depth-first readdir walk with the ignore list and the entry cap (`maxEntries` is injectable for tests). */
export async function walkTree(root: string, warn?: (message: string) => void, maxEntries: number = MAX_LIST_ENTRIES): Promise<string[]> {
  return (await walkTreeCapped(root, warn, maxEntries)).paths;
}

/** `walkTree`, and whether it stopped at the entry cap. */
export async function walkTreeCapped(root: string, warn?: (message: string) => void, maxEntries: number = MAX_LIST_ENTRIES): Promise<{ paths: string[]; capped: boolean }> {
  const out: string[] = [];
  const stack: string[] = [''];
  let entries = 0;
  let capped = false;
  while (stack.length && !capped) {
    const rel = stack.pop()!;
    let dirents;
    try {
      dirents = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      if (++entries > maxEntries) {
        capped = true;
        break;
      }
      const childRel = rel ? join(rel, d.name) : d.name;
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (!isSkippedDirName(d.name)) stack.push(childRel);
      } else if (d.isFile()) {
        out.push(toPosix(childRel));
      }
    }
  }
  if (capped) warn?.(`candidate listing stopped at ${maxEntries} entries (MAX_LIST_ENTRIES); files beyond the cap are not offered as context`);
  return { paths: out, capped };
}

async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * §3 M7 stat gate: may the 8 KB `binary` sniff that produced `prev` be reused for `st`?
 *
 * Only when size, mtime **and** ctime all match. Dropping ctime would be wrong for writers an agent runs every day
 * (`tar -x`, `cp -p`, `rsync -t`, `unzip`, a restored build cache): they set mtime from the archive, so new content
 * can arrive under an unchanged — or older — mtime at an unchanged size. ctime moves on every write and on every
 * `utimes`, and userspace cannot move it backwards, so it closes that hole for free out of the same `lstat`.
 *
 * An entry from before the gate carries neither stamp; `undefined === number` is false, so it simply sniffs once.
 */
export function statGateHit(prev: CandidateEntry | undefined, st: { size: number; mtimeMs: number; ctimeMs: number }): prev is CandidateEntry {
  return prev !== undefined && prev.bytes === st.size && prev.mtimeMs === st.mtimeMs && prev.ctimeMs === st.ctimeMs;
}

export function createCandidateCache(deps: CandidateDeps): CandidateCache {
  let cache: Map<string, CandidateEntry> | null = null;
  let building: Promise<Map<string, CandidateEntry>> | null = null;
  let capped = false;

  async function inspect(rel: string, touched: boolean, prev?: CandidateEntry): Promise<CandidateEntry | null> {
    // The entry itself must not be a symlink: git lists untracked symlinks as bare paths
    // (no 120000 mode to filter on) and an in-workspace target would otherwise appear twice.
    try {
      if ((await lstat(join(deps.root, rel))).isSymbolicLink()) return null;
    } catch {
      return null;
    }
    const canonical = await deps.resolveRead(rel);
    if (canonical === null) return null;
    if (deps.isSecret(rel, canonical)) return null;
    let st;
    try {
      st = await lstat(canonical);
    } catch {
      return null;
    }
    const stamp = { bytes: st.size, touchedThisRun: touched, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
    if (!st.isFile()) return { ...stamp, binary: false, excluded: true };
    let binary: boolean;
    if (statGateHit(prev, st)) binary = prev.binary;
    else {
      try {
        binary = st.size > 0 && (await sniffBinary(canonical));
      } catch {
        return null;
      }
    }
    // a file over the cap is sniffed too, so `glob` can tag a 3 MB PNG `(binary)` and `grep` names only the large TEXT files it skipped
    const skip = binary ? ('binary' as const) : st.size > MAX_CANDIDATE_BYTES ? ('large' as const) : null;
    return skip === null ? { ...stamp, binary, excluded: false } : { ...stamp, binary, excluded: true, skip };
  }

  async function names(): Promise<string[]> {
    if (deps.gitList) {
      const fromGit = await deps.gitList();
      if (fromGit !== null) {
        capped = false;
        return fromGit.filter((p) => p.length > 0 && !p.includes('\0')).map(toPosix);
      }
    }
    const walked = await walkTreeCapped(deps.root, deps.warn, deps.maxEntries ?? MAX_LIST_ENTRIES);
    capped = walked.capped;
    return walked.paths;
  }

  async function fill(target: Map<string, CandidateEntry>, rels: readonly string[]): Promise<void> {
    const fresh = rels.filter((r) => !target.has(r));
    const entries = await mapBounded(fresh, STAT_CONCURRENCY, async (rel) => [rel, await inspect(rel, false)] as const);
    for (const [rel, entry] of entries) if (entry) target.set(rel, entry);
  }

  async function build(): Promise<Map<string, CandidateEntry>> {
    const m = new Map<string, CandidateEntry>();
    await fill(m, await names());
    return m;
  }

  async function ensure(): Promise<Map<string, CandidateEntry>> {
    if (cache) return cache;
    if (!building) {
      building = build().then((m) => {
        cache = m;
        building = null;
        return m;
      });
    }
    return building;
  }

  return {
    async list() {
      const m = await ensure();
      const out: Candidate[] = [];
      for (const [path, e] of m) if (!e.excluded) out.push({ path, bytes: e.bytes });
      out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return out;
    },
    async invalidate() {
      const m = await ensure();
      const current = new Set(await names());
      for (const key of [...m.keys()]) if (!current.has(key)) m.delete(key);
      await fill(m, [...current]);
    },
    /**
     * HARNESS-NEXT-DESIGN §6 S0 (the harness-overhead gate): every `run` outcome re-inspects the whole reported
     * dirty set, which on the `step-overhead` fixture is 50 files that did not change. The inspections are
     * independent, so they run at `STAT_CONCURRENCY` like `fill` instead of one at a time, and the stat gate in
     * `inspect` skips the 8 KB sniff of an unchanged file. Results are applied in input order, so a repeated path
     * still ends on its last reading and the cache is what the serial loop produced.
     */
    async noteChanged(paths) {
      const m = await ensure();
      const rels: string[] = [];
      for (const raw of paths) {
        const rel = toPosix(relative(deps.root, join(deps.root, raw)));
        if (rel.length === 0 || rel.startsWith('..')) continue;
        rels.push(rel);
      }
      if (rels.length === 0) return;
      const end = stepTimeline.span('listing', 'note-changed');
      try {
        const inspected = await mapBounded(rels, STAT_CONCURRENCY, async (rel) => [rel, await inspect(rel, true, m.get(rel))] as const);
        for (const [rel, entry] of inspected) {
          if (entry) m.set(rel, entry);
          else m.delete(rel);
        }
      } finally {
        end();
      }
    },
    entries() {
      return cache ?? new Map<string, CandidateEntry>();
    },
    walkCapped() {
      return capped;
    },
  };
}
