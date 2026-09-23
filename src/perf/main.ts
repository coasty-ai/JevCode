/**
 * `jevcode perf` (DESIGN.md §12; TUI-DESIGN §18; TUI-DESIGN-2 §9): first frame (run + chat, three geometries; the
 * first frame is splash frame 0), harness overhead per step with images, Static append bytes, render lag while typing
 * during a live mocked run paced by `JEVCODE_MOCK_STEP_MS` (three geometries at the realistic 200 ms rate, gated; one
 * zero-latency stress row, reported; a splash frame-count bucket per geometry), composer keystroke latency (six
 * series), the intake reply latency (Enter → `[you]` bubble, Enter → `[jevcode]` reply, mock at 0 ms and delayed
 * 150 ms), the idle wordmark loop's frame and byte budget over 31 s (TUI-DESIGN-3 §3.9), zero clears per state, and (with
 * --live) Jev latency. Writes perf/results/latest.json, prints a table,
 * rewrites the Performance section of docs/measurements/performance.md from the result (`readme.ts`; complete runs, and
 * only in a checkout whose `package.json` is ours — `rewriteReadmePerformance`) and exits 1 when a gate fails.
 *
 * Opt-in probes (named in `JEVCODE_PERF_ONLY`, never in a bare run): `lane-run` and `sandbox-spawn` (Ring 0), and
 * `stream-latency` — a streamed `--mock` chat reply timed per delta from emission to paint through the typist's clock
 * bridge (`stream-latency.ts`), red on arrival by design and outside the release set until the streaming work lands.
 *
 * It runs from a source checkout only. Every probe resolves `bin/jevcode.js`, `scripts/pty/drive.exp` and
 * `perf/drivers/pty_type.py` out of the CWD, and the last two are not in the shipped package at all, so a CWD with no
 * `bin/jevcode.js` is refused up front (`PERF_NEEDS_CHECKOUT`, exit 2) instead of failing probe by probe.
 *
 * One measurement at a time on this machine: `/tmp/jevcode-perf-window-open` (`PERF_WINDOW_FILE`) is taken for the
 * length of the run and released in a `finally`; a run that finds a live window refuses with exit 2 and names the
 * file, when it was taken and by whom. A window past its TTL (`perfWindowTtlMs`) is a killed run's leftover and is
 * replaced with a logged note.
 *
 * The machine must be quiet: the 1-minute load average is read first and, above `LOAD_MAX`, the run waits
 * `LOAD_WAIT_MS` and re-reads it up to three times (the load at measurement start and end is recorded either way). A
 * release number additionally needs the load ≤ `LOAD_QUIET` at both ends (`load.quiet` in the result): the harness
 * gate passes by a few milliseconds and flips under modest load (`step-overhead.ts`).
 *
 * `JEVCODE_PERF_ONLY=first-frame,states` (comma list of probe names) runs a subset — for iterating on one probe; a
 * subset result is written with `partial: true`, never counts as the release number and never reaches the README.
 *
 * The Static microbenchmark mounts the real Ink App in-process (`static-append.ts`); Ink's cursor helper registers an
 * exit hook that writes `ESC[?25h` to `process.stderr` (`restore-cursor`: `signalExit(() => process.stderr.write(…))`),
 * which would corrupt the perf command's own output at exit, so the parent runs it in a child `jevcode perf` process
 * (`JEVCODE_PERF_ONLY=static-append`, `JEVCODE_PERF_CHILD=1`, stdio piped) and reads its JSON.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ParsedFlags } from '../cli/args.js';
import { ConfigError } from '../errors.js';
import { isJsonObject } from '../core/json.js';
import { measureFirstFrame, type FirstFrameResult } from './first-frame.js';
import { measureStepOverhead, type StepOverheadResult } from './step-overhead.js';
import { REALISTIC_STEP_MS, measureRenderLag, type RenderLagResult } from './render-lag.js';
import { measureComposerLatency, type ComposerLatencyResult } from './composer-latency.js';
import { measureIntakeLatency, type IntakeLatencyResult } from './intake-latency.js';
import { measureIdleFrames, type IdleFramesResult } from './idle-frames.js';
import { measureStates, type StatesResult } from './states.js';
import { measureScrollLatency, type ScrollLatencyResult } from './scroll-latency.js';
import type { StreamLatencyResult } from './stream-latency.js';
import type { StaticAppendResult } from './static-append.js';
import type { JevLatencyResult } from './jev-latency.js';
import type { LaneRunResult } from './lane-run.js';
import type { SandboxSpawnResult } from './sandbox-spawn.js';
import { resultRows, updateReadmePerformance } from './readme.js';

/**
 * The working directory `jevcode perf` measures, and the only one it is allowed to write a README into.
 *
 * Every probe resolves its instruments from the CWD — `bin/jevcode.js` (the binary each pty child runs),
 * `scripts/pty/drive.exp` (`pty.ts`) and `perf/drivers/pty_type.py` — and neither `scripts/` nor `perf/` is in
 * package.json `files` (`scripts/check-pack.mjs` forbids both from the tarball, and `bin` is only shipped inside the
 * package directory, not into the user's CWD). So from an installed package the command cannot work, and before this
 * guard it answered with a probe-by-probe failure cascade rather than a diagnosis — having first rewritten whatever
 * `README.md` the user happened to be standing next to.
 */
