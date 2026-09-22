/** tui/onboarding/reducer.ts (TUI-DESIGN §11.1, §19.0 row O7; TUI-DESIGN-2 §1.4, §8.1 S2): the state machine; the reducer never holds a key; ≤ 4 rows. */
import { describe, expect, it } from 'vitest';
import {
  HINT_CTRL_C_CLOSES,
  HINT_CTRL_C_QUITS,
  HINT_PASTED_TWICE,
  HINT_PICK_OPTION,
  HINT_PREFIX_KEY,
  HINT_REJECTED,
  HINT_TOO_SHORT,
  IMPORT_PROBE_DEADLINE_MS,
  INITIAL_ONBOARDING,
  JEV_PROVIDER_OPTIONS,
  importStepWanted,
  WIZARD_EXIT_CODE,
  WIZARD_OPTIONS_ORDER,
  cancelCloses,
  expectedKeyProvider,
  hintPrefix,
  isFieldStep,
  keyAsOf,
  looksLikeKey,
  looksPastedTwice,
  onboardingReducer as reduce,
  openrouterGeneratorEntered,
  reuseJevOffered,
  reuseOffered,
  sanitizeKeyInput,
  skipOffered,
  targetMode,
  wizardActive,
  wizardRows,
  type OnboardingAction,
  type OnboardingState,
  type SaveRequest,
} from '../../../../src/tui/onboarding/reducer.js';
import { DEFAULT_MODE } from '../../../../src/config/defaults.js';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuv_-x';
const OR_KEY = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123';

function run(actions: OnboardingAction[], start: OnboardingState = INITIAL_ONBOARDING): OnboardingState {
  return actions.reduce((s, a) => reduce(s, a), start);
}
/** a jev-on first run with both keys missing and nothing inferred — TUI-DESIGN-3 §1.4: the one-paste `key` step */
const detectBoth: OnboardingAction = { type: 'detect', missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false };
/** the same with a non-openrouter generator provider preselected (`--provider anthropic`): the round-2 provider step */
const detectBothProvider: OnboardingAction = { ...detectBoth, provider: 'anthropic' };
/** TUI-DESIGN-3 §1.4.1: a `SaveRequest` with the round-3 members at their round-2-flow values (found null → keyAs both, no reuse, no pending mode) */
const req = (o: Pick<SaveRequest, 'provider' | 'jevProvider' | 'fields' | 'reuseGeneratorForJev'> & Partial<SaveRequest>): SaveRequest => ({ oneKey: false, keyAs: 'both', reuseJevForGenerator: false, pendMode: null, ...o });
/** TUI-DESIGN-2 §1.1: the default first run — jev-only, only the Jev key missing */
const detectJevOnly: OnboardingAction = { type: 'detect', missing: ['decider.apiKey'], mode: 'jev-only', provider: null, trustNeeded: false };

/** Every string value anywhere in the state; a key byte sequence must never be among them. */
function stringsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsIn(x, out);
  return out;
}

describe('onboardingReducer: detect', () => {
  it('the initial state is DEFAULT_MODE (TUI-DESIGN-3 §1.1) with reason `missing` and no Jev provider', () => {
    expect(INITIAL_ONBOARDING.mode).toBe(DEFAULT_MODE);
    expect(INITIAL_ONBOARDING.currentMode).toBe(DEFAULT_MODE);
    expect(INITIAL_ONBOARDING.found).toBeNull();
    expect(INITIAL_ONBOARDING.pendMode).toBeNull();
    expect(INITIAL_ONBOARDING.reason).toBe('missing');
    expect(INITIAL_ONBOARDING.jevProvider).toBeNull();
    expect(INITIAL_ONBOARDING.jevProviderShown).toBe(false);
  });

  it('missing=[] skips every key step: trust when needed, else sandbox', () => {
    expect(reduce(INITIAL_ONBOARDING, { type: 'detect', missing: [], mode: 'jev-on', provider: null, trustNeeded: true }).step).toBe('trust');
    expect(reduce(INITIAL_ONBOARDING, { type: 'detect', missing: [], mode: 'jev-on', provider: null, trustNeeded: false }).step).toBe('sandbox');
  });

  it('a missing generator key opens the provider step when a non-openrouter provider is preselected (--provider anthropic / JEVCODE_PROVIDER); TUI-DESIGN-3 §1.4: null or openrouter opens the one-paste `key` step', () => {
    const s = reduce(INITIAL_ONBOARDING, detectBothProvider);
    expect(s.step).toBe('provider');
    expect(s.providerShown).toBe(true);
    expect(s.provider).toBe('anthropic');
    const pre = reduce(INITIAL_ONBOARDING, { ...detectBoth, provider: 'openrouter' });
    expect(pre.step).toBe('key');
    expect(pre.field).toBe('key');
    expect(pre.provider).toBe('openrouter');
    expect(pre.providerShown).toBe(false);
    const none = reduce(INITIAL_ONBOARDING, detectBoth);
    expect(none.step).toBe('key');
    expect(none.found).toBeNull();
  });

  it('TUI-DESIGN-2 §1.4: a jev-only first run asks the Jev provider when nothing inferred it, else goes straight to the Jev key; the generator key is never asked', () => {
    const ask = reduce(INITIAL_ONBOARDING, detectJevOnly);
    expect(ask.step).toBe('jevProvider');
    expect(ask.jevProviderShown).toBe(true);
    expect(ask.providerShown).toBe(false);
    expect(ask.field).toBeNull();
    const inferred = reduce(INITIAL_ONBOARDING, { ...detectJevOnly, jevProvider: 'typesafe' });
    expect(inferred.step).toBe('jevKey');
    expect(inferred.field).toBe('decider.apiKey');
    expect(inferred.jevProvider).toBe('typesafe');
    expect(inferred.jevProviderShown).toBe(false);
    // the detect-time `provider` is the RESOLVED generator provider — openrouter by default since commit 2a92d0b — and never skips
    // the question: a TypeSafe key saved as an openrouter key would be sent to openrouter.ai (§1.4 blocker)
    const orGen = reduce(INITIAL_ONBOARDING, { ...detectJevOnly, provider: 'openrouter' });
    expect(orGen.step).toBe('jevProvider');
    expect(orGen.jevProviderShown).toBe(true);
    // only an OpenRouter generator key typed in THIS wizard (the reuse rule) or an explicit detect `jevProvider` skips it
    const orTyped = run([detectBothProvider, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }]);
    expect(orTyped.step).toBe('jevKey');
    expect(orTyped.jevProviderShown).toBe(false);
    expect(openrouterGeneratorEntered(orTyped)).toBe(true);
    expect(openrouterGeneratorEntered(orGen)).toBe(false);
    expect(reduce(INITIAL_ONBOARDING, { ...detectJevOnly, provider: 'openrouter', jevProvider: 'openrouter' }).step).toBe('jevKey');
    // jev-only with the generator key missing too: still no generator step
    const both = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-only', provider: null, trustNeeded: false });
    expect(both.step).toBe('jevProvider');
    const modeGenOnly = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: ['generator.apiKey'], mode: 'jev-only', provider: null, trustNeeded: true });
    expect(modeGenOnly.step).toBe('trust');
    // jev-on with only the Jev key missing and an anthropic generator: the Jev provider is asked
    const anth = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: ['decider.apiKey'], mode: 'jev-on', provider: 'anthropic', trustNeeded: false });
    expect(anth.step).toBe('jevProvider');
    expect(reduce(INITIAL_ONBOARDING, { ...detectJevOnly, reason: 'login' }).reason).toBe('login');
    expect(reduce(INITIAL_ONBOARDING, detectJevOnly).reason).toBe('missing');
  });
});

