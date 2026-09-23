/**
 * Composer keystroke → frame latency in a real pty (TUI-DESIGN §18 row 2), driven by `perf/drivers/pty_type.py`
 * through `pty.ts` `typist()` (see there for why the timing probes do not use drive.exp's `sleep`).
 *
 * Every measured key is written at an exact cadence (`send X`, then a pause the driver lands within 0.1 ms while it
 * keeps draining the pty — `drain_for` in the driver); latency = the arrival time of the first frame after the send
 * whose **composer row** ends with the key (`pty.ts` `composerEndsWithKey`, the row above the status line) minus the
 * send time — both from the driver's clock (0.1 ms resolution). Seven series at 24×80 (`chat --mock`; `idle-loop` is round 3's:
 * the idle keys typed while the wordmark's sweep is writing frames, TUI-DESIGN-3 §9):
 *
 *   idle         200 keys, 100 ms apart, the session-start composer (pane closed; round 2: inside the boxed console of
 *                TUI-DESIGN-2 §4.3, whose `│ › … │` row `pty.ts` `composerRow` unwraps) — gated
 *   live         200 keys, 100 ms apart, during a live mocked run at the A109 region: pane 12 + live rows + a composer
 *                at its 6-row cap over a 2,000-char draft (125 unmeasured lowercase 16-letter chunks, delivered like
 *                fast typing; the design's "rows 24: pane 12 + live 2 + queue 2 + composer 6" — no steer is queued, so
 *                the queue rows are not held). The run is paced at the realistic step rate (`JEVCODE_MOCK_STEP_MS=200`,
 *                `render-lag.ts` `REALISTIC_STEP_MS`, about 5 steps/s) and is `--max-replans 100000` so the loop
 *                detector's replans never end it under the typist (the mock trajectory trips it at step 71 otherwise);
 *                it is aborted with Ctrl-C after the keys — gated (latency and dynamic frame rate)
 *   live-stress  the same plan over the zero-latency mock (`JEVCODE_MOCK_STEP_MS=0`, ≈ 35 steps/s, ≈ 460 `<Static>`
 *                rows/s): the storm diagnosis; latency and frame rate reported, hygiene gated
 *   palette      200 keys, 100 ms apart, with the palette open (`/Z…`: no command matches, so no ghost text) — gated
 *   review       200 `e` presses, 100 ms apart, with a review pending (`JEVCODE_MOCK_REVIEW_AT=2`): the composer is
 *                collapsed to one inactive row while a review is pending (D1), so the measured key is the review's own
 *                `e` (expand / collapse the preview, which zeroes / restores the Jev panel, `layout.ts` step 10) and a
 *                key's frame is the first one whose painted rows differ from the screen the key acted on (`pty.ts`
 *                `paintedRowsChanged`; the spinner is off during a review, `src/tui/spinner.ts`, so only the 1 Hz clock
 *                repaints in between and it keeps the layout). Round 2 collapses the panel to a one-row strip by default
 *                (TUI-DESIGN-2 §4.6) and the mock's preview is one line, so `e` would change nothing; the series opens the
 *                panel with `/panel full` right after the run starts, and the toggle then moves the pane rows — gated
 *   burst30      200 keys, 30 ms apart (33 keys/s offered, above maxFps 30): Ink's throttle is `leading: true`, so a
 *                key that lands after the previous 34 ms window renders at once and one inside it waits for the
 *                trailing edge; the latency therefore measures composer + throttle and is reported, not gated (§18);
 *                the frame-rate gate applies to its `dynamic` frames (the `key` frames follow the offered key rate by
 *                design, `pty.ts` `classifyFrame`)
 *
 * Gates (idle, live, palette, review): p95 < 16 ms and max < 50 ms with a frame located for every key; plus zero
 * clears after the first frame, the painted dynamic region never above rows − 2 (`paintedRows`, measured on every
 * frame), at most one cursor hide per frame, every frame ending with `ESC[?25h` where the composer is active (idle,
 * live, live-stress, palette, burst30 — the review series has no cursor while the composer is collapsed and reports
 * the count), and the child exits 0.
 *
 * Frame rate (DESIGN §12: `dynamic` frames per second ≤ maxFps + 1, busiest one-second bucket of the typing window;
 * frames are split into `static` / `key` / `dynamic` as `render-lag.ts` explains): gated where it is exercised — in the
 * `live` series, where frames flow from the run regardless of the key rate, and in any series whose *achieved* key
 * rate exceeds maxFps (burst30; asserted from the measured spacing, never assumed) — and reported for `live-stress`.
 * At 10 keys/s the offered rate cannot exceed maxFps, so idle, palette and review report their rate as not exercised.
 *
 * Declared deviations from §18 (`deviations` in the result): 200 keys per series (the wave-4 brief's count) rather
 * than 500 printable bytes; the review series measures the review's own key, not composer typing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { END_PATTERN, NO_FPS, RUN_STARTED_PATTERN, SGR_GAP, classCounts, classifyFrames, clearsAfter, composerEndsWithKey, composerRowChanged, cursorStats, firstDynamicFrameOffset, frameAt, framesPerSecondByClass, keyLatencies, keystrokeSteps, maxStepSeen, paintedMax, paintedRowsChanged, safeKey, sendTimes, splitFrames, summarise, throttleMs, typist, type FrameClassCounts, type KeyFrameMatcher, type LatencySummary, type TypistStep } from './pty.js';
import { REALISTIC_STEP_MS, STRESS_STEP_MS } from './render-lag.js';

export const MAX_FPS = 30;

/**
 * TUI-DESIGN-4 §11 / contract 1.7 item 11 adds two: `palette-cycle` (200 **Enter** presses over the full command
 * list, gated) and `palette-arg` (200 Enters in S-ARG over `/mode `, reported). Today's gated `palette` series
 * types `/Z…`, i.e. **zero matches and no ghost** — the cheap path; the 41-row + sub-row path had never been gated.
 */
