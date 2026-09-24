/**
 * TUI-DESIGN-4 §4 (D-X) through the **mounted** App, over the shared harness (`app-harness.tsx`, read-only; §9.1 gives
 * S4 this file and only this file at App level).
 *
 * Two halves. The first is landed and unconditional: the state footer on the card, the S-NONE inline row (E2), the
 * one-chunk `/m` that used to draw no palette at all (E9), a mouse report that can never reach the draft (E10), the
 * four new commands reaching the host, and — the regression that guards every pty suite — a **hand-typed** `/exit`
 * that still exits at once with no confirm row (`EXIT_IDLE`, `test/pty/helpers.ts:789`).
 *
 * The second half needs §9.2's `App.tsx` row, which **S1 lands in W3**: the `NavEffect` dispatch (`paletteNavState` +
 * `paletteStep`), the marker reset (P-P3), the `acceptedRef` provenance ref (§4.5) and the confirm overlay. Those
 * cases follow round 3's precedent (`round3-commands-app.test.tsx:26–34`) and are written behind `it.skipIf` probes
 * on the App source, so each one activates the moment its line lands instead of being written twice.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanup } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { PALETTE_FOOTER, paletteMatches } from '../../../src/tui/commands/palette.js';
import { tick } from '../../fixtures/tui/fixtures.js';
import { CTRL_C, fakeHost, mountApp, waitFor, type Mounted } from './app-harness.js';

const APP_SRC = readFileSync(fileURLToPath(new URL('../../../src/tui/App.tsx', import.meta.url)), 'utf8');
/** §9.2's `App.tsx` row for S4, probed on the source so every case activates when its line lands (W3) */
const LANDED = {
  /** §4.2 P-P1: `case 'palette'` dispatches a `NavEffect` instead of calling `onEnter()` for every Enter */
  nav: APP_SRC.includes('paletteStep('),
  /** §4.3 P-P3: the marker resets to the top on every query change (a `lastToken` ref in the composer fall-through) */
  markerReset: /lastToken/.test(APP_SRC),
  /** §4.5: `acceptedRef` — set by an accept or a cycle, cleared by any edit; never `overlay === 'palette'` */
  provenance: APP_SRC.includes('acceptedRef'),
  /** §4.5: the three one-row confirms in the `exitConfirm` slot */
  confirm: APP_SRC.includes('confirmRow('),
  /** §4.7 E12 / E13: the controller supplies `draftTokenOnly`, which turns both rules on (they are inert without it) */
  tokenOnly: APP_SRC.includes('draftTokenOnly'),
};

afterEach(() => cleanup());

async function settle(m: Mounted): Promise<void> {
  m.dispatch({ type: 'splash:done' });
  await waitFor(() => m.state()?.splash === 'done');
  await tick(20);
}

