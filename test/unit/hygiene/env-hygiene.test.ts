/**
 * Gate hygiene: the unit suite measures the TREE, not the measuring session's shell (test/unit/setup-env.ts,
 * wired as the unit project's `setupFiles` in vitest.config.ts).
 *
 * Before that wiring, every mechanism env var the engine reads before its options leaked from the shell into all
 * 543 unit files, and only three of them defended themselves (test/unit/loop/fastpath.test.ts,
 * test/unit/loop/router.test.ts, test/unit/loop/router-golden.test.ts). A developer who had exported
 * `JEVCODE_FASTPATH=off` for a `jev-on-next-nofast` replay and then typed `npm test` in the same shell was
 * gating the merge on a different tree from the one the merge message describes.
 *
 * The first version of the setup file deleted a hand-audited list of nine names, which left ~78 of the ~87
 * `JEVCODE_*` names the shipped code reads still leaking — among them `JEVCODE_HEDGE` and
 * `JEVCODE_DEADLINE_GROWTH` (src/synth/llm/source.ts, both read before/without an option and both pinned per arm
 * in the OOS wave) and `JEVCODE_MOCK_STEP_MS`, each of which deterministically reds a real unit file. The list is
 * now INVERTED — sweep every `JEVCODE_*` except an explicit keep-list — so the two cases below that quantify over
 * the whole tree (`no product switch survives the sweep`, `the keep-list holds only harness opt-ins`) are the
 * drift gate, and no future switch needs anybody to remember this file.
 *
 * What is measured is the state a test file's MODULE SCOPE sees — the surface the leak actually had, since a
 * `const` at the top of a test file or a module-level engine reads the environment before any `beforeEach` can
 * clean it. So the snapshot and the four resolutions below are taken at this file's module scope, and the setup
 * module is pulled in by a dynamic import AFTERWARDS: importing it statically would perform the deletion itself
 * and the file would pass whatever the config says.
 *
 * This is also the one file that imports `MECHANISM_ENV_VARS` from src/bench/conditions.js. The setup file used
 * to import it, which put that module's 60-module value graph in front of all 543 unit files for a containment
 * fact that is asserted here, once, at the cost of one graph.
 *
 * Failing-first: `JEVCODE_FASTPATH=off JEVCODE_ROUTERS=on npx vitest run --project unit
 * test/unit/hygiene/env-hygiene.test.ts` is red on every resolution case against the config at d297b29 (no
 * `setupFiles`), and green with the setup file whatever the shell holds; `JEVCODE_HEDGE=on
 * JEVCODE_DEADLINE_GROWTH=served JEVCODE_MOCK_STEP_MS=5 …` is red on `the names the audited list missed` against
 * the nine-name version of the setup file, and green against the sweep.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
const { UNIT_ENV_KEPT, deletedByUnitSetup } = await import('../setup-env.js');

const ROOT = join(import.meta.dirname, '../../..');

/** Every `JEVCODE_*` name the shipped code mentions — the set the sweep has to cover, recomputed on every run. */
function shippedEnvNames(): string[] {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) for (const m of readFileSync(p, 'utf8').matchAll(/JEVCODE_[A-Z0-9_]+/g)) names.add(m[0]);
    }
  };
  for (const dir of ['src', 'scripts', 'bin']) walk(join(ROOT, dir));
  // `JEVCODE_ASSERT_`, `JEVCODE_MOCK_`, `JEVCODE_REPRO__` … are prefixes written in prose or built by concatenation,
  // not names; a real name always has a letter after the last underscore and is never a bare prefix.
  return [...names].filter((n) => !n.endsWith('_')).sort();
}

describe('the unit suite starts from the tree default, not the shell', () => {
  it('every name the setup file sweeps is already absent when a test file is imported', () => {
    const leaked = [...ENV_AT_IMPORT].filter(deletedByUnitSetup).sort();
    expect(leaked, 'setupFiles must delete these before the test file is imported').toEqual([]);
  });

  it("the sweep covers the bench's own mechanism switches, so the two cannot drift", () => {
    for (const name of MECHANISM_ENV_VARS) expect(deletedByUnitSetup(name), `${name} is a bench arm mechanism`).toBe(true);
    // and the names the first, hand-audited version of the list owned
    for (const name of ['JEVCODE_JEV', 'JEVCODE_MODE', 'JEVCODE_WARM', 'JEVCODE_BENCH_CONTEXT', 'JEVCODE_HOME', 'JEVCODE_TRACE', 'JEVCODE_FAULT']) {
      expect(deletedByUnitSetup(name), `${name} was audited into the first list`).toBe(true);
    }
  });

  it('the names the audited list missed are swept too (the reason the list is inverted)', () => {
    // each of these reds a real unit file when it is exported: source-backoff/deadline-growth (src/synth/llm/source.ts
    // `hedgeEnabled`, `deadlineGrowthFrom` — read before any option) and cli/mock-trajectory
    for (const name of ['JEVCODE_HEDGE', 'JEVCODE_DEADLINE_GROWTH', 'JEVCODE_MOCK_STEP_MS', 'JEVCODE_MOCK_INTAKE', 'JEVCODE_MOCK_JEV_MS', 'JEVCODE_CONTEXT_MODE', 'JEVCODE_SANDBOX', 'JEVCODE_PROVIDER', 'JEVCODE_MODEL', 'JEVCODE_API_KEY']) {
      expect(deletedByUnitSetup(name), `${name} is read by the shipped code and must not reach a unit file`).toBe(true);
    }
    // and a name that does not exist yet is covered on the day it is added: that is what "inverted" buys
    expect(deletedByUnitSetup('JEVCODE_A_SWITCH_ADDED_TOMORROW')).toBe(true);
    // nothing outside the prefix is this file's business
    for (const name of ['CI', 'HOME', 'PATH', 'NODE_ENV', 'JEV_API_KEY']) expect(deletedByUnitSetup(name)).toBe(false);
  });

  it('no product switch the shipped code reads survives the sweep', () => {
    const survivors = shippedEnvNames().filter((n) => !deletedByUnitSetup(n));
    // the only survivors allowed are assertion switches, which can only make a child process stricter
    expect(survivors, 'a behaviour switch on the keep-list is the leak this file exists to close').toEqual(survivors.filter((n) => n.startsWith('JEVCODE_ASSERT_')));
    expect(shippedEnvNames().length, 'the walk must actually find the switches').toBeGreaterThan(50);
  });

  it('the keep-list holds only harness opt-ins, and holds the two the tests read at module scope', () => {
    // read at module scope by test/unit/bench/ladder-long.test.ts and test/unit/loop/router-golden.test.ts, i.e.
    // AFTER setupFiles has run: sweeping them would disarm the ladder tier and the golden refresh
    expect(UNIT_ENV_KEPT).toContain('JEVCODE_LADDER_PYTHON');
    expect(UNIT_ENV_KEPT).toContain('JEVCODE_ROUTER_GOLDEN_OUT');
    expect(UNIT_ENV_KEPT).toContain('JEVCODE_LIVE');
    // every kept name is a harness name: the shipped product does not read it for behaviour
    const shipped = new Set(shippedEnvNames());
    const productSwitchesKept = UNIT_ENV_KEPT.filter((n) => shipped.has(n) && !n.startsWith('JEVCODE_ASSERT_'));
    expect(productSwitchesKept, 'src/, scripts/ and bin/ must not read a kept name for behaviour').toEqual([]);
    for (const name of UNIT_ENV_KEPT) expect(name.startsWith('JEVCODE_'), `${name} is outside the swept prefix anyway`).toBe(true);
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
