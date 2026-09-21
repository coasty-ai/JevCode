/**
 * The onboarding / `/login` wizard (TUI-DESIGN §11.1, §11.2, F10, F-M, F-N, F-O, §24 "Wizard"): ≤ 4 rows in the
 * overlay slot (the composer is refunded, D1), rows from the pure `wizardLines(state, view)`, the masked field
 * with its bytes in `useMaskedBytes` (never the reducer, never a frame), digits pick (provider `1`/`2`, trust
 * `1`/`2`/`3`), Enter submits / reuses the OpenRouter key for Jev, Esc clears or steps back, Ctrl-C exits 2 only
 * when no run exists (`/login` mid-run closes the wizard, judge-safety E5). Saving runs through `WizardHost`
 * (the session controller's `writeCredentials` + `addSecret` FIRST, then the `[setup]` items); the reducer's
 * `save` step is transient. Keys are resolved by `resolveKey` in `<App>` (`wizard` actions).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { Box, Text } from 'ink';
import type { CursorPosition } from 'ink';
import type { EngineMode, SecretSettingName } from '../../core/types.js';
import type { TrustInputs } from '../../config/trust.js';
import type { KeyAction } from '../keys/resolve.js';
import { textProps, themeFor, type Theme } from '../theme.js';
import { MaskedField, useMaskedBytes } from './MaskedField.js';
import { wizardLines, type WizardView } from './lines.js';
import { INITIAL_ONBOARDING, looksLikeKey, onboardingReducer, wizardActive, wizardRows, type OnboardingAction, type OnboardingState, type SaveRequest, type TrustOption, type WizardField, type WizardProvider } from './reducer.js';

export type { OnboardingState, SaveRequest, TrustOption, WizardField, WizardProvider };

export interface WizardSaveInput extends SaveRequest {
  /** the key bytes by field, read from the masked refs and forgotten afterwards */
  values: Readonly<Partial<Record<WizardField, string>>>;
}

export type WizardSaveResult = { ok: true; items: readonly string[] } | { ok: false; reason: string };
export type WizardVerifyResult = { ok: boolean; rejected: WizardField | null; items: readonly string[] };

/** What the session controller implements for the wizard (O10); every method is optional but `save`. */
export interface WizardHost {
  /** `addSecret` first, then the atomic 0600 write; returns the `[setup]` item texts to append */
  save(input: WizardSaveInput): Promise<WizardSaveResult>;
  /** the optional priced verification on an explicit `y` */
  verify?(input: { provider: WizardProvider | null; fields: readonly WizardField[] }): Promise<WizardVerifyResult>;
  /** the trust decision */
  trust?(option: TrustOption): void;
  /** the sandbox line to append when the wizard reaches its sandbox step */
  sandboxLine?(): string | null;
  trustInputs?(): TrustInputs | null;
}

export interface WizardDetect {
  missing: readonly SecretSettingName[];
  mode: EngineMode;
  provider: WizardProvider | null;
  trustNeeded: boolean;
  runLive?: boolean;
}

export interface WizardDeps {
  host: () => WizardHost | null;
  /** `[setup]` / `[sandbox]` items (renderer-local or `annotate()`d by the host) */
  onItem: (text: string, label: '[setup]' | '[sandbox]' | '[config]') => void;
  onDone: () => void;
  /** Ctrl-C with no run: the controller prints the fix block after unmount and exits 2 */
  onExit: (code: number) => void;
  /** key-class trace (`key masked len=1`) */
  onMaskedKey?: (len: number) => void;
}

export interface WizardController {
  readonly state: OnboardingState;
  readonly active: boolean;
  /** rows wanted in the overlay slot for the terminal height */
  rows(terminalRows: number): number;
  start(detect: WizardDetect): void;
  reopen(at: 'provider' | WizardField, runLive: boolean): void;
  apply(action: Extract<KeyAction, { type: 'wizard' }>): void;
  /** Ctrl-C: exit 2 with no run, close mid-run */
  cancel(): void;
  dispatch(action: OnboardingAction): void;
}

