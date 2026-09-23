/**
 * First-run wizard state machine (TUI-DESIGN §11.1, D5, F10; TUI-DESIGN-2 §1.4; TUI-DESIGN-3 §1.4 D-J). Pure: the reducer never
 * sees a key byte — the field buffer lives in the component's `useRef<string>` and only its masked length (plus booleans
 * the component derives) reaches the reducer, so a state dump, a test snapshot or a devtools tree can never contain a
 * credential.
 *
 *   detect → key → save → verify? → [caps item] → trust → sandbox → [import] → done    both keys missing, nothing inferred (one OpenRouter paste)
 *            key ──Esc (empty)──▶ options: 1 key (back) · 2 jevKey(typesafe) → generatorKey(Enter = skip) · 3 Jev only (mode) · 4 generatorKey(anthropic)
 *   detect → key (found-title; the generator key ONLY) → save → …                  Jev resolves (TYPESAFE_API_KEY / JEV_API_KEY / a saved key), generator missing
 *   detect → [jevProvider] → jevKey → save → verify? → trust → sandbox → done          generator resolves, Jev missing (the round-2 flow, untouched)
 *   detect → provider → generatorKey → [jevProvider] → jevKey → save → …              a non-openrouter generator provider was preselected
 *   reopen(reason 'mode') → provider → generatorKey → save → verify? → done              /mode jev-on with no generator key
 *
 * Ctrl-C exits 2 only for a wizard a missing key opened at startup with no run live; a wizard a command opened
 * (`/login`, `/mode`, `/trust`) or one open while a run is live closes instead (TUI-DESIGN-2 §1.4, TD E5).
 */
import type { EngineMode, JevProvider, SecretSettingName } from '../../core/types.js';
import { DEFAULT_MODE } from '../../config/defaults.js';
import { MIN_SECRET_LENGTH } from '../../core/redact.js';

/** TUI-DESIGN §11.1: the two generator providers the wizard offers. */
export type WizardProvider = 'anthropic' | 'openrouter';
/** TUI-DESIGN §11.1 / TUI-DESIGN-3 §1.4.1: the masked fields — the two secrets and `key`, the one-paste OpenRouter field. */
export type WizardField = SecretSettingName | 'key';
/** TUI-DESIGN §11.1 / TUI-DESIGN-2 §1.4 / TUI-DESIGN-3 §1.4.1: the wizard steps (`key` / `options` new; `exit` = Ctrl-C with no run at startup). */
export type WizardStep = 'detect' | 'key' | 'options' | 'jevProvider' | 'provider' | 'generatorKey' | 'jevKey' | 'save' | 'verify' | 'trust' | 'sandbox' | 'import' | 'done' | 'exit';
/** TUI-DESIGN §11.3: `1 trust · 2 this session only · 3 don't trust`. */
export type TrustOption = 1 | 2 | 3;
/**
 * TUI-DESIGN-5 §5.1 / IMPORT-DESIGN §5.1 (F-O): what the ≤ 50 ms `probe()` told the wizard — **tool names and
 * counts only**, never a path, never a value, never a body. A structural subset of `ImportProbe`
 * (`src/core/types.ts`), restated so the reducer imports nothing from `src/import/**` (gate G-R5-1).
 */
export interface ImportProbeCounts {
  readonly tools: readonly { readonly display: string; readonly items: number }[];
  /** sum of `tools[].items` */
  readonly total: number;
}
/** TUI-DESIGN-5 §5.1: `1 import now · 2 later · 3 never` — the step's three answers. */
export type ImportOption = 1 | 2 | 3;
/**
 * TUI-DESIGN-2 §1.4: why the wizard is open — `missing` (a key at startup), `login` (`/login`), `rejected` (a 401 pane's
 * `[l]`), `mode` (`/mode jev-on` with no generator key: the generator step in place, Ctrl-C keeps the current mode);
 * TUI-DESIGN-3 §4.4 F17: `trust` (the card `/trust` reopens: Esc and Ctrl-C close it, nothing exits).
 */
