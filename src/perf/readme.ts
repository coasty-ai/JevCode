/**
 * The README "Performance" section, generated from a `PerfResult` (`jevcode perf` rewrites it after every complete
 * run, so the table can never drift from `perf/results/latest.json`). `resultRows()` is also the console table of
 * `jevcode perf`: one row model, two renderings. Every sentence below is computed from the result or names the
 * source line it was verified against; nothing is hand-maintained between runs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { PerfResult } from './main.js';
import { LAG_MAX_MS, LAG_P95_MS, describeGeometry, type LagGeometry } from './render-lag.js';

export interface Row {
  measurement: string;
  result: string;
  gate: string;
  status: string;
}

const ms = (v: number | null | undefined, digits = 1): string => (v == null || !Number.isFinite(v) ? '–' : `${v.toFixed(digits)} ms`);
const n0 = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(0));
const n1 = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(1));
const pf = (ok: boolean): string => (ok ? 'pass' : 'FAIL');

/** The named gates that failed in this result (empty when everything passed). */
export function failures(r: PerfResult): string[] {
  const out: string[] = [];
  if (r.firstFrame && !r.firstFrame.pass) out.push('first frame');
  if (r.stepOverhead && !r.stepOverhead.pass) out.push('harness overhead');
  if (r.staticAppend && !r.staticAppend.pass) out.push('Static append region budget');
  if (r.renderLag) {
    for (const g of [r.renderLag.rows40, r.renderLag.rows12, r.renderLag.rows40Reduced, r.renderLag.stress]) {
      const where = describeGeometry(g);
      if (g.gated && !g.lagOk) out.push(`event-loop lag (${where})`);
      if (g.gated && !g.fpsOk) out.push(`dynamic frame rate (${where})`);
      if (!g.hygieneOk) out.push(`render-lag hygiene (${where})`);
    }
    if (!r.renderLag.clearReSelfTest) out.push('CLEAR_RE self-test');
  }
  if (r.composerLatency) {
    for (const s of r.composerLatency.series) {
      if (s.pass) continue;
      const why: string[] = [];
      if (s.latency.samples !== s.keys) why.push('keys not located');
      if (s.gated && (s.latency.p95 === null || s.latency.p95 >= r.composerLatency.gateP95Ms || s.latency.max === null || s.latency.max >= r.composerLatency.gateMaxMs)) why.push('latency');
      if (s.fpsGated && !s.fpsOk) why.push('dynamic frame rate');
      if (s.clears > 0 || s.regionMax > s.rows - 2 || s.exitCode !== 0 || s.timedOut || s.cursorHidesMaxPerFrame > 1 || (s.cursorGated && s.cursorFramesWithoutShow > 0)) why.push('hygiene');
      out.push(`composer ${s.name} (${why.join(', ') || 'see result'})`);
    }
  }
  if (r.states) for (const s of r.states.scenarios) if (!s.pass) out.push(`state ${s.name} ${s.rows}×${s.columns}`);
  return out;
}

/** the three gated (realistic-rate) geometries, in the order the rows show them */
function realistic(r: PerfResult): LagGeometry[] {
  const l = r.renderLag!;
  return [l.rows40, l.rows12, l.rows40Reduced];
}

function lagTriple(r: PerfResult, f: (g: LagGeometry) => string): string {
  return realistic(r)
    .map((g) => f(g))
    .join(' / ');
}

/** the four render-lag runs (three realistic + stress) */
function lagQuad(r: PerfResult, f: (g: LagGeometry) => string): string {
  return `${lagTriple(r, f)} / ${f(r.renderLag!.stress)}`;
}

const TRIPLE = 'rows 40 / rows 12 / rows 40 reduced motion';
const QUAD = `${TRIPLE} / stress`;

