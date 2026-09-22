/**
 * TUI-DESIGN-2 §8.1 S4 — the mounted App on the round-2 findings (§13, second synthesis pass; the fix pass of the S4 review):
 * finding 1 — the `thinking` phase runs under `run: 'starting'` and still owns the status word, the placeholder, the console
 * border, Enter (toast) and Ctrl-C ×1 (`host.abort`, no exit); finding 2 — the brand rule row never flickers to the strip
 * during a submission (the strip first appears at `run:ready`, §5.4); finding 3 — a hidden-only engine batch (`intent`,
 * `context`) re-renders nothing under `<Static>` because every `<Transcript>` prop the App passes is stable (the memo
 * bails out: counted through a wrapping mock, since Ink in debug mode writes a frame for every commit of the dynamic
 * region, so `frames.length` cannot be the App-level observable); finding 4 — `]`, `[`, Alt+J, Alt+Shift+J and `/panel` on
 * the idle first frame open a headed tab (`▾`), never a headerless hole, and Ink's `ESC j` / `ESC J` deliveries resolve to
 * `global:panelToggle` / `global:panelFull` through the App; finding 10 — the brand accent holds on the pulsing splash glyphs.
 * Colour is observed through the roles `textProps` is asked for (chalk runs at level 0 under vitest, so no SGR is written).
 */
import { createElement, memo } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '../../../src/core/types.js';
import { RuleRow, STILL_THINKING_TOAST, chatThinking, runIsLive } from '../../../src/tui/App.js';
import { WORDMARK } from '../../../src/tui/splash.js';
import { PLACEHOLDERS } from '../../../src/tui/composer/Composer.js';
import { GLYPHS } from '../../../src/tui/glyphs.js';
import { ESC_REBUFFER_MS } from '../../../src/tui/keys/interrupts.js';
import { brandRow } from '../../../src/tui/splash.js';
import { themeFor, type ColorRole } from '../../../src/tui/theme.js';
import type { TranscriptProps } from '../../../src/tui/Transcript.js';
import { resetRenderFaults } from '../../../src/tui/PaneBoundary.js';
import { loadRunEvents, tick } from '../../fixtures/tui/fixtures.js';
import { CTRL_C, dynamicLines, fakeHost, goLive, mountApp, waitFor, type Mounted } from './app-harness.js';

const probes = vi.hoisted(() => ({ roles: [] as string[], transcriptRenders: 0 }));

// every `textProps(theme, role, on)` the App's tree asks for, in render order — the colour observable
vi.mock('../../../src/tui/theme.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/tui/theme.js')>();
  return {
    ...actual,
    textProps: (theme: Parameters<typeof actual.textProps>[0], role: ColorRole, on: Parameters<typeof actual.textProps>[2]) => {
      probes.roles.push(role);
      return actual.textProps(theme, role, on);
    },
  };
});

// the memoised <Transcript> wrapped in a counting memo with the same compare: it renders exactly when the App's prop set changed
vi.mock('../../../src/tui/Transcript.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/tui/Transcript.js')>();
  const Inner = (actual.Transcript as unknown as { type: (p: TranscriptProps) => React.JSX.Element }).type;
  const Counting = memo(function CountingTranscript(p: TranscriptProps): React.JSX.Element {
    probes.transcriptRenders++;
    return createElement(Inner, p);
  });
  return { ...actual, Transcript: Counting };
});

afterEach(() => cleanup());
beforeEach(() => {
  resetRenderFaults();
  probes.roles.length = 0;
  probes.transcriptRenders = 0;
});

const SPINNER = `[${GLYPHS.unicode.spinner.join('')}]`;
const BRAND_RE = /^─── ◆ jevcode \S+ ─+$/;
/** TUI-DESIGN-3 §3.3: the plain rule while the resting mark has rows (before the first run:ready) */
const PLAIN_RE = /^─+$/;
/** the mark's second row (the `J` column) — present in every frame that shows the wordmark */
const MARK_ROW = `${' '.repeat(22)}${WORDMARK[1]}`.replace(/\s+$/, '');

/** the dynamic region's rule row of the latest frame */
function ruleRow(m: Mounted): string {
  return dynamicLines(m.lastFrame())[0] ?? '';
}
/** the resting mark is on screen (TUI-DESIGN-3 §3.2: idle, thinking, after a run at ≥ 24 rows) */
function markShown(m: Mounted): boolean {
  return dynamicLines(m.lastFrame()).includes(MARK_ROW);
}

