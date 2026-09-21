/** tui/onboarding/reducer.ts (TUI-DESIGN §11.1, §19.0 row O7): the state machine; the reducer never holds a key; ≤ 4 rows. */
import { describe, expect, it } from 'vitest';
import {
  HINT_CTRL_C_QUITS,
  HINT_REJECTED,
  HINT_TOO_SHORT,
  INITIAL_ONBOARDING,
  WIZARD_EXIT_CODE,
  hintPrefix,
  looksLikeKey,
  onboardingReducer as reduce,
  sanitizeKeyInput,
  wizardActive,
  wizardRows,
  type OnboardingAction,
  type OnboardingState,
} from '../../../../src/tui/onboarding/reducer.js';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuv_-x';
const OR_KEY = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123';

function run(actions: OnboardingAction[], start: OnboardingState = INITIAL_ONBOARDING): OnboardingState {
  return actions.reduce((s, a) => reduce(s, a), start);
}
const detectBoth: OnboardingAction = { type: 'detect', missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false };

/** Every string value anywhere in the state; a key byte sequence must never be among them. */
function stringsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsIn(x, out);
  return out;
}

describe('onboardingReducer: detect', () => {
  it('missing=[] skips every key step: trust when needed, else sandbox', () => {
    expect(reduce(INITIAL_ONBOARDING, { type: 'detect', missing: [], mode: 'jev-on', provider: null, trustNeeded: true }).step).toBe('trust');
    expect(reduce(INITIAL_ONBOARDING, { type: 'detect', missing: [], mode: 'jev-on', provider: null, trustNeeded: false }).step).toBe('sandbox');
  });

  it('a missing generator key opens the provider step, preselected from --provider / JEVCODE_PROVIDER', () => {
    const s = reduce(INITIAL_ONBOARDING, detectBoth);
    expect(s.step).toBe('provider');
    expect(s.providerShown).toBe(true);
    expect(s.provider).toBeNull();
    const pre = reduce(INITIAL_ONBOARDING, { ...detectBoth, provider: 'openrouter' });
    expect(pre.step).toBe('provider');
    expect(pre.provider).toBe('openrouter');
  });

  it('skips the provider step when only the Jev key is missing, and under jev-only even if the generator key is missing', () => {
    const jevOnly = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: ['decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false });
    expect(jevOnly.step).toBe('jevKey');
    expect(jevOnly.field).toBe('decider.apiKey');
    expect(jevOnly.providerShown).toBe(false);
    const mode = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-only', provider: null, trustNeeded: false });
    expect(mode.step).toBe('jevKey');
    const modeGenOnly = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: ['generator.apiKey'], mode: 'jev-only', provider: null, trustNeeded: true });
    expect(modeGenOnly.step).toBe('trust');
  });
});