describe('onboardingReducer: the jevProvider step (TUI-DESIGN-2 §1.4)', () => {
  it('1 → typesafe, 2 → openrouter, Enter → the preselection, nothing preselected asks again; then the Jev key field', () => {
    expect(JEV_PROVIDER_OPTIONS).toEqual(['typesafe', 'openrouter']);
    const s = reduce(INITIAL_ONBOARDING, detectJevOnly);
    const ts = reduce(s, { type: 'choose', option: 1 });
    expect(ts.step).toBe('jevKey');
    expect(ts.jevProvider).toBe('typesafe');
    expect(ts.field).toBe('decider.apiKey');
    expect(ts.length).toBe(0);
    const or = reduce(s, { type: 'choose', option: 2 });
    expect(or.jevProvider).toBe('openrouter');
    const noPre = reduce(s, { type: 'choose', option: 'enter' });
    expect(noPre.step).toBe('jevProvider');
    expect(noPre.hint).toBe('pick 1 or 2');
    const pre = reduce({ ...s, jevProvider: 'typesafe' }, { type: 'choose', option: 'enter' });
    expect(pre.step).toBe('jevKey');
    expect(pre.jevProvider).toBe('typesafe');
    // field actions are inert on the step
    expect(reduce(s, { type: 'length', length: 3 })).toBe(s);
    expect(reduce(s, { type: 'enter', length: 30, prefixOk: true })).toBe(s);
  });

  it('the save carries jevProvider only when the step was shown; a preselected (inferred) provider is never written', () => {
    const shown = run([detectJevOnly, { type: 'choose', option: 1 }, { type: 'enter', length: 40, prefixOk: true }]);
    expect(shown.step).toBe('save');
    expect(shown.save).toEqual(req({ provider: null, jevProvider: 'typesafe', fields: ['decider.apiKey'], reuseGeneratorForJev: false }));
    const inferred = run([{ ...detectJevOnly, jevProvider: 'typesafe' }, { type: 'enter', length: 40, prefixOk: true }]);
    expect(inferred.save).toEqual(req({ provider: null, jevProvider: null, fields: ['decider.apiKey'], reuseGeneratorForJev: false }));
    // jev-on: generator (anthropic) → jev provider asked → jev key; both providers travel with the save
    const full = run([detectBothProvider, { type: 'choose', option: 1 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }]);
    expect(full.save).toEqual(req({ provider: 'anthropic', jevProvider: 'openrouter', fields: ['generator.apiKey', 'decider.apiKey'], reuseGeneratorForJev: false }));
  });

  it('Esc from the Jev key returns to the jevProvider step when it was shown, else to the generator field / provider step / a hint', () => {
    const atKey = run([detectJevOnly, { type: 'choose', option: 1 }]);
    const back = reduce(atKey, { type: 'escape' });
    expect(back.step).toBe('jevProvider');
    expect(back.jevProvider).toBe('typesafe');
    expect(reduce(back, { type: 'escape' }).hint).toBe(HINT_CTRL_C_QUITS);
    // after a generator key the jevProvider step's Esc goes back to the generator field
    const afterGen = run([detectBothProvider, { type: 'choose', option: 1 }, { type: 'enter', length: 40, prefixOk: true }]);
    expect(afterGen.step).toBe('jevProvider');
    const gen = reduce(afterGen, { type: 'escape' });
    expect(gen.step).toBe('generatorKey');
    expect(gen.entered).toEqual([]);
    const inferred = reduce(INITIAL_ONBOARDING, { ...detectJevOnly, jevProvider: 'typesafe' });
    expect(reduce(inferred, { type: 'escape' }).hint).toBe(HINT_CTRL_C_QUITS);
  });

  it('expectedKeyProvider: the Jev step is checked against the Jev provider (openrouter when none), the generator step against the generator; typesafe accepts any shape', () => {
    const jev = run([detectJevOnly, { type: 'choose', option: 1 }]);
    expect(expectedKeyProvider(jev)).toBe('typesafe');
    expect(looksLikeKey('whatever-shape-1234', expectedKeyProvider(jev))).toBe(true);
    const or = run([detectJevOnly, { type: 'choose', option: 2 }]);
    expect(expectedKeyProvider(or)).toBe('openrouter');
    expect(looksLikeKey(KEY, expectedKeyProvider(or))).toBe(false);
    expect(looksLikeKey(OR_KEY, expectedKeyProvider(or))).toBe(true);
    const noJev = reduce(INITIAL_ONBOARDING, { ...detectJevOnly, provider: 'anthropic', jevProvider: null });
    expect(noJev.step).toBe('jevProvider');
    const gen = run([detectBothProvider, { type: 'choose', option: 1 }]);
    expect(expectedKeyProvider(gen)).toBe('anthropic');
    // a `/login` reopen at the Jev key with the session's resolved provider goes straight to the field; with none it asks first
    const reopened = reduce(INITIAL_ONBOARDING, { type: 'reopen', at: 'decider.apiKey', runLive: true, jevProvider: 'openrouter' });
    expect(reopened.step).toBe('jevKey');
    expect(expectedKeyProvider(reopened)).toBe('openrouter');
    const unknown = reduce(INITIAL_ONBOARDING, { type: 'reopen', at: 'decider.apiKey', runLive: true });
    expect(unknown.step).toBe('jevProvider');
    expect(expectedKeyProvider(reduce(unknown, { type: 'choose', option: 1 }))).toBe('typesafe');
  });

  it('TUI-DESIGN-2 §1.4 (finding 2): after an OpenRouter generator key a typesafe Jev provider never offers `Enter = reuse` — an empty Enter is too short', () => {
    // the Jev provider was inferred (typesafe) before the wizard opened; the generator is openrouter and its key was typed here
    const atJev = run([{ ...detectBothProvider, jevProvider: 'typesafe' }, { type: 'choose', option: 2 }, { type: 'enter', length: OR_KEY.length, prefixOk: true }]);
    expect(atJev.step).toBe('jevKey');
    expect(atJev.jevProvider).toBe('typesafe');
    expect(atJev.jevProviderShown).toBe(false);
    expect(reuseOffered(atJev)).toBe(false);
    const empty = reduce(atJev, { type: 'enter', length: 0, prefixOk: true });
    expect(empty.step).toBe('jevKey');
    expect(empty.hint).toBe(HINT_TOO_SHORT);
    expect(empty.save).toBeNull();
    // a typed TypeSafe key saves with the generator's key, never as a reuse
    const typed = reduce(atJev, { type: 'enter', length: 44, prefixOk: true });
    expect(typed.save).toEqual(req({ provider: 'openrouter', jevProvider: null, fields: ['generator.apiKey', 'decider.apiKey'], reuseGeneratorForJev: false }));
    // the same choice made on the jevProvider step (1 = typesafe) after the openrouter key: the step is shown only when nothing inferred it — here an anthropic generator
    const chosen = run([detectBothProvider, { type: 'choose', option: 1 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'choose', option: 1 }]);
    expect(reuseOffered(chosen)).toBe(false);
    expect(reduce(chosen, { type: 'enter', length: 0, prefixOk: true }).hint).toBe(HINT_TOO_SHORT);
    // openrouter (or unresolved) Jev provider after the OpenRouter key: reuse is offered
    const or = run([{ ...detectBothProvider, jevProvider: 'openrouter' }, { type: 'choose', option: 2 }, { type: 'enter', length: OR_KEY.length, prefixOk: true }]);
    expect(reuseOffered(or)).toBe(true);
    expect(reduce(or, { type: 'enter', length: 0, prefixOk: true }).save?.reuseGeneratorForJev).toBe(true);
    const unresolved = run([detectBothProvider, { type: 'choose', option: 2 }, { type: 'enter', length: OR_KEY.length, prefixOk: true }]);
    expect(reuseOffered(unresolved)).toBe(true);
    // never on the generator step, never without the generator key typed here
    expect(reuseOffered({ step: 'generatorKey', provider: 'openrouter', entered: ['generator.apiKey'], jevProvider: null })).toBe(false);
    expect(reuseOffered({ step: 'jevKey', provider: 'openrouter', entered: [], jevProvider: null })).toBe(false);
    expect(reuseOffered({ step: 'jevKey', provider: 'anthropic', entered: ['generator.apiKey'], jevProvider: 'openrouter' })).toBe(false);
  });
});

