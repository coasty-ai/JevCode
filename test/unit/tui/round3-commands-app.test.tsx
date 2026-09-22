/**
 * TUI-DESIGN-3 §4 / §8 S4 — the mounted App on the round-3 command work, over the shared harness (`app-harness.tsx`, read-only):
 * F3 — `/p d` twice opens then collapses the decisions tab, `/Panel full` expands, `/tr compact` / `/TR` are the transcript command
 * in every spelling (the alias- and case-aware `parsePanelCommand` behind the App's pre-router); the popular set idle (host-forwarded
 * lines arrive as typed, aliases included; App-local ones act), live (idle-only commands answer the availability sentence) and
 * thinking (F14); the palette frame with the alias column and the Popular order; the ghost `+N`; the alias Enter (`/q` exits, `/s`
 * reaches the host); a rebound `global:help` → `none` leaves `?` as text (F10, the `bindings` prop). The App.tsx wiring of §7.2 that
 * S2 lands in W3 (Tab → `completeDraft`, `keepDraft`, the thinking route, the theme forward, `dispatchCtxOf`, `setBindings`,
 * `/copy diff`) is tested behind `it.skipIf(!landed)` probes on the App source so the cases activate the moment the lines land.
 */
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { App, createBridge } from '../../../src/tui/App.js';
import { STILL_THINKING_TOAST } from '../../../src/tui/composer/submit.js';
import { COMMANDS, POPULAR, findCommand } from '../../../src/tui/commands/registry.js';
import { PALETTE_FOOTER, paletteMatches } from '../../../src/tui/commands/palette.js';
import { loadKeybindings } from '../../../src/tui/keys/keybindings-file.js';
import { createEventBus, createTuiConfirmer } from '../../../src/tui/useEngine.js';
import { tick } from '../../fixtures/tui/fixtures.js';
import { fakeHost, goLive, mountApp, stripSgr, waitFor, type FakeHost, type Mounted } from './app-harness.js';

const APP_SRC = readFileSync(fileURLToPath(new URL('../../../src/tui/App.tsx', import.meta.url)), 'utf8');
/** §7.2 App row: the S4 requests S2 lands in W3, probed on the source so each case activates when its line lands */
const LANDED = {
  completeDraft: APP_SRC.includes('completeDraft('),
  keepDraft: APP_SRC.includes('keepDraft'),
  thinking: APP_SRC.includes('allowCommandsWhileSubmitting'),
  themeForward: /case 'theme':[\s\S]{0,900}?\.command\(line\)/.test(APP_SRC),
  setBindings: APP_SRC.includes('setBindings'),
  copyDiff: /case 'copy':[\s\S]{0,900}?\.command\(/.test(APP_SRC),
};

afterEach(() => cleanup());

async function settle(m: Mounted): Promise<void> {
  m.dispatch({ type: 'splash:done' });
  await waitFor(() => m.state()?.splash === 'done');
  await tick(20);
}

async function enter(m: Mounted, line: string): Promise<void> {
  m.stdin.write(line);
  await waitFor(() => m.lastFrame().includes(`› ${line}`));
  m.stdin.write('\r');
  await tick(20);
}

/** a host whose `submit` stays pending until `release()` — the intake, lookup or reply in flight (round2-app.test.tsx's pattern) */
function pendingHost(): { host: FakeHost; release: () => void } {
  const host = fakeHost();
  let release: () => void = () => undefined;
  host.submit = (text, opts) => {
    host.order.push('submit');
    host.submitted.push({ text, kind: opts.kind, secretSpans: opts.secretSpans, pinnedFiles: opts.pinnedFiles });
    return new Promise<void>((r) => {
      release = r;
    });
  };
  return { host, release: () => release() };
}

describe('F3: /panel and /transcript in every spelling stay App-local (TUI-DESIGN-3 §4.4)', () => {
  it('`/p d` twice → the decisions tab opens, then collapses; `/Panel full` → full; `/tr compact` and `/tr full` set the view; `/TR` alone reports it; nothing reaches the host', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await settle(m);
    expect(m.state()?.panel).toBe('collapsed');
    await enter(m, '/p d');
    await waitFor(() => m.state()?.panel === 'open');
    expect(m.state()?.tab).toBe('d');
    await enter(m, '/p d');
    await waitFor(() => m.state()?.panel === 'collapsed');
    expect(m.state()?.tab).toBe('d');
    await enter(m, '/Panel full');
    await waitFor(() => m.state()?.panel === 'full');
    await enter(m, '/P off');
    await waitFor(() => m.state()?.panel === 'collapsed');
    await enter(m, '/tr full');
    await waitFor(() => m.state()?.transcript === 'full');
    await enter(m, '/tr compact');
    await waitFor(() => m.state()?.transcript === 'compact');
    await enter(m, '/TR');
    await waitFor(() => host.notes.includes('transcript compact'));
    expect(host.commands).toEqual([]);
    expect(host.submitted).toEqual([]);
    // the lines are remembered as commands (history), the draft is cleared each time
    expect(m.lastFrame()).not.toContain('› /TR');
  });
});