describe('onboardingReducer: provider → generator key → jev key → save', () => {
  it('1/2 choose the provider and open the masked generator field; Enter accepts a preselection; nothing preselected asks again', () => {
    const base = reduce(INITIAL_ONBOARDING, detectBoth);
    const a = reduce(base, { type: 'choose', option: 1 });
    expect(a.provider).toBe('anthropic');
    expect(a.step).toBe('generatorKey');
    expect(a.field).toBe('generator.apiKey');
    expect(a.length).toBe(0);
    const b = reduce(base, { type: 'choose', option: 2 });
    expect(b.provider).toBe('openrouter');
    const noPre = reduce(base, { type: 'choose', option: 'enter' });
    expect(noPre.step).toBe('provider');
    expect(noPre.hint).toBe('pick 1 or 2');
    const pre = reduce(reduce(INITIAL_ONBOARDING, { ...detectBoth, provider: 'openrouter' }), { type: 'choose', option: 'enter' });
    expect(pre.step).toBe('generatorKey');
    expect(pre.provider).toBe('openrouter');
  });

  it('length/clear track the masked length only; Enter needs ≥ 8 chars; the prefix hint warns once and a second Enter keeps the key', () => {
    const s0 = run([detectBoth, { type: 'choose', option: 1 }]);
    const s1 = reduce(s0, { type: 'length', length: 5 });
    expect(s1.length).toBe(5);
    const short = reduce(s1, { type: 'enter', length: 5, prefixOk: true });
    expect(short.step).toBe('generatorKey');
    expect(short.hint).toBe(HINT_TOO_SHORT);
    const cleared = reduce(short, { type: 'clear' });
    expect(cleared.length).toBe(0);
    expect(cleared.hint).toBeNull();
    const warned = reduce(reduce(cleared, { type: 'length', length: 40 }), { type: 'enter', length: 40, prefixOk: false });
    expect(warned.step).toBe('generatorKey');
    expect(warned.hint).toBe(hintPrefix('anthropic'));
    expect(warned.prefixWarned).toBe(true);
    const kept = reduce(warned, { type: 'enter', length: 40, prefixOk: false });
    expect(kept.step).toBe('jevKey');
    expect(kept.field).toBe('decider.apiKey');
    expect(kept.entered).toEqual(['generator.apiKey']);
    expect(kept.length).toBe(0);
    // NaN / negative / Infinity lengths are clamped to 0
    expect(reduce(s0, { type: 'length', length: NaN }).length).toBe(0);
    expect(reduce(s0, { type: 'length', length: -4 }).length).toBe(0);
    expect(reduce(s0, { type: 'enter', length: Infinity, prefixOk: true }).hint).toBe(HINT_TOO_SHORT);
  });

  it('Jev step: Enter on an empty field reuses the OpenRouter key; otherwise a real key is required; then save carries the request', () => {
    const atJev = run([detectBoth, { type: 'choose', option: 2 }, { type: 'enter', length: OR_KEY.length, prefixOk: true }]);
    expect(atJev.step).toBe('jevKey');
    const reused = reduce(atJev, { type: 'enter', length: 0, prefixOk: true });
    expect(reused.step).toBe('save');
    expect(reused.save).toEqual({ provider: 'openrouter', fields: ['generator.apiKey'], reuseGeneratorForJev: true });
    const typed = reduce(atJev, { type: 'enter', length: 60, prefixOk: true });
    expect(typed.save).toEqual({ provider: 'openrouter', fields: ['generator.apiKey', 'decider.apiKey'], reuseGeneratorForJev: false });
    // anthropic provider: an empty Jev field is too short, never a reuse
    const anth = run([detectBoth, { type: 'choose', option: 1 }, { type: 'enter', length: KEY.length, prefixOk: true }]);
    expect(reduce(anth, { type: 'enter', length: 0, prefixOk: true }).hint).toBe(HINT_TOO_SHORT);
    // only the Jev key missing: no generator entered → no reuse either
    const jevOnly = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: ['decider.apiKey'], mode: 'jev-on', provider: 'openrouter', trustNeeded: false });
    expect(reduce(jevOnly, { type: 'enter', length: 0, prefixOk: true }).hint).toBe(HINT_TOO_SHORT);
    // the provider step was never shown: the host must not write a provider the user never chose
    expect(reduce(jevOnly, { type: 'enter', length: 60, prefixOk: true }).save).toEqual({ provider: null, fields: ['decider.apiKey'], reuseGeneratorForJev: false });
    const noProviderAtAll = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: ['decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false });
    expect(reduce(noProviderAtAll, { type: 'enter', length: 40, prefixOk: true }).save?.provider).toBeNull();
    const reopened = reduce(INITIAL_ONBOARDING, { type: 'reopen', at: 'generator.apiKey', runLive: false });
    expect(reduce(reopened, { type: 'enter', length: 40, prefixOk: true }).save?.provider).toBeNull();
  });

  it('save → saved → verify? → n skips to trust or sandbox; y verifies; a rejected key returns to its field; keep proceeds', () => {
    const saved = run([detectBoth, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'enter', length: 0, prefixOk: true }, { type: 'saved' }]);
    expect(saved.step).toBe('verify');
    expect(saved.save).toBeNull();
    expect(reduce(saved, { type: 'verify-answer', yes: false }).step).toBe('sandbox');
    expect(reduce(saved, { type: 'verify-answer', yes: false }).verify).toBe('skipped');
    const trusty = reduce({ ...saved, trustNeeded: true }, { type: 'verify-answer', yes: false });
    expect(trusty.step).toBe('trust');
    const verifying = reduce(saved, { type: 'verify-answer', yes: true });
    expect(verifying.verifying).toBe(true);
    expect(reduce(verifying, { type: 'verify-answer', yes: true })).toBe(verifying);
    const ok = reduce(verifying, { type: 'verify-result', ok: true, rejected: null });
    expect(ok.step).toBe('sandbox');
    expect(ok.verify).toBe('ok');
    const rejected = reduce(verifying, { type: 'verify-result', ok: false, rejected: 'generator.apiKey' });
    expect(rejected.step).toBe('generatorKey');
    expect(rejected.hint).toBe(HINT_REJECTED);
    expect(rejected.entered).toEqual([]);
    const kept = reduce(rejected, { type: 'keep' });
    expect(kept.step).toBe('sandbox');
    // a re-entered generator key visits the Jev step again (Enter = reuse) before saving
    const retyped = reduce(rejected, { type: 'enter', length: 40, prefixOk: true });
    expect(retyped.step).toBe('jevKey');
    expect(reduce(retyped, { type: 'enter', length: 0, prefixOk: true }).step).toBe('save');
    const failedNoField = reduce(verifying, { type: 'verify-result', ok: false, rejected: null });
    expect(failedNoField.step).toBe('sandbox');
    expect(failedNoField.verify).toBe('failed');
    // a saved with nothing entered (nothing to verify) goes straight on
    const nothing = reduce({ ...saved, step: 'save', entered: [] }, { type: 'saved' });
    expect(nothing.step).toBe('sandbox');
  });

  it('save-failed returns to the last field with the reason as the hint', () => {
    const s = run([detectBoth, { type: 'choose', option: 1 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'enter', length: 40, prefixOk: true }]);
    expect(s.step).toBe('save');
    const f = reduce(s, { type: 'save-failed', reason: 'EACCES: cannot write ~/.config/jevcode/config.json' });
    expect(f.step).toBe('jevKey');
    expect(f.hint).toContain('EACCES');
    expect(f.entered).toEqual(['generator.apiKey']);
    expect(f.save).toBeNull();
  });

  it('save-failed with nothing entered returns to the field the detect would open, reason as the hint', () => {
    const jevOnly = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: ['decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false });
    const f = reduce({ ...jevOnly, step: 'save', field: null, entered: [], save: { provider: null, fields: [], reuseGeneratorForJev: false } }, { type: 'save-failed', reason: 'could not write ~/.config/jevcode/config.json: EACCES' });
    expect(f.step).toBe('jevKey');
    expect(f.field).toBe('decider.apiKey');
    expect(f.hint).toBe('could not write ~/.config/jevcode/config.json: EACCES');
    expect(f.entered).toEqual([]);
    const gen = reduce(INITIAL_ONBOARDING, detectBoth);
    const g = reduce({ ...gen, step: 'save', entered: [], save: { provider: null, fields: [], reuseGeneratorForJev: false } }, { type: 'save-failed', reason: 'x' });
    expect(g.field).toBe('generator.apiKey');
  });

  it('a rejected Jev key under openrouter: Enter on the empty field takes the reuse path (the generator key serves Jev)', () => {
    const verifying = run([detectBoth, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'enter', length: 40, prefixOk: true }, { type: 'saved' }, { type: 'verify-answer', yes: true }]);
    const rejected = reduce(verifying, { type: 'verify-result', ok: false, rejected: 'decider.apiKey' });
    expect(rejected.step).toBe('jevKey');
    expect(rejected.hint).toBe(HINT_REJECTED);
    expect(rejected.entered).toEqual(['generator.apiKey']);
    const reuse = reduce(rejected, { type: 'enter', length: 0, prefixOk: true });
    expect(reuse.step).toBe('save');
    expect(reuse.save).toEqual({ provider: 'openrouter', fields: ['generator.apiKey'], reuseGeneratorForJev: true });
    // under anthropic the same Enter is "too short"
    const anth = reduce(run([detectBoth, { type: 'choose', option: 1 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'enter', length: 40, prefixOk: true }, { type: 'saved' }, { type: 'verify-answer', yes: true }]), { type: 'verify-result', ok: false, rejected: 'decider.apiKey' });
    expect(reduce(anth, { type: 'enter', length: 0, prefixOk: true }).hint).toBe(HINT_TOO_SHORT);
  });

  it('cancel while step === save exits 2 (no run) or closes (run live) and drops the pending save request', () => {
    const save = run([detectBoth, { type: 'choose', option: 1 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'enter', length: 40, prefixOk: true }]);
    expect(save.step).toBe('save');
    expect(save.save).not.toBeNull();
    const exit = reduce(save, { type: 'cancel' });
    expect(exit.step).toBe('exit');
    expect(exit.exitCode).toBe(WIZARD_EXIT_CODE);
    expect(exit.save).toBeNull();
    const live = reduce({ ...save, runLive: true }, { type: 'cancel' });
    expect(live.step).toBe('done');
    expect(live.save).toBeNull();
    expect(wizardActive(live)).toBe(false);
  });

  it('reopen after exit clears the exit code and starts the requested step cleanly', () => {
    const exit = reduce(run([detectBoth, { type: 'choose', option: 1 }, { type: 'length', length: 9 }]), { type: 'cancel' });
    expect(exit.step).toBe('exit');
    const again = reduce(exit, { type: 'reopen', at: 'provider', runLive: false });
    expect(again.step).toBe('provider');
    expect(again.exitCode).toBeNull();
    expect(again.length).toBe(0);
    expect(again.entered).toEqual([]);
    expect(again.save).toBeNull();
    const atField = reduce(exit, { type: 'reopen', at: 'decider.apiKey', runLive: true });
    expect(atField.step).toBe('jevKey');
    expect(atField.exitCode).toBeNull();
    expect(atField.runLive).toBe(true);
  });

  it('trust 1/2/3 records the decision and moves to the sandbox line; sandbox-shown finishes', () => {
    const t = run([{ type: 'detect', missing: [], mode: 'jev-on', provider: null, trustNeeded: true }]);
    expect(t.step).toBe('trust');
    for (const option of [1, 2, 3] as const) {
      const d = reduce(t, { type: 'trust', option });
      expect(d.step).toBe('sandbox');
      expect(d.trustDecision).toBe(option);
      expect(reduce(d, { type: 'sandbox-shown' }).step).toBe('done');
    }
    expect(reduce(t, { type: 'sandbox-shown' })).toBe(t);
  });
});

