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
 * And a WATCHDOG over all of it, because the failure that mattered in the field was not a wrong
 * verdict but no verdict at all: an eight-lane batch whose workers never attached left the
 * harness at 0 % CPU with no child processes for an hour, and the sieve reported "0 tested on 8
 * lanes (nothing ran)" while the step's whole test wall drained into boot deadlines. So every
 * `serve()` races its own budget (`watchdogMs`), a call that outlives it abandons the attempt
 * and disables the plane, and a worker that times out — no ready line, no fifo peer, no reply —
 * disables it on the FIRST occurrence rather than after a restart budget: a hang is a property
 * of the mechanism, and the wall it costs comes out of the step, not out of the plane.
 *
 * Every transition is counted in `stats()` so the sieve's `synth` line, and through it the trace,
 * records how much of a step was screened, how often the plane fell back and why.
 */
import { join } from 'node:path';

import type { Sandbox } from '../../core/types.js';
import type { Lane, OracleModel } from '../search/types.js';
import { interpreterFor, requestFor, type WarmMode, type WarmRunRequest, type WarmRunResult } from './protocol.js';
import { WARM_BOOT_TIMEOUT_MS, WARM_RESPONSE_SLACK_MS, WarmError, WarmWorker, writeWarmServer } from './worker.js';

/** Restarts allowed per lane before the plane gives up on the mechanism for the run. */
export const WARM_MAX_RESTARTS_PER_LANE = 2;
/**
 * Worker failures allowed across ALL lanes before the plane gives up for the run. The per-lane
 * budget alone is not a budget: eight lanes could each pay three boots, and a boot that ends at
 * its deadline costs the STEP's test wall, not the plane's. The run that made this necessary
 * spent its whole 600 s test wall on 10 restarts and tested nothing.
 */
export const WARM_MAX_FAILURES_PER_RUN = 4;
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
  /**
   * How long a worker has to boot, and with it the plane's watchdog budget. Default
   * `WARM_BOOT_TIMEOUT_MS`; the tests that drive the watchdog with a worker that sleeps for
   * ever pass a small one so the case costs a second rather than a minute.
   */
  bootTimeoutMs?: number;
}

/**
 * Is the warm plane on for this oracle? Default on for the two Python lane shapes, off for every
 * other runner; `JEVCODE_WARM=off` forces today's behaviour and `=on` is only an override for a
 * shape that is already supported (it never invents one).
 */
export function warmModeFor(oracle: Pick<OracleModel, 'runner'>, env: Readonly<Record<string, string | undefined>> = process.env): WarmMode | null {
  const flag = (env[WARM_ENV_FLAG] ?? '').trim().toLowerCase();
  if (flag === 'off' || flag === '0' || flag === 'false') return null;
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
  private serverPath: Promise<string> | null = null;
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
    return this.watched(lane.index, this.attempt(lane, req, deadlineMs, env), this.watchdogMs(deadlineMs));
  }

  /**
   * The wall after which a warm call is a WEDGE, not a slow candidate: a boot and a request are
   * each bounded by their own timer, so anything still outstanding here is a syscall that never
   * returned or a reply that never came. Worth having twice over, because the first version of
   * this plane hung the whole harness on a blocking `open(2)` that no timer could interrupt.
   */
  private watchdogMs(deadlineMs: number): number {
    return (this.opts.bootTimeoutMs ?? WARM_BOOT_TIMEOUT_MS) * 2 + Math.max(0, deadlineMs) + WARM_RESPONSE_SLACK_MS;
  }

  /**
   * The plane's watchdog. A warm attempt that outlives `ms` is abandoned — the caller gets null
   * and runs the command cold — the lane's worker is dropped, and the plane is DISABLED for the
   * run with a `disabledReason` the sieve prints. Nothing re-enables it, so a mechanism that
   * wedged once costs a run one deadline and never a second.
   */
  private watched(index: number, work: Promise<WarmRunResult | null>, ms: number): Promise<WarmRunResult | null> {
    return new Promise<WarmRunResult | null>((resolve) => {
      let settled = false;
      const finish = (r: WarmRunResult | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        this.counts.fallbacks += 1;
        this.counts.restarts += 1;
        this.forget(index);
        this.disable(`a warm call on lane ${index} did not come back within ${ms} ms`);
        finish(null);
      }, ms);
      // the abandoned attempt must not surface as an unhandled rejection
      void work.then(finish, () => finish(null));
    });
  }

  /** One warm attempt: boot the lane's worker if needed and run. Never throws — a failure is a cold run. */
  private async attempt(lane: Lane, req: WarmRunRequest, deadlineMs: number, env: Readonly<Record<string, string>>): Promise<WarmRunResult | null> {
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
      this.forget(lane.index);
      this.note(lane.index, e instanceof Error ? e.message : String(e), e instanceof WarmError && e.timedOut);
      return null;
    }
  }

  /** Drop a lane's worker and stop its interpreter. */
  private forget(index: number): void {
    const w = this.workers.get(index);
    if (w === undefined) return;
    this.workers.delete(index);
    w.dispose();
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
      // the PROMISE is memoised, not its value: eight lanes boot at once, and eight concurrent
      // `writeFile` calls truncate the file a ninth interpreter may be reading right then
      this.serverPath ??= writeWarmServer(root);
      const serverPath = await this.serverPath;
      const qbDir = this.qbDir ?? o.quixbugsDir ?? null;
      const worker = await WarmWorker.start({
        sandbox: o.sandbox,
        signal: o.signal,
        dir: join(root, `lane${lane.index}`),
        serverPath,
        cwd: lane.dir,
        mode: o.mode,
        ...(o.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: o.bootTimeoutMs }),
        interpreter: o.interpreter,
        roots: [o.workspaceRoot, lane.dir],
        ...(o.bootEnv === undefined ? {} : { env: o.bootEnv }),
        ...(qbDir === null ? {} : { quixbugsDir: qbDir }),
      });
      // the watchdog (or a mismatch) may have disabled the plane while this was booting
      if (this.off !== null) {
        worker.dispose();
        return null;
      }
      this.workers.set(lane.index, worker);
      return worker;
    } catch (e: unknown) {
      this.counts.fallbacks += 1;
      this.note(lane.index, `could not start a warm worker: ${e instanceof Error ? e.message : String(e)}`, e instanceof WarmError && e.timedOut);
      return null;
    }
  }

  /**
   * Record one worker failure and decide whether the mechanism is finished.
   *
   * A TIMEOUT ends it immediately, whatever the budgets say: a worker that never announced
   * itself or never answered is a broken mechanism, not a difficult candidate, and the wall a
   * deadline costs comes out of the STEP's test budget — the run this rule was written for
   * spent 600 s of test wall on repeated boot deadlines and classified nothing. A crash is
   * different: it is plausibly this candidate's doing, so it keeps a per-lane restart budget,
   * a run-wide failure budget, and the older rule that a plane which has never once served a
   * command is an environment without a usable interpreter (no python3, a seatbelt denial, a
   * sandbox stub in a test).
   */
  private note(index: number, why: string, timedOut: boolean): void {
    const n = (this.restarts.get(index) ?? 0) + 1;
    this.restarts.set(index, n);
    this.counts.restarts += 1;
    if (timedOut) this.disable(`lane ${index} stopped answering: ${why}`);
    else if (n > WARM_MAX_RESTARTS_PER_LANE) this.disable(`lane ${index} failed ${n} times, the last: ${why}`);
    else if (this.counts.restarts > WARM_MAX_FAILURES_PER_RUN) this.disable(`the warm plane failed ${this.counts.restarts} times across its lanes, the last: ${why}`);
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
