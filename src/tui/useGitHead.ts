/**
 * TUI-DESIGN §12.2 (A142, D7): the status line's git zone follows HEAD without a spawn.
 *
 * `fs.watch(gitDir, { persistent: false })` filtered on `!filename || filename === 'HEAD'`, a
 * 100 ms debounce, then an in-process read of `<gitDir>/HEAD` plus the loose ref file or
 * `packed-refs` (0.0–0.1 ms; never `git`). A watcher error freezes the value: the zone keeps
 * showing the last head it knew with `frozen: true` (§15 item 20 `GitZone.frozen`). The
 * ahead/behind and dirty counts of the zone come from the run-start `GitState` and the
 * `invalidateCandidates()` refresh (`workspace.gitState()`), not from here. The reader itself
 * (`readHead`, `resolveRef`, the parsers, `HeadFs`) lives in `src/workspace/gitstate.ts` so the
 * workspace can refresh `gitState().head` after each `run` outcome without importing a React module;
 * it is re-exported here unchanged, and `watchHead`/`useGitHead` are a thin layer over it.
 *
 * Bounds (§18 lag gate): a HEAD event costs two or three small file reads on the Ink loop; `packed-refs`
 * is parsed once per rewrite and reused by (path, mtimeMs, size), so a repository with tens of thousands
 * of tags does not re-split a multi-MB file on every checkout. Reftable repositories (`HEAD` =
 * `ref: refs/heads/.invalid`) read as unknown and the zone keeps the probe's `initial` head.
 */
import { watch as fsWatch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { useEffect, useState } from 'react';

import type { GitHead } from '../core/types.js';
import { nodeHeadFs, readHead } from '../workspace/gitstate.js';
import type { HeadFs } from '../workspace/gitstate.js';

export { MAX_SYMREF_DEPTH, REFTABLE_HEAD_REF, branchName, nodeHeadFs, packedRefOid, parseHeadText, parsePackedRefs, readHead, resetPackedRefsCache, resolveRef } from '../workspace/gitstate.js';
export type { HeadFs } from '../workspace/gitstate.js';

/** TUI-DESIGN §12.2: the debounce between the HEAD event and the read (git writes `HEAD.lock` then renames). */
export const HEAD_DEBOUNCE_MS = 100;

export interface WatchHeadOptions {
  commonDir?: string | null;
  debounceMs?: number;
  watch?: typeof fsWatch;
  fs?: HeadFs;
}

export interface HeadWatcher {
  close(): void;
}

/**
 * TUI-DESIGN §12.2: watch `<gitDir>` for HEAD changes. `onChange` receives `readHead()` once per
 * debounced burst (a `HEAD.lock` → `HEAD` rename is one burst); events for other entries (`index`,
 * `ORIG_HEAD`, `refs/…`) never trigger a read. `onError` fires once — when the watcher cannot be
 * created or reports an error — after which nothing else is delivered (the zone freezes). Non-persistent:
 * the watcher never keeps the process alive.
 */
export function watchHead(gitDir: string, onChange: (head: GitHead | null) => void, onError: () => void, o: WatchHeadOptions = {}): HeadWatcher {
  const debounceMs = typeof o.debounceMs === 'number' && Number.isFinite(o.debounceMs) && o.debounceMs >= 0 ? o.debounceMs : HEAD_DEBOUNCE_MS;
  const watchImpl = o.watch ?? fsWatch;
  const fs = o.fs ?? nodeHeadFs;
  const common = o.commonDir ?? null;
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  const stop = (): void => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (watcher !== null) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
    }
    watcher = null;
  };
  const fire = (): void => {
    timer = null;
    if (closed) return;
    onChange(readHead(gitDir, common, fs));
  };
  try {
    watcher = watchImpl(gitDir, { persistent: false }, (_event, filename) => {
      if (closed) return;
      const name = filename === null || filename === undefined ? '' : String(filename);
      if (name !== '' && name !== 'HEAD') return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fire, debounceMs);
    });
  } catch {
    stop();
    onError();
    return { close: stop };
  }
  watcher.on('error', () => {
    if (closed) return;
    stop();
    onError();
  });
  return { close: stop };
}

/** TUI-DESIGN §15 item 20: the part of `GitZone` this hook owns. */
export interface GitHeadView {
  head: GitHead | null;
  /** the watcher failed: `head` is the last value read and will not move again this run */
  frozen: boolean;
}

/**
 * TUI-DESIGN §12.2: the Ink hook. Reads HEAD in-process on mount (falling back to `initial`, the
 * run-start `GitState.head`, when the read yields nothing — HEAD unreadable, or a reftable repository),
 * then follows the watcher; `gitDir === null` (no repository) yields `{ head: initial, frozen: false }`
 * and watches nothing. A change of `gitDir`/`commonDir` (a new run in another worktree) closes the old
 * watcher, re-reads HEAD and starts a new one. `debounceMs`, `watch` and `fs` are effect dependencies:
 * pass stable references (module-level or memoised).
 */
export function useGitHead(gitDir: string | null, commonDir: string | null, initial: GitHead | null, o: Omit<WatchHeadOptions, 'commonDir'> = {}): GitHeadView {
  const { debounceMs, watch, fs } = o;
  const [view, setView] = useState<GitHeadView>({ head: initial, frozen: false });
  useEffect(() => {
    if (gitDir === null) {
      setView({ head: initial, frozen: false });
      return undefined;
    }
    setView({ head: readHead(gitDir, commonDir, fs) ?? initial, frozen: false });
    const w = watchHead(
      gitDir,
      (head) => setView((v) => (v.frozen ? v : { head: head ?? v.head, frozen: false })),
      () => setView((v) => ({ head: v.head, frozen: true })),
      { commonDir, ...(debounceMs !== undefined ? { debounceMs } : {}), ...(watch !== undefined ? { watch } : {}), ...(fs !== undefined ? { fs } : {}) },
    );
    return () => w.close();
    // `initial` is a mount-time fallback only: re-seeding on every render would restart the watcher
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitDir, commonDir, debounceMs, watch, fs]);
  return view;
}
