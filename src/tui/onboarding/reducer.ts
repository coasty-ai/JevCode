/**
 * First-run wizard state machine (TUI-DESIGN §11.1, D5, F10; TUI-DESIGN-2 §1.4). Pure: the reducer never sees a
 * key byte — the field buffer lives in the component's `useRef<string>` and only its masked
 * length (plus booleans the component derives) reaches the reducer, so a state dump, a test
 * snapshot or a devtools tree can never contain a credential.
 *
 *   detect → [jevProvider] → jevKey → save → verify? → trust → sandbox → done          jev-only first run (the default)
 *   detect → provider → generatorKey → [jevProvider] → jevKey → save → …                 jev-on first run
 *   reopen(reason 'mode') → provider → generatorKey → save → verify? → done              /mode jev-on with no generator key
 *
 * Ctrl-C exits 2 only for a wizard a missing key opened at startup with no run live; a wizard a command opened
 * (`/login`, `/mode`) or one open while a run is live closes instead (TUI-DESIGN-2 §1.4, TD E5).
 */
import type { EngineMode, JevProvider, SecretSettingName } from '../../core/types.js';
import { MIN_SECRET_LENGTH } from '../../core/redact.js';

/** TUI-DESIGN §11.1: the two generator providers the wizard offers. */
export type WizardProvider = 'anthropic' | 'openrouter';
/** TUI-DESIGN §11.1: the two masked fields. */
export type WizardField = SecretSettingName;
/** TUI-DESIGN §11.1 / TUI-DESIGN-2 §1.4: the wizard steps in order (`jevProvider` new; `exit` = Ctrl-C with no run at startup). */
export type WizardStep = 'detect' | 'jevProvider' | 'provider' | 'generatorKey' | 'jevKey' | 'save' | 'verify' | 'trust' | 'sandbox' | 'done' | 'exit';
/** TUI-DESIGN §11.3: `1 trust · 2 this session only · 3 don't trust`. */
export type TrustOption = 1 | 2 | 3;
/**
 * TUI-DESIGN-2 §1.4: why the wizard is open — `missing` (a key at startup), `login` (`/login`), `rejected` (a 401 pane's
 * `[l]`), `mode` (`/mode jev-on` with no generator key: the generator step in place, Ctrl-C keeps the current mode).
 */
export type WizardReason = 'missing' | 'login' | 'rejected' | 'mode';

/** What the host persists when `step === 'save'` (the bytes come from the component's refs, keyed by field). */
export interface SaveRequest {
  /** the provider chosen on the provider step; null when that step was never shown (the host then leaves `provider` in the file untouched) */
  provider: WizardProvider | null;
  /** TUI-DESIGN-2 §1.4: the Jev provider chosen on the jevProvider step; null when that step was never shown (file key `jevProvider` untouched) */
  jevProvider: JevProvider | null;
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
  /** TUI-DESIGN-2 §1.4: the Jev provider (preselected by the detect, or chosen on the jevProvider step) */
  jevProvider: JevProvider | null;
  /** the jevProvider step was shown (Esc from the Jev key field returns to it; the save carries the choice) */
  jevProviderShown: boolean;
  /** TUI-DESIGN-2 §1.4: why the wizard is open; decides what Ctrl-C does */
  reason: WizardReason;
  missing: readonly SecretSettingName[];
  /** the target mode: the session's mode at startup, or the mode `/mode` is switching to (reason `mode`) */
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
      /** TUI-DESIGN-2 §1.4: the Jev provider a §2.3 rule inferred; null = nothing inferred (the jevProvider step is shown) */
      jevProvider?: JevProvider | null;
      /** TUI-DESIGN-2 §1.4: why the wizard opens (default `missing`) */
      reason?: WizardReason;
      trustNeeded: boolean;
      runLive?: boolean;
    }
  /** `1` / `2` on the provider or jevProvider step (Enter accepts the preselection) */
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
  /**
   * `/login`: re-enter at the provider step or at the missing field. TUI-DESIGN-2 §1.4: `reason` (default `login`) and
   * `mode` (default: the state's); reason `mode` forces the provider step with the `<badge> needs a generator` title.
   * `jevProvider` (the session's resolved Jev provider, §2.3) replaces the state's when given; a reopen at the Jev key with
   * no Jev provider known asks the jevProvider step first — a Jev key is never saved without the provider it belongs to.
   */
  | { type: 'reopen'; at: 'provider' | WizardField; runLive: boolean; reason?: Exclude<WizardReason, 'missing'>; mode?: EngineMode; jevProvider?: JevProvider | null };

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
/** TUI-DESIGN-2 §1.4: the same no-op hint when Ctrl-C closes the wizard instead of exiting (`/login`, `/mode`, a live run). */
export const HINT_CTRL_C_CLOSES = 'Ctrl-C closes';
/** TUI-DESIGN §11.1 / D2: wizard Ctrl-C with no run → the fix block and exit 2. */
export const WIZARD_EXIT_CODE = 2;
/** TUI-DESIGN-2 §1.4: the `1`/`2` options of the jevProvider step, in row order. */
export const JEV_PROVIDER_OPTIONS: readonly [JevProvider, JevProvider] = ['typesafe', 'openrouter'];

