/**
 * TUI-DESIGN §19.3 (`wizard.test.tsx`, §11.1, F10; TUI-DESIGN-2 §1.4): the masked field — zero key bytes in every frame, the bytes only
 * in the `useMaskedBytes` ref, `•`/`*` cells, the cursor after the bullets; the wizard hook — digits pick the provider,
 * typed / pasted bytes change only `length`, Enter with < 8 chars hints, Enter saves through the host with `addSecret`
 * before the `[setup]` items (the host's order), Esc clears then steps back, Ctrl-C exits 2 with no run and closes the
 * wizard mid-run; every row ≤ columns cells.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import type { CursorPosition } from 'ink';
import { MaskedField } from '../../../src/tui/onboarding/MaskedField.js';
import { Wizard, useWizard, type WizardController, type WizardHost, type WizardModeChoice, type WizardSaveInput, type WizardVerifyInput } from '../../../src/tui/onboarding/Wizard.js';
import { HINT_PASTED_TWICE, HINT_TOO_SHORT } from '../../../src/tui/onboarding/reducer.js';
import { WIZARD_KEY_HINT_EMPTY, WIZARD_KEY_TITLE, WIZARD_OPTIONS_TITLE, WIZARD_VERIFY_TITLE_ONE_KEY, keyFoundTitle, optionHint, optionsTitle } from '../../../src/tui/onboarding/lines.js';
import { stringWidth } from '../../../src/tui/composer/width.js';

afterEach(() => cleanup());
const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** wait for an async host round trip (save → saved → verify; verify n → done) instead of a fixed tick — the full suite runs under load */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('until: condition not met in time');
    await tick(5);
  }
}
const KEY = 'sk-ant-api03-SECRET-CANARY-0123456789abcdef';

describe('<MaskedField>', () => {
  it('renders `> ` + bullets (min(len, columns − 3)), `*` in ASCII, and places the cursor after them', () => {
    const positions: (CursorPosition | undefined)[] = [];
    const ui = render(<MaskedField length={12} columns={40} top={2} cursor={(p) => positions.push(p)} />);
    expect(strip(ui.lastFrame())).toBe(`> ${'•'.repeat(12)}`);
    expect(positions.at(-1)).toEqual({ x: 14, y: 2 });
    cleanup();
    const ascii = render(<MaskedField length={50} columns={40} top={0} ascii />);
    expect(strip(ascii.lastFrame())).toBe(`> ${'*'.repeat(37)}`);
    expect(stringWidth(strip(ascii.lastFrame()))).toBeLessThanOrEqual(40);
  });
});

interface Harness {
  ctl: () => WizardController;
  frame: () => string;
  items: string[];
  /** TUI-DESIGN-3 §5.1 rule 13: the TUI-only detail bodies `onItem` received */
  details: (string | undefined)[];
  exits: number[];
  done: number;
  host: WizardHost & { saves: WizardSaveInput[]; order: string[]; modes: WizardModeChoice[]; dones: number; verifies: WizardVerifyInput[] };
}

function harness(hostOver: Partial<WizardHost> = {}): Harness {
  const items: string[] = [];
  const details: (string | undefined)[] = [];
  const exits: number[] = [];
  const h: Harness = { ctl: () => ctlRef!, frame: () => '', items, details, exits, done: 0, host: null as never };
  const host: Harness['host'] = {
    saves: [],
    order: [],
    modes: [],
    dones: 0,
    verifies: [],
    save: async (input) => {
      host.order.push('addSecret');
      host.saves.push(input);
      host.order.push('write');
      return { ok: true, items: ['generator key: entered (sha256:e31150e9) source=wizard', 'saved ~/.config/jevcode/config.json (mode 0600, dir 0700)'] };
    },
    mode: (choice) => {
      host.modes.push(choice);
    },
    done: () => {
      host.dones += 1;
    },
    sandboxLine: () => 'seatbelt — writes confined to the workspace and run dirs',
    ...hostOver,
  };
  h.host = host;
  let ctlRef: WizardController | null = null;
  function Probe(): React.JSX.Element {
    const ctl = useWizard({
      host: () => host,
      onItem: (t, l, d) => {
        items.push(`${l} ${t}`);
        details.push(d);
      },
      onDone: () => (h.done += 1),
      onExit: (c) => exits.push(c),
    });
    ctlRef = ctl;
    return ctl.active ? <Wizard state={ctl.state} rows={ctl.rows(24)} columns={80} top={0} /> : <Text>closed</Text>;
  }
  const ui = render(<Probe />);
  h.frame = () => strip(ui.lastFrame());
  return h;
}

