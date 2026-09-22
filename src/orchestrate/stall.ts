/**
 * The watchdog (docs/ORCHESTRATION-DESIGN.md §7.1, corner row 46): three acted-on signals over a bounded
 * heartbeat history, plus the one condition that is deliberately NOT a stall.
 *
 * Pure over an injected `now`: no clock, no I/O, no `Date.now()`. `stall.test.ts` drives it with a fake one.
 *
 * The non-obvious invariant, and the thing most likely to be got wrong: **a quiet pipe is not a stall, and it
 * does not suppress one either.** §7.1's last row says a pipe silent for `2 × HEARTBEAT_MS` while the
 * heartbeat is live is never acted on — so it produces `signal: null, action: 'none'`. But a genuinely stuck
 * agent is almost always quiet too, so `quiet` is reported as an independent FLAG alongside whatever signal
 * did fire. Treating quiet as a short-circuit would make the whole watchdog inert on exactly the agents it
 * exists for.
 *
 * Every signal is a fact and one toast; nothing here kills anything.
 */
import type { SplitPolicy } from './types.js';

/** One heartbeat reading. The supervisor appends one per `HEARTBEAT_MS`; the caller bounds the history. */
export interface HeartbeatSample {
  at: number;
  step: number;
  phase: 'running' | 'idle' | 'ended';
  /** files this agent has changed against its base, as the heartbeat reported it */
  changedFiles: number;
  /** the collected test count, or null when no run has been parsed */
  testCount: number | null;
  /** the paths its last step touched */
  touchedPaths: readonly string[];
  /** cumulative net line delta against the base: `added - removed` */
  netLines: number;
  /** when the last json line arrived on its pipe */
  lastJsonLineAt: number;
}

export type StallSignal = 'no_step_progress' | 'no_file_progress' | 'churn';

export interface StallVerdict {
  signal: StallSignal | null;
  message: string;
  action: 'notify' | 'pause' | 'kick' | 'none';
  /** §7.1's last row: the pipe has been silent for 2 × heartbeat while the heartbeat itself is live */
  quiet: boolean;
}

/** §7.1's `no progress 11 m`: whole minutes, never rounded up, never a fraction. */
function minutes(ms: number): string {
  return `${Math.max(0, Math.floor(ms / 60_000))} m`;
}

const NONE: StallVerdict = { signal: null, message: '', action: 'none', quiet: false };

/** §7.1: "the heartbeat has shown the same `step` for `agentStallMs` while `phase === 'running'`". */
function noStepProgress(history: readonly HeartbeatSample[], now: number, stallMs: number): string | null {
  const last = history[history.length - 1];
  if (last === undefined || last.phase !== 'running') return null;
  let since = last.at;
  for (let i = history.length - 1; i >= 0; i--) {
    const s = history[i];
    if (s === undefined || s.step !== last.step) break;
    since = s.at;
  }
  const age = now - since;
  return age >= stallMs ? `no progress ${minutes(age)}` : null;
}

/**
 * §7.1: "the last 3 committed steps produced no `changedFiles` and no test-count change".
 *
 * `changedFiles` is CUMULATIVE against the base (see `HeartbeatSample`), so what this row asks for is the
 * DIFFERENCE over the window — the same compare `churn` makes on `netLines` — and not the raw count.
 * Reading the raw count as a per-step delta made the signal fire only for an agent whose total changed
 * file count is zero, i.e. never for the one it exists to catch: an agent that changed files early and
 * then stopped.
 */
function noFileProgress(history: readonly HeartbeatSample[]): string | null {
  const last = history[history.length - 1];
  if (last === undefined || last.phase !== 'running' || history.length < 3) return null;
  // The window is the last 3 samples, measured against the sample before them when there is one: a file
  // (or a test) that appeared on entering the window is progress the agent made. The same four samples
  // answer both halves of the row.
  const window = history.slice(-4);
  const base = window[0];
  if (base === undefined || last.changedFiles !== base.changedFiles) return null;
  const counts = window.map((s) => s.testCount);
  const first = counts[0];
  if (counts.some((c) => c !== first)) return null;
  return 'no files changed in 3 steps';
}

/** §7.1: "the last 3 steps touched the same file with a net diff of 0 lines against 3 steps ago". */
function churn(history: readonly HeartbeatSample[]): string | null {
  const last = history[history.length - 1];
  const before = history[history.length - 4];
  if (last === undefined || before === undefined || last.phase !== 'running') return null;
  if (last.netLines !== before.netLines) return null;
  const window = history.slice(-3);
  let common: string[] = [...(window[0]?.touchedPaths ?? [])];
  for (const s of window.slice(1)) common = common.filter((p) => s.touchedPaths.includes(p));
  const file = common[0];
  if (file === undefined) return null;
  return `no net change to ${file} in 3 steps`;
}

/**
 * §7.1, in precedence order: `no_step_progress` → `no_file_progress` → `churn`, which is the table's own
 * order. The three are disjoint in practice (a churning agent's step advances and its `changedFiles` is not
 * zero); the order only decides a pathological overlap, and putting the time-bounded freeze first means a
 * frozen agent is reported as frozen and honours `onStall` rather than being kicked as if it were working.
 */
export function detectStall(
  history: readonly HeartbeatSample[],
  now: number,
  policy: Pick<SplitPolicy, 'agentStallMs' | 'onStall'>,
  heartbeatMs: number,
): StallVerdict {
  const last = history[history.length - 1];
  if (last === undefined) return NONE;

  // §7.1's last row / corner row 46: quiet pipe, live heartbeat. A FLAG, never an action.
  const live = last.phase !== 'ended' && now - last.at < 2 * heartbeatMs;
  const silence = now - last.lastJsonLineAt;
  const quiet = live && silence >= 2 * heartbeatMs;

  const step = noStepProgress(history, now, policy.agentStallMs);
  if (step !== null) return { signal: 'no_step_progress', message: step, action: policy.onStall, quiet };
  const files = noFileProgress(history);
  if (files !== null) return { signal: 'no_file_progress', message: files, action: policy.onStall, quiet };
  const spin = churn(history);
  // §7.1's churn row says `kick`, whatever `onStall` says: one more try is the only useful answer to an agent
  // that is rewriting the same file to the same content.
  if (spin !== null) return { signal: 'churn', message: spin, action: 'kick', quiet };

  return quiet ? { signal: null, message: `quiet: no output for ${minutes(silence)}, heartbeat is live`, action: 'none', quiet: true } : NONE;
}