export type WizardReason = 'missing' | 'login' | 'rejected' | 'mode' | 'trust';
/** TUI-DESIGN-3 §1.4.1: what detect found among the RESOLVED entries (a source, never a value). */
export type FoundKey = 'typesafe' | 'jev' | 'anthropic' | null;
/** TUI-DESIGN-3 §1.4.1: the layer the found key came from (title text only). */
export type FoundSource = 'env' | 'dotenv' | 'file';
/** TUI-DESIGN-3 §1.4.3: what the `key` field's bytes become — the save-shape table. */
export type KeyAs = 'both' | 'generator' | 'jev';
/** TUI-DESIGN-3 §1.4.1: the `1–4` of the options step, in row order. */
export const WIZARD_OPTIONS_ORDER = ['openrouter', 'typesafe', 'jev-only', 'anthropic'] as const;
export type WizardOption = 1 | 2 | 3 | 4;

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
  /** TUI-DESIGN-3 §1.4.1: the `key` field serves generator AND Jev (four file keys) — true ONLY when `found === null` */
  oneKey: boolean;
  /** TUI-DESIGN-3 §1.4.3: what the `key` field's bytes become */
  keyAs: KeyAs;
  /** TUI-DESIGN-3 §1.4.1 (found `jev`, an OpenRouter key): Enter on the empty `key` field copies the resolved Jev value into the file as the generator key */
  reuseJevForGenerator: boolean;
  /** TUI-DESIGN-3 §1.4.1: option `2` then an empty Enter on the generator field (`Enter = skip (stay Jev-only)`): the host pends / persists jev-only after the save */
  pendMode: EngineMode | null;
}

/** TUI-DESIGN §11.1: the reducer state — `{ step, field, length }` and booleans; never a key byte. */
export interface OnboardingState {
  step: WizardStep;
  /** the active masked field, or null outside the key steps */
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
  /** TUI-DESIGN-3 §1.9: the session's current (next-run) mode — what Ctrl-C keeps under reason `mode` (`providerHintMode`) */
  currentMode: EngineMode;
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
  /** TUI-DESIGN-3 §1.4.1: what detect found among the resolved entries (the `key` step's found-title) */
  found: FoundKey;
  foundSource: FoundSource | null;
  /** TUI-DESIGN-3 §1.4.1: the found Jev value is an OpenRouter key (`sk-or-…`): Enter on the empty `key` field reuses it (the host computed the boolean; never the value) */
  foundReusable: boolean;
  /** the options step was shown (Esc from `key` opened it) */
  optionsShown: boolean;
  /** the highlighted option on the `options` step (a digit highlights, the same digit or Enter confirms) */
  highlight: WizardOption | null;
  /** the option confirmed on the `options` step (`2`: jevKey then the skippable generator field; `3`: Jev only; `4`: Anthropic) */
  optionsChoice: WizardOption | null;
  /** TUI-DESIGN-3 §1.4.1: option `3` (or `2` + skip) pends / persists this mode without saving a key */
  pendMode: EngineMode | null;
  /**
   * TUI-DESIGN-5 §5.1: what `probe()` found, or null while it is still running / after it missed its deadline.
   * `null` and `total === 0` both mean "the step does not render at all" (§7 rows 52, 53).
   */
  importProbe: ImportProbeCounts | null;
  /** the config's `seen.import` is set (`never`, or this version already asked): the step is skipped */
  importSeen: boolean;
  /** the answer the human gave on the import step; the HOST acts on it (open the overlay, write `seen.import`) */
  importChoice: ImportOption | null;
  /** the highlighted option on the import step (a digit highlights, the same digit or Enter confirms) */
  importHighlight: ImportOption | null;
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
      /** TUI-DESIGN-3 §1.4.1: what already resolves, and where from */
      found?: FoundKey;
      foundSource?: FoundSource;
      /** TUI-DESIGN-3 §1.4.1: the found Jev value starts `sk-or-` (the host's boolean, never the value) */
      foundReusable?: boolean;
      /** TUI-DESIGN-5 §5.1: `seen.import` is already set (`never`, or this version asked) — the step never renders */
      importSeen?: boolean;
    }
  /** `1`–`4` / Enter on the options step; `1` / `2` on the provider or jevProvider step (Enter accepts the preselection) */
  | { type: 'choose'; option: WizardOption | 'enter' }
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
   * TUI-DESIGN-5 §5.1 / §7 rows 52–53: the post-first-frame `probe()` resolved. `found: null` is BOTH "nothing
   * installed" and "the 50 ms deadline passed" — the step is skipped for this start either way, and the reducer
   * does not distinguish them because the user-visible behaviour is identical.
   */
  | { type: 'import-probe'; found: ImportProbeCounts | null }
  /** TUI-DESIGN-5 §5.1: `1` / `2` / `3` on the import step; a digit highlights, the same digit or Enter confirms */
  | { type: 'import-choose'; option: ImportOption | 'enter' }
  /** TUI-DESIGN-3 §1.8 edge 2: the component saw `sk-or-` twice in the buffer (pure: no bytes reach the reducer) */
  | { type: 'pasted-twice' }
  /**
   * `/login`: re-enter at the provider step or at the missing field. TUI-DESIGN-2 §1.4: `reason` (default `login`) and
   * `mode` (default: the state's); reason `mode` forces the provider step with the `<badge> needs a generator` title.
   * `jevProvider` (the session's resolved Jev provider, §2.3) replaces the state's when given; a reopen at the Jev key with
   * no Jev provider known asks the jevProvider step first — a Jev key is never saved without the provider it belongs to.
   * TUI-DESIGN-3 §1.3.2: `at: 'key'` reopens the one-paste field (both sides openrouter after a 401, or `/login` with nothing else resolving).
   */
  | { type: 'reopen'; at: 'provider' | WizardField; runLive: boolean; reason?: Exclude<WizardReason, 'missing'>; mode?: EngineMode; currentMode?: EngineMode; jevProvider?: JevProvider | null; found?: FoundKey; foundSource?: FoundSource };

