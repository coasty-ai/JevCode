/**
 * THE OWNER'S DIRECTIVE (2026-09-23): "Keep jevcode branding on top only and even after chat starts keep it there only
 * and chats appear after that" / "make sure the jevcode ascii design stays at top and chat is below the ascii design".
 * The real `<App>` on a stub TTY (`debug: true`, so every frame is the whole scrollback plus the dynamic region): the
 * classic renderer commits the SETTLED wordmark as the first `<Static>` block — at the settle, or before the first item
 * that would otherwise land above it (a submit before the settle, a `--resume` replay, the one-shot header) — and every
 * message lands BELOW it, with the console at the bottom. Pinned here:
 *
 *  - the order after the settle and two messages: wordmark → `[you]` → `[jevcode]` → rule → composer;
 *  - NOTHING moves at the commit: the splash box is the top of the dynamic region (box → rule → console) in exactly the
 *    rows the committed block takes, so the settled frame (mark → rule → console) is the same rows — no glyph row, no
 *    rule row and no console row moves;
 *  - a submit during the splash commits the mark FIRST, and nothing lands between it and the `[you]` bubble;
 *  - a replay (or any item) before the settle goes BELOW the mark; `jevcode run`'s task header waits for the commit
 *    (its reveal plays in the dynamic region like a session's) and lands directly below the mark;
 *  - the config decides: a mount that settles in frame 0 (reduced motion) or a one-shot mount commits only after
 *    `setUi`, so `ui.wordmark: off` and `ui.noColor` that arrive after the first frame are honoured;
 *  - the mark is committed exactly once: `/clear` (not a command in this build — nothing clears the classic transcript),
 *    `/new`, Ctrl+L and more messages never write a second one;
 *  - the width is read at the commit only: a session that starts at 50 columns and widens never drops a mark mid-chat;
 *  - the WHETHER rules: a screen reader, the flat tier and `ui.wordmark: off` commit none; `--ascii` commits the `#`
 *    twin; a 16-row terminal commits one (the TUI owner's rule for a committed mark: only the width tier and the boxed
 *    floor apply — the 21-row floor existed because the pinned mark held dynamic rows);
 *  - zero repaint at rest: after the commit no frame is written while the session idles (the idle sweep is off).
 */
// colour is forced before chalk is first imported (vitest runs each file in its own worker), so the `ui.noColor` case
// below can see the SGR it removes; every other assertion here reads SGR-stripped rows
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '3';
});

import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent, LaunchSettings, UiConfig } from '../../../src/core/types.js';
import { App, createBridge, type Bridge } from '../../../src/tui/App.js';
import { WORDMARK } from '../../../src/tui/splash.js';
import { scrollbackMarkPad, scrollbackMarkRows } from '../../../src/tui/wordmark.js';
import { createEventBus, createTuiConfirmer, type UiState } from '../../../src/tui/useEngine.js';
import { VERSION } from '../../../src/version.js';
import { mkUiConfig, tick } from '../../fixtures/tui/fixtures.js';
import { agentOpening, agentRunResult, shapedTurn } from './agent-fixtures.js';
import { StubStdin, StubStdout, isRuleRow, stripSgr } from './stub-stdout.js';

const unmounts: Array<() => void> = [];
afterEach(() => {
  for (const u of unmounts.splice(0)) u();
});

const MOTION: LaunchSettings & { reducedMotion: boolean } = { fps: 30, renderMode: 'standard', screenReader: false, ascii: false, noColor: false, reducedMotion: false };
const ENV: NodeJS.ProcessEnv = { FORCE_COLOR: '1' };
const CARET = '▍';

interface M {
  stdout: StubStdout;
  stdin: StubStdin;
  bus: ReturnType<typeof createEventBus>;
  bridge: Bridge;
  /** the last frame's rows: SGR and the caret stripped, trailing blanks trimmed */
  rows: () => string[];
  state: () => UiState | null;
}

