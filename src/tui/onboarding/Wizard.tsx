/**
 * The onboarding / `/login` / `/mode` wizard (TUI-DESIGN §11.1, §11.2, F10, F-M, F-N, F-O, §24 "Wizard"; TUI-DESIGN-2 §1.4):
 * ≤ 4 rows in the overlay slot (the composer is refunded, D1; the boxed console hosts them under `setup · <step>`, §4.3),
 * rows from the pure `wizardLines(state, view)`, the masked field with its bytes in `useMaskedBytes` (never the reducer,
 * never a frame), digits pick (jev provider `1`/`2`, provider `1`/`2`, trust `1`/`2`/`3`), Enter submits / reuses the
 * OpenRouter key for Jev, Esc clears or steps back, Ctrl-C exits 2 only for a startup wizard with no run live (`/login`,
 * `/mode` and a live run close it instead — the reducer's `cancelCloses`). Saving runs through `WizardHost`
 * (the session controller's `writeCredentials` + `addSecret` FIRST, then the `[setup]` items); the reducer's
 * `save` step is transient. Keys are resolved by `resolveKey` in `<App>` (`wizard` actions).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { Box, Text } from 'ink';
import type { CursorPosition } from 'ink';
import type { EngineMode, JevProvider, SecretSettingName } from '../../core/types.js';
import type { TrustInputs } from '../../config/trust.js';
import type { KeyAction } from '../keys/resolve.js';
import { textProps, themeFor, type Theme } from '../theme.js';
import { MaskedField, useMaskedBytes } from './MaskedField.js';
import { wizardLines, type WizardView } from './lines.js';
import { HINT_PASTED_TWICE, INITIAL_ONBOARDING, expectedKeyProvider, isFieldStep, looksLikeKey, looksPastedTwice, onboardingReducer, wizardActive, wizardRows, type FoundKey, type FoundSource, type OnboardingAction, type OnboardingState, type SaveRequest, type TrustOption, type WizardField, type WizardOption, type WizardProvider, type WizardReason } from './reducer.js';

export type { FoundKey, FoundSource, OnboardingState, SaveRequest, TrustOption, WizardField, WizardProvider, WizardReason };

/**
 * TUI-DESIGN-3 §1.8 edge 1: the newline a pasted key ends with (`\r`, `\n` or `\r\n`) is the Enter that saves it.
 * `sanitizeKeyInput` strips it from the value, so the wizard must recognise it on the raw text of the paste.
 */
export const PASTED_NEWLINE_RE = /(?:\r\n|\r|\n)$/;

/**
 * TUI-DESIGN-2 §1.4: the optional third argument of `reopen` — `/mode jev-on` reopens at the provider step with the target mode;
 * `jevProvider` is the session's resolved Jev provider (§2.3; null = unresolved, the Jev key reopen asks the jevProvider step first).
 * TUI-DESIGN-3 §1.9 / §1.4.3: `currentMode` is what Ctrl-C keeps (the hint names it); `found` / `foundSource` the detect-time hint of a resolving key.
 */
export interface WizardReopenOptions {
  reason?: Exclude<WizardReason, 'missing'>;
  mode?: EngineMode;
  currentMode?: EngineMode;
  jevProvider?: JevProvider | null;
  found?: FoundKey;
  foundSource?: FoundSource;
}

export interface WizardSaveInput extends SaveRequest {
  /** the key bytes by field, read from the masked refs and forgotten afterwards */
  values: Readonly<Partial<Record<WizardField, string>>>;
}

export type WizardSaveResult = { ok: true; items: readonly string[] } | { ok: false; reason: string };
export type WizardVerifyResult = { ok: boolean; rejected: WizardField | null; items: readonly string[] };
/** TUI-DESIGN-3 §1.5: what the wizard's `y` hands the host — the providers, the fields typed here, the target mode, and the abort signal Ctrl-C chains (edge 5) */
export interface WizardVerifyInput {
  provider: WizardProvider | null;
  jevProvider: JevProvider | null;
  fields: readonly WizardField[];
  mode: EngineMode;
  signal?: AbortSignal;
}
/** TUI-DESIGN-3 §1.4.3: option `3 Jev only` — the host persists (a startup wizard) or pends (`/login`) the mode; no key is saved by it */
export interface WizardModeChoice {
  mode: EngineMode;
  persist: boolean;
}