export const PERF_NEEDS_CHECKOUT =
  'jevcode perf runs only from a JevCode source checkout (needs bin/jevcode.js, scripts/pty/, perf/drivers/ in the working directory)';

/** `<root>/bin/jevcode.js` exists: the cheapest sound test that this CWD is the source tree the probes need. */
export function hasPerfInstruments(root: string): boolean {
  return existsSync(resolve(root, 'bin/jevcode.js'));
}

/**
 * This CWD is a JevCode checkout: the perf binary is here AND `package.json` is ours. The README rewrite is gated on
 * this rather than on `hasPerfInstruments` alone, because a foreign tree can hold a `bin/jevcode.js` (a vendored
 * copy, a fixture) and its README is still not ours to rewrite.
 */
export function isJevCodeCheckout(root: string): boolean {
  if (!hasPerfInstruments(root)) return false;
  try {
    const pkg: unknown = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    return isJsonObject(pkg) && pkg['name'] === 'jevcode';
  } catch {
    return false;
  }
}

/**
 * The perf-window sentinel (docs/LLM-LOOP-DESIGN.md §8.2's last bullet; the protocol in full is the DECISIONS entry
 * "The perf-window sentinel protocol"): two autonomous sessions share this machine's cores, and a measurement taken
 * while the other one is building or running its suites measures the load, not the change. The protocol used to live
 * in that one design-doc bullet, which nothing read and nothing enforced; it is enforced here, where the load is
 * generated — `runPerf` refuses to start while a live window exists, writes the protocol's header line for the
 * length of the run, and removes it in a `finally`.
 */
export const PERF_WINDOW_FILE = '/tmp/jevcode-perf-window-open';
/**
 * The sentinel's one line, as the protocol states it: `<iso-8601 created> <pid> <owner-label> <expected-minutes>`.
 * The label is what a human reads in the refusal of the run that is waiting for it.
 */
export const PERF_WINDOW_OWNER = 'jevcode-perf';
/** What a release run claims when it takes the window; the TTL floor covers it, so it is a label, not a promise. */
export const PERF_WINDOW_EXPECTED_MIN = 30;
/** TTL floor: below this a window is honoured however short its header claims to be. */
export const PERF_WINDOW_TTL_FLOOR_MS = 30 * 60 * 1000;
/** TTL ceiling: no header can hold the machine longer than this — a longer measurement takes the window in segments. */
export const PERF_WINDOW_TTL_MAX_MS = 90 * 60 * 1000;

/** Where the sentinel lives. `JEVCODE_PERF_WINDOW` overrides it, so a test never touches the machine's real window. */
export function perfWindowPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['JEVCODE_PERF_WINDOW'];
  return override !== undefined && override.trim() !== '' ? override.trim() : PERF_WINDOW_FILE;
}

/** The sentinel's header line, parsed. */
export interface PerfWindowHeader {
  createdAt: Date;
  pid: number;
  owner: string;
  expectedMinutes: number;
}

/** `<iso-8601 created> <pid> <owner-label> <expected-minutes>`, or null for a sentinel that carries no such line. */
export function parsePerfWindowHeader(text: string): PerfWindowHeader | null {
  const parts = (text.split('\n')[0] ?? '').trim().split(/\s+/);
  if (parts.length < 4) return null;
  const [iso, pid, owner, mins] = parts as [string, string, string, string];
  const createdMs = Date.parse(iso);
  const pidN = Number(pid);
  const minsN = Number(mins);
  if (!Number.isFinite(createdMs) || !Number.isInteger(pidN) || pidN <= 0 || !Number.isFinite(minsN) || minsN < 0) return null;
  return { createdAt: new Date(createdMs), pid: pidN, owner, expectedMinutes: minsN };
}

/**
 * How long this sentinel describes a live measurement: `max(expected, 30)` minutes, never more than 90. A sentinel
 * with no parseable header — a bare `touch`, which is all the agent prompts ask for — keeps the floor, measured from
 * its mtime: clobbering somebody's live window costs a real measurement, while honouring a leftover costs one
 * refusal that says which file to remove.
 *
 * That headerless reading is the one place this implementation and the protocol's first draft disagreed, and the
 * disagreement is settled in writing: docs/DECISIONS.md "Amendment (applied in place above): a perf-window sentinel
 * with no readable header is HELD from its mtime, not stale", whose replacement sentence the integration branch
 * applied IN PLACE inside the F17 sentinel entry's "Who creates it" bullet (it used to read "a reader that cannot
 * parse that line treats the file as stale"). Nothing is held indefinitely: the floor still expires.
 */
