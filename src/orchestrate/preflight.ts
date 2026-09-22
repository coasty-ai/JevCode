/**
 * The resource pre-flight (docs/ORCHESTRATION-DESIGN.md §3.6, §8.2 D2 item 21, corner row 45): the
 * arithmetic that decides how many agents actually fit, run BEFORE any worktree exists.
 *
 * `preflight` is pure. Every environmental fact — free disk, free memory, the hardware thread count,
 * the measured repo size, the soft `RLIMIT_NOFILE` — arrives through an injected `PreflightProbe`
 * (§8.1 rule 1), which is what makes "the disk is full" and "the box has three cores" ordinary unit
 * cases. `nodePreflightProbe` is the one impure export and the only place `node:os` / `statfs` / `du`
 * appear; a caller that has a sandboxed git seam passes it in so the git dir is resolved through it.
 *
 * The invariant that matters more than the arithmetic, and the one `split/gate.ts`'s `fits()` already
 * states: **an unmeasurable denominator is UNBOUNDED, never zero.** A machine with no `statfs`, a
 * container with no `getrlimit`, a `du` that timed out — none of those is evidence that nothing fits,
 * and reading them as zero would turn every such box into `no_split` for a reason that is not true.
 * A `null` reading therefore contributes no limit at all and says so in `reasons`, which is what the
 * manifest's `rejected` list and the §3.7 card print.
 *
 * A shortfall REDUCES the count; the caller drops the lowest-ranked agents and merges their items into
 * the survivors, and below 2 the whole thing is `no_split` with the reason. That decision is the
 * caller's: this module only answers "how many fit, and what stopped the rest".
 */
// `node:os` and `node:path` are the only module-scope node imports, and neither is reachable from
// `preflight` itself: `freeMemBytes()` and `availableParallelism()` are SYNCHRONOUS members of the seam,
// so `nodePreflightProbe` cannot defer them to a dynamic import the way it defers `statfs` and `du`.
// Nothing in the pure half below the seam touches either module.
import { availableParallelism, freemem } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';

import type { RunGit } from './types.js';

// ---------------------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------------------

export interface PreflightProbe {
  /** free bytes and total bytes of the filesystem holding the repo (statfs) */
  diskFree(path: string): Promise<{ freeBytes: number; totalBytes: number } | null>;
  /** free system memory in bytes (os.freemem) */
  freeMemBytes(): number | null;
  /** os.availableParallelism() */
  availableParallelism(): number | null;
  /** measured repo size in bytes: `du -sk` of .git + checkout, cached per repoKey by the CALLER */
  repoBytes(path: string): Promise<number | null>;
  /** the soft RLIMIT_NOFILE, when it can be read; null when it cannot */
  openFileLimit(): number | null;
}

export interface PreflightInput {
  repoRoot: string;
  /** the agent count the normaliser asked for */
  want: number;
  /** `orchestrate.minFreeBytes`, default 2 GiB (§6.4) */
  minFreeBytes: number;
  /** `orchestrate.agentMemBytes`, default 3 GiB — the bench's measured 2.9 GB RSS peak (§6.4) */
  agentMemBytes: number;
}

export type PreflightLimit = 'disk' | 'memory' | 'cpu' | 'fds';

export interface PreflightReason {
  limit: PreflightLimit;
  /** how many agents this limit allows; `Infinity` when it could not be measured and is therefore not a limit */
  allowed: number;
  /** the arithmetic in one line, for `Manifest.rejected` and the §3.7 card */
  text: string;
}

export interface PreflightResult {
  /** the agent count that fits; 0 or 1 means `no_split` */
  agents: number;
  /** every limit that reduced the count, with the arithmetic that did it — for Manifest.rejected and the card */
  reasons: readonly PreflightReason[];
  /** true when `agents < want` */
  reduced: boolean;
}

// ---------------------------------------------------------------------------------------
// The constants §3.6 names
// ---------------------------------------------------------------------------------------

