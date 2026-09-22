/**
 * The plane's accounting and its give-up rules (docs/HARNESS-NEXT-DESIGN.md §3 M6). Nothing here
 * needs an interpreter: what is under test is that every way the warm path can go wrong ends in
 * `null` — the cold path — and is counted, and that the mechanism switches itself off rather
 * than retrying for ever.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ExecResult, Sandbox, SandboxRunOptions } from '../../../../src/core/types.js';
import type { Lane } from '../../../../src/synth/search/types.js';
import { quixbugsTestCommand } from '../../../../src/synth/verify/quixbugs.js';
import { emptyWarmStats, interpreterOf, WARM_MAX_RESTARTS_PER_LANE, WarmPlane, warmDelta, warmModeFor, warmNote } from '../../../../src/synth/warm/index.js';

let tmp: string | null = null;
afterEach(() => {
  if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

/** A sandbox whose every command exits at once: no worker can ever announce itself. */
function deadSandbox(): Sandbox & { runs: string[] } {
  const runs: string[] = [];
  return {
    level: 'none',
    runs,
    async run(command: string, _o: SandboxRunOptions): Promise<ExecResult> {
      runs.push(command);
      return { ok: false, exitCode: 127, signal: null, stdout: '', stderr: 'python3: not found', truncated: false, bytesSeen: 0, killedBy: null, timedOut: false, orphans: [], sandboxExecDenied: false, durationMs: 1 };
    },
    async killAll(): Promise<void> {},
  };
}

function planeOver(sandbox: Sandbox): { plane: WarmPlane; lane: (i: number) => Lane } {
  tmp = mkdtempSync(join(tmpdir(), 'jev-plane-'));
  const runDir = join(tmp, 'run');
  const plane = new WarmPlane({ sandbox, signal: new AbortController().signal, runDir, workspaceRoot: join(tmp, 'ws'), mode: 'quixbugs', interpreter: 'python3' });
  return { plane, lane: (i) => ({ index: i, dir: join(runDir, `tmp/synth/lane${i}`), mode: 'candidate_file', busy: false }) };
}

const CMD = quixbugsTestCommand('/b/quixbugs', 'gcd', '/l/gcd.py');

describe('warmModeFor', () => {
  it('is on for the two Python lane shapes and off for everything else', () => {
    expect(warmModeFor({ runner: 'quixbugs' }, {})).toBe('quixbugs');
    expect(warmModeFor({ runner: 'pytest' }, {})).toBe('pytest');
    expect(warmModeFor({ runner: 'other' }, {})).toBeNull();
  });

  it('JEVCODE_WARM=off restores the cold path, whatever the runner', () => {
    for (const off of ['off', 'OFF', '0', 'false', ' off ']) expect(warmModeFor({ runner: 'quixbugs' }, { JEVCODE_WARM: off })).toBeNull();
    // `on` is not a way to invent a lane shape the server does not implement
    expect(warmModeFor({ runner: 'other' }, { JEVCODE_WARM: 'on' })).toBeNull();
    expect(warmModeFor({ runner: 'quixbugs' }, { JEVCODE_WARM: 'on' })).toBe('quixbugs');
  });

  it('interpreterOf follows the cold command', () => {
    expect(interpreterOf('python -m pytest -q')).toBe('python');
    expect(interpreterOf('python3 -m pytest -q')).toBe('python3');
    expect(interpreterOf("PYTHONDONTWRITEBYTECODE=1 python3 '/b/run_tests.py' gcd /l/gcd.py")).toBe('python3');
  });
});

describe('the plane falls back and gives up rather than retrying for ever', () => {
  it('an unservable command is not even counted as an offer', async () => {
    const sb = deadSandbox();
    const { plane, lane } = planeOver(sb);
    expect(await plane.serve(lane(0), 'python3 -m pytest -q', 1_000)).toBeNull();
    expect(plane.stats().offered).toBe(0);
    expect(sb.runs).toHaveLength(0);
    plane.dispose();
  });

  it('a worker that cannot start is a fallback, and after a few the plane switches itself off', async () => {
    const sb = deadSandbox();
    const { plane, lane } = planeOver(sb);
    for (let i = 0; i <= WARM_MAX_RESTARTS_PER_LANE; i++) expect(await plane.serve(lane(i), CMD, 1_000)).toBeNull();
    expect(plane.disabled).toBe(true);
    expect(plane.stats().disabledReason).toMatch(/no warm worker ever served a command/);
    const attempts = sb.runs.length;
    // disabled is one-way: no further boot is attempted, on any lane
    expect(await plane.serve(lane(7), CMD, 1_000)).toBeNull();
    expect(sb.runs).toHaveLength(attempts);
    plane.dispose();
  }, 30_000);

  it('one screen/confirm mismatch disables the plane for the run', async () => {
    const { plane, lane } = planeOver(deadSandbox());
    expect(plane.disabled).toBe(false);
    plane.mismatch();
    expect(plane.disabled).toBe(true);
    expect(plane.stats().mismatches).toBe(1);
    expect(plane.stats().disabledReason).toBe('screen/confirm mismatch');
    expect(await plane.serve(lane(0), CMD, 1_000)).toBeNull();
    plane.dispose();
  });

  it('two bench directories in one run keep the second cold: the parent holds one run_tests.py', async () => {
    const sb = deadSandbox();
    const { plane, lane } = planeOver(sb);
    await plane.serve(lane(0), quixbugsTestCommand('/b/one', 'gcd', '/l/gcd.py'), 1_000);
    expect(plane.stats().offered).toBe(1);
    await plane.serve(lane(0), quixbugsTestCommand('/b/two', 'gcd', '/l/gcd.py'), 1_000);
    expect(plane.stats().offered).toBe(1);
    plane.dispose();
  });
});

describe('the reported counters', () => {
  it('warmDelta reports the batch, not the run, and keeps the moment the plane went off', () => {
    const before = { ...emptyWarmStats(), offered: 4, screened: 4, screenMs: 20 };
    const after = { ...emptyWarmStats(), offered: 9, screened: 7, screenMs: 55, fallbacks: 2, disabledReason: 'screen/confirm mismatch' };
    const d = warmDelta(before, after);
    expect(d).toMatchObject({ offered: 5, screened: 3, screenMs: 35, fallbacks: 2, disabledReason: 'screen/confirm mismatch' });
    // already off before the batch: the batch did not turn it off
    expect(warmDelta({ ...before, disabledReason: 'x' }, after).disabledReason).toBeNull();
  });

  it('warmNote says nothing when nothing happened, and names every anomaly when it did', () => {
    expect(warmNote(emptyWarmStats())).toBe('');
    expect(warmNote({ ...emptyWarmStats(), offered: 10, screened: 9, screenMs: 61.4, confirmed: 1, confirmMs: 80, fallbacks: 1 })).toBe('; warm 9/10, screen 61 ms, 1 cold confirm 80 ms, 1 fallback');
    const bad = warmNote({ ...emptyWarmStats(), offered: 2, screened: 1, mismatches: 1, restarts: 1, invalidations: 1, scopeUnusable: 3, disabledReason: 'screen/confirm mismatch' });
    expect(bad).toContain('1 screen:mismatch');
    expect(bad).toContain('3 scope_unusable');
    expect(bad).toContain('1 invalidation');
    expect(bad).toContain('warm off: screen/confirm mismatch');
  });
});
