/**
 * The warm verification plane (docs/HARNESS-NEXT-DESIGN.md §3 M6, wave S1): one warm interpreter
 * per lane, a hard "screen hot, confirm cold" rule enforced by the caller, and a fallback to the
 * cold path on *any* anomaly.
 *
 * The plane is deliberately a screen, never an authority:
 *   * `serve()` returns null whenever the command is not exactly a shape the warm server
 *     reproduces, the plane is disabled, the lane has no worker, or the worker misbehaved — the
 *     caller then runs the command cold, byte for byte as it does today;
 *   * a warm result is a `VerifyRunResult`, so `summarize()` turns it into a `TestRunSummary`
 *     through the same parsers as a cold one: the warm path adds no parsing of its own;
 *   * `mismatch()` — one screen/confirm disagreement — disables the plane for the whole run;
 *   * `disable()` is one-way. Nothing re-enables the plane inside a run.
 *
 * Every transition is counted in `stats()` so the sieve's `synth` line, and through it the trace,
 * records how much of a step was screened, how often the plane fell back and why.
 */
import { join } from 'node:path';

import type { Sandbox } from '../../core/types.js';
import type { Lane, OracleModel } from '../search/types.js';
import { interpreterFor, requestFor, type WarmMode, type WarmRunResult } from './protocol.js';
import { WarmError, WarmWorker, writeWarmServer } from './worker.js';

/** Restarts allowed per lane before the plane gives up on the mechanism for the run. */
export const WARM_MAX_RESTARTS_PER_LANE = 2;
/** Subdirectory of the run's lane area that holds the server source and the per-lane FIFOs. */
export const WARM_SUBDIR = 'tmp/synth/warm';
/** `JEVCODE_WARM=off` restores today's cold path exactly; `on` forces it where it is not the default. */
export const WARM_ENV_FLAG = 'JEVCODE_WARM';

export interface WarmStats {
  /** commands the plane was offered */
  offered: number;
  /** commands actually served by a warm worker */
  screened: number;
  /** cold confirmation runs the caller made for warm passers */
  confirmed: number;
  /** screen/confirm disagreements; must be 0 (§5) */
  mismatches: number;
  /** offers that fell back to the cold path after a warm attempt failed */
  fallbacks: number;
  /** worker restarts */
  restarts: number;
  /** restarts caused by the warm parent's import set going stale */
  invalidations: number;
  /** scoped runs that reported zero collected tests and were re-run at full scope */
  scopeUnusable: number;
  /** warm runs that hit a deadline and were therefore re-run cold instead of being classified */
  deadlineRechecks: number;
  /** wall spent inside warm runs (ms, as the worker measured it) */
  screenMs: number;
  /** wall spent in cold confirmations (ms) */
  confirmMs: number;
  disabledReason: string | null;
}

/**
 * What the sieve runner needs from the warm plane. An interface, not the class, so a test can
 * drive the screen/confirm rule with a scripted screen (test/unit/synth/sieve/screen-confirm.test.ts)
 * without an interpreter — the rule is the part that must never be wrong.
 */
export interface WarmScreen {
  readonly disabled: boolean;
  serve(lane: Lane, command: string, deadlineMs: number, env?: Readonly<Record<string, string>>): Promise<WarmRunResult | null>;
  /** one cold confirmation of a hot-screened passer completed, taking `ms` */
  confirmed(ms: number): void;
  /** a hot-screened passer the cold confirmation refused */
  mismatch(): void;
  /** a scoped run reported zero collected tests and was widened */
  scopeUnusable(): void;
  /** a warm run hit a deadline, so the caller discarded it and ran the command cold */
  deadlineRecheck(): void;
  stats(): WarmStats;
  dispose(): void;
}

export interface WarmPlaneOptions {
  sandbox: Pick<Sandbox, 'run'>;
  signal: AbortSignal;
  runDir: string;
  workspaceRoot: string;
  mode: WarmMode;
  /** the interpreter word of the cold command, verbatim (`interpreterFor`) */
  interpreter: string;
  /** directory holding run_tests.py (quixbugs mode) */
  quixbugsDir?: string;
  /** the environment a cold lane run gets (`laneRunEnv`), so the worker boots in the same one */
  bootEnv?: Readonly<Record<string, string>>;
}