describe('onboardingReducer: Esc and Ctrl-C', () => {
  it('Esc clears a non-empty field, else steps back: jev → generator → provider; on the first step it only hints', () => {
    const jev = run([detectBoth, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'length', length: 3 }]);
    const cleared = reduce(jev, { type: 'escape' });
    expect(cleared.step).toBe('jevKey');
    expect(cleared.length).toBe(0);
    const back = reduce(cleared, { type: 'escape' });
    expect(back.step).toBe('generatorKey');
    expect(back.entered).toEqual([]);
    const toProvider = reduce(back, { type: 'escape' });
    expect(toProvider.step).toBe('provider');
    const hinted = reduce(toProvider, { type: 'escape' });
    expect(hinted.step).toBe('provider');
    expect(hinted.hint).toBe(HINT_CTRL_C_QUITS);
    // generator field reached without a provider step (reopen at the field): Esc hints
    const reopened = reduce(INITIAL_ONBOARDING, { type: 'reopen', at: 'generator.apiKey', runLive: false });
    expect(reduce(reopened, { type: 'escape' }).hint).toBe(HINT_CTRL_C_QUITS);
    const jevOnly = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: ['decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false });
    expect(reduce(jevOnly, { type: 'escape' }).hint).toBe(HINT_CTRL_C_QUITS);
    expect(reduce(reduce(INITIAL_ONBOARDING, { type: 'detect', missing: [], mode: 'jev-on', provider: null, trustNeeded: true }), { type: 'escape' }).step).toBe('trust');
  });

  it('Ctrl-C exits 2 only when no run exists; during /login mid-run it closes the wizard (E5); it is inert once done', () => {
    const s = run([detectBoth, { type: 'choose', option: 1 }, { type: 'length', length: 12 }]);
    const exit = reduce(s, { type: 'cancel' });
    expect(exit.step).toBe('exit');
    expect(exit.exitCode).toBe(WIZARD_EXIT_CODE);
    expect(exit.length).toBe(0);
    const live = reduce({ ...s, runLive: true }, { type: 'cancel' });
    expect(live.step).toBe('done');
    expect(live.exitCode).toBeNull();
    expect(reduce(live, { type: 'cancel' })).toBe(live);
    expect(reduce(exit, { type: 'cancel' })).toBe(exit);
    const atTrust = run([{ type: 'detect', missing: [], mode: 'jev-on', provider: null, trustNeeded: true }]);
    expect(reduce(atTrust, { type: 'cancel' }).exitCode).toBe(2);
  });

  it('/login re-enters at the provider step or at a field with runLive carried', () => {
    const p = reduce(INITIAL_ONBOARDING, { type: 'reopen', at: 'provider', runLive: true });
    expect(p.step).toBe('provider');
    expect(p.runLive).toBe(true);
    const f = reduce(INITIAL_ONBOARDING, { type: 'reopen', at: 'decider.apiKey', runLive: true });
    expect(f.step).toBe('jevKey');
    expect(f.field).toBe('decider.apiKey');
    expect(reduce(f, { type: 'cancel' }).step).toBe('done');
  });
});

