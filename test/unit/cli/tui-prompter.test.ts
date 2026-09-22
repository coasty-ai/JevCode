/**
 * TUI-DESIGN §15 item 16 (the renderer ↔ controller seam) / §19.0: `createTuiPrompter` adapts O9's `TuiRenderer`
 * prompts to the controller's `Prompter` — follow-up (`start`/`raise`/`cancel` → y/r/n), exit confirm, blocking,
 * undo (`yes`/`no`/`all`/`skipRest`/`abort` → y/n/a/s/esc), picker (Enter on a row → its newest run; Esc → null),
 * rewind, and the wizard round trip (`openWizard` → the App calls `wizardHost.save` → `persistCredentials` →
 * `{ kind: 'persisted' }`), plus the trust step through `wizardHost.trust`; `reopenWizard`'s `runLive` flag comes from
 * the controller (§11.1), the wizard settles `cancelled` through `wizardHost.cancel()` (the App's close channel), and
 * `cancelAll()` settles every pending prompt with its safe default (§13.5 / F3).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlockingRequest, SessionRow } from '../../../src/core/types.js';
import type { OverlayKind, PickerOpen, TuiRenderer, UiState, WizardDetect } from '../../../src/tui/index.js';
import type { IntakeOverlay } from '../../../src/tui/Overlay.js';
import { INTAKE_CARD_BODY, INTAKE_ROW_MEDIUM } from '../../../src/chat/lines.js';
import { createTuiPrompter, hasSecretGate, oneKeyReopen, patchFromWizard, undoKeyOf, type SecretGateRenderer, type TuiPrompterControls } from '../../../src/cli/tui-prompter.js';
import { DEFAULT_MODE } from '../../../src/config/defaults.js';
import type { WizardSaveInput } from '../../../src/tui/onboarding/Wizard.js';
import type { SaveRequest } from '../../../src/tui/onboarding/reducer.js';
import { detectSecrets } from '../../../src/core/redact.js';
import { mkConfirmRequest } from '../../fixtures/tui/fixtures.js';

interface Fake {
  renderer: TuiRenderer;
  calls: string[];
  lastPicker: PickerOpen | null;
  lastWizard: WizardDetect | null;
  followUpAnswer: 'start' | 'raise' | 'cancel';
  undoAnswer: 'yes' | 'no' | 'all' | 'skipRest' | 'abort';
  /** what `state().overlay` reports (null = no state yet) */
  overlay: OverlayKind | null;
  /** TUI-DESIGN-2 §3.7: the last intake card the App was asked to show, and the answer it gives */
  lastIntake: IntakeOverlay | null;
  intakeAnswer: 'run' | 'chat' | 'keep';
  /** renderer promises that never settle (the App unmounted) */
  hang: boolean;
  gateAnswer: boolean;
}

const controls = (o: Partial<TuiPrompterControls> = {}): TuiPrompterControls => ({ persistCredentials: async () => ({ ok: true, items: [] }), mode: () => 'jev-on', trustInputs: () => null, sandboxLine: () => null, runsDir: () => null, trashDir: () => null, runLive: () => false, ...o });
/** TUI-DESIGN-3 §1.4.1: a save input with the round-3 members at their round-2-flow values */
const save = (o: Pick<SaveRequest, 'provider' | 'jevProvider' | 'fields' | 'reuseGeneratorForJev'> & Partial<SaveRequest> & { values: WizardSaveInput['values'] }): WizardSaveInput => ({ oneKey: false, keyAs: 'both', reuseJevForGenerator: false, pendMode: null, ...o });