function mount(rows: number, columns: number, o: { launch?: LaunchSettings & { reducedMotion?: boolean }; ui?: Partial<UiConfig>; mode?: 'session' | 'one-shot'; task?: string } = {}): M {
  const stdout = new StubStdout(rows, columns, true);
  const stdin = new StubStdin();
  const bus = createEventBus();
  const bridge = createBridge(null, null);
  const launch = o.launch ?? MOTION;
  if (o.ui) bridge.ui = mkUiConfig({ ...launch, reducedMotion: launch.reducedMotion ?? false }, o.ui);
  const instance = render(<App task={o.task ?? ''} resumeId={null} source={bus} confirmer={createTuiConfirmer()} onAbort={() => undefined} mode={o.mode ?? 'session'} cwd="/tmp/proj" tickMs={0} bridge={bridge} launch={launch} env={ENV} />, {
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
    rows: () => rowsOf(stdout.lastFrame()),
    state: () => bridge.stateReader?.() ?? null,
  };
}

/** `setUi` as the session calls it after the first frame (session.ts `applyConfig`) */
function setUi(m: M, launch: LaunchSettings & { reducedMotion?: boolean }, ui: Partial<UiConfig>): void {
  m.bridge.ui = mkUiConfig({ ...launch, reducedMotion: launch.reducedMotion ?? false }, ui);
  m.bridge.notify();
}

function rowsOf(frame: string): string[] {
  return stripSgr(frame)
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => l.replaceAll(CARET, '').trimEnd());
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return pred();
}

const markRow = (r: number, columns: number, g: readonly string[] = WORDMARK): string => `${' '.repeat(Math.floor((columns - 56) / 2))}${g[r]}`.replace(/\s+$/, '');
/** the index of every row that is the mark's glyph row 1 (the one row no caption or tagline ever touches) */
const markAt = (rows: readonly string[], columns: number): number[] => rows.flatMap((l, i) => (l === markRow(1, columns) ? [i] : []));
const ruleAt = (rows: readonly string[], columns: number): number => {
  for (let i = rows.length - 1; i >= 0; i--) if (isRuleRow(rows[i] ?? '', columns)) return i;
  return -1;
};
const edgeAt = (rows: readonly string[]): number => rows.findIndex((l) => l.startsWith('╭─'));
const settle = async (m: M): Promise<void> => {
  m.bridge.command({ type: 'dispatch', action: { type: 'splash:done' } });
  await tick(40);
};
const you = (m: M, text: string): void => m.bridge.command({ type: 'dispatch', action: { type: 'local', text, label: '[you]' } });
async function feed(m: M, events: readonly EngineEvent[]): Promise<void> {
  for (const e of events) {
    m.bus.emit(e);
    if (e.type === 'generator:delta') await tick(40);
  }
  await tick(120);
}
/** a whole agent reply: opening, one shaped turn, the end */
async function reply(m: M, task: string, text: string, runId = 'a1'): Promise<void> {
  await feed(m, agentOpening(task, runId));
  await feed(m, shapedTurn(1, 1, [text]));
  m.bus.emit({ type: 'run:end', result: agentRunResult('complete'), exitCode: 0 });
  await waitFor(() => (m.state()?.run ?? 'live') === 'none');
  await tick(60);
}

