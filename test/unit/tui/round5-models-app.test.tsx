/**
 * TUI-DESIGN-5 §10 R5-6 `round5-models-app.test.tsx` — the model picker as Ink draws it, at 120×40 and 40×24, with
 * `--ascii`, and with the composer text driving the rows keystroke by keystroke (D-AQ's pane-slot picker).
 *
 * **Why the component is local.** §9.1 gives the React arm to R5-4: "the React component is `src/tui/Picker.tsx`'s
 * new `'models'` arm, owned by R5-4". R5-4's shared-shell PR is W3 and is not on the tree yet, so this file mounts
 * `<ModelsPickerArm/>` — which **is** the hunk R5-6 asks R5-4 to land, verbatim in its body (see the request in
 * R5-6's report). When that PR merges, the two lines that define it here are deleted and the import points at
 * `src/tui/Picker.js`; every assertion below is on the drawn frame and does not change.
 *
 * The pure row text is pinned by `models/lines.test.ts`; what only a mounted component can show is asserted here:
 * the rule row, the marker column, the row window, the provenance row, the padding to the pane height, and that
 * nothing is ever wider than the terminal.
 */
import { Box, Text, render } from 'ink';
import { describe, expect, it } from 'vitest';
import { instantCatalogue } from '../../../src/models/list.js';
import { GLYPHS, cellWidth, type GlyphSet } from '../../../src/tui/glyphs.js';
import { modelRow, modelsRule, modelsSrLine, provenanceRow } from '../../../src/tui/models/lines.js';
import { INITIAL_MODELS, modelsReducer, providersCovered, selectedModel, visibleModels, type ModelsPickerState } from '../../../src/tui/models/state.js';
import { PICKER_PANE_WANT } from '../../../src/tui/Picker.js';
import { StubStdout, stripSgr } from './stub-stdout.js';
import { API, model, result } from './models/helpers.js';

const NOW = Date.parse('2026-09-22T13:00:00.000Z');
const POOL = [
  model('z-ai/glm-5.3-flash', 'openrouter'),
  model('z-ai/glm-5.3', 'openrouter', { pricing: { inputPerM: 0.6, outputPerM: 2 } }),
  model('z-ai/glm-5.2-air', 'openrouter', { contextLength: 200_000, maxOutput: undefined as never, pricing: { inputPerM: 0.05, outputPerM: 0.2 }, supports: { tools: true } }),
  model('claude-sonnet-5', 'anthropic', { pricing: { inputPerM: 2, outputPerM: 10 } }),
];
const RESULTS = [result('openrouter', POOL.slice(0, 3)), result('anthropic', [POOL[3]!], { source: 'cache', fetchedAt: '2026-09-22T10:00:00.000Z', stale: true })];

interface ArmProps {
  state: ModelsPickerState;
  filter: string;
  columns: number;
  rows: number;
  glyphs?: GlyphSet;
}

/**
 * THE HUNK R5-4 LANDS in `src/tui/Picker.tsx` as the `'models'` arm of `pickerLines`/`<Picker>`: the same shape
 * `pickerLines` already has for `'sessions'` and `'rewind'` — a rule row, a window of rows around the selection
 * with the `▌` marker, the provenance row last, and padding to `rows`.
 */
function ModelsPickerArm({ state, filter, columns, rows, glyphs = GLYPHS.unicode }: ArmProps): React.ReactElement {
  const g = glyphs;
  const marker = g.mode === 'ascii' ? '> ' : '▌ ';
  const { hits } = visibleModels(state, API, filter);
  const tail = [provenanceRow(state.results, NOW, columns, API, g)].filter((r) => r !== '');
  const listRows = Math.max(1, rows - 1 - tail.length);
  const start = Math.max(0, Math.min(state.selected - Math.floor(listRows / 2), hits.length - listRows));
  const shown = hits.slice(start, start + listRows);
  const body = shown.map((h, i) => `${start + i === state.selected ? marker : '  '}${modelRow(h.model, columns - 2, API, g)}`);
  // §12.5 S99: the CATALOGUE total (F-58 reads `512` with `glm` typed) and the providers the load COVERS — the
  // first synchronous paint has zero results by construction and `of 0 providers` would be its header
  const lines = [modelsRule({ total: state.models.length, providers: providersCovered(state), columns, glyphs: g }), ...body, ...tail];
  while (lines.length < rows) lines.push('');
  return (
    <Box flexDirection="column">
      {lines.slice(0, rows).map((l, i) =>
        // TD4 §9.2's own note, re-verified here: Ink measures `<Text>{''}</Text>` at height 0, so a padding row
        // must be `<Box height={1}/>` or the pane slot silently collapses under its `PICKER_PANE_WANT` height
        l === '' ? <Box key={i} height={1} /> : <Text key={i}>{l}</Text>,
      )}
    </Box>
  );
}

