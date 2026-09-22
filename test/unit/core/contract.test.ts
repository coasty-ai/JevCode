/**
 * contract 1.2 (docs/TUI-DESIGN-2.md §6, S1 W0): the additive items exist with the shapes §6 spells out. Types have no
 * runtime, so this file is the compile-time proof (`tsc` runs over test/**) plus the few runtime facts the contract makes:
 * every Decider names its provider, `usage.cost` is optional on the wire, the header comment records the contract.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AckOutcome,
  AskResult,
  BlockingAnswer,
  ChatLabel,
  CheckpointState,
  CheckpointStore,
  ContextUsage,
  DeciderConfig,
  Engine,
  EngineEvent,
  EngineOptions,
  EngineStatus,
  HistoryStore,
  IntakeKind,
  InterruptReason,
  JevProvider,
  JevProviderSource,
  JevUsage,
  LaunchSettings,
  PauseOptions,
  PausePoint,
  PausePointReason,
  Renderer,
  ResolvedConfig,
  RunMeta,
  SessionHost,
  SessionRef,
  StepRecord,
  SubmitOutcome,
  UiConfig,
  UiLabel,
} from '../../../src/core/types.js';
import type { WizardOutcome } from '../../../src/cli/session.js';
import type { Bindings } from '../../../src/tui/keys/bindings.js';
import { DEFAULT_BINDINGS } from '../../../src/tui/keys/bindings.js';
import { AbortError } from '../../../src/errors.js';
import { createMockDecider } from '../../../src/jev/mock.js';
import { JEV_PROVIDERS } from '../../../src/jev/providers.js';

const ROOT = join(import.meta.dirname, '../../..');

describe('contract 1.2 (TUI-DESIGN-2 §6 items 1–13)', () => {
  it('header: types.ts records contract 1.2 under the 1.1 line and keeps CheckpointEnvelope.version at 1', () => {
    const text = readFileSync(join(ROOT, 'src/core/types.ts'), 'utf8');
    const lines = text.split('\n');
    const i11 = lines.findIndex((l) => l.startsWith('// contract 1.1 (2026-09-20)'));
    const i12 = lines.findIndex((l) => l.startsWith('// contract 1.2 (2026-09-21)'));
    expect(i11).toBeGreaterThan(0);
    expect(i12).toBe(i11 + 1);
    expect(lines[i12]).toContain('docs/TUI-DESIGN-2.md §6');
    expect(lines[i12]).toContain('CheckpointEnvelope.version stays 1');
  });

  it('items 1–2: chat labels and the five intake kinds (compile-time; the arrays are the runtime twins)', () => {
    const labels: UiLabel[] = ['[ui]', '[setup]', '[config]', '[sandbox]', '[you]', '[jevcode]'];
    const chat: ChatLabel[] = ['[you]', '[jevcode]'];
    const kinds: IntakeKind[] = ['greeting_or_smalltalk', 'question_about_this_tool', 'question_about_the_code', 'coding_task', 'ambiguous'];
    expect(labels).toHaveLength(6);
    expect(chat.every((c) => labels.includes(c))).toBe(true);
    expect(kinds).toHaveLength(5);
  });

  it('items 3, 6, 8, 11, 12, 13: optional additions accept both the old and the new shape', () => {
    const record = { step: 1 } as unknown as StepRecord;
    const events: EngineEvent[] = [
      { type: 'step:end', record },
      { type: 'step:end', record, costUsd: { generator: 0.01, jev: 0.0001 } },
    ];
    expect(events).toHaveLength(2);
    const results: Pick<AskResult, 'costBasis'>[] = [{}, { costBasis: 'provider' }, { costBasis: 'table' }];
    expect(results).toHaveLength(3);
    const models: EngineOptions['deciderModel'][] = [{ configured: 'm', pinned: true }, { configured: 'jev-1.13.0', pinned: true, provider: 'typesafe' }];
    expect(models[0]?.provider).toBeUndefined();
    const hooks: Pick<Renderer, 'restoreDraft' | 'live'> = {};
    expect(hooks.restoreDraft).toBeUndefined();
    const appended: string[] = [];
    const history: HistoryStore = { entries: () => [], append: (kind, text) => appended.push(`${kind}:${text}`), clear: () => undefined };
    history.append('chat', 'hi');
    history.append('prompt', 'fix it');
    expect(appended).toEqual(['chat:hi', 'prompt:fix it']);
    const refs: SessionRef[] = [
      { sessionId: null, parentRunId: null, source: 'cli' },
      { sessionId: 's', parentRunId: null, source: 'cli', intake: { kind: 'coding_task', probability: 0.78, requestHash: 'abc123def456' } },
    ];
    expect(refs[1]?.intake?.kind).toBe('coding_task');
  });

  it('item 4: DeciderConfig carries provider, provider-aware pinned, pricing and providerSource', () => {
    const sources: JevProviderSource[] = ['flag', 'env', 'dotenv:/x/.env', 'file:/x/config.yaml', 'auto:base-url', 'auto:typesafe-key', 'auto:openrouter-key', 'default'];
    expect(sources).toHaveLength(8);
    const cfg: DeciderConfig = { provider: 'typesafe', baseUrl: JEV_PROVIDERS.typesafe.baseUrl, apiKey: 'k', model: 'jev-1.13.0', pinned: true, pricing: JEV_PROVIDERS.typesafe.pricing, providerSource: 'auto:typesafe-key' };
    expect(cfg.pricing.outputUsdPerToken).toBe(0);
  });

  it('item 5: usage.cost is optional on the wire (TypeSafe native sends none)', () => {
    const usages: JevUsage[] = [{ input_tokens: 319, output_tokens: 23 }, { input_tokens: 895, output_tokens: 30, cost: 895 * 4.2e-8 }];
    expect(usages[0]?.cost).toBeUndefined();
  });

  it('item 7: every Decider names its provider; the mock is openrouter', () => {
    const d = createMockDecider();
    const p: JevProvider = d.provider;
    expect(p).toBe('openrouter');
  });

  it('item 9: ResolvedConfig.mode is an EngineMode (compile-time)', () => {
    const pick: Pick<ResolvedConfig, 'mode'> = { mode: 'jev-only' };
    expect(pick.mode).toBe('jev-only');
  });

  it('the contract headers read 1.1, 1.2, 1.2, 1.3, 1.4 in file order, contiguous; 1.4 names §12.0 and keeps the envelope at 1', () => {
    const lines = readFileSync(join(ROOT, 'src/core/types.ts'), 'utf8').split('\n');
    const headers = lines.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith('// contract '));
    // every wave's line, in the order the waves landed (two 1.2 lines: TUI round 2 and llm-jev)
    expect(headers.map(([l]) => l.slice('// contract '.length).split(' ')[0])).toEqual(['1.1', '1.2', '1.2', '1.3', '1.4']);
    // one contiguous block, so a later wave appends rather than slotting in somewhere
    expect(headers.map(([, i]) => i)).toEqual(headers.map((_, k) => headers[0]![1] + k));
    const i14 = headers.at(-1)![1];
    expect(lines[i14]?.startsWith('// contract 1.4 (2026-09-21)')).toBe(true);
    // 1.4 sits directly after the TUI's round-3 line, which is where the harness rebased it
    expect(lines[i14 - 1]?.startsWith('// contract 1.3 (2026-09-21)')).toBe(true);
    expect(lines[i14]).toContain('docs/COORDINATION-DESIGN.md §12.0');
    expect(lines[i14]).toContain('CheckpointEnvelope.version stays 1');
  });

  it('contract 1.4 shapes: PausePoint / PauseOptions / the events / the verbs / the state fields compile in both the old and the new form', () => {
    const reasons: PausePointReason[] = ['step', 'now', 'now-after-execute', 'pane', 'worktree'];
    expect(reasons).toHaveLength(5);
    const point: PausePoint = { step: 3, round: null, phase: 'idle', reason: 'step', resumableAt: 'boundary', replayable: false, by: 'self', end: false };
    const rich: PausePoint = { ...point, round: 1, phase: 'pane', pane: 'jev-unreachable', reason: 'pane', resumableAt: 'cache/step-3.json', replayable: true, llm: { goalId: 'g1', round: 1, arrived: [0, 2] }, by: 'peer:rpywkq2v', end: true };
    const events: EngineEvent[] = [
      { type: 'pause:point', point: rich },
      { type: 'context:compacted', step: 3, chars: { before: 12_000, after: 4_000 }, by: 'code' },
      { type: 'pause:requested', step: 3 },
      { type: 'blocking:resolved', id: 'b1', answer: 'pause', auto: false },
    ];
    expect(events).toHaveLength(4);
    const answers: BlockingAnswer[] = ['retry', 'continue', 'stop', 'login', 'pin', 'pause', 'wait', 'worktree'];
    expect(answers).toHaveLength(8);
    const interrupts: InterruptReason[] = ['signal', 'human_abort', 'wall_time', 'error', 'human_pause'];
    expect(interrupts).toHaveLength(5);
    // the zero-arg pause() still compiles for every fake; a fake without end / deliver still satisfies Engine
    const pauses: PauseOptions[] = [{}, { at: 'step' }, { at: 'now', by: 'device:mbp' }];
    expect(pauses).toHaveLength(3);
    const calls: string[] = [];
    const fakeEngine: Pick<Engine, 'pause' | 'end' | 'deliver'> = { pause: () => calls.push('pause') };
    fakeEngine.pause();
    fakeEngine.pause({ at: 'now' });
    expect(fakeEngine.end).toBeUndefined();
    expect(fakeEngine.deliver).toBeUndefined();
    expect(calls).toEqual(['pause', 'pause']);
    const host: Pick<SessionHost, 'pause'> = { pause: () => undefined };
    host.pause({ at: 'now' });
    const ack: AckOutcome[] = ['delivered', 'applied', 'refused', 'expired'];
    expect(ack).toHaveLength(4);
    const status: Pick<EngineStatus, 'pausePoint' | 'pauseNow' | 'context'> = { pausePoint: null, pauseNow: false };
    expect(status.context).toBeUndefined();
    // ONE ContextUsage: §8.7's members, the agreed token names and the context-policy branch's own (budgetBoundBy … refreshMs)
    const usage: ContextUsage = {
      promptChars: 1,
      budgetChars: 2,
      pct: 50,
      files: 0,
      historyEntries: 0,
      summaryAt: null,
      lastCompactionStep: null,
      tokensInWindow: 0,
      budgetTokens: 1,
      windowTokens: 2,
      compactions: 0,
      lastCompactionAt: null,
      compaction: 'code',
      budgetBoundBy: 'window',
      usdPerStep: null,
      windowTooSmall: false,
      recentSteps: { chars: 0, allowanceChars: 0, whole: 0, clipped: 0, oneLine: 0, reads: 0 },
      promptBuildMs: 0,
      refreshMs: 0,
    };
    expect(usage.compaction).toBe('code');
    expect(usage.budgetTokens).toBeLessThanOrEqual(usage.windowTokens);
    const resumes: NonNullable<EngineOptions['resume']>[] = [{ runId: 'r', force: false }, { runId: 'r', force: true, replay: true }];
    expect(resumes[0]?.replay).toBeUndefined();
    const stateBits: Pick<CheckpointState, 'interruptedDetail' | 'pausePoint' | 'compactions' | 'lastCompactionAt' | 'lastPromptChars'>[] = [{}, { interruptedDetail: { cache: 'cache/step-1.json', resumes: 1, at: '2026-09-21T12:00:00.000Z', targetsSha: {}, replayable: true, partialChars: 0 }, pausePoint: point, compactions: 0, lastCompactionAt: null, lastPromptChars: 12_000 }];
    expect(stateBits).toHaveLength(2);
    const meta: Pick<RunMeta, 'ended' | 'resumes'>[] = [{ resumes: [] }, { ended: { at: 't', by: 'remote' }, resumes: [{ resumedAt: 't', previousStopReason: 'human_pause', reopened: true }] }, { ended: null, resumes: [] }];
    expect(meta).toHaveLength(3);
    const store: Pick<CheckpointStore, 'writeCache' | 'readCache' | 'renameCache'> = {};
    expect(store.writeCache).toBeUndefined();
    expect(store.renameCache).toBeUndefined();
    // the replayed proposal event is marked; a fresh one carries no verdict
    const proposals: EngineEvent[] = [{ type: 'proposal', step: 1, proposal: { goal: 'g', action: { kind: 'done', summary: 's' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' }, verdict: 'replay' }];
    expect(proposals).toHaveLength(1);
    expect(new AbortError('human_pause').exitCode).toBe(4);
  });

  it('item 10 (W0 half): SubmitOutcome exists and submit() may resolve with it or with nothing until §3.8 lands', async () => {
    const outcomes: SubmitOutcome[] = [{ became: 'run' }, { became: 'chat' }, { became: 'nothing' }];
    expect(outcomes).toHaveLength(3);
    const oldStyle: Pick<SessionHost, 'submit'> = { submit: async () => undefined };
    const newStyle: Pick<SessionHost, 'submit'> = { submit: async () => ({ became: 'chat' }) };
    const so = { kind: 'prompt' as const, secretSpans: [], pinnedFiles: [] };
    expect(await oldStyle.submit('hi', so)).toBeUndefined();
    expect(await newStyle.submit('hi', so)).toEqual({ became: 'chat' });
  });
});

describe('contract 1.3 (TUI-DESIGN-3 §6 items 1–4, 7, 8; S3 W0)', () => {
  it('header: types.ts records contract 1.3 after the 1.2 lines and keeps CheckpointEnvelope.version at 1', () => {
    const text = readFileSync(join(ROOT, 'src/core/types.ts'), 'utf8');
    const lines = text.split('\n');
    const i12 = lines.findIndex((l) => l.startsWith('// contract 1.2 (2026-09-21)'));
    const i13 = lines.findIndex((l) => l.startsWith('// contract 1.3 (2026-09-21)'));
    expect(i13).toBeGreaterThan(i12);
    expect(lines.slice(i12, i13).every((l) => l.startsWith('// contract 1.2'))).toBe(true);
    expect(lines[i13]).toContain('docs/TUI-DESIGN-3.md §6');
    expect(lines[i13]).toContain('CheckpointEnvelope.version stays 1');
    expect(text).toMatch(/version: 1;/);
  });

  it('item 1: Renderer.setBindings is optional and takes the tui Bindings shape (the one type-only core → tui import)', () => {
    const without: Pick<Renderer, 'setBindings'> = {};
    expect(without.setBindings).toBeUndefined();
    let seen: Bindings | null = null;
    const withIt: Pick<Renderer, 'setBindings'> = { setBindings: (b) => void (seen = b) };
    withIt.setBindings?.(DEFAULT_BINDINGS);
    expect(seen).toBe(DEFAULT_BINDINGS);
    // the inversion is type-only: core/types.ts has no runtime import of src/tui
    const text = readFileSync(join(ROOT, 'src/core/types.ts'), 'utf8');
    expect(text.split('\n').filter((l) => /^import\s/.test(l) && l.includes('../tui'))).toEqual([]);
  });

  it('item 2: WizardOutcome gains the mode kind (mode + persist) beside saved / persisted / cancelled', () => {
    const outcomes: WizardOutcome[] = [
      { kind: 'cancelled' },
      { kind: 'persisted' },
      { kind: 'saved', patch: {} },
      { kind: 'mode', mode: 'jev-only', persist: true },
      { kind: 'mode', mode: 'jev-only', persist: false },
    ];
    expect(outcomes.filter((o) => o.kind === 'mode')).toHaveLength(2);
  });

  it('items 4 and 8: UiConfig.wordmark is optional (sweep | static | off); LaunchSettings gains themeHint (light) and ssh, both optional in W0', () => {
    const uis: Pick<UiConfig, 'wordmark'>[] = [{}, { wordmark: 'sweep' }, { wordmark: 'static' }, { wordmark: 'off' }];
    expect(uis.map((u) => u.wordmark)).toEqual([undefined, 'sweep', 'static', 'off']);
    const launches: Pick<LaunchSettings, 'themeHint' | 'ssh'>[] = [{}, { themeHint: 'light' }, { ssh: true }, { themeHint: 'light', ssh: false }];
    expect(launches[0]?.themeHint).toBeUndefined();
    expect(launches[3]).toEqual({ themeHint: 'light', ssh: false });
  });

  it('item 7: SessionHost.dispatchContext is optional and returns the dispatch context without the run phase', () => {
    const without: Pick<SessionHost, 'dispatchContext'> = {};
    expect(without.dispatchContext).toBeUndefined();
    const withIt: Pick<SessionHost, 'dispatchContext'> = { dispatchContext: () => ({ step: 3, changedSteps: [1, 2] }) };
    expect(withIt.dispatchContext?.()).toEqual({ step: 3, changedSteps: [1, 2] });
  });
});