export function perfWindowTtlMs(header: PerfWindowHeader | null): number {
  if (header === null) return PERF_WINDOW_TTL_FLOOR_MS;
  return Math.min(PERF_WINDOW_TTL_MAX_MS, Math.max(PERF_WINDOW_TTL_FLOOR_MS, header.expectedMinutes * 60_000));
}

/** free: no sentinel; held: one inside its TTL; stale: one past it, i.e. a killed run's leftover. */
export type PerfWindow =
  | { kind: 'free' }
  | { kind: 'held' | 'stale'; header: PerfWindowHeader | null; owner: string; createdAt: Date; ageMs: number; ttlMs: number };

/** Read the sentinel: what it is, who wrote it, how old it is against its own TTL. A path with no file reads as free. */
export function perfWindowState(path: string, now: number = Date.now()): PerfWindow {
  let mtime: Date;
  try {
    mtime = statSync(path).mtime;
  } catch {
    return { kind: 'free' };
  }
  let header: PerfWindowHeader | null = null;
  try {
    header = parsePerfWindowHeader(readFileSync(path, 'utf8'));
  } catch {
    // an unreadable sentinel still holds the window; it just cannot say who by
  }
  const createdAt = header?.createdAt ?? mtime;
  const ttlMs = perfWindowTtlMs(header);
  const ageMs = Math.max(0, now - createdAt.getTime());
  const owner = header === null ? 'an unknown process' : `${header.owner} (pid ${header.pid})`;
  return { kind: ageMs > ttlMs ? 'stale' : 'held', header, owner, createdAt, ageMs, ttlMs };
}

const minutes = (ms: number): string => (ms / 60_000).toFixed(1);

/** The refusal sentence for a window another run holds: the file, when it was taken, by whom, so it can be chased. */
export function perfWindowBusyMessage(path: string, w: Extract<PerfWindow, { kind: 'held' | 'stale' }>): string {
  return `another perf window is open: ${path} (taken ${w.createdAt.toISOString()}, ${minutes(w.ageMs)} min ago, by ${w.owner}; it goes stale after ${minutes(w.ttlMs)} min) — wait for that measurement to finish, or remove the file if nothing is measuring`;
}

/**
 * `O_CREAT|O_EXCL`: true when THIS call created the file, false when something was already at that path. Every
 * other errno throws — a window that cannot be written for any other reason is not a window this run may assume.
 */
function createExclusive(path: string, line: string): boolean {
  try {
    writeFileSync(path, line, { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    return false;
  }
}

/** The refusal for a path that is occupied but that `perfWindowState` cannot read as a window. */
export function perfWindowOccupiedMessage(path: string): string {
  return `cannot take the perf window ${path}: the path exists but does not read as a window (another run took it in the same instant, or it is a dangling symlink) — remove it if nothing is measuring`;
}

/**
 * Take the perf window: refuse (`ConfigError`, exit 2) while another run holds it, replace a stale one with a logged
 * note, and write this run's header line.
 *
 * The create is **exclusive**, and that is the mutual exclusion — not the state read above it. `perfWindowState`
 * cannot arbitrate between two runs: the window is taken immediately before `awaitQuietMachine`, i.e. exactly when
 * both sessions on this machine are most likely to start together after waiting on the same sentinel, and a
 * check-then-write let every run that landed between the `statSync` and the `writeFileSync` read `free` and
 * measure. (It also left the first run's `closePerfWindow` declining to unlink, because the pid on disk was by then
 * the last writer's, so the leftover outlived all of them.) So the OS decides who created the file; the state read
 * is kept for the two things it is actually good at — the *wording* of the refusal, and recognising a killed run's
 * leftover, which is the one case where an existing file is replaced.
 */
export function openPerfWindow(path: string, log: (s: string) => void, now: number = Date.now()): void {
  const line = `${new Date(now).toISOString()} ${process.pid} ${PERF_WINDOW_OWNER} ${PERF_WINDOW_EXPECTED_MIN}\n`;
  // At most two attempts: one to take a free window, and one more after a stale leftover has been removed.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (createExclusive(path, line)) {
      log(`perf: perf window taken: ${path} (pid ${process.pid})\n`);
      return;
    }
    const w = perfWindowState(path, now);
    if (w.kind === 'held') throw new ConfigError(perfWindowBusyMessage(path, w));
    if (w.kind === 'stale') {
      log(`perf: ${path} is ${minutes(w.ageMs)} min old (stale after ${minutes(w.ttlMs)} min) and was taken by ${w.owner}; treating it as a killed run's leftover and replacing it\n`);
      // whoever unlinks it first wins the next create; losing that is another run holding the window, not an error
      try {
        unlinkSync(path);
      } catch {
        // gone already, or not ours to remove: the next exclusive create is the only answer that matters
      }
    }
    // `free` with the create refused means the path is occupied by something the state read cannot see (a
    // dangling symlink) or the holder released it in between; either way, one more exclusive attempt decides.
  }
  throw new ConfigError(perfWindowOccupiedMessage(path));
}

