/**
 * Command → warm request mapping and response parsing (docs/HARNESS-NEXT-DESIGN.md §3 M6).
 * The mapping is the plane's whole safety surface on the way in: anything it does not reproduce
 * exactly must be refused, because a mis-parsed command would be answered with the wrong run.
 */
import { describe, expect, it } from 'vitest';

import { interpreterFor, parseResponse, pytestRequestFor, quixbugsRequestFor, requestFor, WARM_OUTPUT_BYTES } from '../../../../../src/jev-modes/synth/warm/index.js';
import { RUN_OUTPUT_BYTES } from '../../../../../src/jev-modes/synth/sieve/runner.js';
import { quixbugsTestCommand } from '../../../../../src/jev-modes/synth/verify/quixbugs.js';

describe('quixbugsRequestFor', () => {
  it('maps the command the sieve actually builds, flags and all', () => {
    const cmd = quixbugsTestCommand('/b/quixbugs', 'gcd', '/lane0/gcd.py', { timeoutSec: 0.5, slow: true });
    expect(quixbugsRequestFor(cmd)).toEqual({ kind: 'quixbugs', dir: '/b/quixbugs', name: 'gcd', path: '/lane0/gcd.py', maxFailures: 1000, timeout: 0.5, slow: true });
    expect(quixbugsRequestFor(quixbugsTestCommand('/b/quixbugs', 'kth', '/lane0/kth.py'))).toEqual({ kind: 'quixbugs', dir: '/b/quixbugs', name: 'kth', path: '/lane0/kth.py', maxFailures: 1000 });
  });

  it('accepts the unit suffixes run_tests.py accepts', () => {
    expect(quixbugsRequestFor("python3 '/b/run_tests.py' gcd /l/gcd.py --timeout 500ms")?.timeout).toBe(0.5);
    expect(quixbugsRequestFor("python3 '/b/run_tests.py' gcd /l/gcd.py --timeout 2s")?.timeout).toBe(2);
  });

  it('refuses anything it would not reproduce exactly', () => {
    // a flag the warm server does not implement
    expect(quixbugsRequestFor("python3 '/b/run_tests.py' gcd /l/gcd.py --jobs 2")).toBeNull();
    expect(quixbugsRequestFor("python3 '/b/run_tests.py' gcd /l/gcd.py --timeout-ms 500")).toBeNull();
    // a second program on the line, a redirection, a pipe, a substitution
    expect(quixbugsRequestFor("python3 '/b/run_tests.py' gcd /l/gcd.py && rm -rf /")).toBeNull();
    expect(quixbugsRequestFor("python3 '/b/run_tests.py' gcd /l/gcd.py > out.txt")).toBeNull();
    expect(quixbugsRequestFor("python3 '/b/run_tests.py' gcd $(echo /l/gcd.py)")).toBeNull();
    // a nonsense per-case limit
    expect(quixbugsRequestFor("python3 '/b/run_tests.py' gcd /l/gcd.py --timeout 0")).toBeNull();
    // not the QuixBugs runner at all
    expect(quixbugsRequestFor('python3 -m pytest -q')).toBeNull();
    expect(quixbugsRequestFor("ruby '/b/run_tests.py' gcd /l/gcd.py")).toBeNull();
  });
});

describe('pytestRequestFor', () => {
  it('maps `python -m pytest`, keeping the argv verbatim', () => {
    expect(pytestRequestFor('python3 -m pytest -q')).toEqual({ kind: 'pytest', args: ['-q'] });
    expect(pytestRequestFor('python -m pytest -q tests/test_a.py tests/test_b.py')).toEqual({ kind: 'pytest', args: ['-q', 'tests/test_a.py', 'tests/test_b.py'] });
    expect(pytestRequestFor("/ws/.venv/bin/python -m pytest -q 'tests/test a.py'")).toEqual({ kind: 'pytest', args: ['-q', 'tests/test a.py'] });
    expect(pytestRequestFor('PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q')).toEqual({ kind: 'pytest', args: ['-q'] });
  });

  it('refuses a console-script head: the interpreter behind `pytest` is only knowable from its shebang', () => {
    // `pytest.main()` would reproduce the run, but on whichever interpreter the plane booted —
    // a different site-packages is a different verdict, and a non-passer is never cold-confirmed
    expect(pytestRequestFor('pytest -q')).toBeNull();
    expect(pytestRequestFor('/ws/.venv/bin/pytest -q')).toBeNull();
    expect(pytestRequestFor('py.test -q')).toBeNull();
  });

  it('refuses a different module, a shell line and the other runners', () => {
    expect(pytestRequestFor('python3 -m unittest discover -v')).toBeNull();
    expect(pytestRequestFor('python3 tests/runtests.py --parallel 1')).toBeNull();
    expect(pytestRequestFor('python3 bin/test')).toBeNull();
    expect(pytestRequestFor('python3 -m pytest -q | tee log')).toBeNull();
    expect(pytestRequestFor('npm test')).toBeNull();
  });

  it('requestFor dispatches on the plane mode, never across it', () => {
    const qb = quixbugsTestCommand('/b/quixbugs', 'gcd', '/l/gcd.py');
    expect(requestFor('quixbugs', qb)?.kind).toBe('quixbugs');
    expect(requestFor('pytest', qb)).toBeNull();
    expect(requestFor('pytest', 'python3 -m pytest -q')?.kind).toBe('pytest');
    expect(requestFor('quixbugs', 'python3 -m pytest -q')).toBeNull();
  });
});

