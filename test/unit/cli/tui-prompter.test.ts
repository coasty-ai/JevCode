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
import { createTuiPrompter, hasSecretGate, patchFromWizard, undoKeyOf, type SecretGateRenderer, type TuiPrompterControls } from '../../../src/cli/tui-prompter.js';
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
  /** renderer promises that never settle (the App unmounted) */
  hang: boolean;
  gateAnswer: boolean;
}

const controls = (o: Partial<TuiPrompterControls> = {}): TuiPrompterControls => ({ persistCredentials: async () => ({ ok: true, items: [] }), mode: () => 'jev-on', trustInputs: () => null, sandboxLine: () => null, runsDir: () => null, trashDir: () => null, runLive: () => false, ...o });

function fakeTui(): Fake {
  const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);
  const f: Fake = {
    calls: [],
    lastPicker: null,
    lastWizard: null,
    followUpAnswer: 'start',
    undoAnswer: 'yes',
    overlay: null,
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
      reopenWizard: (at, runLive) => {
        f.calls.push(`reopenWizard:${at}:${runLive ? 'live' : 'idle'}`);
      },
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
    const r = await b.wizardHost.save({ provider: 'openrouter', fields: ['decider.apiKey'], reuseGeneratorForJev: false, values: { 'decider.apiKey': 'sk-or-v1-abcdefghijklmnop' } });
    expect(r).toEqual({ ok: true, items: [] });
    expect(saved).toEqual([{ patch: { provider: 'openrouter', jevApiKey: 'sk-or-v1-abcdefghijklmnop' }, source: 'wizard' }]);
    expect(await w).toEqual({ kind: 'persisted' });
    expect(b.wizardHost.sandboxLine?.()).toBe('seatbelt — x');
    void b.prompter.wizard!(['generator.apiKey', 'decider.apiKey'], { provider: null, reason: 'login' });
    expect(f.calls.at(-1)).toBe('reopenWizard:generator.apiKey:idle');
    // reuseGeneratorForJev copies the generator key into the Jev slot
    expect(patchFromWizard({ provider: 'openrouter', fields: ['generator.apiKey'], reuseGeneratorForJev: true, values: { 'generator.apiKey': 'sk-or-v1-zzzzzzzzzzzz' } })).toEqual({ provider: 'openrouter', apiKey: 'sk-or-v1-zzzzzzzzzzzz', jevApiKey: 'sk-or-v1-zzzzzzzzzzzz' });
    // a failed save is reported to the wizard and leaves the prompt pending
    b.control(controls({ persistCredentials: async () => ({ ok: false, items: [], error: 'EACCES' }) }));
    expect(await b.wizardHost.save({ provider: null, fields: [], reuseGeneratorForJev: false, values: {} })).toEqual({ ok: false, reason: 'EACCES' });
  });

  it('reopenWizard carries the controller\'s live flag, not the reason: a 401 pane `[l]` with a live run reopens live (Ctrl-C closes), an idle /login reopens idle (Ctrl-C exits 2) (§11.1)', () => {
    const f = fakeTui();
    const b = createTuiPrompter();
    b.attach(f.renderer);
    let live = true;
    b.control(controls({ runLive: () => live }));
    void b.prompter.wizard!(['decider.apiKey'], { provider: null, reason: 'rejected' });
    expect(f.calls.at(-1)).toBe('reopenWizard:decider.apiKey:live');
    live = false;
    void b.prompter.wizard!(['generator.apiKey', 'decider.apiKey'], { provider: null, reason: 'login' });
    expect(f.calls.at(-1)).toBe('reopenWizard:generator.apiKey:idle');
    // the second open cancelled the first prompt
    live = true;
    void b.prompter.wizard!(['decider.apiKey'], { provider: null, reason: 'login' });
    expect(f.calls.at(-1)).toBe('reopenWizard:decider.apiKey:live');
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
    await b.wizardHost.save({ provider: null, fields: ['decider.apiKey'], reuseGeneratorForJev: false, values: { 'decider.apiKey': 'sk-or-v1-abcdefghijklmnop' } });
    expect(saved).toEqual({ kind: 'persisted' });
    b.wizardHost.cancel(); // the App's `done` without a further answer, or a later Ctrl-C: nothing pending
    await vi.advanceTimersByTimeAsync(0);
    expect(saved).toEqual({ kind: 'persisted' });
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