/**
 * Is the warm plane on for this oracle? **Default OFF since 2026-09-22**: the first live measurement of the merged tree
 * (experiments/results/llm-jev-iter1.md §1) found that with the plane on an llm-jev run never completes a synthesis step —
 * the SIEVE batch reaches the lanes, `0 tested on 8 lanes (nothing ran)`, and the wall cap takes step 1, with runs wedged
 * at 0 % CPU; the unit suite passed because its parity tests use fakes. `JEVCODE_WARM=on` enables it for the two Python
 * lane shapes (quixbugs, pytest) and is the switch the fix is measured behind; it never invents a shape. The default goes
 * back to on only when a real-lane integration test and Ring 1 pass with the plane on.
 */
export function warmModeFor(oracle: Pick<OracleModel, 'runner'>, env: Readonly<Record<string, string | undefined>> = process.env): WarmMode | null {
  const flag = (env[WARM_ENV_FLAG] ?? '').trim().toLowerCase();
  if (flag !== 'on' && flag !== '1' && flag !== 'true') return null;
  if (oracle.runner === 'quixbugs') return 'quixbugs';
  if (oracle.runner === 'pytest') return 'pytest';
  return null;
}

export function emptyWarmStats(): WarmStats {
  return { offered: 0, screened: 0, confirmed: 0, mismatches: 0, fallbacks: 0, restarts: 0, invalidations: 0, scopeUnusable: 0, deadlineRechecks: 0, screenMs: 0, confirmMs: 0, disabledReason: null };
}

/** What happened between two snapshots: the counters are cumulative over a run, the sieve reports per batch. */
export function warmDelta(before: WarmStats, after: WarmStats): WarmStats {
  return {
    offered: after.offered - before.offered,
    screened: after.screened - before.screened,
    confirmed: after.confirmed - before.confirmed,
    mismatches: after.mismatches - before.mismatches,
    fallbacks: after.fallbacks - before.fallbacks,
    restarts: after.restarts - before.restarts,
    invalidations: after.invalidations - before.invalidations,
    scopeUnusable: after.scopeUnusable - before.scopeUnusable,
    deadlineRechecks: after.deadlineRechecks - before.deadlineRechecks,
    screenMs: after.screenMs - before.screenMs,
    confirmMs: after.confirmMs - before.confirmMs,
    disabledReason: before.disabledReason === null ? after.disabledReason : null,
  };
}

export class WarmPlane implements WarmScreen {
  private readonly opts: WarmPlaneOptions;
  private readonly workers = new Map<number, WarmWorker>();
  private readonly restarts = new Map<number, number>();
  private readonly booting = new Map<number, Promise<WarmWorker | null>>();
  private serverPath: string | null = null;
  private qbDir: string | null = null;
  private off: string | null = null;
  private readonly counts: WarmStats = emptyWarmStats();

  constructor(opts: WarmPlaneOptions) {
    this.opts = opts;
  }

  get disabled(): boolean {
    return this.off !== null;
  }

  stats(): WarmStats {
    return { ...this.counts, disabledReason: this.off };
  }

  /** One-way. Called for a crash budget overrun, an unusable transport, or a screen/confirm disagreement. */
  disable(reason: string): void {
    if (this.off !== null) return;
    this.off = reason;
    this.counts.disabledReason = reason;
    for (const w of this.workers.values()) w.dispose();
    this.workers.clear();
  }

  /** A hot-screened passer the cold confirmation refused: the mechanism is off for the run (§3 M6). */
  mismatch(): void {
    this.counts.mismatches += 1;
    this.disable('screen/confirm mismatch');
  }

  confirmed(ms: number): void {
    this.counts.confirmed += 1;
    this.counts.confirmMs += ms;
  }

  scopeUnusable(): void {
    this.counts.scopeUnusable += 1;
  }

  deadlineRecheck(): void {
    this.counts.deadlineRechecks += 1;
  }