/** a host whose `submit` stays pending until `release()` — the intake, lookup or reply in flight */
function pendingHost(): { host: ReturnType<typeof fakeHost>; release: (outcome?: unknown) => void } {
  const host = fakeHost();
  let release: (outcome?: unknown) => void = () => undefined;
  host.submit = (text, opts) => {
    host.order.push('submit');
    host.submitted.push({ text, kind: opts.kind, secretSpans: opts.secretSpans, pinnedFiles: opts.pinnedFiles });
    return new Promise<unknown>((r) => {
      release = r;
    }) as Promise<void>;
  };
  return { host, release: (o) => release(o) };
}

async function settleSplash(m: Mounted): Promise<void> {
  m.dispatch({ type: 'splash:done' });
  await waitFor(() => m.state()?.splash === 'done');
  await tick(20);
}

describe('finding 1: the thinking phase under `run: starting` (TUI-DESIGN-2 §3.1 rows 1, 10, 11; §4.4; §4.8)', () => {
  it('status `▓ thinking`, placeholder `(thinking…)`, the plain rule with the mark kept (TUI-DESIGN-3 §3.2) and the idle `border` role; Enter → `one moment — still thinking` with the draft kept; Ctrl-C ×1 → host.abort and no exit', async () => {
    const { host, release } = pendingHost();
    const m = mountApp({ mode: 'session', host });
    await settleSplash(m);
    expect(ruleRow(m)).toMatch(PLAIN_RE);
    expect(markShown(m)).toBe(true);
    m.stdin.write('hi there\r');
    await waitFor(() => m.state()?.run === 'starting');
    expect(host.submitted.map((s) => s.text)).toEqual(['hi there']);
    // TUI-DESIGN-3 §5.2 P7: the App enters the intake phase with `run:starting`; the controller's `thinking('intake')` (§3.8) is idempotent
    expect(m.state()?.thinking).toBe('intake');
    probes.roles.length = 0;
    m.dispatch({ type: 'thinking', phase: 'intake' });
    await waitFor(() => m.state()?.thinking === 'intake');
    await waitFor(() => new RegExp(`│ ${SPINNER} thinking`).test(m.lastFrame()));
    await waitFor(() => probes.roles.length > 0); // the spinner's next frame re-renders the console
    const dyn = dynamicLines(m.lastFrame());
    expect(dyn[0]).toMatch(PLAIN_RE); // finding 2: not the strip; §3.2: the mark stays while thinking
    expect(dyn).toHaveLength(11);
    expect(markShown(m)).toBe(true);
    expect(dyn[7]).toBe(`│ › ${PLACEHOLDERS.thinking}${' '.repeat(96 - 2 - PLACEHOLDERS.thinking.length)} │`);
    expect(dyn[9]).toMatch(new RegExp(`^│ ${SPINNER} thinking\\s+step 0/–`));
    expect(m.lastFrame()).not.toContain('│ starting');
    expect(m.lastFrame()).not.toContain(PLACEHOLDERS.steer);
    // the console border keeps the idle `border` role — no `borderFocus`, no `steer` prompt: no engine run is live
    expect(probes.roles).toContain('border');
    expect(probes.roles).not.toContain('borderFocus');
    expect(probes.roles).not.toContain('steer');
    expect(runIsLive('starting')).toBe(false);
    expect(chatThinking({ run: 'starting', thinking: 'intake' })).toBe(true);
    expect(chatThinking({ run: 'none', thinking: 'lookup' })).toBe(true);
    expect(chatThinking({ run: 'live', thinking: 'intake' })).toBe(false);
    expect(chatThinking({ run: 'starting', thinking: null })).toBe(false);
    // §3.1 row 11: Enter on a draft while thinking → toast, the draft stays, nothing is submitted
    m.stdin.write('and again');
    await waitFor(() => m.lastFrame().includes('› and again'));
    m.stdin.write('\r');
    await waitFor(() => m.lastFrame().includes(STILL_THINKING_TOAST));
    expect(m.lastFrame()).toContain('› and again');
    expect(host.submitted).toHaveLength(1);
    // §3.1 row 10: Ctrl-C ×1 aborts the request through the host; no arm, no exit, the phase is the controller's to clear
    m.stdin.write(CTRL_C);
    await waitFor(() => host.aborts.length === 1);
    expect(host.aborts).toEqual(['human_abort']);
    expect(host.exits).toEqual([]);
    expect(m.state()?.run).toBe('starting');
    expect(m.lastFrame()).not.toContain('press Ctrl-C again to exit');
    // the controller: `thinking(null)`, toast `stopped thinking`, the submit resolves with `became: 'nothing'`
    m.dispatch({ type: 'thinking', phase: null });
    release({ became: 'nothing' });
    await waitFor(() => m.state()?.run === 'none');
    expect(m.state()?.thinking).toBeNull();
    expect(ruleRow(m)).toMatch(PLAIN_RE);
    expect(markShown(m)).toBe(true);
    expect(m.lastFrame()).toContain('› and again'); // the draft was never restored or cleared
    expect(m.lastFrame()).not.toContain(PLACEHOLDERS.thinking);
  });

  it('the lookup and reply phases name themselves; a live engine run never shows a phase (steer placeholder, `borderFocus`)', async () => {
    const { host, release } = pendingHost();
    const m = mountApp({ mode: 'session', host });
    await settleSplash(m);
    m.stdin.write('what does kth do?\r');
    await waitFor(() => m.state()?.run === 'starting');
    m.dispatch({ type: 'thinking', phase: 'lookup' });
    await waitFor(() => new RegExp(`│ ${SPINNER} looking`).test(m.lastFrame()));
    m.dispatch({ type: 'thinking', phase: 'replying' });
    await waitFor(() => new RegExp(`│ ${SPINNER} replying`).test(m.lastFrame()));
    expect(m.lastFrame()).toContain(`› ${PLACEHOLDERS.thinking}`);
    m.dispatch({ type: 'thinking', phase: null });
    release({ became: 'chat' });
    await waitFor(() => m.state()?.run === 'none');
    // a chat reply is a turn: the follow-up placeholder (§4.4)
    await waitFor(() => m.lastFrame().includes(`› ${PLACEHOLDERS.followup}`));
    // a run: `run:start` clears any phase, the steer placeholder and the live border take over
    m.dispatch({ type: 'thinking', phase: 'intake' });
    await waitFor(() => m.state()?.thinking === 'intake');
    probes.roles.length = 0;
    goLive(m, 1);
    await waitFor(() => m.state()?.run === 'live');
    expect(m.state()?.thinking).toBeNull();
    await waitFor(() => m.lastFrame().includes(`› ${PLACEHOLDERS.steer}`));
    expect(probes.roles).toContain('borderFocus');
    expect(probes.roles).toContain('steer');
  });
});