describe('onboardingReducer: invariants', () => {
  it('the state never holds a key: only lengths and booleans arrive, and no string in any state contains the key', () => {
    const states: OnboardingState[] = [];
    let s = INITIAL_ONBOARDING;
    const script: OnboardingAction[] = [
      detectBoth,
      { type: 'choose', option: 1 },
      { type: 'length', length: KEY.length },
      { type: 'enter', length: KEY.length, prefixOk: looksLikeKey(KEY, 'anthropic') },
      { type: 'length', length: OR_KEY.length },
      { type: 'enter', length: OR_KEY.length, prefixOk: true },
      { type: 'saved' },
      { type: 'verify-answer', yes: false },
      { type: 'sandbox-shown' },
    ];
    for (const a of script) {
      s = reduce(s, a);
      states.push(s);
    }
    expect(s.step).toBe('done');
    for (const st of states) {
      const json = JSON.stringify(st);
      expect(json).not.toContain(KEY);
      expect(json).not.toContain(OR_KEY);
      for (const str of stringsIn(st)) expect(str.length).toBeLessThan(120);
    }
    // the action union has no member carrying a key value
    const keys = new Set<string>();
    for (const a of script) for (const k of Object.keys(a)) keys.add(k);
    expect([...keys].sort()).toEqual(['at', 'length', 'missing', 'mode', 'option', 'prefixOk', 'provider', 'trustNeeded', 'type', 'yes'].filter((k) => k !== 'at'));
  });

  it('unknown or out-of-step actions return the same state object', () => {
    const s = reduce(INITIAL_ONBOARDING, detectBoth);
    expect(reduce(s, { type: 'length', length: 3 })).toBe(s);
    expect(reduce(s, { type: 'enter', length: 30, prefixOk: true })).toBe(s);
    expect(reduce(s, { type: 'saved' })).toBe(s);
    expect(reduce(s, { type: 'trust', option: 1 })).toBe(s);
    expect(reduce(s, { type: 'verify-answer', yes: true })).toBe(s);
    expect(reduce(s, { type: 'keep' })).toBe(s);
    expect(reduce(s, { type: 'bogus' } as unknown as OnboardingAction)).toBe(s);
  });

  it('wizardRows: provider 3, key 3, verify 2, trust 4 (2 below rows 12), else 0 — never more than 4; wizardActive covers save', () => {
    const base = reduce(INITIAL_ONBOARDING, detectBoth);
    expect(wizardRows(base, 24)).toBe(3);
    const key = reduce(base, { type: 'choose', option: 1 });
    expect(wizardRows(key, 24)).toBe(3);
    const save = run([{ type: 'enter', length: 40, prefixOk: true }, { type: 'enter', length: 40, prefixOk: true }], key);
    expect(wizardRows(save, 24)).toBe(0);
    expect(wizardActive(save)).toBe(true);
    const verify = reduce(save, { type: 'saved' });
    expect(wizardRows(verify, 24)).toBe(2);
    const trust = reduce({ ...verify, trustNeeded: true }, { type: 'verify-answer', yes: false });
    expect(wizardRows(trust, 24)).toBe(4);
    expect(wizardRows(trust, 11)).toBe(2);
    expect(wizardRows(trust, 12)).toBe(4);
    expect(wizardRows(trust, NaN)).toBe(4);
    const sandbox = reduce(trust, { type: 'trust', option: 1 });
    expect(wizardRows(sandbox, 24)).toBe(0);
    expect(wizardActive(sandbox)).toBe(false);
    for (const rows of [3, 8, 12, 24, 40, 50, 0, -1]) for (const st of [base, key, save, verify, trust, sandbox]) expect(wizardRows(st, rows)).toBeLessThanOrEqual(4);
  });
});