describe('useWizard + <Wizard> (§11.1)', () => {
  it('provider step (a non-openrouter provider preselected): digits pick; the key field masks every byte and only `length` reaches the reducer; Enter < 8 hints', async () => {
    const h = harness();
    h.ctl().start({ missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: 'anthropic', trustNeeded: false });
    await tick();
    expect(h.frame()).toContain('No API key found. Pick the generator provider:');
    h.ctl().apply({ type: 'wizard', op: 'input', text: '2' });
    await tick();
    expect(h.frame()).toContain('OpenRouter API key (OPENROUTER_API_KEY)');
    h.ctl().apply({ type: 'wizard', op: 'input', text: 'sk-or' });
    await tick();
    expect(h.frame()).toContain(`> ${'•'.repeat(5)}`);
    expect(h.frame()).not.toContain('sk-or');
    expect(h.ctl().state.length).toBe(5);
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await tick();
    expect(h.frame()).toContain('key too short (8+ characters)');
    h.ctl().apply({ type: 'wizard', op: 'backspace' });
    await tick();
    expect(h.ctl().state.length).toBe(4);
    h.ctl().apply({ type: 'wizard', op: 'clear' });
    await tick();
    expect(h.ctl().state.length).toBe(0);
  });

  it('TUI-DESIGN-3 §1.4 (D-J): both keys missing under a generator mode → the one-paste `key` step; a pasted key never appears in a frame; Enter saves ONE field through the host (addSecret first, keyAs both, oneKey), appends the [setup] items; the verify title names the two calls; n skips → sandbox → done', async () => {
    const h = harness({ sandboxDetail: () => 'the long sentence' });
    h.ctl().start({ missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: 'openrouter', trustNeeded: false });
    await tick();
    expect(h.ctl().state.step).toBe('key');
    expect(h.frame()).toContain(WIZARD_KEY_TITLE);
    expect(h.frame()).toContain(WIZARD_KEY_HINT_EMPTY);
    // Enter on the empty field: too short, nothing offered (edge 10)
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await tick();
    expect(h.frame()).toContain(HINT_TOO_SHORT);
    const frames: string[] = [];
    h.ctl().apply({ type: 'wizard', op: 'input', text: `sk-or-v1-${KEY}` });
    await tick();
    frames.push(h.frame());
    expect(h.frame()).toContain(`> ${'•'.repeat(`sk-or-v1-${KEY}`.length)}`);
    expect(h.frame()).toMatch(/\d+ chars · Enter saves · Ctrl-U clears · Esc clears \(again: other ways\)/);
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await until(() => h.ctl().state.step === 'verify');
    frames.push(h.frame());
    expect(h.host.saves).toHaveLength(1);
    expect(h.host.saves[0]).toMatchObject({ provider: null, jevProvider: null, fields: ['key'], reuseGeneratorForJev: false, oneKey: true, keyAs: 'both', reuseJevForGenerator: false, pendMode: null });
    expect(h.host.saves[0]?.values['key']).toBe(`sk-or-v1-${KEY}`);
    expect(h.host.saves[0]?.values['generator.apiKey']).toBeUndefined();
    expect(h.host.order).toEqual(['addSecret', 'write']);
    expect(h.items).toContain('[setup] generator key: entered (sha256:e31150e9) source=wizard');
    for (const f of frames) expect(f).not.toContain(KEY);
    for (const i of h.items) expect(i).not.toContain(KEY);
    expect(h.frame()).toContain(WIZARD_VERIFY_TITLE_ONE_KEY);
    expect(h.frame()).toContain('decision ~$0.00002 · completion ~$0.000002 · key info $0 · Enter/Esc skip');
    h.ctl().apply({ type: 'wizard', op: 'input', text: 'n' });
    await until(() => h.done === 1);
    // TUI-DESIGN-3 §5.1 rule 13: the [sandbox] item carries the host's detail body
    expect(h.items).toContain('[sandbox] seatbelt — writes confined to the workspace and run dirs');
    expect(h.details[h.items.indexOf('[sandbox] seatbelt — writes confined to the workspace and run dirs')]).toBe('the long sentence');
    expect(h.host.dones).toBe(1);
    expect(h.frame()).toBe('closed');
  });

  it('TUI-DESIGN-3 §1.4: Esc on the empty `key` field opens `options`; a digit highlights (title, ▌, consequence), the same digit confirms; `3 Jev only` with a resolving TypeSafe key tells the host `{ mode: jev-only, persist }` once, no save, and `done()` closes; Esc on `options` returns to `key`', async () => {
    const h = harness();
    h.ctl().start({ missing: ['generator.apiKey'], mode: 'jev-on', provider: 'openrouter', jevProvider: 'typesafe', trustNeeded: false, found: 'typesafe', foundSource: 'env' });
    await tick();
    expect(h.ctl().state.step).toBe('key');
    expect(h.frame()).toContain(keyFoundTitle('typesafe'));
    h.ctl().apply({ type: 'wizard', op: 'back' });
    await tick();
    expect(h.ctl().state.step).toBe('options');
    expect(h.frame()).toContain(WIZARD_OPTIONS_TITLE);
    expect(h.frame()).toContain('  1 OpenRouter   2 TypeSafe   3 Jev only   4 Anthropic');
    expect(h.frame()).toContain('pick 1–4 · Esc back');
    // Esc goes back to the key field, then Esc again reopens options
    h.ctl().apply({ type: 'wizard', op: 'back' });
    await tick();
    expect(h.ctl().state.step).toBe('key');
    h.ctl().apply({ type: 'wizard', op: 'back' });
    await tick();
    // Enter with nothing highlighted asks to pick
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await tick();
    expect(h.frame()).toContain('pick 1–4');
    h.ctl().apply({ type: 'wizard', op: 'input', text: '3' });
    await tick();
    expect(h.frame()).toContain(optionsTitle(3));
    expect(h.frame()).toContain('▌3 Jev only');
    expect(h.frame()).toContain(optionHint(3));
    expect(h.host.modes).toEqual([]);
    h.ctl().apply({ type: 'wizard', op: 'input', text: '3' });
    await until(() => h.done === 1);
    expect(h.host.modes).toEqual([{ mode: 'jev-only', persist: true }]);
    expect(h.host.saves).toEqual([]);
    expect(h.host.dones).toBe(1);
    expect(h.exits).toEqual([]);
    expect(h.items.filter((i) => i.startsWith('[sandbox]'))).toHaveLength(1);
    expect(h.frame()).toBe('closed');
    // under /login the choice pends (persist false) and a Ctrl-C afterwards cancels (host.cancel, never done)
    let cancels = 0;
    const login = harness({ cancel: () => (cancels += 1) });
    login.ctl().start({ missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false, reason: 'login' });
    await tick();
    login.ctl().apply({ type: 'wizard', op: 'back' });
    await tick();
    login.ctl().apply({ type: 'wizard', op: 'input', text: '3' });
    await tick();
    login.ctl().apply({ type: 'wizard', op: 'submit' });
    await until(() => login.host.modes.length === 1);
    expect(login.ctl().state.step).toBe('jevProvider');
    expect(login.host.modes).toEqual([{ mode: 'jev-only', persist: false }]);
    login.ctl().cancel();
    await until(() => login.done === 1);
    expect(cancels).toBe(1);
    expect(login.host.dones).toBe(1); // done() after a cancel finds nothing pending (the prompter's cancel settled it)
    expect(login.exits).toEqual([]);
  });

  it('TUI-DESIGN-3 §1.8 edge 2: `sk-or-` twice in the buffer → HINT_PASTED_TWICE once (pure: no bytes to the reducer); Ctrl-U clears; Enter again keeps a doubled key', async () => {
    const h = harness();
    h.ctl().start({ missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'input', text: `sk-or-v1-${KEY}sk-or-v1-${KEY}` });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await tick();
    expect(h.frame()).toContain(HINT_PASTED_TWICE);
    expect(h.host.saves).toEqual([]);
    expect(h.frame()).not.toContain(KEY);
    h.ctl().apply({ type: 'wizard', op: 'clear' });
    await tick();
    expect(h.ctl().state.length).toBe(0);
    expect(h.frame()).toContain(WIZARD_KEY_HINT_EMPTY);
    h.ctl().apply({ type: 'wizard', op: 'input', text: `sk-or-v1-${KEY}sk-or-v1-${KEY}` });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'submit' }); // Enter again keeps it
    await until(() => h.host.saves.length === 1);
    expect(h.host.saves[0]?.values['key']).toBe(`sk-or-v1-${KEY}sk-or-v1-${KEY}`);
  });

  it('TUI-DESIGN-3 §1.5 / §1.8 edges 5, 14, 38: host.verify receives { provider, jevProvider, fields, mode, signal }; Ctrl-C while verifying aborts the verification only (the `verification failed: AbortError …` item, the key kept, the wizard continues, no exit); a thrown fetch is the same item; Enter and Esc at verify skip', async () => {
    let resolveVerify: ((r: { ok: boolean; rejected: null; items: string[] }) => void) | null = null;
    const h = harness({
      verify: (i) =>
        new Promise((resolve, reject) => {
          h.host.verifies.push(i);
          resolveVerify = resolve;
          i.signal?.addEventListener('abort', () => reject(i.signal?.reason instanceof Error ? i.signal.reason : new DOMException('aborted', 'AbortError')));
        }),
    });
    h.ctl().start({ missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'input', text: `sk-or-v1-${KEY}` });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await until(() => h.ctl().state.step === 'verify');
    h.ctl().apply({ type: 'wizard', op: 'input', text: 'y' });
    await until(() => h.host.verifies.length === 1);
    expect(h.frame()).toContain('verifying… (Ctrl-C cancels)');
    expect(h.host.verifies).toHaveLength(1);
    expect(h.host.verifies[0]).toMatchObject({ provider: null, jevProvider: null, fields: ['key'], mode: 'jev-on' });
    expect(h.host.verifies[0]?.signal).toBeInstanceOf(AbortSignal);
    h.ctl().cancel(); // Ctrl-C while verifying: the abort, not the wizard's exit
    await until(() => h.done === 1);
    expect(h.exits).toEqual([]);
    expect(h.items.some((i) => i.startsWith('[setup] verification failed: AbortError:') && i.endsWith('— the key was kept; fix it with /login'))).toBe(true);
    expect(h.host.saves).toHaveLength(1);
    expect(h.frame()).toBe('closed');
    expect(resolveVerify).not.toBeNull();
    cleanup();
    // edge 14: a network failure
    const net = harness({ verify: async () => { throw new TypeError('fetch failed'); } });
    net.ctl().start({ missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false });
    await tick();
    net.ctl().apply({ type: 'wizard', op: 'input', text: `sk-or-v1-${KEY}` });
    await tick();
    net.ctl().apply({ type: 'wizard', op: 'submit' });
    await until(() => net.ctl().state.step === 'verify');
    net.ctl().apply({ type: 'wizard', op: 'input', text: 'y' });
    await until(() => net.done === 1);
    expect(net.items).toContain('[setup] verification failed: TypeError: fetch failed — the key was kept; fix it with /login');
    expect(net.exits).toEqual([]);
    cleanup();
    // edge 38: Enter and Esc at verify both skip
    for (const op of ['submit', 'back'] as const) {
      const skip = harness({ verify: async () => { throw new Error('never called'); } });
      skip.ctl().start({ missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false });
      await tick();
      skip.ctl().apply({ type: 'wizard', op: 'input', text: `sk-or-v1-${KEY}` });
      await tick();
      skip.ctl().apply({ type: 'wizard', op: 'submit' });
      await until(() => skip.ctl().state.step === 'verify');
      skip.ctl().apply({ type: 'wizard', op });
      await until(() => skip.done === 1, 2000);
      expect(skip.ctl().state.verify).toBe('skipped');
      expect(skip.items.some((i) => i.includes('verification'))).toBe(false);
      cleanup();
    }
  });

  it('TUI-DESIGN-3 §4.4 F17: the `/trust` card (reason trust) — Esc closes it (host.cancel → null), Ctrl-C closes it, nothing exits; Enter stays inert; the startup card exits 2 on Ctrl-C', async () => {
    let cancels = 0;
    const h = harness({ cancel: () => (cancels += 1), trust: () => undefined });
    h.ctl().start({ missing: [], mode: 'jev-on', provider: null, trustNeeded: true, reason: 'trust' });
    await tick();
    expect(h.ctl().state.step).toBe('trust');
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await tick();
    expect(h.ctl().state.step).toBe('trust');
    h.ctl().apply({ type: 'wizard', op: 'back' });
    await until(() => h.done === 1);
    expect(cancels).toBe(1);
    expect(h.exits).toEqual([]);
    expect(h.items.filter((i) => i.startsWith('[sandbox]'))).toEqual([]);
    cleanup();
    let cancels2 = 0;
    const h2 = harness({ cancel: () => (cancels2 += 1), trust: () => undefined });
    h2.ctl().start({ missing: [], mode: 'jev-on', provider: null, trustNeeded: true, reason: 'trust' });
    await tick();
    h2.ctl().cancel();
    await until(() => h2.done === 1);
    expect(cancels2).toBe(1);
    expect(h2.exits).toEqual([]);
    cleanup();
    const startup = harness({ trust: () => undefined });
    startup.ctl().start({ missing: [], mode: 'jev-on', provider: null, trustNeeded: true });
    await tick();
    startup.ctl().cancel();
    await until(() => startup.exits.length === 1);
    expect(startup.exits).toEqual([2]);
  });

  it('TUI-DESIGN-3 §1.4.3: <Wizard> draws the `key` step\'s masked row through `isFieldStep` (the boxed prompt, the cursor after the bullets) like the two secret fields', async () => {
    const positions: (CursorPosition | undefined)[] = [];
    const h = harness();
    h.ctl().start({ missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'input', text: 'sk-or-v1-abc' });
    await tick();
    const boxed = render(<Wizard state={h.ctl().state} rows={3} columns={76} top={0} prompt="› " cursor={(p) => positions.push(p)} />);
    const lines = strip(boxed.lastFrame()).split('\n');
    expect(lines[0]).toBe(WIZARD_KEY_TITLE);
    expect(lines[1]).toBe(`› ${'•'.repeat(12)}`);
    expect(positions.at(-1)).toEqual({ x: 14, y: 1 });
    for (const l of lines) expect(stringWidth(l)).toBeLessThanOrEqual(76);
    // the screen-reader twin names the field instead of bullets
    const sr = render(<Wizard state={h.ctl().state} rows={3} columns={76} top={0} screenReader />);
    expect(strip(sr.lastFrame()).split('\n')[1]).toBe('API key field, 12 characters entered, hidden');
  });

  it('Esc clears a non-empty field, then steps back; Ctrl-C exits 2 with no run and closes the wizard mid-run', async () => {
    const h = harness();
    h.ctl().start({ missing: ['generator.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'input', text: '1' });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'input', text: 'abc' });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'back' });
    await tick();
    expect(h.ctl().state.length).toBe(0);
    expect(h.ctl().state.step).toBe('generatorKey');
    h.ctl().apply({ type: 'wizard', op: 'back' });
    await tick();
    expect(h.ctl().state.step).toBe('provider');
    h.ctl().cancel();
    await until(() => h.exits.length > 0);
    expect(h.exits).toEqual([2]);
    cleanup();
    const live = harness();
    live.ctl().start({ missing: ['decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false, runLive: true });
    await tick();
    live.ctl().cancel();
    await tick(60);
    expect(live.exits).toEqual([]);
    expect(live.done).toBe(1);
  });

  it('host.cancel() is called once on Ctrl-C (no run: exit 2; live: close) and on a `done` with no save / trust answer, never after a save (§11.1)', async () => {
    let cancels = 0;
    const h = harness({ cancel: () => (cancels += 1) });
    h.ctl().start({ missing: ['decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false });
    await tick();
    h.ctl().cancel();
    await tick(60);
    expect(cancels).toBe(1);
    expect(h.exits).toEqual([2]);
    cleanup();
    let liveCancels = 0;
    const live = harness({ cancel: () => (liveCancels += 1) });
    live.ctl().start({ missing: ['decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false, runLive: true });
    await tick();
    live.ctl().cancel();
    await tick(60);
    expect(liveCancels).toBe(1); // once: the `done` the cancel produced does not cancel again
    expect(live.done).toBe(1);
    cleanup();
    let savedCancels = 0;
    const saved = harness({ cancel: () => (savedCancels += 1) });
    saved.ctl().start({ missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: 'openrouter', trustNeeded: false });
    await tick();
    saved.ctl().apply({ type: 'wizard', op: 'input', text: `sk-or-v1-${KEY}` });
    await tick();
    saved.ctl().apply({ type: 'wizard', op: 'submit' }); // the one-paste key → save
    await until(() => saved.ctl().state.step === 'verify');
    expect(saved.host.saves).toHaveLength(1);
    saved.ctl().apply({ type: 'wizard', op: 'submit' }); // Enter = no priced verification → sandbox line → done
    await until(() => saved.done === 1);
    expect(savedCancels).toBe(0);
    cleanup();
    let trustCancels = 0;
    const trusted = harness({ cancel: () => (trustCancels += 1), trust: () => undefined });
    trusted.ctl().start({ missing: [], mode: 'jev-on', provider: null, trustNeeded: true });
    await tick();
    expect(trusted.ctl().state.step).toBe('trust');
    trusted.ctl().apply({ type: 'wizard', op: 'input', text: '1' });
    await tick(60);
    expect(trustCancels).toBe(0);
    expect(trusted.done).toBe(1);
  });

  it('every wizard row is ≤ columns cells at 40 columns (F-N)', async () => {
    const h = harness();
    h.ctl().start({ missing: ['decider.apiKey'], mode: 'jev-only', provider: null, jevProvider: 'typesafe', trustNeeded: false });
    await tick();
    expect(h.ctl().state.step).toBe('jevKey');
    h.ctl().apply({ type: 'wizard', op: 'input', text: 'x'.repeat(108) });
    await tick();
    const ui = render(<Wizard state={h.ctl().state} rows={3} columns={40} top={0} />);
    const lines = strip(ui.lastFrame()).split('\n');
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(stringWidth(l)).toBeLessThanOrEqual(40);
    expect(lines[1]).toBe(`> ${'•'.repeat(37)}`);
  });

  it('TUI-DESIGN-2 §1.4: a jev-only first run with nothing inferred asks the Jev provider (digits pick), then the `1/1` Jev key; the save carries jevProvider and no generator provider', async () => {
    const h = harness();
    h.ctl().start({ missing: ['decider.apiKey'], mode: 'jev-only', provider: null, jevProvider: null, trustNeeded: false });
    await tick();
    expect(h.ctl().state.step).toBe('jevProvider');
    expect(h.frame()).toContain('No Jev key found. Where do you reach Jev?');
    expect(h.frame()).toContain('1 typesafe');
    h.ctl().apply({ type: 'wizard', op: 'input', text: '1' });
    await tick();
    expect(h.ctl().state.step).toBe('jevKey');
    expect(h.frame()).toContain('Jev API key (TYPESAFE_API_KEY)  1/1');
    h.ctl().apply({ type: 'wizard', op: 'input', text: `ts-${KEY}` });
    await tick();
    expect(h.frame()).not.toContain(KEY);
    expect(h.frame()).toContain(`> ${'•'.repeat(`ts-${KEY}`.length)}`);
    // Esc on the empty field steps back to the provider question, Enter accepts the preselection
    h.ctl().apply({ type: 'wizard', op: 'clear' });
    h.ctl().apply({ type: 'wizard', op: 'back' });
    await tick();
    expect(h.ctl().state.step).toBe('jevProvider');
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await tick();
    expect(h.ctl().state.step).toBe('jevKey');
    expect(h.ctl().state.jevProvider).toBe('typesafe');
    h.ctl().apply({ type: 'wizard', op: 'input', text: `ts-${KEY}` });
    await tick();
    // typesafe: every key shape passes the prefix check on the first Enter
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await until(() => h.host.saves.length > 0); // poll: the save's passive effect + host round trip
    expect(h.host.saves).toHaveLength(1);
    expect(h.host.saves[0]).toMatchObject({ provider: null, jevProvider: 'typesafe', fields: ['decider.apiKey'], reuseGeneratorForJev: false });
    expect(h.host.saves[0]?.values['decider.apiKey']).toBe(`ts-${KEY}`);
    expect(h.host.saves[0]?.values['generator.apiKey']).toBeUndefined();
    // the verify detail names the typesafe probe; n skips → done
    expect(h.frame()).toContain('one Jev decision at api.typesafe.ai ~$0.00002 (jev-1.13.0)');
    h.ctl().apply({ type: 'wizard', op: 'input', text: 'n' });
    await tick(60);
    expect(h.done).toBe(1);
    expect(h.exits).toEqual([]);
    for (const i of h.items) expect(i).not.toContain(KEY);
  });

  it('TUI-DESIGN-2 §1.4: `/mode jev-on` with no generator key reopens at the provider step with its own title; Ctrl-C closes the wizard and never exits; host.verify receives jevProvider', async () => {
    const verifies: { provider: string | null; jevProvider: string | null }[] = [];
    const h = harness({ verify: async (i) => {
      verifies.push({ provider: i.provider, jevProvider: i.jevProvider });
      return { ok: true, rejected: null, items: [] };
    } });
    h.ctl().start({ missing: ['decider.apiKey'], mode: 'jev-only', provider: null, jevProvider: 'typesafe', trustNeeded: false });
    await tick();
    h.ctl().cancel(); // the startup wizard exits 2 (no run)
    await until(() => h.exits.length > 0);
    expect(h.exits).toEqual([2]);
    h.ctl().reopen('provider', false, { reason: 'mode', mode: 'jev-on' });
    await tick();
    expect(h.ctl().state.step).toBe('provider');
    expect(h.ctl().state.mode).toBe('jev-on');
    expect(h.frame()).toContain('jev+llm needs a generator. Pick the provider:');
    expect(h.frame()).toContain('Ctrl-C keeps jev-only');
    h.ctl().cancel();
    await until(() => h.done >= 1); // the /mode wizard closes (no second exit)
    expect(h.exits).toEqual([2]); // no second exit: the /mode wizard closes
    expect(h.done).toBe(1);
    expect(h.frame()).toBe('closed');
    // and the saving path: provider 2 → key → save carries the provider → verify y → host.verify sees jevProvider (from the startup detect)
    h.ctl().reopen('provider', false, { reason: 'mode', mode: 'jev-on' });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'input', text: '2' });
    await tick();
    expect(h.frame()).toContain('OpenRouter API key (OPENROUTER_API_KEY)');
    h.ctl().apply({ type: 'wizard', op: 'input', text: `sk-or-v1-${KEY}` });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await until(() => h.host.saves.length > 0); // the save's passive effect + the host round trip: poll, never a fixed tick (flaked at 20 ms under load)
    expect(h.host.saves).toHaveLength(1);
    expect(h.host.saves[0]).toMatchObject({ provider: 'openrouter', jevProvider: null, fields: ['generator.apiKey'] });
    const itemsBefore = h.items.length;
    h.ctl().apply({ type: 'wizard', op: 'input', text: 'y' });
    await tick(60);
    expect(verifies).toEqual([{ provider: 'openrouter', jevProvider: 'typesafe' }]);
    expect(h.done).toBe(2);
    expect(h.exits).toEqual([2]);
    // finding 7: a reopened wizard ends at `done` after the keys — no second `[sandbox]` item from host.sandboxLine()
    expect(h.items.slice(itemsBefore).filter((i) => i.startsWith('[sandbox]'))).toEqual([]);
    expect(h.frame()).toBe('closed');
  });

  it('TUI-DESIGN-2 §1.4: a `/login` reopen emits no `[sandbox]` item (verify `n` → done); reopen at the Jev key asks the provider unless the session passes it', async () => {
    const h = harness();
    h.ctl().start({ missing: ['decider.apiKey'], mode: 'jev-only', provider: null, jevProvider: 'typesafe', trustNeeded: false });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'input', text: `ts-${KEY}` });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await until(() => h.ctl().state.step === 'verify');
    h.ctl().apply({ type: 'wizard', op: 'input', text: 'n' });
    await until(() => h.done === 1);
    // the startup wizard appends the one sandbox line
    expect(h.items.filter((i) => i.startsWith('[sandbox]'))).toHaveLength(1);
    // /login at the Jev key with the session's resolved provider: straight to the field, save, verify n → done, still one sandbox line
    h.ctl().reopen('decider.apiKey', false, { jevProvider: 'typesafe' });
    await tick();
    expect(h.ctl().state.step).toBe('jevKey');
    expect(h.frame()).toContain('Jev API key (TYPESAFE_API_KEY)  1/1');
    h.ctl().apply({ type: 'wizard', op: 'input', text: `ts2-${KEY}` });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await until(() => h.ctl().state.step === 'verify');
    expect(h.host.saves).toHaveLength(2);
    expect(h.host.saves[1]).toMatchObject({ provider: null, jevProvider: null, fields: ['decider.apiKey'] });
    h.ctl().apply({ type: 'wizard', op: 'input', text: 'n' });
    await until(() => h.done === 2);
    expect(h.items.filter((i) => i.startsWith('[sandbox]'))).toHaveLength(1);
    expect(h.frame()).toBe('closed');
    // a reopen at the Jev key with nothing known asks where Jev is reached first (§1.4: a Jev key never saved without its provider)
    h.ctl().reopen('decider.apiKey', false, { jevProvider: null });
    await tick();
    expect(h.ctl().state.step).toBe('jevProvider');
    // TUI-DESIGN-3 §4.4 F19: the /login re-entry title drops "No Jev key found."
    expect(h.frame()).toContain('Where do you reach Jev?');
    expect(h.frame()).not.toContain('No Jev key found.');
    expect(h.frame()).toContain('1 typesafe');
    h.ctl().apply({ type: 'wizard', op: 'input', text: '2' });
    await tick();
    expect(h.frame()).toContain('Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY)  1/1');
    h.ctl().cancel();
    await until(() => h.done === 3);
    expect(h.exits).toEqual([]);
    for (const i of h.items) expect(i).not.toContain(KEY);
  });

  it('TUI-DESIGN-2 §4.3: the `prompt` prop draws the boxed console\'s `› ` masked row and places the cursor after the bullets', async () => {
    const positions: (CursorPosition | undefined)[] = [];
    const ui = render(<MaskedField length={6} columns={76} top={1} prompt="› " cursor={(p) => positions.push(p)} />);
    expect(strip(ui.lastFrame())).toBe('› ••••••');
    expect(positions.at(-1)).toEqual({ x: 8, y: 1 });
    cleanup();
    const h = harness();
    h.ctl().start({ missing: ['decider.apiKey'], mode: 'jev-only', provider: null, jevProvider: 'openrouter', trustNeeded: false });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'input', text: 'sk-or-v1-abc' });
    await tick();
    const boxed = render(<Wizard state={h.ctl().state} rows={3} columns={76} top={0} prompt="› " />);
    const lines = strip(boxed.lastFrame()).split('\n');
    expect(lines[0]).toBe('Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY)  1/1');
    expect(lines[1]).toBe(`› ${'•'.repeat(12)}`);
    for (const l of lines) expect(stringWidth(l)).toBeLessThanOrEqual(76);
  });
});