export type ComposerSeriesName = 'idle' | 'idle-loop' | 'live' | 'live-stress' | 'palette' | 'palette-cycle' | 'palette-arg' | 'review' | 'burst30';

export interface ComposerSeries {
  name: ComposerSeriesName;
  rows: number;
  columns: number;
  /** `JEVCODE_MOCK_STEP_MS` of the live run behind the series (null: no run is live) */
  stepMs: number | null;
  /** the zero-latency storm profile: latency and frame rate reported, hygiene gated */
  stress: boolean;
  /** send-to-send spacing requested, in ms */
  spacingMs: number;
  /** mean send-to-send spacing achieved */
  spacingMeasuredMs: number | null;
  /** keys per second achieved (1000 / spacingMeasuredMs) */
  keysPerSecond: number | null;
  keys: number;
  latency: LatencySummary;
  frames: number;
  /** busiest one-second bucket during the typing window (all frames) */
  fpsMax: number | null;
  fpsMean: number | null;
  /** busiest bucket per frame class (`pty.ts` `classifyFrame`) */
  fpsStaticMax: number | null;
  fpsKeyMax: number | null;
  fpsDynamicMax: number | null;
  /** frames of the whole capture per class */
  frameClasses: FrameClassCounts;
  /** the frame-rate gate value (maxFps + 1), applied to `fpsDynamicMax` */
  fpsGate: number;
  /** the offered key rate exceeds maxFps, or frames flow from a live run — the frame-rate check means something here */
  fpsExercised: boolean;
  /** the frame-rate check counts in `pass` (exercised and not the stress series) */
  fpsGated: boolean;
  fpsOk: boolean;
  /** tallest dynamic region painted after the first frame (`pty.ts` `paintedRows`) */
  regionMax: number;
  clears: number;
  cursorHidesMaxPerFrame: number;
  /** frames not ending with `ESC[?25h` */
  cursorFramesWithoutShow: number;
  /** the per-frame cursor rule counts in `pass` (the composer is active throughout the series) */
  cursorGated: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** the run reached at least this step (live and review series) */
  stepSeen: number;
  /** the latency gate applies */
  gated: boolean;
  pass: boolean;
}

export interface ComposerLatencyResult {
  gateP95Ms: number;
  gateMaxMs: number;
  maxFps: number;
  throttleMs: number;
  series: ComposerSeries[];
  /** §18 items this probe knowingly does not do as written */
  deviations: string[];
  pass: boolean;
}