describe('finding 2: the rule row between Enter and the reply (TUI-DESIGN-2 §5.4; TUI-DESIGN-3 §3.2–3.3)', () => {
  it('stays the plain rule with the mark for the whole submission and after a chat reply; run:start hides the mark and shows the brand row; the strip first appears at run:ready, not run:start', async () => {
    const { host, release } = pendingHost();
    const m = mountApp({ mode: 'session', host });
    await settleSplash(m);
    const plain = ruleRow(m);
    expect(plain).toMatch(PLAIN_RE);
    expect(markShown(m)).toBe(true);
    const framesBefore = m.frames.length;
    m.stdin.write('hello\r');
    await waitFor(() => m.state()?.run === 'starting');
    m.dispatch({ type: 'thinking', phase: 'intake' });
    await waitFor(() => m.state()?.thinking === 'intake');
    // the intake's own decision rows (§3.11) arrive while still starting — still the plain rule, the mark still there
    m.dispatch({ type: 'chat-decisions', rows: [] });
    await tick(30);
    // every frame committed since Enter carries the plain rule and the mark, never `▸ jev`, never the brand row
    expect(m.frames.length).toBeGreaterThan(framesBefore);
    for (const f of m.frames.slice(framesBefore)) {
      const rows = dynamicLines(f.replace(/\x1b\[[0-9;]*m/g, ''));
      expect(rows[0]).toBe(plain);
      expect(rows).toContain(MARK_ROW);
      expect(f).not.toContain('▸ jev');
      expect(f).not.toMatch(BRAND_RE);
    }
    m.dispatch({ type: 'thinking', phase: null });
    release({ became: 'chat' });
    await waitFor(() => m.state()?.run === 'none');
    expect(ruleRow(m)).toBe(plain);
    expect(markShown(m)).toBe(true);
    // run:start alone: the mark hides (§3.2: zero animation frames during a run) and the brand row takes the rule row (§5.4: until the first run:ready)
    m.bus.emit({ type: 'run:start', runId: 'r1', task: 'Fix the failing test', mode: 'jev-on', resumedFromStep: null });
    await waitFor(() => m.state()?.run === 'live');
    await waitFor(() => BRAND_RE.test(ruleRow(m)));
    expect(markShown(m)).toBe(false);
    expect(dynamicLines(m.lastFrame())).toHaveLength(6);
    m.bus.emit({ type: 'run:ready', runId: 'r1', step: 0, maxSteps: 40, task: 'Fix the failing test', resumed: false });
    // RE-PINNED BY SLOT S1 (TUI-DESIGN-4 §1.2 P-H1 / D-T a): at `run:ready` the strip appears WITH the permanent
    // `◆ jevcode` prefix. The pre-`run:ready` assertions above (the plain rule, then the brand row) are unchanged.
    await waitFor(() => m.lastFrame().includes('─── ◆ jevcode ─ ▸ jev · no decisions yet'));
    expect(ruleRow(m)).toMatch(/^─── ◆ jevcode ─ ▸ jev · no decisions yet ─+ \[d\] \[p\] \[t\] \[s\] ──$/);
    expect(markShown(m)).toBe(false);
  });
});

describe('finding 3: a hidden-only engine batch dirties no <Static> subtree through the App (TUI-DESIGN-2 §4.5)', () => {
  it('intent + context events (compact view) leave the memoised <Transcript> unrendered and the transcript rows unchanged; a visible item renders it once more', async () => {
    const m = mountApp({ mode: 'session' });
    await settleSplash(m);
    goLive(m, 1);
    await tick(60);
    const intent = loadRunEvents().find((e): e is Extract<EngineEvent, { type: 'intent' }> => e.type === 'intent');
    expect(intent).toBeDefined();
    if (!intent) return;
    // the dynamic region keeps committing (status, spinner…) — the App re-renders; the transcript must not
    m.stdin.write('x'); // a keystroke: an App render with an unchanged transcript prop set
    await waitFor(() => m.lastFrame().includes('› x'));
    const rendersBefore = probes.transcriptRenders;
    const staticBefore = m.lastFrame().split('\n').filter((l) => /^\[/.test(l));
    m.bus.emit({ ...intent, step: 1 });
    await tick(40);
    m.bus.emit({ type: 'context', step: 1, files: ['src/kth.py', 'tests/test_kth.py'], bytes: 812, candidates: 12 });
    await tick(80);
    // the items reached the reducer (hidden) — `/transcript full` and `/export` still see them
    const items = m.state()?.items ?? [];
    expect(items.some((i) => i.kind === 'intent')).toBe(true);
    expect(items.some((i) => i.kind === 'context')).toBe(true);
    expect(items.filter((i) => i.kind === 'intent' || i.kind === 'context').every((i) => i.hidden === true)).toBe(true);
    // the App committed (the frames grew), but the memoised <Transcript> saw the same props: no <Static> re-render, no static dirt
    expect(probes.transcriptRenders).toBe(rendersBefore);
    expect(m.lastFrame().split('\n').filter((l) => /^\[/.test(l))).toEqual(staticBefore);
    expect(m.lastFrame()).not.toContain('context 2 files');
    expect(m.lastFrame()).not.toContain('intent=');
    // a visible item (a local [ui] note) re-renders it exactly once
    m.dispatch({ type: 'local', text: 'visible note', label: '[ui]' });
    await waitFor(() => m.lastFrame().includes('[ui] visible note'));
    expect(probes.transcriptRenders).toBe(rendersBefore + 1);
  });
});

describe('finding 4: the panel keys on the idle first frame (TUI-DESIGN-2 §4.6, §5.4)', () => {
  it('`]` opens a headed decisions tab (`▾ decisions s0`, `(no decisions yet)`) in place of the mark, `]`/`[` cycle, Esc collapses back to the plain rule and the mark returns (TUI-DESIGN-3 §3.3: 11 rows)', async () => {
    const m = mountApp({ mode: 'session' });
    await settleSplash(m);
    expect(ruleRow(m)).toMatch(PLAIN_RE);
    expect(markShown(m)).toBe(true);
    m.stdin.write(']');
    await waitFor(() => m.state()?.panel === 'open');
    await waitFor(() => m.lastFrame().includes('─── ▾ decisions s0'));
    let dyn = dynamicLines(m.lastFrame());
    expect(dyn[0]).toContain('─── ▾ decisions s0');
    expect(dyn[0]).toContain('[d]ecisions [p]lan [t]ime [s]ynth');
    expect(dyn[1]).toContain('(no decisions yet)');
    expect(dyn).toHaveLength(1 + 6 + 5); // header · 6 pane rows · console — the panel owns the slot, the mark is gone
    expect(markShown(m)).toBe(false);
    expect(m.lastFrame()).not.toMatch(BRAND_RE);
    m.stdin.write(']');
    await waitFor(() => m.lastFrame().includes('─── ▾ plan s0'));
    m.stdin.write('[');
    await waitFor(() => m.lastFrame().includes('─── ▾ decisions s0'));
    // Esc on the empty idle draft collapses the panel before it arms Esc Esc — and brings the mark back (§3.3)
    m.stdin.write('\x1b');
    await tick(ESC_REBUFFER_MS + 40);
    await waitFor(() => m.state()?.panel === 'collapsed');
    await waitFor(() => markShown(m));
    dyn = dynamicLines(m.lastFrame());
    expect(dyn[0]).toMatch(PLAIN_RE);
    expect(dyn).toHaveLength(11);
  });

  it('Ink’s `ESC j` → global:panelToggle (open, then collapsed) and `ESC J` → global:panelFull (12 headed rows); `/panel`, `/panel t` and `/panel off` through the composer', async () => {
    const m = mountApp({ mode: 'session' });
    await settleSplash(m);
    m.stdin.write('\x1bj');
    await waitFor(() => m.state()?.panel === 'open');
    await waitFor(() => m.lastFrame().includes('─── ▾ decisions s0'));
    m.stdin.write('\x1bj');
    await waitFor(() => m.state()?.panel === 'collapsed');
    await waitFor(() => PLAIN_RE.test(ruleRow(m)) && markShown(m));
    m.stdin.write('\x1bJ');
    await waitFor(() => m.state()?.panel === 'full');
    await waitFor(() => m.lastFrame().includes('─── ▾ decisions s0'));
    const full = dynamicLines(m.lastFrame());
    expect(full[0]).toContain('─── ▾ decisions s0');
    expect(full).toHaveLength(1 + 12 + 5);
    expect(full[1]).toContain('(no decisions yet)');
    // the draft is untouched by the chords
    expect(m.lastFrame()).toContain(`› ${PLACEHOLDERS.task}`);
    m.stdin.write('/panel off\r');
    await waitFor(() => m.state()?.panel === 'collapsed');
    await waitFor(() => PLAIN_RE.test(ruleRow(m)) && markShown(m));
    m.stdin.write('/panel\r');
    await waitFor(() => m.state()?.panel === 'open');
    await waitFor(() => m.lastFrame().includes('─── ▾ decisions s0'));
    m.stdin.write('/panel t\r');
    await waitFor(() => m.lastFrame().includes('─── ▾ timeline s0'));
    m.stdin.write('/panel t\r'); // a second `/panel t` on the same tab collapses
    await waitFor(() => m.state()?.panel === 'collapsed');
    await waitFor(() => PLAIN_RE.test(ruleRow(m)) && markShown(m));
  });
});

describe('finding 10: the brand accent on the pulsing splash glyphs (TUI-DESIGN-2 §5.1, §5.4)', () => {
  it('RuleRow asks for rule · accent · rule around `░ jevcode 0.2.0`, `▒ …`, `▓ …` exactly as around `◆ jevcode 0.2.0`; a strip row is one rule span', () => {
    const theme = themeFor('dark');
    for (const t of [null, 0, 50, 100, 150]) {
      cleanup();
      probes.roles.length = 0;
      const row = brandRow('0.2.0', 60, t);
      const out = render(<RuleRow text={row} theme={theme} color={24} glyphs={GLYPHS.unicode} />).lastFrame() ?? '';
      expect(out).toBe(row);
      expect(probes.roles).toEqual(['rule', 'accent', 'rule']);
      expect(['░', '▒', '▓', '◆']).toContain(row.slice(4, 5));
    }
    cleanup();
    probes.roles.length = 0;
    const strip = '─── ▸ jev · no decisions yet ──────────── [d] [p] [t] [s] ──';
    expect(render(<RuleRow text={strip} theme={theme} color={24} glyphs={GLYPHS.unicode} />).lastFrame()).toBe(strip);
    expect(probes.roles).toEqual(['rule']);
    // the ascii twin: `* jevcode` and the `# + .` pulse heads
    cleanup();
    probes.roles.length = 0;
    const ascii = brandRow('0.2.0', 60, 0, GLYPHS.ascii);
    expect(render(<RuleRow text={ascii} theme={theme} color={24} glyphs={GLYPHS.ascii} />).lastFrame()).toBe(ascii);
    expect(probes.roles).toEqual(['rule', 'accent', 'rule']);
  });
});
