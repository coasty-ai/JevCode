import { defineConfig } from 'vitest/config';

/**
 * docs/DECISIONS.md (2026-09-22, the shared-machine gate): a full unit run is bounded to three workers so a gate run
 * cannot starve the bench/perf window that shares this machine. The bound used to live only in prose — `npm test` is
 * `vitest run --project unit`, which spawns the runner's default of `cpus - 1`, i.e. exactly what the decision forbids —
 * so it lives here instead, where typing the short command cannot lose it. CI has the machine to itself and keeps the
 * runner's default.
 */
const LOCAL_MAX_WORKERS = 3;
const localWorkerBound = process.env['CI'] === undefined || process.env['CI'] === '' ? { maxWorkers: LOCAL_MAX_WORKERS } : {};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts', 'test/unit/**/*.test.tsx'],
          environment: 'node',
          testTimeout: 20_000,
          hookTimeout: 20_000,
          // the mechanism env vars the engine reads before its options are deleted before every unit file, so a gate run
          // measures the tree and not the measuring session's shell (test/unit/setup-env.ts)
          setupFiles: ['test/unit/setup-env.ts'],
          // `allowOnly` defaults to `!isCI`, and every gate in this wave is run locally: a committed `it.only` would
          // silently narrow a file and the run would still exit 0. Fail the run instead, in CI and out of it.
          allowOnly: false,
          ...localWorkerBound,
        },
      },
      {
        test: {
          name: 'live',
          include: ['test/live/**/*.live.test.ts'],
          environment: 'node',
          testTimeout: 300_000,
          hookTimeout: 60_000,
          fileParallelism: false,
          allowOnly: false,
        },
      },
      {
        test: {
          // TUI-DESIGN §19.5 / §19.8: real-pty scenarios through scripts/pty/drive.exp (expect(1)); macOS only, sequential
          name: 'pty',
          include: ['test/pty/**/*.pty.test.ts'],
          environment: 'node',
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
          globalSetup: ['test/pty/global-setup.ts'],
          allowOnly: false,
        },
      },
    ],
    coverage: { provider: 'v8', include: ['src/**'], reporter: ['text', 'json-summary'] },
  },
});