describe('TUI-DESIGN-4 §4: the palette card through the mounted App', () => {
  it('§4.4: `/` opens the card and its footer is the STATE footer, not round 3\'s one constant', async () => {
    const m = mountApp({ mode: 'session', host: fakeHost() });
    await settle(m);
    m.stdin.write('/');
    await waitFor(() => m.lastFrame().includes(PALETTE_FOOTER));
    const frame = m.lastFrame();
    expect(frame).toContain('Enter next · Tab picks · Esc closes');
    expect(frame).not.toContain('Enter runs an exact match');
    expect(frame).toContain(`(1/${paletteMatches('', { lastStop: null, unauthorized: false, changedFiles: false, rewindMenu: false, live: false }).length})`);
    // …and once the draft names a command exactly, the footer says what Enter will do with it
    m.stdin.write('cost');
    await waitFor(() => m.lastFrame().includes('Enter runs /cost'));
    expect(m.lastFrame()).toContain('Enter runs /cost · Esc closes');
  });
  it('§4.7 E2: zero matches draw the inline sentence and a `(0/0)` footer, never today\'s blank card', async () => {
    const m = mountApp({ mode: 'session', host: fakeHost() });
    await settle(m);
    m.stdin.write('/zz');
    await waitFor(() => m.lastFrame().includes('no command matches'));
    const frame = m.lastFrame();
    expect(frame).toContain('no command matches /zz — keep typing, or Esc to clear');
    expect(frame).toContain('(0/0)  Esc closes');
    // Ctrl-C closes the card; the draft rule itself is E12's, which needs the controller's `draftTokenOnly`
    m.stdin.write(CTRL_C);
    await waitFor(() => !m.lastFrame().includes('no command matches'));
  });
  it('§4.7 E9: `/m` delivered as ONE chunk opens the palette with `m` as the query (measured: it drew `› /m` with no card at all)', async () => {
    const m = mountApp({ mode: 'session', host: fakeHost() });
    await settle(m);
    m.stdin.write('/m');
    await waitFor(() => m.state()?.overlay === 'palette');
    expect(m.state()?.overlay).toBe('palette');
    const frame = m.lastFrame();
    expect(frame).toContain('/mode');
    expect(frame).toContain('/model');
    expect(frame).toContain('› /m');
  });
  it('§4.7 E10: a mouse report from an outer program never reaches the draft, with the card open or closed', async () => {
    const m = mountApp({ mode: 'session', host: fakeHost() });
    await settle(m);
    m.stdin.write('[<64;10;5M');
    await tick(20);
    expect(m.lastFrame()).not.toContain('64;10;5');
    m.stdin.write('/');
    await waitFor(() => m.lastFrame().includes(PALETTE_FOOTER));
    m.stdin.write('[<64;10;5M');
    await tick(20);
    expect(m.lastFrame()).not.toContain('64;10;5');
    expect(m.state()?.overlay).toBe('palette');
  });
  it('§1.3.1 / §1.3.4 / §7.10 / §7.1: the four commands round 4 adds reach the host as the typed line', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await settle(m);
    for (const line of ['/fullscreen', '/scrollback', '/peers', '/ui reset']) {
      m.stdin.write(line);
      await waitFor(() => m.lastFrame().includes(`› ${line}`));
      m.stdin.write('\r');
      await waitFor(() => host.commands.includes(line));
    }
    expect(host.commands).toEqual(['/fullscreen', '/scrollback', '/peers', '/ui reset']);
    // `/ui` with anything else is the §7.1 error, and it never reaches the host
    m.stdin.write('/ui nope');
    await waitFor(() => m.lastFrame().includes('› /ui nope'));
    m.stdin.write('\r');
    await waitFor(() => host.notes.some((n) => n.includes('expected reset')));
    expect(host.commands).toHaveLength(4);
  });
  it('§4.5: `/history clear` through the palette reaches the host with NO confirm row — it owns its own y/N', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await settle(m);
    m.stdin.write('/history clear');
    await waitFor(() => m.lastFrame().includes('› /history clear'));
    m.stdin.write('\r');
    await waitFor(() => host.commands.includes('/history clear'));
    // the fourth destructive command has no rung ladder (§4.5 gives it the readline y/N in `session.ts`), so it is
    // not a `ConfirmKind` and no overlay is ever asked to draw a body `confirmRow` cannot produce
    expect(m.lastFrame()).not.toMatch(/\[y\][\s\S]*\[n\]/);
    expect(m.state()?.overlay).not.toBe('exitConfirm');
  });
  it('§4.5 REGRESSION: a hand-typed `/exit` still exits at once with no confirm row (EXIT_IDLE ends nearly every pty scenario)', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await settle(m);
    m.stdin.write('/exit');
    await waitFor(() => m.lastFrame().includes('› /exit'));
    // the card is OPEN while the line is being typed — which is exactly why `fromPalette` may never be
    // `overlay === 'palette'` (§4.5)
    expect(m.state()?.overlay).toBe('palette');
    m.stdin.write('\r');
    await waitFor(() => m.exits.length > 0 || host.exits.length > 0);
    expect([...m.exits, ...host.exits]).toContain(0);
    expect(m.lastFrame()).not.toContain('leave JevCode?');
  });
});

