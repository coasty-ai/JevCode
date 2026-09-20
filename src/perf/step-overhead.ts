/**
 * Harness overhead per step (DESIGN.md §12): the engine in-process with a mock provider and
 * mock decider at zero latency, a 5,000-file git fixture plus a 5,000-file node_modules to
 * skip, 50 steps whose trajectory includes `run` actions (cache invalidation path).
 * harnessMs = StepRecord.timing.harnessMs from step:end events. Gate: p95 < 50 ms.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Confirmer, EngineOptions } from '../core/types.js';
import { percentile } from '../core/time.js';
import { mockTrajectory } from '../cli/mock-trajectory.js';

export interface StepOverheadResult {
  steps: number;
  harnessMs: number[];
  p50: number | null;
  p95: number | null;
  pass: boolean;
  gateMs: number;
}

const neverAsked: Confirmer = { identity: 'perf', confirm: async () => false };

export async function measureStepOverhead(opts: { steps: number; gateMs?: number }): Promise<StepOverheadResult> {
  const gateMs = opts.gateMs ?? 50;
  const ws = mkdtempSync(join(tmpdir(), 'jevcode-perf-ws-'));
  const runs = mkdtempSync(join(tmpdir(), 'jevcode-perf-runs-'));
  try {
    for (let d = 0; d < 70; d++) {
      mkdirSync(join(ws, 'src', `pkg${d}`), { recursive: true });
      for (let f = 0; f < 72; f++) writeFileSync(join(ws, 'src', `pkg${d}`, `mod${f}.py`), `# module ${d}/${f}\nVALUE = ${f}\n`);
    }
    for (let d = 0; d < 50; d++) {
      mkdirSync(join(ws, 'node_modules', `dep${d}`), { recursive: true });
      for (let f = 0; f < 100; f++) writeFileSync(join(ws, 'node_modules', `dep${d}`, `f${f}.js`), `module.exports=${f};\n`);
    }
    writeFileSync(join(ws, '.gitignore'), 'node_modules/\n');
    spawnSync('git', ['init', '-q'], { cwd: ws });
    spawnSync('git', ['-c', 'user.email=perf@jevcode', '-c', 'user.name=perf', 'add', '-A'], { cwd: ws });
    spawnSync('git', ['-c', 'user.email=perf@jevcode', '-c', 'user.name=perf', 'commit', '-qm', 'fixture'], { cwd: ws });

    const { createMockProvider } = await import('../provider/mock.js');
    const { createMockDecider } = await import('../jev/mock.js');
    const { createSpendMeter } = await import('../spend/meter.js');
    const { createEngine } = await import('../loop/engine.js');
    const { patternRedact } = await import('../core/redact.js');
    const turns = mockTrajectory(opts.steps + 1);
    turns.pop(); // drop the trailing `done`; the mock decider keeps the run going until max_steps
    const engineOpts: EngineOptions = {
      task: 'perf: exercise the loop with scratch files',
      mode: 'jev-on',
      workspace: ws,
      runsDir: runs,
      provider: createMockProvider({ turns: (_req, i) => turns[i % turns.length]! }),
      decider: createMockDecider({ rules: [({ questions }) => ('task_complete' in questions ? { task_complete: { type: 'noul', noul: 0.05 } } : undefined)] }),
      confirmer: neverAsked,
      meter: createSpendMeter(1000),
      limits: { maxSteps: opts.steps, maxWallMs: 600_000, maxReplans: 50, completeThreshold: 0.85, impossibleThreshold: 0.85, commandTimeoutMs: 30_000, maxCommandTimeoutMs: 60_000, maxOutputBytes: 200_000, spendCapUsd: 1000 },
      sandboxProfile: 'none',
      noNetwork: true,
      configRecord: {},
      redact: patternRedact,
      secretPaths: [],
      generation: { temperature: null, maxTokens: 4096 },
      deciderModel: { configured: 'typesafe/jev-1.13-20260917', pinned: true },
    };
    const engine = await createEngine(engineOpts);
    const harnessMs: number[] = [];
    engine.events.on('step:end', (e) => harnessMs.push(e.record.timing.harnessMs));
    await engine.run();
    const p95 = percentile(harnessMs, 95);
    return { steps: harnessMs.length, harnessMs, p50: percentile(harnessMs, 50), p95, pass: p95 !== null && p95 < gateMs && harnessMs.length >= Math.min(opts.steps, 10), gateMs };
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(runs, { recursive: true, force: true });
  }
}