const ROWS = 24;
const COLUMNS = 80;
const FIRST_FRAME: TypistStep = { op: 'expect', pattern: '\\x1b\\[\\?25l', timeoutMs: 20_000 };
/** the round-2 `task` placeholder (TUI-DESIGN-2 §4.4 `Say hi, ask a question, or describe a task…`) */
const PLACEHOLDER: TypistStep = { op: 'expect', pattern: 'Say hi', timeoutMs: 20_000 };
/** the run is live once the status row reads `step <n>/<max>` (`pty.ts` `RUN_STARTED_PATTERN`; the TUI no longer prints the `[run] started` item) */
const RUN_STARTED: TypistStep = { op: 'expect', pattern: RUN_STARTED_PATTERN, timeoutMs: 20_000 };
const FOLLOWUP: TypistStep = { op: 'expect', pattern: 'Follow-up, question', timeoutMs: 20_000 };
/** every mocked run says `--mode jev-on` explicitly: the scripted `--mock` trajectory is a generator trajectory, whatever `DEFAULT_MODE` is (TUI-DESIGN-3 §1.1) */
const MOCK_RUN_MODE = ['--mode', 'jev-on'] as const;
const PROLOGUE: TypistStep[] = [FIRST_FRAME, PLACEHOLDER, { op: 'sleep', ms: 500 }];
/**
 * TUI-DESIGN-3 §3.6 / §9: the wordmark's idle sweep — `splash:done` at 700 ms, a 5,750 ms rest, the first pass from 6,450 ms with
 * its first written band frame at 6,700 ms — so a typist that waits this long after the first frame lands its first key ≈ 200 ms
 * into the first pass, and its 200 keys at 100 ms cover the whole 4 s pass and the rest after it (the `idle-loop` series).
 */
export const IDLE_LOOP_WAIT_MS = 6650;
const START_RUN: TypistStep[] = [{ op: 'send', text: 'start the perf run' }, { op: 'sleep', ms: 200 }, { op: 'send', text: '\r' }];
const EXIT_IDLE: TypistStep[] = [
  { op: 'send', text: '/exit' },
  { op: 'sleep', ms: 200 },
  { op: 'send', text: '\r' },
  { op: 'eof', timeoutMs: 20_000 },
];

interface Plan {
  steps: TypistStep[];
  measured: Set<number>;
  keys: string[];
  /** how a key's frame is recognised */
  matcher: KeyFrameMatcher;
  /** the composer is active for the whole series (per-frame cursor rule gated) */
  composerActive: boolean;
}

function newPlan(steps: TypistStep[], matcher: KeyFrameMatcher = composerEndsWithKey, composerActive = true): Plan {
  return { steps, measured: new Set(), keys: [], matcher, composerActive };
}

/** Append `n` measured keystrokes to `steps`, recording their send-step numbers (the typist numbers steps from 1). */
function typeMeasured(plan: Plan, n: number, spacingMs: number, keyAt: (i: number) => string = safeKey): void {
  for (let i = 0; i < n; i++) {
    const key = keyAt(i);
    plan.measured.add(plan.steps.length + 1);
    plan.keys.push(key);
    plan.steps.push(...keystrokeSteps(key, spacingMs));
  }
}

function planIdle(n: number, spacingMs: number, waitMs?: number): Plan {
  const plan = newPlan(waitMs === undefined ? [...PROLOGUE] : [FIRST_FRAME, PLACEHOLDER, { op: 'sleep', ms: waitMs }]);
  typeMeasured(plan, n, spacingMs);
  // Ctrl-C with a draft clears it (§3.3 S1); then /exit
  plan.steps.push({ op: 'sleep', ms: 300 }, { op: 'send', text: '\x03' }, PLACEHOLDER, ...EXIT_IDLE);
  return plan;
}

