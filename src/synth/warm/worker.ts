/**
 * One warm lane worker (docs/HARNESS-NEXT-DESIGN.md §3 M6, wave S1): a persistent Python
 * interpreter, started *through the harness's own sandbox*, that has paid interpreter start and
 * `import pytest` once and then forks per candidate.
 *
 * Why it is started through `ctx.sandbox.run` and not with a second `spawn`: the worker then
 * inherits the seatbelt profile, the environment scrub, the output redaction, the three-pass
 * tree kill and `killAll()` at run end for free, and no part of `src/sandbox/run.ts` has to grow
 * a long-lived-stdin mode. The cost is that stdin is not available, so the request channel is a
 * FIFO pair the *worker* creates (`os.mkfifo`, stdlib) inside `<runDir>/tmp/synth/warm/lane<k>/`
 * — one of the seatbelt's writable roots — and announces with a `JEVCODE_WARM_READY` line on
 * stdout, which `SandboxRunOptions.onOutput` streams back here.
 *
 * Liveness, in four independent layers, because a leaked interpreter is the worst failure mode:
 *   1. closing the request FIFO gives the worker EOF and it exits (this is what happens when the
 *      harness process dies, since the fd goes with it);
 *   2. the worker exits after `--idle-ms` without a request and after `--max-ms` of life;
 *   3. the `sandbox.run` call that started it carries its own `timeoutMs`;
 *   4. `sandbox.killAll()` at run end kills it with everything else.
 *
 * Every anomaly — a boot that never announces, a response that does not parse, a response for
 * the wrong id, a request that outlives its deadline, an exit — makes the worker `dead`. The
 * caller (src/synth/warm/plane.ts) then runs the candidate cold; nothing here can turn an
 * anomaly into a verdict.
 *
 * THE TRANSPORT NEVER BLOCKS AND NEVER TOUCHES LIBUV. Both facts were paid for:
 *
 *   * `fs.createWriteStream` / `fs.createReadStream` over a FIFO look like ordinary file streams
 *     and are not. `open(2)` on the write end blocks until a reader appears and every `read(2)`
 *     on the read end blocks until a line arrives — each inside a `uv__fs_work` thread, and the
 *     pool holds FOUR of them. An eight-lane batch parked all four (one per idle lane's pending
 *     read, the rest on opens whose worker had already given up at `--connect-ms`) and every
 *     `fs` call in the whole harness — the candidate writes, the checkpoint, the next lane's
 *     boot — queued behind them for ever: a harness at 0 % CPU with no child processes.
 *   * `net.Socket({ fd })`, the usual answer, is WRONG HERE on macOS: kqueue's read filter on a
 *     FIFO delivers only what was already in the pipe when the watcher was armed. Measured
 *     while fixing this: a 200 KB reply written one second after the socket attached delivered
 *     0 bytes — for every combination of `O_RDONLY`/`O_RDWR`, blocking/non-blocking and
 *     plain/`{readable, writable}` — while `select(2)` on the very same fd from Python
 *     reported it readable at once. A truncating candidate's reply is exactly that shape, so
 *     this would have been a silent hang in the field rather than a failure in a test.
 *
 * So the two fifo ends are raw `O_NONBLOCK` fds driven by `readSync`/`writeSync` off a timer
 * that runs ONLY while a request is in flight. Non-blocking is what makes the sync calls safe
 * (they return `EAGAIN` instead of waiting), the timer is what makes readiness our own business
 * rather than kqueue's, and an idle lane costs neither a thread nor a wakeup.
 */
