/**
 * `warmPlaneFor` — the only production construction site of the warm plane
 * (docs/HARNESS-NEXT-DESIGN.md §3 M6, wave S1). `screen-confirm.test.ts` injects a scripted
 * screen and `runner.test.ts` pins the cold path with `JEVCODE_WARM=off`, so without this file
 * nothing covers the default-on decision itself: which runners get a plane, which interpreter it
 * boots, and that a disabled plane never comes back inside a run.
 *
 * The interpreter is the one defect this file exists for: it is the word the suite command names
 * and nothing else, because a plane booted on another interpreter screens every candidate under
 * the wrong site-packages — and a non-passing screen is never cold-confirmed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { warmPlaneFor, type RunnerContext, type RunnerMemory, type SuiteSpec } from '../../../../src/synth/sieve/runner.js';
import { WARM_ENV_FLAG, type WarmScreen } from '../../../../src/synth/warm/index.js';
import { fakeSandbox, oracle } from './helpers.js';

// 2026-09-22: the warm plane is OFF by default (it wedged llm-jev runs on the merged tree); these cases exercise the
// warm path, so the file opts in for its own duration and restores the caller's environment afterwards.
const PREV_JEVCODE_WARM = process.env['JEVCODE_WARM'];
beforeAll(() => {
  process.env['JEVCODE_WARM'] = 'on';
});
afterAll(() => {
  if (PREV_JEVCODE_WARM === undefined) delete process.env['JEVCODE_WARM'];
  else process.env['JEVCODE_WARM'] = PREV_JEVCODE_WARM;
});


let tmp: string | null = null;
afterEach(() => {
  if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
  delete process.env[WARM_ENV_FLAG];
});

function ctxFor(): RunnerContext {
  tmp = mkdtempSync(join(tmpdir(), 'jev-wiring-'));
  return { runDir: join(tmp, 'run'), sandbox: fakeSandbox(), signal: new AbortController().signal, workspaceInfo: { root: join(tmp, 'ws'), git: false }, step: 1, emit: () => undefined };
}

const spec = (command: string): SuiteSpec => ({ command, workspaceRoot: '/ws' });

/** The plane's private options are not observable, so the interpreter is read off the boot command. */
function bootCommandOf(plane: WarmScreen, ctx: RunnerContext): Promise<string | undefined> {
  const sb = ctx.sandbox as ReturnType<typeof fakeSandbox>;
  return plane.serve({ index: 0, dir: join(ctx.runDir, 'lane0'), mode: 'candidate_file', busy: false }, "PYTHONDONTWRITEBYTECODE=1 python3 '/b/run_tests.py' gcd /l/gcd.py --max-failures 1000", 1_000).then(() => sb.calls.at(-1)?.command);
}

describe('warmPlaneFor', () => {
  it('is on by default for the two Python lane shapes and off for every other runner', () => {
    const ctx = ctxFor();
    const mem: Pick<RunnerMemory, 'warm'> = {};
    expect(warmPlaneFor(ctx, mem, oracle({ runner: 'quixbugs' }), spec("python3 '/b/run_tests.py' gcd /l/gcd.py"))).not.toBeNull();
    expect(mem.warm).toBeDefined();
    const mem2: Pick<RunnerMemory, 'warm'> = {};
    expect(warmPlaneFor(ctx, mem2, oracle({ runner: 'pytest' }), spec('python3 -m pytest -q'))).not.toBeNull();
    const mem3: Pick<RunnerMemory, 'warm'> = {};
    expect(warmPlaneFor(ctx, mem3, oracle({ runner: 'other' }), spec('python3 tests/runtests.py'))).toBeNull();
    expect(mem3.warm).toBeUndefined();
  });

  it('JEVCODE_WARM=off disposes any plane on the memory and returns null', () => {
    const ctx = ctxFor();
    const mem: Pick<RunnerMemory, 'warm'> = {};
    const plane = warmPlaneFor(ctx, mem, oracle({ runner: 'quixbugs' }), spec("python3 '/b/run_tests.py' gcd /l/gcd.py"));
    expect(plane).not.toBeNull();
    process.env[WARM_ENV_FLAG] = 'off';
    expect(warmPlaneFor(ctx, mem, oracle({ runner: 'quixbugs' }), spec("python3 '/b/run_tests.py' gcd /l/gcd.py"))).toBeNull();
    expect(mem.warm).toBeUndefined();
  });

  it('boots the interpreter the suite command names, not a guess — the venv python, not python3', async () => {
    const ctx = ctxFor();
    const mem: Pick<RunnerMemory, 'warm'> = {};
    const plane = warmPlaneFor(ctx, mem, oracle({ runner: 'quixbugs' }), spec("PYTHONDONTWRITEBYTECODE=1 /ws/.venv/bin/python '/b/run_tests.py' gcd /l/gcd.py"));
    expect(plane).not.toBeNull();
    // that plane refuses the `python3` lane command above: a different interpreter is a
    // different environment, and the sieve runs it cold instead
    expect(await bootCommandOf(plane as WarmScreen, ctx)).toBeUndefined();
  });

  it('serves a command whose interpreter matches, and the boot command names that interpreter', async () => {
    const ctx = ctxFor();
    const mem: Pick<RunnerMemory, 'warm'> = {};
    const plane = warmPlaneFor(ctx, mem, oracle({ runner: 'quixbugs' }), spec("PYTHONDONTWRITEBYTECODE=1 python3 '/b/run_tests.py' gcd /l/gcd.py"));
    const boot = await bootCommandOf(plane as WarmScreen, ctx);
    expect(boot).toMatch(/(^|\s)python3\s/);
    expect(boot).toContain('warm_server.py');
    expect(boot).toContain('--mode quixbugs');
  });

  it('a suite command whose interpreter cannot be read off it gets no plane at all', () => {
    const ctx = ctxFor();
    // a console script: `pytest.main()` would run, but on whichever interpreter we happened to boot
    for (const command of ['pytest -q', '/ws/.venv/bin/pytest -q', 'tox -e py311']) {
      const mem: Pick<RunnerMemory, 'warm'> = {};
      expect(warmPlaneFor(ctx, mem, oracle({ runner: 'pytest' }), spec(command)), command).toBeNull();
      expect(mem.warm).toBeUndefined();
    }
  });

  it('the disabled latch is one-way: a plane a mismatch switched off is never handed out again', () => {
    const ctx = ctxFor();
    const mem: Pick<RunnerMemory, 'warm'> = {};
    const plane = warmPlaneFor(ctx, mem, oracle({ runner: 'quixbugs' }), spec("python3 '/b/run_tests.py' gcd /l/gcd.py"));
    plane?.mismatch();
    expect(warmPlaneFor(ctx, mem, oracle({ runner: 'quixbugs' }), spec("python3 '/b/run_tests.py' gcd /l/gcd.py"))).toBeNull();
    // and it is still on the memory, so its counters reach the batch note
    expect(mem.warm?.stats().mismatches).toBe(1);
  });

  it('the same plane is reused across calls of a step (one interpreter per lane, not per batch)', () => {
    const ctx = ctxFor();
    const mem: Pick<RunnerMemory, 'warm'> = {};
    const first = warmPlaneFor(ctx, mem, oracle({ runner: 'pytest' }), spec('python3 -m pytest -q'));
    const again = warmPlaneFor(ctx, mem, oracle({ runner: 'pytest' }), spec('python3 -m pytest -q'));
    expect(again).toBe(first);
  });
});
