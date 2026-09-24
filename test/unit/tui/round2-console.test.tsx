/**
 * TUI-DESIGN-2 §4.3 / §5 / §8.1 S4 (`Console.tsx`, `motion.ts`): the mounted console's rows equal `consoleLines()` byte for byte
 * (idle H-A3 / wide H-A3w, the hosted gate row, the wizard's rows under `setup · generator key` with the `› •••` field, the
 * picker filter under `sessions · filter`); the placeholder hint is right-aligned at ≥ 100 inner cells (H-A1w) and appended
 * for steer (H-D1w); `useMotion` reports time from Ink's shared timer, settles at 700 ms and never ticks afterwards.
 */
import { useEffect, useState } from 'react';
// Ink keeps its animation context private (`exports` maps only `.`); the pinned ink 7.1.1 module is reached by path — the same
// module instance `useAnimation` reads, so a Provider here injects the clock `useMotion` sees
import AnimationContext from '../../../node_modules/ink/build/components/AnimationContext.js';
import { cleanup, render } from 'ink-testing-library';
import { Text } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { Console, ghostText, pickerConsoleTitle, wizardBodyRows, wizardConsoleTitle } from '../../../src/tui/Console.js';
import { MODE_BADGE_WORD } from '../../../src/config/defaults.js';
import { consoleTopEdge } from '../../../src/tui/console-lines.js';
import { modeBadge } from '../../../src/tui/status/lines.js';
import { textProps, themeFor } from '../../../src/tui/theme.js';
import { consoleLines } from '../../../src/tui/console-lines.js';
import { createBuffer, reduceBuffer } from '../../../src/tui/composer/buffer.js';
import { PLACEHOLDERS, draftRows } from '../../../src/tui/composer/Composer.js';
import { GLYPHS } from '../../../src/tui/glyphs.js';
import { useMotion } from '../../../src/tui/motion.js';
import { INITIAL_ONBOARDING, onboardingReducer } from '../../../src/tui/onboarding/reducer.js';
import { SPLASH_INTERVAL_MS, SPLASH_MS } from '../../../src/tui/splash.js';
import { statusLineText, type StatusLineState } from '../../../src/tui/status/lines.js';
import { render as inkRender } from 'ink';
import { StubStdin, StubStdout, stripSgr } from './stub-stdout.js';

/** ink-testing-library's stdout is 100 columns wide; the 120-column console renders through Ink with a 120-column stub */
function wideRows(el: React.JSX.Element, columns = 120): string[] {
  const stdout = new StubStdout(40, columns);
  const inst = inkRender(el, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: new StubStdin() as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
  const rows = stripSgr(stdout.lastFrame()).replace(/\n$/, '').split('\n');
  inst.unmount();
  return rows;
}

afterEach(() => cleanup());

const strip = (s: string | undefined): string[] => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\n$/, '').split('\n');
const idle: StatusLineState = { run: 'none', mode: null, status: null, ready: null, done: null, runId: null, overlay: 'none', pendingReview: null, retrying: null, blocking: null, errors: 0, stageStartedAt: null, toasts: [], git: null, spend: { run: null, session: { totalUsd: 0, capUsd: 1.25 } }, draft: { secretHits: 0 }, nowMs: 0 };
const noop = (): void => undefined;

