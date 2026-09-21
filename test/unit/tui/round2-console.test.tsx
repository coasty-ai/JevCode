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
import { Console, pickerConsoleTitle, wizardBodyRows, wizardConsoleTitle } from '../../../src/tui/Console.js';
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
  it('finding 6: `bodyColumns` (the App’s debounced width) lays the draft out while the edges follow `columns` — inside the 50 ms debounce the rows the layout granted and the rows the box wraps agree', () => {
    const text = 'x'.repeat(90);
    const b = reduceBuffer(createBuffer(), { type: 'insert', text });
    // shrink 120 → 80: the edges already at 80, the body still wrapped at 120 (one row, as `composerWant` at 116 inner cells says)
    expect(draftRows(text, [], 116, '› ')).toBe(1);
    const shrink = strip(render(<Console buffer={b} columns={80} bodyColumns={120} height={draftRows(text, [], 116, '› ')} top={1} scrollTop={0} cursor={noop} active mode="task" rows={24} badge="jev-only" dir="proj" status={idle} statusOptions={{}} />).lastFrame());
    expect(shrink).toHaveLength(5); // top · one body row · divider · status · bottom
    expect(shrink[0]).toBe('╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮');
    expect(shrink[1]?.startsWith(`│ › ${'x'.repeat(60)}`)).toBe(true);
    expect(shrink[2]).toBe(`├${'─'.repeat(78)}┤`);
    cleanup();
    // grow 80 → 120: the edges at 120, the body still wrapped at 80 (two rows, as `composerWant` at 76 inner cells says)
    expect(draftRows(text, [], 76, '› ')).toBe(2);
    const grow = wideRows(<Console buffer={b} columns={120} bodyColumns={80} height={draftRows(text, [], 76, '› ')} top={1} scrollTop={0} cursor={noop} active mode="task" rows={40} badge="jev-only" dir="proj" status={idle} statusOptions={{}} />);
    expect(grow).toHaveLength(6);
    expect(grow[0]).toBe(`╭─ jev-only ${'─'.repeat(120 - 20)} proj ─╮`);
    expect(grow[1]).toBe(`│ › ${'x'.repeat(74)} │`);
    expect(grow[2]).toBe(`│   ${'x'.repeat(16)}${' '.repeat(76 - 2 - 16)} │`);
    expect(grow[3]).toBe(`├${'─'.repeat(118)}┤`);
    // settled (bodyColumns === columns, or omitted): identical to consoleLines()
    const settled = strip(render(<Console buffer={b} columns={80} bodyColumns={80} height={2} top={1} scrollTop={0} cursor={noop} active mode="task" rows={24} badge="jev-only" dir="proj" status={idle} statusOptions={{}} />).lastFrame());
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
