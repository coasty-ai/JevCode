/**
 * tasks.jsonl is written through the run's redact function (jev-only-audit.md §5 gap: evaluator
 * `reason` strings carry raw subprocess tails and error messages; the bench writer had no redaction
 * pass of its own). A fake key placed in an evaluator reason must not reach the file, neither in the
 * per-record append nor in the consolidated rewrite; the record read back still parses.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRedactor } from '../../../src/core/redact.js';
import { readTasksJsonl, runBenchWithSources, serialiseRedacted } from '../../../src/bench/runner.js';
import type { BenchRecord } from '../../../src/bench/types.js';
import { baseOptions, createFakeDeps, syntheticSource, tempDir, type EngineScript } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const FAKE_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const script: EngineScript = () => ({
  result: { steps: 2, tokensPerStep: [10, 10], generatorTokensPerStep: [5, 5], jevTokensPerStep: [5, 5], jevLatencyMs: [100, 100], counters: { blocked: 0, reviews: 0, declined: 0, failed: 0, loops: 0, replans: 0, reads: 0 } },
  decisions: 2,
  spendUsd: 0.01,
});

describe('bench runner redacts tasks.jsonl', () => {
  it('serialiseRedacted redacts every string leaf and leaves keys and non-strings alone', () => {
    const redact = (s: string): string => s.replaceAll(FAKE_KEY, '[REDACTED:test]');
    const rec = { task: 'x', reason: `run_tests.py: Authorization: Bearer ${FAKE_KEY}`, steps: 3, meta: { note: FAKE_KEY, nested: [FAKE_KEY, 7] } } as unknown as BenchRecord;
    const text = serialiseRedacted(rec, redact);
    expect(text).not.toContain(FAKE_KEY);
    const back = JSON.parse(text) as { reason: string; steps: number; meta: { note: string; nested: [string, number] } };
    expect(back.reason).toBe('run_tests.py: Authorization: Bearer [REDACTED:test]');
    expect(back.steps).toBe(3);
    expect(back.meta.note).toBe('[REDACTED:test]');
    expect(back.meta.nested).toEqual(['[REDACTED:test]', 7]);
  });

  it('a fake key in an evaluator reason never reaches tasks.jsonl (append or consolidated write)', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const { deps } = createFakeDeps({ script });
    const redactor = createRedactor([{ name: 'OPENROUTER_API_KEY', value: FAKE_KEY }]);
    const sources = ['t1', 't2'].map((id) =>
      syntheticSource({
        id,
        evaluate: () => ({ pass: false, evaluator: 'mock', reason: `run_tests: evaluator tail ... export OPENROUTER_API_KEY=${FAKE_KEY} ... exit 1` }),
      }),
    );
    const outDir = join(t.dir, 'out');
    const out = await runBenchWithSources(sources, baseOptions(join(t.dir, 'runs'), outDir, { conditions: ['jev-on'], concurrency: 1, redact: (s) => redactor.redact(s) }), deps);

    // the in-memory records are what the harness produced (unredacted): the writer is the defence
    expect(out.records.some((r) => r.reason?.includes(FAKE_KEY))).toBe(true);
    const text = await readFile(join(outDir, 'tasks.jsonl'), 'utf8');
    expect(text).not.toContain(FAKE_KEY);
    expect(text).toContain('[REDACTED:OPENROUTER_API_KEY]');
    // the summary and the comparison never carry the reason verbatim either
    expect(await readFile(join(outDir, 'summary.json'), 'utf8')).not.toContain(FAKE_KEY);
    expect(await readFile(join(outDir, 'comparison.md'), 'utf8')).not.toContain(FAKE_KEY);
    // the redacted file still reads back as records
    const back = await readTasksJsonl(join(outDir, 'tasks.jsonl'));
    expect(back).toHaveLength(2);
    expect(back.every((r) => typeof r.reason === 'string' && r.reason.includes('[REDACTED:OPENROUTER_API_KEY]'))).toBe(true);
  });
});
