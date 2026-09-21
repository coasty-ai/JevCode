/**
 * First-run wizard state machine (TUI-DESIGN §11.1, D5, F10). Pure: the reducer never sees a
 * key byte — the field buffer lives in the component's `useRef<string>` and only its masked
 * length (plus booleans the component derives) reaches the reducer, so a state dump, a test
 * snapshot or a devtools tree can never contain a credential.
 *
 *   detect → provider → generatorKey → jevKey (Enter = reuse) → save → verify? → trust → sandbox → done
 *
 * Ctrl-C exits 2 only when no run exists; during `/login` mid-run it closes the wizard (E5).
 */
import type { EngineMode, SecretSettingName } from '../../core/types.js';
import { MIN_SECRET_LENGTH } from '../../core/redact.js';

/** TUI-DESIGN §11.1: the two generator providers the wizard offers. */
export type WizardProvider = 'anthropic' | 'openrouter';
/** TUI-DESIGN §11.1: the two masked fields. */
export type WizardField = SecretSettingName;
/** TUI-DESIGN §11.1: the wizard steps in order (`exit` = Ctrl-C with no run). */
export type WizardStep = 'detect' | 'provider' | 'generatorKey' | 'jevKey' | 'save' | 'verify' | 'trust' | 'sandbox' | 'done' | 'exit';
/** TUI-DESIGN §11.3: `1 trust · 2 this session only · 3 don't trust`. */
export type TrustOption = 1 | 2 | 3;

/** What the host persists when `step === 'save'` (the bytes come from the component's refs, keyed by field). */
export interface SaveRequest {
  /** the provider chosen on the provider step; null when that step was never shown (the host then leaves `provider` in the file untouched) */
  provider: WizardProvider | null;
  /** fields typed in this wizard, in order */
  fields: readonly WizardField[];
  /** jev key left empty under openrouter: the generator key serves Jev too (§11.1) */
  reuseGeneratorForJev: boolean;
}

/** TUI-DESIGN §11.1: the reducer state — `{ step, field, length }` and booleans; never a key byte. */
export interface OnboardingState {
  step: WizardStep;
  /** the active masked field, or null outside the two key steps */
  field: WizardField | null;
  /** masked length of the active field's buffer — the only thing the reducer knows about it */
  length: number;
  provider: WizardProvider | null;
  /** the provider step was shown (Esc from the key field returns to it) */
  providerShown: boolean;
  missing: readonly SecretSettingName[];
  mode: EngineMode;
  /** fields typed so far in this wizard */
  entered: readonly WizardField[];
  save: SaveRequest | null;
  /** one-frame hint under the field (too short, prefix warning, rejected key) */
  hint: string | null;
  /** the prefix warning was shown for the active field; the next Enter keeps the key */
  prefixWarned: boolean;
  /** verification requested and in flight */
  verifying: boolean;
  verify: 'skipped' | 'ok' | 'failed' | null;
  /** untrusted inputs exist and no stored decision covers them */
  trustNeeded: boolean;
  trustDecision: TrustOption | null;
  /** `/login` while a run is live: Ctrl-C closes instead of exiting (judge-safety E5) */
  runLive: boolean;
  /** set with `step === 'exit'` */
  exitCode: number | null;
}