describe('TUI-DESIGN-4 §4: the sequences that need §9.2\'s App.tsx row (S1, W3)', () => {
  it.skipIf(!LANDED.nav)('§10 S4: `/` + Enter ×2 + Tab + Enter runs the third row', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await settle(m);
    m.stdin.write('/');
    await waitFor(() => m.lastFrame().includes(PALETTE_FOOTER));
    const third = paletteMatches('', { lastStop: null, unauthorized: false, changedFiles: false, rewindMenu: false, live: false })[2]?.spec.name as string;
    m.stdin.write('\r');
    m.stdin.write('\r');
    await waitFor(() => m.lastFrame().includes('(3/'));
    // a cycle never touches the draft — that is §4.1's whole safety argument
    expect(m.lastFrame()).toContain('› /');
    m.stdin.write('\t');
    await waitFor(() => m.lastFrame().includes(`› /${third}`));
    m.stdin.write('\r');
    await waitFor(() => host.commands.some((c) => c.startsWith(`/${third}`)) || m.state()?.overlay !== 'palette');
  });
  it.skipIf(!LANDED.markerReset)('§10 S4 / §4.3 P-P3: `/` ↓ ↓ `m` → the marker is back on row 1 (`/mode`) and the footer reads (1/6)', async () => {
    const m = mountApp({ mode: 'session', host: fakeHost() });
    await settle(m);
    m.stdin.write('/');
    await waitFor(() => m.lastFrame().includes(PALETTE_FOOTER));
    m.stdin.write('\x1b[B');
    m.stdin.write('\x1b[B');
    await waitFor(() => m.lastFrame().includes('(3/'));
    m.stdin.write('m');
    const total = paletteMatches('/m', { lastStop: null, unauthorized: false, changedFiles: false, rewindMenu: false, live: false }).length;
    await waitFor(() => m.lastFrame().includes(`(1/${total})`));
    expect(total).toBe(6); // mode, model, llm, theme, resume, rename — the §10 S4 row's `(1/6)`
    expect(m.lastFrame()).toContain('▌ /mode');
  });
  /**
   * TUI-DESIGN-4 §4.2 S-ARG (integrator 2026-09-22): with an argument token typed, Enter moves the **value**
   * cursor `j` and never touches the draft. Writing the marked value into the draft instead would make the state
   * S-ARGDONE, whose Enter is `run` — measured in the perf `palette-arg` series as the SECOND Enter of a 200-key
   * cycle executing `/mode jev-on` and closing the card (2 of 200 key frames). The ghost previews `V[j]`, so the
   * composer row still changes on every press, which is what `composerRowChanged` measures.
   */
  it.skipIf(!LANDED.nav)('§4.2 S-ARG: Enter walks the argument values as a ghost and never runs the command', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await settle(m);
    m.stdin.write('/mode');
    await waitFor(() => m.state()?.overlay === 'palette');
    m.stdin.write(' ');
    await waitFor(() => m.lastFrame().includes('› /mode '));
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      m.stdin.write('\r');
      await tick(30);
      const row = m.lastFrame().split('\n').find((l) => l.includes('› /mode ')) ?? '';
      seen.push(row.replace(/\s+$/, ''));
    }
    // the draft is untouched — nothing ran, nothing was dispatched, the card is still open
    expect(host.commands).toEqual([]);
    expect(host.submitted).toEqual([]);
    expect(m.state()?.overlay).toBe('palette');
    expect(m.lastFrame()).toContain('› /mode ');
    // …and the ghost moved: the six presses did not all draw the same row
    expect(new Set(seen).size, JSON.stringify(seen)).toBeGreaterThan(1);
  });

  it.skipIf(!LANDED.tokenOnly)('§4.7 E12: Ctrl-C with the card open and the whole draft one token closes it AND clears the draft', async () => {
    const m = mountApp({ mode: 'session', host: fakeHost() });
    await settle(m);
    m.stdin.write('/zz');
    await waitFor(() => m.lastFrame().includes('no command matches'));
    // the measured trap, both halves: today's CLOSE_OVERLAY leaves `/zz` in the composer with no card and no
    // placeholder. `CLOSE_OVERLAY_AND_CLEAR` has no `src` consumer until this row lands, so a missing App case
    // would otherwise be invisible.
    m.stdin.write(CTRL_C);
    await waitFor(() => !m.lastFrame().includes('no command matches'));
    expect(m.lastFrame()).not.toContain('/zz');
    // …and a draft with an ARGUMENT keeps today's behaviour (close only). The two writes are deliberate: the card
    // has to be OPEN for E12 to apply, and one `/budget 5` chunk is paste-like (E9's charset bound excludes the
    // space), so it would leave the palette closed and the Ctrl-C would be the ordinary CLEAR_DRAFT rule.
    m.stdin.write('/budget');
    await waitFor(() => m.state()?.overlay === 'palette');
    m.stdin.write(' 5');
    await waitFor(() => m.lastFrame().includes('› /budget 5'));
    expect(m.state()?.overlay).toBe('palette');
    m.stdin.write(CTRL_C);
    await tick(20);
    expect(m.lastFrame()).toContain('› /budget 5');
  });
  it.skipIf(!(LANDED.provenance && LANDED.confirm))('§4.5: Enter on an ACCEPTED `/new` opens the confirm row, Enter on the row does nothing, `y` ends the session and `n` keeps it', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await settle(m);
    m.stdin.write('/ne');
    await waitFor(() => m.lastFrame().includes('› /ne'));
    m.stdin.write('\t'); // an accept — the provenance ref is set here, and only here
    await waitFor(() => m.lastFrame().includes('› /new'));
    m.stdin.write('\r');
    await waitFor(() => m.lastFrame().includes('start fresh?'));
    expect(m.lastFrame()).toMatch(/\[y\][\s\S]*\[n\]/);
    m.stdin.write('\r'); // inert
    await tick(20);
    expect(m.lastFrame()).toContain('start fresh?');
    expect(host.commands).not.toContain('/new');
    m.stdin.write('n');
    await waitFor(() => !m.lastFrame().includes('start fresh?'));
    expect(host.commands).not.toContain('/new');
  });
});