describe('the popular set through the mounted App (TUI-DESIGN-3 §4.1, §8 S4)', () => {
  it('idle: every Popular command Enter runs — App-local ones act (/help item, /panel toggle, /theme applied, /exit leaves), host ones arrive as the typed line, aliases included (`/s`, `/m jev-on`, `/nw`, `/u`)', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await settle(m);
    const hostLines = POPULAR.filter((n) => !['help', 'panel', 'theme', 'exit', 'plan'].includes(n)).map((n) => `/${n}`);
    for (const line of hostLines) {
      await enter(m, line);
      await waitFor(() => host.commands.includes(line));
      expect(host.commands.at(-1), line).toBe(line);
    }
    for (const line of ['/s', '/m jev-on', '/nw', '/u', '/c', '/b spend-cap 3', '/j', '/l', '/d', '/r']) {
      await enter(m, line);
      await waitFor(() => host.commands.includes(line));
    }
    // /plan is App-local until S2 lands F6 (then the host answers); either way it is answered and never dropped
    await enter(m, '/plan');
    await waitFor(() => host.commands.includes('/plan') || host.notes.includes('plan'));
    await enter(m, '/help');
    await waitFor(() => host.notes.includes('keys'));
    await enter(m, '/h commands');
    await waitFor(() => host.notes.includes('commands'));
    await enter(m, '/panel');
    await waitFor(() => m.state()?.panel === 'open');
    await enter(m, '/theme light');
    await waitFor(() => m.bridge.ui?.theme === 'light');
    await enter(m, '/t dark');
    await waitFor(() => m.bridge.ui?.theme === 'dark');
    expect(host.submitted).toEqual([]);
    expect(host.exits).toEqual([]);
    // /exit is App-local: with a host the exit goes through `host.exit(0)` (the controller's leave), never `onExit`
    await enter(m, '/q');
    await waitFor(() => host.exits.length > 0);
    expect(host.exits).toEqual([0]);
  });
  it('live: idle-only commands (/resume, /new, /undo — by name and alias) answer the availability sentence as a [ui] item, live ones reach the host; /exit opens the exit confirm; every any-command still runs', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await settle(m);
    goLive(m, 3);
    await waitFor(() => m.state()?.run === 'live');
    for (const [line, name] of [['/resume', 'resume'], ['/nw', 'new'], ['/u', 'undo'], ['/rw', 'rewind'], ['/export', 'export']] as const) {
      await enter(m, line);
      await waitFor(() => host.notes.includes(`error: /${name} runs when the run is idle; Esc pauses first`));
    }
    for (const line of ['/status', '/cost', '/m', '/diff', '/budget']) {
      await enter(m, line);
      await waitFor(() => host.commands.includes(line));
    }
    await enter(m, '/pause');
    await waitFor(() => host.paused > 0);
    await enter(m, '/exit');
    await waitFor(() => m.state()?.overlay === 'exitConfirm');
    expect(m.exits).toEqual([]);
    m.stdin.write('n');
    await waitFor(() => m.state()?.overlay === 'none');
  });
  it('the palette frame carries the alias column and the Popular order; the ghost reads the top row (`› /help +40`); `/m` pins /mode over /model with the `+5` count', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await settle(m);
    m.stdin.write('/');
    await waitFor(() => m.lastFrame().includes(PALETTE_FOOTER));
    const frame = m.lastFrame();
    expect(frame).toContain('▌ /help       h  keys by context, commands with one-liners, per-terminal notes');
    expect(frame).toContain('  /mode       m  engine mode: show, or set for the next run');
    expect(frame).toContain('  /model      ml generator model for the next run only');
    expect(frame).toContain('  /cost       c  run and session spend, per-step cost, pending caps');
    // MINIMAL, MARKED pin move (S4, TUI-DESIGN-4 §4.6; TUI-DESIGN-5 §2.3/§2.7/§2.9): the command set is 41 after
    // round 4, 47 after R5-2's six coordination rows and 56 with every round-5 row, so the ghost's count is the table size
    // less the top row — derived, so the next slot's rows move it without another pin edit
    expect(frame).toContain(`› /help +${COMMANDS.length - 1}`);
    m.stdin.write('m');
    await waitFor(() => m.lastFrame().includes('▌ /mode       m  '));
    const fm = m.lastFrame();
    expect(fm).toContain('  /model      ml generator model for the next run only');
    expect(fm.indexOf('▌ /mode')).toBeLessThan(fm.indexOf('  /model'));
    // S5's Console draws ` → /mode` from `ghost.arrow` (F-P2 adds the count beside it); a pre-round-3 renderer
    // shows the count alone. TUI-DESIGN-5 §3.3 / §5.5: `/compact`, `/memory` and `/mem` join the `/m` matches,
    // so the count is derived from the live matcher — 6 in TD3's frame, 9 here — never a literal
    const mMatches = paletteMatches('/m', { lastStop: null, unauthorized: false, changedFiles: false, rewindMenu: false, live: false });
    expect(fm).toMatch(new RegExp(`› /m( → /mode| \\+${mMatches.length - 1})`));
    expect(fm).toContain(`(1/${mMatches.length})`);
    m.stdin.write('\r');
    await waitFor(() => host.commands.includes('/m'));
  });
  it('a typo keeps the draft with the [ui] error (fixable); an availability error clears it once S2 lands `keepDraft` (F21)', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await settle(m);
    await enter(m, '/budgett');
    // MINIMAL, MARKED pin move (S4, TUI-DESIGN-4 §3.1.7): the unknown-command shape; `budgett` is not a subsequence
    // of any command name or alias, so `rank` clears no candidate, there is no `Did you mean` clause — and with no
    // clause the sentence carries no full stop before the `·`
    await waitFor(() => host.notes.includes('error: /budgett — not a command · type / to list commands'));
    expect(m.lastFrame()).toContain('› /budgett');
    m.stdin.write('\x15'); // Ctrl-U clears the line
    await waitFor(() => !m.lastFrame().includes('› /budgett'));
    goLive(m, 3);
    await waitFor(() => m.state()?.run === 'live');
    await enter(m, '/undo');
    await waitFor(() => host.notes.includes('error: /undo runs when the run is idle; Esc pauses first'));
    if (LANDED.keepDraft) expect(m.lastFrame()).not.toContain('› /undo');
    else expect(m.lastFrame()).toContain('› /undo'); // today's rule: every error keeps the draft (R4 F21)
  });
});