/** TUI-DESIGN §11.1: semantic actions the Ink wizard / readline twin dispatch; no member carries a key value. */
export type OnboardingAction =
  | {
      type: 'detect';
      missing: readonly SecretSettingName[];
      mode: EngineMode;
      /** preselected from --provider / JEVCODE_PROVIDER, or the resolved provider */
      provider: WizardProvider | null;
      trustNeeded: boolean;
      runLive?: boolean;
    }
  /** `1` / `2` on the provider step (Enter accepts the preselection) */
  | { type: 'choose'; option: 1 | 2 | 'enter' }
  /** the field buffer changed (typed, pasted, Backspace, Delete): its new masked length */
  | { type: 'length'; length: number }
  /** Ctrl-U */
  | { type: 'clear' }
  /** Enter in a field; `prefixOk` = the component's `looksLikeKey(buffer, provider)` verdict */
  | { type: 'enter'; length: number; prefixOk: boolean }
  /** Esc: clears a non-empty field, else steps back */
  | { type: 'escape' }
  /** Ctrl-C */
  | { type: 'cancel' }
  /** the host wrote the credentials file */
  | { type: 'saved' }
  /** the host could not write: back to the last field with the reason as the hint */
  | { type: 'save-failed'; reason: string }
  | { type: 'verify-answer'; yes: boolean }
  /** `rejected` names the field to return to; null = every key was accepted */
  | { type: 'verify-result'; ok: boolean; rejected: WizardField | null }
  /** `n` on a rejected key: keep it anyway */
  | { type: 'keep' }
  | { type: 'trust'; option: TrustOption }
  | { type: 'sandbox-shown' }
  /** `/login`: re-enter at the provider step or at the missing field */
  | { type: 'reopen'; at: 'provider' | WizardField; runLive: boolean };

/** TUI-DESIGN §11.1: `key too short (8+ characters)` — the redactor ignores shorter values, so the wizard must too (research 13 §5.3). */
export const HINT_TOO_SHORT = `key too short (${MIN_SECRET_LENGTH}+ characters)`;
/** TUI-DESIGN §11.1: the prefix hint warns only, never blocks (research 13 §5.3). */
export function hintPrefix(provider: WizardProvider | 'openrouter (Jev)'): string {
  return `this does not look like an ${provider} key — Enter again to keep it`;
}
/** TUI-DESIGN §11.1: a verification rejected the key (research 13 §5.6). */
export const HINT_REJECTED = 'rejected — Enter to try another key, n to keep it anyway';
/** TUI-DESIGN §11.1: Esc on the first step is a no-op with this hint (research 13 §5.2). */
export const HINT_CTRL_C_QUITS = 'Ctrl-C quits';
/** TUI-DESIGN §11.1 / D2: wizard Ctrl-C with no run → the fix block and exit 2. */
export const WIZARD_EXIT_CODE = 2;

/** TUI-DESIGN §11.1: the key prefixes each provider issues; a mismatch only warns. */
export const KEY_PREFIXES: Readonly<Record<WizardProvider, readonly string[]>> = {
  anthropic: ['sk-ant-'],
  openrouter: ['sk-or-v1-', 'sk-or-'],
};

/** TUI-DESIGN §11.1: does the buffer start like a key of `provider`? The component calls this on its ref and passes the boolean. Pure. */
export function looksLikeKey(buffer: string, provider: WizardProvider | null): boolean {
  if (provider === null) return true;
  return KEY_PREFIXES[provider].some((p) => buffer.startsWith(p));
}

/**
 * TUI-DESIGN §11.1: the field sanitiser — CSI and OSC sequences, SS2/SS3 (`ESC N x` / `ESC O x`,
 * arrow and keypad keys in application mode), `nF` sequences (`ESC ( B`) and every other 7-bit
 * `ESC <0x30–0x7E>` sequence (`ESC 7`, `ESC =`, `ESC c`), then controls and all whitespace
 * stripped, NFC. Pure; the component applies it to its ref.
 */
export function sanitizeKeyInput(s: string): string {
  return s
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\u001b[NO][@-~]/g, '')
    .replace(/\u001b[ -/]+[0-~]/g, '')
    .replace(/\u001b[0-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/gu, '')
    .normalize('NFC');
}

/** TUI-DESIGN §11.1: the state before `detect`. */
export const INITIAL_ONBOARDING: OnboardingState = {
  step: 'detect',
  field: null,
  length: 0,
  provider: null,
  providerShown: false,
  missing: [],
  mode: 'jev-on',
  entered: [],
  save: null,
  hint: null,
  prefixWarned: false,
  verifying: false,
  verify: null,
  trustNeeded: false,
  trustDecision: null,
  runLive: false,
  exitCode: null,
};