/** TUI-DESIGN §11.1: `key too short (8+ characters)` — the redactor ignores shorter values, so the wizard must too (research 13 §5.3). */
export const HINT_TOO_SHORT = `key too short (${MIN_SECRET_LENGTH}+ characters)`;
/** TUI-DESIGN §11.1: the prefix hint warns only, never blocks (research 13 §5.3). */
export function hintPrefix(provider: WizardProvider | 'openrouter (Jev)'): string {
  return `this does not look like an ${provider} key — Enter again to keep it`;
}
/** TUI-DESIGN-3 §1.4.2: the `key` field's prefix variant — it names the `Esc, then 2` route a TypeSafe key belongs to (71 cells). */
export const HINT_PREFIX_KEY = 'not an OpenRouter key? Enter again keeps it · TypeSafe key: Esc, then 2';
/** TUI-DESIGN-3 §1.8 edge 2: the buffer holds `sk-or-` twice. */
export const HINT_PASTED_TWICE = 'looks like the key was pasted twice — Ctrl-U clears';
/** TUI-DESIGN-3 §1.4.2: Enter on the `options` step with nothing highlighted. */
export const HINT_PICK_OPTION = 'pick 1–4';
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

/** TUI-DESIGN-3 §1.8 edge 2: `sk-or-` appears twice — the key was pasted twice. Pure; the component calls it on its ref. */
export function looksPastedTwice(buffer: string): boolean {
  const first = buffer.indexOf('sk-or-');
  return first >= 0 && buffer.indexOf('sk-or-', first + 1) > first;
}

/**
 * TUI-DESIGN-2 §1.4: the provider whose key shape the active field is checked against — the Jev provider on the Jev step
 * (openrouter when none was chosen: `JEV_API_KEY` / `OPENROUTER_API_KEY` are OpenRouter keys), the generator provider otherwise.
 * TUI-DESIGN-3 §1.4.1: the one-paste `key` field is an OpenRouter key whatever `found` says.
 */
export function expectedKeyProvider(state: OnboardingState): WizardProvider | JevProvider | null {
  if (state.step === 'key') return 'openrouter';
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

/** TUI-DESIGN §11.1: the state before `detect` (TUI-DESIGN-3 §1.1: the mode is DEFAULT_MODE until detect names one). */
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
  mode: DEFAULT_MODE,
  currentMode: DEFAULT_MODE,
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
  found: null,
  foundSource: null,
  foundReusable: false,
  optionsShown: false,
  highlight: null,
  optionsChoice: null,
  pendMode: null,
  importProbe: null,
  importSeen: false,
  importChoice: null,
  importHighlight: null,
};

/**
 * TUI-DESIGN-5 §5.1 / §7 row 53 / IMPORT-DESIGN §5.1: `probe()`'s own deadline (`src/import/index.ts:595`),
 * restated here because the WIZARD enforces it too — the `sandbox` step waits this long for an answer and no
 * longer, and a probe that misses it skips the step for this start rather than blocking setup.
 */
/**
 * TUI-DESIGN-5 §5.1 / §7 rows 52–53: does the import step render at all? Only when the probe already came back
 * with at least one item and `seen.import` is unset. A pending probe (`importProbe === null`) reads as "no" — the
 * wizard never waits on it, which is §1.4 promise 1 applied to onboarding.
 */