describe('the committed wordmark heads the scrollback', () => {
  it.each([
    [30, 100],
    [24, 80],
  ])('%ix%i: after the settle and two messages the order is wordmark → [you] → [jevcode] → rule → composer, the mark drawn once', async (rows, columns) => {
    const m = mount(rows, columns);
    await settle(m);
    // settled: the committed block is the top of the scrollback — its blank rows, the five glyph rows, its blank rows —
    // then the rule and the console
    const pad = scrollbackMarkPad(rows);
    let f = m.rows();
    const top = markAt(f, columns)[0]! - 1;
    expect(top).toBe(pad);
    expect(f.slice(0, pad).every((l) => l === '')).toBe(true);
    for (let r = 0; r < 4; r++) expect(f[top + r]).toBe(markRow(r, columns));
    expect(f[top + 4]).toBe(`${markRow(4, columns)}  ◆ ${VERSION}`);
    expect(f.slice(top + 5, top + 5 + pad).every((l) => l === '')).toBe(true);
    expect(ruleAt(f, columns)).toBe(top + 5 + pad);
    expect(f[ruleAt(f, columns)]).toBe('─'.repeat(columns));
    expect(edgeAt(f)).toBe(ruleAt(f, columns) + 1);
    // two messages
    you(m, 'hi');
    await reply(m, 'hi', 'Hello! What would you like to work on?\n');
    you(m, 'who made you');
    await reply(m, 'who made you', 'I am jevcode, built by the JevCode team.\n', 'a2');
    f = m.rows();
    const marks = markAt(f, columns);
    expect(marks, f.join('\n')).toHaveLength(1);
    const y1 = f.findIndex((l) => l.includes('[you] hi'));
    const j1 = f.findIndex((l) => l.includes('[jevcode] Hello!'));
    const y2 = f.findIndex((l) => l.includes('[you] who made you'));
    const j2 = f.findIndex((l) => l.includes('[jevcode] I am jevcode'));
    const rule = ruleAt(f, columns);
    const composer = f.findIndex((l, i) => i > rule && l.includes('› '));
    expect([marks[0]!, y1, j1, y2, j2, rule, composer].every((v) => v >= 0), JSON.stringify({ marks, y1, j1, y2, j2, rule, composer })).toBe(true);
    expect(marks[0]!).toBeLessThan(y1);
    expect(y1).toBeLessThan(j1);
    expect(j1).toBeLessThan(y2);
    expect(y2).toBeLessThan(j2);
    expect(j2).toBeLessThan(rule);
    expect(rule).toBeLessThan(composer);
    // nothing between the mark's bottom padding and the first bubble
    expect(y1).toBe(marks[0]! + 3 + pad + 1);
    // the whole frame is the scrollback above the one rule row: no mark row below it
    expect(f.slice(rule).some((l) => l.includes('██'))).toBe(false);
    // not one clear was written
    expect(m.stdout.frames.join('')).not.toContain('\x1b[2J');
  });

  it.each([
    [30, 100],
    [24, 80],
    [40, 120],
  ])('%ix%i: NOTHING moves at the commit — box → rule → console before, mark → rule → console after, the same rows', async (rows, columns) => {
    const m = mount(rows, columns);
    const box = scrollbackMarkRows(rows);
    await waitFor(() => m.rows().some((l) => l.endsWith(`◆ ${VERSION}`)), 1500);
    // the held splash frame (no scrollback yet, so its rows are the dynamic region): the box on top, the rule, the console
    const held = m.rows();
    expect(markAt(held, columns), held.join('\n')).toHaveLength(1);
    expect(ruleAt(held, columns)).toBe(box);
    expect(edgeAt(held)).toBe(box + 1);
    expect(m.state()?.splash).toBe('running');
    await settle(m);
    const f1 = m.rows();
    // the settled frame is the same rows: the glyph rows, the rule and the console's top edge kept their rows
    expect(f1).toEqual(held);
    expect(markAt(f1, columns)).toEqual(markAt(held, columns));
    expect(ruleAt(f1, columns)).toBe(box);
    expect(edgeAt(f1)).toBe(box + 1);
    expect(m.state()?.splash).toBe('done');
    // and every later frame keeps the rule directly above the console, with no mark below it
    you(m, 'hi');
    await reply(m, 'hi', 'Hello!\n');
    const f2 = m.rows();
    const r2 = ruleAt(f2, columns);
    expect(edgeAt(f2)).toBe(r2 + 1);
    expect(markAt(f2, columns)).toHaveLength(1);
    expect(markAt(f2, columns)[0]!).toBeLessThan(r2);
    expect(m.stdout.frames.join('')).not.toContain('\x1b[2J');
  });

  it('a submit during the splash commits the mark FIRST: the [you] bubble is the next block, nothing lands in between', async () => {
    const m = mount(30, 100);
    await tick(60);
    expect(m.state()?.splash).toBe('running');
    you(m, 'hi');
    await waitFor(() => m.rows().some((l) => l.includes('[you] hi')));
    const f = m.rows();
    const mark = markAt(f, 100);
    expect(mark).toHaveLength(1);
    const pad = scrollbackMarkPad(30);
    // the settled mark (the caption on row 4, no reveal head), then its blank rows, then the bubble
    expect(f[mark[0]! + 3]).toBe(`${markRow(4, 100)}  ◆ ${VERSION}`);
    expect(f.join('\n')).not.toMatch(/[▓▒░]{3}/);
    const y = f.findIndex((l) => l.includes('[you] hi'));
    expect(f.slice(mark[0]! + 4, y).every((l) => l === ''), JSON.stringify(f.slice(mark[0]! + 4, y))).toBe(true);
    expect(y).toBe(mark[0]! + 4 + pad);
    // the splash is over: no second mark in the dynamic region, ever
    await tick(900);
    expect(markAt(m.rows(), 100)).toHaveLength(1);
    expect(m.state()?.splash).toBe('done');
  });

  it('a replay before the settle (a `--resume`) lands BELOW the mark, not above it', async () => {
    const m = mount(30, 100);
    await tick(20);
    for (const t of ['earlier question', 'another one']) you(m, t);
    await waitFor(() => m.rows().some((l) => l.includes('[you] another one')));
    const f = m.rows();
    const mark = markAt(f, 100);
    expect(mark).toHaveLength(1);
    expect(mark[0]!).toBeLessThan(f.findIndex((l) => l.includes('[you] earlier question')));
  });

  it('one-shot (`jevcode run "<task>"`): frame 0 is splash frame 0 with no header; the reveal plays; the header lands directly below the committed mark', async () => {
    const m = mount(30, 100, { mode: 'one-shot', task: 'fix the failing test' });
    const f0 = rowsOf(m.stdout.frames[0] ?? '');
    // frame 0: the `J` column and the sweep head in the box, the status sentinel — and nothing committed yet
    expect(f0.join('\n')).toContain(`${WORDMARK[3]!.slice(0, 7)}▓▒░`);
    expect(f0.join('\n')).toContain('step 0/–');
    expect(f0.some((l) => l.includes('fix the failing test'))).toBe(false);
    // the reveal plays in the dynamic region (more than one splash frame before the commit)
    await waitFor(() => m.rows().some((l) => l.endsWith(`◆ ${VERSION}`)), 1500);
    expect(m.stdout.frames.filter((fr) => stripSgr(fr).includes('▓▒░')).length).toBeGreaterThan(1);
    expect(m.rows().some((l) => l.includes('fix the failing test'))).toBe(false);
    await settle(m);
    const f = m.rows();
    const mark = markAt(f, 100);
    expect(mark).toHaveLength(1);
    const header = f.findIndex((l) => l.includes('fix the failing test'));
    // the committed block (its bottom padding included), then the header: one item below the mark
    expect(header, f.join('\n')).toBe(mark[0]! + 4 + scrollbackMarkPad(30));
    expect(header).toBeLessThan(ruleAt(f, 100));
    await tick(200);
    expect(markAt(m.rows(), 100)).toHaveLength(1);
  });

  it('one-shot: the first run item before the settle commits the mark, then the header, then the item', async () => {
    const m = mount(30, 100, { mode: 'one-shot', task: 'fix the failing test' });
    await tick(60);
    expect(m.state()?.splash).toBe('running');
    you(m, 'an early item');
    await waitFor(() => m.rows().some((l) => l.includes('an early item')));
    const f = m.rows();
    const mark = markAt(f, 100)[0]!;
    const header = f.findIndex((l) => l.includes('fix the failing test'));
    const item = f.findIndex((l) => l.includes('an early item'));
    expect(mark).toBeGreaterThanOrEqual(0);
    expect(mark).toBeLessThan(header);
    expect(header).toBeLessThan(item);
  });
});

