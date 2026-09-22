/**
 * Harness overhead per step (DESIGN.md §12; TUI-DESIGN §18 last row): the engine in-process with a mock provider and
 * mock decider at zero latency, no TUI attached, over a git fixture of 5,000 small files (70 dirs) plus a 5,000-file
 * `node_modules/` that must be skipped. The trajectory is the `--mock` cycle write → read → run → edit, so every
 * fourth step is a `run` action (the cache-invalidation path and the §12.3 pre-image of the dirty set).
 *
 * §12.3 additions: 50 files modified after the fixture commit, 300 KiB each (15 MiB in total — the worst case inside
 * the 200-file / 16 MiB `run` pre-image cap, each under the 1 MiB per-file limit, so all 50 are copied at every `run`
 * step), and one `run` step whose command writes a 60 MiB artefact, which the post-image must record with
 * `hashSkipped: true` (it exceeds the 16 MiB per-step hashing budget) without hashing it. `harnessMs` is
 * `StepRecord.timing.harnessMs` from `step:end` (images are awaited inside `runStep()`, so the gate sees them — the
 * design's choice, D8: `imagesMs` is recorded inside `harnessMs`); `imagesMs` is `StepTiming.imagesMs`. Gate:
 * harnessMs p95 < 50 ms; imagesMs p95 reported against 15 ms. The `run` steps carry the p95 (each copies the 15 MiB
 * dirty set), so their own p95 / p50 are reported as a row of their own: the margin under the gate is theirs, a few
 * milliseconds, and it is load-sensitive — a release number is taken with the 1-minute load ≤ `LOAD_QUIET` (`main.ts`).
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Action, Confirmer, EngineOptions, MockTurn, PlanDraft } from '../core/types.js';
import { percentile } from '../core/time.js';
import { bucketStats, labelStats, stepTimeline, timelineEnabled, type BucketStat } from './timeline.js';

export interface StepOverheadResult {
  steps: number;
  harnessMs: number[];
  p50: number | null;
  p95: number | null;
  /** harnessMs of the `run` steps alone (the 15 MiB pre-image copy happens there; they carry the p95) */
  harnessRun: number[];
  harnessRunP50: number | null;
  harnessRunP95: number | null;
  /** harnessMs of every other step */
  harnessOtherP95: number | null;
  /** imagesMs of every step that took images (pre or post) */
  imagesMs: number[];
  imagesP50: number | null;
  imagesP95: number | null;
  /** imagesMs of the `run` steps alone (the dirty-set copy) */
  imagesRunP95: number | null;
  imagesTargetMs: number;
  imagesWithinTarget: boolean;
  /** the 60 MiB artefact step's post image carries hashSkipped: true */
  hashSkipped: boolean | null;
  /**
   * docs/COORDINATION-DESIGN.md §8.9 / review D14: the relaxed context's own gates. `promptBuildMs` is
   * `EngineStatus.context.promptBuildMs` — the whole build (file refresh + tier plan + assembly) on the WARM path — and
   * `coldPromptBuildMs` is the first build after `--resume`, when none of the output files has been read yet.
   */
  promptBuildMs: number[];
  promptBuildP50: number | null;
  promptBuildP95: number | null;
  promptBuildGateMs: number;
  promptBuildWithinGate: boolean;
  coldPromptBuildMs: number | null;
  coldGateMs: number;
  coldWithinGate: boolean;
  /** what the tier ladder did at the last build (§8.2(c)) */
  recentSteps: { whole: number; clipped: number; oneLine: number; reads: number } | null;
  artefactStep: number;
  dirtyFiles: number;
  dirtyBytes: number;
  pass: boolean;
  gateMs: number;
  /**
   * HARNESS-NEXT-DESIGN §4.4 / §6 S0: where the step's wall went, per bucket and per label — only with
   * `JEVCODE_TIMELINE` set, because the recorder would otherwise be measuring itself inside the gated number. This
   * is the readout that says whether a harness p95 is images, lane spawns, the decider double or the engine.
   */
  timeline: { buckets: BucketStat[]; labels: BucketStat[] } | null;
}

const neverAsked: Confirmer = { identity: 'perf', confirm: async () => false };
const DIRTY_FILES = 50;
const DIRTY_FILE_BYTES = 300 * 1024;
const ARTEFACT_MIB = 60;

function turn(goal: string, action: Action, plan: PlanDraft): MockTurn {
  return {
    text: `${goal}\n`,
    toolCall: { name: 'propose_action', input: { goal, action: action as unknown as Record<string, string>, plan } as never, rawJson: JSON.stringify({ goal, action, plan }) },
    usage: { inputTokens: 1200, outputTokens: 150, costUsd: 0, calls: 1 },
  };
}

