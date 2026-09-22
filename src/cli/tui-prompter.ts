/**
 * The Ink renderer's modal prompts as a controller `Prompter` (TUI-DESIGN §0 one modal slot, §3.3, §8.4, §9.3,
 * §11.1, §12.4, §13.3): `createTuiPrompter` adapts O9's `TuiRenderer` surface (`confirmFollowUp`, `promptUndo`,
 * `confirmExit`, `blocking`, `openPicker`, `openWizard`) and its `WizardHost` (the wizard's `save` / `trust` callbacks)
 * to the `Prompter` the session controller awaits. The wizard host is needed before the renderer mounts, so the
 * bundle is created first and the renderer and controller are attached afterwards. Pure over the renderer methods:
 * every prompt is a promise the App resolves; nothing here touches the process.
 *
 * Every prompt is cancellable (§13.5 / F3): `cancelAll()` — called by the controller's `finishSession` — settles the
 * pending ones with their safe defaults so no controller await outlives the renderer. The wizard's close channel is the
 * host's `cancel()` (`WizardHost.cancel?`): the App calls it from `wizard.cancel()` (Ctrl-C — §11.1: with a run live the
 * wizard closes and the run continues, otherwise exit 2) and when the wizard reaches `done` without a save / trust answer,
 * so a pending `wizard()` resolves `cancelled` and a pending `trust()` resolves `null` at once (no overlay polling).
 */
import type { BlockingAnswer, EngineMode, JevProvider, SecretSettingName, SessionRow } from '../core/types.js';
import type { CredentialsPatch } from '../config/credentials.js';
import { DEFAULT_MODE } from '../config/defaults.js';
import type { TrustInputs, TrustOption } from '../config/trust.js';
import type { PickerOpen, TuiRenderer, WizardHost, WizardSaveInput } from '../tui/index.js';
import type { WizardModeChoice, WizardVerifyInput, WizardVerifyResult } from '../tui/onboarding/Wizard.js';
import type { FoundKey, FoundSource, WizardProvider } from '../tui/onboarding/reducer.js';
import { childCapUsd } from '../tui/budget/lines.js';
import type { UndoAskKey } from '../undo/plan.js';
import type { Prompter, WizardOutcome, WizardReason } from './session.js';
// TUI-DESIGN-2 §3.7: the ambiguity card's rows come from the one string source shared with `--plain` and the screen reader
import { INTAKE_CARD_BODY, intakeCardTitle, intakeRowLines } from '../chat/lines.js';
import type { IntakeOverlay } from '../tui/Overlay.js';

/** the controller hooks the wizard host bridge calls back into */
export interface TuiPrompterControls {
  /** `SessionController.persistCredentials` — addSecret first, then the 0600 write, then resolveConfig again */
  persistCredentials(patch: CredentialsPatch, source: 'wizard' | 'login', opts?: { reusedFrom?: FoundSource }): Promise<{ ok: boolean; items: string[]; error?: string }>;
  /** TUI-DESIGN-3 §1.4.1 (edges 11, 17): the layer the resolved Jev key came from (the reuse item names it) */
  resolvedJevSource?(): FoundSource | null;
  /** the engine mode of the next run (the wizard skips the generator key for jev-only) */
  mode(): EngineMode;
  /** the trust inputs of the current workspace (the wizard's trust step) */
  trustInputs(): TrustInputs | null;
  /** the `[sandbox]` line the wizard appends at its sandbox step */
  sandboxLine(): string | null;
  /** `<runsDir>` / `<jevcodeDir>/trash` for the picker's `x` then `y` */
  runsDir(): string | null;
  trashDir(): string | null;
  /** §11.1: a run is live — the reopened wizard's Ctrl-C closes it instead of exiting 2 */
  runLive(): boolean;
  /** TUI-DESIGN-3 §1.5: the wizard's `y` — one Jev decision, one 1-token completion, the key info; `items` are the `[setup]` texts, `rejected` the field to return to */
  verifyKeys?(input: WizardVerifyInput): Promise<WizardVerifyResult>;
  /** TUI-DESIGN-3 §1.4.3: option `3 Jev only` (or `2` + skip) — persist the mode row (a startup wizard) or pend it (`/login`); runs after the save when one follows */
  applyMode?(mode: EngineMode, persist: boolean): Promise<void>;
  /** TUI-DESIGN-3 §1.4.1 (edges 11, 17): the resolved Jev key's value for `reuseJevForGenerator` — read once at save time, never stored here */
  resolvedJevKey?(): string | null;
  /** TUI-DESIGN-3 §5.1 rule 13: the `[sandbox]` item's TUI-only detail body */
  sandboxDetail?(): string | null;
}