describe('F14: commands while the intake is thinking (TUI-DESIGN-3 §4.4)', () => {
  it.skipIf(!LANDED.thinking)('read-only commands run (/status answers through the host), /new toasts `one moment — still thinking` with the draft kept, /exit cancels the request and exits', async () => {
    const { host } = pendingHost();
    const m = mountApp({ mode: 'session', host });
    await settle(m);
    m.stdin.write('hi there\r');
    await waitFor(() => m.state()?.run === 'starting');
    m.dispatch({ type: 'thinking', phase: 'intake' });
    await waitFor(() => m.state()?.thinking === 'intake');
    await enter(m, '/status');
    await waitFor(() => host.commands.includes('/status'));
    await enter(m, '/new');
    await waitFor(() => m.lastFrame().includes(STILL_THINKING_TOAST));
    expect(host.commands).not.toContain('/new');
    expect(m.lastFrame()).toContain('› /new');
    m.stdin.write('\x15');
    await enter(m, '/steer go');
    await waitFor(() => host.notes.includes('error: /steer needs a live run'));
    await enter(m, '/exit');
    await waitFor(() => host.exits.length > 0 || host.aborts.length > 0);
    expect(host.aborts).toContain('human_abort');
  });
  it('today (before the S2 wiring): text while thinking toasts and stays; the toast text is the one constant both modules export', async () => {
    const { host } = pendingHost();
    const m = mountApp({ mode: 'session', host });
    await settle(m);
    m.stdin.write('hi there\r');
    await waitFor(() => m.state()?.run === 'starting');
    m.dispatch({ type: 'thinking', phase: 'intake' });
    await waitFor(() => m.state()?.thinking === 'intake');
    m.stdin.write('and again');
    await waitFor(() => m.lastFrame().includes('› and again'));
    m.stdin.write('\r');
    await waitFor(() => m.lastFrame().includes(STILL_THINKING_TOAST));
    expect(STILL_THINKING_TOAST).toBe('one moment — still thinking');
    expect(host.submitted.map((s) => s.text)).toEqual(['hi there']);
  });
});

