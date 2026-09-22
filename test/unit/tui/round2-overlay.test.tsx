/**
 * TUI-DESIGN-2 §4.7 / §4.2 / §8.1 S4 (`overlay.test.tsx` ext.): the boxed wants (review 9, followup 5, blocking ≤ 6, undo 3,
 * exitConfirm 3, intake 3, palette ≤ 8, secret 0, wizard `wizardRows`); the cards `exit?`, `undo`, `commands`, `files`, the
 * blocking card, the intake card (`run this as a task?`, H-I1) and their flat twins (today's rows); the review invariants in
 * the boxed tier (only `y` approves, Enter inert, no default) through the mounted App.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockingRequest } from '../../../src/core/types.js';
import { CAP } from '../../../src/tui/layout.js';
import { render as inkRender } from 'ink';
import { EXIT_CONFIRM_ROW, EXIT_CONFIRM_ROW_COMPACT, Overlay, exitConfirmRow, intakeCardLines, overlayWant, type IntakeOverlay, type OverlayData } from '../../../src/tui/Overlay.js';
import { cardRow, cardTop } from '../../../src/tui/card.js';
import { StubStdin, StubStdout, stripSgr } from './stub-stdout.js';

const probes = vi.hoisted(() => ({ roles: [] as string[], texts: [] as string[] }));

// every `textProps(theme, role, on)` the overlay asks for, in render order — the colour observable (chalk runs at level 0 under vitest, so no SGR is written)
vi.mock('../../../src/tui/theme.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/tui/theme.js')>();
  return {
    ...actual,
    textProps: (theme: Parameters<typeof actual.textProps>[0], role: Parameters<typeof actual.textProps>[1], on: Parameters<typeof actual.textProps>[2]) => {
      probes.roles.push(role);
      return actual.textProps(theme, role, on);
    },
  };
});
beforeEach(() => {
  probes.roles.length = 0;
});

/** ink-testing-library's stdout is 100 columns wide; the 120-column cards render through Ink with a 120-column stub */
function wideRows(el: React.JSX.Element, columns = 120): string[] {
  const stdout = new StubStdout(40, columns);
  const inst = inkRender(el, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: new StubStdin() as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
  const rows = stripSgr(stdout.lastFrame()).replace(/\n$/, '').split('\n');
  inst.unmount();
  return rows;
}
import { stringWidth } from '../../../src/tui/composer/width.js';
import { detectSecrets } from '../../../src/core/redact.js';
import { INITIAL_ONBOARDING, onboardingReducer } from '../../../src/tui/onboarding/reducer.js';
import { mkConfirmRequest } from '../../fixtures/tui/fixtures.js';

afterEach(() => cleanup());

const strip = (s: string | undefined): string[] => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\n$/, '').split('\n');
const blocking: BlockingRequest = { id: 'b1', step: 0, kind: 'key-rejected', side: 'jev', detail: 'HTTP 401 — "User not found."', sources: ['env JEV_API_KEY', 'OPENROUTER_API_KEY'], stop: 'error', exitCode: 2 };
const followup = { runCapUsd: 2, clampedToUsd: 0.42, sessionSpentUsd: 9.58, sessionCapUsd: 10, runs: 5, lastRunUsd: 0.71 };
const paletteState = { lastStop: null, unauthorized: false, changedFiles: false, rewindMenu: false, live: false };
const intake: IntakeOverlay = { title: 'run this as a task?', body: ['[y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)'], flat: ['run this as a task?  [y] run it  [n] just chatting  Esc keeps the text'] };