function needsGenerator(s: OnboardingState): boolean {
  return s.mode !== 'jev-only' && s.missing.includes('generator.apiKey');
}
function needsJev(s: OnboardingState): boolean {
  return s.missing.includes('decider.apiKey');
}

function field(s: OnboardingState, f: WizardField, hint: string | null = null): OnboardingState {
  return { ...s, step: f === 'generator.apiKey' ? 'generatorKey' : 'jevKey', field: f, length: 0, hint, prefixWarned: false };
}

function afterKeys(s: OnboardingState): OnboardingState {
  if (s.trustNeeded && s.trustDecision === null) return { ...s, step: 'trust', field: null, length: 0, hint: null };
  return { ...s, step: 'sandbox', field: null, length: 0, hint: null };
}

function toSave(s: OnboardingState, reuse: boolean): OnboardingState {
  // Only a provider the user actually chose is persisted; a guessed one would write a `provider` they never selected.
  const provider = s.providerShown ? s.provider : null;
  return { ...s, step: 'save', field: null, length: 0, hint: null, save: { provider, fields: s.entered, reuseGeneratorForJev: reuse } };
}

function nextAfterGenerator(s: OnboardingState): OnboardingState {
  return needsJev(s) ? field(s, 'decider.apiKey') : toSave(s, false);
}

function startFromDetect(s: OnboardingState): OnboardingState {
  if (s.missing.length === 0) return afterKeys(s);
  if (needsGenerator(s)) return { ...s, step: 'provider' };
  if (needsJev(s)) return field(s, 'decider.apiKey');
  return afterKeys(s);
}

