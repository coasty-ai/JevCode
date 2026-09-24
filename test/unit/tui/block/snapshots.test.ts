/**
 * TUI-DESIGN-4 §3.1–§3.3 / §10 S3: **one snapshot per block at 40 / 80 / 120 columns**. The `commands-width` pty
 * gate asserts the *property* (no static row exceeds the terminal) at ten geometries; this file is the readable
 * half — the exact rows a reviewer can look at, at the three widths the round-3 gate already sampled, so a change
 * to the grammar shows up as a diff of the drawn block rather than as a failing width predicate somewhere else.
 *
 * The width handed to every builder is `blockWidth(columns)` (the RUNG's body width, §3.1.2), never `columns`:
 * 40 → 30 (tight), 80 → 70 (standard), 120 → 110 (wide).
 */
import { describe, expect, it } from 'vitest';
import { blockTexts, blockWidth, textRows, type BlockRow } from '../../../../src/tui/block/lines.js';
import { configTableLines } from '../../../../src/cli/config-table.js';
import { epilogueRows } from '../../../../src/cli/epilogue.js';
import { costRows } from '../../../../src/tui/budget/lines.js';
import { calibrationBlock, calibrationStats } from '../../../../src/tui/calibration.js';
import { cellWidth } from '../../../../src/tui/glyphs.js';
import type { ConfigRecordValue } from '../../../../src/core/types.js';

const COLUMNS = [40, 80, 120] as const;

/** F-B1 `/status` */
const STATUS: BlockRow[] = [
  // §3.1.5: the two identifier rows — never elided, the row wraps instead (`statusCommand` sets the same flag)
  { kind: 'kv', key: 'run', value: '20260922-035503-kntk2yw3 · complete (exit 0)', id: true },
  { kind: 'kv', key: 'session', value: '20260922-035503-kntk2yw3 · 1 run · $0.001', id: true },
  { kind: 'kv', key: 'step', value: '4 of 40 · idle' },
  { kind: 'kv', key: 'workspace', value: '~/T/a3-ws-jC6j7y · no git repository' },
  { kind: 'kv', key: 'sandbox', value: 'seatbelt · lock released' },
];

/** F-B2 `/cost`, through the real builder */
const COST = costRows(
  {
    mode: 'jev-on',
    run: { spentUsd: 0.001, capUsd: 2, perStepUsd: [0.0004, 0.0003, 0.0003] },
    session: { spentUsd: 0.001, capUsd: 10, runs: 1 },
    gen: { usd: 0, tablePriced: false },
    jev: { usd: 0.001, questions: 83, p50Ms: 0 },
    basis: { generator: 'provider usage.cost', jev: 'provider usage.cost' },
    pending: [],
  },
  { messages: 1, costUsd: 0.0001, p50Ms: 0 },
);

/** `/jev` */
const JEV: BlockRow[] = [
  { kind: 'kv', key: 'decider', value: 'typesafe · api.typesafe.test · typesafe/jev-1.13-20260917 (pinned)' },
  { kind: 'kv', key: 'latency', value: 'p50 0 ms · p95 2 ms' },
  { kind: 'kv', key: 'cost', value: '$0.001 · 83 questions' },
  { kind: 'kv', key: 'intake', value: '1 message · p50 0 ms · $0.0001 · last question about this tool (1.00)' },
];

/** `/budget` with the one `pending · next /resume or run` rule caption of §3.3 */
const BUDGET: BlockRow[] = [
  // §3.1.4: an amount SPENT is three decimals, a CAP is `usd2` — one form per quantity, as `budgetCommand` builds it
  { kind: 'kv', key: 'run', value: '$0.001 of $2.00' },
  { kind: 'kv', key: 'session', value: '$0.00 of $10.00 · 1 run' },
  { kind: 'rule', caption: 'pending · next /resume or run' },
  { kind: 'kv', key: 'max-steps', value: '14', role: 'accent' },
  { kind: 'kv', key: 'spend-cap', value: '5.00', role: 'accent' },
];

