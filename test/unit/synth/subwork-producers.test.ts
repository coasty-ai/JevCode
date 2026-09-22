/**
 * contract 1.4 (W3), COORDINATION-DESIGN §6 / §3.3 / W3 item 28 — the sub-work PRODUCERS.
 *
 * The heartbeat has carried `subwork` rows (≤ 16, `subworkStarted` / `subworkEnded` on `CoordinationRuntime`) since
 * W2b and nothing under `src/synth/**` wrote one. These are the three that do: an llm-jev sample (`sample`,
 * `goalId:round:sampleIx`), a sieve lane run (`lane`, the lane's key) and a perturbation probe (`probe`).
 *
 * The fake runtime below is the real bookkeeping (`mergeSubwork` / `removeSubwork` capped at `SUBWORK_MAX`) over an
 * array, so "the count never exceeds 16 live rows" is a statement about the rows a peer would actually read rather
 * than about a counter this test keeps. The other half of the property is the absence: with `ctx.coordination`
 * undefined every producer is a `?.` that allocates nothing, which is what keeps jev-only and the legacy paths
 * byte-identical — asserted by running the same producers with no hook and comparing the results.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SubworkEntry, SynthSubwork } from '../../../src/core/types.js';
import { mergeSubwork, removeSubwork } from '../../../src/coordination/index.js';
import { SUBWORK_MAX } from '../../../src/loop/coordination.js';
import { createLanes, laneKey, type LaneContext, type LanePool } from '../../../src/synth/sieve/lanes.js';
import { createLaneProbe, probeSubworkId } from '../../../src/synth/search/perturb.js';
import type { Lane, VerifyOutcome } from '../../../src/synth/search/types.js';
import { createLlmSource, sampleSubworkId } from '../../../src/synth/llm/source.js';
import { candidate, fakeSandbox, GCD_BUGGY, oracle, site, sourceFile } from './sieve/helpers.js';
import { applyCandidate } from '../../../src/synth/verify/apply.js';
import { calcFiles, proposeFixCall, scriptedGenerate, type HunkIn } from './llm/fixtures.js';
import { listingSet } from '../../../src/synth/llm/prompt.js';
import type { LlmBudget, LlmFireInput } from '../../../src/synth/llm/source.js';

/** The runtime's own rows, over an array: `mergeSubwork` then the `SUBWORK_MAX` slice, `removeSubwork` to close. */
function fakeRuntime(): { hook: SynthSubwork; rows: () => readonly SubworkEntry[]; log: string[]; maxLive: () => number } {
  let rows: SubworkEntry[] = [];
  const kinds = new Map<string, SubworkEntry['kind']>();
  const log: string[] = [];
  let maxLive = 0;
  const hook: SynthSubwork = {
    subworkStarted: (e) => {
      kinds.set(e.id, e.kind);
      log.push(`start ${e.kind} ${e.id}`);
      rows = mergeSubwork(rows, { kind: e.kind, id: e.id.slice(0, 40), since: new Date(0).toISOString(), stage: e.stage.slice(0, 20), detail60: e.detail.slice(0, 60), ...(e.laneDir === undefined ? {} : { laneDir: e.laneDir }) }).slice(0, SUBWORK_MAX);
      maxLive = Math.max(maxLive, rows.length);
    },
    subworkEnded: (id) => {
      const kind = kinds.get(id);
      if (kind === undefined) return;
      kinds.delete(id);
      log.push(`end ${kind} ${id}`);
      rows = removeSubwork(rows, kind, id.slice(0, 40));
    },
  };
  return { hook, rows: () => rows, log, maxLive: () => maxLive };
}