/** The measurement table (README and console share it). */
export function resultRows(r: PerfResult): Row[] {
  const rows: Row[] = [];
  const ff = r.firstFrame;
  if (ff) {
    for (const s of ff.series) rows.push({ measurement: `First frame \`${s.command}\` ${s.rows}×${s.columns}, cold compile cache: p95 / median over ${s.cold.runs.length} runs (warm median)`, result: `${ms(s.cold.p95)} / ${ms(s.cold.median)} (${ms(s.warm.median)})`, gate: `< ${ff.gateMs} ms`, status: pf(s.pass) });
    for (const b of ff.breakdown) rows.push({ measurement: `First frame \`${b.command}\` ${b.rows}×${b.columns} breakdown, child clock: bare \`node -e ''\` → \`render()\` returned → frame flushed (harness spawn → sentinel)`, result: `${ms(b.bareNodeMs)} → ${ms(b.mountedMs)} → ${ms(b.flushedMs)} (${ms(b.harnessMs)})`, gate: 'report', status: '' });
  }
  const so = r.stepOverhead;
  if (so) {
    rows.push({ measurement: `Harness overhead per step, p95 / p50 (mocked zero-latency run, ${so.steps} steps, 5,000-file git fixture + 5,000 ignored files, ${so.dirtyFiles} dirty files / ${Math.round(so.dirtyBytes / 2 ** 20)} MiB copied at every \`run\` step)`, result: `${ms(so.p95)} / ${ms(so.p50)}`, gate: `< ${so.gateMs} ms`, status: pf(so.p95 !== null && so.p95 < so.gateMs) });
    rows.push({ measurement: `Harness overhead of the \`run\` steps alone, p95 / p50 (${so.harnessRun.length} steps; they copy the pre-image and carry the p95 above) · every other step p95`, result: `${ms(so.harnessRunP95)} / ${ms(so.harnessRunP50)} · ${ms(so.harnessOtherP95)}`, gate: `report (margin under ${so.gateMs} ms)`, status: so.harnessRunP95 === null ? '–' : `${(so.gateMs - so.harnessRunP95).toFixed(1)} ms margin` });
    rows.push({ measurement: '`imagesMs` p95 / p50 over steps with images · `run`-step p95 (the 15 MiB dirty-set copy)', result: `${ms(so.imagesP95)} / ${ms(so.imagesP50)} · ${ms(so.imagesRunP95)}`, gate: `report only, not a gate (§18 target < ${so.imagesTargetMs} ms; the copy is inside \`harnessMs\`, which is gated)`, status: so.imagesWithinTarget ? 'within target' : 'above target (reported)' });
    rows.push({ measurement: `60 MiB \`run\` artefact: post image written with \`hashSkipped: true\`, nothing hashed (step ${so.artefactStep})`, result: String(so.hashSkipped), gate: 'true', status: pf(so.hashSkipped === true) });
  }
  if (r.staticAppend) for (const g of r.staticAppend.regions) rows.push({ measurement: `Static append, bytes per committed line — the append frame, median / mean (\`${g.name}\`, ${g.regionRows}-row region at ${g.rows}×${g.columns})`, result: `${n0(g.appendFrameMedian)} / ${n0(g.appendFrameMean)} B`, gate: 'report', status: g.regionRows <= g.rows - 2 ? 'in budget' : 'OVER' });
  const lag = r.renderLag;
  if (lag) {
    const geos = realistic(r);
    const st = lag.stress;
    const all = [...geos, st];
    const rate = `\`JEVCODE_MOCK_STEP_MS=${lag.realisticStepMs}\``;
    const bl = lag.baseline;
    rows.push({ measurement: `Event-loop lag while typing 10 keys/s during a live mocked run at the realistic step rate (${rate}, about 5 steps/s), p95 net of the probe's idle floor (raw p95 in parentheses; ${TRIPLE}; 120 columns)`, result: lagTriple(r, (g) => `${ms(g.lagNetP95, 2)} (${ms(g.lagP95, 2)})`), gate: `< ${LAG_P95_MS} ms ${bl.ok ? 'net' : 'raw (floor unusable)'}`, status: pf(geos.every((g) => g.lagNetP95 !== null && g.lagNetP95 < LAG_P95_MS)) });
    rows.push({ measurement: `Lag probe idle floor, measured in this run — the same 10 ms \`setInterval\` probe in a bare idle \`node\` process for ${bl.seconds} s: p50 / p95 / max (macOS coalesces the kevent timeout libuv waits with; the p50 is what the row above subtracts)`, result: `${ms(bl.p50, 2)} / ${ms(bl.p95, 2)} / ${ms(bl.max, 2)}`, gate: `report (calibration; applies while the floor p95 is < ${LAG_P95_MS} ms)`, status: bl.ok ? 'applied' : 'NOT applied (floor ≥ gate: raw p95 gated)' });
    rows.push({ measurement: `Event-loop lag, max, raw (${TRIPLE})`, result: lagTriple(r, (g) => ms(g.lagMax, 2)), gate: `< ${LAG_MAX_MS} ms`, status: pf(geos.every((g) => g.lagMax !== null && g.lagMax < LAG_MAX_MS)) });
    rows.push({ measurement: `Mocked run rate under the typist: steps per second · \`<Static>\` rows committed per second over the typing window (${TRIPLE})`, result: lagTriple(r, (g) => `${n1(g.stepsPerSecond)} · ${n0(g.staticRowsPerSecond)}`), gate: 'report (the load profile the gates apply to; a real run commits a few rows per second)', status: '' });
    rows.push({ measurement: `Frames per second while typing, busiest one-second bucket, split into \`static\` · \`key\` · \`dynamic\` (${TRIPLE}): \`static\` frames carry new \`<Static>\` rows and are rendered immediately by Ink, unthrottled (\`reconciler.js\` \`isStaticDirty\` → \`onImmediateRender\`), so their rate is the item commit rate by design; \`key\` frames arrive within one throttle period (${lag.throttleMs} ms) of a keystroke — the leading-edge render, which follows the offered key rate by design; \`dynamic\` is the rest, the frames the \`maxFps\` throttle governs`, result: lagTriple(r, (g) => `${n0(g.fpsStaticMax)} · ${n0(g.fpsKeyMax)} · ${n0(g.fpsDynamicMax)}`), gate: `\`dynamic\` ≤ maxFps + 1 = ${lag.maxFps + 1} (every geometry, reduced motion included); \`static\` and \`key\` reported`, status: pf(geos.every((g) => g.fpsOk)) });
    rows.push({ measurement: `Stress row — the same run at \`JEVCODE_MOCK_STEP_MS=0\` (rows 40; ${n1(st.stepsPerSecond)} steps/s, ${n0(st.staticRowsPerSecond)} \`<Static>\` rows/s, 50–100× any real run): lag p95 net (raw) / max · frames \`static\` · \`key\` · \`dynamic\``, result: `${ms(st.lagNetP95, 2)} (${ms(st.lagP95, 2)}) / ${ms(st.lagMax, 2)} · ${n0(st.fpsStaticMax)} · ${n0(st.fpsKeyMax)} · ${n0(st.fpsDynamicMax)}`, gate: 'report (lag and frame rate not gated under the storm; hygiene below is)', status: st.lagOk && st.fpsOk ? 'within the realistic-rate gates' : 'over the realistic-rate gates (expected)' });
    rows.push({ measurement: `Terminal clears after the first frame during the live run (${QUAD})`, result: lagQuad(r, (g) => String(g.clears)), gate: '0', status: pf(all.every((g) => g.clears === 0)) });
    rows.push({ measurement: `Dynamic region, tallest painted (${QUAD})`, result: lagQuad(r, (g) => `${g.regionMax} rows`), gate: '≤ rows − 2', status: pf(all.every((g) => g.regionMax <= g.rows - 2)) });
    rows.push({ measurement: `Cursor hides per frame, max · frames not ending with \`ESC[?25h\` · cursor shown at exit (${QUAD})`, result: lagQuad(r, (g) => `${g.cursorHidesMaxPerFrame} · ${g.cursorFramesWithoutShow} · ${String(g.cursorShownAtEnd)}`), gate: '≤ 1 · 0 · true', status: pf(all.every((g) => g.cursorHidesMaxPerFrame <= 1 && g.cursorFramesWithoutShow === 0 && g.cursorShownAtEnd)) });
    rows.push({ measurement: '`CLEAR_RE` self-test (matches `ESC[2J`, `ESC[3J`, `ESC c`, `ESC[?1049h`; not `ESC[2K`)', result: String(lag.clearReSelfTest), gate: 'true', status: pf(lag.clearReSelfTest) });
  }
  const comp = r.composerLatency;
  if (comp) {
    for (const s of comp.series) {
      const what = s.name === 'review' ? `${s.latency.samples}/${s.keys} \`e\` toggles located` : `${s.latency.samples}/${s.keys} keys located`;
      const run = s.stepMs !== null ? `, live run at \`JEVCODE_MOCK_STEP_MS=${s.stepMs}\`` : '';
      const gate = s.gated ? `p95 < ${comp.gateP95Ms} ms, max < ${comp.gateMaxMs} ms` : s.stress ? 'latency report only (the zero-latency storm); hygiene gated' : `latency report only (§18: a key inside Ink's ${comp.throttleMs} ms throttle window waits for the trailing edge); \`dynamic\` frame rate ≤ ${s.fpsGate} gated`;
      rows.push({ measurement: `Composer keystroke → frame, p50 / p95 / max (\`${s.name}\`: ${what}, ${s.spacingMs} ms apart → ${n1(s.keysPerSecond)} keys/s achieved, ${s.rows}×${s.columns}${run})`, result: `${ms(s.latency.p50)} / ${ms(s.latency.p95)} / ${ms(s.latency.max)}`, gate, status: pf(s.pass) });
    }
    const names = comp.series.map((s) => `\`${s.name}\``).join(' · ');
    rows.push({ measurement: `Frames per second while typing, busiest bucket, \`static\` · \`key\` · \`dynamic\` (${names}; "n/e" = not exercised: neither a live run nor more than ${comp.maxFps} keys/s offered; "report" = the stress series)`, result: comp.series.map((s) => `${n0(s.fpsStaticMax)} · ${n0(s.fpsKeyMax)} · ${n0(s.fpsDynamicMax)}${s.fpsGated ? '' : s.fpsExercised ? ' (report)' : ' n/e'}`).join(' / '), gate: `\`dynamic\` ≤ maxFps + 1 = ${comp.maxFps + 1} where exercised (\`live\`, \`burst30\`); \`static\` and \`key\` reported`, status: pf(comp.series.every((s) => !s.fpsGated || s.fpsOk)) });
    rows.push({ measurement: `Composer series hygiene: clears after the first frame · tallest painted region · frames not ending with \`ESC[?25h\` (${names}; the review series has no cursor while the composer is collapsed, reported only)`, result: comp.series.map((s) => `${s.clears} · ${s.regionMax} · ${s.cursorFramesWithoutShow}${s.cursorGated ? '' : ' (report)'}`).join(' / '), gate: `0 · ≤ ${comp.series[0] ? comp.series[0].rows - 2 : '–'} · 0 where the composer is active`, status: pf(comp.series.every((s) => s.clears === 0 && s.regionMax <= s.rows - 2 && (!s.cursorGated || s.cursorFramesWithoutShow === 0))) });
  }
  const st = r.states;
  if (st) {
    const clears = st.scenarios.reduce((n, s) => n + s.clearsTotal, 0);
    const shrinks = st.scenarios.reduce((n, s) => n + s.segments.filter((g) => g.allowed > 0).reduce((m, g) => m + g.clears, 0), 0);
    const forbidden = st.scenarios.reduce((n, s) => n + s.forbidden, 0);
    rows.push({ measurement: `Zero clears per state and geometry segment across ${st.scenarios.length} pty scenarios (review, palette, wizard, secret row at 24×80 and 12×60; picker; \`render:composer\` / \`render:pane\` faults; Ctrl+L; three resize sequences): clear events total · in shrink segments · \`ESC c\` + alt-screen`, result: `${clears} · ${shrinks} · ${forbidden}`, gate: '0 outside shrink segments, ≤ 1 per shrink; never `ESC c` / `ESC[?1049h`', status: pf(st.pass) });
    for (const s of st.scenarios.filter((x) => x.name.startsWith('resize'))) rows.push({ measurement: `\`${s.name}\` ${s.rows}×${s.columns} (${s.driver}): clear events per segment (allowed) · stale paints at or after the TUI's reaction to a shrink · frames in flight at the shrink (ms after the ioctl) · dynamic rows painted by the clear frame`, result: `${s.segments.map((g) => `${g.clears} (${g.allowed})`).join(' · ')} · ${s.segments.reduce((n, g) => n + g.stalePaints, 0)} · ${s.segments.reduce((n, g) => n + g.inFlightPaints, 0)}${(() => { const t = s.segments.map((g) => g.inFlightMs).filter((v): v is number => v !== null); return t.length ? ` (+${Math.max(...t).toFixed(1)} ms)` : ''; })()} · ${s.segments.map((g) => g.clearFramePainted).filter((v): v is number => v !== null).join('/') || '–'}`, gate: `≤ allowed · 0 · report · ≤ ${12 - 2}`, status: pf(s.pass) });
    const cl = st.scenarios.find((s) => s.name === 'ctrl-l');
    if (cl) rows.push({ measurement: `Ctrl+L repaint (3-row draft, pane open, ${cl.rows}×${cl.columns}): visible frame content equals the frame before it, in one BSU/ESU pair`, result: `${String(cl.repaintEqual)} (${cl.repaintFrames} frame)`, gate: 'true', status: pf(cl.repaintEqual === true) });
    for (const s of st.scenarios.filter((x) => !x.pass && !x.name.startsWith('resize') && x.name !== 'ctrl-l')) rows.push({ measurement: `state \`${s.name}\` ${s.rows}×${s.columns}`, result: `exit ${s.exitCode} (want ${s.expectedExit})${s.timedOut ? ' timeout' : ''}; clears ${s.segments.map((g) => `${g.clears}/${g.allowed}`).join(' ')}`, gate: '', status: 'FAIL' });
  }
  if (r.jevLatency) rows.push({ measurement: 'Jev latency p50 / p95 (live)', result: `${ms(r.jevLatency.p50)} / ${ms(r.jevLatency.p95)}`, gate: 'report', status: '' });
  return rows;
}