/** `/errors`, the §3.1.7 empty state */
const ERRORS: BlockRow[] = [{ kind: 'note', flush: true, text: 'nothing to report — no warnings or errors this session' }];

/** `/peers` (§7.10) */
const PEERS: BlockRow[] = [
  { kind: 'kv', key: 'workspace', value: '~/T/a3-ws-jC6j7y' },
  { kind: 'kv', key: 'started', value: '14s ago' },
  { kind: 'kv', key: 'state', value: 'exclusive lease held' },
];

const RECORD: Record<string, ConfigRecordValue> = {
  mode: { value: 'jev-on', source: 'flag' },
  'generator.model': { value: 'z-ai/glm-5.3-flash', source: 'file:/Users/me/proj/jevcode.json' },
  'decider.model': { value: 'typesafe/jev-1.13-20260917', source: 'default' },
  'limits.spendCapUsd': { value: '2', source: 'env' },
  'limits.maxSteps': { value: 'lots', source: 'file:/x.json', problem: { kind: 'wrong-type', expected: 'an integer ≥ 1' } },
  'session.spendCapUsd': { value: '10', source: 'derived' },
  workspace: { value: '/Users/me/T/a3-ws-eO2WYu', source: 'flag' },
  runsDir: { value: '/Users/me/T/a3-home-L5tIsG/runs', source: 'env' },
  'ui.theme': { value: 'dark', source: 'default' },
  'ui.fps': { value: '30', source: 'default' },
};

const EPILOGUE = { runId: '20260922-035503-kntk2yw3', runDir: '/Users/me/T/a3-home/runs/20260922-035503-kntk2yw3', resumable: true, stopReason: 'complete' as const, exitCode: 0, home: '/Users/me' };

const BLOCKS: Readonly<Record<string, (columns: number) => readonly string[]>> = {
  status: (c) => blockTexts(STATUS, blockWidth(c)),
  cost: (c) => blockTexts(COST, blockWidth(c)),
  jev: (c) => blockTexts(JEV, blockWidth(c)),
  budget: (c) => blockTexts(BUDGET, blockWidth(c)),
  errors: (c) => blockTexts(ERRORS, blockWidth(c)),
  peers: (c) => blockTexts(PEERS, blockWidth(c)),
  config: (c) => configTableLines(RECORD, { sandboxLevel: 'seatbelt', width: blockWidth(c), home: '/Users/me' }),
  'config --all': (c) => configTableLines(RECORD, { sandboxLevel: 'seatbelt', width: blockWidth(c), all: true, home: '/Users/me' }),
  epilogue: (c) => epilogueRows(EPILOGUE, blockWidth(c)),
  // `session.ts` sends row 0 as the block HEAD and hands the rest to `textBlock` — i.e. through `textRows` and
  // `renderBlock`, which is where a pre-built row wider than the body is elided (§3.1.5). The snapshot follows the
  // real path so the drawn rows are the ones under test, not the builder's un-rendered intermediate.
  calibration: (c) => blockTexts(textRows(calibrationBlock(calibrationStats([]), undefined, blockWidth(c)).slice(1)), blockWidth(c)),
};

describe('one snapshot per block at 40 / 80 / 120 columns (§10 S3)', () => {
  for (const columns of COLUMNS) {
    it(`draws every block at ${columns} columns (body ${blockWidth(columns)})`, () => {
      const drawn: Record<string, readonly string[]> = {};
      for (const [name, build] of Object.entries(BLOCKS)) drawn[name] = build(columns);
      expect(drawn).toMatchSnapshot();
    });

    it(`no row of any block exceeds the body width at ${columns} columns`, () => {
      const width = blockWidth(columns);
      for (const [name, build] of Object.entries(BLOCKS)) {
        for (const row of build(columns)) expect(cellWidth(row), `${name} @ ${columns}: ${JSON.stringify(row)}`).toBeLessThanOrEqual(width);
      }
    });
  }
});
