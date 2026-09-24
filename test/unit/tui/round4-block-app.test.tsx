/**
 * TUI-DESIGN-4 §3 / §10 S3 (`round4-block-app.test.tsx`) — the one command-output grammar as the App actually draws
 * it. `block/lines.test.ts` pins `renderBlock` in isolation; this file pins the two facts that only a mounted App
 * can show:
 *
 *  1. a `[ui]` item whose detail is the pre-rendered body draws **one row per rendered row**, at the body column
 *     (TUI-DESIGN-3 §5.1 rule 1's 10-cell gutter), in order, none of them wider than the terminal;
 *  2. `blockWidth(columns)` is exactly the room those rows get — the block built at the block width fits, and one
 *     built at `columns` (the pre-round-4 mistake, §3.0's last measured row) overflows by exactly the gutter.
 *
 * `Transcript.tsx` is S2's file and `plain.ts` is S5's, so nothing here asserts a mechanism inside either: every
 * assertion is on the drawn frame. The `gap` row is the one exception and is written as the contract it needs
 * (§9.2's request to S2: a `gap` must render as `<Box height={1}/>`, because Ink measures `<Text>{''}</Text>` at
 * height 0 — verified in this file, so the request cannot be forgotten).
 */
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { LABEL_GUTTER, blockTexts, blockWidth, detailRole, type BlockRow } from '../../../src/tui/block/lines.js';
import { localItem } from '../../../src/tui/plain.js';
import { isBlockItem, itemRenderRows } from '../../../src/tui/Transcript.js';
import type { ColorRole } from '../../../src/tui/theme.js';
import { cellWidth } from '../../../src/tui/glyphs.js';
import { mountApp, stripSgr, waitFor } from './app-harness.js';

/** F-B1's rows, the measured 106-cell `/status` row of A3 §2.2 included as a value that must be cut to the width. */
const STATUS_ROWS: BlockRow[] = [
  { kind: 'kv', key: 'run', value: '20260922-035503-kntk2yw3 · complete (exit 0)' },
  { kind: 'kv', key: 'session', value: '20260922-035503-kntk2yw3 · 1 run · $0.001' },
  { kind: 'kv', key: 'step', value: '4 of 40 · idle' },
  { kind: 'kv', key: 'workspace', value: '~/T/a3-ws-jC6j7y · no git repository' },
  { kind: 'kv', key: 'sandbox', value: 'seatbelt · lock released' },
];

/** the `[ui] <head>` row and the body rows under it, gutter stripped, from a rendered frame */
function blockFrom(frame: string, head: string): { head: string; body: string[]; raw: string[] } {
  const lines = stripSgr(frame).split('\n');
  const at = lines.findIndex((l) => l.includes(`[ui] ${head}`));
  expect(at, `no "[ui] ${head}" row in the frame`).toBeGreaterThanOrEqual(0);
  const body: string[] = [];
  const raw: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i] as string;
    if (!l.startsWith(' '.repeat(LABEL_GUTTER)) || l.trim() === '') break;
    raw.push(l);
    body.push(l.slice(LABEL_GUTTER).trimEnd());
  }
  return { head: (lines[at] as string).trimEnd(), body, raw };
}

async function mountWithBlock(head: string, rows: BlockRow[], columns: number): Promise<{ frame: string; expected: string[] }> {
  const expected = blockTexts(rows, blockWidth(columns));
  const m = mountApp({ mode: 'session' });
  // the idle path a command block takes: `Renderer.notify` → `dispatch({ type: 'local' })` → one `<Static>` item
  m.dispatch({ type: 'local', text: head, label: '[ui]', detail: expected.join('\n') });
  // the local item lands on Ink's own schedule; every other App test waits the same way
  await waitFor(() => m.lastFrame().includes(`[ui] ${head}`));
  return { frame: m.lastFrame(), expected };
}

