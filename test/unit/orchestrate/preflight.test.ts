/**
 * The §3.6 resource pre-flight (ORCHESTRATION-DESIGN §8.2 D2 item 21, corner row 45).
 *
 * Everything is driven through a hand-written `PreflightProbe`: the module under test never touches
 * `node:os`, `statfs` or `du`, which is what makes "disk is full" and "the box has three cores" ordinary
 * unit cases instead of a machine-dependent one. The `helpers.ts` temp repo is deliberately NOT used —
 * `preflight` takes no git seam and reads no file, so a real repository would prove nothing.
 *
 * The discipline this file exists to pin down is the one `split/gate.ts`'s `fits()` already follows: an
 * unmeasurable denominator is UNBOUNDED, never zero. A missing `statfs` must not silently turn a healthy
 * box into `no_split`.
 */
import { describe, expect, it } from 'vitest';

import { FDS_PER_AGENT, FD_MARGIN, nodePreflightProbe, preflight } from '../../../src/orchestrate/preflight.js';
import type { PreflightInput, PreflightLimit, PreflightProbe } from '../../../src/orchestrate/preflight.js';

const GiB = 1024 ** 3;

interface FakeReadings {
  disk?: { freeBytes: number; totalBytes: number } | null;
  mem?: number | null;
  cpu?: number | null;
  repo?: number | null;
  fds?: number | null;
}

/** Defaults are a large, healthy machine: with `want: 3` nothing binds and `reasons` is empty. */
function probeOf(r: FakeReadings = {}): PreflightProbe {
  return {
    diskFree: async () => (r.disk === undefined ? { freeBytes: 500 * GiB, totalBytes: 1000 * GiB } : r.disk),
    freeMemBytes: () => (r.mem === undefined ? 64 * GiB : r.mem),
    availableParallelism: () => (r.cpu === undefined ? 32 : r.cpu),
    repoBytes: async () => (r.repo === undefined ? 1 * GiB : r.repo),
    openFileLimit: () => (r.fds === undefined ? 100_000 : r.fds),
  };
}

function inputOf(over: Partial<PreflightInput> = {}): PreflightInput {
  return { repoRoot: '/repo', want: 3, minFreeBytes: 2 * GiB, agentMemBytes: 3 * GiB, ...over };
}

const limits = (r: { reasons: readonly { limit: PreflightLimit }[] }): PreflightLimit[] => r.reasons.map((x) => x.limit);
const reasonFor = (r: { reasons: readonly { limit: PreflightLimit; allowed: number; text: string }[] }, l: PreflightLimit): { limit: PreflightLimit; allowed: number; text: string } => {
  const found = r.reasons.find((x) => x.limit === l);
  expect(found, `a ${l} reason`).toBeDefined();
  return found!;
};

