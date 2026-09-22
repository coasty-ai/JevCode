/**
 * The unit project's `setupFiles` (vitest.config.ts): the mechanism environment of every unit file is the tree's
 * default, never the measuring session's shell.
 *
 * The engine resolves these names BEFORE its options — `resolveFastPathOption` (src/loop/engine.ts) reads
 * `JEVCODE_FASTPATH` when the option is absent, `routersEnabled` (src/jev/router.ts) reads `JEVCODE_ROUTERS`,
 * `src/jev/off.ts` reads `JEVCODE_JEV`, and the rest are read the same way deeper in. A developer who exported one
 * of them for a bench arm, a `--jev off` replay or a trace capture and then ran `npm test` in the same shell was
 * measuring a different tree from the one the merge message claims: before this file only three of 532 unit files
 * defended themselves (test/unit/loop/fastpath.test.ts, router.test.ts, router-golden.test.ts).
 *
 * The names are deleted at module scope, i.e. before the test file is imported, so a module-scope read in a test
 * (a `const` at the top of the file, a module-level engine) sees the default too. A test that WANTS one of them
 * sets it itself, in `beforeEach`/`beforeAll` or around the call, exactly as those three files already do —
 * setupFiles run once per test file, so nothing here fights a test's own assignment.
 *
 * `MECHANISM_ENV_VARS` is the bench's own list of the switches an arm pins (src/bench/conditions.ts): it is
 * imported rather than copied so the two cannot drift — a new mechanism switch added for an arm is deleted here
 * on the same commit, with no second list to remember.
 */
import { MECHANISM_ENV_VARS } from '../../src/bench/conditions.js';

/**
 * The names deleted before every unit file, in the order they were audited. The first two come from the bench;
 * the rest are the switches the engine and its neighbours read from the environment when no option is given.
 */
export const UNIT_ENV_DELETED: readonly string[] = [
  ...MECHANISM_ENV_VARS, // JEVCODE_FASTPATH, JEVCODE_ROUTERS — contract 1.9 (Fastlane) §8.1 arm mechanisms
  'JEVCODE_JEV', // src/jev/off.ts JEV_SWITCH_ENV: off | escape | unreachable | on
  'JEVCODE_MODE', // src/config/defaults.ts `mode` setting: flag > JEVCODE_MODE > dotenv > file > DEFAULT_MODE
  'JEVCODE_WARM', // src/synth/warm/plane.ts
  'JEVCODE_BENCH_CONTEXT',
  'JEVCODE_HOME', // the runs dir; a test that needs one makes its own temp dir
  'JEVCODE_TRACE',
  'JEVCODE_FAULT', // the fault injector
];

for (const name of UNIT_ENV_DELETED) delete process.env[name];