export const IMPORT_PROBE_DEADLINE_MS = 50;

export function importStepWanted(s: Pick<OnboardingState, 'importProbe' | 'importSeen'>): boolean {
  return !s.importSeen && s.importProbe !== null && s.importProbe.total > 0 && s.importProbe.tools.length > 0;
}

/** TUI-DESIGN-3 §1.4.1: the mode the wizard is collecting keys for — option `3` (or `2` + skip) pends jev-only over the detect's mode. */
export function targetMode(s: Pick<OnboardingState, 'mode' | 'pendMode'>): EngineMode {
  return s.pendMode ?? s.mode;
}
function needsGenerator(s: OnboardingState): boolean {
  return targetMode(s) !== 'jev-only' && s.missing.includes('generator.apiKey');
}
function needsJev(s: OnboardingState): boolean {
  return s.missing.includes('decider.apiKey');
}
/** TUI-DESIGN-2 §1.4 / TUI-DESIGN-3 §4.4 F17: Ctrl-C closes (never exits) for a wizard a command opened or one open while a run is live. */
export function cancelCloses(s: Pick<OnboardingState, 'runLive' | 'reason'>): boolean {
  return s.runLive || s.reason === 'mode' || s.reason === 'login' || s.reason === 'trust';
}
function firstStepHint(s: OnboardingState): string {
  return cancelCloses(s) ? HINT_CTRL_C_CLOSES : HINT_CTRL_C_QUITS;
}
/** TUI-DESIGN-3 §1.4.1: one predicate for both renderers' masked row (Console.tsx and Wizard.tsx read it; neither lists steps itself). */
export const isFieldStep = (step: WizardStep): boolean => step === 'key' || step === 'generatorKey' || step === 'jevKey';

/** TUI-DESIGN-3 §1.4.3: what the `key` field's bytes become, from what detect found (the save-shape table). */
export function keyAsOf(found: FoundKey): KeyAs {
  return found === null ? 'both' : found === 'anthropic' ? 'jev' : 'generator';
}

function stepOf(f: WizardField): WizardStep {
  return f === 'key' ? 'key' : f === 'generator.apiKey' ? 'generatorKey' : 'jevKey';
}

function field(s: OnboardingState, f: WizardField, hint: string | null = null): OnboardingState {
  return { ...s, step: stepOf(f), field: f, length: 0, hint, prefixWarned: false, highlight: null };
}

/**
 * After the keys: the trust question and the `[sandbox]` line belong to the startup wizard (reason `missing`); a wizard a
 * command reopened (`/login`, `/mode`, a 401 pane's `[l]`) settled both at startup and closes at once (TUI-DESIGN-2 §1.4:
 * `provider → generatorKey → save → verify? → done`).
 */
function afterKeys(s: OnboardingState): OnboardingState {
  // TUI-DESIGN-3 §4.4 F17: the `/trust` card (reason `trust`) is the trust step alone — no keys before it, no sandbox line after it
  if (s.reason === 'trust') return s.trustDecision === null ? { ...s, step: 'trust', field: null, length: 0, hint: null } : { ...s, step: 'done', field: null, length: 0, hint: null };
  if (s.reason !== 'missing') return { ...s, step: 'done', field: null, length: 0, hint: null };
  if (s.trustNeeded && s.trustDecision === null) return { ...s, step: 'trust', field: null, length: 0, hint: null };
  return { ...s, step: 'sandbox', field: null, length: 0, hint: null };
}