  /**
   * Serve one lane command warm, or return null so the caller runs it cold. Never throws: a
   * thrown warm error is a fallback, and a fallback is only ever slower, never wrong.
   */
  async serve(lane: Lane, command: string, deadlineMs: number, env: Readonly<Record<string, string>> = {}): Promise<WarmRunResult | null> {
    if (this.off !== null || this.opts.signal.aborted) return null;
    const req = requestFor(this.opts.mode, command);
    if (req === null) return null;
    // The plane booted ONE interpreter. A command naming another one (a venv python where the
    // baseline was the system one, or the reverse) has different site-packages, so answering it
    // here would screen the candidate under the wrong environment — and a non-passing screen is
    // never cold-confirmed. Refusing costs one cold run.
    if (interpreterFor(this.opts.mode, command) !== this.opts.interpreter) return null;
    if (req.kind === 'quixbugs') {
      // the warm parent imported ONE run_tests.py; a run pointed at a different bench directory
      // would be answered by the wrong module, so it stays cold
      this.qbDir ??= req.dir;
      if (this.qbDir !== req.dir) return null;
    }
    this.counts.offered += 1;
    const worker = await this.workerFor(lane);
    if (worker === null) return null;
    try {
      const res = await worker.run(req, deadlineMs, env);
      this.counts.screened += 1;
      this.counts.screenMs += res.durationMs;
      return res;
    } catch (e: unknown) {
      this.counts.fallbacks += 1;
      if (e instanceof WarmError && e.invalidated) this.counts.invalidations += 1;
      this.workers.delete(lane.index);
      worker.dispose();
      this.note(lane.index, e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  private async workerFor(lane: Lane): Promise<WarmWorker | null> {
    const have = this.workers.get(lane.index);
    if (have !== undefined && have.alive) return have;
    if (have !== undefined) {
      this.workers.delete(lane.index);
      have.dispose();
    }
    const inFlight = this.booting.get(lane.index);
    if (inFlight !== undefined) return inFlight;
    const boot = this.boot(lane).finally(() => this.booting.delete(lane.index));
    this.booting.set(lane.index, boot);
    return boot;
  }

  private async boot(lane: Lane): Promise<WarmWorker | null> {
    const o = this.opts;
    try {
      const root = join(o.runDir, WARM_SUBDIR);
      this.serverPath ??= await writeWarmServer(root);
      const qbDir = this.qbDir ?? o.quixbugsDir ?? null;
      const worker = await WarmWorker.start({
        sandbox: o.sandbox,
        signal: o.signal,
        dir: join(root, `lane${lane.index}`),
        serverPath: this.serverPath,
        cwd: lane.dir,
        mode: o.mode,
        interpreter: o.interpreter,
        roots: [o.workspaceRoot, lane.dir],
        ...(o.bootEnv === undefined ? {} : { env: o.bootEnv }),
        ...(qbDir === null ? {} : { quixbugsDir: qbDir }),
      });
      this.workers.set(lane.index, worker);
      return worker;
    } catch (e: unknown) {
      this.counts.fallbacks += 1;
      this.note(lane.index, `could not start a warm worker: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * Record one worker failure and decide whether the mechanism is finished. Per lane it is a
   * restart budget; across lanes, a plane that has never once served a command is an environment
   * without a usable interpreter (no python3, a seatbelt denial, a sandbox stub in a test) and
   * retrying it on every lane only burns wall.
   */
  private note(index: number, why: string): void {
    const n = (this.restarts.get(index) ?? 0) + 1;
    this.restarts.set(index, n);
    this.counts.restarts += 1;
    if (n > WARM_MAX_RESTARTS_PER_LANE) this.disable(`lane ${index} failed ${n} times, the last: ${why}`);
    else if (this.counts.screened === 0 && this.counts.restarts > WARM_MAX_RESTARTS_PER_LANE) this.disable(`no warm worker ever served a command: ${why}`);
  }

  dispose(): void {
    for (const w of this.workers.values()) w.dispose();
    this.workers.clear();
  }
}

/** The one-line summary the sieve appends to its `synth` verify event. */
export function warmNote(s: WarmStats): string {
  if (s.offered === 0 && s.scopeUnusable === 0) return '';
  const bits = [`warm ${s.screened}/${s.offered}`];
  if (s.screenMs > 0) bits.push(`screen ${Math.round(s.screenMs)} ms`);
  if (s.confirmed > 0) bits.push(`${s.confirmed} cold confirm${s.confirmed === 1 ? '' : 's'} ${Math.round(s.confirmMs)} ms`);
  if (s.fallbacks > 0) bits.push(`${s.fallbacks} fallback${s.fallbacks === 1 ? '' : 's'}`);
  if (s.restarts > 0) bits.push(`${s.restarts} restart${s.restarts === 1 ? '' : 's'}`);
  if (s.invalidations > 0) bits.push(`${s.invalidations} invalidation${s.invalidations === 1 ? '' : 's'}`);
  if (s.deadlineRechecks > 0) bits.push(`${s.deadlineRechecks} deadline recheck${s.deadlineRechecks === 1 ? '' : 's'} cold`);
  if (s.mismatches > 0) bits.push(`${s.mismatches} screen:mismatch`);
  if (s.scopeUnusable > 0) bits.push(`${s.scopeUnusable} scope_unusable`);
  if (s.disabledReason !== null) bits.push(`warm off: ${s.disabledReason}`);
  return `; ${bits.join(', ')}`;
}
