import { describe, expect, it } from 'vitest';
import type { CheckpointState, ConfigRecordValue, RunLimits, RunMeta, StopReason } from '../../../src/core/types.js';
import { parseCliArgs } from '../../../src/cli/args.js';
import { reconcileResumeConfig, resumeIdentityFromRunMeta, resumeInputsFrom, type ResumeCurrentInputs } from '../../../src/config/resolve.js';

const RUN_ID = '20260919-142301-k7q2m3xa';
const WS = '/private/tmp/ws';

function meta(overrides: Partial<Record<string, string>> = {}, patch: Partial<RunMeta> = {}): RunMeta {
  const values: Record<string, string> = {
    'generator.provider': 'anthropic',
    'generator.model': 'claude-sonnet-5',
    'generator.baseUrl': 'https://api.anthropic.com',
    'decider.model': 'typesafe/jev-1.13-20260917',
    'decider.baseUrl': 'https://openrouter.ai/api/alpha/decisions',
    'limits.spendCapUsd': '2',
    'limits.maxSteps': '40',
    'limits.maxWall': '30m',
    'limits.maxReplans': '5',
    'limits.completeThreshold': '0.9',
    'limits.impossibleThreshold': '0.8',
    sandbox: 'seatbelt',
    ...overrides,
  };
  const config: Record<string, ConfigRecordValue> = {};
  for (const [k, v] of Object.entries(values)) config[k] = { value: v, source: 'default' };
  config['generator.apiKey'] = { value: { source: 'env', fingerprint: 'deadbeef' }, source: 'env' };
  return {
    runId: RUN_ID,
    task: 'fix it',
    workspace: WS,
    mode: 'jev-on',
    config,
    versions: { jevcode: '0.1.0', node: '22.23.2' },
    createdAt: '2026-09-19T00:00:00.000Z',
    overrides: [],
    resumes: [],
    resolvedJevModel: null,
    jevModelDrift: null,
    ...patch,
  };
}

const limits = (p: Partial<RunLimits> = {}): RunLimits => ({
  maxSteps: 40,
  maxWallMs: 30 * 60_000,
  maxReplans: 5,
  completeThreshold: 0.85,
  impossibleThreshold: 0.85,
  commandTimeoutMs: 120_000,
  maxCommandTimeoutMs: 600_000,
  maxOutputBytes: 200 * 1024,
  spendCapUsd: 2,
  ...p,
});

function current(p: Partial<ResumeCurrentInputs> = {}, state: Partial<ResumeCurrentInputs['state']> = {}): ResumeCurrentInputs {
  return { limits: limits(), workspaceRealpath: null, state: { step: 7, spendTotalUsd: 0.5, wallMsUsed: 60_000, replanCount: 1, stopReason: null, ...state }, ...p };
}

const resume = (...extra: string[]) => parseCliArgs(['run', '--resume', RUN_ID, ...extra]);

describe('resumeIdentityFromRunMeta', () => {
  it('reads identity settings from run.json and tolerates missing ones', () => {
    expect(resumeIdentityFromRunMeta(meta())).toEqual({
      task: 'fix it',
      workspace: WS,
      mode: 'jev-on',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      baseUrl: 'https://api.anthropic.com',
      jevModel: 'typesafe/jev-1.13-20260917',
      jevBaseUrl: 'https://openrouter.ai/api/alpha/decisions',
      completeThreshold: 0.9,
      impossibleThreshold: 0.8,
      sandbox: 'seatbelt',
    });
    const sparse = meta({}, { config: { sandbox: { value: 'weird', source: 'flag' } } });
    expect(resumeIdentityFromRunMeta(sparse)).toMatchObject({ provider: null, model: null, jevModel: null, completeThreshold: null, sandbox: null });
  });
});