function planPalette(n: number, spacingMs: number): Plan {
  const plan = newPlan([...PROLOGUE, { op: 'send', text: '/' }, { op: 'expect', pattern: 'Tab picks', timeoutMs: 20_000 }, { op: 'sleep', ms: 300 }]);
  // the first key is Z: no command name contains it, so the palette shows zero matches and no ghost text for the whole query
  typeMeasured(plan, n, spacingMs, (i) => safeKey(25 - (i % 26)));
  plan.steps.push({ op: 'sleep', ms: 300 }, { op: 'send', text: '\x1b' }, { op: 'sleep', ms: 150 }, { op: 'send', text: '\x03' }, PLACEHOLDER, ...EXIT_IDLE);
  return plan;
}

/**
 * TUI-DESIGN-4 §4.2 / §11: `palette-cycle` — the palette open on the FULL command list (no filter, so every row is
 * a candidate and the footer counts them), then 200 **Enter** presses. Enter walks the list and rewrites the
 * composer row with the selected command (`› /resume +36`), so the frame is matched by the row CHANGING, not by
 * it ending with the key. Gated: p95 < 16 ms, max < 50 ms. `§4.5`'s destructive confirm is never reached — Enter
 * on an accepted destructive command opens a confirm ROW, and Enter on that row does nothing (the theorem).
 */
function planPaletteCycle(n: number, spacingMs: number): Plan {
  const plan = newPlan([...PROLOGUE, { op: 'send', text: '/' }, { op: 'expect', pattern: 'Tab picks', timeoutMs: 20_000 }, { op: 'sleep', ms: 300 }], composerRowChanged);
  typeMeasured(plan, n, spacingMs, () => '\r');
  plan.steps.push({ op: 'sleep', ms: 300 }, { op: 'send', text: '\x1b' }, { op: 'sleep', ms: 150 }, { op: 'send', text: '\x03' }, PLACEHOLDER, ...EXIT_IDLE);
  return plan;
}

/**
 * TUI-DESIGN-4 §4.2 / §11: `palette-arg` — the same Enter cycle one level deeper, in S-ARG over `/mode `, where
 * each press walks the VALUE list. Reported, not gated: the value list is short, so the cycle wraps often and the
 * series exists to show the sub-row path is not slower than the command path.
 */
function planPaletteArg(n: number, spacingMs: number): Plan {
  // The card has to be OPEN for S-ARG to exist, and only the `/` KEY at an empty draft opens it
  // (`keys/resolve.ts` `composer:palette`). One `send '/mode '` is a single input event whose charset includes a
  // SPACE, so §4.7 E9 classifies it as paste-like: it lands as text with no card at all, the Enters then take the
  // ordinary submit path, `/mode` runs once and the remaining 198 presses fall on an empty draft. Measured before
  // this was fixed: 2 of 200 key frames and 18 frames in the whole capture. The three writes below are the
  // sequence a human makes.
  const plan = newPlan(
    [...PROLOGUE, { op: 'send', text: '/' }, { op: 'expect', pattern: 'Tab picks', timeoutMs: 20_000 }, { op: 'send', text: 'mode' }, { op: 'sleep', ms: 200 }, { op: 'send', text: ' ' }, { op: 'sleep', ms: 400 }],
    composerRowChanged,
  );
  typeMeasured(plan, n, spacingMs, () => '\r');
  plan.steps.push({ op: 'sleep', ms: 300 }, { op: 'send', text: '\x1b' }, { op: 'sleep', ms: 150 }, { op: 'send', text: '\x03' }, PLACEHOLDER, ...EXIT_IDLE);
  return plan;
}

/**
 * Pre-fill the composer with a 2,000-char draft (§18: "over a 2,000-char draft") in unmeasured 16-letter chunks 20 ms
 * apart, the way a terminal delivers fast typing. Lowercase, disjoint from `SAFE_KEYS`, so no pre-filled row can end
 * with a measured key even before the composer-row pairing is applied.
 */
export const PREFILL_CHUNKS = 125;
export const PREFILL_CHUNK = 'abcdefghijklmnop';

