/**
 * TUI-DESIGN-3 §3 / §5.2 A1–A6 / P7 / §8 S2 (`round3-wordmark-app.test.tsx`, S2's own App-level tests over the real Ink renderer on
 * a stub TTY, `debug: true` so every commit is a frame — the whole scrollback plus the dynamic region). RE-PINNED for the owner's
 * directive of 2026-09-23 ("keep jevcode branding on top only … chats appear after that"): the splash animates in the dynamic
 * region (rule → box → console) and the settled mark is then COMMITTED as the first `<Static>` block — above the rule, above every
 * message — so the settled dynamic region is the rule and the console (6 rows). The hero at 24×80 (the mark + caption in the
 * scrollback, the prompt below); the height tiers are gone (21 and 20 rows both commit the mark; the palette and a draft never touch
 * it); the mark never returns to the dynamic region (a run, a panel, run:end); reduced motion commits the resting mark in frame 0;
 * the flat tier and a screen reader draw no mark; `ui.wordmark: off` keeps today's brand row and `static` / the SSH default commit
 * the mark; A5's run-start sweep is ≤ 6 extra frames with the row count unchanged (none under reduced motion); A6's run-end fade is
 * ≤ 3 frames; A4's streaming caret blinks at 1 Hz and is steady under reduced motion; P7: after Enter no frame reads `starting` or the
 * steer placeholder; the idle sweep never runs on a committed mark: zero frames at rest, and a key still paints within 50 ms.
 */
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import type { LaunchSettings, UiConfig } from '../../../src/core/types.js';
import { App, RUN_END_FADE_MS, RUN_START_SWEEP_MS, createBridge, runEndEdgeRole, runStartBand, streamCaretOn, type Bridge } from '../../../src/tui/App.js';
import { PLACEHOLDERS } from '../../../src/tui/composer/Composer.js';
import { LOOP_REST_MS, scrollbackMarkPad, scrollbackMarkRows } from '../../../src/tui/wordmark.js';
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
/** the rows of the last frame ABOVE its dynamic region — the scrollback (`<Static>`), where the settled mark is committed */
const above = (m: M): string[] => {
  const all = m.frame().replace(/\n$/, '').split('\n');
  return all.slice(0, all.length - m.dyn().length).map((l) => l.trimEnd());
};
/** the committed block as the scrollback's first rows: `pad` blank rows, the five glyph rows (tagline / caption where they fit), `pad` blank rows */
const markBlock = (columns: number, rows: number, o: { caption?: boolean; tagline?: boolean } = {}): string[] => {
  const pad = Array.from({ length: scrollbackMarkPad(rows) }, () => '');
  const glyphs = [0, 1, 2, 3, 4].map((r) => markRow(r, columns));
  if (o.tagline === true) glyphs[0] = `${glyphs[0]}  Decisions, not strings`;
  if (o.caption !== false) glyphs[4] = `${glyphs[4]}  ◆ ${VERSION}`;
  return [...pad, ...glyphs, ...pad];
};
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
  it('24×80: frame 0 is splash frame 0 (the J and the head, step 0/–); after the settle the resting mark with `◆ <version>` heads the scrollback and the dynamic region is the plain rule and the console with the prompt (6 rows)', async () => {
    const m = mount(24, 80);
    const f0 = stripSgr(m.stdout.frames[0] ?? '');
    expect(f0).toContain(`${WORDMARK[3]!.slice(0, 7)}▓▒░`);
    expect(f0).toContain('step 0/–');
    await settle(m);
    expect(above(m)).toEqual(markBlock(80, 24));
    const dyn = m.dyn();
    expect(dyn).toHaveLength(6);
    expect(dyn[0]).toBe(PLAIN(80));
    expect(dyn[1]).toMatch(/^╭─ /);
    expect(dyn[2]).toContain(`› ${PLACEHOLDERS.task}`);
    expect(dyn[5]).toMatch(/^╰─+╯$/);
    expect(hasMark(dyn, 80)).toBe(false);
    expect(m.frame()).not.toContain('▓▒░');
    expect(m.frame()).not.toMatch(BRAND_RE);
  });
  it('40×120: two padding rows each side of the committed mark (owner directive 3), the tagline on row 0 and the caption; 21×64: neither (no caption below 73 columns), one padding row', async () => {
    const wide = mount(40, 120);
    await settle(wide);
    expect(scrollbackMarkPad(40)).toBe(2);
    expect(above(wide)).toEqual(markBlock(120, 40, { tagline: true }));
    expect(above(wide)[2]).toBe(`${markRow(0, 120)}  Decisions, not strings`);
    expect(wide.dyn()).toHaveLength(6);
    const small = mount(21, 64);
    await settle(small);
    expect(above(small)).toEqual(markBlock(64, 21, { caption: false }));
    expect(small.dyn()).toHaveLength(6);
    expect(small.frame()).not.toContain('◆ ');
    expect(small.frame()).not.toContain('Decisions, not strings');
  });
  it('the commit moves the rule row ONCE and nothing else: the held splash frame (rule → box → console) and the first settled frame (mark → rule → console) hold the same rows, the rule moved from above the box to below it', async () => {
    const m = mount(24, 80);
    await waitFor(() => m.frames().some((d) => d.some((l) => l.endsWith(`◆ ${VERSION}`))), 1500);
    const held = m.frames().findLast((d) => d.some((l) => l.endsWith(`◆ ${VERSION}`))) ?? [];
    // the held frame is all dynamic: the rule, the box (the committed block's own height), the console
    expect(held).toHaveLength(1 + scrollbackMarkRows(24) + 5);
    await waitFor(() => (m.bridge.stateReader?.()?.splash ?? 'running') === 'done', 2000);
    await tick(80);
    const box = scrollbackMarkRows(24);
    const settled = [...above(m), ...m.dyn()];
    expect(settled).toEqual([...held.slice(1, 1 + box), held[0]!, ...held.slice(1 + box)]);
    expect(m.dyn()).toHaveLength(6);
  });
});