describe('the config arrives after the first frame: the commit waits for it', () => {
  const STILL = { ...MOTION, reducedMotion: true };
  it('reduced motion: frame 0 holds the resting mark in the splash box; the config commits it to the SAME rows', async () => {
    const m = mount(30, 100, { launch: STILL });
    const f0 = rowsOf(m.stdout.frames[0] ?? '');
    expect(markAt(f0, 100)).toHaveLength(1);
    expect(ruleAt(f0, 100)).toBe(scrollbackMarkRows(30));
    await tick(60);
    // still undecided: nothing is committed while the config is missing
    expect(m.rows()).toEqual(f0);
    setUi(m, STILL, {});
    await tick(40);
    const f1 = m.rows();
    expect(f1).toEqual(f0);
    you(m, 'hi');
    await waitFor(() => m.rows().some((l) => l.includes('[you] hi')));
    const f2 = m.rows();
    expect(markAt(f2, 100)).toHaveLength(1);
    expect(markAt(f2, 100)[0]!).toBeLessThan(f2.findIndex((l) => l.includes('[you] hi')));
  });

  const CASES: [string, { launch?: LaunchSettings & { reducedMotion?: boolean }; mode?: 'session' | 'one-shot'; task?: string }][] = [
    ['a reduced-motion session', { launch: { ...MOTION, reducedMotion: true } }],
    ['a one-shot run', { mode: 'one-shot', task: 'fix the failing test' }],
  ];
  it.each(CASES)('%s with `ui.wordmark: off` delivered by setUi after frame 0 commits NO mark', async (_name, o) => {
    const m = mount(30, 100, o);
    await tick(20);
    setUi(m, o.launch ?? MOTION, { wordmark: 'off' });
    await tick(40);
    await settle(m);
    you(m, 'hi');
    await waitFor(() => m.rows().some((l) => l.includes('[you] hi')));
    await tick(60);
    // at rest: not one mark cell in the scrollback or the dynamic region (debug mode: the frame is both)
    expect(m.rows().some((l) => l.includes('█'))).toBe(false);
    if (o.task !== undefined) expect(m.rows().some((l) => l.includes('fix the failing test'))).toBe(true);
  });

  it('`ui.noColor` delivered by setUi after frame 0 is honoured by the committed block (reduced motion)', async () => {
    const STILL_COLOR = { ...MOTION, reducedMotion: true };
    const m = mount(30, 100, { launch: STILL_COLOR });
    const markLines = (frame: string): string[] => frame.split('\n').filter((l) => stripSgr(l).includes('██'));
    // frame 0 (launch settings): the box's cells are coloured
    expect(markLines(m.stdout.frames[0] ?? '')).toHaveLength(5);
    expect(markLines(m.stdout.frames[0] ?? '').every((l) => l.includes('\x1b['))).toBe(true);
    setUi(m, STILL_COLOR, { noColor: true });
    await tick(60);
    you(m, 'hi');
    await waitFor(() => m.rows().some((l) => l.includes('[you] hi')));
    // the block committed after the config carries no SGR at all
    expect(markLines(m.stdout.lastFrame())).toHaveLength(5);
    for (const l of markLines(m.stdout.lastFrame())) expect(l).not.toContain('\x1b[');
  });
});