/** TUI-DESIGN §11.1: the pure wizard reducer; unknown or out-of-step actions return the same state object. */
export function onboardingReducer(state: OnboardingState, action: OnboardingAction): OnboardingState {
  switch (action.type) {
    case 'detect': {
      const s: OnboardingState = {
        ...INITIAL_ONBOARDING,
        missing: action.missing,
        mode: action.mode,
        provider: action.provider,
        trustNeeded: action.trustNeeded,
        runLive: action.runLive ?? false,
      };
      const next = startFromDetect(s);
      return next.step === 'provider' ? { ...next, providerShown: true } : next;
    }
    case 'reopen': {
      const base: OnboardingState = { ...state, runLive: action.runLive, exitCode: null, hint: null, verifying: false, save: null, entered: [] };
      if (action.at === 'provider') return { ...base, step: 'provider', providerShown: true, field: null, length: 0 };
      return field({ ...base, providerShown: false }, action.at);
    }
    case 'choose': {
      if (state.step !== 'provider') return state;
      const provider: WizardProvider | null = action.option === 1 ? 'anthropic' : action.option === 2 ? 'openrouter' : state.provider;
      if (provider === null) return { ...state, hint: 'pick 1 or 2' };
      return field({ ...state, provider }, 'generator.apiKey');
    }
    case 'length': {
      if (state.field === null) return state;
      const length = Number.isFinite(action.length) && action.length >= 0 ? Math.floor(action.length) : 0;
      return { ...state, length, hint: null };
    }
    case 'clear': {
      if (state.field === null) return state;
      return { ...state, length: 0, hint: null, prefixWarned: false };
    }
    case 'enter': {
      if (state.field === null) return state;
      const length = Number.isFinite(action.length) && action.length >= 0 ? Math.floor(action.length) : 0;
      const s = { ...state, length };
      if (s.step === 'jevKey' && length === 0 && s.provider === 'openrouter' && s.entered.includes('generator.apiKey')) {
        return toSave(s, true);
      }
      if (length < MIN_SECRET_LENGTH) return { ...s, hint: HINT_TOO_SHORT };
      if (!action.prefixOk && !s.prefixWarned) {
        return { ...s, hint: hintPrefix(s.step === 'jevKey' ? 'openrouter (Jev)' : (s.provider ?? 'anthropic')), prefixWarned: true };
      }
      const entered = s.entered.includes(s.field!) ? s.entered : [...s.entered, s.field!];
      const done = { ...s, entered, hint: null, prefixWarned: false };
      return s.step === 'generatorKey' ? nextAfterGenerator(done) : toSave(done, false);
    }
    case 'escape': {
      if (state.field !== null && state.length > 0) return { ...state, length: 0, hint: null, prefixWarned: false };
      if (state.step === 'jevKey') {
        if (state.entered.includes('generator.apiKey')) return field({ ...state, entered: state.entered.filter((f) => f !== 'generator.apiKey') }, 'generator.apiKey');
        if (state.providerShown) return { ...state, step: 'provider', field: null, length: 0, hint: null };
        return { ...state, hint: HINT_CTRL_C_QUITS };
      }
      if (state.step === 'generatorKey') {
        if (state.providerShown) return { ...state, step: 'provider', field: null, length: 0, hint: null, prefixWarned: false };
        return { ...state, hint: HINT_CTRL_C_QUITS };
      }
      if (state.step === 'provider') return { ...state, hint: HINT_CTRL_C_QUITS };
      return state;
    }
    case 'cancel': {
      if (state.step === 'done' || state.step === 'exit') return state;
      if (state.runLive) return { ...state, step: 'done', field: null, length: 0, hint: null, verifying: false, save: null };
      return { ...state, step: 'exit', field: null, length: 0, hint: null, verifying: false, save: null, exitCode: WIZARD_EXIT_CODE };
    }
    case 'saved': {
      if (state.step !== 'save') return state;
      const s = { ...state, save: null };
      return s.entered.length > 0 ? { ...s, step: 'verify' } : afterKeys(s);
    }
    case 'save-failed': {
      if (state.step !== 'save') return state;
      const last = state.entered[state.entered.length - 1] ?? (needsGenerator(state) ? 'generator.apiKey' : 'decider.apiKey');
      return field({ ...state, save: null, entered: state.entered.filter((f) => f !== last) }, last, action.reason);
    }
    case 'verify-answer': {
      if (state.step !== 'verify' || state.verifying) return state;
      return action.yes ? { ...state, verifying: true } : afterKeys({ ...state, verify: 'skipped' });
    }
    case 'verify-result': {
      if (state.step !== 'verify' || !state.verifying) return state;
      const s = { ...state, verifying: false };
      if (action.ok || action.rejected === null) return afterKeys({ ...s, verify: action.ok ? 'ok' : 'failed' });
      return field({ ...s, verify: 'failed', entered: s.entered.filter((f) => f !== action.rejected) }, action.rejected, HINT_REJECTED);
    }
    case 'keep': {
      if (state.field === null || state.hint !== HINT_REJECTED) return state;
      return afterKeys({ ...state, entered: state.entered.includes(state.field) ? state.entered : [...state.entered, state.field] });
    }
    case 'trust': {
      if (state.step !== 'trust') return state;
      return { ...state, step: 'sandbox', trustDecision: action.option, hint: null };
    }
    case 'sandbox-shown': {
      if (state.step !== 'sandbox') return state;
      return { ...state, step: 'done' };
    }
    default:
      return state;
  }
}

/** TUI-DESIGN §11.1 / D1: rows the wizard takes in the overlay slot — provider 3, key 3, verify 2, trust 4 (2 below rows 12), save/sandbox/done 0; never more than 4. */
export function wizardRows(state: OnboardingState, rows: number): number {
  switch (state.step) {
    case 'provider':
    case 'generatorKey':
    case 'jevKey':
      return 3;
    case 'verify':
      return 2;
    case 'trust':
      return Number.isFinite(rows) && rows < 12 ? 2 : 4;
    default:
      return 0;
  }
}

/** TUI-DESIGN §11.1: the wizard owns the overlay slot and the keys while one of these steps is active. */
export function wizardActive(state: OnboardingState): boolean {
  return wizardRows(state, Infinity) > 0 || state.step === 'save';
}