/** the wizard host the App receives; `cancel()` is required here (the App calls it from `wizard.cancel()` / a `done` without an answer) */
export interface TuiWizardHost extends WizardHost {
  /** the wizard closed without a save / trust answer: the pending prompt resolves `cancelled` / `null` */
  cancel(): void;
}

/**
 * §10.2 (F-V gate for an argv task on a TTY one-shot): the renderer method the prompter forwards to — `TuiRenderer.promptSecretGate`
 * (the row `Looks like this contains a secret (<label>). Send anyway? y/N`, §4.10). Kept as a named shape for the duck-typed check a
 * renderer built outside `createTuiRenderer` (tests, a future twin) goes through.
 */
export type SecretGateRenderer = Pick<TuiRenderer, 'promptSecretGate'>;

export function hasSecretGate(r: TuiRenderer | null): r is TuiRenderer & SecretGateRenderer {
  return r !== null && typeof (r as Partial<SecretGateRenderer>).promptSecretGate === 'function';
}

export interface TuiPrompterBundle {
  prompter: Prompter;
  wizardHost: TuiWizardHost;
  /** the renderer, once mounted */
  attach(renderer: TuiRenderer): void;
  /** the controller hooks, once created */
  control(c: TuiPrompterControls): void;
}

/** the newest run of a session row (the fold keeps runs in start order) */
function newestRunId(s: SessionRow): string | null {
  const r = s.runs[s.runs.length - 1];
  return r ? r.runId : null;
}

/**
 * TUI-DESIGN §11.1 save: the wizard's typed values → the credentials patch (`reuseGeneratorForJev` copies the generator key).
 * TUI-DESIGN-3 §1.4.3 — the save-shape table for the one-paste `key` field, keyed on what detect found (`keyAs`):
 *   both (nothing resolves)          → apiKey = jevApiKey = value, provider openrouter, jevProvider openrouter
 *   generator (TypeSafe / Jev found) → apiKey = value, provider openrouter — NEVER jevProvider / jevApiKey (a file `jevProvider` would move Jev off api.typesafe.ai at the next start)
 *   jev (Anthropic found)            → jevApiKey = value, jevProvider openrouter, provider anthropic — NEVER apiKey (GLM must not replace Anthropic silently)
 * `reuseJevForGenerator` copies the resolved Jev value (`jevKey`, read by the host at save time) into `apiKey` with `provider: openrouter`.
 */
export function patchFromWizard(input: WizardSaveInput, jevKey: string | null = null): CredentialsPatch {
  const patch: CredentialsPatch = {};
  if (input.provider !== null) patch.provider = input.provider;
  const gen = input.values['generator.apiKey'];
  const jev = input.values['decider.apiKey'];
  if (gen !== undefined && gen !== '') patch.apiKey = gen;
  if (jev !== undefined && jev !== '') patch.jevApiKey = jev;
  else if (input.reuseGeneratorForJev && patch.apiKey !== undefined) patch.jevApiKey = patch.apiKey;
  // TUI-DESIGN-2 §1.4 / §2.3: the Jev provider chosen on the jevProvider step is written beside the key (never inferred from a host)
  if (input.jevProvider !== null && input.jevProvider !== undefined) patch.jevProvider = input.jevProvider;
  const key = input.values['key'];
  if (key !== undefined && key !== '') {
    switch (input.keyAs) {
      case 'both':
        patch.apiKey = key;
        patch.jevApiKey = key;
        patch.provider = 'openrouter';
        patch.jevProvider = 'openrouter';
        break;
      case 'generator':
        patch.apiKey = key;
        patch.provider = 'openrouter';
        break;
      case 'jev':
        patch.jevApiKey = key;
        patch.jevProvider = 'openrouter';
        patch.provider = 'anthropic';
        break;
    }
  } else if (input.reuseJevForGenerator && jevKey !== null && jevKey !== '') {
    patch.apiKey = jevKey;
    patch.provider = 'openrouter';
  }
  return patch;
}