/** TUI-DESIGN §11.1: the key prefixes each provider issues; a mismatch only warns. */
export const KEY_PREFIXES: Readonly<Record<WizardProvider, readonly string[]>> = {
  anthropic: ['sk-ant-'],
  openrouter: ['sk-or-v1-', 'sk-or-'],
};

/**
 * TUI-DESIGN §11.1: does the buffer start like a key of `provider`? The component calls this on its ref and passes the
 * boolean. TUI-DESIGN-2 §2.3: the TypeSafe key's shape is unknown, so `typesafe` accepts anything. Pure.
 */
export function looksLikeKey(buffer: string, provider: WizardProvider | JevProvider | null): boolean {
  if (provider === null || provider === 'typesafe') return true;
  return KEY_PREFIXES[provider].some((p) => buffer.startsWith(p));
}

/**
 * TUI-DESIGN-2 §1.4: the provider whose key shape the active field is checked against — the Jev provider on the Jev step
 * (openrouter when none was chosen: `JEV_API_KEY` / `OPENROUTER_API_KEY` are OpenRouter keys), the generator provider otherwise.
 */
export function expectedKeyProvider(state: OnboardingState): WizardProvider | JevProvider | null {
  if (state.step === 'jevKey') return state.jevProvider ?? 'openrouter';
  return state.provider;
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

/** TUI-DESIGN §11.1: the state before `detect` (TUI-DESIGN-2 §1.1: the default mode is jev-only). */
export const INITIAL_ONBOARDING: OnboardingState = {
  step: 'detect',
  field: null,
  length: 0,
  provider: null,
  providerShown: false,
  jevProvider: null,
  jevProviderShown: false,
  reason: 'missing',
  missing: [],
  mode: 'jev-only',
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
/** TUI-DESIGN-2 §1.4: Ctrl-C closes (never exits) for a wizard a command opened or one open while a run is live. */
export function cancelCloses(s: Pick<OnboardingState, 'runLive' | 'reason'>): boolean {
  return s.runLive || s.reason === 'mode' || s.reason === 'login';
}
function firstStepHint(s: OnboardingState): string {
  return cancelCloses(s) ? HINT_CTRL_C_CLOSES : HINT_CTRL_C_QUITS;
}

function field(s: OnboardingState, f: WizardField, hint: string | null = null): OnboardingState {
  return { ...s, step: f === 'generator.apiKey' ? 'generatorKey' : 'jevKey', field: f, length: 0, hint, prefixWarned: false };
}

/**
 * After the keys: the trust question and the `[sandbox]` line belong to the startup wizard (reason `missing`); a wizard a
 * command reopened (`/login`, `/mode`, a 401 pane's `[l]`) settled both at startup and closes at once (TUI-DESIGN-2 §1.4:
 * `provider → generatorKey → save → verify? → done`).
 */
function afterKeys(s: OnboardingState): OnboardingState {
  if (s.reason !== 'missing') return { ...s, step: 'done', field: null, length: 0, hint: null };
  if (s.trustNeeded && s.trustDecision === null) return { ...s, step: 'trust', field: null, length: 0, hint: null };
  return { ...s, step: 'sandbox', field: null, length: 0, hint: null };
}

function toSave(s: OnboardingState, reuse: boolean): OnboardingState {
  // Only a provider the user actually chose is persisted; a guessed one would write a `provider` they never selected.
  const provider = s.providerShown ? s.provider : null;
  const jevProvider = s.jevProviderShown ? s.jevProvider : null;
  return { ...s, step: 'save', field: null, length: 0, hint: null, save: { provider, jevProvider, fields: s.entered, reuseGeneratorForJev: reuse } };
}

/**
 * TUI-DESIGN-2 §1.4: an OpenRouter generator key typed in THIS wizard serves Jev too (the Jev provider is openrouter,
 * `Enter = reuse`). A detect-time `provider` alone never counts: since commit 2a92d0b the resolved default generator
 * provider is openrouter, and a TypeSafe key saved under it would be sent to openrouter.ai — the failure §1.4 forbids.
 */
export function openrouterGeneratorEntered(s: Pick<OnboardingState, 'provider' | 'entered'>): boolean {
  return s.provider === 'openrouter' && s.entered.includes('generator.apiKey');
}

/**
 * TUI-DESIGN-2 §1.4: Enter on an empty Jev field reuses the OpenRouter generator key — only when that key was typed in this
 * wizard AND the Jev provider is openrouter or unresolved (a `typesafe` Jev provider never receives an OpenRouter key).
 */
export function reuseOffered(s: Pick<OnboardingState, 'step' | 'provider' | 'entered' | 'jevProvider'>): boolean {
  return s.step === 'jevKey' && openrouterGeneratorEntered(s) && (s.jevProvider === null || s.jevProvider === 'openrouter');
}

/**
 * TUI-DESIGN-2 §1.4: the Jev key step, preceded by the jevProvider step when no §2.3 rule inferred the provider (an
 * explicit detect `jevProvider`) and no OpenRouter generator key was entered in this wizard.
 */
function toJevKey(s: OnboardingState): OnboardingState {
  if (s.jevProvider === null && !openrouterGeneratorEntered(s)) return { ...s, step: 'jevProvider', jevProviderShown: true, field: null, length: 0, hint: null, prefixWarned: false };
  return field(s, 'decider.apiKey');
}

function nextAfterGenerator(s: OnboardingState): OnboardingState {
  return needsJev(s) ? toJevKey(s) : toSave(s, false);
}

function startFromDetect(s: OnboardingState): OnboardingState {
  if (s.missing.length === 0) return afterKeys(s);
  if (needsGenerator(s)) return { ...s, step: 'provider', providerShown: true };
  if (needsJev(s)) return toJevKey(s);
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
        jevProvider: action.jevProvider ?? null,
        reason: action.reason ?? 'missing',
        trustNeeded: action.trustNeeded,
        runLive: action.runLive ?? false,
      };
      return startFromDetect(s);
    }
    case 'reopen': {
      const reason: WizardReason = action.reason ?? 'login';
      // §1.4: under reason `mode` only the generator key is missing for the target mode (the session runs on its Jev key), whatever the startup detect listed
      const missing = reason === 'mode' ? (['generator.apiKey'] as const) : state.missing;
      const jevProvider = action.jevProvider !== undefined ? action.jevProvider : state.jevProvider;
      const base: OnboardingState = { ...state, runLive: action.runLive, reason, mode: action.mode ?? state.mode, missing, jevProvider, exitCode: null, hint: null, verifying: false, save: null, entered: [] };
      // §1.4: reason `mode` is the generator step in place — always the provider step, never the stale field of the startup detect
      if (action.at === 'provider' || reason === 'mode') return { ...base, step: 'provider', providerShown: true, field: null, length: 0, prefixWarned: false };
      // §1.4: the Jev key with no Jev provider known asks where Jev is reached first (never saved as an openrouter key by default)
      if (action.at === 'decider.apiKey') return toJevKey({ ...base, providerShown: false, jevProviderShown: false });
      return field({ ...base, providerShown: false }, action.at);
    }
    case 'choose': {
      if (state.step === 'jevProvider') {
        const jevProvider: JevProvider | null = action.option === 1 ? JEV_PROVIDER_OPTIONS[0] : action.option === 2 ? JEV_PROVIDER_OPTIONS[1] : state.jevProvider;
        if (jevProvider === null) return { ...state, hint: 'pick 1 or 2' };
        return field({ ...state, jevProvider }, 'decider.apiKey');
      }
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
      // §1.4: Enter on the empty Jev field reuses the OpenRouter key only when it was typed here and the Jev provider is openrouter (or unresolved)
      if (length === 0 && reuseOffered(s)) return toSave(s, true);
      if (length < MIN_SECRET_LENGTH) return { ...s, hint: HINT_TOO_SHORT };
      if (!action.prefixOk && !s.prefixWarned) {
        return { ...s, hint: hintPrefix(s.step === 'jevKey' ? 'openrouter (Jev)' : (s.provider ?? 'openrouter')), prefixWarned: true };
      }
      const entered = s.entered.includes(s.field!) ? s.entered : [...s.entered, s.field!];
      const done = { ...s, entered, hint: null, prefixWarned: false };
      return s.step === 'generatorKey' ? nextAfterGenerator(done) : toSave(done, false);
    }
    case 'escape': {
      if (state.field !== null && state.length > 0) return { ...state, length: 0, hint: null, prefixWarned: false };
      if (state.step === 'jevKey') {
        if (state.jevProviderShown) return { ...state, step: 'jevProvider', field: null, length: 0, hint: null, prefixWarned: false };
        if (state.entered.includes('generator.apiKey')) return field({ ...state, entered: state.entered.filter((f) => f !== 'generator.apiKey') }, 'generator.apiKey');
        if (state.providerShown) return { ...state, step: 'provider', field: null, length: 0, hint: null };
        return { ...state, hint: firstStepHint(state) };
      }
      if (state.step === 'jevProvider') {
        if (state.entered.includes('generator.apiKey')) return field({ ...state, entered: state.entered.filter((f) => f !== 'generator.apiKey') }, 'generator.apiKey');
        return { ...state, hint: firstStepHint(state) };
      }
      if (state.step === 'generatorKey') {
        if (state.providerShown) return { ...state, step: 'provider', field: null, length: 0, hint: null, prefixWarned: false };
        return { ...state, hint: firstStepHint(state) };
      }
      if (state.step === 'provider') return { ...state, hint: firstStepHint(state) };
      return state;
    }
    case 'cancel': {
      if (state.step === 'done' || state.step === 'exit') return state;
      // TUI-DESIGN-2 §1.4: a wizard opened by a command (/login, /mode) or while a run is live closes; one opened by a missing key at startup exits 2
      if (cancelCloses(state)) return { ...state, step: 'done', field: null, length: 0, hint: null, verifying: false, save: null };
      return { ...state, step: 'exit', field: null, length: 0, hint: null, verifying: false, save: null, exitCode: WIZARD_EXIT_CODE };
    }
    case 'saved': {
      if (state.step !== 'save') return state;
      const s = { ...state, save: null };
      return s.entered.length > 0 ? { ...s, step: 'verify' } : afterKeys(s);
    }
    case 'save-failed': {
      if (state.step !== 'save') return state;
      // `needsGenerator` reads the target `state.mode`, so a failed save under reason `mode` returns to the generator field (§1.4)
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

/** TUI-DESIGN §11.1 / D1: rows the wizard takes in the overlay slot — jevProvider 3, provider 3, key 3, verify 2, trust 4 (2 below rows 12), save/sandbox/done 0; never more than 4. */
export function wizardRows(state: OnboardingState, rows: number): number {
  switch (state.step) {
    case 'jevProvider':
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
