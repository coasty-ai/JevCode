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
  AgentRef,
  AgentRole,
  AgentRow,
  AgentSpec,
  AgentState,
  AskResult,
  BlockingAnswer,
  ChatLabel,
  CheckpointState,
  CheckpointStore,
  ConfirmRequest,
  ContextUsage,
  DeciderConfig,
  DemandReason,
  Engine,
  EngineEvent,
  EngineOptions,
  EngineSeed,
  EngineStatus,
  GateReason,
  HarnessProblemKind,
  HistoryStore,
  IntakeKind,
  InterruptReason,
  JevProvider,
  JevProviderSource,
  JevUsage,
  LandAttempt,
  LaunchSettings,
  Manifest,
  NoticeKind,
  OrchestrationOptions,
  OrchestrationPolicy,
  PauseOptions,
  PausePoint,
  PausePointReason,
  RejectedOption,
  Renderer,
  ResolvedConfig,
  RiskDimension,
  RiskDimensionResult,
  RunMeta,
  SessionHost,
  SessionRef,
  SpendMeter,
  SpendSnapshot,
  SplitKind,
  StageName,
  StepRecord,
  StepTiming,
  SubmitOutcome,
  SyncedDirtyEntry,
  UiConfig,
  UiLabel,
  UndoSkipReason,
  VerifyResult,
} from '../../../src/core/types.js';
import type { SplitPolicy } from '../../../src/orchestrate/types.js';
import type { WizardOutcome } from '../../../src/cli/session.js';
import type { Bindings } from '../../../src/tui/keys/bindings.js';
import { DEFAULT_BINDINGS } from '../../../src/tui/keys/bindings.js';
import { AbortError } from '../../../src/errors.js';
import { createMockDecider } from '../../../src/jev/mock.js';
import { JEV_PROVIDERS } from '../../../src/jev/providers.js';
import { HEADLINE_ROWS_MAX } from '../../../src/core/limits.js';
import { DEFAULT_SPLIT_POLICY } from '../../../src/orchestrate/index.js';

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

  it('the contract headers read 1.1, 1.2, 1.2, 1.3, 1.4 then ascending later blocks, contiguous; 1.4 names §12.0 and keeps the envelope at 1', () => {
    const lines = readFileSync(join(ROOT, 'src/core/types.ts'), 'utf8').split('\n');
    const headers = lines.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith('// contract '));
    const numbers = headers.map(([l]) => l.slice('// contract '.length).split(' ')[0]!);
    // every wave's line, in the order the waves landed (two 1.2 lines: TUI round 2 and llm-jev), then the blocks assigned
    // after 1.4 (1.5 orchestration, 1.6 import, 1.7 TUI round 4, …) in ASCENDING order whatever order they land in —
    // a block that lands early sits below the numbers reserved above it
    expect(numbers.slice(0, 5)).toEqual(['1.1', '1.2', '1.2', '1.3', '1.4']);
    const later = numbers.slice(5).map(Number);
    for (const n of later) expect(n).toBeGreaterThan(1.4);
    expect(later).toEqual([...later].sort((a, b) => a - b));
    // one contiguous block, so a later wave appends rather than slotting in somewhere
    expect(headers.map(([, i]) => i)).toEqual(headers.map((_, k) => headers[0]![1] + k));
    const i14 = headers[4]![1];
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

// ---------------------------------------------------------------------------------------
// contract 1.5 (docs/ORCHESTRATION-DESIGN.md §4.1, wave D0 item 5)
// ---------------------------------------------------------------------------------------

/**
 * The one line of a declaration, or the block from it down to the first following line that matches `end`.
 * Anchored on the declaration NAME, so a moved declaration is still found and a renamed one fails loudly.
 */
function captureBlock(file: string, anchor: string, end: RegExp): string {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const i = lines.findIndex((l) => l.startsWith(anchor));
  if (i < 0) throw new Error(`${file}: no line starts with ${JSON.stringify(anchor)} — the declaration was renamed or moved out of this file`);
  for (let j = i; j < lines.length; j++) {
    if (end.test(lines[j] ?? '')) return lines.slice(i, j + 1).join('\n');
  }
  throw new Error(`${file}: ${JSON.stringify(anchor)} has no line matching ${String(end)} after it — the declaration's shape changed`);
}

/** The only normalisation the byte-identity guards apply: whitespace-free equality of the captured block. */
const squash = (s: string): string => s.replace(/\s+/g, '');

/** §3.7 [D5c]: the zero dimension the decompose stage fills its synthetic `RiskAssessment` with. */
const ZERO_DIM: RiskDimensionResult = { risk: 0, probability: 1, expected: 0, tailMass: 0, bound: 'expected', confidence: 1, level: 0 };
const zeroDims = (): Record<RiskDimension, RiskDimensionResult> => ({ destructive: ZERO_DIM, out_of_scope: ZERO_DIM, plan_mismatch: ZERO_DIM, irreversible: ZERO_DIM });

describe('contract 1.5 (ORCHESTRATION-DESIGN §4.1)', () => {
  it('header: the 1.5 line sits directly after 1.4 and directly before 1.7, inside one contiguous ascending block', () => {
    const lines = readFileSync(join(ROOT, 'src/core/types.ts'), 'utf8').split('\n');
    const headers = lines.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith('// contract '));
    const i15 = lines.findIndex((l) => l.startsWith('// contract 1.5 (2026-09-22)'));
    expect(i15).toBeGreaterThan(0);
    // §4.1: orchestration rebases onto the commit that lands coordination's 1.4 and never edits above it
    expect(lines[i15 - 1]?.startsWith('// contract 1.4 (2026-09-21)')).toBe(true);
    // the TUI's round-4 block was assigned 1.7 and landed first; 1.5 slots in above it, never below
    expect(lines[i15 + 1]?.startsWith('// contract 1.7 (2026-09-22)')).toBe(true);
    // the block is still contiguous and still ascending after 1.4
    expect(headers.map(([, i]) => i)).toEqual(headers.map((_, k) => headers[0]![1] + k));
    const later = headers.map(([l]) => l.slice('// contract '.length).split(' ')[0]!).slice(5).map(Number);
    expect(later).toEqual([...later].sort((a, b) => a - b));
    expect(later[0]).toBe(1.5);
    expect(lines[i15]).toContain('docs/ORCHESTRATION-DESIGN.md §4.1');
    expect(lines[i15]).toContain('every item is optional or a new union member');
    expect(lines[i15]).toContain('Action, STOP_REASON_SET, exitCodeFor, MODES and CheckpointEnvelope.version are untouched');
  });

  /**
   * §4.1's last claim, made falsifiable. Each expected string is the declaration's source text as captured from HEAD
   * (the commit orchestration rebased onto) and is compared whitespace-free — so reindenting is allowed and every
   * other edit, including a reordered union member or one added enum key, fails.
   *
   * What is captured, and from where:
   *   `Action`                     src/core/types.ts   `export type Action =` → the first line ending in `;`
   *   `STOP_REASON_SET`            src/session/index.ts `const STOP_REASON_SET:` → the first `};`
   *   `exitCodeFor`                src/loop/stop.ts     `export function exitCodeFor(` → the first column-0 `}`
   *   `MODES`                      src/cli/args.ts      the single `export const MODES =` line (the contract's MODES;
   *                                                     src/session/index.ts holds a private `readonly string[]` twin,
   *                                                     which is not the exported constant §4.1 names)
   *   `CheckpointEnvelope`         src/core/types.ts    `export interface CheckpointEnvelope {` → the first column-0 `}`
   */
  it('byte identity: Action, STOP_REASON_SET, exitCodeFor, MODES and CheckpointEnvelope.version are untouched by 1.5', () => {
    expect(squash(captureBlock('src/core/types.ts', 'export type Action =', /;\s*(\/\/.*)?$/))).toBe(
      squash(`export type Action =
  | { kind: 'read'; paths: string[] } // show files, bounded
  | { kind: 'edit'; path: string; old: string; new: string } // exact, unique match
  | { kind: 'write'; path: string; content: string } // create or overwrite
  | { kind: 'patch'; diff: string } // unified diff, -p1, applied with git apply
  | { kind: 'run'; command: string; timeoutMs?: number } // sh -c in sandbox
  | { kind: 'done'; summary: string }; // proposal to finish`),
    );

    expect(squash(captureBlock('src/session/index.ts', 'const STOP_REASON_SET:', /^};$/))).toBe(
      squash(`const STOP_REASON_SET: Readonly<Record<StopReason, true>> = {
  complete: true,
  max_steps: true,
  spend_cap: true,
  wall_time: true,
  max_replans: true,
  human_abort: true,
  signal: true,
  replan_stop: true,
  impossible: true,
  generator_done: true,
  error: true,
  human_pause: true,
  token_cap: true,
};`),
    );

    expect(squash(captureBlock('src/loop/stop.ts', 'export function exitCodeFor(', /^}$/))).toBe(
      squash(`export function exitCodeFor(reason: StopReason, error?: SerializedError, degraded = false, signal?: SignalName): number {
  if (degraded && reason !== 'error') return EXIT_CODES.checkpoint;
  switch (reason) {
    case 'complete':
    case 'generator_done':
      return EXIT_CODES.ok;
    case 'human_abort':
      return EXIT_CODES.sigint;
    case 'signal':
      return signal === 'SIGTERM' ? EXIT_CODES.sigterm : signal === 'SIGHUP' ? EXIT_CODES.sighup : EXIT_CODES.sigint;
    case 'error':
      return error?.exitCode ?? EXIT_CODES.unexpected;
    default:
      // max_steps, spend_cap, wall_time, max_replans, replan_stop, impossible, human_pause, token_cap
      return EXIT_CODES.budget;
  }
}`),
    );

    expect(squash(captureBlock('src/cli/args.ts', 'export const MODES =', /;\s*$/))).toBe(squash(`export const MODES = ['jev-only', 'jev-on', 'jev-off', 'llm-jev'] as const;`));

    expect(squash(captureBlock('src/core/types.ts', 'export interface CheckpointEnvelope {', /^}$/))).toBe(
      squash(`export interface CheckpointEnvelope {
  version: 1;
  /** sha256 of JSON.stringify(state) */
  checksum: string;
  state: CheckpointState;
}`),
    );
  });

  it('the new unions gain exactly the §4.1 members, and every old member still compiles', () => {
    const stages: StageName[] = ['replan', 'intent', 'context', 'propose', 'risk', 'execute', 'judge', 'complete', 'decompose'];
    expect(stages).toHaveLength(9);
    // §4.2: P9 is engine-initiated (`by: 'self'`), P10 is a child's review
    const reasons: PausePointReason[] = ['step', 'now', 'now-after-execute', 'pane', 'worktree', 'delegate', 'review-needed'];
    expect(reasons).toHaveLength(7);
    const problems: HarnessProblemKind[] = ['replan', 'rejected_claim', 'stale_plan', 'human', 'orchestration'];
    expect(problems).toHaveLength(5);
    const notices: NoticeKind[] = ['offline', 'online', 'checkpoint:degraded', 'checkpoint:restored', 'sandbox', 'drift', 'seeded', 'instructions', 'config', 'pricing', 'lock', 'ui', 'orchestration'];
    expect(notices).toHaveLength(13);
    const skips: UndoSkipReason[] = ['link', 'escape', 'submodule', 'not-recoverable', 'head-moved', 'refused', 'declined', 'cap', 'size', 'landed'];
    expect(skips).toHaveLength(10);
    const kinds: SplitKind[] = ['by_plan_item', 'by_directory', 'by_failing_test', 'by_layer', 'as_written', 'no_split'];
    const roles: AgentRole[] = ['code', 'research', 'critic'];
    const demands: DemandReason[] = ['disjoint_directories', 'failing_tests', 'human'];
    expect([kinds.length, roles.length, demands.length]).toEqual([6, 3, 3]);
    const states: AgentState[] = ['planned', 'starting', 'running', 'paused', 'parked', 'review', 'stalled', 'done', 'landing', 'landed', 'conflicted', 'failed-verify', 'kicked', 'dropped', 'crashed', 'failed-start'];
    expect(states).toHaveLength(16); // §2.8 [G22]: `paused` (a human asked) and `parked` (the child stopped itself) are separate
    const gates: GateReason[] = ['split_off', 'child_depth', 'no_ledger', 'not_git', 'unborn_head', 'no_worktree_support', 'plan_too_small', 'blocking_unverified', 'no_verification', 'dirty_too_large', 'children_live', 'max_splits', 'cooldown', 'resources', 'money', 'replan_step', 'orchestration_problem', 'no_demand'];
    expect(gates).toHaveLength(18);
  });

  it('[G2] [D4] [D5] ConfirmRequest: title / headline / body / badge are optional and proposal + risk stay REQUIRED', () => {
    const base = {
      id: 'c1',
      step: 11,
      proposal: { goal: 'delegate: by_directory — 3 agents', action: { kind: 'read' as const, paths: ['orchestrate/manifest-11.json'] }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' },
      risk: { dims: zeroDims(), risk: 0, verdict: 'review' as const, reason: 'a decomposition proposal: nothing is written until you approve' },
    };
    const plain: ConfirmRequest = base;
    expect(plain.title).toBeUndefined();
    expect(plain.headline).toBeUndefined();
    expect(plain.body).toBeUndefined();
    expect(plain.badge).toBeUndefined();
    const card: ConfirmRequest = {
      ...base,
      title: 'delegate 3 agents?',
      badge: 'agent tui-rows',
      headline: ['⚠ your checkout has 7 uncommitted files', '3 agents · $0.90 reserved', 'dock jevcode/dock-r1', '', ''],
      body: ['tui-rows   src/tui/**   npm test -- tui   $0.30 / 12 steps', 'engine     src/loop/**  npm test -- loop  $0.30 / 12 steps'],
    };
    // [D4]: the band `headline` fills is exactly the four RISK_DIMENSIONS gauges plus the matchesIntent row
    expect(HEADLINE_ROWS_MAX).toBe(5);
    expect(card.headline?.length).toBeLessThanOrEqual(HEADLINE_ROWS_MAX);
    // `proposal` and `risk` are required on both forms — the synthetic pair of §3.7 [D5c], not an optional field
    expect(card.proposal.action.kind).toBe('read');
    expect(card.risk.verdict).toBe('review');
  });

  it('[G1] [G8] [D13] StepRecord.commit / .escaped and StepTiming.decomposeMs are optional additions', () => {
    const bare: Pick<StepRecord, 'commit' | 'escaped'> = {};
    expect(bare.commit).toBeUndefined();
    expect(bare.escaped).toBeUndefined();
    const agentStep: Pick<StepRecord, 'commit' | 'escaped'> = { commit: 'f'.repeat(40), escaped: ['src/loop/engine.ts'] };
    expect(agentStep.escaped).toEqual(['src/loop/engine.ts']);
    const timing: StepTiming = { generatorMs: 1, jevMs: 2, execMs: 3, harnessMs: 4, totalMs: 10 };
    expect(timing.decomposeMs).toBeUndefined();
    const delegating: StepTiming = { ...timing, decomposeMs: 812 };
    expect(delegating.decomposeMs).toBe(812);
  });

  it('[D13] EngineSeed.siblings and the EngineOptions orchestration / splitPolicy pair are optional', () => {
    const seed: Pick<EngineSeed, 'siblings'> = {};
    expect(seed.siblings).toBeUndefined();
    const seeded: Pick<EngineSeed, 'siblings'> = { siblings: [{ slug: 'engine', task: 'the loop half', own: ['src/loop/**'] }] };
    expect(seeded.siblings?.[0]?.slug).toBe('engine');
    const opts: Pick<EngineOptions, 'orchestration' | 'splitPolicy'> = {};
    expect(opts.orchestration).toBeUndefined();
    expect(opts.splitPolicy).toBeUndefined();
    const parent: OrchestrationOptions = { depth: 0 };
    const child: OrchestrationOptions = {
      depth: 1,
      role: 'code',
      own: ['src/tui/**'],
      parentRunId: 'r1',
      parentSessionId: 's1',
      slug: 'tui-rows',
      manifestId: 'm1',
      reviewAnswerFile: 'orchestrate/review-11.json',
      commit: { name: 'JevCode agent', email: 'agent@jevcode.invalid' },
      syncedDirty: [{ path: 'src/a.ts', sha256: 'de'.repeat(32), mode: 0o644 }],
      runGit: async () => ({ ok: true, exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, bytesSeen: 0, killedBy: null, timedOut: false, orphans: [], sandboxExecDenied: false, durationMs: 1 }),
    };
    expect([parent.depth, child.depth]).toEqual([0, 1]);
    // §4.1: EngineOptions.splitPolicy is core's OrchestrationPolicy, which src/orchestrate/types.ts aliases as SplitPolicy
    const policy: OrchestrationPolicy = DEFAULT_SPLIT_POLICY;
    const alias: SplitPolicy = policy;
    const back: OrchestrationPolicy = alias;
    expect(back.split).toBe('off');
    const wired: Pick<EngineOptions, 'orchestration' | 'splitPolicy'> = { orchestration: child, splitPolicy: { ...policy, split: 'ask' } };
    expect(wired.splitPolicy?.split).toBe('ask');
  });

  it('CheckpointState, RunMeta and EngineStatus gain their optional orchestration records', () => {
    const fresh: Pick<CheckpointState, 'orchestration' | 'splits'> = {};
    expect(fresh.orchestration).toBeUndefined();
    expect(fresh.splits).toBeUndefined();
    const delegated: Pick<CheckpointState, 'orchestration' | 'splits'> = {
      splits: 1,
      orchestration: { manifestId: 'm1', step: 11, dockBranch: 'jevcode/dock-r1', agents: [{ slug: 'tui-rows', state: 'running', runId: 'r2', commit: null }] },
    };
    expect(delegated.orchestration?.agents[0]?.state).toBe('running');

    const meta: Pick<RunMeta, 'orchestration' | 'agent' | 'landed' | 'undoUnavailableBelow'> = {};
    expect([meta.orchestration, meta.agent, meta.landed, meta.undoUnavailableBelow]).toEqual([undefined, undefined, undefined, undefined]);
    const parentMeta: Pick<RunMeta, 'orchestration' | 'landed' | 'undoUnavailableBelow'> = {
      orchestration: { manifestId: 'm1', agents: ['tui-rows', 'engine'], dockBranch: 'jevcode/dock-r1', landed: [{ slug: 'engine', commit: 'a'.repeat(40), step: 12 }] },
      landed: [{ step: 12, branch: 'jevcode/engine', commit: 'a'.repeat(40) }],
      undoUnavailableBelow: 12,
    };
    expect(parentMeta.undoUnavailableBelow).toBe(12);
    const entry: SyncedDirtyEntry = { path: 'src/a.ts', sha256: 'de'.repeat(32), mode: 0o644 };
    const agentMeta: Pick<RunMeta, 'agent'> = { agent: { slug: 'tui-rows', parentRunId: 'r1', parentSessionId: 's1', own: ['src/tui/**'], manifestId: 'm1', syncedDirty: [entry] } };
    expect(agentMeta.agent?.syncedDirty[0]?.mode).toBe(0o644);

    const idle: Pick<EngineStatus, 'orchestration'> = {};
    expect(idle.orchestration).toBeUndefined();
    const settled: Pick<EngineStatus, 'orchestration'> = { orchestration: null };
    expect(settled.orchestration).toBeNull();
    const live: Pick<EngineStatus, 'orchestration'> = { orchestration: { manifestId: 'm1', agents: 3, live: 2, landed: 1, reserveUsd: 0.9, heldUsd: 0.6 } };
    expect(live.orchestration?.heldUsd).toBe(0.6);
  });

  it('[G6] [D6] SpendMeter.hold / .release are OPTIONAL and SpendSnapshot.heldUsd is optional, so every existing fake compiles', () => {
    // the pre-1.5 fake: five members, no hold, no release, no setCap — still a SpendMeter
    const old: SpendMeter = {
      add: () => snap,
      exceeded: () => false,
      snapshot: () => snap,
      restore: () => undefined,
      child: () => old,
    };
    const snap: SpendSnapshot = { generator: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, jev: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, totalUsd: 0, capUsd: 1, exceeded: false };
    expect(old.hold).toBeUndefined();
    expect(old.release).toBeUndefined();
    expect(snap.heldUsd).toBeUndefined();
    const held: SpendSnapshot = { ...snap, heldUsd: 0.9 };
    expect(held.heldUsd).toBe(0.9);
  });

  it('the twelve new EngineEvent members carry §4.1’s exact field names', () => {
    const spec: AgentSpec = {
      slug: 'tui-rows',
      task: 'the agents tab rows',
      own: ['src/tui/agents/**'],
      role: 'code',
      verify: ['npm test -- tui'],
      dependsOn: [],
      capUsd: 0.3,
      maxSteps: 12,
      maxWallMs: 900_000,
      mode: 'jev-on',
      branch: 'jevcode/tui-rows',
    };
    const rejected: RejectedOption = { kind: 'by_layer', reason: 'coverage below the floor', probability: null };
    const manifest: Manifest = {
      v: 1,
      manifestId: 'm1',
      runId: 'r1',
      sessionId: 's1',
      step: 11,
      splitKind: 'by_directory',
      verdict: 'chosen',
      probability: 0.71,
      confidence: 0.62,
      baseSha: 'a'.repeat(40),
      repoKey: null,
      dockBranch: 'jevcode/dock-r1',
      syncedDirty: [{ path: 'src/a.ts', sha256: 'de'.repeat(32), mode: 0o644 }],
      dirtyOverlap: ['src/a.ts'],
      agents: [spec],
      reserveUsd: 0.9,
      reserveFrom: 'session',
      rejected: [rejected],
      demand: 'disjoint_directories',
      createdAt: '2026-09-22T00:00:00.000Z',
      checksum: 'c0ffee',
    };
    const agent: AgentRef = { slug: 'tui-rows', runId: 'r2', sessionId: 's1' };
    const pending: AgentRef = { slug: 'engine', runId: null, sessionId: null };
    const stage: StageName | 'idle' = 'decompose';
    const row: AgentRow = {
      slug: 'tui-rows',
      state: 'running',
      step: 4,
      maxSteps: 12,
      stage,
      spendUsd: 0.12,
      capUsd: 0.3,
      wallMs: 62_000,
      maxWallMs: 900_000,
      own: ['src/tui/agents/**'],
      branch: 'jevcode/tui-rows',
      verify: ['npm test -- tui'],
      last: 'edit src/tui/agents/lines.ts',
      why: '',
    };
    const verify: VerifyResult = { command: 'npm test -- tui', ok: false, exitCode: 1, durationMs: 4_100, tail: ['1 failing'], counts: null, killed: false };
    const attempt: LandAttempt = { at: '2026-09-22T00:01:00.000Z', slug: 'tui-rows', pinned: 'b'.repeat(40), dockHead: 'a'.repeat(40), outcome: 'failed-verify', verify: [verify], kick: 0 };
    expect(attempt.commit).toBeUndefined();
    const request: ConfirmRequest = {
      id: 'c2',
      step: 4,
      proposal: { goal: 'g', action: { kind: 'done', summary: 's' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' },
      risk: { dims: zeroDims(), risk: 0.4, verdict: 'review', reason: 'r' },
    };
    const events: EngineEvent[] = [
      { type: 'decompose:start', step: 11, options: 4 },
      { type: 'decompose:skipped', step: 11, why: 'plan_too_small' satisfies GateReason },
      { type: 'decompose:ranked', step: 11, splitKind: 'by_directory', verdict: 'chosen', probability: 0.71, agents: 3, rejected: 2 },
      { type: 'orchestration:proposed', step: 11, manifest },
      { type: 'agent:start', agent: pending },
      { type: 'agent:status', agent, row },
      { type: 'agent:review', agent, request },
      { type: 'agent:end', agent, stopReason: 'complete', exitCode: 0, commits: 3, changedFiles: 7, spendUsd: 0.21 },
      { type: 'land:attempt', slug: 'tui-rows', dockHead: 'a'.repeat(40), pinned: 'b'.repeat(40) },
      { type: 'land:result', slug: 'tui-rows', outcome: 'failed-verify', verify: [verify], rule: 'tests-deleted' },
      { type: 'land:result', slug: 'engine', outcome: 'landed', commit: 'c'.repeat(40) },
      { type: 'orchestration:settled', landed: ['engine'], parked: ['tui-rows'], dropped: [], dockBranch: 'jevcode/dock-r1', spendUsd: 0.63 },
      { type: 'agent:adopted', count: 3, parentRunId: 'r1' },
    ];
    // thirteen values over the twelve members (`land:result` appears in both of its outcomes)
    expect(new Set(events.map((e) => e.type)).size).toBe(12);
    expect(events).toHaveLength(13);
  });

  it('[D15] SessionHost keeps its zero-arg pause, gains the optional scope, and gains the optional agents()', () => {
    const calls: unknown[] = [];
    const host: Pick<SessionHost, 'pause' | 'agents'> = { pause: (opts) => void calls.push(opts ?? null) };
    // every pre-1.5 call still compiles
    host.pause();
    host.pause({ at: 'now' });
    host.pause({ at: 'step', by: 'self' });
    const shared: PauseOptions = { at: 'now' };
    host.pause(shared);
    // §4.3: the three scopes, one agent, and the device-wide one
    host.pause({ at: 'step', scope: 'tree' });
    host.pause({ at: 'now', scope: 'agents' });
    host.pause({ scope: 'all' });
    host.pause({ scope: 'run' });
    host.pause({ scope: 'agent:tui-rows' });
    expect(calls).toHaveLength(9);
    // PauseOptions itself is UNWIDENED: the scope rides on SessionHost.pause only, so Engine.pause is untouched
    expect(Object.keys(shared)).toEqual(['at']);
    expect(host.agents).toBeUndefined();
    const withAgents: Pick<SessionHost, 'agents'> = { agents: () => [] };
    expect(withAgents.agents?.()).toEqual([]);
  });
});