function toSave(s: OnboardingState, reuse: boolean, extra: Partial<Pick<SaveRequest, 'reuseJevForGenerator'>> = {}): OnboardingState {
  // Only a provider the user actually chose is persisted; a guessed one would write a `provider` they never selected.
  const provider = s.providerShown ? s.provider : null;
  const jevProvider = s.jevProviderShown ? s.jevProvider : null;
  const oneKeyField = s.entered.includes('key');
  return {
    ...s,
    step: 'save',
    field: null,
    length: 0,
    hint: null,
    save: {
      provider,
      jevProvider,
      fields: s.entered,
      reuseGeneratorForJev: reuse,
      oneKey: oneKeyField && s.found === null,
      keyAs: keyAsOf(s.found),
      reuseJevForGenerator: extra.reuseJevForGenerator ?? false,
      pendMode: s.pendMode,
    },
  };
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

/** TUI-DESIGN-3 §1.4.1 (edges 11, 17): Enter on the empty `key` field copies the found OpenRouter Jev value into the file as the generator key. */
export function reuseJevOffered(s: Pick<OnboardingState, 'step' | 'found' | 'foundReusable' | 'length'>): boolean {
  return s.step === 'key' && s.found === 'jev' && s.foundReusable && s.length === 0;
}

/** TUI-DESIGN-3 §1.4.1: option `2`'s generator field — an empty Enter skips it and stays Jev-only. */
export function skipOffered(s: Pick<OnboardingState, 'step' | 'optionsChoice' | 'length'>): boolean {
  return s.step === 'generatorKey' && s.optionsChoice === 2 && s.length === 0;
}

/**
 * TUI-DESIGN-2 §1.4: the Jev key step, preceded by the jevProvider step when no §2.3 rule inferred the provider (an
 * explicit detect `jevProvider`) and no OpenRouter generator key was entered in this wizard.
 */
function toJevKey(s: OnboardingState): OnboardingState {
  if (s.jevProvider === null && !openrouterGeneratorEntered(s)) return { ...s, step: 'jevProvider', jevProviderShown: true, field: null, length: 0, hint: null, prefixWarned: false, highlight: null };
  return field(s, 'decider.apiKey');
}

function nextAfterGenerator(s: OnboardingState): OnboardingState {
  // TUI-DESIGN-3 §1.4.1: after option `2` the Jev key was typed first — never ask it again
  return needsJev(s) && !s.entered.includes('decider.apiKey') ? toJevKey(s) : toSave(s, false);
}

/** TUI-DESIGN-3 §1.4.1: after option `2`'s Jev key — the skippable generator field when the mode needs one, else the save. */
function nextAfterJevTypesafe(s: OnboardingState): OnboardingState {
  return needsGenerator(s) && !s.entered.includes('generator.apiKey') ? field(s, 'generator.apiKey') : toSave(s, false);
}

/** TUI-DESIGN-3 §1.4.1 / §1.4: which flow detect opens (the one-paste `key` before the round-2 branches). */
function startFromDetect(s: OnboardingState): OnboardingState {
  if (s.missing.length === 0) return afterKeys(s);
  // both missing, nothing inferred a Jev provider, provider null or openrouter → the one-paste field (keyAs both)
  if (needsGenerator(s) && needsJev(s) && s.jevProvider === null && (s.provider === null || s.provider === 'openrouter')) {
    // TUI-DESIGN-3 §1.3.1 (`ANTHROPIC_API_KEY` only): the field is the Jev key; the generator provider becomes anthropic on the save (keyAs jev)
    if (s.found === 'anthropic') return field({ ...s, provider: 'anthropic' }, 'key');
    return field(s, 'key');
  }
  // Jev resolves (TypeSafe / JEV_API_KEY / a saved key), generator missing → the found-title field (keyAs generator)
  if (needsGenerator(s) && !needsJev(s) && s.reason === 'missing' && (s.found === 'typesafe' || s.found === 'jev')) return field(s, 'key');
  if (needsGenerator(s)) return { ...s, step: 'provider', providerShown: true };
  if (needsJev(s)) return toJevKey(s);
  return afterKeys(s);
}

/** TUI-DESIGN-3 §1.4.1: confirm an option of the `options` step. */
function confirmOption(s: OnboardingState, n: WizardOption): OnboardingState {
  const base: OnboardingState = { ...s, highlight: null, hint: null, optionsChoice: n };
  switch (n) {
    case 1:
      return field({ ...base, optionsChoice: null }, 'key');
    case 2: {
      const ts: OnboardingState = { ...base, jevProvider: 'typesafe', jevProviderShown: true };
      // the Jev key first when it is missing; a resolving TypeSafe key (found `typesafe`) goes to the generator field at once
      return needsJev(ts) ? field(ts, 'decider.apiKey') : nextAfterJevTypesafe(ts);
    }
    case 3: {
      // TUI-DESIGN-3 §1.4.3 (D-J ext.): the host receives `{ kind: 'mode', mode: 'jev-only', persist: reason === 'missing' }`; the wizard's target (`targetMode`) becomes jev-only
      const jo: OnboardingState = { ...base, pendMode: 'jev-only' };
      return needsJev(jo) ? toJevKey(jo) : afterKeys(jo);
    }
    case 4: {
      const anth: OnboardingState = { ...base, provider: 'anthropic', providerShown: true };
      // the Anthropic key already resolves (found `anthropic`): the provider-only save (`fields: []`), then the Jev key (`saved`)
      if (s.found === 'anthropic') return toSave({ ...anth, entered: [] }, false);
      return field(anth, 'generator.apiKey');
    }
  }
}

/** TUI-DESIGN §11.1: the pure wizard reducer; unknown or out-of-step actions return the same state object. */
export function onboardingReducer(state: OnboardingState, action: OnboardingAction): OnboardingState {
  switch (action.type) {
    case 'detect': {
      const s: OnboardingState = {
        ...INITIAL_ONBOARDING,
        missing: action.missing,
        mode: action.mode,
        currentMode: action.mode,
        provider: action.provider,
        jevProvider: action.jevProvider ?? null,
        reason: action.reason ?? 'missing',
        trustNeeded: action.trustNeeded,
        runLive: action.runLive ?? false,
        found: action.found ?? null,
        foundSource: action.foundSource ?? null,
        foundReusable: action.foundReusable ?? false,
        importSeen: action.importSeen ?? false,
      };
      return startFromDetect(s);
    }
    case 'reopen': {
      const reason: WizardReason = action.reason ?? 'login';
      // §1.4: under reason `mode` only the generator key is missing for the target mode (the session runs on its Jev key), whatever the startup detect listed
      const missing = reason === 'mode' ? (['generator.apiKey'] as const) : state.missing;
      const jevProvider = action.jevProvider !== undefined ? action.jevProvider : state.jevProvider;
      const base: OnboardingState = {
        ...state,
        runLive: action.runLive,
        reason,
        mode: action.mode ?? state.mode,
        currentMode: action.currentMode ?? state.currentMode,
        missing,
        jevProvider,
        exitCode: null,
        hint: null,
        verifying: false,
        save: null,
        entered: [],
        found: action.found !== undefined ? action.found : null,
        foundSource: action.foundSource ?? null,
        foundReusable: false,
        optionsShown: false,
        highlight: null,
        optionsChoice: null,
        pendMode: null,
      };
      // §1.4: reason `mode` is the generator step in place — always the provider step, never the stale field of the startup detect
      if (action.at === 'provider' || reason === 'mode') return { ...base, step: 'provider', providerShown: true, field: null, length: 0, prefixWarned: false, highlight: null };
      // §1.4: the Jev key with no Jev provider known asks where Jev is reached first (never saved as an openrouter key by default)
      if (action.at === 'decider.apiKey') return toJevKey({ ...base, providerShown: false, jevProviderShown: false });
      return field({ ...base, providerShown: false }, action.at);
    }
    case 'choose': {
      if (state.step === 'options') {
        if (action.option === 'enter') return state.highlight === null ? { ...state, hint: HINT_PICK_OPTION } : confirmOption(state, state.highlight);
        if (state.highlight === action.option) return confirmOption(state, action.option);
        return { ...state, highlight: action.option, hint: null };
      }
      if (state.step === 'jevProvider') {
        const jevProvider: JevProvider | null = action.option === 1 ? JEV_PROVIDER_OPTIONS[0] : action.option === 2 ? JEV_PROVIDER_OPTIONS[1] : action.option === 'enter' ? state.jevProvider : null;
        if (jevProvider === null) return { ...state, hint: 'pick 1 or 2' };
        return field({ ...state, jevProvider }, 'decider.apiKey');
      }
      if (state.step !== 'provider') return state;
      const provider: WizardProvider | null = action.option === 1 ? 'anthropic' : action.option === 2 ? 'openrouter' : action.option === 'enter' ? state.provider : null;
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
    case 'pasted-twice': {
      if (state.field === null) return state;
      return { ...state, hint: HINT_PASTED_TWICE };
    }
    case 'enter': {
      if (state.field === null) return state;
      const length = Number.isFinite(action.length) && action.length >= 0 ? Math.floor(action.length) : 0;
      const s = { ...state, length };
      // §1.4: Enter on the empty Jev field reuses the OpenRouter key only when it was typed here and the Jev provider is openrouter (or unresolved)
      if (length === 0 && reuseOffered(s)) return toSave(s, true);
      // TUI-DESIGN-3 §1.4.1 (edges 11, 17): Enter on the empty `key` field with a reusable found Jev key writes it as the generator key
      if (length === 0 && reuseJevOffered(s)) return toSave({ ...s, entered: [] }, false, { reuseJevForGenerator: true });
      // TUI-DESIGN-3 §1.4.1: option `2`'s generator field — an empty Enter skips it (the save pends / persists jev-only)
      if (length === 0 && skipOffered(s)) return toSave({ ...s, pendMode: 'jev-only' }, false);
      if (length < MIN_SECRET_LENGTH) return { ...s, hint: HINT_TOO_SHORT };
      if (!action.prefixOk && !s.prefixWarned) {
        const hint = s.step === 'key' ? HINT_PREFIX_KEY : hintPrefix(s.step === 'jevKey' ? 'openrouter (Jev)' : (s.provider ?? 'openrouter'));
        return { ...s, hint, prefixWarned: true };
      }
      const entered = s.entered.includes(s.field!) ? s.entered : [...s.entered, s.field!];
      const done = { ...s, entered, hint: null, prefixWarned: false };
      if (s.step === 'key') return toSave(done, false);
      if (s.step === 'generatorKey') return nextAfterGenerator(done);
      // TUI-DESIGN-3 §1.4.1: option `2` — the Jev key first, then the skippable generator field
      if (s.step === 'jevKey' && s.optionsChoice === 2) return nextAfterJevTypesafe(done);
      return toSave(done, false);
    }
    case 'escape': {
      // TUI-DESIGN-3 §1.4.1: Esc with text clears the buffer (the empty-field hint names the next Esc); the host clears its ref
      if (state.field !== null && state.length > 0) return { ...state, length: 0, hint: null, prefixWarned: false };
      if (state.step === 'key') return { ...state, step: 'options', field: null, length: 0, hint: null, prefixWarned: false, optionsShown: true, highlight: state.found === 'anthropic' ? 4 : null };
      if (state.step === 'options') return field({ ...state, highlight: null }, 'key', firstStepHint(state));
      // TUI-DESIGN-3 §1.4.1: Esc at `verify` = `n`
      if (state.step === 'verify') return state.verifying ? state : afterKeys({ ...state, verify: 'skipped' });
      // TUI-DESIGN-3 §4.4 F17: Esc closes the `/trust` card (resolves null); the startup trust card keeps Esc inert
      if (state.step === 'trust') return state.reason === 'trust' ? { ...state, step: 'done', field: null, length: 0, hint: null } : state;
      if (state.step === 'jevKey') {
        if (state.jevProviderShown && state.optionsChoice !== 2) return { ...state, step: 'jevProvider', field: null, length: 0, hint: null, prefixWarned: false };
        if (state.optionsChoice === 2) return { ...state, step: 'options', field: null, length: 0, hint: null, prefixWarned: false, jevProvider: null, jevProviderShown: false, optionsChoice: null, highlight: 2 };
        if (state.entered.includes('generator.apiKey')) return field({ ...state, entered: state.entered.filter((f) => f !== 'generator.apiKey') }, 'generator.apiKey');
        if (state.providerShown) return { ...state, step: 'provider', field: null, length: 0, hint: null };
        if (state.optionsShown) return { ...state, step: 'options', field: null, length: 0, hint: null, prefixWarned: false, pendMode: null, optionsChoice: null, highlight: state.optionsChoice };
        return { ...state, hint: firstStepHint(state) };
      }
      if (state.step === 'jevProvider') {
        if (state.entered.includes('generator.apiKey')) return field({ ...state, entered: state.entered.filter((f) => f !== 'generator.apiKey') }, 'generator.apiKey');
        if (state.optionsShown) return { ...state, step: 'options', field: null, length: 0, hint: null, jevProviderShown: false, optionsChoice: null, pendMode: null, highlight: state.optionsChoice };
        return { ...state, hint: firstStepHint(state) };
      }
      if (state.step === 'generatorKey') {
        if (state.optionsChoice === 2 && state.entered.includes('decider.apiKey')) return field({ ...state, entered: state.entered.filter((f) => f !== 'decider.apiKey') }, 'decider.apiKey');
        if (state.providerShown && state.optionsChoice === 4) return { ...state, step: 'options', field: null, length: 0, hint: null, prefixWarned: false, providerShown: false, provider: null, optionsChoice: null, highlight: 4 };
        if (state.providerShown) return { ...state, step: 'provider', field: null, length: 0, hint: null, prefixWarned: false };
        return { ...state, hint: firstStepHint(state) };
      }
      if (state.step === 'provider') return { ...state, hint: firstStepHint(state) };
      // TUI-DESIGN-5 §5.1: `(Esc = later)` — the same answer as `2`, so the offer returns next version, never never.
      if (state.step === 'import') return { ...state, step: 'done', importChoice: 2, importHighlight: null, hint: null };
      return state;
    }
    case 'cancel': {
      if (state.step === 'done' || state.step === 'exit') return state;
      // TUI-DESIGN-5 §5.1 / IMPORT-DESIGN §5.1: Ctrl-C on the IMPORT step closes the wizard and writes nothing — it
      // never exits 2. Every key is already saved by the time this step renders, so `exit 2 (prints the fix block)`
      // would tell a user who just finished setup that setup failed.
      if (state.step === 'import') return { ...state, step: 'done', importChoice: 2, importHighlight: null, hint: null };
      // TUI-DESIGN-2 §1.4: a wizard opened by a command (/login, /mode, /trust) or while a run is live closes; one opened by a missing key at startup exits 2
      if (cancelCloses(state)) return { ...state, step: 'done', field: null, length: 0, hint: null, verifying: false, save: null };
      return { ...state, step: 'exit', field: null, length: 0, hint: null, verifying: false, save: null, exitCode: WIZARD_EXIT_CODE };
    }
    case 'saved': {
      if (state.step !== 'save') return state;
      const s = { ...state, save: null };
      // TUI-DESIGN-3 §1.4.1: option `4` with the Anthropic key resolving (the provider-only save) continues to the Jev key
      if (s.optionsChoice === 4 && s.entered.length === 0) {
        const rest = { ...s, missing: s.missing.filter((m) => m !== 'generator.apiKey') };
        return needsJev(rest) ? toJevKey(rest) : afterKeys(rest);
      }
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
      // TUI-DESIGN-3 §1.3.2: a one-paste wizard returns to its `key` field whichever side rejected the key
      const back: WizardField = s.entered.includes('key') ? 'key' : action.rejected;
      return field({ ...s, verify: 'failed', entered: s.entered.filter((f) => f !== back) }, back, HINT_REJECTED);
    }
    case 'keep': {
      if (state.field === null || state.hint !== HINT_REJECTED) return state;
      return afterKeys({ ...state, entered: state.entered.includes(state.field) ? state.entered : [...state.entered, state.field] });
    }
    case 'trust': {
      if (state.step !== 'trust') return state;
      // TUI-DESIGN-3 §4.4 F17: the `/trust` card closes after its answer (the sandbox line was printed at startup)
      return { ...state, step: state.reason === 'trust' ? 'done' : 'sandbox', trustDecision: action.option, hint: null };
    }
    case 'sandbox-shown': {
      if (state.step !== 'sandbox') return state;
      // TUI-DESIGN-5 §5.1: the import step sits between `sandbox` and `done`, and renders ONLY when the ≤ 50 ms
      // probe already came back with something (§7 row 52) and `seen.import` is unset (`3 never` / `2 later`).
      return { ...state, step: importStepWanted(state) ? 'import' : 'done' };
    }
    case 'import-probe': {
      // §7 row 53: a probe that resolves after the wizard has moved on is dropped — the step is skipped for this
      // start rather than appearing under whatever is on screen now.
      if (state.step === 'done' || state.step === 'exit') return state;
      const s = { ...state, importProbe: action.found };
      if (state.step === 'import' && !importStepWanted(s)) return { ...s, step: 'done', importHighlight: null };
      return s;
    }
    case 'import-choose': {
      if (state.step !== 'import') return state;
      // TUI-DESIGN-3 §1.4.2's ratified idiom, reused: a digit highlights, the SAME digit or Enter confirms.
      if (action.option === 'enter') {
        const pick = state.importHighlight ?? 2;
        return { ...state, step: 'done', importChoice: pick, importHighlight: null, hint: null };
      }
      if (state.importHighlight !== action.option) return { ...state, importHighlight: action.option, hint: null };
      return { ...state, step: 'done', importChoice: action.option, importHighlight: null, hint: null };
    }
    default:
      return state;
  }
}

/** TUI-DESIGN §11.1 / D1: rows the wizard takes in the overlay slot — key 3, options 3, jevProvider 3, provider 3, key fields 3, import 3 (TUI-DESIGN-5 §5.1), verify 2, trust 4 (2 below rows 12), save/sandbox/done 0; never more than 4. */
export function wizardRows(state: OnboardingState, rows: number): number {
  switch (state.step) {
    case 'key':
    case 'options':
    case 'jevProvider':
    case 'provider':
    case 'generatorKey':
    case 'jevKey':
      return 3;
    case 'import':
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
