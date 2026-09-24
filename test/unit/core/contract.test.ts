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
  BlockingKind,
  ChatLabel,
  CheckpointState,
  CheckpointStore,
  ConfirmRequest,
  ContextUsage,
  DeciderConfig,
  DemandReason,
  Engine,
  EngineEvent,
  EngineMemoryOptions,
  EngineOptions,
  EngineSeed,
  EngineStatus,
  GateReason,
  GeneratorConfig,
  HarnessProblemKind,
  HistoryStore,
  ImportAction,
  ImportManifest,
  ImportPlan,
  ImportProbe,
  InstructionRecord,
  IntakeKind,
  InterruptReason,
  JevProvider,
  JevProviderSource,
  JevUsage,
  LandAttempt,
  LaunchSettings,
  Manifest,
  McpFile,
  McpServerRecord,
  MemoryItem,
  MemoryProvenance,
  MemoryUsage,
  NoticeKind,
  OrchestrationOptions,
  OrchestrationPolicy,
  PauseOptions,
  PausePoint,
  PausePointReason,
  PlanRow,
  ProjectCommand,
  ProviderName,
  RejectedOption,
  Renderer,
  ResolvedConfig,
  RiskDimension,
  RiskDimensionResult,
  RunMeta,
  SelfIdentityView,
  SessionActivityView,
  SessionHost,
  SessionRef,
  SessionRow,
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
// gate G-R5-8 (§11): the settings-collision lint reads the one table every layer resolves through
import { SETTINGS } from '../../../src/config/defaults.js';
import { DEFAULT_SPLIT_POLICY } from '../../../src/orchestrate/index.js';
import { PROVIDER_IDS, isProviderId } from '../../../src/provider/ids.js';

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
    // contract 1.8 item 2 (TUI-DESIGN-5 §8.1): '[session]' is the seventh label — every applied remote verb writes it
    const labels: UiLabel[] = ['[ui]', '[setup]', '[config]', '[sandbox]', '[you]', '[jevcode]', '[session]'];
    const chat: ChatLabel[] = ['[you]', '[jevcode]'];
    const kinds: IntakeKind[] = ['greeting_or_smalltalk', 'question_about_this_tool', 'question_about_the_code', 'coding_task', 'ambiguous'];
    expect(labels).toHaveLength(7);
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
    const hooks: Pick<Renderer, 'live'> = {};
    expect(hooks.live).toBeUndefined();
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
    // the TUI's round-4 block was assigned 1.7 and landed first; 1.5 slots in above it, never below, and
    // import's 1.6 then slots in between the two (contract 1.6 header case below)
    expect(lines[i15 + 1]?.startsWith('// contract 1.6 (2026-09-22)')).toBe(true);
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
    // the agent loop (docs/AGENT-LOOP-DESIGN.md §15 S1) appends on purpose, and nothing else: `cwd?` to the `run` action,
    // `stuck` to STOP_REASON_SET (exitCodeFor's default branch already maps it to 4), `'agent'` to MODES; §A1 appends `answered`
    // (a reply-only agent run) to STOP_REASON_SET and to exitCodeFor's exit-0 cases
    expect(squash(captureBlock('src/core/types.ts', 'export type Action =', /;\s*(\/\/.*)?$/))).toBe(
      squash(`export type Action =
  | { kind: 'read'; paths: string[] } // show files, bounded
  | { kind: 'edit'; path: string; old: string; new: string } // exact, unique match
  | { kind: 'write'; path: string; content: string } // create or overwrite
  | { kind: 'patch'; diff: string } // unified diff, -p1, applied with git apply
  | { kind: 'run'; command: string; timeoutMs?: number; cwd?: string } // sh -c in sandbox; cwd: workspace-relative, agent mode only (docs/AGENT-LOOP-DESIGN.md §6.1)
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
  stuck: true,
  answered: true,
};`),
    );

    expect(squash(captureBlock('src/loop/stop.ts', 'export function exitCodeFor(', /^}$/))).toBe(
      squash(`export function exitCodeFor(reason: StopReason, error?: SerializedError, degraded = false, signal?: SignalName): number {
  if (degraded && reason !== 'error') return EXIT_CODES.checkpoint;
  switch (reason) {
    case 'complete':
    case 'generator_done':
    case 'answered':
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

    expect(squash(captureBlock('src/cli/args.ts', 'export const MODES =', /;\s*$/))).toBe(squash(`export const MODES = ['jev-only', 'jev-on', 'jev-off', 'llm-jev', 'agent'] as const;`));

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

// ---------------------------------------------------------------------------------------
// contract 1.6 (docs/IMPORT-DESIGN.md §7.1 row 1, wave W0 / W4)
// ---------------------------------------------------------------------------------------

/** §2.3: the provenance block every imported byte carries (§0 principle 6). */
const PROVENANCE: MemoryProvenance = { tool: 'claude-code', path: '~/.claude/CLAUDE.md', sha256: 'a'.repeat(64), imported: '2026-09-22T00:00:00.000Z', importId: 'imp_20260922T000000Z_a1b2c3' };

describe('contract 1.6 (IMPORT-DESIGN §7.1 row 1)', () => {
  it('header: the 1.6 line sits directly after 1.5 and directly before 1.7, inside one contiguous ascending block', () => {
    const lines = readFileSync(join(ROOT, 'src/core/types.ts'), 'utf8').split('\n');
    const headers = lines.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith('// contract '));
    const i16 = lines.findIndex((l) => l.startsWith('// contract 1.6 (2026-09-22)'));
    expect(i16).toBeGreaterThan(0);
    // §7.1 [G2.2]: "the import additions to src/core/types.ts go after coordination's round-3 contract line"
    expect(lines[i16 - 1]?.startsWith('// contract 1.5 (2026-09-22)')).toBe(true);
    // the TUI's round-4 block was assigned 1.7 and landed first; 1.6 slots in above it, never below
    expect(lines[i16 + 1]?.startsWith('// contract 1.7 (2026-09-22)')).toBe(true);
    // the block is still contiguous and still ascending after 1.4
    expect(headers.map(([, i]) => i)).toEqual(headers.map((_, k) => headers[0]![1] + k));
    const later = headers
      .map(([l]) => l.slice('// contract '.length).split(' ')[0]!)
      .slice(5)
      .map(Number);
    expect(later).toEqual([...later].sort((a, b) => a - b));
    expect(later.slice(0, 2)).toEqual([1.5, 1.6]);
    expect(lines[i16]).toContain('docs/IMPORT-DESIGN.md §7.1 row 1');
    expect(lines[i16]).toContain('every widening is an optional member or a new union member');
    expect(lines[i16]).toContain('CheckpointEnvelope.version stays 1');
  });

  it('the 22 section-1 shapes are declared in core and re-exported by src/import/types.ts, which declares none of them', () => {
    const core = readFileSync(join(ROOT, 'src/core/types.ts'), 'utf8');
    const imports = readFileSync(join(ROOT, 'src/import/types.ts'), 'utf8');
    const moved = [
      'SourceTool',
      'SourceScope',
      'SourceFormat',
      'ImportClass',
      'ImportSkipAction',
      'ImportAction',
      'SourceParse',
      'SourceItem',
      'MemoryKind',
      'RuleTrigger',
      'MemoryProvenance',
      'MemoryItem',
      'ProjectCommand',
      'McpServerRecord',
      'McpFile',
      'PlanRow',
      'PlanRoot',
      'CannotRead',
      'ImportPlan',
      'ImportProbe',
      'ImportManifestEntry',
      'ImportManifest',
    ];
    expect(moved).toHaveLength(22);
    for (const name of moved) {
      expect(new RegExp(`^export (?:interface|type) ${name}\\b`, 'm').test(core), `core declares ${name}`).toBe(true);
      expect(new RegExp(`^export (?:interface|type) ${name}\\b`, 'm').test(imports), `src/import/types.ts no longer declares ${name}`).toBe(false);
      // the re-export list, so nothing outside src/import/** had to move
      expect(new RegExp(`^  ${name},$`, 'm').test(imports), `src/import/types.ts re-exports ${name}`).toBe(true);
    }
    // section 3 stays local — the atlas shape and the seams are declared here, not in core
    for (const local of ['SourceSpec', 'RootSpec', 'ImportFs', 'ImportWriteFs', 'ImportClock', 'ImportEnvironment', 'MarkdownDoc', 'ValueShape']) {
      expect(new RegExp(`^export interface ${local}\\b`, 'm').test(imports), `${local} stays in src/import/types.ts`).toBe(true);
      expect(new RegExp(`^export interface ${local}\\b`, 'm').test(core), `${local} is NOT in core`).toBe(false);
    }
  });

  it('the moved shapes compile from core with the bodies they had in src/import/types.ts', () => {
    const item: MemoryItem = {
      name: 'test command',
      description: 'how tests are run here',
      kind: 'project',
      scope: 'project',
      paths: ['src/**/*.ts'],
      trigger: 'paths',
      source: PROVENANCE,
      redacted: 0,
      clipped: 0,
      body: 'Run `npm test`.',
    };
    expect(item.paths).toEqual(['src/**/*.ts']);
    const row: PlanRow = {
      id: 'r1',
      source: { id: 's1', display: '~/.claude/CLAUDE.md', tools: ['claude-code'], sha256: 'b'.repeat(64), bytes: 120, mtimeMs: 1 },
      class: 'memory',
      dest: 'AGENTS.md',
      action: 'append',
      scope: 'project',
      bytes: 120,
      why: 'rule 10 (markdown, headings)',
      warnings: [],
    };
    // §4.6.1: every `skip:*` reason is an ImportAction, so a skipped row needs no second field
    const skipped: ImportAction[] = ['skip:self', 'skip:secret', 'skip:transcript', 'skip:unrelated'];
    expect(skipped.every((a) => a.startsWith('skip:'))).toBe(true);
    const plan: ImportPlan = {
      v: 1,
      importId: 'imp_20260922T000000Z_a1b2c3',
      at: '2026-09-22T00:00:00.000Z',
      jevcodeVersion: '0.0.0',
      workspace: '/ws',
      workspaceKey: '/ws',
      gitRoot: '/ws',
      trust: 'trust',
      roots: [],
      rows: [row],
      budget: { memoryBytes: 0, memoryMax: 1, indexLines: 0, indexMax: 1 },
      jev: { requests: 0, questions: 0, usd: 0, fallbacks: 0 },
      cannotRead: [],
      notices: [],
    };
    expect(plan.rows[0]?.dest).toBe('AGENTS.md');
    const server: McpServerRecord = { transport: 'stdio', command: 'x', enabled: false, source: { tool: 'mcp', path: '~/.mcp.json', sha256: 'c'.repeat(64), importId: plan.importId } };
    const mcp: McpFile = { v: 1, servers: { x: server } };
    // §1 property 16: every imported server arrives disabled — the literal `false` is the type
    expect(mcp.servers['x']?.enabled).toBe(false);
    const manifest: ImportManifest = { v: 1, user: [], workspaces: { '/ws': [{ importId: plan.importId, dest: 'AGENTS.md', sourceSha256: 'b'.repeat(64), destSha256: 'd'.repeat(64), scope: 'project', at: plan.at, by: 'tty' }] } };
    expect(manifest.workspaces['/ws']).toHaveLength(1);
    const probe: ImportProbe = { tools: [{ tool: 'codex', display: '~/.codex', items: 4 }], total: 4, ms: 12, partial: false };
    expect(probe.total).toBe(4);
    const command: ProjectCommand = { name: 'review', description: 'review the diff', path: '.jevcode/commands/review.md', body: 'x', scope: 'project', source: PROVENANCE, executableStripped: 1 };
    expect(command.executableStripped).toBe(1);
  });

  it('the five widenings are members of the real declarations: InstructionRecord, EngineOptions.memory, NoticeKind, RunMeta.imports, CheckpointState.kept[].kind', () => {
    // 1. InstructionRecord += kind?, scope? — the pre-1.6 record still compiles
    const plain: InstructionRecord = { path: 'AGENTS.md', sha256: 'e'.repeat(64), bytes: 10 };
    const memoryRecord: InstructionRecord = { ...plain, path: '.jevcode/memory/testing.md', kind: 'preference', scope: 'project-local' };
    expect([plain.kind, memoryRecord.kind]).toEqual([undefined, 'preference']);
    // 2. EngineOptions.memory?: { index?, rules?, topics? }
    const memory: EngineMemoryOptions = { index: '- testing — how tests run here', rules: [], topics: [] };
    const opts: Pick<EngineOptions, 'memory'> = { memory };
    expect(opts.memory?.index).toContain('testing');
    expect(({} as Pick<EngineOptions, 'memory'>).memory).toBeUndefined();
    // 3. NoticeKind += 'import'
    const kinds: NoticeKind[] = ['orchestration', 'import'];
    const notice: Extract<EngineEvent, { type: 'notice' }> = { type: 'notice', step: null, kind: 'import', level: 'info', text: '[import] active from the next run' };
    expect(kinds).toContain(notice.kind);
    // 4. RunMeta.imports?: readonly string[]
    const imports: Pick<RunMeta, 'imports'> = { imports: ['imp_20260922T000000Z_a1b2c3'] };
    expect(imports.imports).toHaveLength(1);
    expect(({} as Pick<RunMeta, 'imports'>).imports).toBeUndefined();
    // 5. CheckpointState.kept?[].kind += 'memory' (the `kept` row lands with the amendment, CD §8.6 :1504)
    const kept: NonNullable<CheckpointState['kept']> = [
      { kind: 'fact', text: 'f() returns 2', step: 3, by: 'jev' },
      { kind: 'file', text: 'src/a.ts', step: 4, by: 'code' },
      { kind: 'decision', text: 'use pytest', step: 5, by: 'human' },
      { kind: 'memory', text: 'testing — how tests run here', step: 6, by: 'code' },
    ];
    expect(kept.map((k) => k.kind)).toEqual(['fact', 'file', 'decision', 'memory']);
    expect(({} as CheckpointState).kept).toBeUndefined();
  });

  it('ContextUsage.memory is the §2.10.3 counter and is OPTIONAL, so a run without memory reports what it did before', () => {
    const usage: MemoryUsage = {
      indexChars: 512,
      rulesChars: 1_200,
      rulesAllowanceChars: 6_144,
      rulesMatched: 3,
      rulesShown: 3,
      memoryChars: 900,
      memoryAllowanceChars: 8_601,
      memoryMatched: 2,
      memoryShown: 1,
    };
    const withMemory: Pick<ContextUsage, 'memory'> = { memory: usage };
    expect(withMemory.memory?.rulesShown).toBe(3);
    expect(({} as Pick<ContextUsage, 'memory'>).memory).toBeUndefined();
  });
});

describe('contract 1.8 (TUI-DESIGN-5 §8.1 items 1–6, W0)', () => {
  /**
   * §9.3 W5's shared row, and the gate the five per-round header cases above cannot give on their own: the
   * WHOLE header block, in order, in one assertion. Each round's own case checks its neighbour; only this one
   * catches a line inserted out of order two rounds later, or a round whose header was never written at all.
   * The expected sequence is `1.1, 1.2, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9` — **1.2 twice**, because round 2 and
   * the llm-jev generator channel both landed under that number and the duplicate is deliberate (the file says
   * so at `:11`). `CheckpointEnvelope.version` stays 1 through all of it, which is the point of "additive".
   */
  it('the contract header block is contiguous and ascending: 1.1, 1.2, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9', () => {
    const lines = readFileSync(join(ROOT, 'src/core/types.ts'), 'utf8').split('\n');
    const heads = lines.map((l, i) => [i, /^\/\/ contract (\d+\.\d+) \(/.exec(l)?.[1] ?? null] as const).filter((e): e is readonly [number, string] => e[1] !== null);
    expect(heads.map((e) => e[1])).toEqual(['1.1', '1.2', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9']);
    // contiguous: no line between the first and the last that is not itself a contract header
    const first = heads[0]?.[0] ?? -1;
    const last = heads[heads.length - 1]?.[0] ?? -1;
    expect(last - first).toBe(heads.length - 1);
    // every one names its design document and says the envelope version is unchanged
    for (const [i, v] of heads) expect(lines[i], v).toMatch(/docs\/[A-Z0-9-]+\.md/);
    expect(lines.filter((l) => /^\/\/ contract \d+\.\d+ \(/.test(l)).filter((l) => /CheckpointEnvelope\.version/.test(l)).length).toBeGreaterThanOrEqual(6);
  });

  it('header: the 1.8 line sits directly under 1.7 and keeps CheckpointEnvelope.version at 1', () => {
    const lines = readFileSync(join(ROOT, 'src/core/types.ts'), 'utf8').split('\n');
    const i17 = lines.findIndex((l) => l.startsWith('// contract 1.7 (2026-09-22): TUI round 4'));
    const i18 = lines.findIndex((l) => l.startsWith('// contract 1.8 (2026-09-22): TUI round 5'));
    expect(i17).toBeGreaterThan(0);
    expect(i18).toBe(i17 + 1);
    expect(lines[i18]).toContain('docs/TUI-DESIGN-5.md §8');
    expect(lines[i18]).toContain('CheckpointEnvelope.version stays 1');
  });

  it('item 10 renumbering: no `contract 1.6 item` comment in core/types.ts cites a TUI-DESIGN-4 section (1.6 is import)', () => {
    const text = readFileSync(join(ROOT, 'src/core/types.ts'), 'utf8');
    const stale = text.split('\n').filter((l) => /contract 1\.6 item/.test(l) && /TUI-DESIGN-4/.test(l));
    expect(stale).toEqual([]);
    // the eight round-4 items are numbered 1.7, which is what the header at the top of the file calls that round
    expect(text.split('\n').filter((l) => /contract 1\.7 item/.test(l)).length).toBeGreaterThanOrEqual(8);
  });

  it('items 1 and 5 arrived from the harness: BlockingKind carries both panes and ConfirmRequest carries the four manifest fields', () => {
    // item 1 (REQUEST R1, landed at c7087e2 with its four placeholder case lines)
    const kinds: BlockingKind[] = ['lease-conflict', 'land-preflight'];
    expect(kinds).toHaveLength(2);
    const answers: BlockingAnswer[] = ['wait', 'worktree'];
    expect(answers).toHaveLength(2);
    // item 5 (REQUEST R5, landed with contract 1.5) — all four OPTIONAL, so every existing constructor compiles
    const bare = {} as ConfirmRequest;
    expect(bare.title).toBeUndefined();
    expect(bare.headline).toBeUndefined();
    expect(bare.body).toBeUndefined();
    expect(bare.badge).toBeUndefined();
  });

  it('item 2: UiLabel gains the seventh member and ChatLabel is unaffected', () => {
    const label: UiLabel = '[session]';
    expect(label).toBe('[session]');
    // ChatLabel is Extract<UiLabel, '[you]' | '[jevcode]'> — widening UiLabel must not widen it
    const chat: ChatLabel[] = ['[you]', '[jevcode]'];
    expect(chat).toHaveLength(2);
  });

  it('item 3: SessionRow gains three OPTIONAL members, so every pre-round-5 row still satisfies the type', () => {
    const old: SessionRow = { sessionId: 's1', workspace: '/w', title: 't', task60: 't', runs: [], lastUsed: '', createdAt: '', totalUsd: 0, mode: 'llm-jev', branch: null };
    expect(old.ended).toBeUndefined();
    expect(old.parentSessionId).toBeUndefined();
    expect(old.workspaces).toBeUndefined();
    const full: SessionRow = { ...old, ended: { at: '2026-09-22T00:00:00.000Z', by: 'remote' }, parentSessionId: 's0', workspaces: ['/w', '/w2'] };
    expect(full.ended?.by).toBe('remote');
    expect(full.workspaces).toHaveLength(2);
  });

  it('item 4: SessionHost.who?() is optional and its two views carry no coordination secret', () => {
    const host = {} as SessionHost;
    expect(host.who).toBeUndefined();
    const self: SelfIdentityView = { deviceId8: 'a1b2c3d4', label: 'mbp', sameDeviceCount: 2 };
    // §7 row 61: no hostKey, no full deviceId, no lease paths anywhere in the view
    expect(Object.keys(self)).toEqual(['deviceId8', 'label', 'sameDeviceCount']);
    const view: SessionActivityView = {
      runId: 'r1', sessionId: 's1', label: 'mbp', parentSessionId: null, deviceId8: 'a1b2c3d4', sameDevice: false, kind: 'run',
      liveness: 'stale-reused-pid', authority: 'trusted',
      flags: { hung: false, skewed: false, forked: false, takenOver: false, noLock: false, ignoredDevice: false, unverified: false, cloned: false },
      beatAgeMs: 1_200, arrivalAgeMs: 1_100, skewMs: null, syncLagMs: null, sameRepo: true, sameBranch: true, leaseCount: 2,
      step: 3, maxSteps: 20, stage: 'execute', mode: 'llm-jev', branch: 'main', head: '3f9a2c1', ctxPct: 41,
      spend: { totalUsd: 0.12, capUsd: 5 }, editing: ['src/a.ts'], subwork: null, bench: null,
    };
    expect(view.liveness).toBe('stale-reused-pid');
    expect(view.leaseCount).toBe(2);
    expect(Object.keys(view)).not.toContain('leases');
  });

  /**
   * Gate G-R5-8 (§11): the settings-collision lint. **The authority is an EXTERNAL table**, not "every name this
   * document mentions" — `docs/ORCHESTRATION-DESIGN.md` §6.4 (`:1427–1461`) for the 34 `orchestrate.*` keys, and
   * TUI-DESIGN-5 §8.1 item 7 for the `context.*` / `coordination.*` / `import.*` / `memory.*` / `seen.*` names.
   * The draft's wording was vacuous for 32 of the 34 (§14.2 #19): a count cannot catch a misspelling.
   *
   * The `orchestrate.*` list is PARSED OUT OF THE DESIGN FILE rather than copied here, so a row added to OR §6.4
   * and not to `SETTINGS` fails this test with no second edit. `depth` is a constant and `--yes-split` a flag —
   * OR's own table says so in the same rows, and neither is a `Setting` name.
   */
  it('gate G-R5-8: every key of ORCHESTRATION-DESIGN §6.4 and of §8.1 item 7 has a SETTINGS row, claimed once', () => {
    const or = readFileSync(join(ROOT, 'docs/ORCHESTRATION-DESIGN.md'), 'utf8');
    // one row per key: `| `orchestrate.<name>` | …`, skipping the struck-through `~~orchestrate.commitNoVerify~~`
    const fromDesign = [...or.matchAll(/^\|\s*`(orchestrate\.[A-Za-z]+)`\s*\|/gm)].map((m) => m[1] as string);
    expect(new Set(fromDesign).size, 'OR §6.4 lists each orchestrate key once').toBe(fromDesign.length);
    expect(fromDesign).toHaveLength(34);
    const names = new Set(SETTINGS.map((sp) => sp.name as string));
    for (const key of fromDesign) expect(names.has(key), `${key} has no SETTINGS row`).toBe(true);
    // §8.1 item 7's own five groups, verbatim
    const item7 = [
      'context.mode', 'context.compaction', 'context.kept', 'context.compactEvery', 'context.budgetChars',
      'import.enabled', 'import.scope', 'import.sources', 'memory.enabled', 'memory.path', 'seen.import',
      'coordination.claims', 'coordination.remoteControl', 'coordination.sync', 'coordination.syncRuns', 'coordination.notify', 'coordination.maxChildren',
    ];
    for (const key of item7) expect(names.has(key), `${key} has no SETTINGS row`).toBe(true);
    // the collision half: no two slots claimed one name, and no two rows share an env variable or a file key
    expect(names.size).toBe(SETTINGS.length);
    const envs = SETTINGS.flatMap((sp) => [...sp.env, ...(sp.negateEnv ?? [])]);
    expect(new Set(envs).size, 'two settings share an env variable').toBe(envs.length);
    const fileKeys = SETTINGS.map((sp) => sp.fileKey).filter((k): k is string => k !== undefined);
    expect(new Set(fileKeys).size, 'two settings share a config-file key').toBe(fileKeys.length);
    // every round-5 row is printable, non-secret, and not a launch setting (§8.3)
    const round5 = SETTINGS.filter((sp) => /^(orchestrate|coordination|import|memory)\./.test(sp.name) || sp.name === 'context.kept' || sp.name === 'seen.import');
    expect(round5).toHaveLength(34 + 6 + 5 + 2);
    for (const sp of round5) {
      expect(sp.secret, sp.name).toBe(false);
      expect(sp.launch, sp.name).toBeUndefined();
      expect(sp.description.length, sp.name).toBeGreaterThan(0);
    }
    // §4.8: `depth` is a CONSTANT and `--yes-split` a FLAG — neither may appear as a setting
    expect(names.has('orchestrate.depth')).toBe(false);
    expect(names.has('orchestrate.yesSplit')).toBe(false);
    // the every-env-name rule of §4.8: `JEVCODE_ORCHESTRATE_<SCREAMING_SNAKE>`
    for (const sp of SETTINGS.filter((x) => x.name.startsWith('orchestrate.'))) {
      const screaming = sp.name.slice('orchestrate.'.length).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
      expect(sp.env, sp.name).toEqual([`JEVCODE_ORCHESTRATE_${screaming}`]);
    }
  });

  it('item 6: ProviderName and GeneratorConfig.provider are every ProviderId, and the old two stay valid', () => {
    const names: ProviderName[] = [...PROVIDER_IDS, 'mock'];
    expect(names).toHaveLength(8);
    expect(names).toContain('anthropic');
    expect(names).toContain('openrouter');
    for (const id of PROVIDER_IDS) {
      const cfg: Pick<GeneratorConfig, 'provider'> = { provider: id };
      expect(isProviderId(cfg.provider)).toBe(true);
    }
  });
});