describe('committed exactly once', () => {
  it('`/clear` (not a command here: nothing clears the classic transcript), `/new` and Ctrl+L never write a second mark', async () => {
    const m = mount(30, 100);
    await settle(m);
    you(m, 'hi');
    await reply(m, 'hi', 'Hello!\n');
    for (const line of ['/clear', '/new']) {
      m.stdin.write(line);
      await waitFor(() => m.rows().some((l) => l.includes(`› ${line}`)));
      m.stdin.write('\r');
      await tick(120);
    }
    m.stdin.write('\x0c');
    await tick(120);
    const all = stripSgr(m.stdout.frames.join(''));
    // every frame carries the whole scrollback (debug mode): the LAST frame has the mark exactly once, at the top
    const f = m.rows();
    expect(markAt(f, 100)).toHaveLength(1);
    expect(markAt(f, 100)[0]!).toBeLessThan(f.findIndex((l) => l.includes('[you] hi')));
    expect(all).not.toContain('\x1b[2J');
  });

  it('the width is read at the commit only: 50 columns at the settle, widened to 100 mid-chat, commits no mark', async () => {
    const m = mount(30, 50);
    await settle(m);
    m.stdout.resize(30, 100);
    await tick(80);
    you(m, 'hi');
    await reply(m, 'hi', 'Hello!\n');
    await tick(200);
    expect(m.stdout.frames.some((fr) => stripSgr(fr).includes('██'))).toBe(false);
  });

  it('a mark committed at 100 columns stays the one mark after a narrow resize and a re-widen', async () => {
    const m = mount(30, 100);
    await settle(m);
    m.stdout.resize(30, 60);
    await tick(80);
    m.stdout.resize(30, 100);
    await tick(80);
    you(m, 'hi');
    await reply(m, 'hi', 'Hello!\n');
    expect(markAt(m.rows(), 100)).toHaveLength(1);
  });
});