/** §11.1: the wizard hook — reducer + masked bytes + the host round trips (save, verify, sandbox line). */
export function useWizard(deps: WizardDeps): WizardController {
  const [state, dispatch] = useReducer(onboardingReducer, INITIAL_ONBOARDING);
  const bytes = useMaskedBytes();
  const stateRef = useRef(state);
  stateRef.current = state;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const busy = useRef(false);

  // the transient steps: save → host.save; verifying → host.verify; sandbox → item + sandbox-shown; done/exit → callbacks
  useEffect(() => {
    const s = state;
    const host = depsRef.current.host();
    if (s.step === 'save' && s.save !== null && !busy.current) {
      busy.current = true;
      const values: Partial<Record<WizardField, string>> = {};
      for (const f of s.save.fields) values[f] = bytes.take(f);
      const req = s.save;
      const run = async (): Promise<void> => {
        if (host === null) {
          dispatch({ type: 'save-failed', reason: 'no session host to save the key' });
          return;
        }
        try {
          const r = await host.save({ ...req, values });
          if (r.ok) {
            for (const item of r.items) depsRef.current.onItem(item, '[setup]');
            dispatch({ type: 'saved' });
          } else dispatch({ type: 'save-failed', reason: r.reason });
        } catch (e) {
          dispatch({ type: 'save-failed', reason: e instanceof Error ? e.message : String(e) });
        }
      };
      void run().finally(() => {
        busy.current = false;
      });
      return;
    }
    if (s.step === 'verify' && s.verifying && !busy.current) {
      busy.current = true;
      const run = async (): Promise<void> => {
        if (host === null || host.verify === undefined) {
          dispatch({ type: 'verify-result', ok: true, rejected: null });
          return;
        }
        try {
          const r = await host.verify({ provider: s.provider, fields: s.entered });
          for (const item of r.items) depsRef.current.onItem(item, '[setup]');
          dispatch({ type: 'verify-result', ok: r.ok, rejected: r.rejected });
        } catch (e) {
          depsRef.current.onItem(`verification failed: ${e instanceof Error ? e.message : String(e)} — the key was kept; fix it with /login`, '[setup]');
          dispatch({ type: 'verify-result', ok: false, rejected: null });
        }
      };
      void run().finally(() => {
        busy.current = false;
      });
      return;
    }
    if (s.step === 'sandbox') {
      const line = host?.sandboxLine?.() ?? null;
      if (line !== null) depsRef.current.onItem(line, '[sandbox]');
      dispatch({ type: 'sandbox-shown' });
      return;
    }
    if (s.step === 'done') {
      bytes.wipe();
      depsRef.current.onDone();
      return;
    }
    if (s.step === 'exit') {
      bytes.wipe();
      depsRef.current.onExit(s.exitCode ?? 2);
    }
  }, [state, bytes]);

  const apply = useCallback(
    (action: Extract<KeyAction, { type: 'wizard' }>): void => {
      const s = stateRef.current;
      const field = s.field;
      switch (action.op) {
        case 'input': {
          const text = action.text ?? '';
          if (field !== null) {
            const len = bytes.append(field, text);
            depsRef.current.onMaskedKey?.(1);
            dispatch({ type: 'length', length: len });
            return;
          }
          const ch = text.trim();
          if (s.step === 'provider' && (ch === '1' || ch === '2')) dispatch({ type: 'choose', option: ch === '1' ? 1 : 2 });
          else if (s.step === 'verify' && (ch === 'y' || ch === 'Y')) dispatch({ type: 'verify-answer', yes: true });
          else if (s.step === 'verify' && (ch === 'n' || ch === 'N')) dispatch({ type: 'verify-answer', yes: false });
          else if (s.step === 'trust' && (ch === '1' || ch === '2' || ch === '3')) {
            const option = Number(ch) as TrustOption;
            depsRef.current.host()?.trust?.(option);
            dispatch({ type: 'trust', option });
          }
          return;
        }
        case 'backspace':
          if (field !== null) dispatch({ type: 'length', length: bytes.backspace(field) });
          return;
        case 'clear':
          if (field !== null) {
            bytes.clear(field);
            dispatch({ type: 'clear' });
          }
          return;
        case 'back':
          if (field !== null && s.length > 0) bytes.clear(field);
          dispatch({ type: 'escape' });
          return;
        case 'submit':
          if (field !== null) {
            if (s.hint !== null && /rejected/.test(s.hint) && s.length === 0) {
              dispatch({ type: 'keep' });
              return;
            }
            dispatch({ type: 'enter', length: s.length, prefixOk: looksLikeKey(bytes.peek(field), s.provider) });
            return;
          }
          if (s.step === 'provider') dispatch({ type: 'choose', option: 'enter' });
          else if (s.step === 'verify' && !s.verifying) dispatch({ type: 'verify-answer', yes: false });
          return;
      }
    },
    [bytes],
  );

  return useMemo<WizardController>(
    () => ({
      get state() {
        return stateRef.current;
      },
      get active() {
        return wizardActive(stateRef.current) || stateRef.current.step === 'verify' || stateRef.current.step === 'trust' || stateRef.current.step === 'sandbox';
      },
      rows: (terminalRows) => wizardRows(stateRef.current, terminalRows),
      start: (d) => dispatch({ type: 'detect', missing: d.missing, mode: d.mode, provider: d.provider, trustNeeded: d.trustNeeded, ...(d.runLive !== undefined ? { runLive: d.runLive } : {}) }),
      reopen: (at, runLive) => dispatch({ type: 'reopen', at, runLive }),
      apply,
      cancel: () => {
        bytes.wipe();
        dispatch({ type: 'cancel' });
      },
      dispatch,
    }),
    [apply, bytes],
  );
}