describe('§6 the `lane` producer', () => {
  let tmp: string;
  let ws: string;
  let runDir: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jev-subwork-'));
    ws = join(tmp, 'ws');
    runDir = join(tmp, 'run');
    mkdirSync(ws);
    mkdirSync(runDir);
    writeFileSync(join(ws, 'gcd.py'), GCD_BUGGY);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const ctxFor = (over: Partial<LaneContext> = {}): LaneContext => ({
    runDir,
    sandbox: fakeSandbox(),
    signal: new AbortController().signal,
    workspaceInfo: { root: ws, git: false },
    ...over,
  });

  it('opens one row per held lane and closes it when the lane is reset, however the body ended', async () => {
    const rt = fakeRuntime();
    const pool = await createLanes(ctxFor({ coordination: rt.hook }), oracle({ runner: 'quixbugs', lanes: 3 }), { count: 3 });
    const gcd = sourceFile('gcd.py', GCD_BUGGY);
    const fix = applyCandidate(candidate(site(gcd, 5), 'return gcd(b, a % b)'));
    await pool.withLane(async (lane) => {
      // the row is live for exactly as long as the lane is held
      expect(rt.rows().map((r) => [r.kind, r.id])).toEqual([['lane', laneKey(lane)]]);
      expect(rt.rows()[0]?.laneDir).toBe(lane.dir);
      await pool.applyToLane(lane, fix);
    });
    expect(rt.rows()).toEqual([]);
    // a throwing body still closes the row
    await expect(pool.withLane(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(rt.rows()).toEqual([]);
    expect(rt.log.filter((l) => l.startsWith('start')).length).toBe(2);
    expect(rt.log.filter((l) => l.startsWith('end')).length).toBe(2);
    await pool.disposeLanes();
  });

  it('three concurrent lanes are three live rows and never more than the lane count', async () => {
    const rt = fakeRuntime();
    const pool = await createLanes(ctxFor({ coordination: rt.hook }), oracle({ runner: 'quixbugs', lanes: 3 }), { count: 3 });
    let release: () => void = () => undefined;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const running = [0, 1, 2].map(() => pool.withLane(() => hold));
    await Promise.resolve();
    expect(rt.rows()).toHaveLength(3);
    expect(new Set(rt.rows().map((r) => r.id)).size).toBe(3);
    release();
    await Promise.all(running);
    expect(rt.rows()).toEqual([]);
    expect(rt.maxLive()).toBeLessThanOrEqual(SUBWORK_MAX);
    await pool.disposeLanes();
  });

  it('with no hook the pool behaves exactly as before: nothing is called and nothing is allocated', async () => {
    const pool = await createLanes(ctxFor(), oracle({ runner: 'quixbugs', lanes: 2 }), { count: 2 });
    const seen: number[] = [];
    await Promise.all([pool.withLane((l) => Promise.resolve(seen.push(l.index))), pool.withLane((l) => Promise.resolve(seen.push(l.index)))]);
    expect(seen).toHaveLength(2);
    await pool.disposeLanes();
  });
});

describe('§6 the `probe` producer', () => {
  /** The pool as `createLaneProbe` uses it: acquire, apply, resolve a path. One lane, so the probes serialise. */
  function fakePool(): LanePool {
    const lane: Lane = { index: 0, dir: '/tmp/lane0', mode: 'candidate_file', busy: false };
    return {
      mode: 'candidate_file',
      lanes: [lane],
      workspaceRoot: '/ws',
      pathInLane: (_l, rel) => join('/tmp/lane0', rel),
      withLane: (fn) => fn(lane),
      applyToLane: () => Promise.resolve(),
      resetLane: () => Promise.resolve(),
      disposeLanes: () => Promise.resolve(),
    };
  }

  /** Only `applied.candidate.id` and `job.base.files` are read by the probe; the rest of a VerifyOutcome is not. */
  const outcome = (id: string): VerifyOutcome => ({ applied: { candidate: { id } }, job: { base: { files: new Map() } } }) as unknown as VerifyOutcome;

  it('opens one `probe` row per candidate and closes it even when the probe process gives nothing', async () => {
    const rt = fakeRuntime();
    const live: number[] = [];
    const sandbox = {
      run: () => {
        live.push(rt.rows().length);
        return Promise.resolve({ ok: true, exitCode: 0, stdout: 'no protocol line', stderr: '', durationMs: 1, killedBy: null, truncated: false });
      },
    };
    const probe = createLaneProbe({ sandbox, signal: new AbortController().signal, coordination: rt.hook } as unknown as Parameters<typeof createLaneProbe>[0], fakePool(), 'gcd', 100);
    await probe([outcome('c1'), outcome('c2')], []);
    expect(rt.log).toContain(`start probe ${probeSubworkId('c1')}`);
    expect(rt.log).toContain(`end probe ${probeSubworkId('c2')}`);
    // the row was live while the process ran, and none is left behind
    expect(Math.max(...live)).toBeGreaterThan(0);
    expect(rt.rows()).toEqual([]);
    expect(rt.maxLive()).toBeLessThanOrEqual(SUBWORK_MAX);
  });

  it('with no hook the probe is unchanged', async () => {
    const sandbox = { run: () => Promise.resolve({ ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1, killedBy: null, truncated: false }) };
    const probe = createLaneProbe({ sandbox, signal: new AbortController().signal } as unknown as Parameters<typeof createLaneProbe>[0], fakePool(), 'gcd', 100);
    expect(await probe([outcome('c1')], [])).toEqual(new Map());
  });
});

describe('§6 the `sample` producer', () => {
  const files = calcFiles();
  const listings = listingSet({ files, frames: [{ path: 'src/calc.py', line: 4 }], anchors: [] });
  const FIX: HunkIn[] = [{ old: '    return a + b', new: '    return (a or 0) + b', near_line: 4 }];

  const budget = (over: Partial<LlmBudget> = {}): LlmBudget => ({ roundsLeft: 2, samplesLeft: 8, usdLeft: 1, ...over });
  const fireInput = (b: LlmBudget, over: Partial<LlmFireInput> = {}): LlmFireInput => ({
    goalId: 'g1',
    step: 3,
    round: 1,
    klass: 'quixbugs',
    system: 'sys',
    userFor: (k) => `user ${k}`,
    files,
    listings,
    signal: new AbortController().signal,
    budget: b,
    deadlineMs: 5000,
    ...over,
  });

  it('opens `goalId:round:sampleIx` at fire and closes it at settle, for every sample of the round', async () => {
    const rt = fakeRuntime();
    const gen = scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX]), usage: { inputTokens: 100, outputTokens: 20 } }));
    const src = createLlmSource({ generate: gen.generate, coordination: rt.hook });
    const b = budget();
    src.fire(fireInput(b, { n: 3 }));
    src.release();
    await src.collectAll();
    for (const k of [0, 1, 2]) {
      const id = sampleSubworkId('g1', 1, k);
      expect(rt.log).toContain(`start sample ${id}`);
      expect(rt.log).toContain(`end sample ${id}`);
    }
    // every row is closed, and the live set never passed the cap
    expect(rt.rows()).toEqual([]);
    expect(rt.maxLive()).toBeLessThanOrEqual(SUBWORK_MAX);
    expect(rt.maxLive()).toBeGreaterThan(0);
  });

  it('a sample the provider never served still closes its row', async () => {
    const rt = fakeRuntime();
    const gen = scriptedGenerate(() => ({ text: 'no tool call' }));
    const src = createLlmSource({ generate: gen.generate, coordination: rt.hook });
    src.fire(fireInput(budget(), { n: 2 }));
    src.release();
    await src.collectAll();
    expect(rt.rows()).toEqual([]);
    expect(rt.log.filter((l) => l.startsWith('start')).length).toBe(rt.log.filter((l) => l.startsWith('end')).length);
  });

  it('with no hook the round is what it was: the same arrivals and the same accounting', async () => {
    const withHook = fakeRuntime();
    const a = scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX]), usage: { inputTokens: 100, outputTokens: 20 } }));
    const withSrc = createLlmSource({ generate: a.generate, coordination: withHook.hook });
    withSrc.fire(fireInput(budget(), { n: 2 }));
    withSrc.release();
    const withArrivals = await withSrc.collectAll();

    const b = scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX]), usage: { inputTokens: 100, outputTokens: 20 } }));
    const plainSrc = createLlmSource({ generate: b.generate });
    plainSrc.fire(fireInput(budget(), { n: 2 }));
    plainSrc.release();
    const plainArrivals = await plainSrc.collectAll();

    expect(plainArrivals.map((x) => [x.sample, x.status, x.candidates.length])).toEqual(withArrivals.map((x) => [x.sample, x.status, x.candidates.length]));
    expect(plainSrc.round()).toMatchObject({ fired: withSrc.round()!.fired, valid: withSrc.round()!.valid, distinct: withSrc.round()!.distinct });
  });
});
