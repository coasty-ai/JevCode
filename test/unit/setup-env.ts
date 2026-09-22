/**
 * The unit project's `setupFiles` (vitest.config.ts): the mechanism environment of every unit file is the tree's
 * default, never the measuring session's shell.
 *
 * The engine resolves these names BEFORE its options — `resolveFastPathOption` (src/loop/engine.ts) reads
 * `JEVCODE_FASTPATH` when the option is absent, `routersEnabled` (src/jev/router.ts) reads `JEVCODE_ROUTERS`,
 * `src/jev/off.ts` reads `JEVCODE_JEV`, `hedgeEnabled` and `deadlineGrowthFrom` (src/synth/llm/source.ts) read
 * `JEVCODE_HEDGE` and `JEVCODE_DEADLINE_GROWTH`, and the rest are read the same way deeper in. A developer who
 * exported one of them for a bench arm, a `--jev off` replay or a trace capture and then ran `npm test` in the
 * same shell was measuring a different tree from the one the merge message claims: before this file only three
 * of 543 unit files defended themselves (test/unit/loop/fastpath.test.ts, router.test.ts, router-golden.test.ts).
 *
 * THE LIST IS INVERTED, and that is the point. The first version deleted nine audited names; `grep -rhoE
 * 'JEVCODE_[A-Z0-9_]+' src/ scripts/ bin/` yields ~87, and two of the ones it missed are documented arm
 * mechanisms that deterministically red the suite: `JEVCODE_DEADLINE_GROWTH=served JEVCODE_HEDGE=on npx vitest
 * run --project unit test/unit/synth/llm` was 3 files / 6 tests red (source-backoff.test.ts, deadline-growth.
 * test.ts), and `JEVCODE_MOCK_STEP_MS=5` reds test/unit/cli/mock-trajectory.test.ts. A per-name list cannot be
 * kept complete by hand — every new switch is a silent hole until someone remembers this file. So every
 * `JEVCODE_*` name in the environment is deleted EXCEPT an explicit keep-list, which is drift-proof by
 * construction: a switch added tomorrow is covered on the day it is added, with nothing to remember.
 *
 * What may be kept, and nothing else:
 *   - a harness opt-in that SELECTS the run or names an artefact path — it chooses what the suite does, it is not
 *     a product behaviour the suite measures (`JEVCODE_LIVE`, `JEVCODE_LADDER_PYTHON`, the golden's out path);
 *   - an assertion switch, which only makes a child process STRICTER and can never make a red run green
 *     (`JEVCODE_ASSERT_*`: .github/workflows/release.yml sets `JEVCODE_ASSERT_NO_NETWORK=1` for the whole job).
 * A product switch — anything the engine, the synthesizer, the provider or the TUI reads for its behaviour — may
 * never be kept, however convenient: that is exactly the leak this file exists to close.
 *
 * The names are deleted at module scope, i.e. before the test file is imported, so a module-scope read in a test
 * (a `const` at the top of the file, a module-level engine) sees the default too. A test that WANTS one of them
 * sets it itself, in `beforeEach`/`beforeAll` or around the call, exactly as those three files already do —
 * setupFiles run once per test file, so nothing here fights a test's own assignment.
 *
 * Nothing is imported here, and nothing may be. setupFiles share the test file's module registry, so a value
 * import is paid once per unit file: the first version imported `src/bench/conditions.js` (to keep the list from
 * drifting from `MECHANISM_ENV_VARS`), whose value closure reaches 60 modules — src/jev/mock.ts, src/provider/
 * sse.ts, src/synth/verify/pytest.ts, src/synth/oracle/*, src/loop/stages/propose.ts … Measured on the 61 files
 * of test/unit/loop at 2 workers: with the import the run reports a `setup` bucket at 7 % of 16.98 s; without it
 * there is no setup bucket to report (16.89 s). The wall barely moves at that width because the setup of one
 * worker overlaps the tests of the other — the CPU does not, and it is paid 543 times. The sweep needs no list,
 * so the containment fact is asserted in test/unit/hygiene/env-hygiene.test.ts, the one file that pays the graph.
 */

/** The prefix that marks a switch of this product. Nothing outside it is touched: `CI`, `HOME`, `PATH` are not ours. */
const JEVCODE_PREFIX = /^JEVCODE_/;

/**
 * The only `JEVCODE_*` names a unit run may inherit from the shell. Each is a harness opt-in or an assertion, never
 * a product behaviour switch — see the header for the rule, which env-hygiene.test.ts enforces name by name.
 */
export const UNIT_ENV_KEPT: readonly string[] = [
  'JEVCODE_LIVE', // selects the live project (package.json `test:live`); the unit project never reads it
  'JEVCODE_LADDER_PYTHON', // which interpreter grades the ladder (test/unit/bench/ladder-long.test.ts, module scope)
  'JEVCODE_ROUTER_GOLDEN_OUT', // where test/unit/loop/router-golden.test.ts writes a refreshed trace (module scope)
  'JEVCODE_ROUTER_GOLDEN_COMMIT', // the commit stamped into that trace
  'JEVCODE_UPDATE_GOLDEN', // the golden-refresh opt-in
  'JEVCODE_PTY_BIN', // the pty project's binary and build opt-outs (no setupFiles today; kept so adding them is safe)
  'JEVCODE_PTY_NO_BUILD',
];

/** The keep rule, exported so the hygiene test can state it over any name rather than over today's environment. */
export function deletedByUnitSetup(name: string): boolean {
  if (!JEVCODE_PREFIX.test(name)) return false;
  if (UNIT_ENV_KEPT.includes(name)) return false;
  // `JEVCODE_ASSERT_*` only ever tightens a child process (throw on network, on config before the first frame):
  // it cannot turn a red run green, and the release job sets one for the whole job.
  if (name.startsWith('JEVCODE_ASSERT_')) return false;
  return true;
}

/** What this process actually deleted, in sorted order — the shell's contribution, named in the hygiene report. */
export const UNIT_ENV_DELETED: readonly string[] = Object.keys(process.env).filter(deletedByUnitSetup).sort();

for (const name of UNIT_ENV_DELETED) delete process.env[name];