import { closeSync, constants as fsConstants, open as fsOpen, readSync, writeSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';

import type { Sandbox } from '../../core/types.js';
import { TAIL_BYTES } from '../../sandbox/run.js';
import { shellQuote } from '../verify/text.js';
import { parseResponse, WARM_OUTPUT_BYTES, type WarmMode, type WarmRunRequest, type WarmRunResult } from './protocol.js';
import { WARM_READY_PREFIX, WARM_REQ_FIFO, WARM_RESP_FIFO, WARM_SERVER_PY } from './server-source.js';

/** How long the interpreter has to import its runner and announce itself. */
export const WARM_BOOT_TIMEOUT_MS = 20_000;
/** Slack over a request's own deadline before the transport is declared wedged. */
export const WARM_RESPONSE_SLACK_MS = 5_000;
/** The worker exits by itself after this long without a request (a step boundary is far shorter). */
export const WARM_IDLE_MS = 300_000;
/** Hard lifetime, also the `sandbox.run` timeout that started it. */
export const WARM_MAX_LIFETIME_MS = 1_800_000;
/** Bounded: only the ready line and the worker's own diagnostics travel on stdout/stderr. */
export const WARM_WORKER_OUTPUT_BYTES = 64 * 1024;
/** Written once per run; every lane's worker reads the same file. */
export const WARM_SERVER_FILENAME = 'warm_server.py';
/** How often the request FIFO is re-tried while the worker has not yet opened its read end. */
export const WARM_FIFO_POLL_MS = 5;
/**
 * How often an in-flight request's fifo is read, in three bands: a warm screen is meant to cost
 * tens of milliseconds, so the first band is tight, and a candidate that runs for a second is
 * polled lazily. Nothing is polled at all when no request is in flight.
 */
export const WARM_POLL_BANDS: readonly { untilMs: number; everyMs: number }[] = [
  { untilMs: 200, everyMs: 1 },
  { untilMs: 2_000, everyMs: 5 },
  { untilMs: Number.POSITIVE_INFINITY, everyMs: 20 },
];
/** One `read(2)` off the response fifo. */
const READ_CHUNK = 64 * 1024;

export class WarmError extends Error {
  /** true when the warm parent's import set went stale: restart, and run this candidate cold */
  readonly invalidated: boolean;
  /**
   * true when nothing came back in time (no ready line, no reader on the fifo, no response).
   * The plane treats a timeout as a failure of the MECHANISM rather than of one candidate: a
   * hang is never local, and paying for a second one is how a run loses its wall (see
   * `WarmPlane.note`).
   */
  readonly timedOut: boolean;
  constructor(message: string, opts: { invalidated?: boolean; timedOut?: boolean; cause?: unknown } = {}) {
    super(`WarmError: ${message}`, opts.cause === undefined ? {} : { cause: opts.cause });
    this.name = 'WarmError';
    this.invalidated = opts.invalidated === true;
    this.timedOut = opts.timedOut === true;
  }
}

/** `fs.open`, promisified to the RAW fd; `WarmWorker.close` owns it from there. */
function openFd(path: string, flags: number): Promise<number> {
  return new Promise<number>((res, rej) => {
    fsOpen(path, flags, (e: NodeJS.ErrnoException | null, fd: number) => (e === null ? res(fd) : rej(e)));
  });
}

/**
 * Open one end of a FIFO without ever parking a libuv thread (see the module header).
 *
 * `O_NONBLOCK` changes what a FIFO open MEANS: the read end opens immediately whether or not a
 * writer exists, and the write end fails with ENXIO instead of blocking until a reader appears.
 * So the write end is polled until the worker has opened its read end, bounded by `deadlineAt`
 * — a worker that died before opening (the `--connect-ms` give-up) ends as a timeout here
 * rather than as a thread blocked in `open(2)` for the life of the process.
 *
 * The response end is opened `O_RDWR`, not `O_RDONLY`: a read-only end of a FIFO with no writer
 * yet reads EOF at once, and the worker opens ITS end only after this side has attached, so a
 * read-only open would race into a spurious "the worker closed the response fifo". Holding a
 * (never written) write end keeps the pipe from ever reading EOF; the worker's death is
 * observed through the `sandbox.run` promise, the per-request timer and the plane's watchdog.
 */
async function openFifo(path: string, end: 'request' | 'response', deadlineAt: number, budgetMs: number, sleep: (ms: number) => Promise<void>): Promise<number> {
  const flags = end === 'request' ? fsConstants.O_WRONLY | fsConstants.O_NONBLOCK : fsConstants.O_RDWR | fsConstants.O_NONBLOCK;
  for (;;) {
    try {
      return await openFd(path, flags);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      // ENXIO: no reader yet. ENOENT: the worker has not reached its mkfifo (it announces after,
      // so this is only a filesystem lagging behind). Anything else is a real failure.
      if (code !== 'ENXIO' && code !== 'ENOENT') throw new WarmError(`cannot open the ${end} fifo: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      if (Date.now() >= deadlineAt) throw new WarmError(`the ${end} fifo had no peer within ${budgetMs} ms`, { timedOut: true });
      await sleep(WARM_FIFO_POLL_MS);
    }
  }
}

/** How long to wait before the next poll of an in-flight request, by how long it has been running. */
export function pollDelayMs(elapsedMs: number): number {
  for (const band of WARM_POLL_BANDS) if (elapsedMs < band.untilMs) return band.everyMs;
  return WARM_POLL_BANDS[WARM_POLL_BANDS.length - 1]?.everyMs ?? 20;
}

export interface WarmWorkerOptions {
  sandbox: Pick<Sandbox, 'run'>;
  signal: AbortSignal;
  /** the worker's own directory (holds the two FIFOs); created here */
  dir: string;
  /** absolute path of the server source, already written */
  serverPath: string;
  /** the lane directory: the worker's cwd, exactly as a cold lane run's */
  cwd: string;
  mode: WarmMode;
  /** `python` or `python3`, taken from the cold command so the interpreter matches */
  interpreter: string;
  /** roots the warm parent must never import from (the workspace and the lane) */
  roots: readonly string[];
  /** directory holding run_tests.py, for `quixbugs` mode */
  quixbugsDir?: string;
  /**
   * Environment of the worker process, merged over the sandbox's scrubbed allowlist exactly as a
   * cold lane run's is (`laneRunEnv`). Per-run keys do NOT belong here: they are set inside the
   * forked child per request, so every candidate sees the env its cold twin would.
   */
  env?: Readonly<Record<string, string>>;
  now?: () => number;
  /** injectable for the tests that drive the fifo retry loop; default a real timer */
  sleep?: (ms: number) => Promise<void>;
  /**
   * How long the boot may take: the ready line, then both fifo ends, then the ping. Default
   * `WARM_BOOT_TIMEOUT_MS`; a test that drives the watchdog with a worker that sleeps for ever
   * passes a small one so the case costs a second rather than a minute.
   */
  bootTimeoutMs?: number;
}

interface Pending {
  id: number;
  /** a `run` must be answered with a run result; an answer without stdout is an anomaly, not an empty pass */
  wantsRun: boolean;
  resolve: (r: WarmRunResult) => void;
  reject: (e: WarmError) => void;
  timer: NodeJS.Timeout;
}

/** The server source, written once per run into the run's warm directory. */
export async function writeWarmServer(warmRoot: string): Promise<string> {
  await mkdir(warmRoot, { recursive: true });
  const path = join(warmRoot, WARM_SERVER_FILENAME);
  await writeFile(path, WARM_SERVER_PY, 'utf8');
  return path;
}

export class WarmWorker {
  private readonly opts: WarmWorkerOptions;
  /** raw O_NONBLOCK fds; see the module header for why they are not streams */
  private reqFd: number | null = null;
  private respFd: number | null = null;
  /** the request bytes `writeSync` has not taken yet (a fifo write is atomic only to PIPE_BUF) */
  private outbox = Buffer.alloc(0);
  /** response bytes read so far, up to the last newline */
  private inbox = '';
  private readonly decoder = new StringDecoder('utf8');
  private readonly chunk = Buffer.allocUnsafe(READ_CHUNK);
  private poll: NodeJS.Timeout | null = null;
  private pending: Pending | null = null;
  private nextId = 1;
  private state: 'booting' | 'ready' | 'dead' = 'booting';
  private deathReason = '';
  /** whether `deathReason` was a deadline rather than a crash; the plane treats the two differently */
  private diedOnTimeout = false;
  /** set while `boot()` waits for the ready line, so a worker that exits at once fails boot at once */
  private bootFailed: ((e: WarmError) => void) | null = null;

  private constructor(opts: WarmWorkerOptions) {
    this.opts = opts;
  }

  get alive(): boolean {
    return this.state === 'ready';
  }
  get reason(): string {
    return this.deathReason;
  }

  /** Boot a worker, or throw a WarmError. The caller falls back to the cold path on any throw. */
  static async start(opts: WarmWorkerOptions): Promise<WarmWorker> {
    const w = new WarmWorker(opts);
    await w.boot();
    return w;
  }

  private command(): string {
    const o = this.opts;
    const parts = ['PYTHONDONTWRITEBYTECODE=1', o.interpreter, shellQuote(o.serverPath), '--dir', shellQuote(o.dir), '--mode', o.mode, '--idle-ms', String(WARM_IDLE_MS), '--max-ms', String(WARM_MAX_LIFETIME_MS), '--connect-ms', String(o.bootTimeoutMs ?? WARM_BOOT_TIMEOUT_MS)];
    if (o.mode === 'quixbugs' && o.quixbugsDir !== undefined) parts.push('--quixbugs-dir', shellQuote(o.quixbugsDir));
    for (const r of o.roots) parts.push('--root', shellQuote(r));
    return parts.join(' ');
  }

  private async boot(): Promise<void> {
    const o = this.opts;
    const bootMs = o.bootTimeoutMs ?? WARM_BOOT_TIMEOUT_MS;
    await mkdir(o.dir, { recursive: true });
    let announce: (() => void) | null = null;
    const ready = new Promise<void>((res, rej) => {
      announce = res;
      this.bootFailed = (e): void => rej(e);
    });
    let seen = '';
    const onOutput = (_stream: 'stdout' | 'stderr', chunk: string): void => {
      seen = `${seen}${chunk}`.slice(-4096);
      if (seen.includes(WARM_READY_PREFIX)) announce?.();
    };
    // Not awaited: this promise settles when the worker exits. Its rejection (an aborted run) is
    // absorbed here; the worker's death is observed through `pending` and `state` instead.
    void o.sandbox
      .run(this.command(), { timeoutMs: WARM_MAX_LIFETIME_MS, maxOutputBytes: WARM_WORKER_OUTPUT_BYTES, signal: o.signal, cwd: o.cwd, onOutput, env: { ...o.env, PYTHONDONTWRITEBYTECODE: '1' } })
      .then(
        (res) => this.die(`worker exited (${res.exitCode ?? 'null'}${res.killedBy === null ? '' : `, killed: ${res.killedBy}`}): ${(res.stderr || res.stdout).trim().split('\n').pop() ?? ''}`),
        (e: unknown) => this.die(`worker failed: ${e instanceof Error ? e.message : String(e)}`),
      )
      .catch(() => undefined);
    const timer = setTimeout(() => this.die(`no ${WARM_READY_PREFIX} within ${bootMs} ms`, true), bootMs);
    try {
      await ready;
    } finally {
      clearTimeout(timer);
      this.bootFailed = null;
    }
    if (this.state === 'dead') throw new WarmError(this.deathReason, { timedOut: this.diedOnTimeout });
    try {
      // The worker opens `req` for reading and then `resp` for writing, so the order here is
      // fixed (write end first, read end second). Both opens are non-blocking and bounded by
      // one deadline: a worker that died between its ready line and its own open is a timeout
      // here, never a libuv thread left in `open(2)` for the life of the process.
      const attachBy = Date.now() + bootMs;
      const sleep = o.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
      this.reqFd = await openFifo(join(o.dir, WARM_REQ_FIFO), 'request', attachBy, bootMs, sleep);
      this.respFd = await openFifo(join(o.dir, WARM_RESP_FIFO), 'response', attachBy, bootMs, sleep);
      this.state = 'ready';
      // a ping proves the whole transport, not just the process (the health check of §3 M6)
      await this.send({ op: 'ping' }, bootMs);
    } catch (e: unknown) {
      const err = e instanceof WarmError ? e : new WarmError(e instanceof Error ? e.message : String(e));
      this.die(err.message, err.timedOut);
      throw err;
    }
  }

  private onLine(line: string): void {
    const p = this.pending;
    if (p === null) {
      this.die(`unsolicited response: ${line.slice(0, 120)}`);
      return;
    }
    const res = parseResponse(line);
    if (res.id !== p.id && res.id !== -1) {
      this.settle(p, new WarmError(`response id ${res.id} for request ${p.id}`));
      this.die('sentinel desync');
      return;
    }
    if (res.kind === 'ok') {
      this.settle(p, null, res.result);
      return;
    }
    if (res.kind === 'ready') {
      if (p.wantsRun) {
        // a run answered with no stdout would summarise as "nothing ran" — an `unchanged`
        // verdict invented by a protocol bug. It is an anomaly, and anomalies run cold.
        this.settle(p, new WarmError('the worker answered a run with no output'));
        this.die('run answered without a result');
        return;
      }
      this.settle(p, null, { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, durationMs: 0 });
      return;
    }
    if (res.kind === 'invalidate') {
      this.settle(p, new WarmError(`the warm interpreter imported ${res.path}, which a candidate changed`, { invalidated: true }));
      this.die('import set invalidated');
      return;
    }
    this.settle(p, new WarmError(res.message));
    this.die(res.message);
  }

  private settle(p: Pending, err: WarmError | null, value?: WarmRunResult): void {
    if (this.pending !== p) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (err !== null) p.reject(err);
    else p.resolve(value ?? { stdout: '', stderr: '', exitCode: null, timedOut: false, truncated: false, durationMs: 0 });
  }

  private die(reason: string, timedOut = false): void {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.deathReason = reason;
    this.diedOnTimeout = timedOut;
    // an interpreter that exits before announcing itself fails the boot now, not at the boot timeout
    this.bootFailed?.(new WarmError(reason, { timedOut }));
    const p = this.pending;
    if (p !== null) {
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(new WarmError(reason, { timedOut }));
    }
    this.close();
  }

  private close(): void {
    this.stopPolling();
    // closing the request end is the worker's own EOF signal, and the one thing that must happen
    for (const fd of [this.reqFd, this.respFd]) {
      if (fd === null) continue;
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
    this.reqFd = null;
    this.respFd = null;
    this.outbox = Buffer.alloc(0);
  }

  /** A method, not a comparison: the narrowing of a field cannot see that `onLine` may kill us. */
  private isDead(): boolean {
    return this.state === 'dead';
  }

  private stopPolling(): void {
    if (this.poll === null) return;
    clearTimeout(this.poll);
    this.poll = null;
  }

  /**
   * Drive the fifos while a request is outstanding: flush whatever of the request `writeSync`
   * has not taken (a fifo write is atomic only to PIPE_BUF, 512 bytes on macOS), then read every
   * complete response line. Re-arms itself until the request is answered, the outbox is empty
   * or the worker dies; an idle worker polls nothing at all.
   */
  private tick(startedAt: number): void {
    this.poll = null;
    if (this.isDead()) return;
    this.flush();
    this.drain();
    if (this.isDead()) return;
    if (this.pending === null && this.outbox.length === 0) return;
    const timer = setTimeout(() => this.tick(startedAt), pollDelayMs(Date.now() - startedAt));
    // the transport must never be the reason the harness stays alive
    timer.unref();
    this.poll = timer;
  }

  private arm(): void {
    if (this.poll !== null || this.isDead()) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => this.tick(startedAt), pollDelayMs(0));
    timer.unref();
    this.poll = timer;
  }

  /** Push what is left of the request; EAGAIN just means the next tick tries again. */
  private flush(): void {
    const fd = this.reqFd;
    if (fd === null || this.outbox.length === 0) return;
    try {
      const n = writeSync(fd, this.outbox);
      this.outbox = n >= this.outbox.length ? Buffer.alloc(0) : this.outbox.subarray(n);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') return;
      this.die(`cannot write the request: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Read every byte the response fifo has, and hand each complete line to `onLine`. */
  private drain(): void {
    const fd = this.respFd;
    if (fd === null) return;
    for (;;) {
      let n = 0;
      try {
        n = readSync(fd, this.chunk, 0, this.chunk.length, null);
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EAGAIN') return;
        this.die(`cannot read the response: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      // 0 is impossible while this side holds the fifo's write end too (see `openFifo`)
      if (n === 0) return;
      this.inbox += this.decoder.write(this.chunk.subarray(0, n));
      let at = this.inbox.indexOf('\n');
      while (at !== -1) {
        const line = this.inbox.slice(0, at).trim();
        this.inbox = this.inbox.slice(at + 1);
        if (line !== '') {
          this.onLine(line);
          if (this.isDead()) return;
        }
        at = this.inbox.indexOf('\n');
      }
    }
  }

  private send(body: Record<string, string | number | boolean | readonly string[] | Record<string, string>>, waitMs: number, wantsRun = false): Promise<WarmRunResult> {
    if (this.state === 'dead') return Promise.reject(new WarmError(this.deathReason || 'worker is dead', { timedOut: this.diedOnTimeout }));
    if (this.pending !== null) return Promise.reject(new WarmError('a request is already in flight on this lane'));
    const id = this.nextId++;
    if (this.reqFd === null) return Promise.reject(new WarmError('worker has no request channel'));
    return new Promise<WarmRunResult>((resolve, reject) => {
      const timer = setTimeout(() => this.die(`no response within ${waitMs} ms`, true), waitMs);
      this.pending = { id, wantsRun, resolve, reject, timer };
      this.outbox = Buffer.concat([this.outbox, Buffer.from(`${JSON.stringify({ id, ...body })}\n`, 'utf8')]);
      this.flush();
      this.arm();
    });
  }

  /**
   * Run one candidate. `deadlineMs` is the wall the *worker* enforces with killpg(SIGKILL), the
   * same role the sandbox timeout plays on the cold path; the transport waits a little longer so
   * a timeout is reported as a timed-out run, not as a dead worker.
   *
   * The worker charges that wall from before its fork and subtracts what it measured a cold run
   * to spend on process start, so `deadlineMs` buys the same amount of CANDIDATE compute on both
   * paths. It can still only be an approximation, which is why `runQueue` re-runs any warm run
   * that hit a deadline on the cold path before it is allowed to be a verdict.
   */
  async run(req: WarmRunRequest, deadlineMs: number, env: Readonly<Record<string, string>> = {}): Promise<WarmRunResult> {
    // the same output budget `src/sandbox/run.ts` gives a cold run, shared across the two streams
    const body: Record<string, string | number | boolean | readonly string[] | Record<string, string>> = { op: 'run', kind: req.kind, deadlineMs, outputBytes: WARM_OUTPUT_BYTES, tailBytes: TAIL_BYTES, env: { ...env } };
    if (req.kind === 'quixbugs') {
      body['dir'] = req.dir;
      body['name'] = req.name;
      body['path'] = req.path;
      if (req.timeout !== undefined) body['timeout'] = req.timeout;
      if (req.slow !== undefined) body['slow'] = req.slow;
      if (req.maxFailures !== undefined) body['maxFailures'] = req.maxFailures;
    } else {
      body['args'] = req.args;
    }
    return this.send(body, deadlineMs + WARM_RESPONSE_SLACK_MS, true);
  }

  /** Idempotent: ends the request FIFO, which is the worker's own exit signal. */
  dispose(): void {
    if (this.state !== 'dead') {
      this.state = 'dead';
      this.deathReason = 'disposed';
      this.close();
    }
  }
}