describe('onboardingReducer: provider → generator key → jev key → save', () => {
  it('1/2 choose the provider and open the masked generator field; Enter accepts a preselection; nothing preselected (a /login reopen at the step) asks again', () => {
    const base = reduce(INITIAL_ONBOARDING, detectBothProvider);
    const a = reduce(base, { type: 'choose', option: 1 });
    expect(a.provider).toBe('anthropic');
    expect(a.step).toBe('generatorKey');
    expect(a.field).toBe('generator.apiKey');
    expect(a.length).toBe(0);
    const b = reduce(base, { type: 'choose', option: 2 });
    expect(b.provider).toBe('openrouter');
    const noPre = reduce(reduce(INITIAL_ONBOARDING, { type: 'reopen', at: 'provider', runLive: false }), { type: 'choose', option: 'enter' });
    expect(noPre.step).toBe('provider');
    expect(noPre.hint).toBe('pick 1 or 2');
    const pre = reduce(base, { type: 'choose', option: 'enter' });
    expect(pre.step).toBe('generatorKey');
    expect(pre.provider).toBe('anthropic');
  });

  it('length/clear track the masked length only; Enter needs ≥ 8 chars; the prefix hint warns once and a second Enter keeps the key', () => {
    const s0 = run([detectBothProvider, { type: 'choose', option: 1 }]);
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
    // anthropic generator: the Jev provider is asked before the Jev key (§1.4)
    expect(kept.step).toBe('jevProvider');
    expect(kept.entered).toEqual(['generator.apiKey']);
    const atJev = reduce(kept, { type: 'choose', option: 2 });
    expect(atJev.step).toBe('jevKey');
    expect(atJev.field).toBe('decider.apiKey');
    expect(atJev.length).toBe(0);
    // an openrouter generator goes straight to the Jev key
    const or = run([detectBothProvider, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }]);
    expect(or.step).toBe('jevKey');
    // the prefix hint on the generator step names the openrouter default when no provider is known
    expect(reduce({ ...s0, provider: null }, { type: 'enter', length: 40, prefixOk: false }).hint).toBe(hintPrefix('openrouter'));
    // NaN / negative / Infinity lengths are clamped to 0
    expect(reduce(s0, { type: 'length', length: NaN }).length).toBe(0);
    expect(reduce(s0, { type: 'length', length: -4 }).length).toBe(0);
    expect(reduce(s0, { type: 'enter', length: Infinity, prefixOk: true }).hint).toBe(HINT_TOO_SHORT);
  });

  it('Jev step: Enter on an empty field reuses the OpenRouter key; otherwise a real key is required; then save carries the request', () => {
    const atJev = run([detectBothProvider, { type: 'choose', option: 2 }, { type: 'enter', length: OR_KEY.length, prefixOk: true }]);
    expect(atJev.step).toBe('jevKey');
    const reused = reduce(atJev, { type: 'enter', length: 0, prefixOk: true });
    expect(reused.step).toBe('save');
    expect(reused.save).toEqual(req({ provider: 'openrouter', jevProvider: null, fields: ['generator.apiKey'], reuseGeneratorForJev: true }));
    const typed = reduce(atJev, { type: 'enter', length: 60, prefixOk: true });
    expect(typed.save).toEqual(req({ provider: 'openrouter', jevProvider: null, fields: ['generator.apiKey', 'decider.apiKey'], reuseGeneratorForJev: false }));
    // anthropic provider: an empty Jev field is too short, never a reuse
    const anth = run([detectBothProvider, { type: 'choose', option: 1 }, { type: 'enter', length: KEY.length, prefixOk: true }, { type: 'choose', option: 2 }]);
    expect(reduce(anth, { type: 'enter', length: 0, prefixOk: true }).hint).toBe(HINT_TOO_SHORT);
    // only the Jev key missing with the resolved (default) openrouter generator: the Jev provider is asked; no generator entered → no reuse either
    const jevOnlyAsk = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: ['decider.apiKey'], mode: 'jev-on', provider: 'openrouter', trustNeeded: false });
    expect(jevOnlyAsk.step).toBe('jevProvider');
    const jevOnly = reduce(jevOnlyAsk, { type: 'choose', option: 2 });
    expect(jevOnly.step).toBe('jevKey');
    expect(reduce(jevOnly, { type: 'enter', length: 0, prefixOk: true }).hint).toBe(HINT_TOO_SHORT);
    // the provider step was never shown: the host must not write a provider the user never chose; the jevProvider step was, so its choice is written
    expect(reduce(jevOnly, { type: 'enter', length: 60, prefixOk: true }).save).toEqual(req({ provider: null, jevProvider: 'openrouter', fields: ['decider.apiKey'], reuseGeneratorForJev: false }));
    const noProviderAtAll = run([{ type: 'detect', missing: ['decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false }, { type: 'choose', option: 1 }]);
    expect(reduce(noProviderAtAll, { type: 'enter', length: 40, prefixOk: true }).save).toEqual(req({ provider: null, jevProvider: 'typesafe', fields: ['decider.apiKey'], reuseGeneratorForJev: false }));
    const reopened = reduce(INITIAL_ONBOARDING, { type: 'reopen', at: 'generator.apiKey', runLive: false });
    expect(reduce(reopened, { type: 'enter', length: 40, prefixOk: true }).save?.provider).toBeNull();
  });

  it('save → saved → verify? → n skips to trust or sandbox; y verifies; a rejected key returns to its field; keep proceeds', () => {
    const saved = run([detectBothProvider, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'enter', length: 0, prefixOk: true }, { type: 'saved' }]);
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
    const s = run([detectBothProvider, { type: 'choose', option: 1 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }]);
    expect(s.step).toBe('save');
    const f = reduce(s, { type: 'save-failed', reason: 'EACCES: cannot write ~/.config/jevcode/config.json' });
    expect(f.step).toBe('jevKey');
    expect(f.hint).toContain('EACCES');
    expect(f.entered).toEqual(['generator.apiKey']);
    expect(f.save).toBeNull();
  });

  it('save-failed with nothing entered returns to the field the detect would open, reason as the hint; under reason `mode` the target mode picks the generator field (§1.4)', () => {
    const jevOnly = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: ['decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false });
    const f = reduce({ ...jevOnly, step: 'save', field: null, entered: [], save: req({ provider: null, jevProvider: null, fields: [], reuseGeneratorForJev: false }) }, { type: 'save-failed', reason: 'could not write ~/.config/jevcode/config.json: EACCES' });
    expect(f.step).toBe('jevKey');
    expect(f.field).toBe('decider.apiKey');
    expect(f.hint).toBe('could not write ~/.config/jevcode/config.json: EACCES');
    expect(f.entered).toEqual([]);
    const gen = reduce(INITIAL_ONBOARDING, detectBothProvider);
    const g = reduce({ ...gen, step: 'save', entered: [], save: req({ provider: null, jevProvider: null, fields: [], reuseGeneratorForJev: false }) }, { type: 'save-failed', reason: 'x' });
    expect(g.field).toBe('generator.apiKey');
    // /mode jev-on from a jev-only session whose detect listed both keys as missing: the target mode (jev-on) needs the generator
    const mode = run([{ type: 'detect', missing: ['generator.apiKey', 'decider.apiKey'], mode: 'jev-only', provider: null, trustNeeded: false }, { type: 'reopen', at: 'provider', runLive: false, reason: 'mode', mode: 'jev-on' }]);
    const m = reduce({ ...mode, step: 'save', entered: [], save: req({ provider: 'anthropic', jevProvider: null, fields: [], reuseGeneratorForJev: false }) }, { type: 'save-failed', reason: 'x' });
    expect(m.field).toBe('generator.apiKey');
    expect(m.step).toBe('generatorKey');
  });

  it('a rejected Jev key under openrouter: Enter on the empty field takes the reuse path (the generator key serves Jev)', () => {
    const verifying = run([detectBothProvider, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'enter', length: 40, prefixOk: true }, { type: 'saved' }, { type: 'verify-answer', yes: true }]);
    const rejected = reduce(verifying, { type: 'verify-result', ok: false, rejected: 'decider.apiKey' });
    expect(rejected.step).toBe('jevKey');
    expect(rejected.hint).toBe(HINT_REJECTED);
    expect(rejected.entered).toEqual(['generator.apiKey']);
    const reuse = reduce(rejected, { type: 'enter', length: 0, prefixOk: true });
    expect(reuse.step).toBe('save');
    expect(reuse.save).toEqual(req({ provider: 'openrouter', jevProvider: null, fields: ['generator.apiKey'], reuseGeneratorForJev: true }));
    // under anthropic the same Enter is "too short"
    const anth = reduce(run([detectBothProvider, { type: 'choose', option: 1 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'saved' }, { type: 'verify-answer', yes: true }]), { type: 'verify-result', ok: false, rejected: 'decider.apiKey' });
    expect(reduce(anth, { type: 'enter', length: 0, prefixOk: true }).hint).toBe(HINT_TOO_SHORT);
  });

  it('cancel while step === save exits 2 (no run) or closes (run live) and drops the pending save request', () => {
    const save = run([detectBothProvider, { type: 'choose', option: 1 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }]);
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
    const exit = reduce(run([detectBothProvider, { type: 'choose', option: 1 }, { type: 'length', length: 9 }]), { type: 'cancel' });
    expect(exit.step).toBe('exit');
    const again = reduce(exit, { type: 'reopen', at: 'provider', runLive: false });
    expect(again.step).toBe('provider');
    expect(again.exitCode).toBeNull();
    expect(again.length).toBe(0);
    expect(again.entered).toEqual([]);
    expect(again.save).toBeNull();
    expect(again.reason).toBe('login');
    // at the Jev key: the session's resolved Jev provider rides along (§2.3); without one the wizard asks where Jev is reached first
    const atField = reduce(exit, { type: 'reopen', at: 'decider.apiKey', runLive: true, jevProvider: 'typesafe' });
    expect(atField.step).toBe('jevKey');
    expect(atField.jevProvider).toBe('typesafe');
    expect(atField.jevProviderShown).toBe(false);
    expect(atField.exitCode).toBeNull();
    expect(atField.runLive).toBe(true);
    const asking = reduce(exit, { type: 'reopen', at: 'decider.apiKey', runLive: true });
    expect(asking.step).toBe('jevProvider');
    expect(asking.jevProviderShown).toBe(true);
    expect(reduce(asking, { type: 'choose', option: 1 }).step).toBe('jevKey');
    // a provider chosen on the startup wizard is kept when the reopen passes none; an explicit null clears it (the session re-resolved to nothing)
    const startupChoice = run([detectJevOnly, { type: 'choose', option: 1 }]);
    expect(reduce(startupChoice, { type: 'reopen', at: 'decider.apiKey', runLive: false }).step).toBe('jevKey');
    expect(reduce(startupChoice, { type: 'reopen', at: 'decider.apiKey', runLive: false, jevProvider: null }).step).toBe('jevProvider');
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

describe('onboardingReducer: /mode jev-on reopens the generator step in place (TUI-DESIGN-2 §1.4, §8.1 S2)', () => {
  const startup = reduce(INITIAL_ONBOARDING, { ...detectJevOnly, jevProvider: 'typesafe' });

  it('reopen with reason `mode` → the provider step, providerShown, the target mode; `at` is ignored (never the stale field of the startup detect)', () => {
    for (const at of ['provider', 'decider.apiKey', 'generator.apiKey'] as const) {
      const s = reduce(startup, { type: 'reopen', at, runLive: false, reason: 'mode', mode: 'jev-on' });
      expect(s.step, at).toBe('provider');
      expect(s.providerShown).toBe(true);
      expect(s.reason).toBe('mode');
      expect(s.mode).toBe('jev-on');
      expect(s.field).toBeNull();
      expect(s.entered).toEqual([]);
      expect(s.runLive).toBe(false);
    }
    // the default reason is `login` and the mode is kept
    const login = reduce(startup, { type: 'reopen', at: 'decider.apiKey', runLive: false });
    expect(login.reason).toBe('login');
    expect(login.mode).toBe('jev-only');
    expect(login.step).toBe('jevKey');
    expect(reduce(startup, { type: 'reopen', at: 'provider', runLive: true, reason: 'rejected' }).reason).toBe('rejected');
  });

  it('llm-jev (docs/LLM-JEV-DESIGN.md): `/mode llm-jev` reopens like jev-on — provider → generatorKey → save with the generator key only', () => {
    const opened = reduce(startup, { type: 'reopen', at: 'provider', runLive: false, reason: 'mode', mode: 'llm-jev' });
    expect(opened).toMatchObject({ step: 'provider', reason: 'mode', mode: 'llm-jev', missing: ['generator.apiKey'] });
    const s = run([{ type: 'reopen', at: 'provider', runLive: false, reason: 'mode', mode: 'llm-jev' }, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }], startup);
    expect(s.step).toBe('save');
    expect(s.save).toEqual(req({ provider: 'openrouter', jevProvider: null, fields: ['generator.apiKey'], reuseGeneratorForJev: false }));
  });

  it('the generator flow under reason `mode` saves the provider and key; the Jev key (already resolving) is not asked again', () => {
    const s = run([{ type: 'reopen', at: 'provider', runLive: false, reason: 'mode', mode: 'jev-on' }, { type: 'choose', option: 1 }, { type: 'enter', length: 40, prefixOk: true }], startup);
    // the startup detect listed the Jev key as missing; under reason `mode` only the generator key is (the session runs on its Jev key): no Jev step
    expect(reduce(startup, { type: 'reopen', at: 'provider', runLive: false, reason: 'mode', mode: 'jev-on' }).missing).toEqual(['generator.apiKey']);
    expect(s.step).toBe('save');
    expect(s.save).toEqual(req({ provider: 'anthropic', jevProvider: null, fields: ['generator.apiKey'], reuseGeneratorForJev: false }));
    // a plain /login reopen keeps the detect's list
    expect(reduce(startup, { type: 'reopen', at: 'provider', runLive: false }).missing).toEqual(['decider.apiKey']);
    const clean = run([{ type: 'detect', missing: [], mode: 'jev-only', provider: null, trustNeeded: false }, { type: 'reopen', at: 'provider', runLive: false, reason: 'mode', mode: 'jev-on' }, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }]);
    expect(clean.step).toBe('save');
    expect(clean.save).toEqual(req({ provider: 'openrouter', jevProvider: null, fields: ['generator.apiKey'], reuseGeneratorForJev: false }));
    const saved = reduce(clean, { type: 'saved' });
    expect(saved.step).toBe('verify');
    // §1.4: `provider → generatorKey → save → verify? → done` — trust and the [sandbox] line were settled at startup (finding 7)
    expect(reduce(saved, { type: 'verify-answer', yes: false }).step).toBe('done');
  });

  it('a reopened wizard (reason mode, login or rejected) ends at `done` after the keys — never the trust or sandbox steps again (finding 7)', () => {
    for (const reason of ['mode', 'login', 'rejected'] as const) {
      // `/login` and a 401 pane's `[l]` reopen at the Jev key (the startup detect inferred typesafe); `/mode` at the provider step
      const at = reason === 'mode' ? 'provider' : 'decider.apiKey';
      const base = reduce({ ...startup, trustNeeded: true, trustDecision: null }, { type: 'reopen', at, runLive: false, reason, mode: reason === 'mode' ? 'jev-on' : 'jev-only' });
      expect(base.step, reason).toBe(reason === 'mode' ? 'provider' : 'jevKey');
      const save = run(reason === 'mode' ? [{ type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }] : [{ type: 'enter', length: 40, prefixOk: true }], base);
      expect(save.step, reason).toBe('save');
      const verify = reduce(save, { type: 'saved' });
      expect(verify.step).toBe('verify');
      expect(reduce(verify, { type: 'verify-answer', yes: false }).step, `${reason} n`).toBe('done');
      const ok = reduce(reduce(verify, { type: 'verify-answer', yes: true }), { type: 'verify-result', ok: true, rejected: null });
      expect(ok.step, `${reason} y`).toBe('done');
      const failed = reduce(reduce(verify, { type: 'verify-answer', yes: true }), { type: 'verify-result', ok: false, rejected: null });
      expect(failed.step, `${reason} failed`).toBe('done');
      // keep after a rejection → done as well
      const rejected = reduce(reduce(verify, { type: 'verify-answer', yes: true }), { type: 'verify-result', ok: false, rejected: reason === 'mode' ? 'generator.apiKey' : 'decider.apiKey' });
      expect(rejected.hint).toBe(HINT_REJECTED);
      expect(reduce(rejected, { type: 'keep' }).step, `${reason} keep`).toBe('done');
      // a save with nothing typed under a reopen closes too
      expect(reduce({ ...save, entered: [] }, { type: 'saved' }).step).toBe('done');
    }
    // the startup wizard keeps its trust and sandbox steps
    const startupSave = run([{ ...detectJevOnly, jevProvider: 'typesafe', trustNeeded: true }, { type: 'enter', length: 40, prefixOk: true }, { type: 'saved' }, { type: 'verify-answer', yes: false }]);
    expect(startupSave.step).toBe('trust');
    expect(reduce(startupSave, { type: 'trust', option: 1 }).step).toBe('sandbox');
  });

  it('Ctrl-C under reason `mode` or `login` closes (done) and never exits, idle or live; a startup `missing` wizard with no run still exits 2', () => {
    const mode = reduce(startup, { type: 'reopen', at: 'provider', runLive: false, reason: 'mode', mode: 'jev-on' });
    const closed = reduce(mode, { type: 'cancel' });
    expect(closed.step).toBe('done');
    expect(closed.exitCode).toBeNull();
    expect(wizardActive(closed)).toBe(false);
    const atKey = reduce(mode, { type: 'choose', option: 1 });
    expect(reduce(atKey, { type: 'cancel' }).step).toBe('done');
    const login = reduce(startup, { type: 'reopen', at: 'decider.apiKey', runLive: false });
    expect(reduce(login, { type: 'cancel' }).step).toBe('done');
    expect(reduce(login, { type: 'cancel' }).exitCode).toBeNull();
    const rejectedIdle = reduce(startup, { type: 'reopen', at: 'decider.apiKey', runLive: false, reason: 'rejected' });
    expect(reduce(rejectedIdle, { type: 'cancel' }).step).toBe('exit');
    const rejectedLive = reduce(startup, { type: 'reopen', at: 'decider.apiKey', runLive: true, reason: 'rejected' });
    expect(reduce(rejectedLive, { type: 'cancel' }).step).toBe('done');
    expect(reduce(startup, { type: 'cancel' }).step).toBe('exit');
    expect(reduce(startup, { type: 'cancel' }).exitCode).toBe(WIZARD_EXIT_CODE);
    expect(cancelCloses({ runLive: false, reason: 'mode' })).toBe(true);
    expect(cancelCloses({ runLive: false, reason: 'login' })).toBe(true);
    expect(cancelCloses({ runLive: false, reason: 'missing' })).toBe(false);
    expect(cancelCloses({ runLive: false, reason: 'rejected' })).toBe(false);
    expect(cancelCloses({ runLive: true, reason: 'missing' })).toBe(true);
  });

  it('Esc on the first step hints `Ctrl-C closes` when Ctrl-C closes, `Ctrl-C quits` when it exits', () => {
    const mode = reduce(startup, { type: 'reopen', at: 'provider', runLive: false, reason: 'mode', mode: 'jev-on' });
    expect(reduce(mode, { type: 'escape' }).hint).toBe(HINT_CTRL_C_CLOSES);
    const login = reduce(startup, { type: 'reopen', at: 'generator.apiKey', runLive: false });
    expect(reduce(login, { type: 'escape' }).hint).toBe(HINT_CTRL_C_CLOSES);
    expect(reduce(startup, { type: 'escape' }).hint).toBe(HINT_CTRL_C_QUITS);
    expect(reduce(reduce(INITIAL_ONBOARDING, detectBothProvider), { type: 'escape' }).hint).toBe(HINT_CTRL_C_QUITS);
  });
});

describe('onboardingReducer: Esc and Ctrl-C', () => {
  it('Esc clears a non-empty field, else steps back: jev → generator → provider; on the first step it only hints', () => {
    const jev = run([detectBothProvider, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }, { type: 'length', length: 3 }]);
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
    // generator field reached without a provider step (reopen at the field, reason login): Esc hints that Ctrl-C closes
    const reopened = reduce(INITIAL_ONBOARDING, { type: 'reopen', at: 'generator.apiKey', runLive: false });
    expect(reduce(reopened, { type: 'escape' }).hint).toBe(HINT_CTRL_C_CLOSES);
    const jevOnly = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: ['decider.apiKey'], mode: 'jev-on', provider: null, trustNeeded: false });
    expect(jevOnly.step).toBe('jevProvider');
    expect(reduce(jevOnly, { type: 'escape' }).hint).toBe(HINT_CTRL_C_QUITS);
    expect(reduce(reduce(INITIAL_ONBOARDING, { type: 'detect', missing: [], mode: 'jev-on', provider: null, trustNeeded: true }), { type: 'escape' }).step).toBe('trust');
  });

  it('Ctrl-C exits 2 only for a startup wizard with no run; during /login mid-run it closes the wizard (E5); it is inert once done', () => {
    const s = run([detectBothProvider, { type: 'choose', option: 1 }, { type: 'length', length: 12 }]);
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

  it('/login re-enters at the provider step or at a field with runLive carried; Ctrl-C closes either way (a command opened it)', () => {
    const p = reduce(INITIAL_ONBOARDING, { type: 'reopen', at: 'provider', runLive: true });
    expect(p.step).toBe('provider');
    expect(p.runLive).toBe(true);
    const f = reduce(INITIAL_ONBOARDING, { type: 'reopen', at: 'decider.apiKey', runLive: true, jevProvider: 'openrouter' });
    expect(f.step).toBe('jevKey');
    expect(f.field).toBe('decider.apiKey');
    expect(reduce(f, { type: 'cancel' }).step).toBe('done');
    const idle = reduce(INITIAL_ONBOARDING, { type: 'reopen', at: 'decider.apiKey', runLive: false });
    expect(idle.step).toBe('jevProvider'); // no Jev provider known: asked before the key (§1.4)
    expect(reduce(idle, { type: 'cancel' }).step).toBe('done');
  });
});

describe('onboardingReducer: invariants', () => {
  it('the state never holds a key: only lengths and booleans arrive, and no string in any state contains the key', () => {
    const states: OnboardingState[] = [];
    let s = INITIAL_ONBOARDING;
    const script: OnboardingAction[] = [
      detectBothProvider,
      { type: 'choose', option: 1 },
      { type: 'length', length: KEY.length },
      { type: 'enter', length: KEY.length, prefixOk: looksLikeKey(KEY, 'anthropic') },
      { type: 'choose', option: 2 },
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
    expect([...keys].sort()).toEqual(['length', 'missing', 'mode', 'option', 'prefixOk', 'provider', 'trustNeeded', 'type', 'yes']);
  });

  it('unknown or out-of-step actions return the same state object', () => {
    const s = reduce(INITIAL_ONBOARDING, detectBothProvider);
    expect(reduce(s, { type: 'length', length: 3 })).toBe(s);
    expect(reduce(s, { type: 'enter', length: 30, prefixOk: true })).toBe(s);
    expect(reduce(s, { type: 'saved' })).toBe(s);
    expect(reduce(s, { type: 'trust', option: 1 })).toBe(s);
    expect(reduce(s, { type: 'verify-answer', yes: true })).toBe(s);
    expect(reduce(s, { type: 'keep' })).toBe(s);
    expect(reduce(s, { type: 'bogus' } as unknown as OnboardingAction)).toBe(s);
  });

  it('wizardRows: jevProvider 3, provider 3, key 3, verify 2, trust 4 (2 below rows 12), else 0 — never more than 4; wizardActive covers save', () => {
    expect(wizardRows(reduce(INITIAL_ONBOARDING, detectJevOnly), 24)).toBe(3);
    const base = reduce(INITIAL_ONBOARDING, detectBothProvider);
    expect(wizardRows(base, 24)).toBe(3);
    const key = reduce(base, { type: 'choose', option: 1 });
    expect(wizardRows(key, 24)).toBe(3);
    const save = run([{ type: 'enter', length: 40, prefixOk: true }, { type: 'choose', option: 2 }, { type: 'enter', length: 40, prefixOk: true }], key);
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
  it('prefix hints per provider; null provider accepts anything; typesafe accepts anything (its key shape is unknown, TUI-DESIGN-2 §2.3)', () => {
    expect(looksLikeKey(KEY, 'anthropic')).toBe(true);
    expect(looksLikeKey(KEY, 'openrouter')).toBe(false);
    expect(looksLikeKey(OR_KEY, 'openrouter')).toBe(true);
    expect(looksLikeKey('whatever', null)).toBe(true);
    expect(looksLikeKey('whatever', 'typesafe')).toBe(true);
    expect(looksLikeKey('', 'typesafe')).toBe(true);
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
    expect(sanitizeKeyInput('é')).toBe('é');
    expect(sanitizeKeyInput('')).toBe('');
    expect(sanitizeKeyInput('日本　語')).toBe('日本語');
  });
});

describe('TUI-DESIGN-3 §1.4: the one-paste `key` step (D-J)', () => {
  const OR = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123';
  /** a TypeSafe-only user under a generator mode: Jev resolves, the generator is missing (edge 15) */
  const detectTypesafe: OnboardingAction = { type: 'detect', missing: ['generator.apiKey'], mode: 'jev-on', provider: 'openrouter', jevProvider: 'typesafe', trustNeeded: false, found: 'typesafe', foundSource: 'env' };
  /** `JEV_API_KEY` only, an OpenRouter key (edge 17) */
  const detectJevFound: OnboardingAction = { type: 'detect', missing: ['generator.apiKey'], mode: 'jev-on', provider: 'openrouter', jevProvider: 'openrouter', trustNeeded: false, found: 'jev', foundSource: 'env', foundReusable: true };
  /** `ANTHROPIC_API_KEY` only: both missing under the default provider, the field is the Jev key (edge 16) */
  const detectAnthropicFound: OnboardingAction = { ...detectBoth, found: 'anthropic', foundSource: 'env' };

  it('both keys missing, nothing inferred, provider null or openrouter → `key` (keyAs both, oneKey); Enter with ≥ 8 chars saves the one field; `saved` → verify', () => {
    const s = reduce(INITIAL_ONBOARDING, detectBoth);
    expect(s.step).toBe('key');
    expect(s.field).toBe('key');
    expect(isFieldStep(s.step)).toBe(true);
    expect(expectedKeyProvider(s)).toBe('openrouter');
    expect(wizardRows(s, 24)).toBe(3);
    const saved = reduce(s, { type: 'enter', length: OR.length, prefixOk: true });
    expect(saved.step).toBe('save');
    expect(saved.save).toEqual(req({ provider: null, jevProvider: null, fields: ['key'], reuseGeneratorForJev: false, oneKey: true, keyAs: 'both' }));
    expect(reduce(saved, { type: 'saved' }).step).toBe('verify');
    expect(keyAsOf(null)).toBe('both');
    expect(keyAsOf('typesafe')).toBe('generator');
    expect(keyAsOf('jev')).toBe('generator');
    expect(keyAsOf('anthropic')).toBe('jev');
    // a jev-only mode never opens it (the round-2 flow stands)
    expect(reduce(INITIAL_ONBOARDING, { ...detectBoth, mode: 'jev-only' }).step).toBe('jevProvider');
    // an inferred Jev provider or a non-openrouter generator provider takes the round-2 branches
    expect(reduce(INITIAL_ONBOARDING, { ...detectBoth, jevProvider: 'typesafe' }).step).toBe('provider');
    expect(reduce(INITIAL_ONBOARDING, detectBothProvider).step).toBe('provider');
  });

  it('edge 10 / 32 / 39: empty Enter and < 8 chars hint too short; a non-OpenRouter shape warns once with HINT_PREFIX_KEY (`Esc, then 2`), Enter again keeps it', () => {
    const s = reduce(INITIAL_ONBOARDING, detectBoth);
    expect(reduce(s, { type: 'enter', length: 0, prefixOk: true }).hint).toBe(HINT_TOO_SHORT);
    expect(reduce(s, { type: 'enter', length: 7, prefixOk: true }).hint).toBe(HINT_TOO_SHORT);
    const warned = reduce(s, { type: 'enter', length: 30, prefixOk: false });
    expect(warned.step).toBe('key');
    expect(warned.hint).toBe(HINT_PREFIX_KEY);
    expect(HINT_PREFIX_KEY).toBe('not an OpenRouter key? Enter again keeps it · TypeSafe key: Esc, then 2');
    expect(warned.prefixWarned).toBe(true);
    const kept = reduce(warned, { type: 'enter', length: 30, prefixOk: false });
    expect(kept.step).toBe('save');
    expect(kept.save?.keyAs).toBe('both');
  });

  it('edge 2: `pasted-twice` sets HINT_PASTED_TWICE; looksPastedTwice sees `sk-or-` twice; Ctrl-U clears the hint', () => {
    const s = reduce(INITIAL_ONBOARDING, detectBoth);
    const twice = reduce({ ...s, length: 80 }, { type: 'pasted-twice' });
    expect(twice.hint).toBe(HINT_PASTED_TWICE);
    expect(reduce(twice, { type: 'clear' }).hint).toBeNull();
    expect(looksPastedTwice(`${OR}${OR}`)).toBe(true);
    expect(looksPastedTwice(OR)).toBe(false);
    expect(looksPastedTwice('')).toBe(false);
    // out of a field it is inert
    const provider = reduce(INITIAL_ONBOARDING, detectBothProvider);
    expect(reduce(provider, { type: 'pasted-twice' })).toBe(provider);
  });

  it('edge 9: Esc with text clears the buffer (hint null → the empty-field hint); Esc on the empty field → `options`; Esc again → `key` with `Ctrl-C quits`', () => {
    const s = reduce(INITIAL_ONBOARDING, detectBoth);
    const typed = reduce(s, { type: 'length', length: 12 });
    const cleared = reduce(typed, { type: 'escape' });
    expect(cleared.step).toBe('key');
    expect(cleared.length).toBe(0);
    expect(cleared.hint).toBeNull();
    const options = reduce(cleared, { type: 'escape' });
    expect(options.step).toBe('options');
    expect(options.optionsShown).toBe(true);
    expect(options.highlight).toBeNull();
    expect(options.field).toBeNull();
    expect(wizardRows(options, 24)).toBe(3);
    expect(wizardActive(options)).toBe(true);
    const back = reduce(options, { type: 'escape' });
    expect(back.step).toBe('key');
    expect(back.hint).toBe(HINT_CTRL_C_QUITS);
    // under /login the hint says Ctrl-C closes
    const login = reduce(INITIAL_ONBOARDING, { ...detectBoth, reason: 'login' });
    expect(reduce(reduce(login, { type: 'escape' }), { type: 'escape' }).hint).toBe(HINT_CTRL_C_CLOSES);
  });

  it('edge 37: on `options` a digit highlights (hint null), the same digit or Enter confirms, another digit re-highlights, Enter with no highlight → `pick 1–4`, Esc → `key`', () => {
    const options = reduce(reduce(INITIAL_ONBOARDING, detectBoth), { type: 'escape' });
    expect(reduce(options, { type: 'choose', option: 'enter' }).hint).toBe(HINT_PICK_OPTION);
    expect(HINT_PICK_OPTION).toBe('pick 1–4');
    const two = reduce(options, { type: 'choose', option: 2 });
    expect(two.step).toBe('options');
    expect(two.highlight).toBe(2);
    expect(two.hint).toBeNull();
    const three = reduce(two, { type: 'choose', option: 3 });
    expect(three.highlight).toBe(3);
    expect(three.step).toBe('options');
    // the same digit confirms
    expect(reduce(two, { type: 'choose', option: 2 }).step).toBe('jevKey');
    // Enter confirms the highlight
    expect(reduce(two, { type: 'choose', option: 'enter' }).step).toBe('jevKey');
    expect(WIZARD_OPTIONS_ORDER).toEqual(['openrouter', 'typesafe', 'jev-only', 'anthropic']);
    // digits are inert on the key field itself (they are key bytes there)
    const key = reduce(INITIAL_ONBOARDING, detectBoth);
    expect(reduce(key, { type: 'choose', option: 1 })).toBe(key);
  });

  it('option 1 returns to `key`; option 2 → jevKey(typesafe, jevProviderShown) then the skippable generator field — a key saves both, an empty Enter pends jev-only (edge 15 route)', () => {
    const options = reduce(reduce(INITIAL_ONBOARDING, detectBoth), { type: 'escape' });
    const one = reduce(reduce(options, { type: 'choose', option: 1 }), { type: 'choose', option: 1 });
    expect(one.step).toBe('key');
    expect(one.optionsChoice).toBeNull();
    const two = reduce(reduce(options, { type: 'choose', option: 2 }), { type: 'choose', option: 'enter' });
    expect(two.step).toBe('jevKey');
    expect(two.jevProvider).toBe('typesafe');
    expect(two.jevProviderShown).toBe(true);
    expect(two.optionsChoice).toBe(2);
    expect(expectedKeyProvider(two)).toBe('typesafe');
    const gen = reduce(two, { type: 'enter', length: 40, prefixOk: true });
    expect(gen.step).toBe('generatorKey');
    expect(gen.entered).toEqual(['decider.apiKey']);
    expect(skipOffered(gen)).toBe(true);
    // Esc from the generator field goes back to the Jev key (its entry is dropped); Esc from the Jev key back to options with `2` highlighted
    const backToJev = reduce(gen, { type: 'escape' });
    expect(backToJev.step).toBe('jevKey');
    expect(backToJev.entered).toEqual([]);
    const backToOptions = reduce(two, { type: 'escape' });
    expect(backToOptions.step).toBe('options');
    expect(backToOptions.highlight).toBe(2);
    expect(backToOptions.jevProvider).toBeNull();
    // a typed OpenRouter key saves both with jevProvider typesafe
    const both = reduce(gen, { type: 'enter', length: OR.length, prefixOk: true });
    expect(both.step).toBe('save');
    expect(both.save).toEqual(req({ provider: null, jevProvider: 'typesafe', fields: ['decider.apiKey', 'generator.apiKey'], reuseGeneratorForJev: false }));
    // an empty Enter skips: the save carries the Jev key and pendMode jev-only
    const skipped = reduce(gen, { type: 'enter', length: 0, prefixOk: true });
    expect(skipped.step).toBe('save');
    expect(skipped.pendMode).toBe('jev-only');
    expect(skipped.save).toEqual(req({ provider: null, jevProvider: 'typesafe', fields: ['decider.apiKey'], reuseGeneratorForJev: false, pendMode: 'jev-only' }));
    expect(targetMode(skipped)).toBe('jev-only');
  });

  it('option 3 (Jev only): pendMode jev-only (targetMode), then the jevProvider question when nothing inferred and the Jev key; a resolving Jev key (TypeSafe found) goes straight on (afterKeys); the wizard mode itself is untouched', () => {
    const options = reduce(reduce(INITIAL_ONBOARDING, detectBoth), { type: 'escape' });
    const three = reduce(reduce(options, { type: 'choose', option: 3 }), { type: 'choose', option: 3 });
    expect(three.pendMode).toBe('jev-only');
    expect(three.mode).toBe('jev-on');
    expect(targetMode(three)).toBe('jev-only');
    expect(three.step).toBe('jevProvider');
    const key = reduce(three, { type: 'choose', option: 2 });
    expect(key.step).toBe('jevKey');
    const saved = reduce(key, { type: 'enter', length: OR.length, prefixOk: true });
    expect(saved.save).toEqual(req({ provider: null, jevProvider: 'openrouter', fields: ['decider.apiKey'], reuseGeneratorForJev: false, pendMode: 'jev-only' }));
    // Esc from the jevProvider question returns to options with `3` highlighted and the pending mode dropped
    const back = reduce(three, { type: 'escape' });
    expect(back.step).toBe('options');
    expect(back.highlight).toBe(3);
    expect(back.pendMode).toBeNull();
    // edge 15: TypeSafe found, generator missing → `key` (found-title); Esc → options; `3` `3` → nothing to ask, on to sandbox (no trust needed)
    const ts = reduce(INITIAL_ONBOARDING, detectTypesafe);
    expect(ts.step).toBe('key');
    expect(ts.found).toBe('typesafe');
    const tsOptions = reduce(ts, { type: 'escape' });
    expect(tsOptions.step).toBe('options');
    const tsThree = reduce(reduce(tsOptions, { type: 'choose', option: 3 }), { type: 'choose', option: 3 });
    expect(tsThree.step).toBe('sandbox');
    expect(tsThree.pendMode).toBe('jev-only');
    expect(reduce(tsThree, { type: 'sandbox-shown' }).step).toBe('done');
    // with untrusted inputs the trust card comes first
    const trusty = reduce(reduce(reduce(reduce(INITIAL_ONBOARDING, { ...detectTypesafe, trustNeeded: true }), { type: 'escape' }), { type: 'choose', option: 3 }), { type: 'choose', option: 3 });
    expect(trusty.step).toBe('trust');
  });

  it('option 4 (Anthropic): the generator field under provider anthropic, then the Jev provider question and key; with the Anthropic key resolving (found anthropic) a provider-only save, then the Jev key', () => {
    const options = reduce(reduce(INITIAL_ONBOARDING, detectBoth), { type: 'escape' });
    const four = reduce(reduce(options, { type: 'choose', option: 4 }), { type: 'choose', option: 'enter' });
    expect(four.step).toBe('generatorKey');
    expect(four.provider).toBe('anthropic');
    expect(four.providerShown).toBe(true);
    expect(expectedKeyProvider(four)).toBe('anthropic');
    const jev = reduce(four, { type: 'enter', length: KEY.length, prefixOk: true });
    expect(jev.step).toBe('jevProvider');
    // Esc from the generator field returns to options with `4` highlighted
    const back = reduce(four, { type: 'escape' });
    expect(back.step).toBe('options');
    expect(back.highlight).toBe(4);
    expect(back.provider).toBeNull();
    // edge 16: ANTHROPIC_API_KEY only → the `key` field IS the Jev key (keyAs jev, provider anthropic on the save); Esc → options with `4` highlighted
    const anth = reduce(INITIAL_ONBOARDING, detectAnthropicFound);
    expect(anth.step).toBe('key');
    expect(anth.found).toBe('anthropic');
    expect(anth.provider).toBe('anthropic');
    expect(expectedKeyProvider(anth)).toBe('openrouter');
    const anthSaved = reduce(anth, { type: 'enter', length: OR.length, prefixOk: true });
    expect(anthSaved.save).toEqual(req({ provider: null, jevProvider: null, fields: ['key'], reuseGeneratorForJev: false, keyAs: 'jev', oneKey: false }));
    const anthOptions = reduce(anth, { type: 'escape' });
    expect(anthOptions.highlight).toBe(4);
    const providerOnly = reduce(anthOptions, { type: 'choose', option: 'enter' });
    expect(providerOnly.step).toBe('save');
    expect(providerOnly.save).toEqual(req({ provider: 'anthropic', jevProvider: null, fields: [], reuseGeneratorForJev: false, keyAs: 'jev' }));
    const afterSave = reduce(providerOnly, { type: 'saved' });
    expect(afterSave.step).toBe('jevProvider');
    const jevKey = reduce(afterSave, { type: 'choose', option: 2 });
    expect(jevKey.step).toBe('jevKey');
    expect(reduce(jevKey, { type: 'enter', length: OR.length, prefixOk: true }).save).toEqual(req({ provider: 'anthropic', jevProvider: 'openrouter', fields: ['decider.apiKey'], reuseGeneratorForJev: false, keyAs: 'jev' }));
  });

  it('edges 11 / 17 / 34: Jev found (TypeSafe or JEV_API_KEY) → `key` saves the generator key ONLY (keyAs generator, oneKey false); an empty Enter reuses a found OpenRouter Jev key (reuseJevForGenerator), never under TypeSafe', () => {
    const ts = reduce(INITIAL_ONBOARDING, detectTypesafe);
    expect(ts.step).toBe('key');
    const tsSaved = reduce(ts, { type: 'enter', length: OR.length, prefixOk: true });
    expect(tsSaved.save).toEqual(req({ provider: null, jevProvider: null, fields: ['key'], reuseGeneratorForJev: false, keyAs: 'generator', oneKey: false }));
    expect(reuseJevOffered(ts)).toBe(false);
    expect(reduce(ts, { type: 'enter', length: 0, prefixOk: true }).hint).toBe(HINT_TOO_SHORT);
    const jev = reduce(INITIAL_ONBOARDING, detectJevFound);
    expect(jev.step).toBe('key');
    expect(reuseJevOffered(jev)).toBe(true);
    const reused = reduce(jev, { type: 'enter', length: 0, prefixOk: true });
    expect(reused.step).toBe('save');
    expect(reused.save).toEqual(req({ provider: null, jevProvider: null, fields: [], reuseGeneratorForJev: false, reuseJevForGenerator: true, keyAs: 'generator' }));
    // a typed key beats the reuse; the found value not being an OpenRouter key offers nothing
    expect(reduce(jev, { type: 'enter', length: OR.length, prefixOk: true }).save?.keyAs).toBe('generator');
    expect(reuseJevOffered(reduce(INITIAL_ONBOARDING, { ...detectJevFound, foundReusable: false }))).toBe(false);
    // the found-title path never applies to /login (reason) — only a startup wizard reads `found`
    expect(reduce(INITIAL_ONBOARDING, { ...detectTypesafe, reason: 'login' }).step).toBe('provider');
  });

  it('edge 38: Enter and Esc at `verify` both act as `n` (verify skipped → sandbox / trust / done); a verifying state ignores Esc', () => {
    const saved = run([detectBoth, { type: 'enter', length: 40, prefixOk: true }, { type: 'saved' }]);
    expect(saved.step).toBe('verify');
    const esc = reduce(saved, { type: 'escape' });
    expect(esc.step).toBe('sandbox');
    expect(esc.verify).toBe('skipped');
    expect(reduce(saved, { type: 'verify-answer', yes: false }).step).toBe('sandbox');
    const verifying = reduce(saved, { type: 'verify-answer', yes: true });
    expect(reduce(verifying, { type: 'escape' })).toBe(verifying);
    // a rejected key on the one-paste path returns to `key` whichever side rejected it
    const rejected = reduce(verifying, { type: 'verify-result', ok: false, rejected: 'decider.apiKey' });
    expect(rejected.step).toBe('key');
    expect(rejected.hint).toBe(HINT_REJECTED);
    expect(rejected.entered).toEqual([]);
    expect(reduce(rejected, { type: 'keep' }).step).toBe('sandbox');
    // a /login one-paste wizard ends at done after the verify
    const login = run([{ ...detectBoth, reason: 'login' }, { type: 'enter', length: 40, prefixOk: true }, { type: 'saved' }, { type: 'escape' }]);
    expect(login.step).toBe('done');
  });

  it('TUI-DESIGN-3 §4.4 F17: the `/trust` card (reason trust) closes on Esc and Ctrl-C (done, never exit); the startup trust card keeps Esc inert and Ctrl-C exiting 2', () => {
    const card = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: [], mode: 'jev-on', provider: null, trustNeeded: true, reason: 'trust' });
    expect(card.step).toBe('trust');
    expect(reduce(card, { type: 'escape' }).step).toBe('done');
    expect(reduce(card, { type: 'cancel' }).step).toBe('done');
    expect(cancelCloses({ runLive: false, reason: 'trust' })).toBe(true);
    const startup = reduce(INITIAL_ONBOARDING, { type: 'detect', missing: [], mode: 'jev-on', provider: null, trustNeeded: true });
    expect(reduce(startup, { type: 'escape' })).toBe(startup);
    expect(reduce(startup, { type: 'cancel' }).step).toBe('exit');
    // Enter stays inert on both
    expect(reduce(card, { type: 'choose', option: 'enter' })).toBe(card);
    // a decision on the card closes it without a second [sandbox] line; the startup card goes on to the sandbox step
    expect(reduce(card, { type: 'trust', option: 2 }).step).toBe('done');
    expect(reduce(startup, { type: 'trust', option: 2 }).step).toBe('sandbox');
  });

  it('reopen at `key` (both sides openrouter after a 401, or /login with nothing else resolving) opens the one-paste field under the reopen\'s reason; `found` / `currentMode` travel', () => {
    const s = reduce(INITIAL_ONBOARDING, { type: 'reopen', at: 'key', runLive: false, reason: 'rejected', currentMode: 'jev-on' });
    expect(s.step).toBe('key');
    expect(s.reason).toBe('rejected');
    expect(s.currentMode).toBe('jev-on');
    expect(s.found).toBeNull();
    const saved = reduce(s, { type: 'enter', length: 40, prefixOk: true });
    expect(saved.save?.keyAs).toBe('both');
    expect(saved.save?.oneKey).toBe(true);
    const withFound = reduce(INITIAL_ONBOARDING, { type: 'reopen', at: 'key', runLive: false, found: 'typesafe', foundSource: 'file' });
    expect(withFound.found).toBe('typesafe');
    expect(withFound.foundSource).toBe('file');
    expect(reduce(withFound, { type: 'enter', length: 40, prefixOk: true }).save?.keyAs).toBe('generator');
    // isFieldStep: the three masked steps and nothing else
    expect(['key', 'generatorKey', 'jevKey'].every((st) => isFieldStep(st as OnboardingState['step']))).toBe(true);
    expect(['detect', 'options', 'jevProvider', 'provider', 'save', 'verify', 'trust', 'sandbox', 'done', 'exit'].some((st) => isFieldStep(st as OnboardingState['step']))).toBe(false);
  });
});

/**
 * TUI-DESIGN-5 §10 names THIS file for the `'import'` step. Round 5's assertions live in the sibling
 * `import-step.test.tsx` (a declared deviation: the step's `useWizard` half needs Ink, and rounds 3/4's pins here
 * are not to be disturbed). These three anchors keep the two files from diverging silently — a rename or a
 * removal on the import half fails HERE, in the file §10 names.
 */
describe('TUI-DESIGN-5 §5.1 — the `import` step (the anchor half; the assertions are in import-step.test.tsx)', () => {
  it('`WizardStep` carries `import` between `sandbox` and `done`, and the step takes 3 rows', () => {
    const s: OnboardingState = { ...INITIAL_ONBOARDING, step: 'import', importProbe: { tools: [{ display: 'claude-code', items: 43 }], total: 43 } };
    expect(s.step).toBe('import');
    expect(wizardRows(s, 24)).toBe(3);
    expect(IMPORT_PROBE_DEADLINE_MS).toBe(50);
  });

  it('`sandbox-shown` routes through `importStepWanted`, and nothing else decides it', () => {
    const at = (over: Partial<OnboardingState>): OnboardingState => ({ ...INITIAL_ONBOARDING, step: 'sandbox', ...over });
    const found = { tools: [{ display: 'codex', items: 3 }], total: 3 };
    expect(reduce(at({ importProbe: found }), { type: 'sandbox-shown' }).step).toBe('import');
    expect(reduce(at({}), { type: 'sandbox-shown' }).step).toBe('done');
    expect(importStepWanted({ importProbe: found, importSeen: false })).toBe(true);
    expect(importStepWanted({ importProbe: found, importSeen: true })).toBe(false);
  });

  it('the import step never exits 2: Esc and Ctrl-C are both `2 later`', () => {
    const open = reduce({ ...INITIAL_ONBOARDING, step: 'sandbox', importProbe: { tools: [{ display: 'codex', items: 3 }], total: 3 } }, { type: 'sandbox-shown' });
    for (const action of [{ type: 'escape' } as const, { type: 'cancel' } as const]) {
      const s = reduce(open, action);
      expect(s.step, action.type).toBe('done');
      expect(s.importChoice, action.type).toBe(2);
      expect(s.exitCode, action.type).toBeNull();
    }
  });
});
