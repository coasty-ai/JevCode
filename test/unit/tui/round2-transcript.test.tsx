/**
 * TUI-DESIGN-2 §4.5 / §9 / §8.1 S4 (`transcript.test.tsx` ext.), TUI-DESIGN-3 §5.1 / §5.3 (D-L, D-O): `[you]` / `[jevcode]` bubbles —
 * the label in its pink (bold), the body default; the 10-cell right-aligned label gutter (bodies at column 10, wrapped rows hanging
 * there, `[step 100]` pushing the body by its excess); spacer rows (above a `[you]` turn, above the first `[jevcode]` of a turn, above
 * run start / end, above a `[ui]` item with a detail body — never between consecutive `[jevcode]` items); detail rows indented under
 * the body column with the epilogue's `label     value` rows hanging under the value; the identity predicate as the §5.3 normaliser
 * (strip leading spaces, join with one space, collapse runs → `formatTranscriptItem(item)`) with the F-R4 step row and `[run] end …` /
 * `exit 4` as explicit cases; the fence rule (`/^```\w*$/` → `╶──── <lang>`), the only text substitution beyond `--ascii`; and a
 * hidden-only batch leaves the `<Profiler>` commit count and `frames().length` unchanged (the `<Transcript>` is memoised).
 */
import { Profiler, memo, useState } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { LABEL_GUTTER, Transcript, bodyRole, bodyRows, bodyWidth, detailRows, fenceRow, gutterLabel, itemLabel, labelProps, normaliseRows, spacerAbove } from '../../../src/tui/Transcript.js';
import { stringWidth } from '../../../src/tui/composer/width.js';
import { GLYPHS } from '../../../src/tui/glyphs.js';
import { formatTranscriptItem, localItem, sessionHeaderItem, type TranscriptItem } from '../../../src/tui/plain.js';
import { textProps, themeFor } from '../../../src/tui/theme.js';
import { useVisibleItems, type UiTranscriptItem } from '../../../src/tui/useEngine.js';
import { epilogueItemLines } from '../../../src/cli/epilogue.js';

afterEach(() => cleanup());

const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\n$/, '');
const you = (text: string, seq: number): TranscriptItem => localItem(text, seq, { label: '[you]' });
const bot = (text: string, seq: number): TranscriptItem => localItem(text, seq, { label: '[jevcode]' });
const G = ' '.repeat(LABEL_GUTTER);

/** the rows of one item: from its label row to the row before the next label row (blank rows and continuations included) */
function itemRows(rows: readonly string[], labelRow: number): string[] {
  const out = [rows[labelRow]!];
  for (let i = labelRow + 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (r === '' || /^\s{0,9}\[[^\]]+\] /.test(r) && !r.startsWith(G)) break;
    out.push(r);
  }
  return out;
}

