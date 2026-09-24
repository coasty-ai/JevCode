/** scripts/ci/retried-reporter.mjs: CI retries failing tests, and this reporter keeps the retried ones visible. */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs module without type declarations
import { retriedRows, summaryMarkdown } from '../../../scripts/ci/retried-reporter.mjs';

interface FakeTest { fullName: string; retryCount: number | null; state: string }
function mod(file: string, tests: FakeTest[]): unknown {
  return {
    relativeModuleId: file,
    children: {
      *allTests() {
        for (const t of tests) {
          yield { fullName: t.fullName, diagnostic: () => (t.retryCount === null ? undefined : { retryCount: t.retryCount }), result: () => ({ state: t.state }) };
        }
      },
    },
  };
}

describe('retried-reporter', () => {
  it('lists only retried tests, sorted by file then name, with the outcome', () => {
    const rows = retriedRows([
      mod('test/unit/b.test.ts', [{ fullName: 'z passes on retry', retryCount: 1, state: 'passed' }, { fullName: 'plain', retryCount: 0, state: 'passed' }]),
      mod('test/unit/a.test.ts', [{ fullName: 'fails every attempt', retryCount: 2, state: 'failed' }, { fullName: 'skipped', retryCount: null, state: 'skipped' }]),
    ]);
    expect(rows).toEqual([
      { file: 'test/unit/a.test.ts', name: 'fails every attempt', retries: 2, outcome: 'failed' },
      { file: 'test/unit/b.test.ts', name: 'z passes on retry', retries: 1, outcome: 'passed on retry' },
    ]);
  });

  it('renders nothing when nothing was retried, and escapes table cells otherwise', () => {
    expect(summaryMarkdown([])).toBe('');
    const md = summaryMarkdown([{ file: 'test/unit/a.test.ts', name: 'a | b\nc', retries: 1, outcome: 'passed on retry' }]);
    expect(md).toContain('### Unit tests retried in this run (1)');
    expect(md).toContain('| test/unit/a.test.ts | a \\| b c | 1 | passed on retry |');
  });
});