function fakeTui(): Fake {
  const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);
  const f: Fake = {
    calls: [],
    lastPicker: null,
    lastWizard: null,
    followUpAnswer: 'start',
    undoAnswer: 'yes',
    overlay: null,
    lastIntake: null,
    intakeAnswer: 'chat',
    hang: false,
    gateAnswer: true,
    renderer: {
      confirmer: { identity: 'x', confirm: () => Promise.resolve(false) },
      attach: () => undefined,
      firstFrame: () => Promise.resolve(),
      unmount: () => Promise.resolve(),
      setHost: () => undefined,
      setUi: () => undefined,
      notify: () => undefined,
      dispatch: () => undefined,
      state: () => (f.overlay === null ? null : ({ overlay: f.overlay } as unknown as UiState)),
      openWizard: (d) => {
        f.calls.push('openWizard');
        f.lastWizard = d;
      },
      reopenWizard: (at, runLive, opts) => {
        f.calls.push(`reopenWizard:${at}:${runLive ? 'live' : 'idle'}${opts ? `:${opts.reason ?? '-'}:${opts.mode ?? '-'}` : ''}`);
      },
      promptIntake: (card) => {
        f.calls.push('promptIntake');
        f.lastIntake = card;
        return f.hang ? never() : Promise.resolve(f.intakeAnswer);
      },
      restoreDraft: () => undefined,
      live: () => undefined,
      openPicker: (o) => {
        f.calls.push(`openPicker:${o.kind}`);
        f.lastPicker = o;
      },
      confirmFollowUp: () => {
        f.calls.push('confirmFollowUp');
        return f.hang ? never() : Promise.resolve(f.followUpAnswer);
      },
      promptUndo: () => (f.hang ? never() : Promise.resolve(f.undoAnswer)),
      confirmExit: () => {
        f.calls.push('confirmExit');
        return f.hang ? never() : Promise.resolve(true);
      },
      blocking: () => (f.hang ? never() : Promise.resolve('retry')),
      setSessionSpend: () => undefined,
      setGitDirs: () => undefined,
      setTitle: () => undefined,
      promptSecretGate: () => {
        f.calls.push('promptSecretGate');
        return f.hang ? never() : Promise.resolve(f.gateAnswer);
      },
    },
  };
  return f;
}

const row = (id: string, runs: string[]): SessionRow => ({ sessionId: id, workspace: '/w', title: id, task60: id, runs: runs.map((r) => ({ runId: r, parentRunId: null, startedAt: '2026-09-20T14:00:00.000Z', endedAt: null, stopReason: 'complete', steps: 1, costUsd: null, exitCode: 0, resumable: false, resumes: 0, live: false })), lastUsed: '2026-09-20T14:00:00.000Z', createdAt: '2026-09-20T14:00:00.000Z', totalUsd: 0, mode: 'jev-on', branch: null });

afterEach(() => {
  vi.useRealTimers();
});