describe('Tab completes arguments (TUI-DESIGN-3 §4.3) — active once S2 swaps `case complete` to `completeDraft`', () => {
  it.skipIf(!LANDED.completeDraft)('`/budget sp` Tab → `/budget spend-cap `; `/budget spend-cap` Tab keeps the value; `/decisions 5 ri` Tab → `risk `; a rest argument toasts `no completions for <arg>`', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await settle(m);
    // `/` alone opens the palette (a multi-character chunk is a paste and opens nothing); the rest of the line follows
    const type = async (rest: string): Promise<void> => {
      m.stdin.write('/');
      await waitFor(() => m.lastFrame().includes(PALETTE_FOOTER));
      m.stdin.write(rest);
      await waitFor(() => m.lastFrame().includes(`› /${rest}`));
    };
    await type('budget sp');
    m.stdin.write('\t');
    await waitFor(() => m.lastFrame().includes('› /budget spend-cap '));
    expect(m.lastFrame()).not.toContain('› /budget  '); // F4: never `› /budget ` alone
    m.stdin.write('\t');
    await waitFor(() => m.lastFrame().includes('no completions for value'));
    expect(m.lastFrame()).toContain('› /budget spend-cap ');
    m.stdin.write('\x15');
    await waitFor(() => !m.lastFrame().includes('› /budget'));
    await type('decisions 5 ri');
    m.stdin.write('\t');
    await waitFor(() => m.lastFrame().includes('› /decisions 5 risk '));
    m.stdin.write('\x15');
    await waitFor(() => !m.lastFrame().includes('› /decisions'));
    await type('rename fo');
    m.stdin.write('\t');
    await waitFor(() => m.lastFrame().includes('no completions for title'));
    expect(m.lastFrame()).toContain('› /rename fo');
    m.stdin.write('\x15');
    await waitFor(() => !m.lastFrame().includes('› /rename'));
    // `/mode ` Tab cycles the four values without a space; Shift+Tab walks back
    await type('mode ');
    m.stdin.write('\t');
    await waitFor(() => m.lastFrame().includes('› /mode jev-only'));
    m.stdin.write('\t');
    await waitFor(() => m.lastFrame().includes('› /mode jev-on'));
    m.stdin.write('\x1b[Z');
    await waitFor(() => m.lastFrame().includes('› /mode jev-only'));
  });
});

