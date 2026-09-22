import { describe, expect, it } from 'vitest';
import { armMechanisms } from '../../../src/bench/conditions.js';
import { computeSuiteMetrics } from '../../../src/bench/metrics.js';
import { TOKEN_PRICING_NOTE, bar, renderComparison } from '../../../src/bench/report.js';
import { buildRecord } from '../../../src/bench/runner.js';
import type { ConditionConfig, Summary } from '../../../src/bench/types.js';
import type { BenchTaskRecord, EngineMode } from '../../../src/core/types.js';
import { fakeRunResult, syntheticSource } from './helpers.js';

function cfg(mode: EngineMode): ConditionConfig {
  return {
    condition: mode,
    mode,
    generatorModel: 'mock',
    deciderModel: mode === 'jev-on' ? 'typesafe/jev-1.13-20260917' : null,
    temperature: null,
    maxTokens: 4096,
    generation: { proposer: 'generator', temperature: null, maxTokens: 4096, reasoning: null, deadlineMs: null, lengthHandling: 'none', servedRate: { inputPerM: 0, outputPerM: 0 } },
    mechanisms: armMechanisms(mode),
    maxSteps: 3,
    maxWallMs: 60_000,
    maxReplans: 5,
    taskSpendCapUsd: 2,
    sandboxProfile: 'none',
    noNetwork: false,
    commandTimeoutMs: 30_000,
    maxCommandTimeoutMs: 120_000,
    maxOutputBytes: 200_000,
    completeThreshold: 0.85,
    impossibleThreshold: 0.85,
  };
}

function rec(task: string, condition: EngineMode, gen: number[], jev: number[]): BenchTaskRecord {
  return buildRecord({
    source: syntheticSource({ id: task }),
    condition,
    result: fakeRunResult({ runId: `r-${task}-${condition}`, mode: condition, steps: gen.length, generatorTokensPerStep: gen, jevTokensPerStep: jev, tokensPerStep: gen.map((g, i) => g + jev[i]!) }),
    evaluation: { pass: true, evaluator: 'mock' },
    patch: { modelPatch: 'd', patchBytes: 1, patchEmpty: false },
    capFired: null,
  });
}

const conditions: EngineMode[] = ['jev-on', 'jev-off'];
const records: BenchTaskRecord[] = [
  rec('a', 'jev-on', [1000, 1000], [5000, 7000]),
  rec('b', 'jev-on', [1200, 800, 1000], [6000, 6000, 6000]),
  rec('a', 'jev-off', [900, 1100], [0, 0]),
  rec('b', 'jev-off', [1000], [0]),
];

function summary(): Summary {
  return {
    benchId: 'test-bench',
    createdAt: '2026-09-19T12:00:00.000Z',
    finishedAt: '2026-09-19T12:10:00.000Z',
    mocked: true,
    suites: ['swebench'],
    conditions: { 'jev-on': cfg('jev-on'), 'jev-off': cfg('jev-off') },
    conditionOrder: conditions,
    generatorModel: 'mock',
    spendCapUsd: 10,
    taskSpendCapUsd: 2,
    spentUsd: { generator: 0, jev: 0, total: 0 },
    capFired: null,
    notRun: { count: 0, tasks: [] },
    pairedTasks: { swebench: 2 },
    records: records.length,
    perSuite: { swebench: computeSuiteMetrics(records, 'swebench', conditions, 3) },
    resumed: false,
  };
}

describe('comparison.md tokens per step by source', () => {
  const md = renderComparison(summary(), records);

  it('reports generator, Jev and combined mean tokens/step as separate rows of the paired table', () => {
    expect(md).toContain('| mean generator tokens/step (steps) | 1000 (n=5) | 1000 (n=3) |');
    expect(md).toContain('| mean Jev tokens/step (steps) | 6000 (n=5) | 0 (n=3) |');
    expect(md).toContain('| mean tokens/step, generator+Jev (steps) | 7000 (n=5) | 1000 (n=3) |');
  });

  it('renders the curve as three adjacent tables (generator, Jev, combined), each mean (n) with bars, then the pricing note', () => {
    const iGen = md.indexOf('#### generator tokens per step');
    const iJev = md.indexOf('#### Jev tokens per step');
    const iAll = md.indexOf('#### generator+Jev tokens per step');
    const iNote = md.indexOf(TOKEN_PRICING_NOTE);
    const iStop = md.indexOf('### Stop reasons');
    expect(iGen).toBeGreaterThan(md.indexOf('### Tokens per step'));
    expect(iJev).toBeGreaterThan(iGen);
    expect(iAll).toBeGreaterThan(iJev);
    expect(iNote).toBeGreaterThan(iAll);
    expect(iStop).toBeGreaterThan(iNote);
    expect(TOKEN_PRICING_NOTE).toBe("Jev tokens are priced at $0.042 per million input tokens (output free); generator tokens at the generator's rates; see the cost row.");
    // every table has the header row with mean tokens (n) and a bar column per condition
    const genTable = md.slice(iGen, iJev);
    const jevTable = md.slice(iJev, iAll);
    const allTable = md.slice(iAll, iNote);
    for (const t of [genTable, jevTable, allTable]) expect(t).toContain('| step | jev-on mean tokens (n) | jev-on | jev-off mean tokens (n) | jev-off |');
    // bars are scaled to each table's own maximum: generator max 1100, Jev max 6500, combined max 7400
    expect(genTable).toContain(`| 1 | 1100 (n=2) | ${bar(1100, 1100)} | 950 (n=2) | ${bar(950, 1100)} |`);
    expect(genTable).toContain(`| 3 | 1000 (n=1) | ${bar(1000, 1100)} |  |  |`);
    expect(jevTable).toContain(`| 1 | 5500 (n=2) | ${bar(5500, 6500)} | 0 (n=2) |  |`);
    expect(jevTable).toContain(`| 2 | 6500 (n=2) | ${'█'.repeat(20)} | 0 (n=1) |  |`);
    expect(allTable).toContain(`| 2 | 7400 (n=2) | ${'█'.repeat(20)} | 1100 (n=1) | ${bar(1100, 7400)} |`);
  });

  it('a condition with no executed steps renders the empty marker in every sub-table', () => {
    const s = summary();
    const empty = renderComparison({ ...s, perSuite: { swebench: computeSuiteMetrics([], 'swebench', conditions, 3) } }, []);
    expect(empty.match(/_no executed steps_/g)).toHaveLength(3);
    expect(empty).toContain(TOKEN_PRICING_NOTE);
  });
});
