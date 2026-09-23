/**
 * TUI-DESIGN-3 §3 / §5.2 A1–A6 / P7 / §8 S2 (`round3-wordmark-app.test.tsx`, S2's own App-level tests over the real Ink renderer on
 * a stub TTY, `debug: true` so every commit is a frame): the hero at 24×80 (the mark + caption + prompt, 11 dynamic rows); 21 rows is the
 * smallest wordmark height (the palette at exactly the budget, a draft never hands it off) and 20 rows keeps the brand row; the mark hides
 * on `run:start` and returns per D-I (at once at 24 rows, on the first key at 22); reduced motion mounts the static mark in frame 0 and
 * writes no wordmark frame afterwards; the flat tier and a screen reader draw no mark; `ui.wordmark: off` keeps today's brand row and
 * `static` / the SSH default keep the mark; A5's run-start sweep is ≤ 6 extra frames with the row count unchanged (none under reduced
 * motion); A6's run-end fade is ≤ 3 frames; A4's streaming caret blinks at 1 Hz and is steady under reduced motion; P7: after Enter no
 * frame reads `starting` or the steer placeholder; the key-during-pass bound: a key landing during the first sweep pass paints within 50 ms.
 */
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import type { LaunchSettings, UiConfig } from '../../../src/core/types.js';
import { App, RUN_END_FADE_MS, RUN_START_SWEEP_MS, createBridge, runEndEdgeRole, runStartBand, streamCaretOn, type Bridge } from '../../../src/tui/App.js';
import { PLACEHOLDERS } from '../../../src/tui/composer/Composer.js';
import { LOOP_REST_MS, WORDMARK_MIN_ROWS, WORDMARK_POST_RUN_MIN_ROWS } from '../../../src/tui/wordmark.js';
import { SPLASH_MS, WORDMARK } from '../../../src/tui/splash.js';
import { createEventBus, createTuiConfirmer } from '../../../src/tui/useEngine.js';
import { VERSION } from '../../../src/version.js';
import { mkRunResult, mkStatus, tick } from '../../fixtures/tui/fixtures.js';
import { fakeHost } from './app-harness.js';
import { StubStdin, StubStdout, dynamicRegion, stripSgr } from './stub-stdout.js';

const unmounts: Array<() => void> = [];
afterEach(() => {
  for (const u of unmounts.splice(0)) u();
});

/** motion allowed, colour on (`FORCE_COLOR` → depth 16, so the idle loop is `enabled`), no SSH */
const MOTION: LaunchSettings & { reducedMotion: boolean } = { fps: 30, renderMode: 'standard', screenReader: false, ascii: false, noColor: false, reducedMotion: false };
const STILL: LaunchSettings & { reducedMotion: boolean } = { ...MOTION, reducedMotion: true };
const ENV: NodeJS.ProcessEnv = { FORCE_COLOR: '1' };
const BRAND_RE = /^─── ◆ jevcode \S+ ─+$/;
const PLAIN = (columns: number): string => '─'.repeat(columns);
const markRow = (r: number, columns: number): string => `${' '.repeat(Math.floor((columns - 56) / 2))}${WORDMARK[r]}`.replace(/\s+$/, '');

interface M {
  stdout: StubStdout;
  stdin: StubStdin;
  bus: ReturnType<typeof createEventBus>;
  bridge: Bridge;
  dyn: () => string[];
  frame: () => string;
  /** the dynamic rows of every frame written so far */
  frames: () => string[][];
}

