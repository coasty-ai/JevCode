/**
 * The shared-dir mirror (§9.1 `shared-dir`, §9.2 lag, §11 rows 5 / 48): our per-device subtrees are write-through copied to
 * `<sharedDir>/jevcode-commons/<kind>/<deviceId>/…` as tmp + rename on the mirror's OWN promise chain with a 5 s per-op
 * timeout; foreign devices' subtrees are read from the same root by the ledger's scanner (torn copies fail their checksum and
 * are skipped). An unmounted or vanished root is `offline` — copies are kept pending and retried on the 15 s tick; local truth
 * is never touched. `syncLagMs` is the time from our local write to our own copy reading back byte-identical (§9.2).
 */
import { dirname, join } from 'node:path';
import type { CoordFs } from './fs.js';
import { DIR_MODE, FILE_MODE, OFFLINE_CODES, classifyLedgerError, withTimeout } from './fs.js';
import { COMMONS_KINDS, commonsPaths, mirrorRoot, type Commons, type CommonsKind } from './paths.js';
import { READ_MAX_BYTES } from './records.js';

export const MIRROR_OP_TIMEOUT_MS = 5_000;
/** §9.1: `⇄ offline` in the status zone after this long */
export const MIRROR_OFFLINE_NOTICE_MS = 15 * 60_000;
/** the iCloud placeholder suffix: `<name>.icloud` means the body is not on disk yet (§11 row 5) */
export const ICLOUD_PLACEHOLDER_RE = /^\..*\.icloud$/;

export type MirrorState = 'unknown' | 'online' | 'offline';

export interface MirrorOptions {
  fs: CoordFs;
  sharedDir: string;
  /**
   * + re-review (6)(ii): the LOCAL coordination root. §10.1 bounded `sharedDir` by string containment only, so a
   * symlink inside it (or a `sharedDir` pointing at `~/.jevcode/coordination` itself) made every mirrored file read
   * back out of our own local subtree — `origin.self` again, and the forged same-device `pause` path is open. The
   * probe resolves both with `realpath` and refuses the mirror when either contains the other.
   */
  localRoot?: string;
  deviceId: string;
  monotonicNow: () => number;
  opTimeoutMs?: number;
  /** transitions, for the `{ kind: 'offline' | 'online' }` fold changes */
  onState?: (state: MirrorState, code: string | null) => void;
}

export interface Mirror {
  readonly root: string;
  readonly paths: Commons;
  readonly state: MirrorState;
  readonly offlineCode: string | null;
  /** + re-review (6)(ii): the reason the root was refused outright (containment), or null */
  readonly refused: string | null;
  /** monotonic ms when the mirror went offline, or null */
  readonly offlineSinceMono: number | null;
  /** §9.2: our last measured write → read-back lag */
  readonly lagMs: number | null;
  readonly pending: number;
  /** stat the root once (the only synchronous-in-spirit cross-device I/O at open, bounded by the op timeout) */
  probe(): Promise<boolean>;
  /** queue a copy of one of our own files (data already written locally); never throws, never awaited by the caller */
  copy(kind: CommonsKind, relInDevice: string, data: string): void;
  /** delete one of our own mirrored files (GC) */
  remove(kind: CommonsKind, relInDevice: string): void;
  /** re-attempt every pending copy after a probe (the 15 s tick) */
  retry(): Promise<void>;
  /** the chain drained (tests, `finish()`) */
  flush(): Promise<void>;
  /** foreign device ids under `<root>/<kind>/` (our own excluded); [] when offline */
  listDevices(kind: CommonsKind): Promise<string[]>;
  /** `sessions sync disable`: remove our own subtrees from the mirror */
  disable(): Promise<void>;
}

