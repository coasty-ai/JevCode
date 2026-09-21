import { defineConfig } from 'vitest/config';

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
        },
      },
    ],
    coverage: { provider: 'v8', include: ['src/**'], reporter: ['text', 'json-summary'] },
  },
});