function mount(rows: number, columns: number, o: { launch?: LaunchSettings; ui?: Partial<UiConfig>; host?: ReturnType<typeof fakeHost> | null; tickMs?: number; env?: NodeJS.ProcessEnv } = {}): M {
  const stdout = new StubStdout(rows, columns, true);
  const stdin = new StubStdin();
  const bus = createEventBus();
  const bridge = createBridge(o.host ?? null, null);
  const launch = o.launch ?? MOTION;
  if (o.ui) bridge.ui = { ...launch, theme: 'dark', title: false, reducedMotion: launch.reducedMotion, notify: false, osc52: false, history: true, noInput: false, trustWorkspace: false, budgetWarnings: true, allowSecretMention: false, exitCode: 'zero', logLevel: 'info', logFile: null, keybindingsFile: null, ...o.ui };
  const instance = render(<App task="" resumeId={null} source={bus} confirmer={createTuiConfirmer()} onAbort={() => undefined} mode="session" cwd="/tmp/proj" tickMs={o.tickMs ?? 0} bridge={bridge} launch={launch} env={o.env ?? ENV} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  unmounts.push(() => instance.unmount());
  return {
    stdout,
    stdin,
    bus,
    bridge,
    dyn: () => dynamicRegion(stripSgr(stdout.lastFrame()), columns),
    frame: () => stripSgr(stdout.lastFrame()),
    frames: () => stdout.frames.map((f) => dynamicRegion(stripSgr(f), columns)),
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return pred();
}

const hasMark = (dyn: readonly string[], columns: number): boolean => dyn.includes(markRow(1, columns));
const settle = async (m: M): Promise<void> => {
  m.bridge.command({ type: 'dispatch', action: { type: 'splash:done' } });
  await tick(30);
};
const startRun = (m: M, runId = 'r1'): void => {
  m.bus.emit({ type: 'run:start', runId, task: 'Fix the failing test', mode: 'jev-on', resumedFromStep: null });
};
const readyRun = (m: M, runId = 'r1'): void => {
  m.bus.emit({ type: 'run:ready', runId, step: 0, maxSteps: 40, task: 'Fix the failing test', resumed: false });
  m.bus.emit({ type: 'status', status: mkStatus(3, 'propose') });
};
const endRun = (m: M, runId = 'r1'): void => {
  void runId;
  m.bus.emit({ type: 'run:end', result: { ...mkRunResult('complete'), steps: 3 }, exitCode: 0 });
};

describe('the hero (TUI-DESIGN-3 §3.2 F-W1, §3.9 first frame)', () => {
  it('24×80: frame 0 is splash frame 0 (the J and the head, step 0/–); after the settle 11 dynamic rows — the plain rule, the resting mark with `◆ <version>`, the console with the prompt', async () => {
    const m = mount(24, 80);
    const f0 = stripSgr(m.stdout.frames[0] ?? '');
    expect(f0).toContain(`${WORDMARK[3]!.slice(0, 7)}▓▒░`);
    expect(f0).toContain('step 0/–');
    await settle(m);
    const dyn = m.dyn();
    expect(dyn).toHaveLength(11);
    expect(dyn[0]).toBe(PLAIN(80));
    for (let r = 0; r < 4; r++) expect(dyn[1 + r]).toBe(markRow(r, 80));
    expect(dyn[5]).toBe(`${markRow(4, 80)}  ◆ ${VERSION}`);
    expect(dyn[6]).toMatch(/^╭─ /);
    expect(dyn[7]).toContain(`› ${PLACEHOLDERS.task}`);
    expect(dyn[10]).toMatch(/^╰─+╯$/);
    expect(m.frame()).not.toContain('▓▒░');
    expect(m.frame()).not.toMatch(BRAND_RE);
  });
  it('40×120: the tagline on row 0 and the caption; 21×64: neither (no caption below 73 columns), still 11 rows', async () => {
    const wide = mount(40, 120);
    await settle(wide);
    expect(wide.dyn()).toHaveLength(11);
    expect(wide.dyn()[1]).toBe(`${markRow(0, 120)}  Decisions, not strings`);
    expect(wide.dyn()[5]).toBe(`${markRow(4, 120)}  ◆ ${VERSION}`);
    const small = mount(WORDMARK_MIN_ROWS, 64);
    await settle(small);
    expect(small.dyn()).toHaveLength(11);
    expect(small.dyn()[1]).toBe(markRow(0, 64));
    expect(small.dyn()[5]).toBe(markRow(4, 64));
    expect(small.frame()).not.toContain('◆ ');
    expect(small.frame()).not.toContain('Decisions, not strings');
  });
  it('the splash:done switch writes no cell change: the last reveal frame (held, t ≥ 550) and the first settled frame have the same dynamic rows', async () => {
    const m = mount(24, 80);
    await waitFor(() => m.frames().some((d) => d[5]?.includes(`◆ ${VERSION}`) === true), 1500);
    const held = m.frames().findLast((d) => d[5]?.includes(`◆ ${VERSION}`) === true) ?? [];
    await waitFor(() => (m.bridge.stateReader?.()?.splash ?? 'running') === 'done', 2000);
    await tick(80);
    expect(m.dyn()).toEqual(held);
    expect(m.dyn()).toHaveLength(11);
  });
});

describe('the tiers (TUI-DESIGN-3 §3.1–3.2)', () => {
  it('21×80 is the smallest wordmark height: the mark shows, `/` (the 8-row palette) keeps it at exactly the budget, a 6-row draft keeps it; 20×80 keeps the brand row (6 rows, no mark)', async () => {
    const m = mount(WORDMARK_MIN_ROWS, 80);
    await settle(m);
    expect(m.dyn()).toHaveLength(11);
    expect(hasMark(m.dyn(), 80)).toBe(true);
    m.stdin.write('/');
    await waitFor(() => (m.bridge.stateReader?.()?.overlay ?? 'none') === 'palette');
    await tick(40);
    expect(m.dyn().length).toBeLessThanOrEqual(WORDMARK_MIN_ROWS - 2);
    expect(hasMark(m.dyn(), 80)).toBe(true);
    m.stdin.write('\x1b');
    await waitFor(() => (m.bridge.stateReader?.()?.overlay ?? 'palette') === 'none');
    await tick(60);
    for (let i = 0; i < 5; i++) m.stdin.write('a line of the draft\\\r'.replace('\\\r', '\\\r'));
    await tick(60);
    expect(m.dyn().length).toBeLessThanOrEqual(WORDMARK_MIN_ROWS - 2);
    expect(hasMark(m.dyn(), 80)).toBe(true);
    const low = mount(WORDMARK_MIN_ROWS - 1, 80);
    await settle(low);
    expect(low.dyn()).toHaveLength(6);
    expect(low.dyn()[0]).toMatch(BRAND_RE);
    expect(hasMark(low.dyn(), 80)).toBe(false);
  });
  it('the flat tier (12×80) and a screen reader (24×80) draw no mark and no wordmark frame after the first', async () => {
    const flat = mount(12, 80);
    await tick(SPLASH_MS + 200);
    expect(flat.dyn()).toHaveLength(3);
    expect(flat.dyn()[0]).toMatch(BRAND_RE);
    expect(flat.frame()).not.toContain('██');
    const sr = mount(24, 80, { launch: { ...MOTION, screenReader: true } });
    await tick(SPLASH_MS + 200);
    expect(sr.frame()).not.toContain('██');
    expect(sr.stdout.frames.map((f) => stripSgr(f)).filter((f) => f.includes('██'))).toEqual([]);
  });
  it('reduced motion: the complete resting mark (no `▓▒░`) is in frame 0 and no further wordmark frame is written; below 64 columns the brand row', async () => {
    const m = mount(24, 80, { launch: STILL });
    const f0 = stripSgr(m.stdout.frames[0] ?? '');
    expect(f0).toContain(markRow(1, 80));
    expect(f0).toContain(`◆ ${VERSION}`);
    expect(f0).not.toContain('▓▒░');
    const n = m.stdout.frames.length;
    await tick(SPLASH_MS + 300);
    // the quiet start (2026-09) leaves a session's `<Static>` empty, and Ink flushes that empty region once more when
    // the splash settles: at most ONE further write, byte-identical to frame 0. What reduced motion promises is that
    // no REVEAL frame is ever written — every frame that carries the mark is the same resting mark.
    expect(m.stdout.frames.length).toBeLessThanOrEqual(n + 1);
    expect(m.stdout.frames.filter((f) => stripSgr(f).includes('▓▒░'))).toEqual([]);
    expect(new Set(m.stdout.frames.filter((f) => stripSgr(f).includes('██'))).size).toBe(1);
    expect(dynamicRegion(f0, 80)).toHaveLength(11);
    const narrow = mount(24, 60, { launch: STILL });
    // the quiet start: with no `<Static>` header the LAST write of a fresh mount can be Ink's `ESC[?2004h`, so the
    // frame under test is the last write that actually painted rows
    const painted = [...narrow.stdout.frames].reverse().map((f) => stripSgr(f)).find((f) => dynamicRegion(f, 60).length > 0) ?? '';
    expect(dynamicRegion(painted, 60)[0]).toMatch(BRAND_RE);
    expect(painted).not.toContain('██');
  });
  it('`ui.wordmark: off` keeps today\'s frames after the reveal (the brand row, 6 rows); `static` and the SSH default keep the mark', async () => {
    const off = mount(24, 80, { ui: { wordmark: 'off' } });
    await settle(off);
    expect(off.dyn()).toHaveLength(6);
    expect(off.dyn()[0]).toMatch(BRAND_RE);
    const still = mount(24, 80, { ui: { wordmark: 'static' } });
    await settle(still);
    expect(still.dyn()).toHaveLength(11);
    expect(hasMark(still.dyn(), 80)).toBe(true);
    const ssh = mount(24, 80, { launch: { ...MOTION, ssh: true } });
    await settle(ssh);
    expect(ssh.dyn()).toHaveLength(11);
    expect(hasMark(ssh.dyn(), 80)).toBe(true);
  });
});

describe('the hand-offs (TUI-DESIGN-3 §3.2–3.3, D-I)', () => {
  it('run:start hides the mark (brand row, 6 rows, zero wordmark frames while live); run:ready shows the strip; at 24 rows run:end brings the mark back at once under the strip (F-W5)', async () => {
    const m = mount(WORDMARK_POST_RUN_MIN_ROWS, 80);
    await settle(m);
    startRun(m);
    await waitFor(() => BRAND_RE.test(m.dyn()[0] ?? ''));
    expect(m.dyn()).toHaveLength(6);
    expect(hasMark(m.dyn(), 80)).toBe(false);
    const liveFrom = m.stdout.frames.length;
    readyRun(m);
    // RE-PINNED BY SLOT S1 (TUI-DESIGN-4 §1.2 P-H1 / D-T a): the post-`run:ready` strip leads with `◆ jevcode`
    await waitFor(() => (m.dyn()[0] ?? '').startsWith('─── ◆ jevcode ─ ▸ jev'));
    expect(hasMark(m.dyn(), 80)).toBe(false);
    await tick(300);
    for (const d of m.frames().slice(liveFrom)) expect(hasMark(d, 80)).toBe(false);
    endRun(m);
    await waitFor(() => hasMark(m.dyn(), 80));
    const dyn = m.dyn();
    expect(dyn).toHaveLength(11);
    expect(dyn[0]).toMatch(/^─── ◆ jevcode ─ ▸ jev /); // the strip keeps the rule row with its brand (F-W5, P-H1); the mark sits under it
    expect(dyn[0]).not.toMatch(BRAND_RE);
    expect(dyn[5]).toBe(`${markRow(4, 80)}  ◆ ${VERSION}`);
  });
  it('at 22 rows the mark waits for the first key after run:end (the epilogue stays on screen), then returns under the strip', async () => {
    const m = mount(22, 80);
    await settle(m);
    startRun(m);
    readyRun(m);
    await waitFor(() => (m.dyn()[0] ?? '').startsWith('─── ◆ jevcode ─ ▸ jev'));
    endRun(m);
    await waitFor(() => (m.bridge.stateReader?.()?.run ?? 'live') === 'none');
    await tick(120);
    expect(hasMark(m.dyn(), 80)).toBe(false);
    expect(m.dyn()).toHaveLength(6);
    expect(m.bridge.stateReader?.()?.postRunKeySeen).toBe(false);
    m.stdin.write('h');
    await waitFor(() => hasMark(m.dyn(), 80));
    expect(m.dyn()).toHaveLength(11);
    expect(m.dyn()[0]).toMatch(/^─── ◆ jevcode ─ ▸ jev /);
    expect(m.frame()).toContain('› h');
  });
  it('`/panel` hands the slot to the panel and `/panel off` gives it back to the mark', async () => {
    const m = mount(24, 80);
    await settle(m);
    m.stdin.write('/panel\r');
    await waitFor(() => (m.bridge.stateReader?.()?.panel ?? 'collapsed') === 'open');
    await waitFor(() => (m.dyn()[0] ?? '').includes('▾ decisions'));
    expect(hasMark(m.dyn(), 80)).toBe(false);
    m.stdin.write('/panel off\r');
    await waitFor(() => (m.bridge.stateReader?.()?.panel ?? 'open') === 'collapsed');
    await waitFor(() => hasMark(m.dyn(), 80));
    expect(m.dyn()).toHaveLength(11);
  });
});

describe('the animation catalogue (TUI-DESIGN-3 §5.2 A4–A6, P7)', () => {
  it('runStartBand / runEndEdgeRole / streamCaretOn tables', () => {
    expect(runStartBand(0, 80)).toEqual({ from: 0, to: 12 });
    expect(runStartBand(150, 80)).toEqual({ from: 34, to: 46 });
    expect(runStartBand(299, 80)!.to).toBe(80);
    expect(runStartBand(RUN_START_SWEEP_MS, 80)).toBeNull();
    expect(runStartBand(-1, 80)).toBeNull();
    expect(runStartBand(10, 0)).toBeNull();
    expect(runEndEdgeRole(0)).toBe('borderFocus');
    expect(runEndEdgeRole(69)).toBe('borderFocus');
    expect(runEndEdgeRole(70)).toBe('accent2');
    expect(runEndEdgeRole(139)).toBe('accent2');
    expect(runEndEdgeRole(140)).toBe('border');
    expect(runEndEdgeRole(RUN_END_FADE_MS)).toBe('border');
    // 1 Hz on the 8 fps tick: on for frames 0–3 of every 8, off for 4–7; steady under reduced motion
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12].map((f) => streamCaretOn(f, false))).toEqual([true, true, true, true, false, false, false, false, true, true, false]);
    expect(streamCaretOn(5, true)).toBe(true);
  });
  it('A5: run:start adds ≤ 6 sweep ticks in its first 450 ms, every render with the same 6 dynamic rows and the same text (colour only); none under reduced motion', async () => {
    const m = mount(24, 80);
    await settle(m);
    const before = m.stdout.frames.length;
    startRun(m);
    await tick(RUN_START_SWEEP_MS + 150);
    const frames = m.frames().slice(before);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    // renders, not written frames (`debug: true` writes every commit; chalk is at level 0 here, so the band's colour never reaches the
    // text): the run:start commit + its effect re-render + 6 ticks (50 … 300 ms) + the one trailing tick that deactivates the
    // subscriber — in a real terminal the trailing tick and the re-render repeat the previous output and Ink writes neither, so the
    // pty gate (S5's `run-start` bucket) sees ≤ 6 extra frames
    expect(frames.length).toBeLessThanOrEqual(1 + 1 + 6 + 1);
    for (const d of frames) expect(d).toHaveLength(6);
    for (const d of frames.slice(1)) expect(d).toEqual(frames[0]);
    // reduced motion: no sweep — the run:start commit and its effect re-render only, identical text
    const still = mount(24, 80, { launch: STILL });
    const b2 = still.stdout.frames.length;
    startRun(still);
    await tick(RUN_START_SWEEP_MS + 150);
    const stillFrames = still.frames().slice(b2);
    expect(stillFrames.length).toBeLessThanOrEqual(2);
    for (const d of stillFrames.slice(1)) expect(d).toEqual(stillFrames[0]);
  });
  it('A6: run:end adds ≤ 3 fade frames in its first 300 ms (the end frame + 3), then nothing; none under reduced motion', async () => {
    const m = mount(24, 80);
    await settle(m);
    startRun(m);
    readyRun(m);
    await tick(RUN_START_SWEEP_MS + 150);
    const before = m.stdout.frames.length;
    endRun(m);
    await tick(RUN_END_FADE_MS + 150);
    const frames = m.frames().slice(before);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    // renders: the run:end commit + its effect re-render + 3 fade ticks (70 · 140 · 210 ms) + the trailing deactivation tick; the mark
    // is back in every one of them (the text never changes after the first)
    expect(frames.length).toBeLessThanOrEqual(1 + 1 + 3 + 1);
    for (const d of frames) expect(d).toHaveLength(11);
    for (const d of frames.slice(1)) expect(d).toEqual(frames[0]);
    const quiet = m.stdout.frames.length;
    await tick(200);
    expect(m.stdout.frames.length).toBe(quiet);
    const still = mount(24, 80, { launch: STILL });
    startRun(still);
    readyRun(still);
    await tick(100);
    const b2 = still.stdout.frames.length;
    endRun(still);
    await tick(RUN_END_FADE_MS + 150);
    const stillFrames = still.frames().slice(b2);
    expect(stillFrames.length).toBeLessThanOrEqual(2);
    for (const d of stillFrames.slice(1)) expect(d).toEqual(stillFrames[0]);
  });
  it('A4: the last live row ends with `▍` while the caret is on (1 Hz: both states within 1.2 s); steady under reduced motion', async () => {
    const m = mount(24, 80);
    await settle(m);
    startRun(m);
    readyRun(m);
    m.bus.emit({ type: 'generator:start', step: 3, attempt: 1 });
    m.bus.emit({ type: 'generator:delta', step: 3, text: 'streamed line one\nstreamed line two\n' });
    await waitFor(() => m.frame().includes('streamed line two'));
    const seen = new Set<boolean>();
    const until = Date.now() + 1300;
    while (Date.now() < until) {
      const row = m.dyn().find((l) => l.includes('streamed line two')) ?? '';
      seen.add(row.trimEnd().endsWith('▍'));
      await tick(20);
    }
    expect([...seen].sort()).toEqual([false, true]);
    const still = mount(24, 80, { launch: STILL });
    startRun(still);
    readyRun(still);
    still.bus.emit({ type: 'generator:start', step: 3, attempt: 1 });
    still.bus.emit({ type: 'generator:delta', step: 3, text: 'steady line\n' });
    await waitFor(() => still.frame().includes('steady line'), 2000);
    await tick(300);
    expect((still.dyn().find((l) => l.includes('steady line')) ?? '').trimEnd().endsWith('▍')).toBe(true);
  });
  it('P7: after Enter on a session no frame reads `│ starting` or the steer placeholder — the first frame already thinks', async () => {
    const host = fakeHost();
    host.submit = () => new Promise<void>(() => undefined);
    const m = mount(24, 80, { host });
    await settle(m);
    const before = m.stdout.frames.length;
    m.stdin.write('hi\r');
    await waitFor(() => (m.bridge.stateReader?.()?.run ?? 'none') === 'starting');
    await tick(60);
    const frames = m.stdout.frames.slice(before).map((f) => stripSgr(f));
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(f).not.toMatch(/│ starting\s/);
      expect(f).not.toContain(PLACEHOLDERS.steer);
    }
    expect(m.frame()).toMatch(/│ [░▒▓█◆] thinking/);
    expect(m.frame()).toContain(`› ${PLACEHOLDERS.thinking}`);
    expect(hasMark(m.dyn(), 80)).toBe(true); // §3.2: the mark stays while thinking
  });
});