function planLive(n: number, spacingMs: number): Plan {
  const plan = newPlan([...PROLOGUE, ...START_RUN, RUN_STARTED, { op: 'sleep', ms: 300 }]);
  for (let i = 0; i < PREFILL_CHUNKS; i++) plan.steps.push({ op: 'send', text: PREFILL_CHUNK }, { op: 'sleep', ms: 20 });
  plan.steps.push({ op: 'sleep', ms: 300 });
  typeMeasured(plan, n, spacingMs);
  // Ctrl-C with a draft clears it; Ctrl-C on the empty live composer aborts the run (§3.3 S2); then /exit
  plan.steps.push({ op: 'sleep', ms: 300 }, { op: 'send', text: '\x03' }, { op: 'sleep', ms: 300 }, { op: 'send', text: '\x03' }, { op: 'expect', pattern: END_PATTERN, timeoutMs: 30_000 }, FOLLOWUP, ...EXIT_IDLE);
  return plan;
}

function planReview(n: number, spacingMs: number): Plan {
  // the §6 card appears when the mock decider sends step 2 to review; `e` toggles the preview expansion (App.tsx `review:expand`),
  // which zeroes the pane while expanded — so the panel is opened to its full form first (TUI-DESIGN-2 §4.6; `/panel` is `any`)
  const plan = newPlan([...PROLOGUE, ...START_RUN, RUN_STARTED, { op: 'send', text: '/panel full' }, { op: 'sleep', ms: 150 }, { op: 'send', text: '\r' }, { op: 'expect', pattern: `▾${SGR_GAP} decisions`, timeoutMs: 20_000 }, { op: 'expect', pattern: '\\[y\\] approve', timeoutMs: 20_000 }, { op: 'sleep', ms: 600 }], paintedRowsChanged, false);
  typeMeasured(plan, n, spacingMs, () => 'e');
  // approve: the run finishes its remaining mocked steps, then /exit
  plan.steps.push({ op: 'sleep', ms: 300 }, { op: 'send', text: 'y' }, { op: 'expect', pattern: 'review approved', timeoutMs: 20_000 }, { op: 'expect', pattern: END_PATTERN, timeoutMs: 30_000 }, FOLLOWUP, ...EXIT_IDLE);
  return plan;
}

interface SeriesSpec {
  name: ComposerSeriesName;
  plan: Plan;
  spacingMs: number;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  /** a live run is behind the series, paced at this `JEVCODE_MOCK_STEP_MS` */
  stepMs: number | null;
  /** the zero-latency storm: latency and frame rate reported only */
  stress: boolean;
  /** the latency gate applies */
  gated: boolean;
}

