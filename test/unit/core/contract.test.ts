/**
 * contract 1.2 (docs/TUI-DESIGN-2.md §6, S1 W0): the additive items exist with the shapes §6 spells out. Types have no
 * runtime, so this file is the compile-time proof (`tsc` runs over test/**) plus the few runtime facts the contract makes:
 * every Decider names its provider, `usage.cost` is optional on the wire, the header comment records the contract.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AskResult,
  ChatLabel,
  DeciderConfig,
  EngineEvent,
  EngineOptions,
  HistoryStore,
  IntakeKind,
  JevProvider,
  JevProviderSource,
  JevUsage,
  LaunchSettings,
  Renderer,
  ResolvedConfig,
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