export interface WizardProps {
  state: OnboardingState;
  rows: number;
  columns: number;
  /** the row the overlay starts on inside the dynamic region */
  top: number;
  cursor?: (pos: CursorPosition | undefined) => void;
  ascii?: boolean;
  screenReader?: boolean;
  trust?: TrustInputs | null;
  theme?: Theme;
  color?: boolean;
}

/** §11.1 / F-M / F-N / F-O: the wizard rows; the masked field row places the cursor. */
export function Wizard(p: WizardProps): React.JSX.Element | null {
  const rows = Math.max(0, Math.floor(p.rows));
  if (rows === 0) return null;
  const view: WizardView = { rows: p.rows, columns: p.columns, ...(p.ascii !== undefined ? { ascii: p.ascii } : {}), ...(p.screenReader !== undefined ? { screenReader: p.screenReader } : {}), ...(p.trust ? { trust: p.trust } : {}) };
  const lines = wizardLines(p.state, view).slice(0, rows);
  const theme = p.theme ?? themeFor('dark');
  const color = p.color ?? true;
  const fieldRow = (p.state.step === 'generatorKey' || p.state.step === 'jevKey') && !p.screenReader ? 1 : -1;
  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      {lines.map((line, i) =>
        i === fieldRow ? (
          <MaskedField key={`w${i}`} length={p.state.length} columns={p.columns} top={p.top + i} {...(p.cursor ? { cursor: p.cursor } : {})} {...(p.ascii !== undefined ? { ascii: p.ascii } : {})} />
        ) : (
          <Text key={`w${i}`} wrap="truncate" {...(i === 0 ? { bold: true } : i === lines.length - 1 && p.state.hint !== null ? textProps(theme, 'warn', color) : textProps(theme, 'dim', color))}>
            {line}
          </Text>
        ),
      )}
    </Box>
  );
}
