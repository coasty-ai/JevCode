/**
 * AGENT-LOOP-DESIGN §9.4 / §A1 (slice S5a; TUI map top change 6): the agent's prose streams IN PLACE as a reply block
 * above the rule and lands in `<Static>` with zero jump — the real `<App>` mounted at 30×100 and 24×80 (with a resize
 * step), fed a fake agent event stream (the agent factory is a stub in this tree). Ink runs in debug mode, so every frame
 * is the whole scrollback plus the dynamic region: a commit that moved nothing leaves the frame's rows identical.
 */
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent, LaunchSettings } from '../../../src/core/types.js';
import { App, createBridge, type Bridge } from '../../../src/tui/App.js';
import { createEventBus, createTuiConfirmer, type UiState } from '../../../src/tui/useEngine.js';
import { stringWidth } from '../../../src/tui/composer/width.js';
import { tick } from '../../fixtures/tui/fixtures.js';
import { agentOpening, agentRunResult, agentStep, shapedTurn } from './agent-fixtures.js';
import { StubStdin, StubStdout, isRuleRow, stripSgr } from './stub-stdout.js';

const unmounts: Array<() => void> = [];
afterEach(() => {
  for (const u of unmounts.splice(0)) u();
});

/** reduced motion: the caret is steady (always on), the splash is done at mount; NO_COLOR keeps the rows plain */
const STILL: LaunchSettings = { fps: 30, renderMode: 'standard', screenReader: false, ascii: false, noColor: true, reducedMotion: true };
const CARET = '▍';

interface Mounted {
  stdout: StubStdout;
  bus: ReturnType<typeof createEventBus>;
  bridge: Bridge;
  state: () => UiState | null;
}

function mount(rows: number, columns: number): Mounted {
  const stdout = new StubStdout(rows, columns);
  const stdin = new StubStdin();
  const bus = createEventBus();
  const bridge = createBridge(null, null);
  const instance = render(<App task="" resumeId={null} source={bus} confirmer={createTuiConfirmer()} onAbort={() => undefined} mode="session" cwd="/tmp/proj" tickMs={0} now={() => 1_000_000} bridge={bridge} launch={STILL} env={{}} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  unmounts.push(() => instance.unmount());
  return { stdout, bus, bridge, state: () => bridge.stateReader?.() ?? null };
}

/** The frame's rows, SGR and the caret stripped, trailing spaces trimmed (the terminal draws nothing there). */
function rowsOf(frame: string): string[] {
  return stripSgr(frame)
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => l.replaceAll(CARET, '').trimEnd());
}

/**
 * Emit events one by one, pausing after every `generator:delta`, then wait out the stream scheduler (250 ms under the
 * reduced motion these mounts use) so the last frame shows everything emitted.
 */
async function feed(m: Mounted, events: readonly EngineEvent[], afterDelta = 45): Promise<void> {
  for (const e of events) {
    m.bus.emit(e);
    if (e.type === 'generator:delta') await tick(afterDelta);
  }
  await tick(300);
}

function youBubble(m: Mounted, text: string): void {
  m.bridge.command({ type: 'dispatch', action: { type: 'local', text, label: '[you]' } });
}

/** The index of the rule row (the first row of the dynamic region below the reply block) in a frame's rows. */
function ruleIndex(rows: readonly string[], columns: number): number {
  for (let i = rows.length - 1; i >= 0; i--) if (isRuleRow(rows[i] ?? '', columns)) return i;
  return -1;
}