describe('overlayWant in the boxed tier (TUI-DESIGN-2 §4.2)', () => {
  it('review 9 · followup 5 · blocking ≤ 6 · undo 3 · exitConfirm 3 · intake 3 · palette ≤ 8 · secret 0 · wizard rows; the flat wants are unchanged', () => {
    const wizard = onboardingReducer(INITIAL_ONBOARDING, { type: 'detect', missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false, jevProvider: null, reason: 'missing' } as never);
    const data: OverlayData = { review: { req: mkConfirmRequest(), note: null }, wizard: { state: wizard, trust: null }, followup, secret: { hits: detectSecrets(`sk-ant-api03-${'A'.repeat(40)}`) }, blocking, palette: { query: '/b', state: paletteState, selected: 0 }, undo: { row: 'x' }, intake };
    expect(overlayWant('review', data, 24, 80, 3)).toBe(CAP.reviewCard);
    expect(overlayWant('followup', data, 24, 80, 3)).toBe(5);
    expect(overlayWant('blocking', data, 24, 80, 3)).toBe(5); // four rows, the first as the title edge, plus the bottom edge
    expect(overlayWant('undo', data, 24, 80, 3)).toBe(3);
    expect(overlayWant('exitConfirm', data, 24, 80, 3)).toBe(3);
    expect(overlayWant('intake', data, 24, 80, 3)).toBe(3);
    expect(overlayWant('palette', data, 24, 80, 3)).toBeGreaterThanOrEqual(4);
    expect(overlayWant('palette', data, 24, 80, 3)).toBeLessThanOrEqual(CAP.palette);
    expect(overlayWant('palette', { mention: { rows: ['a', 'b'], selected: 0 } }, 24, 80, 3)).toBe(5);
    expect(overlayWant('secret', data, 24, 80, 3)).toBe(0);
    expect(overlayWant('wizard', data, 24, 80, 3)).toBe(overlayWant('wizard', data, 24, 80, 0));
    // flat (chrome 0 / omitted): today's values
    expect(overlayWant('review', data, 24, 80)).toBe(8);
    expect(overlayWant('secret', data, 24, 80)).toBe(1);
    expect(overlayWant('undo', data, 24, 80)).toBe(1);
    expect(overlayWant('exitConfirm', data, 24, 80)).toBe(1);
    expect(overlayWant('intake', data, 24, 80)).toBe(1);
    expect(overlayWant('blocking', data, 24, 80)).toBe(4);
  });
});