describe('the tiers (TUI-DESIGN-3 §3.1–3.2)', () => {
  it('the height tiers are gone: 21×80 and 20×80 both commit the mark above a 6-row dynamic region; `/` (the palette) and a 6-row draft never touch it', async () => {
    const m = mount(21, 80);
    await settle(m);
    expect(m.dyn()).toHaveLength(6);
    expect(above(m)).toEqual(markBlock(80, 21));
    m.stdin.write('/');
    await waitFor(() => (m.bridge.stateReader?.()?.overlay ?? 'none') === 'palette');
    await tick(40);
    expect(m.dyn().length).toBeLessThanOrEqual(21 - 2);
    expect(hasMark(m.dyn(), 80)).toBe(false);
    expect(above(m).slice(0, scrollbackMarkRows(21))).toEqual(markBlock(80, 21));
    m.stdin.write('\x1b');
    await waitFor(() => (m.bridge.stateReader?.()?.overlay ?? 'palette') === 'none');
    await tick(60);
    for (let i = 0; i < 5; i++) m.stdin.write('a line of the draft\\\r'.replace('\\\r', '\\\r'));
    await tick(60);
    expect(m.dyn().length).toBeLessThanOrEqual(21 - 2);
    expect(above(m).slice(0, scrollbackMarkRows(21))).toEqual(markBlock(80, 21));
    const low = mount(20, 80);
    await settle(low);
    expect(low.dyn()).toHaveLength(6);
    // the mark is on screen (committed), so the rule row is the plain rule, not the brand row
    expect(low.dyn()[0]).toBe(PLAIN(80));
    expect(above(low)).toEqual(markBlock(80, 20));
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
    // committed in frame 0: the scrollback's first block, the dynamic region the rule and the console
    expect(dynamicRegion(f0, 80)).toHaveLength(6);
    expect(hasMark(dynamicRegion(f0, 80), 80)).toBe(false);
    const narrow = mount(24, 60, { launch: STILL });
    // the quiet start: with no `<Static>` header the LAST write of a fresh mount can be Ink's `ESC[?2004h`, so the
    // frame under test is the last write that actually painted rows
    const painted = [...narrow.stdout.frames].reverse().map((f) => stripSgr(f)).find((f) => dynamicRegion(f, 60).length > 0) ?? '';
    expect(dynamicRegion(painted, 60)[0]).toMatch(BRAND_RE);
    expect(painted).not.toContain('██');
  });
  it('`ui.wordmark: off` keeps today\'s frames after the reveal (the brand row, 6 rows, no mark committed); `static` and the SSH default commit the mark', async () => {
    const off = mount(24, 80, { ui: { wordmark: 'off' } });
    await settle(off);
    expect(off.dyn()).toHaveLength(6);
    expect(off.dyn()[0]).toMatch(BRAND_RE);
    expect(off.frame()).not.toContain('██');
    const still = mount(24, 80, { ui: { wordmark: 'static' } });
    await settle(still);
    expect(still.dyn()).toHaveLength(6);
    expect(above(still)).toEqual(markBlock(80, 24));
    const ssh = mount(24, 80, { launch: { ...MOTION, ssh: true } });
    await settle(ssh);
    expect(ssh.dyn()).toHaveLength(6);
    expect(above(ssh)).toEqual(markBlock(80, 24));
  });
});