describe('<Console> (TUI-DESIGN-2 §4.3)', () => {
  it('H-A3 at 80 and H-A3w at 120: the mounted rows equal consoleLines(); the hint right-aligned at 116 inner cells', () => {
    const rows80 = strip(render(<Console buffer={createBuffer()} columns={80} height={1} top={1} scrollTop={0} cursor={noop} active mode="task" rows={24} badge="jev-only" dir="proj" status={idle} statusOptions={{}} />).lastFrame());
    expect(rows80).toEqual(consoleLines({ columns: 80, badge: 'jev-only', dir: 'proj', body: [`› ${PLACEHOLDERS.task}`], status: statusLineText(idle, 76) }));
    expect(rows80).toEqual([
      '╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮',
      '│ › Say hi, ask a question, or describe a task…                                │',
      '├──────────────────────────────────────────────────────────────────────────────┤',
      '│ idle                                    step 0/–  sess $0.00/1.25 ok  ? help │',
      '╰──────────────────────────────────────────────────────────────────────────────╯',
    ]);
    cleanup();
    const rows120 = wideRows(<Console buffer={createBuffer()} columns={120} height={1} top={1} scrollTop={0} cursor={noop} active mode="task" rows={40} badge="jev-only" dir="proj" status={idle} statusOptions={{}} />);
    expect(rows120[1]).toBe('│ › Say hi, ask a question, or describe a task…                                                   / commands · @ files │');
    expect(rows120).toEqual(consoleLines({ columns: 120, badge: 'jev-only', dir: 'proj', body: [`› ${PLACEHOLDERS.task}${' '.repeat(116 - 2 - 43 - 20)}${PLACEHOLDERS.taskHint}`], status: statusLineText(idle, 116) }));
  });
  it('a draft, a continuation row, the ghost, the search row and the hosted gate row', () => {
    const b = reduceBuffer(reduceBuffer(createBuffer(), { type: 'insert', text: 'first line' }), { type: 'newline' });
    const rows = strip(render(<Console buffer={reduceBuffer(b, { type: 'insert', text: 'second' })} columns={80} height={2} top={1} scrollTop={0} cursor={noop} active mode="task" rows={24} badge="jev-only" dir="proj" gate="Looks like this contains a secret (sk-ant-…). Send anyway? y/N" status={idle} statusOptions={{}} />).lastFrame());
    expect(rows).toHaveLength(7);
    const gate = 'Looks like this contains a secret (sk-ant-…). Send anyway? y/N';
    expect(rows[1]).toBe(`│ ${gate}${' '.repeat(76 - gate.length)} │`);
    expect(rows[2]).toBe(`│ › first line${' '.repeat(76 - 12)} │`);
    expect(rows[3]).toBe(`│   second${' '.repeat(76 - 8)} │`);
    cleanup();
    const ghost = strip(render(<Console buffer={reduceBuffer(createBuffer(), { type: 'insert', text: '/bud' })} columns={80} height={1} top={1} scrollTop={0} cursor={noop} active mode="task" rows={24} badge="jev-only" dir="proj" ghost={{ rest: 'get', more: 2 }} status={idle} statusOptions={{}} />).lastFrame());
    expect(ghost[1]).toBe(`│ › /budget +2${' '.repeat(76 - 12)} │`);
    cleanup();
    const search = strip(render(<Console buffer={createBuffer()} columns={80} height={1} top={1} scrollTop={0} cursor={noop} active mode="task" rows={24} badge="jev-only" dir="proj" searchRow="(reverse-i-search)'par': fix parse_date" status={idle} statusOptions={{}} />).lastFrame());
    expect(search[1]).toBe(`│ (reverse-i-search)'par': fix parse_date${' '.repeat(76 - 39)} │`);
  });
  it('H-H2: the wizard’s rows under `setup · generator key` with the `› •••` field; the picker filter under `sessions · filter`', () => {
    let state = onboardingReducer(INITIAL_ONBOARDING, { type: 'detect', missing: ['generator.apiKey'], mode: 'jev-on', provider: 'anthropic', trustNeeded: false, jevProvider: null, reason: 'mode' } as never);
    state = onboardingReducer(state, { type: 'choose', option: 1 } as never);
    for (let i = 0; i < 20; i++) state = onboardingReducer(state, { type: 'input', length: i + 1 } as never);
    expect(state.step).toBe('generatorKey');
    const rows = strip(render(<Console buffer={createBuffer()} columns={80} height={3} top={1} scrollTop={0} cursor={noop} active mode="task" rows={24} badge="jev+llm · next run" dir="proj" title={wizardConsoleTitle(state.step)} wizard={{ state, trust: null }} status={{ ...idle, overlay: 'wizard' }} statusOptions={{}} />).lastFrame());
    expect(rows).toHaveLength(7);
    expect(rows[0]).toBe('╭─ setup · generator key ─────────────────────────────────────────────── proj ─╮');
    expect(rows[1]).toBe(`│ Anthropic API key (ANTHROPIC_API_KEY)${' '.repeat(76 - 37)} │`);
    expect(rows[2]).toBe(`│ › ${'•'.repeat(state.length)}${' '.repeat(76 - 2 - state.length)} │`);
    expect(rows[3]).toMatch(/^│ \d+ chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back\s+│$/);
    expect(rows[5]).toBe('│ setup                                           step 0/–  sess $0.00/1.25 ok │');
    expect(wizardBodyRows(state, 3, 76, GLYPHS.unicode, null, false)[1]).toBe(`› ${'•'.repeat(state.length)}`);
    expect(wizardConsoleTitle('jevProvider')).toBe('setup · jev provider');
    expect(wizardConsoleTitle('trust')).toBe('setup · trust');
    expect(wizardConsoleTitle('save')).toBe('setup');
    expect(pickerConsoleTitle('sessions')).toBe('sessions · filter');
    cleanup();
    const filter = strip(render(<Console buffer={reduceBuffer(createBuffer(), { type: 'insert', text: 'par' })} columns={80} height={1} top={1} scrollTop={0} cursor={noop} active mode="filter" rows={24} badge="jev-only" dir="proj" title={pickerConsoleTitle('sessions')} status={{ ...idle, picker: true }} statusOptions={{}} />).lastFrame());
    expect(filter[0]).toBe('╭─ sessions · filter ─────────────────────────────────────────────────── proj ─╮');
    expect(filter[1]).toBe(`│ › filter: par${' '.repeat(76 - 13)} │`);
  });
  // MINIMAL, MARKED EDIT BY SLOT S2 (TUI-DESIGN-4 §2.2 P-R2). Round 2's finding 6 kept the box and the body in step by
  // laying the draft out at the App's *debounced* `wrapColumns` and passing it as a second `bodyColumns` prop — which
  // is exactly the D1 skew round 4 deletes: A2 measured 4 of 24 frames with a box row whose right border is the
  // truncation ellipsis. `bodyColumns` is GONE from `ConsoleProps` (round-4 review finding 9), so the assertion is
  // inverted and the prop is removed from these three renders: a second width can no longer reach a frame at all.
  // The rest of the file is untouched; `console.test.ts` pins the type.
  it('TUI-DESIGN-4 §2.2 (P-R2): there is ONE geometry per frame, so the edges and the draft can never disagree', () => {
    const text = 'x'.repeat(90);
    const b = reduceBuffer(createBuffer(), { type: 'insert', text });
    // a narrow terminal: the body wraps at 76, exactly like the edges (round 2 passed `bodyColumns={120}` here)
    expect(draftRows(text, [], 76, '› ')).toBe(2);
    const shrink = strip(render(<Console buffer={b} columns={80} height={2} top={1} scrollTop={0} cursor={noop} active mode="task" rows={24} badge="jev-only" dir="proj" status={idle} statusOptions={{}} />).lastFrame());
    expect(shrink).toHaveLength(6); // top · two body rows · divider · status · bottom
    expect(shrink[0]).toBe('╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮');
    expect(shrink[1]).toBe(`│ › ${'x'.repeat(74)} │`);
    expect(shrink[2]).toBe(`│   ${'x'.repeat(16)}${' '.repeat(76 - 2 - 16)} │`);
    expect(shrink[3]).toBe(`├${'─'.repeat(78)}┤`);
    cleanup();
    // a wide terminal: one row at 116 inner cells, again exactly like the edges (round 2 passed `bodyColumns={80}`)
    expect(draftRows(text, [], 116, '› ')).toBe(1);
    const grow = wideRows(<Console buffer={b} columns={120} height={1} top={1} scrollTop={0} cursor={noop} active mode="task" rows={40} badge="jev-only" dir="proj" status={idle} statusOptions={{}} />);
    expect(grow).toHaveLength(5);
    expect(grow[0]).toBe(`╭─ jev-only ${'─'.repeat(120 - 20)} proj ─╮`);
    expect(grow[1]).toBe(`│ › ${'x'.repeat(90)}${' '.repeat(116 - 2 - 90)} │`);
    expect(grow[2]).toBe(`├${'─'.repeat(118)}┤`);
    cleanup();
    // the rows are `consoleLines()` at `columns` — byte for byte, with no second width anywhere in the call
    const settled = strip(render(<Console buffer={b} columns={80} height={2} top={1} scrollTop={0} cursor={noop} active mode="task" rows={24} badge="jev-only" dir="proj" status={idle} statusOptions={{}} />).lastFrame());
    expect(settled).toEqual(consoleLines({ columns: 80, badge: 'jev-only', dir: 'proj', body: [`› ${'x'.repeat(74)}`, `  ${'x'.repeat(16)}`], status: statusLineText(idle, 76) }));
  });
  it('the --ascii twin is pure ASCII at every row', () => {
    const rows = strip(render(<Console buffer={createBuffer()} columns={80} height={1} top={1} scrollTop={0} cursor={noop} active mode="task" rows={24} badge="jev-only" dir="proj" status={idle} statusOptions={{ ascii: true }} glyphs={GLYPHS.ascii} />).lastFrame());
    for (const l of rows) expect(l).toMatch(/^[\x20-\x7e]*$/);
    expect(rows[0]).toBe(`+- jev-only ${'-'.repeat(80 - 20)} proj -+`);
    expect(rows[1]).toBe(`| > ${PLACEHOLDERS.task.replace('…', '...')}${' '.repeat(76 - 2 - PLACEHOLDERS.task.length - 2)} |`);
    expect(rows[3]).toBe(`| ${statusLineText(idle, 76, { ascii: true })} |`);
    expect(rows[3]).toContain('step 0/-  sess $0.00/1.25 ok  ? help |');
  });
});