describe('interpreterFor', () => {
  it('is the word the command names, verbatim — never guessed from the line', () => {
    expect(interpreterFor('pytest', 'python3 -m pytest -q')).toBe('python3');
    expect(interpreterFor('pytest', 'python -m pytest -q')).toBe('python');
    expect(interpreterFor('pytest', '/ws/.venv/bin/python -m pytest -q')).toBe('/ws/.venv/bin/python');
    expect(interpreterFor('pytest', 'python3.11 -m pytest -q')).toBe('python3.11');
    expect(interpreterFor('quixbugs', quixbugsTestCommand('/b/quixbugs', 'gcd', '/l/gcd.py'))).toBe('python3');
    expect(interpreterFor('quixbugs', "PYTHONDONTWRITEBYTECODE=1 /ws/.venv/bin/python '/b/run_tests.py' gcd /l/gcd.py")).toBe('/ws/.venv/bin/python');
  });

  it('is null for everything the plane cannot serve — including the shapes the old regex called `python3`', () => {
    for (const cmd of ['pytest -q', '/ws/.venv/bin/pytest -q', 'npm test', 'python3 -m unittest discover', 'python3 -m pytest -q | tee log']) {
      expect(interpreterFor('pytest', cmd), cmd).toBeNull();
    }
    expect(interpreterFor('quixbugs', 'python3 -m pytest -q')).toBeNull();
  });
});

describe('the warm output budget', () => {
  it('is the sieve\'s own RUN_OUTPUT_BYTES: a warm run is truncated exactly where its cold twin is', () => {
    expect(WARM_OUTPUT_BYTES).toBe(RUN_OUTPUT_BYTES);
  });
});

describe('parseResponse', () => {
  it('reads a run result', () => {
    expect(parseResponse('{"id":3,"ok":true,"stdout":"{}","stderr":"e","exit":1,"timedOut":false,"ms":4.5}')).toEqual({
      kind: 'ok',
      id: 3,
      result: { stdout: '{}', stderr: 'e', exitCode: 1, timedOut: false, truncated: false, durationMs: 4.5 },
    });
    // the cap the worker enforces is reported, so a truncated warm run is recognisable as one
    const capped = parseResponse('{"id":4,"ok":true,"stdout":"x","exit":1,"truncated":true,"ms":1}');
    expect(capped.kind === 'ok' ? capped.result.truncated : 'not a run').toBe(true);
  });

  it('a missing stdout is the ping answer, not a run', () => {
    expect(parseResponse('{"id":1,"ok":true,"pid":9}')).toEqual({ kind: 'ready', id: 1 });
  });

  it('an invalidation and an error are distinct, and garbage is an error (never a pass)', () => {
    expect(parseResponse('{"id":2,"ok":false,"invalidate":"/ws/a.py"}')).toEqual({ kind: 'invalidate', id: 2, path: '/ws/a.py' });
    expect(parseResponse('{"id":2,"ok":false,"error":"boom","fatal":true}')).toEqual({ kind: 'error', id: 2, message: 'boom' });
    expect(parseResponse('not json').kind).toBe('error');
    expect(parseResponse('{"id":2}').kind).toBe('error');
    // a truthy-looking but non-`true` ok is refused
    expect(parseResponse('{"id":2,"ok":"yes","stdout":"x"}').kind).toBe('error');
  });
});