/** Release the window — but only the one this process wrote: never unlink a window another run took after ours. */
export function closePerfWindow(path: string, log: (s: string) => void): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // already gone
  }
  const header = parsePerfWindowHeader(text);
  if (header === null || header.pid !== process.pid) {
    log(`perf: ${path} now reads "${text.split('\n')[0] ?? ''}", not this run (pid ${process.pid}); leaving it alone\n`);
    return;
  }
  try {
    unlinkSync(path);
  } catch {
    // a window this run cannot remove is a stale one for the next, which replaces it after the TTL
  }
}

/** The line a run prints when it declines to touch a performance page that is not this project's. */
export const README_NOT_A_CHECKOUT = 'docs/measurements/performance.md not rewritten (not a JevCode checkout)\n';
/** Where the release table lives since the public README shrank to a summary: the measurements page carries `## Performance`. */
export const PERFORMANCE_PAGE = 'docs/measurements/performance.md';

/**
 * The page write path of a complete run, and the only caller of `updateReadmePerformance` outside its own tests.
 *
 * `updateReadmePerformance` replaces the `## Performance` section of whatever file it is handed, so the guard has to
 * be here: `<cwd>/docs/measurements/performance.md` is JevCode's page or the run does not write it (the public
 * README no longer carries the table). `partial` — the only condition the
 * rewrite used to carry — says which probes were *asked for*, never whose README this is. Returns the line to log.
 */
export function rewriteReadmePerformance(root: string, out: string, result: PerfResult): string {
  if (!isJevCodeCheckout(root)) return README_NOT_A_CHECKOUT;
  const ok = updateReadmePerformance(resolve(root, PERFORMANCE_PAGE), result);
  return ok ? `${PERFORMANCE_PAGE} Performance section rewritten from ${out}\n` : `${PERFORMANCE_PAGE} has no "## Performance" section; nothing rewritten\n`;
}

export const LOAD_MAX = 8;
/** a release number is taken with the 1-minute load ≤ this at the start and the end of the run */
export const LOAD_QUIET = 2;
export const LOAD_WAIT_MS = 30_000;
export const LOAD_RETRIES = 3;

/** TUI-DESIGN-4 contract 1.7 item 11 / §11: `scroll-latency` is round 4's new probe (fullscreen only, D-S). */
export type ProbeName = 'first-frame' | 'step-overhead' | 'static-append' | 'render-lag' | 'composer-latency' | 'intake-latency' | 'idle-frames' | 'states' | 'scroll-latency' | 'lane-run' | 'sandbox-spawn' | 'stream-latency';
/** the release set: what a bare `jevcode perf` runs, what the README is rewritten from, what the gate is. */
const ALL_PROBES: readonly ProbeName[] = ['first-frame', 'step-overhead', 'static-append', 'render-lag', 'composer-latency', 'intake-latency', 'idle-frames', 'states', 'scroll-latency'];
/**
 * HARNESS-NEXT-DESIGN §5 Ring 0 — opt-in probes: `JEVCODE_PERF_ONLY=lane-run jevcode perf`.
 *
 * They are deliberately NOT in the release set. `lane-run` spawns real interpreters and needs `python3` plus the
 * bench fixtures, and both are measurement instruments for the Fastlane waves rather than gates on this tree; §8
 * R-4's standing rule for this margin is that new work is off the measured path or it does not ship. Naming one of
 * them already makes the run `partial`, which by the header's contract is never a release number and never reaches
 * the README — so the release gate, its wall and its dependencies are byte-for-byte what they were before S0.
 */
const RING0_PROBES: readonly ProbeName[] = ['lane-run', 'sandbox-spawn'];
/**
 * Opt-in probes that are red on arrival by design: `stream-latency` measures the streaming work before it lands
 * (`JEVCODE_PERF_ONLY=stream-latency jevcode perf`). Like the Ring 0 probes, naming one makes the run `partial`, so the
 * release set, its gate and the performance page are unchanged; a probe moves into `ALL_PROBES` once it is green.
 */
const OPT_IN_PROBES: readonly ProbeName[] = ['stream-latency'];
const KNOWN_PROBES: readonly ProbeName[] = [...ALL_PROBES, ...RING0_PROBES, ...OPT_IN_PROBES];