const cell = (s: string): string => s.replace(/\|/g, '\\|');

/** The whole `## Performance` section (heading included, no trailing heading of the next section). */
export function performanceSection(r: PerfResult): string {
  const rows = resultRows(r);
  const m = r.machine;
  const ld = r.load;
  const fails = failures(r);
  const lag = r.renderLag;
  const comp = r.composerLatency;
  const so = r.stepOverhead;
  const st = r.states;
  const ff = r.firstFrame;
  const lines: string[] = [
    '## Performance',
    '',
    'Budgets (docs/DESIGN.md §12, docs/TUI-DESIGN.md §18): first frame under 300 ms with zero network at launch, for both',
    'entry points and every geometry; harness overhead under 50 ms per step with pre/post images; rendering never blocks the',
    'loop (event-loop lag p95 < 5 ms net of the probe\'s idle floor, max < 50 ms while typing during a live mocked run at a realistic step rate —',
    '`JEVCODE_MOCK_STEP_MS=200`, about 5 steps/s, still ten times faster than a real run; the zero-latency storm is measured',
    'as a stress row and reported); composer keystroke → frame p95 < 16 ms in a real pty; zero terminal clears outside a',
    'shrink segment; `dynamic` frames per second ≤ `maxFps` + 1 (frames carrying new `<Static>` rows and the leading-edge',
    'frame of a keystroke are counted separately: Ink renders both outside its throttle by design). `npm run perf` measures',
    'all of it, writes `perf/results/latest.json` (raw values, per-series arrays, machine and load), rewrites this section',
    'from that file (`src/perf/readme.ts`; the table cannot drift from the JSON) and exits 1 when any gate fails.',
    '`JEVCODE_PERF_KEEP=<dir>` keeps every pty capture and timing file; `JEVCODE_PERF_ONLY=<probe,…>` runs a subset (written',
    'as `partial`, never a release number, and never written into this section).',
    '',
    '| Measurement | Result | Gate | Status |',
    '| --- | --- | --- | --- |',
    ...rows.map((x) => `| ${cell(x.measurement)} | ${cell(x.result)} | ${cell(x.gate)} | ${cell(x.status)} |`),
    '',
    `Measured ${r.measuredAt.slice(0, 10)} (${r.measuredAt.slice(11, 16)}Z) on an Apple Silicon Mac (${m.cpus} cores, ${m.memGiB} GB, ${m.model}), Node ${r.node.replace(/^v/, '')},`,
    `${m.os}; 1-minute load average ${ld.atStart.toFixed(2)} at the start and ${ld.atEnd.toFixed(2)} at the end of the run (the suite waits while it is above ${ld.max};`,
    `a release number needs ≤ ${ld.quietMax} at both ends — ${ld.quiet ? 'met' : 'NOT met'} here)${r.foreignDrivers.length > 0 ? `; ${r.foreignDrivers.length} other pty driver process${r.foreignDrivers.length === 1 ? '' : 'es'} (other agents' \`drive.exp\` / \`pty_type.py\` smokes) ${r.foreignDrivers.length === 1 ? 'was' : 'were'} alive at the start, listed under \`foreignDrivers\` in the JSON` : '; no other pty driver process was alive at the start'}. Result of the run: **${fails.length === 0 ? 'all gates pass' : `${fails.length} gate${fails.length === 1 ? '' : 's'} fail: ${fails.join('; ')}`}**.`,
    'Raw values in `perf/results/latest.json`.',
    '',
    'How it is measured:',
    '',
  ];
  let n = 0;
  const note = (text: string[]): void => {
    n += 1;
    lines.push(`${n}. ${text[0]}`);
    for (const t of text.slice(1)) lines.push(`   ${t}`);
  };
  if (ff) {
    const bd = ff.breakdown;
    const boot = bd.length ? bd.map((b) => b.bareNodeMs ?? 0).reduce((a, b) => a + b, 0) / bd.length : null;
    const mounted = bd.length ? bd.map((b) => (b.mountedMs ?? 0) - (b.bareNodeMs ?? 0)).reduce((a, b) => a + b, 0) / bd.length : null;
    const flushed = bd.length ? bd.map((b) => (b.flushedMs ?? 0) - (b.mountedMs ?? 0)).reduce((a, b) => a + b, 0) / bd.length : null;
    note([
      'First frame: `script -q /dev/null sh -c \'stty rows R cols C; exec node bin/jevcode.js <run "…"|chat> --config <unreadable>',
      '--perf-exit-after-first-frame\'` with `JEVCODE_ASSERT_NO_NETWORK=1`, a non-existent `JEVCODE_HOME` and `XDG_CONFIG_HOME`;',
      'the time is spawn → the status sentinel `step 0/` in the pty bytes; cold runs use a fresh `NODE_COMPILE_CACHE`. The',
      `breakdown (three traced runs, \`JEVCODE_TRACE\`) splits the child's own clock: about ${n0(boot)} ms of Node boot, about ${n0(mounted)} ms of`,
      `bundle evaluation plus the first synchronous render, about ${n0(flushed)} ms until Ink has flushed the frame.`,
    ]);
  }
  if (lag) {
    const g40 = lag.rows40;
    const g12 = lag.rows12;
    const gr = lag.rows40Reduced;
    const st2 = lag.stress;
    const bl = lag.baseline;
    const lagFail = [g40, g12, gr].filter((g) => !g.lagOk);
    note([
      'Event-loop lag and composer latency run in a real pty through `perf/drivers/pty_type.py`, a `pty.fork` typist that',
      'reads the master continuously and timestamps every chunk (drive.exp\'s `sleep` polls the pty every 25 ms, and a Node',
      'child writes to its TTY synchronously, so the child blocked in `write()`: measured 11 steps in 12 s and lag p50 114 ms',
      'under a drive.exp `sleep` against 399 steps in 11 s and lag p50 1.1 ms with continuous reads). The lag probe is the',
      'child\'s 10 ms `setInterval` (`--perf-lag-probe`), started before `controller.run()` and stopped at exit, so the',
      'distribution covers the whole session after a 500 ms warm-up — about 0.4 s of idle prologue and 1 s of abort/exit tail',
      'around the 15 s of typing; it is not windowed to the keystrokes (the probe emits percentiles only). The gated load',
      `profile is the \`--mock\` run paced by \`JEVCODE_MOCK_STEP_MS=${lag.realisticStepMs}\` (\`src/cli/mock-trajectory.ts\`: every mocked generator turn`,
      `takes that long, the mock decider answers at once): ${n1(g40.stepsPerSecond)} / ${n1(g12.stepsPerSecond)} / ${n1(gr.stepsPerSecond)} mocked steps/s and ${n0(g40.staticRowsPerSecond)} / ${n0(g12.staticRowsPerSecond)} / ${n0(gr.staticRowsPerSecond)} committed`,
      '`<Static>` rows/s at rows 40 / 12 / 40 reduced motion — still ten times faster than a real run, whose steps take 2–10 s.',
      `The probe has a floor: in an idle Node process on macOS the same 10 ms \`setInterval\` reads about 2 ms per tick with nothing`,
      'blocking (the kernel coalesces the kevent timeout libuv waits with, `kern.timer.coalescing_enabled`; a loop kept spinning by a',
      `1 ms interval reads 0.3 ms). A run paced at 5 steps/s idles between steps, so its raw p95 carries the floor; the storm never idles.`,
      `Each run therefore measures the floor first — the identical probe in a bare idle \`node\` for ${bl.seconds} s: p50 ${ms(bl.p50, 2)}, p95 ${ms(bl.p95, 2)}, max ${ms(bl.max, 2)} here —`,
      `and the gate applies to the p95 net of that median${bl.ok ? '' : ' (NOT applied in this run: the floor itself reached the gate, so the raw p95 was gated)'}; raw and net are both in the table. In this run the lag p95 read`,
      `${ms(g40.lagNetP95, 2)} / ${ms(g12.lagNetP95, 2)} / ${ms(gr.lagNetP95, 2)} net (${ms(g40.lagP95, 2)} / ${ms(g12.lagP95, 2)} / ${ms(gr.lagP95, 2)} raw; max ${ms(g40.lagMax, 2)} / ${ms(g12.lagMax, 2)} / ${ms(gr.lagMax, 2)}) — ${lagFail.length === 0 ? 'inside the gate' : `${lagFail.length} of 3 geometries outside the gate`}.`,
      `The stress row repeats rows 40 at \`JEVCODE_MOCK_STEP_MS=0\`: ${n1(st2.stepsPerSecond)} steps/s and ${n0(st2.staticRowsPerSecond)} \`<Static>\` rows/s, 50–100× any real run, where the lag p95 read`,
      `${ms(st2.lagNetP95, 2)} net (${ms(st2.lagP95, 2)} raw; max ${ms(st2.lagMax, 2)}) — reported, not gated: the storm is the diagnosis of what a transcript commit costs, not a budget a real run meets.`,
    ]);
    note([
      'Frame rate: every frame of the typing window is classified (`src/perf/pty.ts` `classifyFrame`). `static` frames carry',
      'new `<Static>` rows — Ink 7.1.1 renders a commit that changed the `<Static>` subtree at once (`ink/build/reconciler.js`',
      '`resetAfterCommit`: `isStaticDirty` → `onImmediateRender`, which `ink.js` binds to the unthrottled `onRender`), so a',
      'committed transcript item costs a frame by design and their rate is the item commit rate. `key` frames arrive within one',
      `throttle period (\`ceil(1000 / maxFps)\` = ${lag.throttleMs} ms) of a keystroke: the leading edge of \`throttle(onRender, …, { leading: true,`,
      'trailing: true })`, which follows the offered key rate by design. `dynamic` is the rest — spinner, 1 Hz clock, live',
      `flush, status-line and pane changes — the frames the \`maxFps\` throttle governs, and the class the gate applies to (≤ ${lag.maxFps + 1}).`,
      `At the realistic rate the busiest one-second bucket held ${n0(g40.fpsStaticMax)} · ${n0(g40.fpsKeyMax)} · ${n0(g40.fpsDynamicMax)} / ${n0(g12.fpsStaticMax)} · ${n0(g12.fpsKeyMax)} · ${n0(g12.fpsDynamicMax)} / ${n0(gr.fpsStaticMax)} · ${n0(gr.fpsKeyMax)} · ${n0(gr.fpsDynamicMax)} static · key · dynamic`,
      `frames at rows 40 / 12 / 40 reduced motion — ${[g40, g12, gr].every((g) => g.fpsOk) ? 'inside the gate' : 'the gate fails'}; under the stress row ${n0(st2.fpsStaticMax)} · ${n0(st2.fpsKeyMax)} · ${n0(st2.fpsDynamicMax)} (reported). Reduced motion is gated`,
      'the same way: its "≤ 4/s" figure in §18 is the 250 ms live-flush cadence, asserted in unit tests, which a live run',
      'cannot separate from the state-change repaints of 5 steps/s. The same split is applied in the composer series (next note).',
    ]);
  }
  if (comp) {
    const burst = comp.series.find((s) => s.name === 'burst30');
    const live = comp.series.find((s) => s.name === 'live');
    const stress = comp.series.find((s) => s.name === 'live-stress');
    note([
      `Composer latency: ${comp.series[0]?.keys ?? 200} uppercase keys per series (the wave-4 brief's count; §18 names 500 printable bytes) at an exact`,
      'cadence (the typist lands each pause within 0.1 ms; a plain 30 ms `select` overshoots to 37 ms on macOS, which an earlier',
      'run mistook for a 30 ms burst). A key\'s frame is the first frame after the send whose **composer row** — the row',
      'directly above the status line — ends with that key; matching the key anywhere in the frame paired 23 of 200 `live`',
      'keys of the 2026-09-21 08:54Z run with a frame that predated them (a wrapped draft row above the cursor row ended with',
      `the same letter). \`live\` is the A109 region (pane 12 + live rows + a composer at its 6-row cap over a 2,000-char draft)`,
      `during a live mocked run at \`JEVCODE_MOCK_STEP_MS=${live?.stepMs ?? '–'}\` (p95 ${ms(live?.latency.p95)}, ${n0(live?.fpsStaticMax)} · ${n0(live?.fpsKeyMax)} · ${n0(live?.fpsDynamicMax)} static · key · dynamic frames/s); \`live-stress\` repeats it over the`,
      `zero-latency mock (p95 ${ms(stress?.latency.p95)}, ${n0(stress?.fpsStaticMax)} · ${n0(stress?.fpsKeyMax)} · ${n0(stress?.fpsDynamicMax)} frames/s) and is reported. \`review\` measures the review's \`e\` toggle (the composer is`,
      `collapsed while a review is pending, so its frame is recognised by the painted-row change, 22 ↔ 11 rows at 24×80).`,
      `\`burst30\` offers ${n1(burst?.keysPerSecond)} keys/s, above \`maxFps\` ${comp.maxFps}: Ink's throttle is \`leading: true\`, so a key landing after the previous ${comp.throttleMs} ms`,
      `window renders at once and one inside it waits for the trailing edge — its latency (p95 ${ms(burst?.latency.p95)}) is reported, not gated, and its`,
      `${n0(burst?.fpsKeyMax)} \`key\` frames/s follow the offered key rate by design; the gate applies to its \`dynamic\` frames (${n0(burst?.fpsDynamicMax)}). At 10 keys/s without a`,
      'live run the frame rate is reported as not exercised.',
    ]);
  }
  if (so) {
    note([
      'Harness overhead: `StepRecord.timing.harnessMs` from `step:end` with the engine in-process (mock provider and decider',
      `at zero latency, no TUI). The fixture holds ${so.dirtyFiles} tracked files modified after the commit (300 KiB each), so every \`run\``,
      `step copies ${Math.round(so.dirtyBytes / 2 ** 20)} MiB of pre-images — the worst case inside the 200-file / 16 MiB cap — which is why \`imagesMs\` p95`,
      `(${ms(so.imagesP95)}) sits ${so.imagesWithinTarget ? 'inside' : 'above'} the ${so.imagesTargetMs} ms target${so.imagesWithinTarget ? '' : ' — a report row, not a gate: the copy is awaited inside `runStep()` (D8), so it is already inside the gated `harnessMs`'} and the \`run\` steps carry the p95 of \`harnessMs\` (${ms(so.harnessRunP95)} against`,
      `${ms(so.p95)} overall; every other step p95 ${ms(so.harnessOtherP95)}). The margin under the gate is ${so.harnessRunP95 === null ? '–' : `${(so.gateMs - so.harnessRunP95).toFixed(1)} ms`} and load-sensitive, which is why a release number requires a 1-minute load ≤ ${ld.quietMax}.`,
    ]);
  }
  if (st) {
    const resize = st.scenarios.filter((s) => s.name.startsWith('resize'));
    const seg = (s: (typeof resize)[number]): string => s.segments.map((g) => `${g.clears}`).join('/');
    const desc = resize.map((s) => `\`${s.name}\` ${seg(s)}`).join(', ');
    const stale = resize.reduce((n2, s) => n2 + s.segments.reduce((m2, g) => m2 + g.stalePaints, 0), 0);
    note([
      `Zero clears: ${st.scenarios.length} scenarios; the resize sequences run through the typist (its \`resize\` record carries the capture byte`,
      'offset, so every frame is held to the budget of the geometry it was painted in), the rest through `scripts/pty/drive.exp`.',
      'Clears are counted as events (Ink\'s `clearTerminal` is `ESC[2J ESC[3J ESC[H`, two regex matches for one clear) with',
      'the §18 regex self-tested first. A shrink segment is allowed one clear (research 20 §1: Ink cannot erase a frame taller',
      `than the new terminal line by line); clear events per segment in this run — ${desc}; frames painted taller than the new`,
      `geometry at or after the TUI's reaction to a shrink (the stale-tree race DESIGN §12 describes): ${stale}; frames already in flight when`,
      `SIGWINCH landed (written after the ioctl, before the TUI's first reaction, still laid out for the old geometry): ${resize.reduce((n2, s) => n2 + s.segments.reduce((m2, g) => m2 + g.inFlightPaints, 0), 0)} — reported, a`,
      'terminal receives them whatever the renderer does. The retry row and blocking panes are not driven:',
      '`JEVCODE_FAULT=jev:429` / `jev:401` / `persist:ENOSPC` are not implemented in this tree (only `render:<pane>` is).',
    ]);
  }
  note(['`renderTime` (Ink\'s `onRender` metric) is not measured: the App registers no `onRender` callback.']);
  const deviations = [...(comp?.deviations ?? []), ...(lag?.deviations ?? [])];
  if (deviations.length > 0) {
    lines.push('', 'Declared deviations from docs/TUI-DESIGN.md §18 (also listed in `perf/results/latest.json`):', '');
    for (const d of deviations) lines.push(`- ${d}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Replace the `## Performance` section (up to the next `## ` heading) of a README; null when the heading is absent. */
export function replacePerformanceSection(readme: string, section: string): string | null {
  const start = readme.indexOf('## Performance\n');
  if (start < 0) return null;
  const rest = readme.indexOf('\n## ', start + 1);
  const end = rest < 0 ? readme.length : rest + 1;
  return `${readme.slice(0, start)}${section}${rest < 0 ? '' : '\n'}${readme.slice(end)}`;
}

/** Rewrite the README's Performance section from `r`; false when the file has no such section. */
export function updateReadmePerformance(path: string, r: PerfResult): boolean {
  const readme = readFileSync(path, 'utf8');
  const next = replacePerformanceSection(readme, performanceSection(r));
  if (next === null) return false;
  if (next !== readme) writeFileSync(path, next);
  return true;
}