describe('reconcileResumeConfig', () => {
  it('resumes a crashed run (stopReason null) with identity thresholds and no overrides', () => {
    const r = reconcileResumeConfig(current(), meta(), resume());
    expect(r.errors).toEqual([]);
    expect(r.immediateStop).toBeNull();
    expect(r.overrides).toEqual([]);
    expect(r.limits.completeThreshold).toBe(0.9);
    expect(r.limits.impossibleThreshold).toBe(0.8);
    expect(r.limits.maxSteps).toBe(40);
    expect(r.identity.workspace).toBe(WS);
  });

  it('records every raised or lowered limit as an override at the stored step', () => {
    const r = reconcileResumeConfig(current({ limits: limits({ spendCapUsd: 3, maxSteps: 50, maxWallMs: 3_600_000, maxReplans: 2 }) }), meta(), resume());
    expect(r.overrides).toEqual([
      { setting: 'limits.spendCapUsd', from: '2', to: '3', atStep: 7 },
      { setting: 'limits.maxSteps', from: '40', to: '50', atStep: 7 },
      { setting: 'limits.maxReplans', from: '5', to: '2', atStep: 7 },
      { setting: 'limits.maxWall', from: '30m', to: '1h', atStep: 7 },
    ]);
  });

  it('accepts --workspace only when its realpath equals run.json.workspace', () => {
    const same = reconcileResumeConfig(current({ workspaceRealpath: WS }), meta(), resume('--workspace', '/tmp/ws'));
    expect(same.errors).toEqual([]);
    const other = reconcileResumeConfig(current({ workspaceRealpath: '/private/tmp/other' }), meta(), resume('--workspace', '/tmp/other'));
    expect(other.errors).toHaveLength(1);
    expect(other.errors[0]?.setting).toBe('workspace');
    expect(other.errors[0]?.message).toContain(WS);
    expect(other.errors[0]?.exitCode).toBe(2);
    const missing = reconcileResumeConfig(current({ workspaceRealpath: null }), meta(), resume('--workspace', '/tmp/gone'));
    expect(missing.errors[0]?.message).toContain('does not exist');
  });

  it('--provider / --model / --jev-model must match the stored identity; a matching alias is fine', () => {
    expect(reconcileResumeConfig(current(), meta(), resume('--provider', 'Anthropic', '--model', 'claude-sonnet-5', '--jev-model', 'jev-1.13')).errors).toEqual([]);
    expect(reconcileResumeConfig(current(), meta(), resume('--jev-model', 'TYPESAFE/jev-1.13-20260917')).errors).toEqual([]);
    const r = reconcileResumeConfig(current(), meta(), resume('--provider', 'openrouter', '--model', 'anthropic/claude-sonnet-5', '--jev-model', 'jev-1.13-20261001'));
    expect(r.errors.map((e) => e.setting)).toEqual(['generator.provider', 'generator.model', 'decider.model']);
    expect(r.errors[0]?.message).toMatch(/--provider "openrouter" differs/);
  });

  it('stored complete: refuse without --force, resume with it', () => {
    const refused = reconcileResumeConfig(current({}, { stopReason: 'complete' }), meta(), resume());
    expect(refused.errors).toHaveLength(1);
    expect(refused.errors[0]?.message).toMatch(/already completed; pass --force/);
    expect(refused.immediateStop).toBeNull();
    const forced = reconcileResumeConfig(current({}, { stopReason: 'complete' }), meta(), resume('--force'));
    expect(forced.errors).toEqual([]);
    expect(forced.immediateStop).toBeNull();
  });

  const table: { stop: StopReason; state: Partial<ResumeCurrentInputs['state']>; stillStops: Partial<RunLimits>; raised: Partial<RunLimits>; flag: string }[] = [
    { stop: 'spend_cap', state: { spendTotalUsd: 2.01 }, stillStops: { spendCapUsd: 2 }, raised: { spendCapUsd: 3 }, flag: '--spend-cap' },
    { stop: 'max_steps', state: { step: 40 }, stillStops: { maxSteps: 40 }, raised: { maxSteps: 41 }, flag: '--max-steps' },
    { stop: 'wall_time', state: { wallMsUsed: 30 * 60_000 + 5 }, stillStops: { maxWallMs: 30 * 60_000 }, raised: { maxWallMs: 31 * 60_000 }, flag: '--max-wall' },
    { stop: 'max_replans', state: { replanCount: 5 }, stillStops: { maxReplans: 5 }, raised: { maxReplans: 6 }, flag: '--max-replans' },
  ];
  for (const row of table) {
    it(`stored ${row.stop}: immediate stop unless the limit was raised above the stored value`, () => {
      const stops = reconcileResumeConfig(current({ limits: limits(row.stillStops) }, { ...row.state, stopReason: row.stop }), meta(), resume());
      expect(stops.errors).toEqual([]);
      expect(stops.immediateStop?.reason).toBe(row.stop);
      expect(stops.immediateStop?.message).toContain(row.flag);
      expect(stops.immediateStop?.message).toContain(row.stop);
      const goes = reconcileResumeConfig(current({ limits: limits(row.raised) }, { ...row.state, stopReason: row.stop }), meta(), resume());
      expect(goes.immediateStop).toBeNull();
      expect(goes.overrides).toHaveLength(1);
    });
  }

  it('other stored stop reasons resume normally', () => {
    for (const stop of ['human_abort', 'signal', 'error', 'replan_stop', 'impossible', 'generator_done'] as const) {
      const r = reconcileResumeConfig(current({}, { stopReason: stop }), meta(), resume());
      expect(r.immediateStop).toBeNull();
      expect(r.errors).toEqual([]);
    }
  });

  it('resumeInputsFrom picks the checkpoint fields the stop reasons are compared against', () => {
    const state = {
      step: 12,
      spend: { totalUsd: 1.25 },
      wallMsUsed: 4_000,
      loopDetector: { replanCount: 3 },
      stopReason: 'spend_cap',
    } as unknown as CheckpointState;
    const inputs = resumeInputsFrom({ limits: () => limits({ spendCapUsd: 1 }) }, state, WS);
    expect(inputs).toEqual({ limits: limits({ spendCapUsd: 1 }), workspaceRealpath: WS, state: { step: 12, spendTotalUsd: 1.25, wallMsUsed: 4_000, replanCount: 3, stopReason: 'spend_cap' } });
    const r = reconcileResumeConfig(inputs, meta(), resume('--workspace', '/tmp/ws'));
    expect(r.errors).toEqual([]);
    expect(r.immediateStop?.reason).toBe('spend_cap');
  });

  it('is pure: the same inputs give the same output and inputs are not mutated', () => {
    const m = meta();
    const before = JSON.stringify(m);
    const a = reconcileResumeConfig(current(), m, resume());
    const b = reconcileResumeConfig(current(), m, resume());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(m)).toBe(before);
  });
});