describe('a command block in the App (§3.1, §10 S3)', () => {
  it('draws one row per rendered row, in order, at the body column', async () => {
    const { frame, expected } = await mountWithBlock('status', STATUS_ROWS, 100);
    const got = blockFrom(frame, 'status');
    expect(got.head).toBe(`     [ui] status`);
    expect(got.body).toEqual(expected.map((r) => r.trimEnd()));
    // one row per rendered row — never a re-wrap, never a join
    expect(got.body.length).toBe(expected.length);
    // the body column is the 10-cell gutter of TD3 rule 1
    for (const r of got.raw) expect(r.slice(0, LABEL_GUTTER)).toBe(' '.repeat(LABEL_GUTTER));
  });

  it('every drawn row fits the terminal — the block is built at `blockWidth`, not at `columns` (§3.0, §3.3)', async () => {
    const { frame } = await mountWithBlock('status', STATUS_ROWS, 100);
    for (const line of stripSgr(frame).split('\n')) expect(cellWidth(line)).toBeLessThanOrEqual(100);
    // the pre-round-4 mistake, stated as arithmetic: a body built at `columns` is exactly LABEL_GUTTER too wide
    const wrong = blockTexts([{ kind: 'kv', key: 'workspace', value: 'x'.repeat(200) }], 100);
    expect(cellWidth(wrong[0] as string)).toBe(100);
    expect(cellWidth(wrong[0] as string) + LABEL_GUTTER).toBeGreaterThan(100);
    const right = blockTexts([{ kind: 'kv', key: 'workspace', value: 'x'.repeat(200) }], blockWidth(100));
    expect(cellWidth(right[0] as string) + LABEL_GUTTER).toBe(100);
  });

  it('the `… +N more` footer is the last drawn row and names where the rest is (§3.1.5)', async () => {
    const rows: BlockRow[] = Array.from({ length: 30 }, (_, i) => ({ kind: 'kv', key: `k${i}`, value: `v${i}` }));
    const expected = blockTexts(rows, blockWidth(100), undefined, { max: 6, moreFooter: '… +{n} more rows (/config --all)' });
    const m = mountApp({ mode: 'session' });
    m.dispatch({ type: 'local', text: 'config', label: '[ui]', detail: expected.join('\n') });
    await waitFor(() => m.lastFrame().includes('[ui] config'));
    const got = blockFrom(m.lastFrame(), 'config');
    expect(got.body.length).toBe(7);
    expect(got.body.at(-1)).toBe('… +24 more rows (/config --all)');
  });

  it('a `gap` is the one row Ink drops: `<Text>{\'\'}</Text>` measures height 0, `<Box height={1}/>` does not (§3.1.3, request to S2)', () => {
    // the fact the request rests on, verified here rather than asserted from the document
    const probe = render(
      <Box flexDirection="column">
        <Text>a</Text>
        <Box marginLeft={LABEL_GUTTER}><Text wrap="truncate">{''}</Text></Box>
        <Text>b</Text>
        <Box height={1} />
        <Text>c</Text>
      </Box>,
    );
    expect(probe.lastFrame()).toBe('a\nb\n\nc');
    // and `renderBlock` does produce the empty row, so the only missing piece is the `<Box height={1}/>`
    const withGap = blockTexts([{ kind: 'kv', key: 'a', value: '1' }, { kind: 'gap' }, { kind: 'kv', key: 'b', value: '2' }], blockWidth(100));
    expect(withGap).toEqual(['a          1', '', 'b          2']);
  });

  it('a block at 40 and at 24 columns still fits, and the tiers differ (§3.1.2, §3.3 edge 1)', () => {
    for (const columns of [24, 40, 80, 120]) {
      const rendered = blockTexts(STATUS_ROWS, blockWidth(columns));
      for (const r of rendered) expect(cellWidth(r), `${columns}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(blockWidth(columns));
    }
    // 40 columns → body 30 → the tight tier: the key keeps its own row and the value is indented 2 (F-B4)
    expect(blockTexts([{ kind: 'kv', key: 'run', value: 'abc' }], blockWidth(40))).toEqual(['run', '  abc']);
    // 80 columns → body 70 → the standard tier: `key.padEnd(10)` + one separator space
    expect(blockTexts([{ kind: 'kv', key: 'run', value: 'abc' }], blockWidth(80))).toEqual(['run        abc']);
  });
});

describe('contract 1.7 item 1: an item carrying `detailRows` is a BLOCK item (§2.3 exemption, §3.1.6)', () => {
  const rows: { text: string; role: ColorRole | null }[] = [
    { text: 'run        20260922-035503-kntk2yw3', role: null },
    { text: 'pending    spend-cap 5.00', role: 'accent' },
    { text: '╶──── sandbox', role: 'code' },
  ];

  it('`isBlockItem` answers true only for an item whose `detailRows` is a non-empty array', () => {
    const plain = localItem('status', 1, { detail: 'run  x' });
    expect(isBlockItem(plain)).toBe(false);
    const block = localItem('status', 2, { detail: rows.map((r) => r.text).join('\n'), detailRows: rows.filter((r): r is { text: string; role: ColorRole } => r.role !== null) });
    expect(isBlockItem(block)).toBe(true);
    // §2.3: a block item is exempt from STATIC_ITEM_MAX_ROWS — its own §3.1.5 cap and footer govern instead
    const many = Array.from({ length: 60 }, (_, i) => `row ${i}`);
    const big = localItem('config', 3, { detail: many.join('\n'), detailRows: many.map((t) => ({ text: t, role: 'dim' as const })), maxDetailLines: Number.POSITIVE_INFINITY });
    expect(isBlockItem(big)).toBe(true);
    expect(itemRenderRows(big, 80).capped).toBe(false);
  });

  it('`detailKind: \'diff\'` rides the item, and `detailRole` classifies ONLY a block that declared it (§3.1.6)', () => {
    const item = localItem('diff · step 1 · scratch_0.py', 4, { detail: '+VALUE_0 = 3\n-VALUE_0 = 0', detailKind: 'diff' });
    expect(item.detailKind).toBe('diff');
    // the gate: the same text in a block with no declared syntax is never painted
    expect(detailRole('+VALUE_0 = 3', 'diff')).toBe('added');
    expect(detailRole('-VALUE_0 = 0', 'diff')).toBe('removed');
    expect(detailRole('@@ -1,3 +1,4 @@', 'diff')).toBe('hunk');
    expect(detailRole('diff --git a/x b/x', 'diff')).toBe('diffMeta');
    expect(detailRole('+VALUE_0 = 3', undefined)).toBeNull();
  });
});
