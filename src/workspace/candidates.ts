/**
 * Candidate file listing with a cache (DESIGN.md §8).
 *
 * Listed once at run start; edit/write/patch outcomes update entries from their changed
 * paths; only a `run` outcome forces a re-list, and even then only paths not already cached
 * are stat'ed and sniffed. Symlinks, binaries (NUL in the first 8 KB), files over 1 MB and
 * secret paths never become candidates.
 */
import { lstat, open, readdir } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';

import type { Candidate } from '../core/types.js';
import { stepTimeline } from '../perf/timeline.js';

export const MAX_CANDIDATE_BYTES = 1024 * 1024;
export const MAX_LIST_ENTRIES = 20_000;
export const SNIFF_BYTES = 8 * 1024;
const STAT_CONCURRENCY = 32;

export const WALK_SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'dist', 'build', '__pycache__', 'target', '.tox', '.mypy_cache', '.pytest_cache',
]);

/**
 * True when a directory segment of the workspace-relative path is a `WALK_SKIP_DIRS` name (the file's own name
 * never counts). The readdir walk never enters those directories; the git listing applies the same rule to its
 * UNTRACKED entries (git.ts `lsFiles`), so a virtualenv or `node_modules` the workspace forgot to gitignore does
 * not become thousands of candidates — which is what made a three-file demo read as a repository-class checkout
 * (`isRepositoryWorkspace` counts `.py` candidates) and had the localiser name `site-packages/pip/.../wheel.py`
 * as a module file. Tracked files are never dropped: a checkout that commits `dist/` or `build/` means it.
 */
export function underSkippedDir(relPath: string): boolean {
  const segs = relPath.split('/');
  for (let i = 0; i < segs.length - 1; i++) if (WALK_SKIP_DIRS.has(segs[i]!)) return true;
  return false;
}

export interface CandidateEntry {
  bytes: number;
  binary: boolean;
  touchedThisRun: boolean;
  /** dropped for size, type or content; kept so invalidation does not re-stat it */
  excluded: boolean;
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
}

export interface CandidateCache {
  list(): Promise<Candidate[]>;
  invalidate(): Promise<void>;
  noteChanged(paths: readonly string[]): Promise<void>;
  /** the raw cache, for target() and touched bookkeeping */
  entries(): ReadonlyMap<string, CandidateEntry>;
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
        if (!WALK_SKIP_DIRS.has(d.name)) stack.push(childRel);
      } else if (d.isFile()) {
        out.push(toPosix(childRel));
      }
    }
  }
  if (capped) warn?.(`candidate listing stopped at ${maxEntries} entries (MAX_LIST_ENTRIES); files beyond the cap are not offered as context`);
  return out;
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
    if (!st.isFile()) return { bytes: st.size, binary: false, touchedThisRun: touched, excluded: true, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
    if (st.size > MAX_CANDIDATE_BYTES) return { bytes: st.size, binary: false, touchedThisRun: touched, excluded: true, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
    if (statGateHit(prev, st)) {
      return { bytes: st.size, binary: prev.binary, touchedThisRun: touched, excluded: prev.binary, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
    }
    let binary = false;
    try {
      binary = st.size > 0 && (await sniffBinary(canonical));
    } catch {
      return null;
    }
    return { bytes: st.size, binary, touchedThisRun: touched, excluded: binary, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
  }

  async function names(): Promise<string[]> {
    if (deps.gitList) {
      const fromGit = await deps.gitList();
      if (fromGit !== null) return fromGit.filter((p) => p.length > 0 && !p.includes('\0')).map(toPosix);
    }
    return walkTree(deps.root, deps.warn);
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
  };
}