describe('createTuiPrompter', () => {
  it('maps the follow-up box, exit confirm, blocking and undo answers', async () => {
    const f = fakeTui();
    const b = createTuiPrompter();
    b.attach(f.renderer);
    expect(await b.prompter.followUp!({ runCapUsd: 2, sessionCapUsd: 10, sessionSpentUsd: 9, runs: 3, lastRunUsd: 1 })).toBe('y');
    f.followUpAnswer = 'raise';
    expect(await b.prompter.followUp!({ runCapUsd: 2, sessionCapUsd: 10, sessionSpentUsd: 9, runs: 3, lastRunUsd: 1 })).toBe('r');
    f.followUpAnswer = 'cancel';
    expect(await b.prompter.followUp!({ runCapUsd: 2, sessionCapUsd: 10, sessionSpentUsd: 9, runs: 3, lastRunUsd: 1 })).toBe('n');
    expect(await b.prompter.exitConfirm!()).toBe(true);
    const req: BlockingRequest = { id: 'b', step: 1, kind: 'jev-unreachable', detail: '', stop: 'error', exitCode: 5 };
    expect(await b.prompter.blocking!(req)).toBe('retry');
    f.undoAnswer = 'skipRest';
    expect(await b.prompter.undoAsk!({ kind: 'ask', path: 'a', via: 'pre-image', prompt: 'p', expected: { exists: true, sha256: null } }, { index: 0, total: 1 })).toBe('s');
    expect(['yes', 'no', 'all', 'skipRest', 'abort'].map((a) => undoKeyOf(a as 'yes'))).toEqual(['y', 'n', 'a', 's', 'esc']);
    void mkConfirmRequest;
  });

  it('without a renderer every prompt takes its safe default', async () => {
    const b = createTuiPrompter();
    expect(await b.prompter.followUp!({ runCapUsd: 2, sessionCapUsd: 10, sessionSpentUsd: 9, runs: 3, lastRunUsd: 1 })).toBe('n');
    expect(await b.prompter.exitConfirm!()).toBe(false);
    expect(await b.prompter.picker!([], { sort: 'updated', workspace: '/w' })).toBeNull();
    expect(await b.prompter.wizard!(['decider.apiKey'], { provider: null, reason: 'missing' })).toEqual({ kind: 'cancelled' });
    expect(await b.prompter.trust!({ root: '/w', agents: null, dotenv: null, jevcodeJson: null })).toBeNull();
  });

  it('picker: Enter on a row resolves its newest run, Esc resolves null; the rewind picker resolves the step', async () => {
    const f = fakeTui();
    const b = createTuiPrompter();
    b.attach(f.renderer);
    b.control(controls({ runsDir: () => '/runs', trashDir: () => '/trash' }));
    const p = b.prompter.picker!([row('S1', ['R1', 'R2'])], { sort: 'created', workspace: '/w' });
    expect(f.lastPicker).toMatchObject({ kind: 'sessions', sort: 'created', runsDir: '/runs', trashDir: '/trash' });
    f.lastPicker!.onOpen!(row('S1', ['R1', 'R2']));
    expect(await p).toEqual({ runId: 'R2' });
    const p2 = b.prompter.picker!([], { sort: 'updated', workspace: '/w' });
    f.lastPicker!.onClose!();
    expect(await p2).toBeNull();
    const r = b.prompter.rewind!([{ step: 3, changedFiles: ['a'] }]);
    expect(f.lastPicker?.kind).toBe('rewind');
    f.lastPicker!.onRewind!({ step: 3, changedFiles: ['a'] });
    expect(await r).toBe(3);
  });

  it('wizard: openWizard for a missing key; the App saves through the host → persistCredentials → persisted; reopen for /login', async () => {
    const f = fakeTui();
    const b = createTuiPrompter();
    b.attach(f.renderer);
    const saved: unknown[] = [];
    b.control(
      controls({
        persistCredentials: async (patch, source) => {
          saved.push({ patch, source });
          return { ok: true, items: ['saved x'] };
        },
        mode: () => 'jev-only',
        sandboxLine: () => 'seatbelt — x',
      }),
    );
    const w = b.prompter.wizard!(['decider.apiKey'], { provider: 'openrouter', reason: 'missing' });
    expect(f.lastWizard).toEqual({ missing: ['decider.apiKey'], mode: 'jev-only', provider: 'openrouter', trustNeeded: false });
    const r = await b.wizardHost.save(save({ provider: 'openrouter', jevProvider: null, fields: ['decider.apiKey'], reuseGeneratorForJev: false, values: { 'decider.apiKey': 'sk-or-v1-abcdefghijklmnop' } }));
    expect(r).toEqual({ ok: true, items: [] });
    expect(saved).toEqual([{ patch: { provider: 'openrouter', jevApiKey: 'sk-or-v1-abcdefghijklmnop' }, source: 'wizard' }]);
    expect(await w).toEqual({ kind: 'persisted' });
    expect(b.wizardHost.sandboxLine?.()).toBe('seatbelt — x');
    // TUI-DESIGN-3 §1.3.2: `/login` with both keys asked and nothing resolving → the one-paste `key` field through a detect with the reason (both sides openrouter)
    void b.prompter.wizard!(['generator.apiKey', 'decider.apiKey'], { provider: null, reason: 'login' });
    expect(f.calls.at(-1)).toBe('openWizard');
    expect(f.lastWizard).toMatchObject({ missing: ['generator.apiKey', 'decider.apiKey'], reason: 'login', runLive: false, found: null });
    // an anthropic generator (or a typesafe Jev provider, or a found key) keeps the two-field reopen
    void b.prompter.wizard!(['generator.apiKey', 'decider.apiKey'], { provider: 'anthropic', reason: 'login' });
    expect(f.calls.at(-1)).toBe('reopenWizard:generator.apiKey:idle:login:-');
    void b.prompter.wizard!(['generator.apiKey', 'decider.apiKey'], { provider: null, reason: 'login', jevProvider: 'typesafe' });
    expect(f.calls.at(-1)).toBe('reopenWizard:generator.apiKey:idle:login:-');
    expect(oneKeyReopen(['generator.apiKey', 'decider.apiKey'], null, null, undefined)).toBe(true);
    expect(oneKeyReopen(['generator.apiKey', 'decider.apiKey'], 'openrouter', 'openrouter', null)).toBe(true);
    expect(oneKeyReopen(['decider.apiKey'], null, null, null)).toBe(false);
    expect(oneKeyReopen(['generator.apiKey', 'decider.apiKey'], 'anthropic', null, null)).toBe(false);
    expect(oneKeyReopen(['generator.apiKey', 'decider.apiKey'], null, 'typesafe', null)).toBe(false);
    expect(oneKeyReopen(['generator.apiKey', 'decider.apiKey'], null, null, 'jev')).toBe(false);
    // reuseGeneratorForJev copies the generator key into the Jev slot
    expect(patchFromWizard(save({ provider: 'openrouter', jevProvider: null, fields: ['generator.apiKey'], reuseGeneratorForJev: true, values: { 'generator.apiKey': 'sk-or-v1-zzzzzzzzzzzz' } }))).toEqual({ provider: 'openrouter', apiKey: 'sk-or-v1-zzzzzzzzzzzz', jevApiKey: 'sk-or-v1-zzzzzzzzzzzz' });
    // TUI-DESIGN-2 §1.4: the Jev provider chosen on its step rides the patch beside the key
    expect(patchFromWizard(save({ provider: null, jevProvider: 'typesafe', fields: ['decider.apiKey'], reuseGeneratorForJev: false, values: { 'decider.apiKey': 'ts-key-abcdefghijklmnop' } }))).toEqual({ jevApiKey: 'ts-key-abcdefghijklmnop', jevProvider: 'typesafe' });
    // a failed save is reported to the wizard and leaves the prompt pending
    b.control(controls({ persistCredentials: async () => ({ ok: false, items: [], error: 'EACCES' }) }));
    expect(await b.wizardHost.save(save({ provider: null, jevProvider: null, fields: [], reuseGeneratorForJev: false, values: {} }))).toEqual({ ok: false, reason: 'EACCES' });
  });

  it('reopenWizard carries the controller\'s live flag, not the reason: a 401 pane `[l]` with a live run reopens live (Ctrl-C closes), an idle /login reopens idle (Ctrl-C exits 2) (§11.1)', () => {
    const f = fakeTui();
    const b = createTuiPrompter();
    b.attach(f.renderer);
    let live = true;
    b.control(controls({ runLive: () => live }));
    void b.prompter.wizard!(['decider.apiKey'], { provider: null, reason: 'rejected' });
    expect(f.calls.at(-1)).toBe('reopenWizard:decider.apiKey:live:rejected:-');
    live = false;
    void b.prompter.wizard!(['generator.apiKey', 'decider.apiKey'], { provider: 'anthropic', reason: 'login' });
    expect(f.calls.at(-1)).toBe('reopenWizard:generator.apiKey:idle:login:-');
    // the one-paste reopen carries the live flag too
    void b.prompter.wizard!(['generator.apiKey', 'decider.apiKey'], { provider: null, reason: 'login' });
    expect(f.lastWizard).toMatchObject({ reason: 'login', runLive: false });
    // the second open cancelled the first prompt
    live = true;
    void b.prompter.wizard!(['decider.apiKey'], { provider: null, reason: 'login' });
    expect(f.calls.at(-1)).toBe('reopenWizard:decider.apiKey:live:login:-');
    void b.prompter.wizard!(['generator.apiKey', 'decider.apiKey'], { provider: null, reason: 'rejected' });
    expect(f.lastWizard).toMatchObject({ reason: 'rejected', runLive: true });
    b.wizardHost.cancel();
  });

  it('wizardHost.cancel() settles the pending wizard as cancelled and the pending trust as null (the App\'s close paths)', async () => {
    const f = fakeTui();
    const b = createTuiPrompter();
    b.attach(f.renderer);
    b.control(controls());
    const w = b.prompter.wizard!(['decider.apiKey'], { provider: null, reason: 'rejected' });
    b.wizardHost.cancel();
    expect(await w).toEqual({ kind: 'cancelled' });
    const t = b.prompter.trust!({ root: '/w', agents: null, dotenv: null, jevcodeJson: null });
    b.wizardHost.cancel();
    expect(await t).toBeNull();
    // idempotent
    b.wizardHost.cancel();
  });

  it('the wizard host\'s cancel() is the close channel (no overlay polling): a cancel settles the pending wizard and trust prompts at once; a save first wins and a later cancel changes nothing', async () => {
    vi.useFakeTimers();
    const f = fakeTui();
    const b = createTuiPrompter();
    b.attach(f.renderer);
    b.control(controls());
    let settled: unknown = null;
    void b.prompter.wizard!(['decider.apiKey'], { provider: null, reason: 'login' }).then((o) => {
      settled = o;
    });
    // however long the overlay stays open or closed, nothing polls it
    f.overlay = 'wizard';
    await vi.advanceTimersByTimeAsync(5000);
    f.overlay = 'none';
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBeNull();
    b.wizardHost.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual({ kind: 'cancelled' });

    let saved: unknown = null;
    void b.prompter.wizard!(['decider.apiKey'], { provider: null, reason: 'login' }).then((o) => {
      saved = o;
    });
    await b.wizardHost.save(save({ provider: null, jevProvider: null, fields: ['decider.apiKey'], reuseGeneratorForJev: false, values: { 'decider.apiKey': 'sk-or-v1-abcdefghijklmnop' } }));
    expect(saved).toEqual({ kind: 'persisted' });
    b.wizardHost.cancel(); // the App's `done` without a further answer, or a later Ctrl-C: nothing pending
    await vi.advanceTimersByTimeAsync(0);
    expect(saved).toEqual({ kind: 'persisted' });
  });

  it('TUI-DESIGN-2 §1.4: wizard({ reason: mode, mode }) reopens at the provider step with the target mode (and the current one for the Ctrl-C hint); a missing-key wizard without controls defaults to DEFAULT_MODE', () => {
    const f = fakeTui();
    const b = createTuiPrompter();
    b.attach(f.renderer);
    void b.prompter.wizard!(['generator.apiKey'], { provider: null, reason: 'mode', mode: 'jev-on' });
    expect(f.calls.at(-1)).toBe('reopenWizard:provider:idle:mode:jev-on');
    b.control(controls({ runLive: () => true, mode: () => 'jev-only' }));
    void b.prompter.wizard!(['generator.apiKey'], { provider: null, reason: 'mode', mode: 'jev-off' });
    expect(f.calls.at(-1)).toBe('reopenWizard:provider:live:mode:jev-off');
    // no controls yet → the fallback is DEFAULT_MODE (TUI-DESIGN-3 §1.1)
    const b2 = createTuiPrompter();
    const f2 = fakeTui();
    b2.attach(f2.renderer);
    void b2.prompter.wizard!(['decider.apiKey'], { provider: null, reason: 'missing' });
    expect(f2.lastWizard).toEqual({ missing: ['decider.apiKey'], mode: DEFAULT_MODE, provider: null, trustNeeded: false });
    void b2.prompter.wizard!(['generator.apiKey', 'decider.apiKey'], { provider: null, reason: 'missing', mode: 'jev-on' });
    expect(f2.lastWizard?.mode).toBe('jev-on');
  });

  it('finding 11: the reopen step follows `missing` — only the Jev key missing (/mode jev-only after /logout decider) reopens at the Jev key step (reason login: the reducer forces `provider` under reason mode; Ctrl-C keeps the session either way); both keys → the provider step', () => {
    const f = fakeTui();
    const b = createTuiPrompter();
    b.attach(f.renderer);
    void b.prompter.wizard!(['decider.apiKey'], { provider: null, reason: 'mode', mode: 'jev-only' });
    expect(f.calls.at(-1)).toBe('reopenWizard:decider.apiKey:idle:login:jev-only');
    void b.prompter.wizard!(['decider.apiKey'], { provider: null, reason: 'mode', mode: 'jev-on' });
    expect(f.calls.at(-1)).toBe('reopenWizard:decider.apiKey:idle:login:jev-on');
    void b.prompter.wizard!(['generator.apiKey', 'decider.apiKey'], { provider: null, reason: 'mode', mode: 'jev-on' });
    expect(f.calls.at(-1)).toBe('reopenWizard:provider:idle:mode:jev-on');
    b.control(controls({ runLive: () => true }));
    void b.prompter.wizard!(['decider.apiKey'], { provider: null, reason: 'mode', mode: 'jev-only' });
    expect(f.calls.at(-1)).toBe('reopenWizard:decider.apiKey:live:login:jev-only');
  });

  it('TUI-DESIGN-2 §3.7: intake() shows the card (title, body, flat rows at the prompter\'s width) and forwards the App\'s answer; no renderer or cancelAll → keep', async () => {
    const b0 = createTuiPrompter();
    expect(await b0.prompter.intake!('the date parsing')).toBe('keep');
    const f = fakeTui();
    const b = createTuiPrompter();
    b.attach(f.renderer);
    f.intakeAnswer = 'run';
    expect(await b.prompter.intake!('the date parsing')).toBe('run');
    expect(f.calls.at(-1)).toBe('promptIntake');
    const columns = b.prompter.columns!();
    expect(f.lastIntake).toEqual({ title: columns - 4 >= 100 ? '"the date parsing" — run this as a task?' : 'run this as a task?', body: [INTAKE_CARD_BODY], flat: columns >= 100 ? [expect.stringContaining('run this as a task?')] : columns >= 72 ? [INTAKE_ROW_MEDIUM] : [expect.stringContaining('run this as a task?')] });
    f.intakeAnswer = 'chat';
    expect(await b.prompter.intake!('tests?')).toBe('chat');
    f.hang = true;
    const pending = b.prompter.intake!('parse_date');
    b.prompter.cancelAll!();
    expect(await pending).toBe('keep');
  });

  it('secretGate: refuses without a renderer (the controller falls back to the pipe rule) and forwards the App\'s promptSecretGate answer (§10.2, §4.10)', async () => {
    const hits = detectSecrets('use sk-ant-api03-SECRETSECRETSECRETSECRETSECRET1234 now');
    expect(hits.length).toBeGreaterThan(0);
    const b0 = createTuiPrompter();
    expect(await b0.prompter.secretGate!(hits)).toBe(false); // no renderer attached
    const f = fakeTui();
    expect(hasSecretGate(f.renderer)).toBe(true);
    f.gateAnswer = false;
    const b = createTuiPrompter();
    b.attach(f.renderer);
    expect(await b.prompter.secretGate!(hits)).toBe(false);
    expect(f.calls).toEqual(['promptSecretGate']);
    let asked: readonly unknown[] | null = null;
    const gated: TuiRenderer & SecretGateRenderer = {
      ...f.renderer,
      promptSecretGate: async (h) => {
        asked = h;
        return true;
      },
    };
    const b2 = createTuiPrompter();
    b2.attach(gated);
    expect(await b2.prompter.secretGate!(hits)).toBe(true);
    expect(asked).toEqual(hits);
    // the unmount settles a pending gate as a refusal
    const hanging: TuiRenderer & SecretGateRenderer = { ...f.renderer, promptSecretGate: () => new Promise(() => undefined) };
    const b3 = createTuiPrompter();
    b3.attach(hanging);
    const p = b3.prompter.secretGate!(hits);
    b3.prompter.cancelAll!();
    expect(await p).toBe(false);
  });

  it('cancelAll() settles every pending prompt with its safe default after the App stopped answering (§13.5 / F3)', async () => {
    const f = fakeTui();
    f.hang = true;
    const b = createTuiPrompter();
    b.attach(f.renderer);
    b.control(controls());
    const followUp = b.prompter.followUp!({ runCapUsd: 2, sessionCapUsd: 10, sessionSpentUsd: 9, runs: 3, lastRunUsd: 1 });
    const exit = b.prompter.exitConfirm!();
    const req: BlockingRequest = { id: 'b', step: 1, kind: 'jev-unreachable', detail: '', stop: 'error', exitCode: 5 };
    const blocking = b.prompter.blocking!(req);
    const undo = b.prompter.undoAsk!({ kind: 'ask', path: 'a', via: 'pre-image', prompt: 'p', expected: { exists: true, sha256: null } }, { index: 0, total: 1 });
    const picker = b.prompter.picker!([row('S1', ['R1'])], { sort: 'updated', workspace: '/w' });
    const rewind = b.prompter.rewind!([{ step: 3, changedFiles: ['a'] }]);
    const wizard = b.prompter.wizard!(['decider.apiKey'], { provider: null, reason: 'missing' });
    const trust = b.prompter.trust!({ root: '/w', agents: null, dotenv: null, jevcodeJson: null });
    b.prompter.cancelAll!();
    expect(await followUp).toBe('n');
    expect(await exit).toBe(false);
    expect(await blocking).toBe('stop');
    expect(await undo).toBe('esc');
    expect(await picker).toBeNull();
    expect(await rewind).toBeNull();
    expect(await wizard).toEqual({ kind: 'cancelled' });
    expect(await trust).toBeNull();
    // a prompt answered later (the App resolving after the cancel) changes nothing
    f.hang = false;
    expect(await b.prompter.exitConfirm!()).toBe(true);
  });

  it('trust: opens the wizard at its trust step and resolves with the option the App reports', async () => {
    const f = fakeTui();
    const b = createTuiPrompter();
    b.attach(f.renderer);
    const t = b.prompter.trust!({ root: '/w', agents: { name: 'AGENTS.md', bytes: 10 }, dotenv: null, jevcodeJson: null });
    expect(f.lastWizard).toMatchObject({ missing: [], trustNeeded: true });
    b.wizardHost.trust!(2);
    expect(await t).toBe(2);
  });
});

