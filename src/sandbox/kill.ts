/**
 * Three-pass process-tree kill (DESIGN.md §8).
 *
 * `detached: true` puts the shell in its own process group, so `kill(-pid)` reaches ordinary
 * descendants; anything that called setsid/setpgid escapes the group. The `ps` snapshot,
 * taken from the harness (never inside seatbelt, where /bin/ps fails to exec), walks the
 * ppid graph from the root and unions every pid whose pgid is the root, so those escapees are
 * still signalled while their parent chain is alive. Whatever survives SIGKILL is returned as
 * `orphans` rather than dropped: the transcript and Jev both see it.
 */
import { execFile } from 'node:child_process';

export interface ProcEntry {
  pid: number;
  ppid: number;
  pgid: number;
  /** BSD `stat` column; `Z` prefix marks a zombie that is already dead */
  stat: string;
}

export interface KillTreeOptions {
  /** ms between SIGTERM and SIGKILL (default 2000) */
  graceMs?: number;
  /** ms after SIGKILL before the final liveness check (default 60) */
  settleMs?: number;
  /** poll interval during the grace period; the pass ends early when nothing is left alive */
  pollMs?: number;
  snapshot?: () => Promise<ProcEntry[]>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface KillTreeResult {
  /** every pid identified as part of the tree across both snapshots (root included) */
  tree: number[];
  /** pids from `tree` still alive (not zombies) after SIGKILL */
  orphans: number[];
  /** the `ps` snapshot itself failed; only the group kill and the root pid were attempted */
  snapshotFailed: boolean;
}

const PS_TIMEOUT_MS = 5_000;
const PS_MAX_BYTES = 16 * 1024 * 1024;

/** One `ps -axo pid,ppid,pgid,stat` from the harness. */
export function snapshotProcesses(): Promise<ProcEntry[]> {
  return new Promise((resolvePs, rejectPs) => {
    execFile('/bin/ps', ['-axo', 'pid,ppid,pgid,stat'], { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BYTES, env: { PATH: '/usr/bin:/bin' } }, (err, stdout) => {
      if (err) {
        rejectPs(err);
        return;
      }
      resolvePs(parsePs(stdout));
    });
  });
}

export function parsePs(text: string): ProcEntry[] {
  const out: ProcEntry[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*(\S*)/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), stat: m[4] ?? '' });
  }
  return out;
}

/** Descendants of `root` by ppid plus every member of `root`'s process group; `root` included. */
export function collectTree(snapshot: readonly ProcEntry[], root: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const e of snapshot) {
    const list = children.get(e.ppid);
    if (list) list.push(e.pid);
    else children.set(e.ppid, [e.pid]);
  }
  const tree = new Set<number>([root]);
  const queue = [root];
  while (queue.length) {
    const pid = queue.pop()!;
    for (const c of children.get(pid) ?? []) {
      if (!tree.has(c)) {
        tree.add(c);
        queue.push(c);
      }
    }
  }
  for (const e of snapshot) if (e.pgid === root) tree.add(e.pid);
  return tree;
}

function alivePids(snapshot: readonly ProcEntry[], candidates: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (const e of snapshot) if (candidates.has(e.pid) && !e.stat.startsWith('Z')) out.push(e.pid);
  return out.sort((a, b) => a - b);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function signalAll(kill: NonNullable<KillTreeOptions['kill']>, root: number, pids: Iterable<number>, sig: NodeJS.Signals): void {
  // The group first (catches members forked between snapshot and signal), then each pid.
  try {
    kill(-root, sig);
  } catch {
    /* ESRCH: group already gone */
  }
  for (const pid of pids) {
    try {
      kill(pid, sig);
    } catch {
      /* ESRCH: already exited */
    }
  }
}

export async function killTree(root: number, opts: KillTreeOptions = {}): Promise<KillTreeResult> {
  const graceMs = opts.graceMs ?? 2_000;
  const settleMs = opts.settleMs ?? 60;
  const pollMs = Math.max(10, opts.pollMs ?? 100);
  const snapshot = opts.snapshot ?? snapshotProcesses;
  const kill = opts.kill ?? ((pid, sig) => process.kill(pid, sig));
  const sleep = opts.sleep ?? defaultSleep;

  if (!Number.isInteger(root) || root <= 1) return { tree: [], orphans: [], snapshotFailed: false };

  let snapshotFailed = false;
  const takeSnapshot = async (): Promise<ProcEntry[] | null> => {
    try {
      return await snapshot();
    } catch {
      snapshotFailed = true;
      return null;
    }
  };

  // Pass 1: snapshot before any signal so pids are still parented to the tree.
  const first = await takeSnapshot();
  const union = first ? collectTree(first, root) : new Set<number>([root]);

  // Pass 2: SIGTERM to the group and to every snapshotted pid.
  signalAll(kill, root, union, 'SIGTERM');

  // Grace, polling so a cooperative tree does not cost the full 2 s; a fresh snapshot each
  // poll also catches anything forked while a parent was still alive.
  let latest: ProcEntry[] | null = null;
  const deadline = Date.now() + graceMs;
  for (;;) {
    latest = await takeSnapshot();
    if (latest) {
      for (const pid of collectTree(latest, root)) union.add(pid);
      if (alivePids(latest, union).length === 0) break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }

  // Pass 3: SIGKILL the union, then a final check.
  signalAll(kill, root, union, 'SIGKILL');
  await sleep(settleMs);
  const final = await takeSnapshot();
  const orphans = final ? alivePids(final, union) : [];
  return { tree: [...union].sort((a, b) => a - b), orphans, snapshotFailed };
}