/** What the session controller implements for the wizard (O10); every method is optional but `save`. */
export interface WizardHost {
  /** `addSecret` first, then the atomic 0600 write; returns the `[setup]` item texts to append */
  save(input: WizardSaveInput): Promise<WizardSaveResult>;
  /** the optional priced verification on an explicit `y` (TUI-DESIGN-2 §2.7 / TUI-DESIGN-3 §1.5: one decision, one 1-token completion, the key info) */
  verify?(input: WizardVerifyInput): Promise<WizardVerifyResult>;
  /** TUI-DESIGN-3 §1.4.3: the options step chose `3 Jev only` — called once, when the choice is confirmed */
  mode?(choice: WizardModeChoice): void;
  /** the trust decision */
  trust?(option: TrustOption): void;
  /** the sandbox line to append when the wizard reaches its sandbox step */
  sandboxLine?(): string | null;
  /** TUI-DESIGN-3 §5.1 rule 13: the `[sandbox]` item's TUI-only detail body */
  sandboxDetail?(): string | null;
  trustInputs?(): TrustInputs | null;
  /** the wizard closed without a save / trust answer (Ctrl-C, or `done` reached with nothing answered): the pending controller prompt resolves cancelled */
  cancel?(): void;
  /** TUI-DESIGN-3 §1.4.3: the wizard reached `done` (after every save / mode choice); the host settles whatever prompt is still pending */
  done?(): void;
}

export interface WizardDetect {
  missing: readonly SecretSettingName[];
  mode: EngineMode;
  provider: WizardProvider | null;
  /** TUI-DESIGN-2 §1.4: the Jev provider a §2.3 rule inferred (the jevProvider step is skipped); null / absent = ask */
  jevProvider?: JevProvider | null;
  /** TUI-DESIGN-2 §1.4: why the wizard opens (default `missing`) */
  reason?: WizardReason;
  trustNeeded: boolean;
  runLive?: boolean;
  /** TUI-DESIGN-3 §1.4.1: what already resolves (a source, never a value), where from, and whether it is an OpenRouter key worth reusing */
  found?: FoundKey;
  foundSource?: FoundSource;
  foundReusable?: boolean;
}

export interface WizardDeps {
  host: () => WizardHost | null;
  /** `[setup]` / `[sandbox]` items (renderer-local or `annotate()`d by the host); TUI-DESIGN-3 §5.1 rule 13: `detail` is the TUI-only body */
  onItem: (text: string, label: '[setup]' | '[sandbox]' | '[config]', detail?: string) => void;
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
  /** TUI-DESIGN-2 §1.4: `opts.reason === 'mode'` forces the provider step (the generator step in place) with `opts.mode` as the target */
  reopen(at: 'provider' | WizardField, runLive: boolean, opts?: WizardReopenOptions): void;
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
  /** a save or trust answer reached the host during this wizard (reset by start / reopen): `done` without one is a cancel (§11.1) */
  const answered = useRef(false);
  stateRef.current = state;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const busy = useRef(false);
  /** TUI-DESIGN-3 §1.4.3: the `3 Jev only` choice reached the host (once per wizard; reset by start / reopen) */
  const modeSent = useRef(false);
  /** TUI-DESIGN-3 §1.8 edge 5: the verify in flight — Ctrl-C aborts it (the key is kept, the wizard continues) */
  const verifyAbort = useRef<AbortController | null>(null);

