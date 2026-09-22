/**
 * Gate hygiene: the unit suite measures the TREE, not the measuring session's shell (test/unit/setup-env.ts,
 * wired as the unit project's `setupFiles` in vitest.config.ts).
 *
 * Before that wiring, every mechanism env var the engine reads before its options leaked from the shell into all
 * 532 unit files, and only three of them defended themselves (test/unit/loop/fastpath.test.ts,
 * test/unit/loop/router.test.ts, test/unit/loop/router-golden.test.ts). A developer who had exported
 * `JEVCODE_FASTPATH=off` for a `jev-on-next-nofast` replay and then typed `npm test` in the same shell was
 * gating the merge on a different tree from the one the merge message describes.
 *
 * What is measured is the state a test file's MODULE SCOPE sees — the surface the leak actually had, since a
 * `const` at the top of a test file or a module-level engine reads the environment before any `beforeEach` can
 * clean it. So the snapshot and the four resolutions below are taken at this file's module scope, and the setup
 * module is pulled in by a dynamic import AFTERWARDS: importing it statically would perform the deletion itself
 * and the file would pass whatever the config says.
 *
 * Failing-first: `JEVCODE_FASTPATH=off JEVCODE_ROUTERS=on npx vitest run --project unit
 * test/unit/hygiene/env-hygiene.test.ts` is red on every case against the config at d297b29 (no `setupFiles`),
 * and green with the setup file whatever the shell holds.
 */
import { describe, expect, it } from 'vitest';
import { MECHANISM_ENV_VARS } from '../../../src/bench/conditions.js';
import { DEFAULT_MODE } from '../../../src/config/defaults.js';
import { resolveFastPathOption } from '../../../src/loop/engine.js';
import { routersOn } from '../../../src/loop/routers.js';

/** the environment this test FILE was imported with — the state the leak reached */
const ENV_AT_IMPORT = new Set(Object.keys(process.env));
/** the mechanism resolutions a module-scope read in a test file would have got */
const AT_IMPORT = {
  defaultFastPath: resolveFastPathOption(DEFAULT_MODE, undefined),
  defaultRouters: routersOn(DEFAULT_MODE),
  jevOnFastPath: resolveFastPathOption('jev-on', undefined),
  jevOnRouters: routersOn('jev-on'),
};

// after the snapshot: this module deletes the names on import, which is the whole point of it
const { UNIT_ENV_DELETED } = await import('../setup-env.js');

describe('the unit suite starts from the tree default, not the shell', () => {
  it('every name the setup file owns is already absent when a test file is imported', () => {
    const leaked = UNIT_ENV_DELETED.filter((name) => ENV_AT_IMPORT.has(name));
    expect(leaked, 'setupFiles must delete these before the test file is imported').toEqual([]);
  });

  it("the setup file's list covers the bench's own mechanism switches, so the two cannot drift", () => {
    for (const name of MECHANISM_ENV_VARS) expect(UNIT_ENV_DELETED).toContain(name);
    // and the audited names beyond the bench's two
    expect(UNIT_ENV_DELETED).toEqual(expect.arrayContaining(['JEVCODE_JEV', 'JEVCODE_MODE', 'JEVCODE_WARM', 'JEVCODE_BENCH_CONTEXT', 'JEVCODE_HOME', 'JEVCODE_TRACE', 'JEVCODE_FAULT']));
  });

  it('the default-mode engine resolves the fast path off and the routers off', () => {
    // DEFAULT_MODE is llm-jev (src/config/defaults.ts): neither mechanism of contract 1.9 is reachable there
    expect(AT_IMPORT.defaultFastPath).toBe('off');
    expect(AT_IMPORT.defaultRouters).toBe(false);
  });

  it('the jev-on engine resolves the tree defaults: the fast path armed, the routers off', () => {
    // an exported JEVCODE_FASTPATH=off reds the first line; an exported JEVCODE_ROUTERS=on reds the second
    expect(AT_IMPORT.jevOnFastPath).toBe('auto');
    expect(AT_IMPORT.jevOnRouters).toBe(false);
  });
});