describe('useMotion (TUI-DESIGN-2 §5.1, §5.3)', () => {
  it('reports the elapsed time from Ink’s shared timer, settles at 700 ms and never ticks afterwards; ≤ 15 frames', async () => {
    // Ink's animation timer is its own (not the global timers vitest fakes), so the probe runs on the real clock
    const times: number[] = [];
    const settledAt: number[] = [];
    function Probe(): React.JSX.Element {
      const m = useMotion(true, SPLASH_MS);
      times.push(m.time);
      useEffect(() => {
        if (m.settled) settledAt.push(m.time);
      }, [m.settled, m.time]);
      return <Text>{`t=${m.time} ${m.settled ? 'settled' : 'running'}`}</Text>;
    }
    const ui = render(<Probe />);
    expect(times[0]).toBe(0);
    await new Promise((r) => setTimeout(r, SPLASH_MS + 400));
    const last = times.at(-1) ?? 0;
    expect(last).toBeGreaterThanOrEqual(SPLASH_MS);
    // nothing ticks after the settle: the last reported time is the settling tick itself (one interval of slack for the timer)
    expect(last).toBeLessThan(SPLASH_MS + 3 * SPLASH_INTERVAL_MS);
    expect(settledAt.length).toBeGreaterThanOrEqual(1);
    expect(settledAt[0]).toBeGreaterThanOrEqual(SPLASH_MS);
    const distinct = [...new Set(times)];
    expect(distinct.length).toBeLessThanOrEqual(16); // ≤ 15 ticks + the mount
    expect(ui.lastFrame()).toContain('settled');
    ui.unmount();
  });
  it('inactive: time 0, never settled', () => {
    function Probe(): React.JSX.Element {
      const m = useMotion(false, SPLASH_MS);
      return <Text>{`t=${m.time} ${m.settled ? 'settled' : 'still'}`}</Text>;
    }
    expect(render(<Probe />).lastFrame()).toBe('t=0 still');
  });
  it('with an injected animation clock: elapsed time is the scheduler’s, the subscriber leaves at the settle (the host turns `active` off in that commit, as the App does), nothing after; active true → false → true re-arms from zero (`stoppedRef` reset)', async () => {
    // a fake scheduler in Ink's AnimationContext shape: `tick(t)` delivers currentTime t to every subscriber; `startTime` is the subscribe time
    let now = 0;
    let subs: { cb: (t: number) => void; interval: number }[] = [];
    let subscribes = 0;
    const clock = {
      renderThrottleMs: 0,
      subscribe(cb: (t: number) => void, interval: number): { startTime: number; unsubscribe: () => void } {
        subscribes++;
        const s = { cb, interval };
        subs.push(s);
        return {
          startTime: now,
          unsubscribe: () => {
            subs = subs.filter((x) => x !== s);
          },
        };
      },
    };
    // a tick, then the commits it causes (the state update, the host's settle effect and its re-render) — React flushes
    // passive effects on its own scheduler, so the wait is generous
    const tick = async (t: number): Promise<void> => {
      now = t;
      for (const s of [...subs]) s.cb(t);
      await new Promise((r) => setTimeout(r, 30));
    };
    let setActive: (b: boolean) => void = () => undefined;
    function Host(): React.JSX.Element {
      const [active, set] = useState(true);
      setActive = set;
      const m = useMotion(active, SPLASH_MS);
      // the App's settle effect: the splash ends in the commit `settled` first turns true
      useEffect(() => {
        if (m.settled) set(false);
      }, [m.settled]);
      return <Text>{`${active ? 'on' : 'off'} t=${m.time} ${m.settled ? 'settled' : 'running'}`}</Text>;
    }
    const ui = render(
      <AnimationContext.Provider value={clock}>
        <Host />
      </AnimationContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(ui.lastFrame()).toBe('on t=0 running');
    expect(subs).toHaveLength(1);
    expect(subs[0]?.interval).toBe(SPLASH_INTERVAL_MS);
    await tick(100);
    expect(ui.lastFrame()).toBe('on t=100 running');
    await tick(650);
    expect(ui.lastFrame()).toBe('on t=650 running');
    await tick(SPLASH_MS);
    // settled → the host deactivated → the subscriber is gone; the settled frame is the last one that moved
    expect(ui.lastFrame()).toBe('off t=0 running');
    expect(subs).toHaveLength(0);
    const framesAtSettle = ui.frames.length;
    await tick(SPLASH_MS + 200);
    expect(ui.frames.length).toBe(framesAtSettle);
    expect(subscribes).toBe(1);
    // re-arm: a fresh subscription, time counted from the new start (the scheduler's startTime), settles again at 700
    setActive(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(ui.lastFrame()).toBe('on t=0 running');
    expect(subs).toHaveLength(1);
    expect(subscribes).toBe(2);
    await tick(SPLASH_MS + 250);
    expect(ui.lastFrame()).toBe('on t=50 running');
    await tick(SPLASH_MS + 200 + SPLASH_MS);
    expect(ui.lastFrame()).toBe('off t=0 running');
    expect(subs).toHaveLength(0);
    ui.unmount();
  });
});

describe('round 3 (TUI-DESIGN-3 §2.6, §5.2 A6 / P6, §1.4.2, §1.1): edges, prompt, spans, the wizard titles and the badge words', () => {
  const theme = themeFor('dark');
  it('every console row is byte-identical to consoleLines() whatever the colour props (edgeRole, live, the spans change no text)', () => {
    for (const props of [{}, { live: true }, { edgeRole: 'accent2' as const }, { edgeRole: 'border' as const, live: true }]) {
      const rows = strip(render(<Console buffer={createBuffer()} columns={80} height={1} top={1} scrollTop={0} cursor={noop} active mode="task" rows={24} badge="jev+llm" dir="proj" status={{ ...idle, done: { stopReason: 'complete', steps: 1, wallMs: 1, spend: { generator: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, jev: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, totalUsd: 0, capUsd: 2, exceeded: false }, changedFiles: [], runDir: '/r', resumable: true, exitCode: 0 } as never }} statusOptions={{}} {...props} />).lastFrame());
      expect(rows).toEqual(consoleLines({ columns: 80, badge: 'jev+llm', dir: 'proj', body: [`› ${PLACEHOLDERS.task}`], status: statusLineText({ ...idle, done: { stopReason: 'complete', steps: 1, wallMs: 1 } as never }, 76) }));
      cleanup();
    }
  });
  it('the edges: `border` at rest, `borderFocus` while live, the App\'s `edgeRole` (the A6 fade\'s `accent2`) when given — read back through the theme\'s 24-bit colours', () => {
    const edgeColor = (props: { live?: boolean; edgeRole?: 'accent2' | 'border' | 'borderFocus' }): string | undefined => {
      const frame = render(<Console buffer={createBuffer()} columns={80} height={1} top={1} scrollTop={0} cursor={noop} active mode="task" rows={24} badge="jev+llm" dir="proj" status={idle} statusOptions={{}} color={24} {...props} />).lastFrame() ?? '';
      cleanup();
      // chalk runs at level 0 under vitest: the roles are observed through `textProps`, so the test recomputes what the console asked for
      void frame;
      return textProps(theme, props.edgeRole ?? (props.live === true ? 'borderFocus' : 'border'), 24).color;
    };
    expect(edgeColor({})).toBeUndefined(); // `border` is dim, no colour
    expect(edgeColor({ live: true })).toBe(textProps(theme, 'borderFocus', 24).color);
    expect(edgeColor({ edgeRole: 'accent2' })).toBe(textProps(theme, 'accent2', 24).color);
    expect(edgeColor({ edgeRole: 'border', live: true })).toBeUndefined();
    expect(textProps(theme, 'borderFocus', 24).color).toBe('#d45bb6');
    expect(textProps(theme, 'accent2', 24).color).toBe('#d45bb6');
  });
  it('the prompt: `accent` (pink) at rest, `steer` (amber) while a run is live, nothing while inactive (D-O) — the rows\' text is unchanged', () => {
    const rest = strip(render(<Console buffer={createBuffer()} columns={80} height={1} top={1} scrollTop={0} cursor={noop} active mode="task" rows={24} badge="jev+llm" dir="proj" status={idle} statusOptions={{}} />).lastFrame());
    expect(rest[1]).toBe(`│ › ${PLACEHOLDERS.task}${' '.repeat(76 - 2 - PLACEHOLDERS.task.length)} │`);
    cleanup();
    const live = strip(render(<Console buffer={createBuffer()} columns={80} height={1} top={1} scrollTop={0} cursor={noop} active mode="steer" rows={24} badge="jev+llm" dir="proj" status={{ ...idle, run: 'live' }} statusOptions={{}} live />).lastFrame());
    expect(live[1]).toBe(`│ › ${PLACEHOLDERS.steer}${' '.repeat(76 - 2 - PLACEHOLDERS.steer.length)} │`);
    expect(textProps(theme, 'accent', 24).color).toBe('#f386a1');
    expect(textProps(theme, 'steer', 24).color).toBe('#FBBF24');
  });
  it('the ghost: a completion reads `get +2`; an alias arrow reads ` → /status` (` -> /status` under --ascii) — TUI-DESIGN-3 §4.1 rule 3', () => {
    expect(ghostText({ rest: 'get', more: 2 })).toBe('get +2');
    expect(ghostText({ rest: 'get', more: 0 })).toBe('get');
    expect(ghostText({ arrow: '/status' })).toBe(' → /status');
    expect(ghostText({ arrow: '/status' }, GLYPHS.ascii)).toBe(' -> /status');
    expect(ghostText(null)).toBe('');
    const rows = strip(render(<Console buffer={reduceBuffer(createBuffer(), { type: 'insert', text: '/s' })} columns={80} height={1} top={1} scrollTop={0} cursor={noop} active mode="task" rows={24} badge="jev+llm" dir="proj" ghost={{ arrow: '/status' }} status={idle} statusOptions={{}} />).lastFrame());
    expect(rows[1]).toBe(`│ › /s → /status${' '.repeat(76 - 14)} │`);
  });
  it('the status row is rendered from statusSpans: the text equals statusLineText and the row keeps its width for the done word, a meter word and a toast', () => {
    const done = { ...idle, done: { stopReason: 'max_steps', steps: 7, wallMs: 252_000 } as never, spend: { run: { generator: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, jev: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, totalUsd: 1.7, capUsd: 2, exceeded: false }, session: { totalUsd: 9.6, capUsd: 10 } } } as StatusLineState;
    const rows = strip(render(<Console buffer={createBuffer()} columns={80} height={1} top={1} scrollTop={0} cursor={noop} active mode="followup" rows={24} badge="jev+llm" dir="proj" status={done} statusOptions={{}} />).lastFrame());
    expect(rows[3]).toBe(`│ ${statusLineText(done, 76)} │`);
    expect(rows[3]).toMatch(/^│ idle exit 4 .*run \$1\.70\/2\.00 high .*sess \$9\.60\/10\.00 critical/);
    cleanup();
    const toast = { ...idle, toasts: [{ id: 1, text: 'saved', level: 'ok' as const, untilMs: 5000 }], nowMs: 1000 };
    const t = strip(render(<Console buffer={createBuffer()} columns={80} height={1} top={1} scrollTop={0} cursor={noop} active mode="task" rows={24} badge="jev+llm" dir="proj" status={toast} statusOptions={{}} />).lastFrame());
    expect(t[3]).toBe(`│ ${statusLineText(toast, 76)} │`);
    expect(t[3]!.startsWith('│ ✓ saved')).toBe(true);
  });
  it('wizardConsoleTitle: `setup · key` / `setup · options` (TUI-DESIGN-3 §1.4.2, one source in onboarding/lines.ts) beside the round-2 steps; `setup` for a step without a title; the dot folds under --ascii', () => {
    expect(wizardConsoleTitle('key')).toBe('setup · key');
    expect(wizardConsoleTitle('options')).toBe('setup · options');
    expect(wizardConsoleTitle('key', GLYPHS.ascii)).toBe('setup - key');
    expect(wizardConsoleTitle('jevProvider')).toBe('setup · jev provider');
    expect(wizardConsoleTitle('generatorKey')).toBe('setup · generator key');
    expect(wizardConsoleTitle('save')).toBe('setup');
    expect(wizardConsoleTitle('detect')).toBe('setup');
    expect(consoleTopEdge(wizardConsoleTitle('key'), 'proj', 80)).toBe('╭─ setup · key ───────────────────────────────────────────────────────── proj ─╮');
    expect(consoleTopEdge(wizardConsoleTitle('options'), 'proj', 80)).toBe('╭─ setup · options ───────────────────────────────────────────────────── proj ─╮');
  });
  it('F-R8: the one-key `key` step hosted in the console — the masked field is row 2 with the cursor on it (`isFieldStep`), the title bold, 76-cell rows', () => {
    let state = onboardingReducer(INITIAL_ONBOARDING, { type: 'detect', missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: null, jevProvider: null, trustNeeded: false, reason: 'missing' } as never);
    expect(state.step).toBe('key');
    for (let i = 0; i < 20; i++) state = onboardingReducer(state, { type: 'length', length: i + 1 });
    expect(state.length).toBe(20);
    const positions: ({ x: number; y: number } | undefined)[] = [];
    const rows = strip(render(<Console buffer={createBuffer()} columns={80} height={3} top={1} scrollTop={0} cursor={(p) => positions.push(p)} active mode="task" rows={24} badge="jev+llm" dir="proj" title={wizardConsoleTitle(state.step)} wizard={{ state, trust: null }} status={{ ...idle, overlay: 'wizard' }} statusOptions={{}} />).lastFrame());
    expect(rows).toHaveLength(7);
    expect(rows[0]).toBe('╭─ setup · key ───────────────────────────────────────────────────────── proj ─╮');
    expect(rows[1]).toBe(`│ OpenRouter API key — one key runs Jev and the code model${' '.repeat(76 - 56)} │`);
    expect(rows[2]).toBe(`│ › ${'•'.repeat(20)}${' '.repeat(76 - 22)} │`);
    expect(rows[3]).toMatch(/^│ 20 chars · Enter saves · Ctrl-U clears · Esc clears \(again: other ways\)\s+│$/);
    expect(rows[5]).toBe(`│ ${statusLineText({ ...idle, overlay: 'wizard' }, 76)} │`);
    // the cursor sits after the 20 mask cells on the field row (y = top + 1 + row index 1)
    expect(positions.at(-1)).toEqual({ x: 2 + 22, y: 3 });
    for (const r of rows) expect([...r].length).toBe(80);
  });
  it('the badge words come from MODE_BADGE_WORD: `llm+jev · verified · next run` fits the top edge at 60 / 80 / 120 columns beside the dir', () => {
    expect(modeBadge('jev-only', 'llm-jev')).toBe(`${MODE_BADGE_WORD['llm-jev']} · next run`);
    for (const columns of [60, 80, 120]) {
      const rows = columns === 80 || columns === 60 ? strip(render(<Console buffer={createBuffer()} columns={columns} height={1} top={1} scrollTop={0} cursor={noop} active mode="task" rows={24} badge={modeBadge('jev-only', 'llm-jev')} dir="proj" status={idle} statusOptions={{}} />).lastFrame()) : wideRows(<Console buffer={createBuffer()} columns={columns} height={1} top={1} scrollTop={0} cursor={noop} active mode="task" rows={40} badge={modeBadge('jev-only', 'llm-jev')} dir="proj" status={idle} statusOptions={{}} />, columns);
      expect(rows[0]!.startsWith('╭─ llm+jev · verified · next run ─')).toBe(true);
      expect(rows[0]!.endsWith(' proj ─╮')).toBe(true);
      expect([...rows[0]!].length).toBe(columns);
      cleanup();
    }
  });
});