export function createMirror(o: MirrorOptions): Mirror {
  const root = mirrorRoot(o.sharedDir);
  const paths = commonsPaths(root);
  const timeoutMs = o.opTimeoutMs ?? MIRROR_OP_TIMEOUT_MS;
  const pending = new Map<string, { kind: CommonsKind; rel: string; data: string | null; queuedMono: number }>();
  let chain: Promise<void> = Promise.resolve();
  let state: MirrorState = 'unknown';
  let offlineCode: string | null = null;
  let offlineSinceMono: number | null = null;
  let lagMs: number | null = null;
  let refused: string | null = null;

  const setState = (next: MirrorState, code: string | null): void => {
    if (next === state && code === offlineCode) return;
    state = next;
    offlineCode = code;
    offlineSinceMono = next === 'offline' ? (offlineSinceMono ?? o.monotonicNow()) : null;
    o.onState?.(next, code);
  };
  const fail = (e: unknown): void => {
    const code = classifyLedgerError(e);
    if (OFFLINE_CODES.has(code) || code === 'EUNKNOWN') setState('offline', code);
  };
  const enqueue = (op: () => Promise<void>): Promise<void> => {
    const run = chain.then(() => withTimeout(op(), timeoutMs, 'mirror'));
    chain = run.catch(() => undefined);
    return run;
  };
  const target = (kind: CommonsKind, rel: string): string => join(paths.deviceDir(kind, o.deviceId), rel);

  const attempt = async (key: string): Promise<void> => {
    const p = pending.get(key);
    if (p === undefined) return;
    const path = target(p.kind, p.rel);
    try {
      if (p.data === null) {
        await o.fs.unlink(path).catch((e: unknown) => {
          if (classifyLedgerError(e) !== 'ENOENT') throw e;
        });
      } else {
        await o.fs.mkdir(dirname(path), DIR_MODE);
        await o.fs.writeAtomic(path, p.data, { fsync: false, mode: FILE_MODE });
        const back = await o.fs.readBounded(path, READ_MAX_BYTES);
        if (back.overflow || back.text !== p.data) throw Object.assign(new Error('mirror: read-back mismatch'), { code: 'EIO' });
        lagMs = Math.max(0, o.monotonicNow() - p.queuedMono);
      }
      if (pending.get(key) === p) pending.delete(key);
      setState('online', null);
    } catch (e) {
      fail(e);
      throw e;
    }
  };

  /** + re-review (6)(ii): `a` contains `b` (or is `b`) once both are realpaths. */
  const contains = (a: string, b: string): boolean => b === a || b.startsWith(a.endsWith('/') ? a : `${a}/`);

  const probe = async (): Promise<boolean> => {
    if (refused !== null) return false;
    try {
      // + re-check (8): the mirror root has to be BOOTSTRAPPED. `stat(<sharedDir>/jevcode-commons)` of a folder the
      // user just named in `sessions sync enable` is ENOENT, which failed the probe into `offline`, and `copy()` /
      // `remove()` return early while offline — so nothing ever created the root and the mirror could never come up.
      //
      // The PARENT is stat'ed first and is never created. `CoordFs.mkdir` is recursive, so creating the root blind
      // would materialise the whole chain on the local disk at an UNMOUNTED mount point — shadowing the real share
      // when it comes back and silently mirroring to a directory no other device can see. An unmounted `sharedDir`
      // must stay `offline`; a real one gains exactly one directory.
      const parent = await withTimeout(o.fs.stat(o.sharedDir), timeoutMs, 'shared dir probe');
      if (!parent.isDirectory) throw Object.assign(new Error('the shared dir is not a directory'), { code: 'ENOTDIR' });
      await withTimeout(o.fs.mkdir(root, DIR_MODE), timeoutMs, 'mirror mkdir');
      const s = await withTimeout(o.fs.stat(root), timeoutMs, 'mirror probe');
      if (!s.isDirectory) throw Object.assign(new Error('mirror root is not a directory'), { code: 'ENOTDIR' });
      const local = o.localRoot;
      if (local !== undefined) {
        const [mirrorReal, localReal] = await Promise.all([
          withTimeout(o.fs.realpath(root), timeoutMs, 'mirror realpath'),
          withTimeout(o.fs.realpath(local), timeoutMs, 'coordination realpath').catch(() => local),
        ]);
        if (contains(localReal, mirrorReal) || contains(mirrorReal, localReal)) {
          refused = `the shared dir resolves inside the coordination root (${mirrorReal})`;
          pending.clear();
          setState('offline', 'EINVAL');
          return false;
        }
      }
      setState('online', null);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  return {
    root,
    paths,
    get state() {
      return state;
    },
    get offlineCode() {
      return offlineCode;
    },
    get refused() {
      return refused;
    },
    get offlineSinceMono() {
      return offlineSinceMono;
    },
    get lagMs() {
      return lagMs;
    },
    get pending() {
      return pending.size;
    },
    probe,
    copy(kind, rel, data) {
      if (refused !== null) return;
      const key = `${kind}/${rel}`;
      pending.set(key, { kind, rel, data, queuedMono: o.monotonicNow() });
      if (state === 'offline') return;
      void enqueue(() => attempt(key)).catch(() => undefined);
    },
    remove(kind, rel) {
      if (refused !== null) return;
      const key = `${kind}/${rel}`;
      pending.set(key, { kind, rel, data: null, queuedMono: o.monotonicNow() });
      if (state === 'offline') return;
      void enqueue(() => attempt(key)).catch(() => undefined);
    },
    async retry() {
      if (pending.size === 0 && state !== 'offline') return;
      if (!(await probe())) return;
      for (const key of [...pending.keys()]) {
        try {
          await enqueue(() => attempt(key));
        } catch {
          if (state === 'offline') return;
        }
      }
    },
    flush: () => chain,
    async listDevices(kind) {
      if (refused !== null) return [];
      try {
        const names = await withTimeout(o.fs.readdir(paths.kindRoot(kind)), timeoutMs, 'mirror readdir');
        setState('online', null);
        return names.filter((n) => n !== o.deviceId && /^[a-z2-7]{8}$/.test(n)).sort();
      } catch (e) {
        if (classifyLedgerError(e) === 'ENOENT') {
          // the kind dir may simply not exist yet; only a vanished root is offline
          try {
            await withTimeout(o.fs.stat(root), timeoutMs, 'mirror probe');
            return [];
          } catch (e2) {
            fail(e2);
            return [];
          }
        }
        fail(e);
        return [];
      }
    },
    async disable() {
      await chain;
      pending.clear();
      for (const kind of COMMONS_KINDS) await o.fs.rmTree(paths.deviceDir(kind, o.deviceId)).catch(() => undefined);
    },
  };
}