describe('looksLikeKey / sanitizeKeyInput (pure helpers the component applies to its ref)', () => {
  it('prefix hints per provider; null provider accepts anything', () => {
    expect(looksLikeKey(KEY, 'anthropic')).toBe(true);
    expect(looksLikeKey(KEY, 'openrouter')).toBe(false);
    expect(looksLikeKey(OR_KEY, 'openrouter')).toBe(true);
    expect(looksLikeKey('whatever', null)).toBe(true);
    expect(looksLikeKey('', 'anthropic')).toBe(false);
  });

  it('strips CSI/OSC sequences, SS2/SS3 and other ESC Fe sequences, controls, bracketed-paste markers and every whitespace; NFC-normalises', () => {
    expect(sanitizeKeyInput(`\u001b[200~${KEY}\r\n\u001b[201~`)).toBe(KEY);
    // SS3 (arrow / keypad in application mode) and SS2: the payload letter goes with the sequence
    expect(sanitizeKeyInput('abc\u001bOAdef')).toBe('abcdef');
    expect(sanitizeKeyInput('abc\u001bOHdef\u001bOF')).toBe('abcdef');
    expect(sanitizeKeyInput('abc\u001bNqdef')).toBe('abcdef');
    // other two-byte 7-bit ESC sequences (ESC 7 save cursor, ESC = keypad mode, ESC c reset)
    expect(sanitizeKeyInput('a\u001b7b\u001b=c\u001bcd')).toBe('abcd');
    expect(sanitizeKeyInput(`\u001bOA${KEY}\u001bOB`)).toBe(KEY);
    expect(sanitizeKeyInput(` ${KEY}\t \n`)).toBe(KEY);
    expect(sanitizeKeyInput('a\u0007b\u001b]0;title\u0007c\u007fd')).toBe('abcd');
    expect(sanitizeKeyInput('é')).toBe('é');
    expect(sanitizeKeyInput('')).toBe('');
    expect(sanitizeKeyInput('日本　語')).toBe('日本語');
  });
});