const open = (): ModelsPickerState => {
  let s = modelsReducer(INITIAL_MODELS, { type: 'open', models: POOL, pending: ['openrouter', 'anthropic'] });
  for (const r of RESULTS) s = modelsReducer(s, { type: 'settled', result: r });
  return s;
};

/**
 * Rendered through a `StubStdout` at the requested size: ink-testing-library's default stdout is 100 columns, so a
 * 120-column frame would wrap there and the width assertions would measure the harness rather than the picker.
 */
function frameOf(props: ArmProps): string[] {
  const stdout = new StubStdout(props.rows + 4, props.columns);
  const instance = render(<ModelsPickerArm {...props} />, { stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false });
  const out = stripSgr(stdout.lastFrame()).replace(/\n$/, '').split('\n');
  instance.unmount();
  return out;
}

describe('the model picker in the pane slot (§6.4 D-AQ, F-58 / F-59)', () => {
  it('120×40: the rule row, the marker on the selection, the provenance row last (F-58)', () => {
    const lines = frameOf({ state: open(), filter: 'glm', columns: 120, rows: PICKER_PANE_WANT });
    expect(lines[0]?.startsWith('─── models · 4 of 2 providers · by relevance ─ ↑↓ Enter Tab Esc ')).toBe(true);
    // `rankModels`' closeness bonus puts the SHORTEST matching id first, so `glm-5.3` leads `glm-5.3-flash`;
    // F-58's frame is illustrative about which row is on top, and `models/lines.test.ts` pins the row text itself
    expect(lines[1]).toBe('▌ z-ai/glm-5.3 · OpenRouter · 1.3M ctx → 944k out · $0.60/M in · $2/M out · tools · json · reasoning');
    expect(lines[2]?.startsWith('  z-ai/glm-5.2-air ')).toBe(true);
    expect(lines[3]?.startsWith('  z-ai/glm-5.3-flash ')).toBe(true);
    expect(lines[4]).toBe('OpenRouter live · Anthropic cached 3 h ago');
    // the pane slot takes `PICKER_PANE_WANT` rows and never more — §11's "no frame taller than the terminal".
    // Ink absorbs the very last blank row into the frame's trailing newline, so the drawn count is `want` or
    // `want - 1`; what must never happen is `> want`, which is what this asserts.
    expect(lines.length).toBeLessThanOrEqual(PICKER_PANE_WANT);
    expect(lines.length).toBeGreaterThan(5);
  });

  it('40×24 after a resize: the rows drop parts, the rule takes its narrow rung, nothing overflows (F-59, §7 row 85)', () => {
    const lines = frameOf({ state: open(), filter: 'glm', columns: 40, rows: 8 });
    expect(lines[0]?.startsWith('─── models · 4 ─ ↑↓ Enter Esc ')).toBe(true);
    expect(lines[1]).toBe('▌ z-ai/glm-5.3 · $0.60/$2');
    for (const l of lines) expect(cellWidth(l)).toBeLessThanOrEqual(40);
  });

  it('--ascii: every glyph substitutes, including the marker (§7 row 81)', () => {
    const lines = frameOf({ state: open(), filter: 'glm', columns: 120, rows: 8, glyphs: GLYPHS.ascii });
    expect(lines[0]?.startsWith('--- models - 4 of 2 providers - by relevance - ^v Enter Tab Esc ')).toBe(true);
    expect(lines[1]?.startsWith('> z-ai/glm-5.3 - OpenRouter - ')).toBe(true);
    for (const l of lines) expect(l).not.toMatch(/[·→▌↑↓─]/);
  });

  it('typing narrows the rows: `glm` is 3, `air` is 1, `zzz` is 0 and the picker still draws its rule', () => {
    const s = open();
    expect(frameOf({ state: s, filter: 'glm', columns: 120, rows: 8 }).filter((l) => l.trim() !== '' && !l.startsWith('───') && !l.startsWith('OpenRouter'))).toHaveLength(3);
    expect(frameOf({ state: s, filter: 'air', columns: 120, rows: 8 }).filter((l) => l.startsWith('▌'))).toHaveLength(1);
    const empty = frameOf({ state: s, filter: 'zzzzzz', columns: 120, rows: 8 });
    // the header counts the CATALOGUE, so a query that matches nothing does not make the picker claim it is empty
    expect(empty[0]?.startsWith('─── models · 4 of 2 providers')).toBe(true);
    expect(empty.some((l) => l.startsWith('▌'))).toBe(false);
  });

  it('↑↓ move the marker and Enter picks the row under it', () => {
    let s = open();
    const { hits } = visibleModels(s, API, 'glm');
    s = modelsReducer(s, { type: 'move', by: 1, count: hits.length });
    expect(frameOf({ state: s, filter: 'glm', columns: 120, rows: 8 })[2]?.startsWith('▌ z-ai/glm-5.2-air ')).toBe(true);
    expect(selectedModel(s, hits)?.id).toBe('z-ai/glm-5.2-air');
    s = modelsReducer(s, { type: 'move', by: -5, count: hits.length });
    expect(selectedModel(s, visibleModels(s, API, 'glm').hits)?.id).toBe('z-ai/glm-5.3');
  });

  it('a provider settling behind the first paint replaces its rows in place, with the frame already drawn', () => {
    const before = modelsReducer(INITIAL_MODELS, { type: 'open', models: instantCatalogue(), pending: ['anthropic'] });
    const firstFrame = frameOf({ state: before, filter: 'claude-sonnet', columns: 120, rows: 6 });
    expect(firstFrame.some((l) => l.startsWith('▌'))).toBe(true);
    /**
     * The FIRST SYNCHRONOUS PAINT's header, asserted (§6.2, §12.5 S99). `results` is `[]` here — that is what
     * "zero awaits" means — so a header built from `results.length` reads `models · 69 of 0 providers` for as
     * long as the network takes. It names the providers the load COVERS and the catalogue it is holding.
     */
    expect(before.results).toEqual([]);
    expect(firstFrame[0]?.startsWith(`─── models · ${before.models.length} of 1 provider · by relevance `)).toBe(true);
    expect(firstFrame[0]).not.toContain('of 0 providers');
    const after = modelsReducer(before, { type: 'settled', result: result('anthropic', [model('claude-sonnet-6', 'anthropic')]) });
    const second = frameOf({ state: after, filter: 'claude-sonnet', columns: 120, rows: 6 });
    expect(second.join('\n')).toContain('claude-sonnet-6');
    expect(second.filter((l) => l.trim() !== '').at(-1)).toBe('Anthropic live');
  });

  it('the screen-reader sentence names the position, the row and the keys (§12.5 S99 SR)', () => {
    const s = open();
    const { hits } = visibleModels(s, API, 'glm');
    expect(modelsSrLine({ index: s.selected, count: hits.length, model: selectedModel(s, hits), text: API })).toBe('models: 1 of 3 · z-ai/glm-5.3 · OpenRouter · $0.60/M in · Enter picks, Tab narrows, Esc closes');
    // §7 row 81 / §14.2 #53: `--ascii` wins over `screenReader`, so the spoken sentence substitutes too
    expect(modelsSrLine({ index: s.selected, count: hits.length, model: selectedModel(s, hits), text: API, glyphs: GLYPHS.ascii })).toBe('models: 1 of 3 - z-ai/glm-5.3 - OpenRouter - $0.60/M in - Enter picks, Tab narrows, Esc closes');
  });

  it('every row of every frame fits its width, at 40, 80 and 120 (G-R5-6)', () => {
    for (const columns of [40, 80, 120]) {
      for (const filter of ['', 'glm', 'claude']) {
        for (const l of frameOf({ state: open(), filter, columns, rows: PICKER_PANE_WANT })) expect(cellWidth(l)).toBeLessThanOrEqual(columns);
      }
    }
  });
});