/** The `--mock` cycle (write → read → run → edit) with the `run` of cycle `artefactCycle` writing the 60 MiB artefact. */
function trajectory(steps: number, artefactStep: number): MockTurn[] {
  const turns: MockTurn[] = [];
  const remaining = ['create the scratch module', 'exercise it', 'verify with a command'];
  for (let i = 0; i < steps; i++) {
    const k = i % 4;
    const plan: PlanDraft = { done: [], remaining, openProblems: [] };
    if (k === 0) turns.push(turn(`Create scratch_${i}.py`, { kind: 'write', path: `scratch_${i}.py`, content: `VALUE_${i} = ${i}\n` }, plan));
    else if (k === 1) turns.push(turn(`Read scratch_${i - 1}.py`, { kind: 'read', paths: [`scratch_${i - 1}.py`] }, plan));
    else if (k === 2) {
      if (i + 1 === artefactStep) turns.push(turn('Produce the build artefact', { kind: 'run', command: `head -c ${ARTEFACT_MIB * 1024 * 1024} /dev/zero > artefact.bin` }, plan));
      else turns.push(turn('Check the shell works', { kind: 'run', command: `printf 'ok %s\\n' ${i}` }, plan));
    } else turns.push(turn(`Edit scratch_${i - 3}.py`, { kind: 'edit', path: `scratch_${i - 3}.py`, old: `VALUE_${i - 3} = ${i - 3}`, new: `VALUE_${i - 3} = ${i}` }, plan));
  }
  return turns;
}

