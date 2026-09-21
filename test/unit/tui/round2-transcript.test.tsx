/**
 * TUI-DESIGN-2 §4.5 / §9 / §8.1 S4 (`transcript.test.tsx` ext.): `[you]` / `[jevcode]` bubbles — dim label, `you` role body,
 * spacer rows (above a `[you]` turn, above the first `[jevcode]` of a turn, above run start / end — never between consecutive
 * `[jevcode]` items); the identity predicate in `full` (every row is `formatTranscriptItem(item)` wrapped with a hanging indent
 * of `label.length + 1`); the fence rule (`/^```\w*$/` → `╶──── <lang>`), the only text substitution beyond `--ascii`; and a
 * hidden-only batch leaves the `<Profiler>` commit count and `frames().length` unchanged (the `<Transcript>` is memoised).
 */
import { Profiler, memo, useState } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { Transcript, fenceRow, itemLabel, spacerAbove } from '../../../src/tui/Transcript.js';
import { GLYPHS } from '../../../src/tui/glyphs.js';
import { formatTranscriptItem, localItem, sessionHeaderItem, type TranscriptItem } from '../../../src/tui/plain.js';
import { useVisibleItems, type UiTranscriptItem } from '../../../src/tui/useEngine.js';

afterEach(() => cleanup());

const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\n$/, '');
const you = (text: string, seq: number): TranscriptItem => localItem(text, seq, { label: '[you]' });
const bot = (text: string, seq: number): TranscriptItem => localItem(text, seq, { label: '[jevcode]' });

/** the greedy word-wrap Ink applies (wrap-ansi, `hard: true`) with the hanging indent of the label column */
function wrapLike(line: string, width: number, indent: number): string[] {
  const words = line.split(' ');
  const rows: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur === '' ? w : `${cur} ${w}`;
    const limit = rows.length === 0 ? width : width - indent;
    if (next.length <= limit || cur === '') cur = next;
    else {
      rows.push(cur);
      cur = w;
    }
  }
  rows.push(cur);
  return rows.map((r, i) => (i === 0 ? r : `${' '.repeat(indent)}${r}`));
}