describe('bubbles and spacers (TUI-DESIGN-2 §4.5, TUI-DESIGN-3 §5.1)', () => {
  it('H-B2 / F-R3: `[you] hi` then `[jevcode] …` with a spacer above each turn; every body starts at column 10 and the reply hangs under it', () => {
    const header = sessionHeaderItem('/tmp/proj');
    const reply = "Hi. I'm ready when you are — describe a change you want in proj, or ask what I can do.";
    const ui = render(<Transcript items={[you('hi', 1), bot(reply, 2)]} header={header} columns={80} />);
    const rows = strip(ui.lastFrame()).split('\n');
    expect(rows[0]).toBe('    [run] jevcode session · proj | step 0/– starting');
    expect(rows[1]).toBe('');
    expect(rows[2]).toBe('    [you] hi');
    expect(rows[3]).toBe('');
    // F-R3 at 80 columns: the reply wraps once at the 70-cell body width and the continuation hangs at column 10
    expect(rows.slice(4)).toEqual(['[jevcode] Hi. I\'m ready when you are — describe a change you want in proj, or', `${G}ask what I can do.`]);
    expect(normaliseRows(rows.slice(4))).toBe(`[jevcode] ${reply}`);
    for (const r of rows) expect(stringWidth(r)).toBeLessThanOrEqual(80);
  });
  it('a long body wraps at `columns − 10` with the hanging indent, never past the commit width (§3.10 / §9 / D-L; the pty identity gate)', () => {
    const sandbox = 'seatbelt — writes confined to the workspace and run dirs; harness secret files, ~/.ssh, ~/.aws unreadable; reads elsewhere and network allowed unless --no-network';
    const items = [localItem(sandbox, 1, { label: '[sandbox]' }), bot("Hi. I'm ready when you are — describe a change you want in a rather long workspace name, or ask what I can do about it today.", 2)];
    const rows = strip(render(<Transcript items={items} columns={80} />).lastFrame()).split('\n');
    for (const row of rows) expect(stringWidth(row), `row wider than 80 columns: ${JSON.stringify(row)}`).toBeLessThanOrEqual(80);
    const sandboxRows = rows.slice(0, rows.indexOf(''));
    expect(sandboxRows[0]!.startsWith('[sandbox] ')).toBe(true);
    expect(sandboxRows.length).toBeGreaterThan(1);
    for (const r of sandboxRows.slice(1)) expect(r.startsWith(G)).toBe(true);
    expect(sandboxRows).toEqual(bodyRows(sandbox, 80, '[sandbox]').map((r, i) => (i === 0 ? `[sandbox] ${r}` : `${G}${r}`)));
    expect(normaliseRows(sandboxRows)).toBe(`[sandbox] ${sandbox}`);
    // the bubble too: continuation rows hang under the body column
    const botRows = rows.slice(rows.indexOf('') + 1);
    expect(botRows.length).toBeGreaterThan(1);
    for (const r of botRows.slice(1)) expect(r.startsWith(G)).toBe(true);
    expect(normaliseRows(botRows)).toBe(formatTranscriptItem(items[1]!));
  });
  it('consecutive items with the SAME label have no spacer (H-C1); a label change, `[run]` start / end and a `[ui]` item with a detail body have one (owner directive 3)', () => {
    const items = [you('what can you do?', 1), bot('JevCode is a coding agent.', 2), bot('Mode: jev-only.', 3), bot('Switch with /mode jev-on.', 4), localItem('mode jev-only already', 5)];
    const rows = strip(render(<Transcript items={items} columns={80} />).lastFrame()).split('\n');
    expect(rows).toEqual(['    [you] what can you do?', '', '[jevcode] JevCode is a coding agent.', '[jevcode] Mode: jev-only.', '[jevcode] Switch with /mode jev-on.', '', '     [ui] mode jev-only already']);
    expect(spacerAbove(bot('a', 1), bot('b', 0))).toBe(false);
    expect(spacerAbove(bot('a', 1), you('b', 0))).toBe(true);
    expect(spacerAbove(you('a', 1), bot('b', 0))).toBe(true);
    expect(spacerAbove(you('a', 1), null)).toBe(false);
    const runStart: TranscriptItem = { key: 'run:start:1', seq: 1, step: null, kind: 'run:start', level: 'info', text: 'start r1 mode=jev-only task: t' };
    expect(spacerAbove(runStart, you('a', 0))).toBe(true);
    // owner directive 3: a `[step n]` head is a new block under `[run]`, so it gets its blank row…
    expect(spacerAbove({ ...runStart, kind: 'step', step: 3, text: 'edit kth.py' } as TranscriptItem, runStart)).toBe(true);
    // …and the step's own further rows (the same label) stay contiguous under it
    const step3: TranscriptItem = { ...runStart, kind: 'step', step: 3, text: 'edit kth.py' } as TranscriptItem;
    expect(spacerAbove({ ...step3, key: 'k2', text: 'outcome ok' } as TranscriptItem, step3)).toBe(false);
    expect(spacerAbove({ ...step3, key: 'k3', step: 4, text: 'run tests' } as TranscriptItem, step3)).toBe(true);
    // TUI-DESIGN-3 §5.1 rule 9: a `[ui]` head with a detail body (the epilogue, /jev, /cost, /help) reads as a block
    expect(spacerAbove(localItem('cost', 6, { detail: 'run $0.310 of $2.000' }), localItem('x', 5))).toBe(true);
    expect(spacerAbove(localItem('cost', 6), localItem('x', 5))).toBe(false);
    expect(spacerAbove(localItem('cost', 6, { detail: 'a' }), null)).toBe(false);
    expect(itemLabel(runStart)).toBe('[run]');
    expect(itemLabel({ ...runStart, step: 3 })).toBe('[step 3]');
    expect(itemLabel(you('x', 0))).toBe('[you]');
  });
  it('identity in `full` (§5.3 normaliser): every item\'s rows re-join to formatTranscriptItem(item); a row that fits is the padded label + the text', () => {
    const items = [you('hi', 1), bot('Hi.', 2), localItem('why s7.risk.plan_mismatch', 3), localItem('saved', 4, { label: '[setup]' })];
    const rows = strip(render(<Transcript items={items} columns={80} />).lastFrame()).split('\n').filter((r) => r !== '');
    expect(rows).toEqual(['    [you] hi', '[jevcode] Hi.', '     [ui] why s7.risk.plan_mismatch', '  [setup] saved']);
    expect(rows.map((r) => normaliseRows([r]))).toEqual(items.map((i) => formatTranscriptItem(i)));
  });
  it('the fence rule: a line that is exactly ``` or ```lang draws `╶──── <lang>` / `╶────` (`-----` under --ascii); anything else is untouched', () => {
    expect(fenceRow('```py')).toEqual({ text: '╶──── py', fence: true });
    expect(fenceRow('```')).toEqual({ text: '╶────', fence: true });
    expect(fenceRow('```py', GLYPHS.ascii)).toEqual({ text: '----- py', fence: true });
    expect(fenceRow('```py extra')).toEqual({ text: '```py extra', fence: false });
    expect(fenceRow('x = 1')).toEqual({ text: 'x = 1', fence: false });
    const rows = strip(render(<Transcript items={[bot('```py', 1), bot('x = 1', 2), bot('```', 3)]} columns={80} />).lastFrame()).split('\n');
    expect(rows).toEqual(['[jevcode] ╶──── py', '[jevcode] x = 1', '[jevcode] ╶────']);
  });
});