describe('TUI-DESIGN-3 §1.4.3 / §1.5: the save-shape table, found / foundSource through openWizard, verify wired to the controller, the mode outcome, the /trust reason', () => {
  const OR = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123';
  it('patchFromWizard by keyAs: both → four file keys; generator → apiKey + provider only (never jevProvider / jevApiKey); jev → jevApiKey + jevProvider + provider anthropic (never apiKey); reuseJevForGenerator copies the host\'s Jev value', () => {
    expect(patchFromWizard(save({ provider: null, jevProvider: null, fields: ['key'], reuseGeneratorForJev: false, oneKey: true, keyAs: 'both', values: { key: OR } }))).toEqual({ apiKey: OR, jevApiKey: OR, provider: 'openrouter', jevProvider: 'openrouter' });
    expect(patchFromWizard(save({ provider: null, jevProvider: null, fields: ['key'], reuseGeneratorForJev: false, keyAs: 'generator', values: { key: OR } }))).toEqual({ apiKey: OR, provider: 'openrouter' });
    expect(patchFromWizard(save({ provider: null, jevProvider: null, fields: ['key'], reuseGeneratorForJev: false, keyAs: 'jev', values: { key: OR } }))).toEqual({ jevApiKey: OR, jevProvider: 'openrouter', provider: 'anthropic' });
    // the reuse Enter: no key typed, the resolved Jev value becomes the generator key
    expect(patchFromWizard(save({ provider: null, jevProvider: null, fields: [], reuseGeneratorForJev: false, reuseJevForGenerator: true, keyAs: 'generator', values: {} }), OR)).toEqual({ apiKey: OR, provider: 'openrouter' });
    expect(patchFromWizard(save({ provider: null, jevProvider: null, fields: [], reuseGeneratorForJev: false, reuseJevForGenerator: true, keyAs: 'generator', values: {} }), null)).toEqual({});
    // an empty key field writes nothing
    expect(patchFromWizard(save({ provider: null, jevProvider: null, fields: ['key'], reuseGeneratorForJev: false, keyAs: 'both', values: { key: '' } }))).toEqual({});
    // the provider-only save (option 4 with the Anthropic key resolving)
    expect(patchFromWizard(save({ provider: 'anthropic', jevProvider: null, fields: [], reuseGeneratorForJev: false, keyAs: 'jev', values: {} }))).toEqual({ provider: 'anthropic' });
  });

  it('wizard(missing, { found, foundSource, foundReusable }) reaches openWizard for a startup wizard; the save reads the resolved Jev key for the reuse and names its layer; the verify goes through controls.verifyKeys with the mode and the signal', async () => {
    const f = fakeTui();
    const b = createTuiPrompter();
    b.attach(f.renderer);
    const saved: unknown[] = [];
    const verified: unknown[] = [];
    b.control(
      controls({
        mode: () => 'jev-on',
        persistCredentials: async (patch, source, opts) => {
          saved.push({ patch, source, opts });
          return { ok: true, items: [] };
        },
        resolvedJevKey: () => OR,
        resolvedJevSource: () => 'dotenv',
        verifyKeys: async (i) => {
          verified.push(i);
          return { ok: false, rejected: 'decider.apiKey', items: ['x'] };
        },
        sandboxDetail: () => 'the long sentence',
      }),
    );
    void b.prompter.wizard!(['generator.apiKey'], { provider: 'openrouter', reason: 'missing', found: 'jev', foundSource: 'env', foundReusable: true, jevProvider: 'openrouter' });
    expect(f.lastWizard).toEqual({ missing: ['generator.apiKey'], mode: 'jev-on', provider: 'openrouter', trustNeeded: false, found: 'jev', foundSource: 'env', foundReusable: true });
    await b.wizardHost.save(save({ provider: null, jevProvider: null, fields: [], reuseGeneratorForJev: false, reuseJevForGenerator: true, keyAs: 'generator', values: {} }));
    expect(saved).toEqual([{ patch: { apiKey: OR, provider: 'openrouter' }, source: 'wizard', opts: { reusedFrom: 'dotenv' } }]);
    const ac = new AbortController();
    expect(await b.wizardHost.verify!({ provider: 'openrouter', jevProvider: null, fields: ['key'], mode: 'jev-on', signal: ac.signal })).toEqual({ ok: false, rejected: 'decider.apiKey', items: ['x'] });
    expect(verified).toEqual([{ provider: 'openrouter', jevProvider: null, fields: ['key'], mode: 'jev-on', signal: ac.signal }]);
    expect(b.wizardHost.sandboxDetail?.()).toBe('the long sentence');
    // without controls the verify is a no-op success
    const b0 = createTuiPrompter();
    expect(await b0.wizardHost.verify!({ provider: null, jevProvider: null, fields: [], mode: 'jev-on' })).toEqual({ ok: true, rejected: null, items: [] });
  });

  it('the mode outcome: `3 Jev only` with no save → done() resolves { kind: mode, mode, persist }; with a save → applyMode after the key landed and the prompt resolves persisted; Ctrl-C after the choice resolves cancelled', async () => {
    const f = fakeTui();
    const b = createTuiPrompter();
    b.attach(f.renderer);
    const applied: unknown[] = [];
    b.control(controls({ applyMode: async (mode, persist) => { applied.push({ mode, persist }); } }));
    const w1 = b.prompter.wizard!(['generator.apiKey'], { provider: 'openrouter', reason: 'missing', found: 'typesafe', foundSource: 'env' });
    b.wizardHost.mode!({ mode: 'jev-only', persist: true });
    b.wizardHost.done!();
    expect(await w1).toEqual({ kind: 'mode', mode: 'jev-only', persist: true });
    expect(applied).toEqual([]); // runLogin applies the outcome; the prompter only carries it
    const w2 = b.prompter.wizard!(['generator.apiKey', 'decider.apiKey'], { provider: null, reason: 'missing' });
    b.wizardHost.mode!({ mode: 'jev-only', persist: true });
    await b.wizardHost.save(save({ provider: null, jevProvider: 'openrouter', fields: ['decider.apiKey'], reuseGeneratorForJev: false, pendMode: 'jev-only', values: { 'decider.apiKey': OR } }));
    expect(applied).toEqual([{ mode: 'jev-only', persist: true }]);
    expect(await w2).toEqual({ kind: 'persisted' });
    b.wizardHost.done!(); // nothing pending: inert
    const w3 = b.prompter.wizard!(['generator.apiKey', 'decider.apiKey'], { provider: null, reason: 'login' });
    b.wizardHost.mode!({ mode: 'jev-only', persist: false });
    b.wizardHost.cancel();
    expect(await w3).toEqual({ kind: 'cancelled' });
    // a plain done() with nothing chosen and nothing saved resolves cancelled
    const w4 = b.prompter.wizard!(['decider.apiKey'], { provider: null, reason: 'login' });
    b.wizardHost.done!();
    expect(await w4).toEqual({ kind: 'cancelled' });
  });

  it('TUI-DESIGN-3 §4.4 F17: trust(inputs, { reopen: true }) opens the card with reason trust; the startup gate passes no reason', async () => {
    const f = fakeTui();
    const b = createTuiPrompter();
    b.attach(f.renderer);
    b.control(controls());
    void b.prompter.trust!({ root: '/w', agents: null, dotenv: null, jevcodeJson: null }, { reopen: true });
    expect(f.lastWizard).toMatchObject({ missing: [], trustNeeded: true, reason: 'trust', mode: 'jev-on' });
    b.wizardHost.cancel();
    void b.prompter.trust!({ root: '/w', agents: null, dotenv: null, jevcodeJson: null });
    expect(f.lastWizard).toEqual({ missing: [], mode: 'jev-on', provider: null, trustNeeded: true });
    b.wizardHost.cancel();
  });
});