/** §3.6: `repoBytes × agents + 10 %`. A worktree is not a clone, but the index, the build outputs and the
 *  verify commands' artefacts are real, and 10 % of a measured repo is the design's allowance for them. */
export const DISK_HEADROOM = 1.1;

/**
 * §3.6's "`agents × 3` fds **plus the json pipes**": three is the child's stdin/stdout/stderr pipe ends the
 * supervisor holds open for its whole life, and the fourth is the ndjson reader's own handle on the json
 * stream. Four per agent, named here so the fd row of `reasons` and the arithmetic cannot drift apart.
 */
export const FDS_PER_AGENT = 4;

/**
 * §3.6's "within the soft `RLIMIT_NOFILE` **margin**". The parent keeps its own descriptors while the
 * children run — the checkpoint chain, the coordination ledger, `jevcode.log`, the transcript, the tty, the
 * watched files and node's own internals — and a pre-flight that spent the last descriptor would trade a
 * clean "fewer agents" for corner row 23's `failed-start (EMFILE)` at spawn time, which is strictly worse:
 * it costs a worktree and a process. A live run sits near 40; 128 is that rounded up with room to grow, and
 * it is small enough to be invisible against the 256 soft limit of even the meanest default.
 */
export const FD_MARGIN = 128;

/** `reasons` is emitted in this order, always, so two runs of the same input are byte-identical. */
const LIMIT_ORDER: readonly PreflightLimit[] = ['disk', 'memory', 'cpu', 'fds'];

// ---------------------------------------------------------------------------------------
// Formatting — the card reads this, so it is prose, not a dump
// ---------------------------------------------------------------------------------------

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

/**
 * The design's card says `2.0 GB floor` for the 2 GiB default, so the divisor is binary and the label is
 * the design's. One decimal place: the card has one line per limit and no room for a second.
 */
