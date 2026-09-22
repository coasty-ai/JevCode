/**
 * The warm runner's Python source is a TypeScript string (see `src/synth/warm/server-source.ts`
 * for why), so nothing else would catch a syntax error in it before a live run. Compile it with
 * the interpreter on every `npm test`, and pin the two invariants the TS side depends on.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { WARM_READY_PREFIX, WARM_REQ_FIFO, WARM_RESP_FIFO, WARM_SERVER_PY } from '../../../../src/synth/warm/index.js';
import { havePython } from './helpers.js';

describe('the embedded warm server source', () => {
  it.skipIf(!havePython)('compiles with the interpreter the lanes use', () => {
    const r = spawnSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "warm_server.py", "exec")'], { input: WARM_SERVER_PY, encoding: 'utf8', timeout: 30_000 });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it.skipIf(!havePython)('is valid for Python 3.9, the floor run_tests.py declares', () => {
    // no `match`, no `X | Y` annotations, no 3.10+ stdlib: ast.parse with the running interpreter
    // plus an explicit feature-version parse is the cheapest check that does not need a 3.9 build
    const r = spawnSync('python3', ['-c', 'import ast, sys; ast.parse(sys.stdin.read(), feature_version=(3, 9))'], { input: WARM_SERVER_PY, encoding: 'utf8', timeout: 30_000 });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('announces itself with the prefix the worker waits for, and names the two fifos', () => {
    expect(WARM_SERVER_PY).toContain(`READY = "${WARM_READY_PREFIX}"`);
    expect(WARM_SERVER_PY).toContain(`os.path.join(args.dir, "${WARM_REQ_FIFO}")`);
    expect(WARM_SERVER_PY).toContain(`os.path.join(args.dir, "${WARM_RESP_FIFO}")`);
  });

  it('keeps the isolation the cold path has: a fork per candidate, its own session, SIGKILL on the deadline', () => {
    expect(WARM_SERVER_PY).toContain('os.fork()');
    expect(WARM_SERVER_PY).toContain('os.setsid()');
    expect(WARM_SERVER_PY).toContain('signal.SIGKILL');
    expect(WARM_SERVER_PY).toContain('PYTHONDONTWRITEBYTECODE');
  });
});