describe('preflight (§3.6)', () => {
  it('a healthy machine: nothing binds, the answer is `want`, and `reasons` is empty', async () => {
    const r = await preflight(probeOf(), inputOf());
    expect(r.agents).toBe(3);
    expect(r.reduced).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('disk binds alone: repoBytes × agents × 1.1 against free − minFreeBytes', async () => {
    // 4.5 GiB free, a 2 GiB floor and a 1 GiB repo → 2.5 GiB usable / 1.1 GiB per agent = 2
    const r = await preflight(probeOf({ disk: { freeBytes: 4.5 * GiB, totalBytes: 10 * GiB } }), inputOf());
    expect(r.agents).toBe(2);
    expect(r.reduced).toBe(true);
    expect(limits(r)).toEqual(['disk']);
    const disk = reasonFor(r, 'disk');
    expect(disk.allowed).toBe(2);
    expect(disk.text).toBe('disk: 3 agents need 3.3 GB above the 2.0 GB floor; 4.5 GB free — 2 fit');
  });

  it('memory binds alone: floor(freeMemBytes / agentMemBytes)', async () => {
    const r = await preflight(probeOf({ mem: 5 * GiB }), inputOf());
    expect(r.agents).toBe(1);
    expect(limits(r)).toEqual(['memory']);
    const mem = reasonFor(r, 'memory');
    expect(mem.allowed).toBe(1);
    expect(mem.text).toBe('memory: 3 agents need 9.0 GB at 3.0 GB each; 5.0 GB free — 1 fits');
  });

  it('cpu binds alone: availableParallelism() − 1, the one reserved thread being the parent', async () => {
    const r = await preflight(probeOf({ cpu: 3 }), inputOf());
    expect(r.agents).toBe(2);
    expect(limits(r)).toEqual(['cpu']);
    const cpu = reasonFor(r, 'cpu');
    expect(cpu.allowed).toBe(2);
    expect(cpu.text).toBe('cpu: 3 hardware threads, one reserved for the parent — 2 fit');
  });

  it('fds binds alone: (soft RLIMIT_NOFILE − the margin) / the per-agent descriptors', async () => {
    // FD_MARGIN = 128, FDS_PER_AGENT = 4 → a 132 soft limit leaves exactly one agent
    const r = await preflight(probeOf({ fds: FD_MARGIN + FDS_PER_AGENT }), inputOf());
    expect(r.agents).toBe(1);
    expect(limits(r)).toEqual(['fds']);
    const fds = reasonFor(r, 'fds');
    expect(fds.allowed).toBe(1);
    expect(fds.text).toBe(`fds: 3 agents need 12 descriptors of the 132 soft limit less the ${FD_MARGIN} margin — 1 fits`);
  });

  it('two limits bind at once: the minimum wins and BOTH appear, in the fixed disk → memory → cpu → fds order', async () => {
    const r = await preflight(probeOf({ mem: 5 * GiB, cpu: 3 }), inputOf());
    expect(r.agents).toBe(1);
    expect(r.reduced).toBe(true);
    expect(limits(r)).toEqual(['memory', 'cpu']);
    expect(reasonFor(r, 'memory').allowed).toBe(1);
    expect(reasonFor(r, 'cpu').allowed).toBe(2);
  });

  it('all four bind: every one is recorded and the order is disk, memory, cpu, fds', async () => {
    const r = await preflight(probeOf({ disk: { freeBytes: 4.5 * GiB, totalBytes: 10 * GiB }, mem: 5 * GiB, cpu: 3, fds: FD_MARGIN + 2 * FDS_PER_AGENT }), inputOf());
    expect(limits(r)).toEqual(['disk', 'memory', 'cpu', 'fds']);
    expect(r.reasons.map((x) => x.allowed)).toEqual([2, 1, 2, 2]);
    expect(r.agents).toBe(1);
  });

  it('every probe returns null: UNBOUNDED, never zero — `want` survives and four reasons say why', async () => {
    const r = await preflight(probeOf({ disk: null, mem: null, cpu: null, repo: null, fds: null }), inputOf());
    expect(r.agents).toBe(3);
    expect(r.reduced).toBe(false);
    expect(limits(r)).toEqual(['disk', 'memory', 'cpu', 'fds']);
    expect(r.reasons.map((x) => x.text)).toEqual([
      'disk could not be measured; not a limit',
      'memory could not be measured; not a limit',
      'cpu could not be measured; not a limit',
      'fds could not be measured; not a limit',
    ]);
    for (const reason of r.reasons) expect(reason.allowed).toBe(Number.POSITIVE_INFINITY);
  });

  it('a zero, negative or non-finite repoBytes is not a divide-by-zero: disk stops being a limit', async () => {
    for (const repo of [0, -1, -1 * GiB, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = await preflight(probeOf({ repo, disk: { freeBytes: 4.5 * GiB, totalBytes: 10 * GiB } }), inputOf());
      expect(Number.isInteger(r.agents), `repoBytes=${String(repo)} gives an integer`).toBe(true);
      expect(r.agents).toBe(3);
      expect(reasonFor(r, 'disk').text).toBe('disk could not be measured; not a limit');
      expect(reasonFor(r, 'disk').allowed).toBe(Number.POSITIVE_INFINITY);
    }
  });

  it('a non-finite or absurd probe reading never escapes into the count', async () => {
    const r = await preflight(probeOf({ disk: { freeBytes: Number.NaN, totalBytes: Number.NaN }, mem: Number.NaN, cpu: Number.NaN, fds: Number.NaN }), inputOf());
    expect(r.agents).toBe(3);
    expect(Number.isFinite(r.agents)).toBe(true);
    // a soft RLIMIT_NOFILE of "unlimited" arrives as Infinity and is likewise not a limit
    const unlimited = await preflight(probeOf({ fds: Number.POSITIVE_INFINITY }), inputOf());
    expect(unlimited.agents).toBe(3);
    // a zero or negative agentMemBytes / minFreeBytes cannot produce Infinity agents either
    const zeroMem = await preflight(probeOf(), inputOf({ agentMemBytes: 0 }));
    expect(zeroMem.agents).toBe(3);
    const negFloor = await preflight(probeOf(), inputOf({ minFreeBytes: -5 * GiB }));
    expect(negFloor.agents).toBe(3);
    const nanFloor = await preflight(probeOf(), inputOf({ minFreeBytes: Number.NaN }));
    expect(nanFloor.agents).toBe(3);
  });

  it('the result is clamped to `want` however large the machine is', async () => {
    const huge = probeOf({ disk: { freeBytes: 10_000 * GiB, totalBytes: 20_000 * GiB }, mem: 2_000 * GiB, cpu: 512, repo: 1024, fds: 1_048_576 });
    expect((await preflight(huge, inputOf({ want: 1 }))).agents).toBe(1);
    expect((await preflight(huge, inputOf({ want: 2 }))).agents).toBe(2);
    expect((await preflight(huge, inputOf({ want: 7 }))).agents).toBe(7);
    expect((await preflight(huge, inputOf({ want: 7 }))).reduced).toBe(false);
  });

  it('the caller\'s `no_split` band: 1 and 0 are reachable and the count is never negative', async () => {
    // 1: one agent fits
    expect((await preflight(probeOf({ cpu: 2 }), inputOf())).agents).toBe(1);
    // 0: the floor is above the free space, so nothing fits at all
    const none = await preflight(probeOf({ disk: { freeBytes: 1 * GiB, totalBytes: 10 * GiB } }), inputOf());
    expect(none.agents).toBe(0);
    expect(none.reduced).toBe(true);
    expect(reasonFor(none, 'disk').allowed).toBe(0);
    // 0: a single-core box reserves its one thread for the parent
    expect((await preflight(probeOf({ cpu: 1 }), inputOf())).agents).toBe(0);
    // a `want` of 0 or below is not a request for agents, and never a negative answer
    for (const want of [0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = await preflight(probeOf(), inputOf({ want }));
      expect(r.agents, `want=${String(want)}`).toBe(0);
      expect(r.agents).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.agents)).toBe(true);
    }
    // and no probe can push it below zero
    const brutal = await preflight(probeOf({ cpu: 0, fds: 1, mem: 0, disk: { freeBytes: 0, totalBytes: 0 } }), inputOf());
    expect(brutal.agents).toBe(0);
    for (const reason of brutal.reasons) expect(reason.allowed).toBeGreaterThanOrEqual(0);
  });

  it('a fractional `want` is floored, so the count is always an integer', async () => {
    const r = await preflight(probeOf(), inputOf({ want: 3.9 }));
    expect(r.agents).toBe(3);
  });

  it('determinism: the same input twice gives byte-identical reasons', async () => {
    const input = inputOf();
    const a = await preflight(probeOf({ disk: { freeBytes: 4.5 * GiB, totalBytes: 10 * GiB }, mem: 5 * GiB, cpu: 3, fds: 140 }), input);
    const b = await preflight(probeOf({ disk: { freeBytes: 4.5 * GiB, totalBytes: 10 * GiB }, mem: 5 * GiB, cpu: 3, fds: 140 }), input);
    expect(JSON.stringify(a.reasons)).toBe(JSON.stringify(b.reasons));
    expect(a.agents).toBe(b.agents);
  });

  it('the probe is asked once per reading and only for the repo root it was given', async () => {
    const seen: string[] = [];
    const probe: PreflightProbe = {
      diskFree: async (p) => {
        seen.push(`disk:${p}`);
        return { freeBytes: 500 * GiB, totalBytes: 1000 * GiB };
      },
      freeMemBytes: () => {
        seen.push('mem');
        return 64 * GiB;
      },
      availableParallelism: () => {
        seen.push('cpu');
        return 32;
      },
      repoBytes: async (p) => {
        seen.push(`repo:${p}`);
        return GiB;
      },
      openFileLimit: () => {
        seen.push('fds');
        return 100_000;
      },
    };
    await preflight(probe, inputOf({ repoRoot: '/some/repo' }));
    expect(seen.sort()).toEqual(['cpu', 'disk:/some/repo', 'fds', 'mem', 'repo:/some/repo']);
  });
});

describe('nodePreflightProbe', () => {
  it('is an object with five callable members (a smoke case; the real machine is not asserted on)', () => {
    const probe = nodePreflightProbe();
    expect(typeof probe).toBe('object');
    for (const key of ['diskFree', 'freeMemBytes', 'availableParallelism', 'repoBytes', 'openFileLimit'] as const) {
      expect(typeof probe[key], key).toBe('function');
    }
    expect(Object.keys(probe).sort()).toEqual(['availableParallelism', 'diskFree', 'freeMemBytes', 'openFileLimit', 'repoBytes']);
  });
});