function bytes(n: number): string {
  if (!Number.isFinite(n)) return 'an unknown amount';
  const abs = Math.abs(n);
  if (abs >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (abs >= MB) return `${(n / MB).toFixed(1)} MB`;
  if (abs >= KB) return `${(n / KB).toFixed(1)} kB`;
  return `${String(Math.round(n))} B`;
}

/** `2 fit`, `1 fits`, `0 fit` — the tail of every measured reason. */
function fit(n: number): string {
  return n === 1 ? '1 fits' : `${String(n)} fit`;
}

function unmeasured(limit: PreflightLimit): PreflightReason {
  return { limit, allowed: Number.POSITIVE_INFINITY, text: `${limit} could not be measured; not a limit` };
}

// ---------------------------------------------------------------------------------------
// Guards — nothing below may produce NaN, Infinity or a negative agent count
// ---------------------------------------------------------------------------------------

/** A reading is usable only when it is a finite number. `null`, `NaN` and `±Infinity` are all "unknown". */
function reading(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** A divisor is usable only when it is finite and strictly positive — the `fits()` rule, restated. */
function divisor(n: number | null | undefined): number | null {
  const v = reading(n);
  return v !== null && v > 0 ? v : null;
}

/** An allowance is a whole, non-negative number of agents. */
function allowance(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

// ---------------------------------------------------------------------------------------
// The four rows of §3.6
// ---------------------------------------------------------------------------------------

/** `repoBytes × agents × 1.1 ≤ freeBytes − minFreeBytes` */
function diskRow(free: { freeBytes: number; totalBytes: number } | null, repoBytes: number | null, minFreeBytes: number, want: number): PreflightReason | null {
  const freeBytes = reading(free?.freeBytes);
  const per = divisor(repoBytes === null ? null : repoBytes * DISK_HEADROOM);
  if (freeBytes === null || per === null) return unmeasured('disk');
  // a missing or nonsensical floor is no floor; a negative one would hand out free space that is not there
  const floor = Math.max(0, reading(minFreeBytes) ?? 0);
  const usable = freeBytes - floor;
  const allowed = usable <= 0 ? 0 : allowance(usable / per);
  if (allowed >= want) return null;
  return { limit: 'disk', allowed, text: `disk: ${String(want)} agents need ${bytes(per * want)} above the ${bytes(floor)} floor; ${bytes(freeBytes)} free — ${fit(allowed)}` };
}

/** `agents × agentMemBytes ≤ freeMemBytes` */
function memoryRow(freeMem: number | null, agentMemBytes: number, want: number): PreflightReason | null {
  const free = reading(freeMem);
  const per = divisor(agentMemBytes);
  if (free === null || per === null) return unmeasured('memory');
  const allowed = free <= 0 ? 0 : allowance(free / per);
  if (allowed >= want) return null;
  return { limit: 'memory', allowed, text: `memory: ${String(want)} agents need ${bytes(per * want)} at ${bytes(per)} each; ${bytes(free)} free — ${fit(allowed)}` };
}

/** `agents ≤ availableParallelism() − 1` — the reserved thread is the parent's own loop */
function cpuRow(parallelism: number | null, want: number): PreflightReason | null {
  const threads = reading(parallelism);
  if (threads === null || threads <= 0) return unmeasured('cpu');
  const allowed = allowance(threads - 1);
  if (allowed >= want) return null;
  return { limit: 'cpu', allowed, text: `cpu: ${String(Math.floor(threads))} hardware threads, one reserved for the parent — ${fit(allowed)}` };
}

/** `agents × FDS_PER_AGENT` within `soft RLIMIT_NOFILE − FD_MARGIN` */
function fdRow(soft: number | null, want: number): PreflightReason | null {
  const limit = reading(soft);
  // a non-finite soft limit is RLIM_INFINITY (or an unreadable one): unbounded, so not a limit
  if (limit === null || limit <= 0) return unmeasured('fds');
  const allowed = allowance((limit - FD_MARGIN) / FDS_PER_AGENT);
  if (allowed >= want) return null;
  return {
    limit: 'fds',
    allowed,
    text: `fds: ${String(want)} agents need ${String(want * FDS_PER_AGENT)} descriptors of the ${String(Math.floor(limit))} soft limit less the ${String(FD_MARGIN)} margin — ${fit(allowed)}`,
  };
}

// ---------------------------------------------------------------------------------------
// §3.6
// ---------------------------------------------------------------------------------------

/**
 * How many of `want` agents fit, and what stopped the rest.
 *
 * The four readings are taken concurrently (two of them are async and one of those shells out to `du`),
 * then folded in the fixed `disk → memory → cpu → fds` order so `reasons` is deterministic. A row that
 * allows at least `want` is silent; a row that could not be measured says so and allows `Infinity`.
 */
export async function preflight(probe: PreflightProbe, input: PreflightInput): Promise<PreflightResult> {
  // a `want` that is not a positive whole number is not a request for agents
  const wantRaw = reading(input.want);
  const want = wantRaw === null ? 0 : Math.max(0, Math.floor(wantRaw));
  if (want <= 0) return { agents: 0, reasons: [], reduced: false };

  const [free, repoBytes] = await Promise.all([probe.diskFree(input.repoRoot), probe.repoBytes(input.repoRoot)]);
  const rows: Record<PreflightLimit, PreflightReason | null> = {
    disk: diskRow(free, reading(repoBytes), input.minFreeBytes, want),
    memory: memoryRow(probe.freeMemBytes(), input.agentMemBytes, want),
    cpu: cpuRow(probe.availableParallelism(), want),
    fds: fdRow(probe.openFileLimit(), want),
  };

  const reasons: PreflightReason[] = [];
  let agents = want;
  for (const limit of LIMIT_ORDER) {
    const row = rows[limit];
    if (row === null) continue;
    reasons.push(row);
    if (row.allowed < agents) agents = row.allowed;
  }
  // `want` is finite and every `allowed` is either a whole non-negative number or Infinity, so this is
  // belt and braces: nothing below zero and nothing fractional can reach the caller.
  agents = Math.max(0, Math.min(want, Math.floor(agents)));
  return { agents, reasons, reduced: agents < want };
}

// ---------------------------------------------------------------------------------------
// The one impure export
// ---------------------------------------------------------------------------------------

/** One step down an unknown object, without `any`: `process.report.getReport()` is typed `object`. */
function prop(o: unknown, key: string): unknown {
  return typeof o === 'object' && o !== null && key in o ? (o as Record<string, unknown>)[key] : undefined;
}

/** `du -sk` is measured with this ceiling; a repo that takes longer is "unmeasured", not "enormous". */
const DU_TIMEOUT_MS = 10_000;
/** `du -sk` reports kibibytes. */
const KIB = 1024;

/** The `du -sk` of one or more roots, in bytes; `null` when `du` is unavailable, slow or unparseable. */
async function duBytes(paths: readonly string[]): Promise<number | null> {
  if (paths.length === 0) return null;
  const { execFile } = await import('node:child_process');
  return new Promise<number | null>((resolve) => {
    execFile('du', ['-sk', ...paths], { timeout: DU_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err !== null && typeof stdout !== 'string') return resolve(null);
      let total = 0;
      let seen = false;
      for (const line of String(stdout).split('\n')) {
        const kib = Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10);
        if (Number.isFinite(kib) && kib >= 0) {
          total += kib * KIB;
          seen = true;
        }
      }
      // `du` exits non-zero on an unreadable subdirectory but still prints the totals it did reach
      resolve(seen ? total : null);
    });
  });
}

/**
 * The real probe. The ONLY impure export here, and the only place this file touches the machine.
 *
 * `runGit`, when given, is used for one thing: resolving the repository's git COMMON dir, so a linked
 * worktree's `du` covers `<main>/.git` and not just the checkout — the pre-flight's own worktrees are
 * sized against exactly what `createWorktree` will have to materialise. Without it the measurement falls
 * back to `<repoRoot>` plus `<repoRoot>/.git`, which is right for a main tree and conservative elsewhere.
 * The caller caches the result per `repoKey` (§3.6); nothing is cached here.
 */
export function nodePreflightProbe(runGit?: RunGit): PreflightProbe {
  return {
    diskFree: async (path: string): Promise<{ freeBytes: number; totalBytes: number } | null> => {
      try {
        const { statfs } = await import('node:fs/promises');
        const s = await statfs(path);
        const block = Number(s.bsize);
        const free = Number(s.bavail) * block;
        const total = Number(s.blocks) * block;
        return Number.isFinite(free) && Number.isFinite(total) ? { freeBytes: free, totalBytes: total } : null;
      } catch {
        return null;
      }
    },

    freeMemBytes: (): number | null => {
      try {
        const n = freemem();
        return Number.isFinite(n) && n > 0 ? n : null;
      } catch {
        return null;
      }
    },

    availableParallelism: (): number | null => {
      try {
        const n = availableParallelism();
        return Number.isFinite(n) && n > 0 ? n : null;
      } catch {
        return null;
      }
    },

    repoBytes: async (path: string): Promise<number | null> => {
      const roots: string[] = [path];
      let commonDir: string | null = null;
      if (runGit !== undefined) {
        try {
          const r = await runGit(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: DU_TIMEOUT_MS });
          const out = r.stdout.trim().split('\n')[0]?.trim() ?? '';
          if (r.ok && out.length > 0 && isAbsolute(out)) commonDir = out;
        } catch {
          commonDir = null;
        }
      }
      const gitDir = commonDir ?? join(path, '.git');
      // `du -sk a b` double-counts when b is inside a, so a git dir under the checkout is already covered
      if (!gitDir.startsWith(path.endsWith(sep) ? path : path + sep)) roots.push(gitDir);
      return duBytes(roots);
    },

    openFileLimit: (): number | null => {
      try {
        // node has no getrlimit binding; the diagnostic report carries the same numbers and is synchronous
        const soft = prop(prop(prop(process.report.getReport(), 'userLimits'), 'open_files'), 'soft');
        // `"unlimited"` is RLIM_INFINITY: unbounded, which is not a limit
        return typeof soft === 'number' && Number.isFinite(soft) && soft > 0 ? soft : null;
      } catch {
        return null;
      }
    },
  };
}