/** TUI-DESIGN-3 §1.3.2: both sides openrouter (or nothing resolves) and both keys asked → the one-paste `key` field on a reopen */
export function oneKeyReopen(missing: readonly SecretSettingName[], provider: WizardProvider | null, jevProvider: JevProvider | null | undefined, found: FoundKey | undefined): boolean {
  const both = missing.includes('generator.apiKey') && missing.includes('decider.apiKey');
  return both && (provider === null || provider === 'openrouter') && (jevProvider === null || jevProvider === undefined || jevProvider === 'openrouter') && (found === undefined || found === null);
}

/** §12.4: the App's undo answers → the plan's ask keys */
export function undoKeyOf(a: 'yes' | 'no' | 'all' | 'skipRest' | 'abort'): UndoAskKey {
  switch (a) {
    case 'yes':
      return 'y';
    case 'no':
      return 'n';
    case 'all':
      return 'a';
    case 'skipRest':
      return 's';
    case 'abort':
      return 'esc';
  }
}

export function createTuiPrompter(): TuiPrompterBundle {
  let renderer: TuiRenderer | null = null;
  let controls: TuiPrompterControls | null = null;
  let pendingWizard: ((o: WizardOutcome) => void) | null = null;
  let pendingTrust: ((o: TrustOption | null) => void) | null = null;
  /** TUI-DESIGN-3 §1.4.3: the options step's `3 Jev only` (or `2` + skip) for the wizard in flight; applied after a save, resolved at `done` without one */
  let modeChosen: WizardModeChoice | null = null;
  /** the cancel of every pending renderer prompt (follow-up, exit confirm, blocking, undo, picker, rewind) */
  const cancels = new Set<() => void>();

  /** a renderer promise that `cancelAll()` settles with `fallback` (the App never resolves it after the unmount) */
  function cancellable<T>(p: Promise<T>, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
      let done = false;
      const settle = (v: T): void => {
        if (done) return;
        done = true;
        cancels.delete(cancel);
        resolve(v);
      };
      const cancel = (): void => settle(fallback);
      cancels.add(cancel);
      p.then(settle, () => settle(fallback));
    });
  }

  /** the wizard closed without a save / trust answer (Ctrl-C with a run live, exit 2 with none, `done` with nothing answered) */
  function cancelWizard(): void {
    const w = pendingWizard;
    const t = pendingTrust;
    pendingWizard = null;
    pendingTrust = null;
    modeChosen = null;
    w?.({ kind: 'cancelled' });
    t?.(null);
  }

  const wizardHost: TuiWizardHost = {
    async save(input) {
      if (!controls) return { ok: false, reason: 'no session controller' };
      // TUI-DESIGN-3 §1.4.1 (edges 11, 17): the resolved Jev value is read only for the reuse Enter, at save time
      const jevKey = input.reuseJevForGenerator ? (controls.resolvedJevKey?.() ?? null) : null;
      const reusedFrom = input.reuseJevForGenerator && jevKey !== null ? (controls.resolvedJevSource?.() ?? 'env') : undefined;
      const r = await controls.persistCredentials(patchFromWizard(input, jevKey), 'wizard', reusedFrom !== undefined ? { reusedFrom } : {});
      if (r.ok) {
        // TUI-DESIGN-3 §1.4.3: a mode chosen on the options step (`3`, or `2` + skip; `wizardHost.mode` ran first) is applied after the key landed — persist at startup, pend from /login
        const chosen = modeChosen;
        modeChosen = null;
        if (chosen !== null) await controls.applyMode?.(chosen.mode, chosen.persist);
        const w = pendingWizard;
        pendingWizard = null;
        w?.({ kind: 'persisted' });
      }
      return r.ok ? { ok: true, items: [] } : { ok: false, reason: r.error ?? 'could not save the key' };
    },
    // TUI-DESIGN-3 §1.5: the controller verifies (it holds the resolved keys and the meter); no controller → nothing to verify
    verify: (i) => (controls?.verifyKeys ? controls.verifyKeys(i) : Promise.resolve({ ok: true, rejected: null, items: [] })),
    mode(choice) {
      modeChosen = choice;
    },
    done() {
      // TUI-DESIGN-3 §1.4.3: `done` after a mode choice with no save → the controller's runLogin persists / pends it (`{ kind: 'mode' }`)
      const w = pendingWizard;
      const chosen = modeChosen;
      pendingWizard = null;
      modeChosen = null;
      if (w !== null) w(chosen !== null ? { kind: 'mode', mode: chosen.mode, persist: chosen.persist } : { kind: 'cancelled' });
    },
    trust(option) {
      const t = pendingTrust;
      pendingTrust = null;
      t?.(option);
    },
    cancel: () => cancelWizard(),
    sandboxLine: () => controls?.sandboxLine() ?? null,
    sandboxDetail: () => controls?.sandboxDetail?.() ?? null,
    trustInputs: () => controls?.trustInputs() ?? null,
  };

  const prompter: Prompter = {
    wizard(missing: readonly SecretSettingName[], o: { provider: WizardProvider | null; reason: WizardReason; mode?: EngineMode; found?: FoundKey; foundSource?: FoundSource; foundReusable?: boolean; jevProvider?: JevProvider | null }) {
      return new Promise<WizardOutcome>((resolve) => {
        const r = renderer;
        if (!r) {
          resolve({ kind: 'cancelled' });
          return;
        }
        pendingWizard?.({ kind: 'cancelled' });
        pendingWizard = resolve;
        modeChosen = null;
        // TUI-DESIGN-3 §1.1: the fallback is DEFAULT_MODE; the missing-key wizard asks for what that mode needs, with the detect-time `found` hint (§1.4.3)
        const current = controls?.mode() ?? DEFAULT_MODE;
        const found = o.found !== undefined ? { found: o.found, ...(o.foundSource !== undefined ? { foundSource: o.foundSource } : {}) } : {};
        if (o.reason === 'missing') r.openWizard({ missing, mode: o.mode ?? current, provider: o.provider, trustNeeded: false, ...found, ...(o.foundReusable !== undefined ? { foundReusable: o.foundReusable } : {}) });
        // TUI-DESIGN-2 §1.3 / §1.4: `/mode <m>` without the keys `m` needs reopens for THAT mode; Ctrl-C closes it and keeps the session.
        // The step follows `missing`: a generator key → the provider step (reason `mode`); only the Jev key (`/mode jev-only` after
        // `/logout decider`) → the Jev key step — under reason `login`, because the reducer forces `provider` for reason `mode`
        // (S2's `case 'reopen'`; `cancel` keeps the session under `login` too, §1.4)
        else if (o.reason === 'mode') {
          const mode = o.mode ?? current;
          if (missing.includes('generator.apiKey')) r.reopenWizard('provider', controls?.runLive() ?? false, { reason: 'mode', mode, currentMode: current });
          else r.reopenWizard('decider.apiKey', controls?.runLive() ?? false, { reason: 'login', mode, currentMode: current });
        }
        // TUI-DESIGN-3 §1.3.2: both sides openrouter (a 401 on either, or `/login` with nothing else resolving) → the one-paste `key` field; the
        // detect with the reason opens it (the renderer's `reopenWizard` names the two secret fields only), `runLive` keeps Ctrl-C's rule
        else if (oneKeyReopen(missing, o.provider, o.jevProvider, o.found)) r.openWizard({ missing, mode: o.mode ?? current, provider: o.provider, trustNeeded: false, reason: o.reason === 'rejected' ? 'rejected' : 'login', runLive: controls?.runLive() ?? false, found: null });
        // §11.1: Ctrl-C in a reopened wizard closes it when a run is live (`/login` mid-run, the 401 pane's `[l]`) and exits 2 otherwise
        else r.reopenWizard(missing.includes('generator.apiKey') ? 'generator.apiKey' : 'decider.apiKey', controls?.runLive() ?? false, { reason: o.reason === 'rejected' ? 'rejected' : 'login', currentMode: current, ...found });
      });
    },
    // TUI-DESIGN-2 §3.7: the ambiguity card — the App answers `run` (y) · `chat` (n) · `keep` (Esc / Ctrl-C); no renderer or the unmount → keep (C46, never a run)
    intake(message) {
      const r = renderer;
      if (!r) return Promise.resolve('keep');
      const columns = prompter.columns?.() ?? 80;
      const card: IntakeOverlay = { title: intakeCardTitle(message, columns - 4), body: [INTAKE_CARD_BODY], flat: intakeRowLines(columns) };
      return cancellable(r.promptIntake(card), 'keep');
    },
    trust(inputs: TrustInputs, o?: { reopen?: boolean }) {
      return new Promise<TrustOption | null>((resolve) => {
        const r = renderer;
        if (!r) {
          resolve(null);
          return;
        }
        pendingTrust?.(null);
        pendingTrust = resolve;
        void inputs;
        // TUI-DESIGN-3 §4.4 F17: the card `/trust` reopens carries reason `trust` — Esc and Ctrl-C close it (null), nothing exits; the startup gate keeps today's rule
        r.openWizard({ missing: [], mode: controls?.mode() ?? DEFAULT_MODE, provider: null, trustNeeded: true, ...(o?.reopen === true ? { reason: 'trust' as const } : {}) });
      });
    },
    async followUp(box) {
      const r = renderer;
      if (!r) return 'n';
      const a = await cancellable(r.confirmFollowUp({ runCapUsd: box.runCapUsd, clampedToUsd: childCapUsd(box.runCapUsd, box.sessionCapUsd, box.sessionSpentUsd), sessionSpentUsd: box.sessionSpentUsd, sessionCapUsd: box.sessionCapUsd, runs: box.runs, lastRunUsd: box.lastRunUsd }), 'cancel');
      return a === 'start' ? 'y' : a === 'raise' ? 'r' : 'n';
    },
    exitConfirm: () => (renderer ? cancellable(renderer.confirmExit(), false) : Promise.resolve(false)),
    blocking: (req): Promise<BlockingAnswer> => (renderer ? cancellable(renderer.blocking(req), 'stop') : Promise.resolve('stop')),
    async undoAsk(ask) {
      const r = renderer;
      if (!r) return 'n';
      return undoKeyOf(await cancellable(r.promptUndo(ask.prompt), 'abort'));
    },
    // §10.2: `y` sends (addSecret + secretsAcked in the controller); a renderer without the row, a cancel or the unmount refuse
    secretGate: (hits) => (hasSecretGate(renderer) ? cancellable(renderer.promptSecretGate(hits), false) : Promise.resolve(false)),
    cancelAll() {
      for (const c of [...cancels]) c();
      cancelWizard();
    },
    picker(sessions, o) {
      return new Promise<{ runId: string } | null>((resolve) => {
        const r = renderer;
        if (!r) {
          resolve(null);
          return;
        }
        let done = false;
        const cancel = (): void => finish(null);
        const finish = (v: { runId: string } | null): void => {
          if (done) return;
          done = true;
          cancels.delete(cancel);
          resolve(v);
        };
        cancels.add(cancel);
        const open: PickerOpen = {
          kind: 'sessions',
          sessions,
          workspace: o.workspace,
          sort: o.sort,
          onOpen: (s) => {
            const id = newestRunId(s);
            finish(id === null ? null : { runId: id });
          },
          onClose: () => finish(null),
          ...(controls?.runsDir() ? { runsDir: controls.runsDir() as string } : {}),
          ...(controls?.trashDir() ? { trashDir: controls.trashDir() as string } : {}),
        };
        r.openPicker(open);
      });
    },
    rewind(steps) {
      return new Promise<number | null>((resolve) => {
        const r = renderer;
        if (!r) {
          resolve(null);
          return;
        }
        let done = false;
        const cancel = (): void => finish(null);
        const finish = (v: number | null): void => {
          if (done) return;
          done = true;
          cancels.delete(cancel);
          resolve(v);
        };
        cancels.add(cancel);
        r.openPicker({ kind: 'rewind', rewindSteps: steps, workspace: '', onRewind: (s) => finish(s.step), onClose: () => finish(null) });
      });
    },
    columns: () => (typeof process.stdout.columns === 'number' && process.stdout.columns > 0 ? process.stdout.columns : 80),
  };

  return {
    prompter,
    wizardHost,
    attach(r) {
      renderer = r;
    },
    control(c) {
      controls = c;
    },
  };
}
