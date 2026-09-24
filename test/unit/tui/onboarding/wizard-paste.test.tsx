/**
 * TUI-DESIGN-3 §1.8 edge 1 (`wizard.test.tsx`'s paste half, S3): a key pasted into the one-key field with the newline it
 * was copied with. Two shapes reach `<Wizard>`:
 *   - unbracketed (the terminal, and every pty driver): `splitInputChunk` (App.tsx §4.5 step 1) turns the chunk into the
 *     text and the Enter it ended with — TWO `wizard` actions applied in ONE React batch, so `stateRef.current` still
 *     holds the length from before the paste. The regression this pins: `submit` read that stale length and the wizard
 *     answered `key too short (8+ characters)` on a full field (the pasted key was saved nowhere).
 *   - bracketed (`usePaste`): one `input` action whose text keeps the trailing `\r` — the newline is the Enter.
 * Both save the clean key (`sanitizeKeyInput` strips the newline and every other control byte); the double-paste hint
 * still warns first; no key byte ever reaches a frame.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { Wizard, useWizard, type WizardController, type WizardHost, type WizardSaveInput } from '../../../../src/tui/onboarding/Wizard.js';
import { HINT_PASTED_TWICE, HINT_TOO_SHORT } from '../../../../src/tui/onboarding/reducer.js';

afterEach(() => cleanup());
const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** the save is a host round trip behind a passive effect: poll instead of guessing a tick (the suite runs under load) */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('until: condition not met in time');
    await tick(5);
  }
}
const KEY = 'sk-or-v1-fakefakefakefakefakefakefakefakefake';

interface Harness {
  ctl: () => WizardController;
  frame: () => string;
  saves: WizardSaveInput[];
}

/** the one-key field, open and waiting for the paste */
function harness(): Harness {
  const saves: WizardSaveInput[] = [];
  const host: WizardHost = {
    save: async (input) => {
      saves.push(input);
      return { ok: true, items: [] };
    },
  };
  let ctlRef: WizardController | null = null;
  function Probe(): React.JSX.Element {
    const ctl = useWizard({ host: () => host, onItem: () => undefined, onDone: () => undefined, onExit: () => undefined });
    ctlRef = ctl;
    return ctl.active ? <Wizard state={ctl.state} rows={ctl.rows(24)} columns={80} top={0} /> : <Text>closed</Text>;
  }
  const ui = render(<Probe />);
  const h: Harness = { ctl: () => ctlRef as WizardController, frame: () => strip(ui.lastFrame()), saves };
  h.ctl().start({ missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false, found: null });
  return h;
}

describe('TUI-DESIGN-3 §1.8 edge 1: a key pasted with its newline', () => {
  it('the unbracketed chunk (text + Enter in one React batch) saves the clean key — the Enter reads the BUFFER, never the stale snapshot length', async () => {
    const h = harness();
    await tick();
    expect(h.frame()).toContain('OpenRouter API key');
    // exactly what `splitInputChunk('sk-or-…\r', …)` hands the App: two actions, no render in between
    h.ctl().apply({ type: 'wizard', op: 'input', text: KEY });
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await until(() => h.saves.length > 0);
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]?.values['key']).toBe(KEY);
    expect(h.saves[0]?.oneKey).toBe(true);
    expect(h.saves[0]?.keyAs).toBe('both');
    expect(h.frame()).not.toContain(HINT_TOO_SHORT);
    expect(h.frame()).not.toContain('fakefake');
  });

  it('the bracketed paste keeps its trailing newline in one action: `\\r`, `\\n` and `\\r\\n` all save the clean key', async () => {
    for (const nl of ['\r', '\n', '\r\n']) {
      const h = harness();
      await tick();
      h.ctl().apply({ type: 'wizard', op: 'input', text: `${KEY}${nl}` });
      await until(() => h.saves.length > 0);
      expect(h.saves.map((s) => s.values['key'])).toEqual([KEY]);
      cleanup();
    }
  });

  it('control characters inside the pasted text are stripped, never keys; a paste without a newline waits for Enter', async () => {
    const h = harness();
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'input', text: `sk-or-v1-a\u0007bc\u001b[Ddef\t g\r\n` });
    await until(() => h.saves.length > 0);
    expect(h.saves.map((s) => s.values['key'])).toEqual(['sk-or-v1-abcdefg']);
    cleanup();
    const noNewline = harness();
    await tick();
    noNewline.ctl().apply({ type: 'wizard', op: 'input', text: KEY });
    await tick(30);
    expect(noNewline.saves).toHaveLength(0);
    expect(noNewline.ctl().state.length).toBe(KEY.length);
    expect(noNewline.frame()).toContain(`${KEY.length} chars`);
  });

  it('edge 2 survives the newline: a key pasted twice with a trailing CR warns instead of saving; the next Enter keeps it', async () => {
    const h = harness();
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'input', text: `${KEY}${KEY}\r` });
    await tick(30);
    expect(h.saves).toHaveLength(0);
    expect(h.frame()).toContain(HINT_PASTED_TWICE);
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await until(() => h.saves.length > 0);
    expect(h.saves.map((s) => s.values['key'])).toEqual([`${KEY}${KEY}`]);
  });

  it('Esc after a paste in the same batch clears the buffer the reducer emptied (a later Enter never saves the leftovers)', async () => {
    const h = harness();
    await tick();
    h.ctl().apply({ type: 'wizard', op: 'input', text: KEY });
    h.ctl().apply({ type: 'wizard', op: 'back' });
    await tick(30);
    expect(h.ctl().state.step).toBe('key');
    expect(h.ctl().state.length).toBe(0);
    h.ctl().apply({ type: 'wizard', op: 'input', text: 'sk-or-v1-second-key-0123456789' });
    h.ctl().apply({ type: 'wizard', op: 'submit' });
    await until(() => h.saves.length > 0);
    expect(h.saves.map((s) => s.values['key'])).toEqual(['sk-or-v1-second-key-0123456789']);
  });
});
