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
import type { BlockingAnswer, EngineMode, SecretSettingName, SessionRow } from '../core/types.js';
import type { CredentialsPatch } from '../config/credentials.js';
import type { TrustInputs, TrustOption } from '../config/trust.js';
import type { PickerOpen, TuiRenderer, WizardHost, WizardSaveInput } from '../tui/index.js';
import type { WizardProvider } from '../tui/onboarding/reducer.js';
import { childCapUsd } from '../tui/budget/lines.js';
import type { UndoAskKey } from '../undo/plan.js';
import type { Prompter, WizardOutcome } from './session.js';

/** the controller hooks the wizard host bridge calls back into */
export interface TuiPrompterControls {
  /** `SessionController.persistCredentials` — addSecret first, then the 0600 write, then resolveConfig again */
  persistCredentials(patch: CredentialsPatch, source: 'wizard' | 'login'): Promise<{ ok: boolean; items: string[]; error?: string }>;
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

/** TUI-DESIGN §11.1 save: the wizard's typed values → the credentials patch (`reuseGeneratorForJev` copies the generator key) */
export function patchFromWizard(input: WizardSaveInput): CredentialsPatch {
  const patch: CredentialsPatch = {};
  if (input.provider !== null) patch.provider = input.provider;
  const gen = input.values['generator.apiKey'];
  const jev = input.values['decider.apiKey'];
  if (gen !== undefined && gen !== '') patch.apiKey = gen;
  if (jev !== undefined && jev !== '') patch.jevApiKey = jev;
  else if (input.reuseGeneratorForJev && patch.apiKey !== undefined) patch.jevApiKey = patch.apiKey;
  return patch;
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
    w?.({ kind: 'cancelled' });
    t?.(null);
  }

  const wizardHost: TuiWizardHost = {
    async save(input) {
      if (!controls) return { ok: false, reason: 'no session controller' };
      const r = await controls.persistCredentials(patchFromWizard(input), 'wizard');
      if (r.ok) {
        const w = pendingWizard;
        pendingWizard = null;
        w?.({ kind: 'persisted' });
      }
      return r.ok ? { ok: true, items: [] } : { ok: false, reason: r.error ?? 'could not save the key' };
    },
    trust(option) {
      const t = pendingTrust;
      pendingTrust = null;
      t?.(option);
    },
    cancel: () => cancelWizard(),
    sandboxLine: () => controls?.sandboxLine() ?? null,
    trustInputs: () => controls?.trustInputs() ?? null,
  };

  const prompter: Prompter = {
    wizard(missing: readonly SecretSettingName[], o: { provider: WizardProvider | null; reason: 'missing' | 'login' | 'rejected' }) {
      return new Promise<WizardOutcome>((resolve) => {
        const r = renderer;
        if (!r) {
          resolve({ kind: 'cancelled' });
          return;
        }
        pendingWizard?.({ kind: 'cancelled' });
        pendingWizard = resolve;
        if (o.reason === 'missing') r.openWizard({ missing, mode: controls?.mode() ?? 'jev-on', provider: o.provider, trustNeeded: false });
        // §11.1: Ctrl-C in a reopened wizard closes it when a run is live (`/login` mid-run, the 401 pane's `[l]`) and exits 2 otherwise
        else r.reopenWizard(missing.includes('generator.apiKey') ? 'generator.apiKey' : 'decider.apiKey', controls?.runLive() ?? false);
      });
    },
    trust(inputs: TrustInputs) {
      return new Promise<TrustOption | null>((resolve) => {
        const r = renderer;
        if (!r) {
          resolve(null);
          return;
        }
        pendingTrust?.(null);
        pendingTrust = resolve;
        void inputs;
        r.openWizard({ missing: [], mode: controls?.mode() ?? 'jev-on', provider: null, trustNeeded: true });
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
