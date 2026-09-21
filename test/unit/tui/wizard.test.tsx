/**
 * TUI-DESIGN §19.3 (`wizard.test.tsx`, §11.1, F10): the masked field — zero key bytes in every frame, the bytes only
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
import { Wizard, useWizard, type WizardController, type WizardHost, type WizardSaveInput } from '../../../src/tui/onboarding/Wizard.js';
import { stringWidth } from '../../../src/tui/composer/width.js';

afterEach(() => cleanup());
const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
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
  exits: number[];
  done: number;
  host: WizardHost & { saves: WizardSaveInput[]; order: string[] };
}

function harness(hostOver: Partial<WizardHost> = {}): Harness {
  const items: string[] = [];
  const exits: number[] = [];
  const h: Harness = { ctl: () => ctlRef!, frame: () => '', items, exits, done: 0, host: null as never };
  const host: Harness['host'] = {
    saves: [],
    order: [],
    save: async (input) => {
      host.order.push('addSecret');
      host.saves.push(input);
      host.order.push('write');
      return { ok: true, items: ['generator key: entered (sha256:e31150e9) source=wizard', 'saved ~/.config/jevcode/config.json (mode 0600, dir 0700)'] };
    },
    sandboxLine: () => 'seatbelt — writes confined to the workspace and run dirs',
    ...hostOver,
  };
  h.host = host;
  let ctlRef: WizardController | null = null;
  function Probe(): React.JSX.Element {
    const ctl = useWizard({ host: () => host, onItem: (t, l) => items.push(`${l} ${t}`), onDone: () => (h.done += 1), onExit: (c) => exits.push(c) });
    ctlRef = ctl;
    return ctl.active ? <Wizard state={ctl.state} rows={ctl.rows(24)} columns={80} top={0} /> : <Text>closed</Text>;
  }
  const ui = render(<Probe />);
  h.frame = () => strip(ui.lastFrame());
  return h;
}

describe('useWizard + <Wizard> (§11.1)', () => {
  it('provider step: digits pick; the key field masks every byte and only `length` reaches the reducer; Enter < 8 hints', async () => {
    const h = harness();
    h.ctl().start({ missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false });
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

  it('a pasted key never appears in a frame; Enter saves through the host (addSecret first), appends the [setup] items, then Enter reuses the key for Jev', async () => {
    const h = harness();
    h.ctl().start({ missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: 'openrouter', trustNeeded: false });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'submit' }); // Enter accepts the preselected provider
    await tick();
    const frames: string[] = [];
    h.ctl().apply({ type: 'wizard', op: 'input', text: `sk-or-v1-${KEY}` });
    await tick();
    frames.push(h.frame());
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await tick();
    frames.push(h.frame());
    expect(h.frame()).toContain('Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY)  2/2');
    expect(h.frame()).toContain('Enter = reuse the OpenRouter key for Jev');
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await tick(20);
    frames.push(h.frame());
    expect(h.host.saves).toHaveLength(1);
    expect(h.host.saves[0]?.reuseGeneratorForJev).toBe(true);
    expect(h.host.saves[0]?.values['generator.apiKey']).toBe(`sk-or-v1-${KEY}`);
    expect(h.host.order).toEqual(['addSecret', 'write']);
    expect(h.items).toContain('[setup] generator key: entered (sha256:e31150e9) source=wizard');
    for (const f of frames) expect(f).not.toContain(KEY);
    for (const i of h.items) expect(i).not.toContain(KEY);
    // verify step → n skips → sandbox line → done
    expect(h.frame()).toContain('Verify the keys now? [y] yes (one priced Jev call, ~$0.0001)  [n] skip');
    h.ctl().apply({ type: 'wizard', op: 'input', text: 'n' });
    await tick(60);
    expect(h.items).toContain('[sandbox] seatbelt — writes confined to the workspace and run dirs');
    expect(h.done).toBe(1);
    expect(h.frame()).toBe('closed');
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
    await tick(60);
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
    saved.ctl().apply({ type: 'wizard', op: 'submit' }); // Enter accepts the preselected provider
    await tick();
    saved.ctl().apply({ type: 'wizard', op: 'input', text: `sk-or-v1-${KEY}` });
    await tick();
    saved.ctl().apply({ type: 'wizard', op: 'submit' });
    await tick();
    saved.ctl().apply({ type: 'wizard', op: 'submit' }); // Enter = reuse the OpenRouter key for Jev → save
    await tick(60);
    expect(saved.host.saves).toHaveLength(1);
    expect(saved.ctl().state.step).toBe('verify');
    saved.ctl().apply({ type: 'wizard', op: 'submit' }); // Enter = no priced verification → sandbox line → done
    await tick(60);
    expect(saved.done).toBe(1);
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
    h.ctl().start({ missing: ['decider.apiKey'], mode: 'jev-only', provider: null, trustNeeded: false });
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'input', text: 'x'.repeat(108) });
    await tick();
    const ui = render(<Wizard state={h.ctl().state} rows={3} columns={40} top={0} />);
    const lines = strip(ui.lastFrame()).split('\n');
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(stringWidth(l)).toBeLessThanOrEqual(40);
    expect(lines[1]).toBe(`> ${'•'.repeat(37)}`);
  });
});
