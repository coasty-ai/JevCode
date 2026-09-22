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
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface, type Interface } from 'node:readline';
import { join } from 'node:path';
import type { ReadStream, WriteStream } from 'node:fs';

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

export class WarmError extends Error {
  /** true when the warm parent's import set went stale: restart, and run this candidate cold */
  readonly invalidated: boolean;
  constructor(message: string, opts: { invalidated?: boolean; cause?: unknown } = {}) {
    super(`WarmError: ${message}`, opts.cause === undefined ? {} : { cause: opts.cause });
    this.name = 'WarmError';
    this.invalidated = opts.invalidated === true;
  }
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
  private req: WriteStream | null = null;
  private resp: ReadStream | null = null;
  private lines: Interface | null = null;
  private pending: Pending | null = null;
  private nextId = 1;
  private state: 'booting' | 'ready' | 'dead' = 'booting';
  private deathReason = '';
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
    const parts = ['PYTHONDONTWRITEBYTECODE=1', o.interpreter, shellQuote(o.serverPath), '--dir', shellQuote(o.dir), '--mode', o.mode, '--idle-ms', String(WARM_IDLE_MS), '--max-ms', String(WARM_MAX_LIFETIME_MS), '--connect-ms', String(WARM_BOOT_TIMEOUT_MS)];
    if (o.mode === 'quixbugs' && o.quixbugsDir !== undefined) parts.push('--quixbugs-dir', shellQuote(o.quixbugsDir));
    for (const r of o.roots) parts.push('--root', shellQuote(r));
    return parts.join(' ');
  }

  private async boot(): Promise<void> {
    const o = this.opts;
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
    const timer = setTimeout(() => this.die(`no ${WARM_READY_PREFIX} within ${WARM_BOOT_TIMEOUT_MS} ms`), WARM_BOOT_TIMEOUT_MS);
    try {
      await ready;
    } finally {
      clearTimeout(timer);
      this.bootFailed = null;
    }
    if (this.state === 'dead') throw new WarmError(this.deathReason);
    try {
      // The worker opens `req` for reading and then `resp` for writing, and opening a FIFO blocks
      // until the peer opens its end — so the order here is fixed (write end first, read end
      // second) and BOTH opens are bounded: a worker that died between its ready line and its
      // open would otherwise leave this promise pending for ever, hanging the whole batch.
      this.req = createWriteStream(join(o.dir, WARM_REQ_FIFO));
      await this.opened(this.req, 'request fifo');
      this.req.on('error', (e) => this.die(`request fifo: ${e.message}`));
      this.resp = createReadStream(join(o.dir, WARM_RESP_FIFO));
      await this.opened(this.resp, 'response fifo');
      this.resp.on('error', (e) => this.die(`response fifo: ${e.message}`));
      this.lines = createInterface({ input: this.resp });
      this.lines.on('line', (l) => this.onLine(l));
      this.lines.on('close', () => this.die('response fifo closed'));
      this.state = 'ready';
      // a ping proves the whole transport, not just the process (the health check of §3 M6)
      await this.send({ op: 'ping' }, WARM_BOOT_TIMEOUT_MS);
    } catch (e: unknown) {
      const err = e instanceof WarmError ? e : new WarmError(e instanceof Error ? e.message : String(e));
      this.die(err.message);
      throw err;
    }
  }

  /** Wait for a fifo end to open, bounded; on the deadline the stream is destroyed, not left pending. */
  private opened(stream: { once(event: string, listener: (...args: never[]) => void): unknown; destroy(): unknown }, what: string): Promise<void> {
    return new Promise<void>((res, rej) => {
      const timer = setTimeout(() => {
        stream.destroy();
        rej(new WarmError(`the ${what} did not open within ${WARM_BOOT_TIMEOUT_MS} ms`));
      }, WARM_BOOT_TIMEOUT_MS);
      stream.once('open', () => {
        clearTimeout(timer);
        res();
      });
      stream.once('error', ((e: Error) => {
        clearTimeout(timer);
        rej(new WarmError(`cannot open the ${what}: ${e.message}`, { cause: e }));
      }) as (...args: never[]) => void);
    });
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

  private die(reason: string): void {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.deathReason = reason;
    // an interpreter that exits before announcing itself fails the boot now, not at the boot timeout
    this.bootFailed?.(new WarmError(reason));
    const p = this.pending;
    if (p !== null) {
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(new WarmError(reason));
    }
    this.close();
  }

  private close(): void {
    try {
      this.req?.end();
    } catch {
      /* the fifo is already gone */
    }
    try {
      this.lines?.removeAllListeners('close');
      this.lines?.close();
    } catch {
      /* already closed */
    }
    try {
      this.resp?.close();
    } catch {
      /* already closed */
    }
    this.req = null;
    this.resp = null;
    this.lines = null;
  }

  private send(body: Record<string, string | number | boolean | readonly string[] | Record<string, string>>, waitMs: number, wantsRun = false): Promise<WarmRunResult> {
    if (this.state === 'dead') return Promise.reject(new WarmError(this.deathReason || 'worker is dead'));
    if (this.pending !== null) return Promise.reject(new WarmError('a request is already in flight on this lane'));
    const id = this.nextId++;
    const stream = this.req;
    if (stream === null) return Promise.reject(new WarmError('worker has no request channel'));
    return new Promise<WarmRunResult>((resolve, reject) => {
      const timer = setTimeout(() => this.die(`no response within ${waitMs} ms`), waitMs);
      this.pending = { id, wantsRun, resolve, reject, timer };
      stream.write(`${JSON.stringify({ id, ...body })}\n`, (e) => {
        if (e) this.die(`cannot write the request: ${e.message}`);
      });
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