describe('cards (TUI-DESIGN-2 §4.7, §12 "Cards")', () => {
  it('exit confirm: `╭─ exit? ─…╮`, the §24 row, `╰─…╯`; the flat tier draws the bare row', () => {
    const boxed = strip(render(<Overlay kind="exitConfirm" rows={3} previewRows={0} columns={80} terminalRows={24} top={0} data={{}} chrome={3} />).lastFrame());
    expect(boxed).toHaveLength(3);
    expect(boxed[0]).toBe(`╭─ exit? ${'─'.repeat(80 - 10)}╮`);
    // finding 5: the 78-cell §24 row would be cut inside the card's 76 inner cells — the compact twin keeps every word, `(Enter does nothing)` included
    expect(boxed[1]).toBe(cardRow(EXIT_CONFIRM_ROW_COMPACT, 80));
    expect(EXIT_CONFIRM_ROW_COMPACT).toHaveLength(67);
    expect(boxed[1]).toBe(`│ a run is live: [y] abort and exit   [n] stay   (Enter does nothing)${' '.repeat(76 - 67)} │`);
    expect(boxed[1]).toMatch(/\(Enter does nothing\)\s+│$/);
    expect(boxed[2]).toBe(`╰${'─'.repeat(78)}╯`);
    expect(exitConfirmRow(76)).toBe(EXIT_CONFIRM_ROW_COMPACT);
    expect(exitConfirmRow(78)).toBe(EXIT_CONFIRM_ROW);
    expect(EXIT_CONFIRM_ROW_COMPACT.replace(/ {3}/g, ' ')).toBe(EXIT_CONFIRM_ROW.replace(/ {2,}/g, ' '));
    cleanup();
    // 120 columns: the §24 row fits whole
    const wide = wideRows(<Overlay kind="exitConfirm" rows={3} previewRows={0} columns={120} terminalRows={40} top={0} data={{}} chrome={3} />);
    expect(wide[1]).toBe(cardRow(EXIT_CONFIRM_ROW, 120));
    // the flat tier still draws the §24 row itself
    expect(strip(render(<Overlay kind="exitConfirm" rows={1} previewRows={0} columns={80} terminalRows={24} top={0} data={{}} chrome={0} />).lastFrame())).toEqual([EXIT_CONFIRM_ROW]);
  });
  it('undo and blocking cards; the blocking card keeps its first row as the title and ≤ 6 rows', () => {
    const ask = 'src/a.py changed since step 7 (outside JevCode). Overwrite? [y/N]  a=all  s=skip rest  Esc=abort';
    const undo = wideRows(<Overlay kind="undo" rows={3} previewRows={0} columns={120} terminalRows={24} top={0} data={{ undo: { row: ask } }} chrome={3} />);
    expect(undo[0]?.startsWith('╭─ undo ─')).toBe(true);
    expect(undo[1]).toBe(`│ ${ask}${' '.repeat(116 - ask.length)} │`);
    cleanup();
    const want = overlayWant('blocking', { blocking }, 24, 80, 3);
    expect(want).toBe(5);
    const b = strip(render(<Overlay kind="blocking" rows={want} previewRows={0} columns={80} terminalRows={24} top={0} data={{ blocking }} chrome={3} />).lastFrame());
    expect(b).toHaveLength(want);
    expect(b[0]).toBe(cardTop('jev: key rejected (HTTP 401 — "User not found.")', 80));
    const keys = '[r] retry with the current key   [l] /login   [q] stop (exit 2)';
    expect(b[want - 2]).toBe(`│ ${keys}${' '.repeat(76 - keys.length)} │`);
    for (const l of b) expect(stringWidth(l)).toBe(80);
  });
  it('TUI-DESIGN-3 §5.2 A9: the selected palette row\'s `▌ ` marker takes `accent2` (the secondary pink) — in the card and the flat tier, for a row with and without spans; unselected rows never ask for it; the review card passes `armed` through (OverlayData.review.armed, A8)', () => {
    const state = { ...paletteState, changedFiles: true };
    strip(render(<Overlay kind="palette" rows={8} previewRows={0} columns={80} terminalRows={24} top={0} data={{ palette: { query: '/b', state, selected: 0 } }} chrome={3} />).lastFrame());
    expect(probes.roles.filter((r) => r === 'accent2')).toHaveLength(1);
    cleanup();
    probes.roles.length = 0;
    // the flat tier, the selected row has no spans (an empty query)
    const flat = strip(render(<Overlay kind="palette" rows={8} previewRows={0} columns={80} terminalRows={12} top={0} data={{ palette: { query: '/', state, selected: 1 } }} chrome={0} />).lastFrame());
    expect(flat[1]?.startsWith('▌ /')).toBe(true);
    expect(probes.roles.filter((r) => r === 'accent2')).toHaveLength(1);
    cleanup();
    probes.roles.length = 0;
    // colour off: no role is asked for the marker (bold only)
    strip(render(<Overlay kind="palette" rows={8} previewRows={0} columns={80} terminalRows={24} top={0} data={{ palette: { query: '/b', state, selected: 0 } }} chrome={3} color={false} />).lastFrame());
    expect(probes.roles.filter((r) => r === 'accent2')).toHaveLength(0);
    cleanup();
    // A8: `armed` is accepted on the review data and the card still renders (Review draws it once S5 lands the prop)
    const req = mkConfirmRequest('c1', 7);
    const data: OverlayData = { review: { req, note: null, armed: true } };
    const rows = strip(render(<Overlay kind="review" rows={9} previewRows={0} columns={80} terminalRows={24} top={0} data={data} chrome={3} />).lastFrame());
    expect(rows[1]).toMatch(/^│ \[y\] approve \[n\] decline/);
    expect(data.review?.armed).toBe(true);
  });
  it('palette card `commands` with the footer as the last inner row; the mention popup is the `files` card', () => {
    const rows = strip(render(<Overlay kind="palette" rows={8} previewRows={0} columns={80} terminalRows={24} top={0} data={{ palette: { query: '/b', state: paletteState, selected: 0 } }} chrome={3} />).lastFrame());
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(rows[0]).toBe(`╭─ commands ${'─'.repeat(80 - 13)}╮`);
    expect(rows[1]).toMatch(/^│ ▌ \/budget/);
    expect(rows.at(-2)).toMatch(/Tab completes · Enter runs an exact match · Esc closes\s*│$/);
    expect(rows.at(-1)).toBe(`╰${'─'.repeat(78)}╯`);
    for (const l of rows) expect(stringWidth(l)).toBe(80);
    cleanup();
    const m = strip(render(<Overlay kind="palette" rows={5} previewRows={0} columns={80} terminalRows={24} top={0} data={{ mention: { rows: ['src/a.py', 'src/b.py'], selected: 1 } }} chrome={3} />).lastFrame());
    expect(m).toHaveLength(5);
    expect(m[0]?.startsWith('╭─ files ─')).toBe(true);
    expect(m[2]).toMatch(/^│ ▌ src\/b\.py/);
    expect(m[3]).toMatch(/Enter inserts @path/);
  });
  it('H-I1: the intake card; the flat tier draws the one-row twin; `intakeCardLines` is the string twin', () => {
    const card = strip(render(<Overlay kind="intake" rows={3} previewRows={0} columns={80} terminalRows={24} top={0} data={{ intake }} chrome={3} />).lastFrame());
    expect(card).toEqual(intakeCardLines(intake, 80));
    expect(card).toEqual(['╭─ run this as a task? ────────────────────────────────────────────────────────╮', '│ [y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)    │', '╰──────────────────────────────────────────────────────────────────────────────╯']);
    cleanup();
    expect(strip(render(<Overlay kind="intake" rows={1} previewRows={0} columns={80} terminalRows={12} top={0} data={{ intake }} chrome={0} />).lastFrame())).toEqual(['run this as a task?  [y] run it  [n] just chatting  Esc keeps the text']);
    cleanup();
    const wide = wideRows(<Overlay kind="intake" rows={3} previewRows={0} columns={120} terminalRows={40} top={0} data={{ intake: { ...intake, title: '"the date parsing" — run this as a task?' } }} chrome={3} />);
    expect(wide[0]).toBe(`╭─ "the date parsing" — run this as a task? ${'─'.repeat(120 - 45)}╮`);
  });
  it('the review card through <Overlay>: edges, keys row, preview rows inside the box; every row exactly columns', () => {
    const req = mkConfirmRequest('c1', 7);
    const rows = strip(render(<Overlay kind="review" rows={9} previewRows={4} columns={80} terminalRows={24} top={0} data={{ review: { req, note: null } }} chrome={3} />).lastFrame());
    expect(rows).toHaveLength(13);
    expect(rows[0]).toMatch(/^╭─ review · step 7 · risk 0\.50 \(exp\) · edit src\/a\.py "fix the off-by-one" ─+╮$/);
    expect(rows[1]).toMatch(/^│ \[y\] approve \[n\] decline/);
    expect(rows[8]).toMatch(/^│ {3}--- old/);
    expect(rows[12]).toBe(`╰${'─'.repeat(78)}╯`);
    for (const l of rows) expect(stringWidth(l)).toBe(80);
    cleanup();
    const noted = strip(render(<Overlay kind="review" rows={9} previewRows={0} columns={80} terminalRows={24} top={0} data={{ review: { req, note: { text: 'skip', gate: null } } }} chrome={3} />).lastFrame());
    expect(noted[1]).toMatch(/^│ note \(≤ 600, Enter sends, Esc cancels\): skip/);
  });
});
