/**
 * TUI-DESIGN §13.6 `EngineOptions.log` (additive, wave-4 polish): the engine writes its notice / warning / error lines to
 * the log handle the controller passes (cli/session.ts hands it the run log), so they reach `<runDir>/jevcode.log` —
 * every `notice` at its level (`seeded`, `ui` from `annotate()`), `transcript` lines at warn+, `error` events and a failed
 * retry chain; pane-only events write nothing; without a log nothing is written and the loop never sees a log failure.
 * Built directly on `createEngine(opts, deps)` with the loop fakes (the fakes' harness picks its `engine` options by name).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Engine, EngineEvent, EngineOptions } from '../../../src/core/types.js';
import type { Log } from '../../../src/core/log.js';
import { createEngine, type EngineDeps } from '../../../src/loop/engine.js';
import { DEFAULT_LIMITS, FIXED_RUN_ID, alwaysDecline, createFakeDecider, createFakeMeter, createFakeProvider, createFakeSandbox, createFakeStore, createFakeWorkspace, noRepoState, turn } from '../loop/fakes.js';

function capturingLog(lines: string[], throwing = false): Log {
  const line = (level: string) => (m: string): void => {
    if (throwing) throw new Error('log sink broken');
    lines.push(`${level} ${m}`);
  };
  return { level: 'info', file: '/dev/null', fellBack: false, error: line('error'), warn: line('warn'), info: line('info'), debug: line('debug'), trace: line('trace'), enabled: () => true, key: () => undefined, paste: () => undefined, flush: () => undefined, close: () => undefined };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function build(log: Log | undefined, extra: Partial<EngineOptions> = {}): Promise<{ engine: Engine; events: EngineEvent[] }> {
  const runsDir = mkdtempSync(join(tmpdir(), 'jevcode-engine-log-'));
  dirs.push(runsDir);
  const store = createFakeStore(join(runsDir, FIXED_RUN_ID));
  const opts: EngineOptions = {
    task: 'Fix f() in src/a.py so that tests/test_a.py passes',
    mode: 'jev-on',
    workspace: runsDir,
    runsDir,
    provider: createFakeProvider([turn({ kind: 'done', summary: 'nothing to do' })]),
    decider: createFakeDecider(),
    confirmer: alwaysDecline,
    meter: createFakeMeter(DEFAULT_LIMITS.spendCapUsd),
    limits: { ...DEFAULT_LIMITS, maxSteps: 2 },
    sandboxProfile: 'none',
    noNetwork: false,
    configRecord: {},
    redact: (s) => s.replaceAll('sk-or-v1-SECRETSECRETSECRETSECRET', '[REDACTED:test]'),
    secretPaths: [],
    generation: { temperature: null, maxTokens: 4096 },
    deciderModel: { configured: 'typesafe/jev-1.13-20260917', pinned: true },
    ...(log ? { log } : {}),
    ...extra,
  };
  const deps: EngineDeps = {
    createCheckpointStore: () => store,
    createWorkspace: async () => createFakeWorkspace({ root: runsDir }),
    createSandbox: () => createFakeSandbox(),
    newRunId: () => FIXED_RUN_ID,
    probeGitState: async () => noRepoState(),
  };
  const engine = await createEngine(opts, deps);
  const events: EngineEvent[] = [];
  engine.events.onAny((e) => events.push(e));
  return { engine, events };
}

const seed = { parentRunId: '20260919-100000-aaaaaaaa', plan: { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [] }, window: [], createdThisRun: [], lastTestRun: null };

describe('EngineOptions.log (§13.6)', () => {
  it('notice lines land at their level (seeded → info, an annotate() warn → warn), redacted; a fatal error is an error line; pane-only events write nothing', async () => {
    const lines: string[] = [];
    const { engine, events } = await build(capturingLog(lines), { seed });
    engine.events.on('run:ready', () => {
      expect(engine.annotate('budget: session cap $10.00 → $15.00 (applies now) sk-or-v1-SECRETSECRETSECRETSECRET', { level: 'warn' })).toBe(true);
    });
    await engine.run();
    expect(lines.filter((l) => l.startsWith('info notice seeded: '))).toHaveLength(1);
    expect(lines).toContain('warn notice ui: budget: session cap $10.00 → $15.00 (applies now) [REDACTED:test]');
    // exactly one run-log line per annotate(): the controller's warnLine() defers to this one while a run is live (session.test.ts)
    expect(lines.filter((l) => l.includes('session cap $10.00'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('SECRETSECRET');
    // pane-only and item events (status, decision, run:start, run:ready, step:end, run:end) are not log lines
    const eventTypes = new Set(events.map((e) => e.type));
    expect(eventTypes.has('status')).toBe(true);
    expect(lines.some((l) => /status|run:ready|run:start|step:end|run:end/.test(l))).toBe(false);
  });

  it('without a log nothing is written and the run is unchanged; a throwing log never reaches the loop', async () => {
    const a = await build(undefined, { seed });
    const ra = await a.engine.run();
    const lines: string[] = [];
    const b = await build(capturingLog(lines, true), { seed });
    const rb = await b.engine.run();
    expect(rb.stopReason).toBe(ra.stopReason);
    expect(lines).toEqual([]);
    expect(b.events.some((e) => e.type === 'notice' && e.kind === 'seeded')).toBe(true);
  });
});