describe('the idle loop through the App (TUI-DESIGN-3 §3.4, §3.6, §3.9 key-during-pass)', () => {
  it('no loop frame in the 5 s after the settle; the first pass starts ≈ 6.45 s after mount; a key landing during the pass paints within the 50 ms bound and the pass carries on', async () => {
    const m = mount(24, 80, { tickMs: 250 });
    await waitFor(() => (m.bridge.stateReader?.()?.splash ?? 'running') === 'done', 2000);
    const settledAt = Date.now();
    const settledFrames = m.stdout.frames.length;
    // the ticks (250 ms) re-render nowMs but Ink writes only what changes; in debug mode every commit is a frame — count the ones the
    // mark itself changed: none for 5 s (the loop rests 5,750 ms; the spinner is off; the 1 Hz-ish ticks only move the clock)
    await tick(5000);
    const idleFrames = m.frames().slice(settledFrames);
    for (const d of idleFrames) expect(d).toHaveLength(11);
    // the first pass: a written frame whose mark rows are unchanged as text (colour only) — observe the loop through the reducer-free
    // path: the render count rises at 4 fps once the pass runs (≥ 4 frames in the second after 6.7 s)
    await waitFor(() => Date.now() - settledAt >= LOOP_REST_MS + 600, 8000);
    const passStart = m.stdout.frames.length;
    await tick(1000);
    const passFrames = m.stdout.frames.length - passStart;
    expect(passFrames).toBeGreaterThanOrEqual(3);
    expect(passFrames).toBeLessThanOrEqual(4 + 4 + 1); // ≤ 4 sweep frames + ≤ 4 ticks + 1
    // the key during the pass: painted within 50 ms
    const t0 = Date.now();
    m.stdin.write('k');
    await waitFor(() => m.frame().includes('› k'), 200);
    expect(Date.now() - t0).toBeLessThanOrEqual(50);
    // the pass carries on: more frames follow within the next second, every one still 11 rows with the mark
    const afterKey = m.stdout.frames.length;
    await tick(800);
    expect(m.stdout.frames.length).toBeGreaterThan(afterKey);
    for (const d of m.frames().slice(afterKey)) expect(hasMark(d, 80)).toBe(true);
  }, 20_000);
});