export interface PerfResult {
  measuredAt: string;
  node: string;
  machine: { cpus: number; model: string; memGiB: number; os: string };
  load: { atStart: number; atEnd: number; waitedMs: number; max: number; quietMax: number; quiet: boolean };
  /** other pty drivers alive when the run started (`pgrep -fl 'drive.exp|pty_type.py'`, other agents' smokes): the run's conditions, recorded for the reader */
  foreignDrivers: string[];
  probes: ProbeName[];
  partial: boolean;
  firstFrame: FirstFrameResult | null;
  stepOverhead: StepOverheadResult | null;
  staticAppend: StaticAppendResult | null;
  renderLag: RenderLagResult | null;
  composerLatency: ComposerLatencyResult | null;
  /** TUI-DESIGN-2 §3.12 / §9: Enter → bubble and Enter → reply against the mock decider (null before round 2's `intake-latency` probe ran) */
  intakeLatency: IntakeLatencyResult | null;
  /** TUI-DESIGN-3 §3.9 / §9: the idle wordmark loop's frame and byte budget over 31 s (null before round 3's `idle-frames` probe ran) */
  idleFrames: IdleFramesResult | null;
  states: StatesResult | null;
  /** TUI-DESIGN-4 §11 / D-S: the fullscreen scroll gate; `skipped` (never a failure) when fullscreen was refused */
  scrollLatency: ScrollLatencyResult | null;
  jevLatency: JevLatencyResult | null;
  /** HARNESS-NEXT-DESIGN §5 Ring 0, opt-in (see RING0_PROBES): null unless JEVCODE_PERF_ONLY named them */
  laneRun: LaneRunResult | null;
  sandboxSpawn: SandboxSpawnResult | null;
  /** opt-in (see OPT_IN_PROBES): the streamed chat reply, per delta; null unless JEVCODE_PERF_ONLY named it */
  streamLatency: StreamLatencyResult | null;
  pass: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The probes a run measures: the release set when `JEVCODE_PERF_ONLY` is unset or empty, else exactly the named ones (known order). */
export function selectedProbes(env: NodeJS.ProcessEnv): ProbeName[] {
  const only = env['JEVCODE_PERF_ONLY'];
  if (only === undefined || only.trim() === '') return [...ALL_PROBES];
  const wanted = new Set(only.split(',').map((s) => s.trim()).filter(Boolean));
  const unknown = [...wanted].filter((w) => !KNOWN_PROBES.includes(w as ProbeName));
  if (unknown.length > 0) throw new Error(`JEVCODE_PERF_ONLY: unknown probe(s) ${unknown.join(', ')} (known: ${KNOWN_PROBES.join(', ')})`);
  return KNOWN_PROBES.filter((p) => wanted.has(p));
}

/** Wait for a quiet machine: 1-minute load ≤ LOAD_MAX, re-read up to LOAD_RETRIES times LOAD_WAIT_MS apart. */
async function awaitQuietMachine(log: (s: string) => void): Promise<{ load: number; waitedMs: number }> {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const load = loadavg()[0] ?? 0;
    if (load <= LOAD_MAX || attempt >= LOAD_RETRIES) {
      if (load > LOAD_MAX) log(`perf: load average ${load.toFixed(2)} still above ${LOAD_MAX} after ${LOAD_RETRIES} waits; measuring anyway (recorded in the result)\n`);
      return { load, waitedMs: waited };
    }
    log(`perf: load average ${load.toFixed(2)} > ${LOAD_MAX}; waiting ${LOAD_WAIT_MS / 1000} s (${attempt + 1}/${LOAD_RETRIES})…\n`);
    await sleep(LOAD_WAIT_MS);
    waited += LOAD_WAIT_MS;
  }
}

/**
 * The pty driver processes among `pgrep -fl` lines: an `expect` running `scripts/pty/drive.exp` or a `python3` running
 * `perf/drivers/pty_type.py` — not every process whose argv merely mentions those names (a shell carrying a script
 * text, an editor). One truncated `pid command` line each.
 */
export function driverLines(pgrepOutput: string): string[] {
  const driver = /^\d+\s+(?:\S*\/)?(?:expect\b.*drive\.exp|python3?\b.*pty_type\.py)/;
  return pgrepOutput
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => driver.test(l))
    .map((l) => (l.length > 160 ? `${l.slice(0, 159)}…` : l));
}