describe('F5 / F7 / F20 — App requests S2 lands in W3 (probed)', () => {
  it.skipIf(!LANDED.themeForward)('`/theme light` is applied at once and forwarded to the host; `bridge.ui.theme` survives a `setUi`', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await settle(m);
    await enter(m, '/theme light');
    await waitFor(() => host.commands.includes('/theme light'));
    expect(m.bridge.ui?.theme).toBe('light');
  });
  it.skipIf(!LANDED.copyDiff)('`/copy diff` asks the host (the diff is the controller\'s); `/copy` stays App-local', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await settle(m);
    await enter(m, '/copy diff');
    await waitFor(() => host.commands.includes('/copy diff'));
    await enter(m, '/cp');
    await tick(30);
    expect(host.commands).not.toContain('/cp');
  });
});

describe('F10: the effective bindings reach resolveKey (TUI-DESIGN-3 §4.4)', () => {
  function mountWithBindings(host: FakeHost, file: string): Mounted {
    const load = loadKeybindings(file);
    expect(load.found).toBe(true);
    expect(load.warnings).toEqual([]);
    const bus = createEventBus();
    const confirmer = createTuiConfirmer();
    const exits: number[] = [];
    const aborts: string[] = [];
    const bridge = createBridge(host, null);
    const ui = render(<App task="" resumeId={null} source={bus} confirmer={confirmer} onAbort={(r) => aborts.push(r)} mode="session" cwd="/Users/x/proj" onExit={(c) => exits.push(c)} tickMs={0} bridge={bridge} bindings={load.bindings} />);
    return { bus, confirmer, aborts, exits, host, bridge, stdin: ui.stdin, lastFrame: () => stripSgr(ui.lastFrame() ?? ''), frames: ui.frames, state: () => bridge.stateReader?.() ?? null, dispatch: (a) => bridge.command({ type: 'dispatch', action: a }) };
  }
  it('a keybindings.json mapping `global:help` to `none` → `?` on an empty draft inserts text instead of appending the help block; the default mount appends it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-kb-'));
    const file = join(dir, 'keybindings.json');
    writeFileSync(file, JSON.stringify({ 'global:help': 'none' }));
    const host = fakeHost();
    const m = mountWithBindings(host, file);
    await settle(m);
    m.stdin.write('?');
    await waitFor(() => m.lastFrame().includes('› ?'));
    expect(host.notes).not.toContain('keys');
    cleanup();
    const plain = mountApp({ mode: 'session', host: fakeHost() });
    await settle(plain);
    plain.stdin.write('?');
    await waitFor(() => (plain.host as FakeHost).notes.includes('keys'));
    expect(plain.lastFrame()).not.toContain('› ?');
  });
  it('a bound command chord fires the command through the App (`session:cost` → `ctrl+x c` → /cost reaches the host)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-kb-'));
    const file = join(dir, 'keybindings.json');
    writeFileSync(file, JSON.stringify({ 'session:cost': 'ctrl+x c' }));
    const host = fakeHost();
    const m = mountWithBindings(host, file);
    await settle(m);
    m.stdin.write('\x18'); // Ctrl-X arms the chord
    await tick(10);
    m.stdin.write('c');
    const fired = await waitFor(() => host.commands.includes('/cost'), 800);
    // the `slash` KeyAction is S4's (keys/resolve.ts); the App's `case 'slash'` is S2's §7.2 line — until it lands the key is swallowed, never inserted
    if (!fired) expect(m.lastFrame()).not.toContain('› c');
    expect(host.submitted).toEqual([]);
  });
  it.skipIf(!LANDED.setBindings)('`/help reload` swaps the bindings live (renderer.setBindings): after the swap `?` is text', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await settle(m);
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-kb-'));
    const file = join(dir, 'keybindings.json');
    writeFileSync(file, JSON.stringify({ 'global:help': 'none' }));
    m.bridge.command({ type: 'bindings', bindings: loadKeybindings(file).bindings });
    await tick(20);
    m.stdin.write('?');
    await waitFor(() => m.lastFrame().includes('› ?'));
  });
});

describe('the pre-router and the registry agree (F3 + aliases)', () => {
  it('every alias of /panel and /transcript is the same command the registry names; the parser never steals another alias', () => {
    expect(findCommand('p')?.name).toBe('panel');
    expect(findCommand('tr')?.name).toBe('transcript');
    expect(findCommand('t')?.name).toBe('theme');
    expect(findCommand('pl')?.name).toBe('plan');
  });
});