  // the transient steps: save → host.save; verifying → host.verify; sandbox → item + sandbox-shown; done/exit → callbacks
  useEffect(() => {
    const s = state;
    const host = depsRef.current.host();
    // TUI-DESIGN-3 §1.4.3: option `3` confirmed — tell the host once (persist at startup, pend from /login); a save may still follow
    if (s.pendMode !== null && !modeSent.current) {
      modeSent.current = true;
      host?.mode?.({ mode: s.pendMode, persist: s.reason === 'missing' });
    }
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
            answered.current = true;
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
      const ac = new AbortController();
      verifyAbort.current = ac;
      const run = async (): Promise<void> => {
        if (host === null || host.verify === undefined) {
          dispatch({ type: 'verify-result', ok: true, rejected: null });
          return;
        }
        try {
          // TUI-DESIGN-3 §1.5: the host verifies for the wizard's target mode (`pendMode` over the detect's); Ctrl-C chains `signal`
          const r = await host.verify({ provider: s.provider, jevProvider: s.jevProvider, fields: s.entered, mode: s.pendMode ?? s.mode, signal: ac.signal });
          for (const item of r.items) depsRef.current.onItem(item, '[setup]');
          dispatch({ type: 'verify-result', ok: r.ok, rejected: r.rejected });
        } catch (e) {
          // edge 5 / 14: an abort or a network failure — `verification failed: <name>: <message> — the key was kept; fix it with /login`
          const short = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          depsRef.current.onItem(`verification failed: ${short} — the key was kept; fix it with /login`, '[setup]');
          dispatch({ type: 'verify-result', ok: false, rejected: null });
        }
      };
      void run().finally(() => {
        busy.current = false;
        if (verifyAbort.current === ac) verifyAbort.current = null;
      });
      return;
    }
    if (s.step === 'sandbox') {
      const line = host?.sandboxLine?.() ?? null;
      if (line !== null) {
        const detail = host?.sandboxDetail?.() ?? null;
        if (detail !== null) depsRef.current.onItem(line, '[sandbox]', detail);
        else depsRef.current.onItem(line, '[sandbox]');
      }
      dispatch({ type: 'sandbox-shown' });
      return;
    }
    if (s.step === 'done') {
      bytes.wipe();
      // §11.1: `done` reached with no save / trust / mode answer (Ctrl-C with a run live, nothing to ask) closes the controller's prompt;
      // TUI-DESIGN-3 §1.4.3: after a mode choice with no save the host resolves `{ kind: 'mode' }` through `done()`
      if (!answered.current && !modeSent.current) depsRef.current.host()?.cancel?.();
      else depsRef.current.host()?.done?.();
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
      /**
       * TUI-DESIGN-3 §1.8 edge 1: Enter on a field reads the length from the BUFFER, never from `stateRef.current`.
       * One `useInput` delivery carries several keys (`splitInputChunk`: a pasted key and the CR it ended with are
       * two events applied in one React batch), so the snapshot still holds the length from before the chunk — a
       * pasted `sk-or-…\r` dispatched `enter` with length 0 and the wizard answered `key too short` on a full field.
       * The reducer's own state is in order (its queued `length` action runs first); only this closure is stale.
       */
      const submitField = (f: WizardField): void => {
        const len = bytes.length(f);
        if (s.hint !== null && /rejected/.test(s.hint) && len === 0) {
          dispatch({ type: 'keep' });
          return;
        }
        // TUI-DESIGN-3 §1.8 edge 2: `sk-or-` twice in the buffer — warn once (pure: no bytes reach the reducer); Enter again keeps it
        if (s.step === 'key' && s.hint !== HINT_PASTED_TWICE && looksPastedTwice(bytes.peek(f))) {
          dispatch({ type: 'pasted-twice' });
          return;
        }
        // TUI-DESIGN-2 §1.4 / §2.3: the Jev step is checked against the Jev provider's key shape (typesafe: every shape passes), the generator step against the generator's
        dispatch({ type: 'enter', length: len, prefixOk: looksLikeKey(bytes.peek(f), expectedKeyProvider(s)) });
      };
      switch (action.op) {
        case 'input': {
          const text = action.text ?? '';
          if (field !== null) {
            const len = bytes.append(field, text);
            depsRef.current.onMaskedKey?.(1);
            dispatch({ type: 'length', length: len });
            // TUI-DESIGN-3 §1.8 edge 1: a paste that carries its own newline (a bracketed paste, or a terminal without
            // 2004 whose chunk kept an interior newline) saves the clean key — `sanitizeKeyInput` dropped the byte, so
            // the Enter it stood for has to come from here; every other control character is stripped, never a key.
            if (PASTED_NEWLINE_RE.test(text)) submitField(field);
            return;
          }
          const ch = text.trim();
          // TUI-DESIGN-3 §1.4.1: a digit highlights an option (the same digit again confirms); the reducer owns the rule
          if (s.step === 'options' && /^[1-4]$/.test(ch)) dispatch({ type: 'choose', option: Number(ch) as WizardOption });
          else if ((s.step === 'provider' || s.step === 'jevProvider') && (ch === '1' || ch === '2')) dispatch({ type: 'choose', option: ch === '1' ? 1 : 2 });
          else if (s.step === 'verify' && (ch === 'y' || ch === 'Y')) dispatch({ type: 'verify-answer', yes: true });
          else if (s.step === 'verify' && (ch === 'n' || ch === 'N')) dispatch({ type: 'verify-answer', yes: false });
          else if (s.step === 'trust' && (ch === '1' || ch === '2' || ch === '3')) {
            const option = Number(ch) as TrustOption;
            answered.current = true;
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
          // edge 9: Esc with text clears the buffer — the live length, so a paste and the Esc of one chunk agree with the reducer
          if (field !== null && bytes.length(field) > 0) bytes.clear(field);
          dispatch({ type: 'escape' });
          return;
        case 'submit':
          if (field !== null) {
            submitField(field);
            return;
          }
          if (s.step === 'provider' || s.step === 'jevProvider' || s.step === 'options') dispatch({ type: 'choose', option: 'enter' });
          // TUI-DESIGN-3 §1.4.1: Enter at `verify` = `n` (Esc too, through `back` → the reducer's `escape`)
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
        // TUI-DESIGN-2 §1.4: a wizard opened by a missing key at startup exits 2 — the `exit` step keeps the setup console on
        // screen until the unmount, so no idle console (`╭─ jev-only`, the task placeholder) is drawn on the way out
        return wizardActive(stateRef.current) || stateRef.current.step === 'verify' || stateRef.current.step === 'trust' || stateRef.current.step === 'sandbox' || stateRef.current.step === 'exit';
      },
      rows: (terminalRows) => wizardRows(stateRef.current, terminalRows),
      start: (d) => {
        answered.current = false;
        modeSent.current = false;
        dispatch({
          type: 'detect',
          missing: d.missing,
          mode: d.mode,
          provider: d.provider,
          trustNeeded: d.trustNeeded,
          ...(d.jevProvider !== undefined ? { jevProvider: d.jevProvider } : {}),
          ...(d.reason !== undefined ? { reason: d.reason } : {}),
          ...(d.runLive !== undefined ? { runLive: d.runLive } : {}),
          ...(d.found !== undefined ? { found: d.found } : {}),
          ...(d.foundSource !== undefined ? { foundSource: d.foundSource } : {}),
          ...(d.foundReusable !== undefined ? { foundReusable: d.foundReusable } : {}),
        });
      },
      reopen: (at, runLive, opts) => {
        answered.current = false;
        modeSent.current = false;
        dispatch({
          type: 'reopen',
          at,
          runLive,
          ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
          ...(opts?.mode !== undefined ? { mode: opts.mode } : {}),
          ...(opts?.currentMode !== undefined ? { currentMode: opts.currentMode } : {}),
          ...(opts?.jevProvider !== undefined ? { jevProvider: opts.jevProvider } : {}),
          ...(opts?.found !== undefined ? { found: opts.found } : {}),
          ...(opts?.foundSource !== undefined ? { foundSource: opts.foundSource } : {}),
        });
      },
      apply,
      cancel: () => {
        // TUI-DESIGN-3 §1.8 edge 5: Ctrl-C while verifying aborts the verification only — the key is kept, the wizard continues
        const inFlight = verifyAbort.current;
        if (stateRef.current.step === 'verify' && stateRef.current.verifying && inFlight !== null) {
          verifyAbort.current = null;
          inFlight.abort(new DOMException('verification cancelled', 'AbortError'));
          return;
        }
        bytes.wipe();
        // §11.1: the controller's pending prompt resolves cancelled at once (no overlay watch needed); the reducer then exits 2 or closes
        if (!answered.current) depsRef.current.host()?.cancel?.();
        answered.current = true;
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
  /** TUI-DESIGN-2 §4.3: the prompt glyph of the masked row (`glyphs.prompt`, `› ` inside the boxed console); default `> ` */
  prompt?: string;
}

/** §11.1 / F-M / F-N / F-O: the wizard rows; the masked field row places the cursor. */
export function Wizard(p: WizardProps): React.JSX.Element | null {
  const rows = Math.max(0, Math.floor(p.rows));
  if (rows === 0) return null;
  const view: WizardView = { rows: p.rows, columns: p.columns, ...(p.ascii !== undefined ? { ascii: p.ascii } : {}), ...(p.screenReader !== undefined ? { screenReader: p.screenReader } : {}), ...(p.trust ? { trust: p.trust } : {}), ...(p.prompt !== undefined ? { prompt: p.prompt } : {}) };
  const lines = wizardLines(p.state, view).slice(0, rows);
  const theme = p.theme ?? themeFor('dark');
  const color = p.color ?? true;
  // TUI-DESIGN-3 §1.4.3: the one predicate both renderers read (Console.tsx's boxed row and this flat-tier row cannot drift)
  const fieldRow = isFieldStep(p.state.step) && !p.screenReader ? 1 : -1;
  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      {lines.map((line, i) =>
        i === fieldRow ? (
          <MaskedField key={`w${i}`} length={p.state.length} columns={p.columns} top={p.top + i} {...(p.cursor ? { cursor: p.cursor } : {})} {...(p.ascii !== undefined ? { ascii: p.ascii } : {})} {...(p.prompt !== undefined ? { prompt: p.prompt } : {})} />
        ) : (
          <Text key={`w${i}`} wrap="truncate" {...(i === 0 ? { bold: true } : i === lines.length - 1 && p.state.hint !== null ? textProps(theme, 'warn', color) : textProps(theme, 'dim', color))}>
            {line}
          </Text>
        ),
      )}
    </Box>
  );
}