function readHashSkipped(runsDir: string, step: number): boolean | null {
  // post/<step>.json lives under <runsDir>/<runId>/; there is exactly one run
  try {
    const runs = spawnSync('ls', [runsDir], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    for (const id of runs) {
      const p = join(runsDir, id, 'post', `${step}.json`);
      try {
        const v: unknown = JSON.parse(readFileSync(p, 'utf8'));
        if (typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)['hashSkipped'] === 'boolean') return (v as Record<string, unknown>)['hashSkipped'] as boolean;
      } catch {
        /* next run dir */
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** `EngineStatus.context` until `src/core/types.ts` carries the member (docs/COORDINATION-DESIGN.md §12.0.3). */
interface ContextMeter {
  promptBuildMs: number;
  recentSteps: { whole: number; clipped: number; oneLine: number; reads: number };
}

function meterOf(status: unknown): ContextMeter | null {
  const c = (status as { context?: ContextMeter } | null)?.context;
  return c !== undefined && typeof c.promptBuildMs === 'number' ? c : null;
}

export async function measureStepOverhead(opts: { steps: number; gateMs?: number; imagesTargetMs?: number; promptBuildGateMs?: number; coldGateMs?: number }): Promise<StepOverheadResult> {
  const gateMs = opts.gateMs ?? 50;
  const imagesTargetMs = opts.imagesTargetMs ?? 15;
  // §8.9: `promptBuildMs` p95 < 5 ms warm; §8.3: the first build after a resume opens the output files, budget 25 ms
  const promptBuildGateMs = opts.promptBuildGateMs ?? 5;
  const coldGateMs = opts.coldGateMs ?? 25;
  const ws = mkdtempSync(join(tmpdir(), 'jevcode-perf-ws-'));
  const runs = mkdtempSync(join(tmpdir(), 'jevcode-perf-runs-'));
  // the 60 MiB artefact is written by the `run` of the third cycle (step 11), so nine steps see the plain dirty set first
  const artefactStep = 11;
  try {
    for (let d = 0; d < 70; d++) {
      mkdirSync(join(ws, 'src', `pkg${d}`), { recursive: true });
      for (let f = 0; f < 72; f++) writeFileSync(join(ws, 'src', `pkg${d}`, `mod${f}.py`), `# module ${d}/${f}\nVALUE = ${f}\n`);
    }
    for (let d = 0; d < 50; d++) {
      mkdirSync(join(ws, 'node_modules', `dep${d}`), { recursive: true });
      for (let f = 0; f < 100; f++) writeFileSync(join(ws, 'node_modules', `dep${d}`, `f${f}.js`), `module.exports=${f};\n`);
    }
    mkdirSync(join(ws, 'data'), { recursive: true });
    const blob = Buffer.alloc(DIRTY_FILE_BYTES, 0x61);
    for (let i = 0; i < DIRTY_FILES; i++) writeFileSync(join(ws, 'data', `set${i}.bin`), blob);
    writeFileSync(join(ws, '.gitignore'), 'node_modules/\n');
    spawnSync('git', ['init', '-q'], { cwd: ws });
    spawnSync('git', ['-c', 'user.email=perf@jevcode', '-c', 'user.name=perf', 'add', '-A'], { cwd: ws });
    spawnSync('git', ['-c', 'user.email=perf@jevcode', '-c', 'user.name=perf', 'commit', '-qm', 'fixture'], { cwd: ws });
    // the dirty set: 50 tracked files modified after the commit (300 KiB each, 15 MiB in total)
    const dirty = Buffer.alloc(DIRTY_FILE_BYTES, 0x62);
    let dirtyBytes = 0;
    for (let i = 0; i < DIRTY_FILES; i++) {
      writeFileSync(join(ws, 'data', `set${i}.bin`), dirty);
      dirtyBytes += statSync(join(ws, 'data', `set${i}.bin`)).size;
    }

    const { createMockProvider } = await import('../provider/mock.js');
    const { createMockDecider } = await import('../jev/mock.js');
    const { createSpendMeter } = await import('../spend/meter.js');
    const { createEngine } = await import('../loop/engine.js');
    const { patternRedact } = await import('../core/redact.js');
    const turns = trajectory(opts.steps, artefactStep);
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
    const promptBuildMs: number[] = [];
    let recentSteps: StepOverheadResult['recentSteps'] = null;
    const harnessMs: number[] = [];
    const harnessRun: number[] = [];
    const harnessOther: number[] = [];
    const imagesMs: number[] = [];
    const imagesRun: number[] = [];
    engine.events.on('step:end', (e) => {
      // §8.9: one sample per step, taken after the step's prompt was built (§12.0.3 cadence point 1)
      const meter = meterOf(engine.status());
      if (meter !== null && meter.promptBuildMs > 0) {
        promptBuildMs.push(meter.promptBuildMs);
        recentSteps = meter.recentSteps;
      }
      const isRun = e.record.proposal?.action.kind === 'run';
      harnessMs.push(e.record.timing.harnessMs);
      (isRun ? harnessRun : harnessOther).push(e.record.timing.harnessMs);
      const im = e.record.timing.imagesMs;
      if (im !== undefined) {
        imagesMs.push(im);
        if (isRun) imagesRun.push(im);
      }
    });
    await engine.run();
    // the timeline snapshot is taken HERE, before the §8.3 cold-start engine below runs: `stepTimeline` is a
    // process-wide recorder, so a second engine over the same run dir would append its steps to this snapshot.
    const snap = stepTimeline.snapshot();
    const timeline = timelineEnabled() && snap.steps.length > 0 ? { buckets: bucketStats(snap), labels: labelStats(snap) } : null;
    // §8.3 cold-start row: a second process over the same run dir, where no `outputs/step-n.txt` has been read yet
    let coldPromptBuildMs: number | null = null;
    try {
      const resumed = await createEngine({
        ...engineOpts,
        limits: { ...engineOpts.limits, maxSteps: opts.steps + 1 },
        provider: createMockProvider({ turns: (_req, i) => turns[i % turns.length]! }),
        resume: { runId: engine.runId, force: false },
      });
      let cold: number | null = null;
      resumed.events.on('step:end', () => {
        if (cold === null) cold = meterOf(resumed.status())?.promptBuildMs ?? null;
      });
      await resumed.run();
      coldPromptBuildMs = cold;
    } catch {
      coldPromptBuildMs = null;
    }
    const hashSkipped = readHashSkipped(runs, artefactStep);
    const p95 = percentile(harnessMs, 95);
    const imagesP95 = percentile(imagesMs, 95);
    return {
      steps: harnessMs.length,
      harnessMs,
      p50: percentile(harnessMs, 50),
      p95,
      harnessRun,
      harnessRunP50: percentile(harnessRun, 50),
      harnessRunP95: percentile(harnessRun, 95),
      harnessOtherP95: percentile(harnessOther, 95),
      imagesMs,
      imagesP50: percentile(imagesMs, 50),
      imagesP95,
      imagesRunP95: percentile(imagesRun, 95),
      imagesTargetMs,
      imagesWithinTarget: imagesP95 !== null && imagesP95 < imagesTargetMs,
      hashSkipped,
      promptBuildMs,
      promptBuildP50: percentile(promptBuildMs, 50),
      promptBuildP95: percentile(promptBuildMs, 95),
      promptBuildGateMs,
      promptBuildWithinGate: promptBuildMs.length === 0 || (percentile(promptBuildMs, 95) ?? 0) < promptBuildGateMs,
      coldPromptBuildMs,
      coldGateMs,
      coldWithinGate: coldPromptBuildMs === null || coldPromptBuildMs < coldGateMs,
      recentSteps,
      artefactStep,
      dirtyFiles: DIRTY_FILES,
      dirtyBytes,
      pass: p95 !== null && p95 < gateMs && harnessMs.length >= Math.min(opts.steps, 10) && hashSkipped === true && (promptBuildMs.length === 0 || (percentile(promptBuildMs, 95) ?? 0) < promptBuildGateMs),
      gateMs,
      timeline,
    };
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(runs, { recursive: true, force: true });
  }
}