describe('bubbles and spacers (TUI-DESIGN-2 §4.5)', () => {
  it('H-B2: `[you] hi` then `[jevcode] …` with a spacer above each turn; the reply wraps with a hanging indent under the text column', () => {
    const header = sessionHeaderItem('/tmp/proj');
    const reply = "Hi. I'm ready when you are — describe a change you want in proj, or ask what I can do.";
    const ui = render(<Transcript items={[you('hi', 1), bot(reply, 2)]} header={header} />);
    const rows = strip(ui.lastFrame()).split('\n');
    expect(rows[0]).toBe('[run] jevcode session · proj | step 0/– starting');
    expect(rows[1]).toBe('');
    expect(rows[2]).toBe('[you] hi');
    expect(rows[3]).toBe('');
    // ink-testing-library's stdout is 100 columns: the reply wraps once, the continuation hangs under the text column
    expect(rows.slice(4)).toEqual(wrapLike(`[jevcode] ${reply}`, 100, '[jevcode]'.length + 1));
    expect(rows.slice(4).join(' ').replace(/\s+/g, ' ')).toBe(`[jevcode] ${reply}`);
  });
  it('a long body wraps at `columns − label − 1` with the hanging indent, never past the commit width (§3.10 / §9; the pty identity gate: `[sandbox] …` measured 89 cells at 80 columns)', () => {
    // Ink's `<Static>` box is absolute and fit-content: without an exact width Yoga sizes the row by content and the body wraps at the full width beside the label
    const sandbox = 'seatbelt — writes confined to the workspace and run dirs; harness secret files, ~/.ssh, ~/.aws unreadable; reads elsewhere and network allowed unless --no-network';
    const items = [localItem(sandbox, 1, { label: '[sandbox]' }), bot("Hi. I'm ready when you are — describe a change you want in a rather long workspace name, or ask what I can do about it today.", 2)];
    const rows = strip(render(<Transcript items={items} columns={80} />).lastFrame()).split('\n');
    for (const row of rows) expect([...row].length, `row wider than 80 columns: ${JSON.stringify(row)}`).toBeLessThanOrEqual(80);
    const sandboxRows = rows.slice(0, rows.indexOf(''));
    expect(sandboxRows).toEqual(wrapLike(`[sandbox] ${sandbox}`, 80, '[sandbox]'.length + 1));
    expect(sandboxRows.length).toBeGreaterThan(1);
    expect(sandboxRows.join(' ').replace(/\s+/g, ' ')).toBe(`[sandbox] ${sandbox}`);
    // the bubble too: continuation rows hang under the text column
    const botRows = rows.slice(rows.indexOf('') + 1);
    expect(botRows).toEqual(wrapLike(formatTranscriptItem(items[1]!), 80, '[jevcode]'.length + 1));
    expect(botRows.length).toBeGreaterThan(1);
  });
  it('consecutive [jevcode] items have no spacer between them (H-C1); [step N] and [ui] rows have none; [run] start / end have one', () => {
    const items = [you('what can you do?', 1), bot('JevCode is a coding agent.', 2), bot('Mode: jev-only.', 3), bot('Switch with /mode jev-on.', 4), localItem('mode jev-only already', 5)];
    const rows = strip(render(<Transcript items={items} />).lastFrame()).split('\n');
    expect(rows).toEqual(['[you] what can you do?', '', '[jevcode] JevCode is a coding agent.', '[jevcode] Mode: jev-only.', '[jevcode] Switch with /mode jev-on.', '[ui] mode jev-only already']);
    expect(spacerAbove(bot('a', 1), bot('b', 0))).toBe(false);
    expect(spacerAbove(bot('a', 1), you('b', 0))).toBe(true);
    expect(spacerAbove(you('a', 1), bot('b', 0))).toBe(true);
    expect(spacerAbove(you('a', 1), null)).toBe(false);
    const runStart: TranscriptItem = { key: 'run:start:1', seq: 1, step: null, kind: 'run:start', level: 'info', text: 'start r1 mode=jev-only task: t' };
    expect(spacerAbove(runStart, you('a', 0))).toBe(true);
    expect(spacerAbove({ ...runStart, kind: 'step', step: 3, text: 'edit kth.py' } as TranscriptItem, runStart)).toBe(false);
    expect(itemLabel(runStart)).toBe('[run]');
    expect(itemLabel({ ...runStart, step: 3 })).toBe('[step 3]');
    expect(itemLabel(you('x', 0))).toBe('[you]');
  });
  it('identity in `full`: every row of every item is formatTranscriptItem(item), one per line, byte for byte when it fits', () => {
    const items = [you('hi', 1), bot('Hi.', 2), localItem('why s7.risk.plan_mismatch', 3), localItem('saved', 4, { label: '[setup]' })];
    const rows = strip(render(<Transcript items={items} />).lastFrame()).split('\n').filter((r) => r !== '');
    expect(rows).toEqual(items.map((i) => formatTranscriptItem(i)));
  });
  it('the fence rule: a line that is exactly ``` or ```lang draws `╶──── <lang>` / `╶────` (`-----` under --ascii); anything else is untouched', () => {
    expect(fenceRow('```py')).toEqual({ text: '╶──── py', fence: true });
    expect(fenceRow('```')).toEqual({ text: '╶────', fence: true });
    expect(fenceRow('```py', GLYPHS.ascii)).toEqual({ text: '----- py', fence: true });
    expect(fenceRow('```py extra')).toEqual({ text: '```py extra', fence: false });
    expect(fenceRow('x = 1')).toEqual({ text: 'x = 1', fence: false });
    const rows = strip(render(<Transcript items={[bot('```py', 1), bot('x = 1', 2), bot('```', 3)]} />).lastFrame()).split('\n');
    expect(rows).toEqual(['[jevcode] ╶──── py', '[jevcode] x = 1', '[jevcode] ╶────']);
  });
});

describe('a hidden-only batch dirties no <Static> subtree (TUI-DESIGN-2 §4.5, §13 finding 12)', () => {
  it('appending hidden items leaves the Profiler commit count of the transcript and frames().length unchanged; a visible item renders once', async () => {
    let commits = 0;
    let push: (items: UiTranscriptItem[]) => void = () => undefined;
    const count = (): void => {
      commits++;
    };
    // the Profiler sits under a memoised wrapper keyed on the visible array, exactly as the App hands `<Static>` its items
    const Measured = memo(function Measured({ items }: { items: readonly UiTranscriptItem[] }): React.JSX.Element {
      return (
        <Profiler id="transcript" onRender={count}>
          <Transcript items={items} />
        </Profiler>
      );
    });
    function Host(): React.JSX.Element {
      const [items, setItems] = useState<UiTranscriptItem[]>([you('hi', 1)]);
      push = (more) => setItems((cur) => [...cur, ...more]);
      const visible = useVisibleItems(items, 0);
      return <Measured items={visible} />;
    }
    const ui = render(<Host />);
    await new Promise((r) => setTimeout(r, 20));
    const commitsBefore = commits;
    const framesBefore = ui.frames.length;
    const hidden: UiTranscriptItem = { ...localItem('intent=edit p=0.9', 2), kind: 'intent', hidden: true };
    push([hidden, { ...hidden, key: 'h2', seq: 3 }]);
    await new Promise((r) => setTimeout(r, 40));
    // the Host re-rendered, but `visibleItems` gave the same rows: the memoised <Transcript> committed nothing new
    expect(commits).toBe(commitsBefore);
    expect(ui.frames.length).toBe(framesBefore);
    expect(strip(ui.lastFrame())).not.toContain('intent=edit');
    push([bot('Hi.', 4)]);
    await new Promise((r) => setTimeout(r, 40));
    expect(commits).toBeGreaterThan(commitsBefore);
    expect(strip(ui.lastFrame())).toContain('[jevcode] Hi.');
  });
});