describe('the agent reply block: prose streams in place and commits with zero jump', () => {
  it.each([
    [30, 100],
    [24, 80],
  ])('%ix%i: a newline-free partial line is drawn as text above the rule; the committed rows equal the last live rows (no clears, no jump)', async (rows, columns) => {
    const m = mount(rows, columns);
    await tick(60);
    youBubble(m, 'what does calc do?');
    await feed(m, agentOpening('what does calc do?'));
    // the first token: text at once, never a `streaming… N chars` counter
    await feed(m, [{ type: 'generator:delta', step: 1, text: 'calc is a small' }]);
    let frame = rowsOf(m.stdout.lastFrame());
    expect(frame.join('\n')).toContain('[jevcode] calc is a small');
    expect(frame.join('\n')).not.toMatch(/streaming… \d+ chars/);
    // the block sits ABOVE the rule
    const r = ruleIndex(frame, columns);
    expect(frame.findIndex((l) => l.includes('[jevcode] calc is a small'))).toBeLessThan(r);
    // finish the line; the frame before the commit shows the whole line in the block
    await feed(m, [{ type: 'generator:delta', step: 1, text: ' expression parser with a REPL.\n' }]);
    const before = rowsOf(m.stdout.lastFrame());
    m.bus.emit({ type: 'assistant:text', step: 1, turn: 1, attempt: 1, text: 'calc is a small expression parser with a REPL.', final: false });
    await tick(60);
    const after = rowsOf(m.stdout.lastFrame());
    // zero jump: the same rows, now half of them in <Static>
    expect(after).toEqual(before);
    expect(m.state()?.items.some((i) => i.prose !== undefined && i.text === 'calc is a small expression parser with a REPL.')).toBe(true);
    expect(m.state()?.live).toBe('');
    // no clear was ever written
    expect(m.stdout.frames.join('')).not.toContain('\x1b[2J');
    // a second paragraph after a blank line: the blank line is kept, the reply stays one contiguous block
    await feed(m, shapedTurn(1, 1, ['\n', 'It reads a line, ', 'tokenises it and\n', 'prints the value.']));
    frame = rowsOf(m.stdout.lastFrame());
    const i0 = frame.findIndex((l) => l.includes('calc is a small expression parser'));
    expect(frame[i0 + 1]).toMatch(/^\s*\[jevcode\]$/);
    expect(frame[i0 + 2]).toContain('[jevcode] It reads a line, tokenises it and');
    expect(frame[i0 + 3]).toContain('[jevcode] prints the value.');
    // one blank row between the [you] bubble and the reply, none inside it
    const you = frame.findIndex((l) => l.includes('[you] what does calc do?'));
    expect(frame[you + 1]).toBe('');
    expect(i0).toBe(you + 2);
    for (const l of frame) expect(stringWidth(l)).toBeLessThanOrEqual(columns);
  });

  it('resize mid-stream (30×100 → 24×80): the block re-wraps at the new width and the commit still moves nothing', async () => {
    const m = mount(30, 100);
    await tick(60);
    youBubble(m, 'explain');
    await feed(m, agentOpening('explain'));
    await feed(m, [{ type: 'generator:delta', step: 1, text: 'The parser walks the tokens left to right and folds every operator into a tree' }]);
    m.stdout.resize(24, 80);
    await tick(120);
    await feed(m, [{ type: 'generator:delta', step: 1, text: ' before it evaluates anything at all.\n' }]);
    const before = rowsOf(m.stdout.lastFrame());
    expect(before.some((l) => l.startsWith('[jevcode] The parser walks'))).toBe(true);
    for (const l of before.slice(-22)) expect(stringWidth(l)).toBeLessThanOrEqual(80);
    m.bus.emit({ type: 'assistant:text', step: 1, turn: 1, attempt: 1, text: 'The parser walks the tokens left to right and folds every operator into a tree before it evaluates anything at all.', final: false });
    await tick(60);
    expect(rowsOf(m.stdout.lastFrame())).toEqual(before);
  });

  it('a 3,200-character paragraph at 24×80 never paints more than rows − 2 dynamic rows: its finished rows commit early (overflow) and the final commit still moves nothing', async () => {
    const m = mount(24, 80);
    await tick(60);
    youBubble(m, 'tell me everything');
    await feed(m, agentOpening('tell me everything'));
    const words = Array.from({ length: 480 }, (_, i) => `word${i}`).join(' ');
    const para = words.slice(0, 3200);
    const chunks: string[] = [];
    for (let i = 0; i < para.length; i += 160) chunks.push(para.slice(i, i + 160));
    for (const c of chunks) {
      await feed(m, [{ type: 'generator:delta', step: 1, text: c }], 45);
      const rows = rowsOf(m.stdout.lastFrame());
      const r = ruleIndex(rows, 80);
      // the dynamic region is the reply block's rows plus everything from the rule down
      const block = m.state()?.reply !== undefined ? rows.length - r : 0;
      expect(block).toBeLessThanOrEqual(22);
    }
    // rows committed before the line ended (the block kept within its cap)
    expect(m.state()?.items.some((i) => i.prose !== undefined && i.prose.to !== undefined)).toBe(true);
    const before = rowsOf(m.stdout.lastFrame());
    m.bus.emit({ type: 'assistant:text', step: 1, turn: 1, attempt: 1, text: para, final: true });
    await tick(60);
    const after = rowsOf(m.stdout.lastFrame());
    expect(after).toEqual(before);
    // every word landed exactly once, in order, in the scrollback
    const flat = after.join(' ').replace(/\s+/g, ' ');
    const first = flat.indexOf('word0 ');
    const tail = flat.slice(first);
    expect(tail.includes(para.slice(-40).trim().split(' ').slice(-2).join(' '))).toBe(true);
    expect(tail.match(/word1 /g)?.length).toBe(1);
  });

  it('a tool-less turn reads as chat: no step row, no `[run] finished`, the `[jevcode]` reply only (§A1)', async () => {
    const m = mount(30, 100);
    await tick(60);
    youBubble(m, 'hi');
    await feed(m, agentOpening('hi'));
    await feed(m, shapedTurn(1, 1, ['Hi! ', 'What should we work on?']));
    await feed(m, [
      { type: 'generator:end', step: 1, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001, calls: 1 }, latencyMs: 300, finishReason: 'stop' },
      { type: 'proposal', step: 1, proposal: { goal: 'finish', action: { kind: 'done', summary: 'Hi!' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' } },
      { type: 'outcome', step: 1, outcome: { status: 'noop', summary: 'done' } },
      { type: 'step:end', record: agentStep(1, { kind: 'finish', action: { kind: 'done', summary: 'Hi!' }, outcome: { status: 'noop', summary: 'done' } }), costUsd: { generator: 0.0001, jev: 0 } },
      { type: 'run:end', result: agentRunResult('answered'), exitCode: 0 },
    ]);
    const text = rowsOf(m.stdout.lastFrame()).join('\n');
    expect(text).toContain('[jevcode] Hi! What should we work on?');
    expect(text).not.toContain('[step 1]');
    expect(text).not.toContain('[run] finished');
    expect(text).not.toContain('[run] started');
    // the held rows exist for the dumps, hidden
    expect(m.state()?.items.filter((i) => i.kind === 'run:end').every((i) => (i as { hidden?: boolean }).hidden === true)).toBe(true);
  });
});