describe('the hand-offs (TUI-DESIGN-3 §3.2–3.3, D-I)', () => {
  it('the committed mark stays the first scrollback block across run:start → run:ready → run:end and never re-enters the dynamic region — only the rule row changes (plain → the strip)', async () => {
    const m = mount(24, 80);
    await settle(m);
    expect(above(m)).toEqual(markBlock(80, 24));
    startRun(m);
    await tick(120);
    // the mark is on screen (in the scrollback), so the brand row never takes the rule row: the plain rule holds until run:ready
    expect(m.dyn()[0]).toBe(PLAIN(80));
    const liveFrom = m.stdout.frames.length;
    readyRun(m);
    await waitFor(() => (m.dyn()[0] ?? '').startsWith('─── ◆ jevcode ─ ▸ jev'));
    await tick(300);
    // …and NO frame of the run draws it in the dynamic region; every frame's scrollback still opens with it
    for (const d of m.frames().slice(liveFrom)) expect(hasMark(d, 80)).toBe(false);
    for (const f of m.stdout.frames.slice(liveFrom)) {
      if (dynamicRegion(stripSgr(f), 80).length === 0) continue;
      expect(stripSgr(f).split('\n').slice(0, scrollbackMarkRows(24)).map((l) => l.trimEnd())).toEqual(markBlock(80, 24));
    }
    endRun(m);
    await waitFor(() => (m.bridge.stateReader?.()?.run ?? 'live') === 'none');
    await tick(120);
    const dyn = m.dyn();
    expect(hasMark(dyn, 80)).toBe(false);
    expect(dyn).toHaveLength(6);
    expect(dyn[0]).toMatch(/^─── ◆ jevcode ─ ▸ jev /); // the strip keeps the rule row with its brand (F-W5, P-H1)
    expect(dyn[0]).not.toMatch(BRAND_RE);
    expect(above(m).slice(0, scrollbackMarkRows(24))).toEqual(markBlock(80, 24));
  });
  it('at 22 rows after run:end the first key changes nothing about the mark: it is scrollback, the dynamic region stays 6 rows', async () => {
    const m = mount(22, 80);
    await settle(m);
    startRun(m);
    readyRun(m);
    await waitFor(() => (m.dyn()[0] ?? '').startsWith('─── ◆ jevcode ─ ▸ jev'));
    endRun(m);
    await waitFor(() => (m.bridge.stateReader?.()?.run ?? 'live') === 'none');
    await tick(120);
    expect(m.dyn()).toHaveLength(6);
    expect(m.dyn()[0]).toMatch(/^─── ◆ jevcode ─ ▸ jev /);
    m.stdin.write('h');
    await waitFor(() => m.frame().includes('› h'));
    expect(hasMark(m.dyn(), 80)).toBe(false);
    expect(m.dyn()).toHaveLength(6);
    expect(above(m).slice(0, scrollbackMarkRows(22))).toEqual(markBlock(80, 22));
  });
  it('`/panel` at 30 rows and at 24 rows opens the panel in the dynamic region; the committed mark stays above it, and `/panel off` gives the 6-row region back', async () => {
    for (const rows of [30, 24]) {
      const m = mount(rows, 80);
      await settle(m);
      m.stdin.write('/panel\r');
      await waitFor(() => (m.bridge.stateReader?.()?.panel ?? 'collapsed') === 'open');
      await waitFor(() => (m.dyn()[0] ?? '').includes('▾ decisions'));
      expect(hasMark(m.dyn(), 80)).toBe(false);
      expect(above(m).slice(0, scrollbackMarkRows(rows))).toEqual(markBlock(80, rows));
      m.stdin.write('/panel off\r');
      await waitFor(() => (m.bridge.stateReader?.()?.panel ?? 'open') === 'collapsed');
      await waitFor(() => m.dyn().length === 6);
      expect(m.dyn()).toHaveLength(6);
      expect(above(m).slice(0, scrollbackMarkRows(rows))).toEqual(markBlock(80, rows));
    }
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
    // 50 columns: boxed (≥ 40) but below the mark's 64 and the indicator's 60, so the run-start sweep is the only
    // animation in the window and the measurement is of the sweep alone, exactly as round 3 specified it
    const m = mount(24, 50);
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
    const still = mount(24, 50, { launch: STILL });
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
    // renders: the run:end commit + its effect re-render + 3 fade ticks (70 · 140 · 210 ms) + the trailing deactivation tick; the
    // dynamic region is the rule and the console in every one of them (the text never changes after the first)
    expect(frames.length).toBeLessThanOrEqual(1 + 1 + 3 + 1);
    for (const d of frames) expect(d).toHaveLength(6);
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
    // AGENT-LOOP-DESIGN §A3: the glyph slot is the mini braille donut (1–3 cells), or its ASCII twin
    expect(m.frame()).toMatch(/│ (?:[⠀-⣿]{1,3}|[-\\|/]) thinking/);
    expect(m.frame()).toContain(`› ${PLACEHOLDERS.thinking}`);
    // §3.2: the mark stays while thinking — committed at the top of the scrollback, never in the dynamic region
    expect(hasMark(m.dyn(), 80)).toBe(false);
    expect(above(m).slice(0, scrollbackMarkRows(24))).toEqual(markBlock(80, 24));
  });
});

describe('the idle loop through the App (TUI-DESIGN-3 §3.4, §3.6, §3.9 key-during-pass)', () => {
  it('a committed mark is never repainted: no frame at rest past the old first-pass time (≈ 6.45 s after mount), and a key still paints within the 50 ms bound', async () => {
    const m = mount(24, 80);
    await waitFor(() => (m.bridge.stateReader?.()?.splash ?? 'running') === 'done', 2000);
    const settledAt = Date.now();
    await tick(150);
    const settledFrames = m.stdout.frames.length;
    // the pinned mark's first idle pass started LOOP_REST_MS after the settle; a committed mark has no pass at all —
    // `ui.wordmark: sweep` covers the splash alone, so an idle session writes nothing (the `idle-frames` gate)
    await waitFor(() => Date.now() - settledAt >= LOOP_REST_MS + 1500, 9000);
    expect(m.stdout.frames.length - settledFrames).toBe(0);
    const t0 = Date.now();
    m.stdin.write('k');
    await waitFor(() => m.frame().includes('› k'), 200);
    expect(Date.now() - t0).toBeLessThanOrEqual(50);
    expect(hasMark(m.dyn(), 80)).toBe(false);
    expect(above(m)).toEqual(markBlock(80, 24));
  }, 20_000);
});