async function runSeries(root: string, bin: string, spec: SeriesSpec, gate: { p95: number; max: number }): Promise<ComposerSeries> {
  const home = mkdtempSync(join(tmpdir(), 'jevcode-perf-home-'));
  const ws = mkdtempSync(join(tmpdir(), 'jevcode-perf-ws-'));
  const { name, plan, spacingMs, gated, stepMs, stress } = spec;
  try {
    const r = await typist({
      root,
      rows: ROWS,
      columns: COLUMNS,
      steps: plan.steps,
      command: [process.execPath, bin, 'chat', ...(spec.stepMs !== null || spec.name === 'review' ? MOCK_RUN_MODE : []), '--mock', '--source', 'perf', '--workspace', ws, ...spec.args],
      env: { JEVCODE_HOME: home, NODE_ENV: 'production', ...(stepMs !== null ? { JEVCODE_MOCK_STEP_MS: String(stepMs) } : {}), ...spec.env },
      wallMs: 300_000,
      label: `composer-${name}`,
    });
    const { frames } = splitFrames(r.capture);
    const lat = keyLatencies(r.timing, frames, r.chunks, plan.measured, plan.matcher);
    const latency = summarise(lat.map((l) => l.ms));
    const firstDyn = firstDynamicFrameOffset(r.capture);
    const firstIdx = Math.max(0, frameAt(frames, firstDyn));
    const regionMax = paintedMax(frames, firstIdx + 1);
    const first = lat[0];
    const last = lat[lat.length - 1];
    const throttle = throttleMs(MAX_FPS);
    const classes = classifyFrames(frames, r.chunks, sendTimes(r.timing), throttle);
    const window = first && last ? { from: first.sentAt, to: last.frameAt } : null;
    const fps = window ? framesPerSecondByClass(frames, r.chunks, classes, window.from, window.to) : { all: NO_FPS, static: NO_FPS, key: NO_FPS, dynamic: NO_FPS };
    const spacing = first && last && lat.length > 1 ? (last.sentAt - first.sentAt) / (lat.length - 1) : null;
    const keysPerSecond = spacing !== null && spacing > 0 ? 1000 / spacing : null;
    const clears = clearsAfter(r.capture, firstDyn);
    const cursor = cursorStats(frames, r.capture);
    const complete = latency.samples === plan.keys.length;
    const inBudget = latency.p95 !== null && latency.p95 < gate.p95 && latency.max !== null && latency.max < gate.max;
    const fpsGate = MAX_FPS + 1;
    // the check means something only where frames can exceed maxFps: a live run, or an offered key rate above maxFps
    const fpsExercised = stepMs !== null || (keysPerSecond !== null && keysPerSecond > MAX_FPS);
    const fpsGated = fpsExercised && !stress;
    const fpsOk = fps.dynamic.max === null || fps.dynamic.max <= fpsGate;
    const cursorOk = cursor.hidesMaxPerFrame <= 1 && cursor.shownAtEnd && (!plan.composerActive || cursor.framesWithoutShow === 0);
    const hygiene = clears === 0 && regionMax <= ROWS - 2 && r.code === 0 && !r.timedOut && cursorOk && (!fpsGated || fpsOk);
    return {
      name,
      rows: ROWS,
      columns: COLUMNS,
      stepMs,
      stress,
      spacingMs,
      spacingMeasuredMs: spacing,
      keysPerSecond,
      keys: plan.keys.length,
      latency,
      frames: frames.length,
      fpsMax: fps.all.max,
      fpsMean: fps.all.mean,
      fpsStaticMax: fps.static.max,
      fpsKeyMax: fps.key.max,
      fpsDynamicMax: fps.dynamic.max,
      frameClasses: classCounts(classes),
      fpsGate,
      fpsExercised,
      fpsGated,
      fpsOk,
      regionMax,
      clears,
      cursorHidesMaxPerFrame: cursor.hidesMaxPerFrame,
      cursorFramesWithoutShow: cursor.framesWithoutShow,
      cursorGated: plan.composerActive,
      exitCode: r.code,
      timedOut: r.timedOut,
      stepSeen: maxStepSeen(r.capture),
      gated,
      pass: gated ? complete && inBudget && hygiene : complete && hygiene,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
}

export const COMPOSER_DEVIATIONS: readonly string[] = [
  '200 keys per series (the wave-4 brief) rather than §18\'s 500 printable bytes; the live draft is the 2,000 chars §18 names',
  'review series: the composer is collapsed to one inactive row while a review is pending (D1), so the measured key is the review\'s `e` toggle and a frame is recognised by its painted-row change, not by the composer row; the per-frame `ESC[?25h` rule is reported there (no cursor while the composer is inactive); round 2 opens the Jev panel with `/panel full` before the review so the toggle has pane rows to zero (the default strip and the one-line mock preview would leave `e` without a visible effect)',
  'the frame-rate gate applies to dynamic frames only and only where it is exercised (a live run at the realistic step rate, or an achieved key rate above maxFps); at 10 keys/s without a run it is reported as not exercised, and the live-stress series reports it',
];

export async function measureComposerLatency(opts: { root: string; bin: string; keys?: number; gateP95Ms?: number; gateMaxMs?: number; stepMs?: number; onProgress?: (line: string) => void }): Promise<ComposerLatencyResult> {
  const n = opts.keys ?? 200;
  const gate = { p95: opts.gateP95Ms ?? 16, max: opts.gateMaxMs ?? 50 };
  const realisticStepMs = opts.stepMs ?? REALISTIC_STEP_MS;
  const series: ComposerSeries[] = [];
  const report = (s: ComposerSeries): void => {
    series.push(s);
    const fpsNote = s.fpsGated ? ` (dynamic ≤ ${s.fpsGate}${s.fpsOk ? '' : ' EXCEEDED'})` : s.fpsExercised ? ' (report)' : ' (not exercised)';
    const cursorNote = `cursor hides ≤ ${s.cursorHidesMaxPerFrame}, ${s.cursorFramesWithoutShow} frames without show${s.cursorGated ? '' : ' (report)'}`;
    opts.onProgress?.(`composer ${s.name}${s.stepMs !== null ? ` (step ${s.stepMs} ms)` : ''}: ${s.latency.samples}/${s.keys} keys, p50 ${s.latency.p50?.toFixed(1)} ms, p95 ${s.latency.p95?.toFixed(1)} ms, max ${s.latency.max?.toFixed(1)} ms${s.gated ? '' : ' (report)'}, spacing ${s.spacingMeasuredMs?.toFixed(1)} ms (${s.keysPerSecond?.toFixed(1)} keys/s), frames ${s.frames}, fps max ${s.fpsMax?.toFixed(0)} mean ${s.fpsMean?.toFixed(1)} (static ${s.fpsStaticMax?.toFixed(0)}, key ${s.fpsKeyMax?.toFixed(0)}, dynamic ${s.fpsDynamicMax?.toFixed(0)})${fpsNote}, region max ${s.regionMax}, clears ${s.clears}, ${cursorNote}, step ${s.stepSeen}, exit ${s.exitCode}${s.timedOut ? ' TIMEOUT' : ''} → ${s.pass ? 'pass' : 'FAIL'}`);
  };
  const live = ['--mock-steps', '3000', '--max-steps', '3000', '--max-replans', '100000'];
  report(await runSeries(opts.root, opts.bin, { name: 'idle', plan: planIdle(n, 100), spacingMs: 100, args: [], env: {}, stepMs: null, stress: false, gated: true }, gate));
  // TUI-DESIGN-3 §9: the same 200 keys typed while the wordmark's idle sweep is running (the first key 200 ms into the first pass)
  report(await runSeries(opts.root, opts.bin, { name: 'idle-loop', plan: planIdle(n, 100, IDLE_LOOP_WAIT_MS), spacingMs: 100, args: [], env: {}, stepMs: null, stress: false, gated: true }, gate));
  // a long mocked run that stays live through the 2.5 s pre-fill and 200 spaced keys (≈ 25 s; 3000 steps is ample at either pace)
  report(await runSeries(opts.root, opts.bin, { name: 'live', plan: planLive(n, 100), spacingMs: 100, args: live, env: {}, stepMs: realisticStepMs, stress: false, gated: true }, gate));
  report(await runSeries(opts.root, opts.bin, { name: 'live-stress', plan: planLive(n, 100), spacingMs: 100, args: live, env: {}, stepMs: STRESS_STEP_MS, stress: true, gated: false }, gate));
  report(await runSeries(opts.root, opts.bin, { name: 'palette', plan: planPalette(n, 100), spacingMs: 100, args: [], env: {}, stepMs: null, stress: false, gated: true }, gate));
  // TUI-DESIGN-4 §11: the two Enter-cycle series — the 41-row path (gated) and the S-ARG sub-row path (reported)
  report(await runSeries(opts.root, opts.bin, { name: 'palette-cycle', plan: planPaletteCycle(n, 100), spacingMs: 100, args: [], env: {}, stepMs: null, stress: false, gated: true }, gate));
  report(await runSeries(opts.root, opts.bin, { name: 'palette-arg', plan: planPaletteArg(n, 100), spacingMs: 100, args: [], env: {}, stepMs: null, stress: false, gated: false }, gate));
  report(await runSeries(opts.root, opts.bin, { name: 'review', plan: planReview(n, 100), spacingMs: 100, args: ['--mock-steps', '5'], env: { JEVCODE_MOCK_REVIEW_AT: '2', JEVCODE_AUTONOMY: 'review' }, stepMs: null, stress: false, gated: true }, gate));
  report(await runSeries(opts.root, opts.bin, { name: 'burst30', plan: planIdle(n, 30), spacingMs: 30, args: [], env: {}, stepMs: null, stress: false, gated: false }, gate));
  return { gateP95Ms: gate.p95, gateMaxMs: gate.max, maxFps: MAX_FPS, throttleMs: throttleMs(MAX_FPS), series, deviations: [...COMPOSER_DEVIATIONS], pass: series.every((s) => s.pass) };
}