/** Other pty driver processes alive right now (drive.exp / pty_type.py of other agents). */
export function foreignPtyDrivers(): string[] {
  try {
    return driverLines(execFileSync('pgrep', ['-fl', 'drive\\.exp|pty_type\\.py'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    // pgrep exits 1 when nothing matches
    return [];
  }
}

/**
 * Run the Static microbenchmark in a child `jevcode perf` (see the header) and return its result; the child's progress
 * lines (two-space indented) are forwarded, everything else it prints is dropped. Null when the child failed.
 *
 * `parentEnv` is the run's environment — `PerfRunOptions.env`, i.e. `process.env` in production and whatever a test
 * injected otherwise. Reading `process.env` here instead would have made the injection a half-truth: the child is
 * the one place a perf run hands an environment to something else, so it is the one place where getting it from the
 * process rather than from the run is visible.
 */
export async function measureStaticAppendInChild(bin: string, root: string, parentEnv: NodeJS.ProcessEnv, progress: (line: string) => void): Promise<StaticAppendResult | null> {
  const dir = mkdtempSync(join(tmpdir(), 'jevcode-perf-static-'));
  const out = join(dir, 'static-append.json');
  const env: Record<string, string | undefined> = { ...parentEnv, JEVCODE_PERF_ONLY: 'static-append', JEVCODE_PERF_CHILD: '1', NODE_ENV: 'production' };
  delete env['CI'];
  try {
    const code = await new Promise<number | null>((done) => {
      const child = spawn(process.execPath, [bin, 'perf', '--out', out], { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: root });
      let buffered = '';
      child.stdout.on('data', (b: Buffer) => {
        buffered += b.toString('utf8');
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) if (line.startsWith('  ')) progress(line.slice(2));
      });
      child.stderr.on('data', () => undefined);
      const killer = setTimeout(() => child.kill('SIGKILL'), 300_000);
      child.on('close', (c) => {
        clearTimeout(killer);
        done(c);
      });
    });
    if (code !== 0) return null;
    const parsed: unknown = JSON.parse(readFileSync(out, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const sa = (parsed as { staticAppend?: StaticAppendResult | null }).staticAppend;
    return sa ?? null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * What a run measures from, reads its switches out of, and prints to. Defaults are the process's own; a test injects.
 *
 * The injection is honoured everywhere the run reaches out of itself: the two refusals, the README write, the
 * static-append child's cwd **and** its environment, and the `root` the `lane-run` and `jev-latency` probes resolve
 * their fixtures and config against. It is not a sandbox — the pty probes still resolve their drivers from `root`
 * and run real processes — but nothing on the path reads `process.env` or `process.cwd()` behind the caller's back.
 */
export interface PerfRunOptions {
  /** the working directory the probes and the README rewrite resolve against (default `process.cwd()`) */
  cwd?: string;
  /** the environment `JEVCODE_PERF_ONLY` / `JEVCODE_PERF_CHILD` / `JEVCODE_PERF_WINDOW` are read from, and the one the static-append child inherits (default `process.env`) */
  env?: NodeJS.ProcessEnv;
  /** where the run's own lines go (default `process.stdout`) */
  log?: (s: string) => void;
}

/**
 * `jevcode perf`. Two refusals come before any measurement:
 *
 *   * the CWD must be a JevCode source checkout (`PERF_NEEDS_CHECKOUT`) — the probes' instruments are resolved from
 *     it and are not in the shipped package;
 *   * the perf window must be free — one measurement at a time on this machine (`PERF_WINDOW_FILE`). The window is
 *     this process's for the length of the run and is released in a `finally`, including on a gate failure or a
 *     throw. A `JEVCODE_PERF_CHILD=1` run takes no window: its parent is holding one.
 */
export async function runPerf(flags: ParsedFlags, opts: PerfRunOptions = {}): Promise<number> {
  const root = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const log =
    opts.log ??
    ((s: string): void => {
      process.stdout.write(s);
    });
  if (!hasPerfInstruments(root)) throw new ConfigError(PERF_NEEDS_CHECKOUT);
  const child = env['JEVCODE_PERF_CHILD'] === '1';
  if (child) return measureAll(flags, { root, env, log, child });
  const windowPath = perfWindowPath(env);
  openPerfWindow(windowPath, log);
  try {
    return await measureAll(flags, { root, env, log, child });
  } finally {
    closePerfWindow(windowPath, log);
  }
}

async function measureAll(flags: ParsedFlags, ctx: { root: string; env: NodeJS.ProcessEnv; log: (s: string) => void; child: boolean }): Promise<number> {
  const { root, env, log, child } = ctx;
  const bin = resolve(root, 'bin/jevcode.js');
  const out = flags.out ?? 'perf/results/latest.json';
  const progress = (line: string): void => log(`  ${line}\n`);
  const probes = selectedProbes(env);
  const partial = probes.length !== ALL_PROBES.length;
  // the parent already waited for a quiet machine; a child measures right away
  const quiet = child ? { load: loadavg()[0] ?? 0, waitedMs: 0 } : await awaitQuietMachine(log);
  log(`perf: load average ${quiet.load.toFixed(2)} at start (limit ${LOAD_MAX}, release ≤ ${LOAD_QUIET}); probes: ${probes.join(', ')}${partial ? ' (PARTIAL)' : ''}\n`);
  const foreignDrivers = child ? [] : foreignPtyDrivers();
  if (foreignDrivers.length > 0) log(`perf: ${foreignDrivers.length} other pty driver process(es) alive at the start (recorded in the result):\n${foreignDrivers.map((d) => `  ${d}`).join('\n')}\n`);

  let firstFrame: FirstFrameResult | null = null;
  let overhead: StepOverheadResult | null = null;
  let staticAppend: StaticAppendResult | null = null;
  let lag: RenderLagResult | null = null;
  let composer: ComposerLatencyResult | null = null;
  let intake: IntakeLatencyResult | null = null;
  let idle: IdleFramesResult | null = null;
  let states: StatesResult | null = null;
  let scroll: ScrollLatencyResult | null = null;
  let jev: JevLatencyResult | null = null;
  let laneRun: LaneRunResult | null = null;
  let sandboxSpawn: SandboxSpawnResult | null = null;
  let stream: StreamLatencyResult | null = null;

  if (probes.includes('first-frame')) {
    log('perf: first frame (run + chat × 40x120 / 24x80 / 8x40; 10 cold + 10 warm runs each under a pseudo-TTY, zero network asserted)…\n');
    firstFrame = await measureFirstFrame({ bin, runs: 10, onProgress: progress });
  }
  if (probes.includes('step-overhead')) {
    log('perf: harness overhead per step (mocked, zero latency, 50 steps, 5,000-file fixture, 50 dirty files / 15 MiB, one 60 MiB artefact)…\n');
    overhead = await measureStepOverhead({ steps: 50 });
    progress(`harness p50 ${overhead.p50?.toFixed(1)} ms, p95 ${overhead.p95?.toFixed(1)} ms (run steps p95 ${overhead.harnessRunP95?.toFixed(1)} / p50 ${overhead.harnessRunP50?.toFixed(1)} ms, other steps p95 ${overhead.harnessOtherP95?.toFixed(1)} ms); imagesMs p50 ${overhead.imagesP50?.toFixed(1)} p95 ${overhead.imagesP95?.toFixed(1)} ms (run steps p95 ${overhead.imagesRunP95?.toFixed(1)} ms); hashSkipped ${String(overhead.hashSkipped)} at step ${overhead.artefactStep}; promptBuildMs p50 ${overhead.promptBuildP50?.toFixed(2)} p95 ${overhead.promptBuildP95?.toFixed(2)} ms (cold after --resume ${overhead.coldPromptBuildMs?.toFixed(2) ?? 'n/a'} ms)`);
    // HARNESS-NEXT-DESIGN §6 S0: with JEVCODE_TIMELINE set, where that p95 went (never in a gated run: the recorder would measure itself)
    for (const r of [...(overhead.timeline?.buckets ?? []), ...(overhead.timeline?.labels ?? [])]) {
      progress(`  ${r.bucket.padEnd(24)} p50 ${(r.p50 ?? 0).toFixed(1).padStart(7)} ms  p95 ${(r.p95 ?? 0).toFixed(1).padStart(7)} ms  total ${r.totalMs.toFixed(0).padStart(6)} ms  n ${r.n}`);
    }
  }
  if (probes.includes('static-append')) {
    log('perf: Static append bytes per committed line (in-process fake TTY 24x80: live + 6-row draft, review pending, idle)…\n');
    if (child) {
      const { measureStaticAppend } = await import('./static-append.js');
      staticAppend = await measureStaticAppend({ onProgress: progress });
    } else {
      staticAppend = await measureStaticAppendInChild(bin, root, env, progress);
      if (staticAppend === null) progress('static append: the child probe failed (no result) → FAIL');
    }
  }
  if (probes.includes('render-lag')) {
    log(`perf: render lag while typing 10 keys/s during a live mocked run (real pty, 120 columns: rows 40, rows 12, rows 40 reduced motion at JEVCODE_MOCK_STEP_MS=${REALISTIC_STEP_MS} — gated; rows 40 at 0 ms — the stress row, reported)…\n`);
    lag = await measureRenderLag({ root, bin, onProgress: progress });
  }
  if (probes.includes('composer-latency')) {
    log(`perf: composer keystroke → frame latency (real pty 24x80: idle, live at the A109 region at JEVCODE_MOCK_STEP_MS=${REALISTIC_STEP_MS}, live-stress at 0 ms (reported), palette, review; 200 keys 100 ms apart; burst30 latency reported, dynamic frame rate gated)…\n`);
    composer = await measureComposerLatency({ root, bin, onProgress: progress });
  }
  if (probes.includes('intake-latency')) {
    log('perf: intake reply latency (real pty 24x80, chat --mock: 20 greetings and tool questions, Enter → [you] bubble frame and Enter → [jevcode] reply frame, gated over the warm messages, the cold first one and the first-frame bubble reported; mock decider at 0 ms, then delayed 150 ms through JEVCODE_MOCK_JEV_MS)…\n');
    intake = await measureIntakeLatency({ root, bin, onProgress: progress });
  }
  // opt-in, imported lazily so a release run never loads it
  if (probes.includes('stream-latency')) {
    log('perf: streaming latency (real pty, chat --mock streaming a known reply — 30 / 5 ms gaps at 24x80 and 40x120, SSH, the mock decider at 150 ms, an 8 KB reply, typing while it streams; emission → paint per delta through the typist clock bridge; opt-in, red on arrival)…\n');
    const { measureStreamLatency } = await import('./stream-latency.js');
    stream = await measureStreamLatency({ root, bin, onProgress: progress });
  }
  if (probes.includes('idle-frames')) {
    log('perf: idle animation frames (real pty, chat --mock at 24x80 and 40x120 left alone for 31 s after the settle: dynamic frames ≤ 4 per second and ≤ 2/s mean, bytes ≤ 12 KB/s peak and ≤ 5 KB/s mean, 0 clears, region ≤ rows − 2; child CPU reported)…\n');
    idle = await measureIdleFrames({ root, bin, onProgress: progress });
  }
  if (probes.includes('states')) {
    log('perf: zero clears per state and geometry segment (review, palette, picker, wizard, secret row, an unsure reading, render faults, resize idle/live 40→12→40, Ctrl+L)…\n');
    states = await measureStates({ root, bin, onProgress: progress });
  }
  if (probes.includes('scroll-latency')) {
    log('perf: scroll latency (real pty, chat --renderer fullscreen at 40x120 with 20 000 items: scroll key → frame p95 < 16 ms, ≤ 6 KB per scroll frame, a width-change rebuild < 50 ms; skipped with the refusal text when fullscreen is not available)…\n');
    scroll = await measureScrollLatency({ root, bin, onProgress: progress });
  }
  // HARNESS-NEXT-DESIGN §5 Ring 0: opt-in, `partial`, imported lazily so a release run never loads them
  if (probes.includes('sandbox-spawn')) {
    log('perf: the seatbelt wrapper alone (sandbox-exec -f <profile> /bin/sh -c true vs bare; report only, §5 P2b)…\n');
    const { measureSandboxSpawn } = await import('./sandbox-spawn.js');
    sandboxSpawn = await measureSandboxSpawn({ onProgress: progress });
  }
  if (probes.includes('lane-run')) {
    log('perf: one real candidate run, cold spawn vs the persistent runner (§5 P2 — the >= 2x gate wave S1 is judged by)…\n');
    const { measureLaneRun } = await import('./lane-run.js');
    laneRun = await measureLaneRun({ root, onProgress: progress });
  }
  if (flags.live) {
    log('perf: Jev latency (live)…\n');
    const { measureJevLatency } = await import('./jev-latency.js');
    jev = await measureJevLatency(flags, { root, env });
  }
  const loadEnd = loadavg()[0] ?? 0;

  const staticPass = probes.includes('static-append') ? (staticAppend?.pass ?? false) : undefined;
  // laneRun fails the run only when a warm arm was actually measured and missed the >= 2x gate; a pending arm
  // (no src/sandbox/pool.ts yet) and sandbox-spawn are report-only, per §5's probe table
  const gates: boolean[] = [firstFrame?.pass, overhead?.pass, staticPass, lag?.pass, composer?.pass, intake?.pass, idle?.pass, states?.pass, scroll?.pass, laneRun?.pass, stream?.pass].filter((v): v is boolean => v !== undefined);
  const pass = gates.length > 0 && gates.every(Boolean);
  const cpu = cpus();
  const result: PerfResult = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    machine: { cpus: cpu.length, model: cpu[0]?.model ?? 'unknown', memGiB: Math.round(totalmem() / 2 ** 30), os: `darwin ${release()}` },
    load: { atStart: quiet.load, atEnd: loadEnd, waitedMs: quiet.waitedMs, max: LOAD_MAX, quietMax: LOAD_QUIET, quiet: quiet.load <= LOAD_QUIET && loadEnd <= LOAD_QUIET },
    foreignDrivers,
    probes,
    partial,
    firstFrame,
    stepOverhead: overhead,
    staticAppend,
    renderLag: lag,
    composerLatency: composer,
    intakeLatency: intake,
    idleFrames: idle,
    states,
    scrollLatency: scroll,
    jevLatency: jev,
    laneRun,
    sandboxSpawn,
    streamLatency: stream,
    pass,
  };
  mkdirSync(resolve(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2));

  const rows = resultRows(result).map((r) => [r.measurement.replace(/`/g, ''), r.result, r.gate.replace(/`/g, ''), r.status] as const);
  const w = rows.reduce((m, r) => Math.max(m, r[0].length), 0);
  const w1 = rows.reduce((m, r) => Math.max(m, r[1].length), 0);
  for (const r of rows) log(`${r[0].padEnd(w)}  ${r[1].padEnd(w1)}  ${r[2].padEnd(26)} ${r[3]}\n`);
  log(`load average ${quiet.load.toFixed(2)} at start, ${loadEnd.toFixed(2)} at end (limit ${LOAD_MAX}; release number needs ≤ ${LOAD_QUIET} at both ends: ${result.load.quiet ? 'met' : 'NOT met'})\n`);
  log(`written ${out}${partial ? ' (PARTIAL: not a release number)' : ''}\n`);
  if (!partial && !child) log(rewriteReadmePerformance(root, out, result));
  log(`perf: ${pass ? 'all gates pass' : 'GATE FAILURE'}\n`);
  return pass ? 0 : 1;
}