describe('the label gutter, the wrap rule and detail rows in a mounted transcript (TUI-DESIGN-3 §5.1 rules 1, 3, 4; D-L)', () => {
  const STEP = 'run $ python -m pytest -q tests/test_core.py · risk 0.00 ok · tests 4p/3f/0e · judge 0.49 · 4.9s · $0.006';
  const END = 'end replan_stop steps=9 wall=14s cost=$0.025 (gen $0.000, jev $0.025) exit 4';
  const step = (n: number, text: string): TranscriptItem => ({ key: `step:${n}`, seq: n, step: n, kind: 'step', level: 'info', text });
  const runItem = (kind: 'run:start' | 'run:end', text: string, seq: number): TranscriptItem => ({ key: `${kind}:${seq}`, seq, step: null, kind, level: 'info', text });

  it('gutterLabel / bodyWidth: `[jevcode]` flush, shorter labels padded, `[step 100]` touches the edge, longer labels push the body', () => {
    expect(LABEL_GUTTER).toBe(10);
    expect(gutterLabel('[jevcode]')).toBe('[jevcode]');
    expect(gutterLabel('[sandbox]')).toBe('[sandbox]');
    expect(gutterLabel('[you]')).toBe('    [you]');
    expect(gutterLabel('[run]')).toBe('    [run]');
    expect(gutterLabel('[ui]')).toBe('     [ui]');
    expect(gutterLabel('[step 7]')).toBe(' [step 7]');
    expect(gutterLabel('[step 40]')).toBe('[step 40]');
    expect(gutterLabel('[step 100]')).toBe('[step 100]');
    expect(gutterLabel('[step 1000]')).toBe('[step 1000]');
    expect(bodyWidth(80, '[you]')).toBe(70);
    expect(bodyWidth(80, '[jevcode]')).toBe(70);
    expect(bodyWidth(80, '[step 100]')).toBe(69);
    expect(bodyWidth(120, '[ui]')).toBe(110);
  });
  it('F-R4 at 80 columns: the task bubble wraps by the word rule, `[run] start` by the word rule, the step row breaks before ` · ` with the separator leading', () => {
    const task = 'Fix the failing tests in tests/test_core.py without changing the tests.';
    const git: TranscriptItem = { key: 'ws:3', seq: 3, step: null, kind: 'workspace', level: 'info', text: 'git main · 3 modified · 1 untracked' };
    const items = [you(task, 1), runItem('run:start', `start 20260921-212813-uo5luiq4 mode=jev-on task: ${task}`, 2), git, step(1, STEP)];
    const rows = strip(render(<Transcript items={items} columns={80} />).lastFrame()).split('\n');
    expect(rows).toEqual([
      '    [you] Fix the failing tests in tests/test_core.py without changing the',
      `${G}tests.`,
      '',
      '    [run] start 20260921-212813-uo5luiq4 mode=jev-on task: Fix the failing tests',
      `${G}in tests/test_core.py without changing the tests.`,
      '    [run] git main · 3 modified · 1 untracked',
      '',
      ' [step 1] run $ python -m pytest -q tests/test_core.py · risk 0.00 ok',
      `${G}· tests 4p/3f/0e · judge 0.49 · 4.9s · $0.006`,
    ]);
    for (const r of rows) expect(stringWidth(r)).toBeLessThanOrEqual(80);
    // §5.3: every item re-joins to its one-line form; the separator survives the join without any separator clause
    expect(normaliseRows(rows.slice(0, 2))).toBe(formatTranscriptItem(items[0]!));
    expect(normaliseRows(rows.slice(3, 5))).toBe(formatTranscriptItem(items[1]!));
    expect(normaliseRows(rows.slice(7, 9))).toBe(`[step 1] ${STEP}`);
    expect(normaliseRows(rows.slice(7, 9))).toContain('risk 0.00 ok · tests 4p/3f/0e');
  });
  it('F-R6 at 80 columns: `[run] end … (gen $0.000, jev $0.025)` / `exit 4` — the orphan rule moves `exit` down; the epilogue\'s detail rows hang under their values', () => {
    const id = '20260921-212813-uo5luiq4';
    const epilogue = epilogueItemLines(null, { runId: id, runDir: `/Users/me/.jevcode/runs/${id}`, resumable: true, stopReason: 'replan_stop', home: '/Users/me' }, (x) => x);
    const items = [step(9, 'edit calc/core.py "fix issue" · risk 0.99 [block] · blocked · judge 0.10 · 1.2s · $0.003'), runItem('run:end', END, 10), localItem(epilogue.text, 11, { detail: epilogue.detail.join('\n') })];
    const rows = strip(render(<Transcript items={items} columns={80} />).lastFrame()).split('\n');
    const endAt = rows.findIndex((r) => r.startsWith('    [run] end'));
    expect(rows[endAt - 1]).toBe('');
    expect(rows[endAt]).toBe('    [run] end replan_stop steps=9 wall=14s cost=$0.025 (gen $0.000, jev $0.025)');
    expect(rows[endAt + 1]).toBe(`${G}exit 4`);
    expect(normaliseRows(rows.slice(endAt, endAt + 2))).toBe(`[run] ${END}`);
    // the `[ui] stopped` head has a spacer above (rule 9) and its four detail rows sit under column 10; `files` hangs under its value
    expect(rows[endAt + 2]).toBe('');
    expect(rows[endAt + 3]).toBe('     [ui] stopped — replan_stop (exit 4)');
    // TUI-DESIGN-4 §3.1.3 / §3.3: the epilogue is a BLOCK now — its kv rows sit at the 10-cell key column with a
    // one-cell separator (value column 11, `epilogue.ts`'s old `padEnd(10)` plus the separator §3.1.3 declares),
    // and the block itself wraps the `files` / `report` rows under that column at the body width (§3.4's measured
    // motivation: a continuation at column 0 read as a new key). The transcript's own `detailRows` hang is then a
    // no-op on rows the block already fitted.
    expect(rows.slice(endAt + 4)).toEqual([
      `${G}run        ${id}`,
      `${G}files      ~/.jevcode/runs/${id}/  (transcript.log,`,
      `${G}           state.json, jevcode.log)`,
      `${G}resume     jevcode run --resume ${id}`,
      `${G}report     jevcode report ${id}   (redacted bundle`,
      `${G}           written locally; nothing is sent)`,
    ]);
    for (const r of rows) expect(stringWidth(r)).toBeLessThanOrEqual(80);
  });
  it('detailRows: a `label  value` row hangs under the value, a plain detail row wraps like a body, one row without a width', () => {
    // the double-space gap before the parenthetical is a group boundary: the parenthetical moves whole to the hanging row, and is
    // word-wrapped only when it is wider than the hang's row
    expect(detailRows('files     ~/x/  (transcript.log, state.json, jevcode.log)', 60)).toEqual(['files     ~/x/  (transcript.log, state.json, jevcode.log)']);
    expect(detailRows('files     ~/x/  (transcript.log, state.json, jevcode.log)', 52)).toEqual(['files     ~/x/', '          (transcript.log, state.json, jevcode.log)']);
    expect(detailRows('files     ~/x/  (transcript.log, state.json, jevcode.log)', 40)).toEqual(['files     ~/x/', '          (transcript.log, state.json,', '          jevcode.log)']);
    expect(detailRows('run $0.310 of $2.000 (15 %)', 70)).toEqual(['run $0.310 of $2.000 (15 %)']);
    expect(detailRows('a · b · c', 5)).toEqual(['a · b', '· c']);
    expect(detailRows('anything at all', undefined)).toEqual(['anything at all']);
    // a head as wide as the row falls back to the body rule
    expect(detailRows(`${'x'.repeat(30)}  value here`, 32).length).toBeGreaterThan(1);
  });
  it('steps ≥ 100 push the body by the excess and still re-join; 120 columns gives a 110-cell body', () => {
    const rows = strip(render(<Transcript items={[step(100, STEP), step(1000, STEP)]} columns={80} />).lastFrame()).split('\n');
    expect(rows[0]!.startsWith('[step 100] run $')).toBe(true);
    expect(rows.find((r) => r.startsWith('[step 1000] '))).toBeDefined();
    const first = itemRows(rows, 0);
    expect(normaliseRows(first)).toBe(`[step 100] ${STEP}`);
    const wide = strip(render(<Transcript items={[step(1, STEP)]} columns={120} />).lastFrame()).split('\n');
    expect(wide).toEqual([` [step 1] ${STEP}`]);
  });
  it('label roles (D-O): `[jevcode]` assistant bold, `[you]` you bold, every other label dim; bodies default, warn / error by level, dim for `[run] git …` only', () => {
    const theme = themeFor('dark');
    expect(labelProps(bot('x', 1), theme, 24)).toEqual({ ...textProps(theme, 'assistant', 24), bold: true });
    expect(labelProps(you('x', 1), theme, 24)).toEqual({ ...textProps(theme, 'you', 24), bold: true });
    expect(labelProps(localItem('x', 1), theme, 24)).toEqual(textProps(theme, 'dim', 24));
    expect(labelProps(step(1, 'x'), theme, 24)).toEqual(textProps(theme, 'dim', 24));
    expect(labelProps(bot('x', 1), theme, false)).toEqual({});
    expect(bodyRole(you('x', 1))).toBeNull();
    expect(bodyRole(bot('x', 1))).toBeNull();
    expect(bodyRole(localItem('x', 1))).toBeNull();
    expect(bodyRole(step(1, 'x'))).toBeNull();
    expect(bodyRole(localItem('x', 1, { level: 'warn' }))).toBe('warn');
    expect(bodyRole(localItem('x', 1, { level: 'error' }))).toBe('error');
    expect(bodyRole({ ...step(1, 'x'), verdict: 'block' })).toBe('error');
    expect(bodyRole({ ...step(1, 'x'), verdict: 'review' })).toBe('warn');
    expect(bodyRole({ key: 'w', seq: 1, step: null, kind: 'workspace', level: 'info', text: 'git main · 3 modified' })).toBe('dim');
    // (chalk runs at level 0 under vitest, so SGR bytes are not observable here — the roles above are the contract; the pty
    // `theme-pink.steps` scenario reads the `38;5;211` / `38;5;169` bytes of the two labels from a real capture)
    const frame = strip(render(<Transcript items={[you('hi', 1), bot('Hi.', 2)]} columns={80} color={24} />).lastFrame());
    expect(frame.split('\n')).toEqual(['    [you] hi', '', '[jevcode] Hi.']);
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