describe('WHETHER a mark is drawn (the width tier; the height tiers were about dynamic rows only)', () => {
  it('a screen reader, the flat tier (15 rows) and `ui.wordmark: off` commit none; 16 rows (the boxed floor) commits one', async () => {
    const sr = mount(30, 100, { launch: { ...MOTION, screenReader: true } });
    await tick(60);
    const flat = mount(15, 100);
    await settle(flat);
    const off = mount(30, 100, { ui: { wordmark: 'off' } });
    await settle(off);
    const low = mount(16, 100);
    await settle(low);
    for (const m of [sr, flat, off]) {
      you(m, 'hi');
      await waitFor(() => m.rows().some((l) => l.includes('[you] hi')));
      expect(m.rows().some((l) => l.includes('██'))).toBe(false);
    }
    you(low, 'hi');
    await waitFor(() => low.rows().some((l) => l.includes('[you] hi')));
    expect(markAt(low.rows(), 100)).toHaveLength(1);
    expect(markAt(low.rows(), 100)[0]!).toBeLessThan(low.rows().findIndex((l) => l.includes('[you] hi')));
  });

  it('`--ascii` commits the `#` twin with the `* <version>` caption', async () => {
    const m = mount(30, 100, { launch: { ...MOTION, ascii: true } });
    await settle(m);
    const hash = WORDMARK.map((r) => r.replace(/█/g, '#'));
    const f = m.rows();
    const at = f.indexOf(markRow(1, 100, hash));
    expect(at).toBeGreaterThan(0);
    expect(f[at + 3]).toBe(`${markRow(4, 100, hash)}  * ${VERSION}`);
    expect(at).toBeLessThan(ruleAt(f, 100));
  });

  it('the tagline "Decisions, not strings" is committed on row 0 where it fits (≥ 104 columns)', async () => {
    const m = mount(40, 120);
    await settle(m);
    const f = m.rows();
    const at = markAt(f, 120)[0]!;
    expect(f[at - 1]).toBe(`${markRow(0, 120)}  Decisions, not strings`);
    // two blank rows each side at ≥ 34 rows (directive 3's generous padding)
    expect(f.slice(at - 3, at - 1)).toEqual(['', '']);
    expect(f.slice(at + 4, at + 6)).toEqual(['', '']);
  });
});

describe('zero repaint at rest', () => {
  it('after the commit the idle session writes no frame (the idle sweep never runs on a committed mark)', async () => {
    const m = mount(30, 100);
    await settle(m);
    await tick(200);
    const before = m.stdout.frames.length;
    // LOOP_REST_MS is 5.75 s; the old pinned mark's first idle pass would have started by now — wait past one rest
    await tick(6_300);
    expect(m.stdout.frames.length - before).toBe(0);
  }, 10_000);
});
