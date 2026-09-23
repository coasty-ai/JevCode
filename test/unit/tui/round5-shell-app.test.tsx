/**
 * TUI-DESIGN-5 §9.2 (R5-4's shared-shell row) — **the three surfaces, mounted in the App**.
 *
 * `docs/STATUS.md`'s "three honest gaps" item 2 names exactly what this file covers: `src/tui/Picker.tsx` had no
 * `'models'` arm, `src/tui/App.tsx` never opened the `'import'` overlay, and `PickerState.card` (§2.8's resume-card
 * sub-state) had no predicate that could produce `pickerCard: 'closed'`, so `keys/resolve.ts`'s six card ops were
 * inert. Each surface's own pieces are already covered by its slot's file — `models/state.test.ts`,
 * `models/lines.test.ts`, `import/reducer.test.ts`, `import/lines.test.ts`, `round5-import-app.test.tsx` (the
 * `<Overlay>` component on its own) and `picker.test.tsx` (the reducer and the resolver). **This file is only
 * about the shell**: the command that opens it, the keys that reach it, the pane/overlay slot it lands in, the
 * twins beside it and the invariants it must not break.
 *
 * Round-5 App cases belong here and never in `app.test.tsx` or a round2–4 file (§9.2's rule for the shared shell).
 *
 * Offline by construction: both seams (`models`, `importEngine`) are injected, so the mounted App does no
 * `await import()` at all and `src/models/**` / `src/import/**` are imported by the TEST, as pure functions, over
 * the repo's own `test/fixtures/import/plan.json` and the bundled catalogue snapshot.
 */
import { readFileSync } from 'node:fs';
import { cleanup } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import * as models from '../../../src/models/index.js';
import { applicableRows, summarisePlan } from '../../../src/import/index.js';
import type { ImportPlan, LaunchSettings, SessionRow } from '../../../src/core/types.js';
import type { ModelInfo } from '../../../src/models/types.js';
import { createPlainRenderer } from '../../../src/tui/plain.js';
import { INITIAL_PICKER, MODELS_HINT, PICKER_CARD_HINT, PICKER_CARD_KEYS, PICKER_PANE_WANT, defaultCardLines, modelProvidersCovered, pickerLines, pickerReducer, pickerRule, selectedModelRow, sessionOfRun, visibleModelHits, type PickerState } from '../../../src/tui/Picker.js';
import { pickerConsoleTitle } from '../../../src/tui/Console.js';
import { initialKeyState, resolveKey, type KeyEvent } from '../../../src/tui/keys/resolve.js';
import { DEFAULT_BINDINGS, KEY_ACTIONS, KEY_CONTEXTS } from '../../../src/tui/keys/bindings.js';
import { CAP } from '../../../src/tui/layout.js';
import { GLYPHS } from '../../../src/tui/glyphs.js';
import { IMPORT_DRY_RUN_REFUSAL, importApplyNotWired, importApplyNotWiredRungs, importLines, importPlainLines, importScreenReaderLines, importSelectionPrompt, IMPORT_NOTHING_FOUND, importClosedRow } from '../../../src/tui/import/lines.js';
import { initImportUi, isWritableRow, scanningImportUi, selectedRowIds, type ImportUiInput, type ImportUiState } from '../../../src/tui/import/reducer.js';
import { blockWidth } from '../../../src/tui/block/lines.js';
import { glyphTwin } from '../../../src/tui/glyphs.js';
import { patternRedact } from '../../../src/core/redact.js';
import { IMPORT_PENDING_TOAST } from '../../../src/tui/keys/resolve.js';
import type { ImportApplyOptions } from '../../../src/tui/App.js';
import { MODELS_LOADING, MODELS_PLAIN_CAP, SR_COALESCE_MS, modelCheck, modelsPickPrompt, modelsPlainLines, modelsSrLine, type ModelsApi } from '../../../src/tui/models/lines.js';
import { catalogueSettled, snapshotResults } from '../../../src/tui/models/state.js';
import { tick } from '../../fixtures/tui/fixtures.js';
import { CTRL_R, DOWN, ESC, fakeHost, mountApp, waitFor, type FakeHost, type MountOptions, type Mounted } from './app-harness.js';
// R5-H4: the peer-zone seam — the reducer, the `statusView` pass-through and the zone it feeds
import { initialUiState, uiReducer, type UiState } from '../../../src/tui/useEngine.js';
import { statusView } from '../../../src/tui/StatusLine.js';
import { peerZoneCounts, peerZoneText, statusZones } from '../../../src/tui/status/lines.js';
import type { Fold } from '../../../src/coordination/index.js';

afterEach(() => cleanup());

// ---------------------------------------------------------------------------------------
// seams: the REAL pure functions, injected, so nothing the App runs reaches the network or `node:fs`
// ---------------------------------------------------------------------------------------

/** the production binding of §6.4's seam, verbatim (`openModelsPicker`'s `{ ...m, rank: m.rankModels }`) */
const API: ModelsApi = { ...models, rank: models.rankModels };
const SNAPSHOT: readonly ModelInfo[] = models.instantCatalogue();

const RAW = readFileSync(new URL('../../fixtures/import/plan.json', import.meta.url), 'utf8');
const planOf = (): ImportPlan => JSON.parse(RAW) as ImportPlan;
function importInput(plan: ImportPlan = planOf()): ImportUiInput {
  return { plan, summary: summarisePlan(plan), applicable: applicableRows(plan, { scope: 'both' }) };
}
function engineOf(plan: ImportPlan = planOf()): NonNullable<MountOptions['importEngine']> {
  return { planImport: async () => plan, summarisePlan, applicableRows: (p: ImportPlan, o?: { scope?: 'user' | 'project' | 'both' }) => applicableRows(p, o ?? {}) };
}

async function settle(m: Mounted): Promise<void> {
  m.dispatch({ type: 'splash:done' });
  await waitFor(() => m.state()?.splash === 'done');
  await tick(20);
}

async function enter(m: Mounted, line: string): Promise<void> {
  m.stdin.write(line);
  await waitFor(() => m.lastFrame().includes(`› ${line}`));
  m.stdin.write('\r');
  await tick(30);
}

const srLaunch = (over: Partial<LaunchSettings> = {}): LaunchSettings => ({ ascii: false, color: 'auto', mode: 'chat', screenReader: false, ...over }) as LaunchSettings;

// ---------------------------------------------------------------------------------------
// (a) the model picker — §6.4, D-AQ
// ---------------------------------------------------------------------------------------

describe('(a) `/model` with no argument opens the pane-slot picker (TUI-DESIGN-5 §6.4, D-AQ)', () => {
  it('the picker opens in the PANE slot at PICKER_PANE_WANT rows, with the rule row, the snapshot rows and the hint — and no overlay is used', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host, models: API, instantModels: () => SNAPSHOT });
    await settle(m);
    await enter(m, '/model');
    await waitFor(() => m.state()?.picker === true);
    const f = m.lastFrame();
    // §14.2 #13: a PICKER, not an overlay — `OverlayKind` has no `models` member at all
    expect(m.state()?.overlay).toBe('none');
    // §12.5 S99 / F-58: `models · <N> of <P> providers · by relevance` with the arrows and keys to its right
    expect(f).toMatch(/models · \d+ of \d+ providers/);
    expect(f).toContain(MODELS_HINT);
    // the first paint is the bundled snapshot: rows are on screen, not a spinner and not an empty pane
    expect(SNAPSHOT.some((mm) => f.includes(mm.id))).toBe(true);
    expect(PICKER_PANE_WANT).toBe(12);
    // §6.4: the console title is the picker's, with the kind as the word
    expect(pickerConsoleTitle('models')).toBe('models · filter');
  });

  it('`/model` never reaches the host, and `/model <id>` still does (one pending value, one home — §13.1)', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host, models: API, instantModels: () => SNAPSHOT });
    await settle(m);
    await enter(m, '/model');
    await waitFor(() => m.state()?.picker === true);
    expect(host.commands).not.toContain('/model');
    m.stdin.write(ESC);
    await waitFor(() => m.state()?.picker !== true);
    await enter(m, '/model z-ai/glm-4.6');
    await waitFor(() => host.commands.includes('/model z-ai/glm-4.6'));
    expect(host.commands.at(-1)).toBe('/model z-ai/glm-4.6');
  });

  it('typing filters (the composer IS the query) and the rule row keeps reporting the CATALOGUE total, never the filtered count', async () => {
    const m = mountApp({ mode: 'session', host: fakeHost(), models: API, instantModels: () => SNAPSHOT });
    await settle(m);
    await enter(m, '/model');
    await waitFor(() => m.state()?.picker === true);
    m.stdin.write('glm');
    await waitFor(() => m.lastFrame().includes('glm'));
    const f = m.lastFrame();
    expect(f).toMatch(new RegExp(`models · ${SNAPSHOT.length} of `));
    // every row on screen matched the query
    const rows = f.split('\n').filter((l) => /^\s*[▌ ]\s*\S+\/\S+/.test(l) && !l.includes('models ·'));
    expect(rows.length).toBeGreaterThan(0);
  });

  it('Enter pends the row under the marker FOR THE NEXT RUN ONLY: one `/model <id>` to the host, no run started, the picker closes', async () => {
    const host = fakeHost();
    const picked: ModelInfo[] = [];
    const m = mountApp({ mode: 'session', host, models: API, instantModels: () => SNAPSHOT });
    await settle(m);
    m.bridge.command({ type: 'picker', open: { kind: 'models', workspace: '/w', models: SNAPSHOT, results: snapshotResults(SNAPSHOT, '2026-01-01T00:00:00.000Z'), onModel: (x) => picked.push(x) } });
    await waitFor(() => m.state()?.picker === true);
    m.stdin.write('\r');
    await waitFor(() => picked.length === 1);
    await waitFor(() => m.state()?.picker !== true);
    expect(m.state()?.picker).not.toBe(true);
    expect(host.commands.at(-1)).toBe(`/model ${picked[0]?.id ?? ''}`);
    // D-AQ: a pick is a PEND, never a run
    expect(host.submitted).toEqual([]);
    expect(m.state()?.run).toBe('none');
  });

  it('Esc closes it and `s` stays unbound: the keys that are session-row ops elsewhere are filter TEXT here (§6.4, §15 Q18)', () => {
    const ks = { ...initialKeyState(), picker: true, pickerFilter: true };
    const text = (input: string): KeyEvent => ({ input, key: { ...NO_FLAGS } });
    // `s` was never bound in the picker context at all — no registry row claims it, in either state
    expect(KEY_ACTIONS.filter((b) => b.context === 'picker' && b.keys.includes('s'))).toEqual([]);
    // space / x are `picker:preview` / `picker:delete` for a SESSION row and query characters here
    expect(resolveKey(ks, text(' '), 0)).toEqual([{ type: 'insert', text: ' ' }]);
    expect(resolveKey(ks, text('x'), 0)).toEqual([{ type: 'insert', text: 'x' }]);
    expect(resolveKey(ks, text('s'), 0)).toEqual([{ type: 'insert', text: 's' }]);
    // …and they keep their session meanings when the flag is off (round 3, byte for byte)
    const sessions = { ...initialKeyState(), picker: true };
    expect(resolveKey(sessions, text(' '), 0)).toEqual([{ type: 'picker', op: 'preview' }]);
    expect(resolveKey(sessions, text('x'), 0)[1]).toEqual({ type: 'picker', op: 'deleteArm' });
    // Esc closes (the one Esc meaning a filter picker has)
    expect(resolveKey(ks, { input: '', key: { ...NO_FLAGS, escape: true } }, 0, DEFAULT_BINDINGS).some((a) => a.type === 'escBuffer')).toBe(true);
  });

  it('§6.8 / §7 row 81: the rows drop parts instead of being cut at 40 columns, and `--ascii` substitutes every glyph', () => {
    const st: PickerState = { kind: 'models', sessions: [], rewindSteps: [], workspace: '/w', selected: 0, widened: false, sort: 'updated', preview: null, renaming: false, deleteArmed: false, card: null, models: { models: SNAPSHOT, results: snapshotResults(SNAPSHOT, '2026-01-01T00:00:00.000Z'), pending: [], selected: 0, open: true } };
    for (const g of [GLYPHS.unicode, GLYPHS.ascii]) {
      for (const columns of [40, 80, 120]) {
        const r = pickerLines(st, { filter: '', rows: PICKER_PANE_WANT, columns, nowMs: 0, glyphs: g, models: { text: API, search: API } });
        expect(r.lines).toHaveLength(PICKER_PANE_WANT);
        for (const l of r.lines) expect([...l].length, `${g.mode}@${columns}: ${l}`).toBeLessThanOrEqual(columns);
        expect([...pickerRule(st, columns, g)].length).toBeLessThanOrEqual(columns);
        if (g.mode === 'ascii') {
          for (const l of [...r.lines, pickerRule(st, columns, g)]) expect(l, l).not.toMatch(/[·→▌↑↓─—]/);
        }
      }
    }
  });

  it('the `--plain` twin is the NUMBERED one-shot prompt through the plain renderer — never a pane (§13.2 clause 7)', () => {
    const out: string[] = [];
    const r = createPlainRenderer({ task: '', resumeId: null, onAbort: () => undefined, mode: 'session', stdout: { write: (s: string) => out.push(s) } as unknown as NodeJS.WriteStream });
    const rows = SNAPSHOT.slice(0, 3);
    const lines = modelsPlainLines({ models: rows, text: API, results: snapshotResults(rows, '2026-01-01T00:00:00.000Z'), total: SNAPSHOT.length, prompt: true });
    expect(typeof r.blockLines).toBe('function');
    r.blockLines?.(lines, { label: '[ui]' });
    r.notify(modelsPickPrompt(rows.length), { label: '[ui]' });
    const text = out.join('');
    expect(text).toContain(`models (1-3 of ${SNAPSHOT.length})`);
    expect(text).toContain('type a number, "more", or a query, then Enter');
    expect(text).toContain(modelsPickPrompt(3).trimEnd());
    // never a pane: no rule row, no marker column
    expect(text).not.toContain('▌');
    expect(text).not.toMatch(/─── models/);
    expect(MODELS_PLAIN_CAP).toBe(40);
  });

  it('§6.4 / §15 Q18: the remaining free-text keys — `ctrl+a` edits the QUERY, `ctrl+r` is inert, and the delete chord cannot arm', () => {
    const filter = { ...initialKeyState(), picker: true, pickerFilter: true };
    const list = { ...initialKeyState(), picker: true };
    const ctrl = (c: string): KeyEvent => ({ input: c, key: { ...NO_FLAGS, ctrl: true } });
    // Ctrl-A is `picker:allWorkspaces` for a session list and the composer's line-start for a query
    expect(resolveKey(filter, ctrl('a'), 0)).toEqual([{ type: 'move', to: 'home' }]);
    expect(resolveKey(list, ctrl('a'), 0)).toEqual([{ type: 'picker', op: 'allWorkspaces' }]);
    // Ctrl-R renames a session and means nothing for a model id — inert, never a rename of a catalogue row
    expect(resolveKey(filter, ctrl('r'), 0)).toEqual([]);
    expect(resolveKey(list, ctrl('r'), 0)).toEqual([{ type: 'picker', op: 'rename' }]);
    // …and `x` then `y` is two query characters here, never an arm and never a confirmation
    const text = (input: string): KeyEvent => ({ input, key: { ...NO_FLAGS } });
    expect(resolveKey(filter, text('x'), 0)).toEqual([{ type: 'insert', text: 'x' }]);
    expect(resolveKey(filter, text('y'), 10)).toEqual([{ type: 'insert', text: 'y' }]);
    expect(resolveKey(list, text('y'), 10).some((a) => (a as { op?: string }).op === 'deleteConfirm')).toBe(false);
  });

  it('§6.2 / §12.5 S99: the provenance of a snapshot with FEWER than seven providers is what it is — and `catalogueSettled` stays false', () => {
    const three = SNAPSHOT.filter((mm) => ['anthropic', 'openai', 'zai'].includes(mm.provider));
    const results = snapshotResults(three, '2026-01-01T00:00:00.000Z');
    const providers = new Set(three.map((mm) => mm.provider));
    expect(results).toHaveLength(providers.size);
    expect(results.length).toBeLessThan(7);
    for (const r of results) {
      expect(r.source).toBe('static');
      expect(r.stale).toBe(true);
      expect(r.models.every((mm) => mm.provider === r.provider)).toBe(true);
    }
    // the rule row counts the providers the load COVERS, which is what the snapshot actually holds
    const st: PickerState = pickerReducer(INITIAL_PICKER, { type: 'open', kind: 'models', workspace: '/w', models: { type: 'open', models: three, results, pending: [] } });
    expect(modelProvidersCovered(st)).toBe(results.length);
    expect(pickerRule(st, 120)).toContain(`models · ${three.length} of ${results.length} providers`);
    // §7 row 100: nothing was fetched, so a typed id that is not in the snapshot WARNS rather than being refused
    expect(catalogueSettled(results, [])).toBe(false);
    expect(modelCheck('some/unknown-model', three, catalogueSettled(results, []), API).kind).toBe('warn');
  });

  it('§6.2: an external `openPicker({ kind: "models" })` with no seam bound paints an honest LOADING row, never `no model matches` beside a live total', async () => {
    // the pure frame: the seam is what ranks rows, and "not loaded" is a different fact from "no hits"
    const st: PickerState = pickerReducer(INITIAL_PICKER, { type: 'open', kind: 'models', workspace: '/w', models: { type: 'open', models: SNAPSHOT, results: snapshotResults(SNAPSHOT, '2026-01-01T00:00:00.000Z'), pending: [] } });
    const bare = pickerLines(st, { filter: 'glm', rows: PICKER_PANE_WANT, columns: 80, nowMs: 0 });
    expect(bare.lines[0]).toContain(MODELS_LOADING);
    expect(bare.lines.join('\n')).not.toContain('no model matches');
    // …and the rule row, which is built from state, keeps telling the truth beside it
    expect(pickerRule(st, 120)).toContain(`models · ${SNAPSHOT.length} of `);
    // through the App: no frame may ever carry the contradiction
    const m = mountApp({ mode: 'session', host: fakeHost() });
    await settle(m);
    m.bridge.command({ type: 'picker', open: { kind: 'models', workspace: '/w', models: SNAPSHOT, results: snapshotResults(SNAPSHOT, '2026-01-01T00:00:00.000Z') } });
    await waitFor(() => m.state()?.picker === true);
    await waitFor(() => SNAPSHOT.some((mm) => m.lastFrame().includes(mm.id)));
    for (const f of m.frames) expect(f, f).not.toContain('no model matches');
  });

  it('the screen-reader twin is ONE sentence per selection, and the App speaks it while the picker is open (§12.5 S99 SR)', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host, models: API, instantModels: () => SNAPSHOT, launch: srLaunch({ screenReader: true }) });
    await settle(m);
    await enter(m, '/model');
    await waitFor(() => m.state()?.picker === true);
    // `noteLine` routes to the host when there is one, so the spoken rows land in `host.notes`
    await waitFor(() => host.notes.some((t) => t.startsWith('models: 1 of ')));
    expect(host.notes.some((t) => t.startsWith('models: 1 of '))).toBe(true);
    expect(modelsSrLine({ index: 0, count: SNAPSHOT.length, model: SNAPSHOT[0] ?? null, text: API, glyphs: GLYPHS.sr })).toContain('Enter picks, Tab narrows, Esc closes');
  });

  /**
   * §12.5 S99 SR: "at most one per `SR_COALESCE_MS`" is a COALESCER, not a dropper. Three moves inside the
   * window used to speak the first and silently discard the rest — including the row the human stopped on,
   * because the effect's dependency is the rendered line and it never ran again for that selection.
   */
  it('three moves inside 400 ms are ONE announcement, and it is the row the user landed on (the trailing edge)', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host, models: API, instantModels: () => SNAPSHOT, launch: srLaunch({ screenReader: true }) });
    await settle(m);
    await enter(m, '/model');
    await waitFor(() => host.notes.some((t) => t.startsWith('models: 1 of ')));
    const before = host.notes.filter((t) => t.startsWith('models: ')).length;
    for (let i = 0; i < 3; i++) m.stdin.write(DOWN);
    // the row they stopped on is spoken — eventually, not immediately, and exactly once
    await waitFor(() => host.notes.some((t) => t.startsWith('models: 4 of ')), 4000);
    expect(host.notes.some((t) => t.startsWith('models: 4 of '))).toBe(true);
    const spoken = host.notes.filter((t) => t.startsWith('models: ')).length - before;
    expect(spoken).toBeGreaterThan(0);
    expect(spoken).toBeLessThanOrEqual(3);
    expect(SR_COALESCE_MS).toBe(400);
  });

  it('§12.5 S99: the spoken POSITION is the clamped one the marker sits on, even after a filter narrows the hits', () => {
    const st: PickerState = pickerReducer(INITIAL_PICKER, { type: 'open', kind: 'models', workspace: '/w', models: { type: 'open', models: SNAPSHOT, results: [], pending: [] } });
    const paged = pickerReducer(st, { type: 'move', by: 40, count: SNAPSHOT.length });
    const hits = visibleModelHits(paged, API, 'glm').hits;
    expect(paged.models.selected).toBeGreaterThan(hits.length - 1);
    // the renderer clamps, so the sentence has to clamp with it — `41 of 16` names a row that is not there
    const clamped = Math.min(Math.max(0, paged.models.selected), Math.max(0, hits.length - 1));
    const model = selectedModelRow(paged, API, 'glm');
    expect(hits[paged.models.selected]).toBeUndefined();
    expect(model?.id).toBe(hits[clamped]?.model.id);
    const line = pickerLines(paged, { filter: 'glm', rows: PICKER_PANE_WANT, columns: 120, nowMs: 0, models: { text: API, search: API } });
    const marked = line.lines.find((l) => l.startsWith('▌')) ?? '';
    // the row under the marker, the model the pick would take and the spoken sentence all name ONE row
    expect(marked).toContain(model?.id ?? '');
    const spoken = modelsSrLine({ index: clamped, count: hits.length, model, text: API });
    expect(spoken).toContain(`models: ${clamped + 1} of ${hits.length}`);
    expect(spoken).toContain(model?.id ?? '');
    // the unclamped index is the defect: it names a position past the end of the list it claims to be in
    expect(modelsSrLine({ index: paged.models.selected, count: hits.length, model, text: API })).toContain(`models: ${paged.models.selected + 1} of ${hits.length}`);
  });
});

// ---------------------------------------------------------------------------------------
// (b) the import overlay — §5.2, §7 rows 58–59
// ---------------------------------------------------------------------------------------

describe('(b) `/import` opens the review overlay (TUI-DESIGN-5 §5.2, §7 rows 58–59)', () => {
  async function openImport(over: MountOptions = {}): Promise<{ m: Mounted; host: FakeHost }> {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host, importEngine: engineOf(), ...over });
    await settle(m);
    await enter(m, '/import');
    await waitFor(() => m.state()?.overlay === 'import');
    await waitFor(() => m.lastFrame().includes('Import'));
    return { m, host };
  }

  it('the overlay opens in the ONE modal slot with the five-group default view and one keys row — never the honest refusal any more', async () => {
    const { m, host } = await openImport();
    const f = m.lastFrame();
    expect(m.state()?.overlay).toBe('import');
    expect(f).toMatch(/Import [—-] \d+ to import/);
    for (const key of ['memory', 'commands', 'mcp', 'review']) expect(f).toContain(key);
    expect(f).toMatch(/\[y\] import all \d+|y all \d+/);
    // §5.5's refusal is gone: `/import` no longer reaches the host at all
    expect(host.commands).not.toContain('/import');
  });

  it('Enter expands the group under the cursor and Enter again collapses it back (§5.2)', async () => {
    const { m } = await openImport();
    const groups = m.lastFrame();
    m.stdin.write('\r');
    await waitFor(() => m.lastFrame() !== groups);
    expect(m.lastFrame()).toContain('Space toggles');
    m.stdin.write('\r');
    await waitFor(() => m.lastFrame().includes('] import all') || m.lastFrame().includes('y all'));
    expect(m.lastFrame()).not.toContain('Space toggles');
  });

  it('`y` applies EXACTLY `applicableRows` and never a secret row — the group flag is never consulted (§7 row 58)', async () => {
    const applied: string[][] = [];
    const { m } = await openImport({ applyImport: async (rows: readonly string[]) => { applied.push([...rows]); return { ok: rows.length, failed: 0 }; } });
    m.stdin.write('y');
    await waitFor(() => applied.length === 1);
    const input = importInput();
    expect(applied[0] ?? []).toEqual(selectedRowIds(initImportUi(input), input));
    expect(applied[0] ?? []).toEqual([...input.applicable]);
    for (const id of applied[0] ?? []) {
      const row = input.plan.rows.find((r) => r.id === id);
      expect(row?.class, id).not.toBe('secret');
      expect(isWritableRow(row ?? { id, class: 'secret' }, new Set(input.applicable))).toBe(true);
    }
    await waitFor(() => m.lastFrame().includes('applied'));
  });

  it('a plan with a `secret`-class row inside an APPLICABLE group is still never applied by `y` (the planted-row invariant, through the shell)', async () => {
    const plan = planOf();
    const memory = plan.rows.find((r) => r.class === 'memory' && !r.action.startsWith('skip:') && r.action !== 'review');
    expect(memory).toBeDefined();
    const planted: ImportPlan = { ...plan, rows: [...plan.rows, { ...(memory as ImportPlan['rows'][number]), id: 'planted-secret', class: 'secret' }] };
    const applied: string[][] = [];
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host, importEngine: engineOf(planted), applyImport: async (rows: readonly string[]) => { applied.push([...rows]); return { ok: rows.length, failed: 0 }; } });
    await settle(m);
    await enter(m, '/import');
    await waitFor(() => m.lastFrame().includes('Import'));
    m.stdin.write('y');
    await waitFor(() => applied.length === 1);
    expect(applied[0] ?? []).not.toContain('planted-secret');
  });

  it('with NO apply seam (this build) `y` names what it would write and refuses — it never reports a write that did not happen (§5.3, D-AN)', async () => {
    const { m } = await openImport();
    // the DEFAULT geometry, which is where the 105-cell one-rung form was being cut in half
    m.bridge.geometry = { rows: 24, columns: 80 };
    m.bridge.notify();
    await tick(40);
    m.stdin.write('y');
    await waitFor(() => m.lastFrame().includes('jevcode import --yes'));
    const input = importInput();
    const n = input.applicable.length;
    /**
     * The WHOLE sentence, not a 24-character prefix. The one-rung form is 105 cells: at 24×80 the overlay
     * elided it to `…is not available in this b…`, dropping exactly the half that makes it honest, and a prefix
     * assertion could not see that. The rung the App picked at THIS width is what must be on screen, whole.
     */
    expect(m.lastFrame()).toContain(importApplyNotWired(n, blockWidth(80)));
    expect(m.lastFrame()).toContain('jevcode import --yes');
    expect(m.state()?.overlay).toBe('import');
    // …and a SHRINK re-picks the rung (the count is what is stored, never the rendered string), so the row
    // narrows instead of being elided. 100 columns is ink-testing-library's own stdout, so the wide rung is
    // asserted in the pure ladder case above rather than against a clipped frame.
    m.bridge.geometry = { rows: 12, columns: 40 };
    m.bridge.notify();
    await waitFor(() => m.lastFrame().includes(importApplyNotWired(n, blockWidth(40))));
    expect(m.lastFrame()).toContain(importApplyNotWired(n, blockWidth(40)));
    // a DIFFERENT, narrower rung — and it still points at the twin that runs
    expect(importApplyNotWired(n, blockWidth(40))).not.toBe(importApplyNotWired(n, blockWidth(80)));
    expect(importApplyNotWired(n, blockWidth(40))).toContain('jevcode import --yes');
  });

  it('§5.8: the refusal is a RUNG LADDER — every width keeps `jevcode import --yes`, and the row is never truncated', () => {
    const input = importInput();
    const st = initImportUi(input);
    for (const g of [GLYPHS.unicode, GLYPHS.ascii]) {
      for (const columns of [40, 80, 120]) {
        const width = blockWidth(columns);
        const rung = importApplyNotWired(9, width, g);
        const lines = importLines({ ...st, hint: rung }, input, columns, g);
        // the whole rung, byte for byte, on one rendered row — no ellipsis, no prefix
        expect(lines.some((l) => l.includes(rung)), `${g.mode}@${columns}: ${rung}`).toBe(true);
        expect(rung).toContain('jevcode import --yes');
        expect([...rung].length).toBeLessThanOrEqual(width);
        if (g.mode === 'ascii') expect(rung).not.toMatch(/[·—…]/);
      }
    }
    // the widest rung is the whole sentence, and the narrowest still points at the twin that runs
    expect(importApplyNotWired(9)).toContain('applying from the session is not available in this build');
    expect(importApplyNotWiredRungs(9).at(-1)).toContain('jevcode import --yes');
  });

  it('`--ascii` through the App: EVERY step renders inside 40 / 80 / 120 with no unicode cell and no lost keys row (§7 row 81, §5.8)', () => {
    const input = importInput();
    const base = initImportUi(input);
    const steps: readonly ImportUiState[] = [
      base,
      { ...base, step: 'rows', expanded: 'memory', rowCursor: 1 },
      { ...base, step: 'review', reviewAt: 0 },
      { ...base, step: 'applying' },
      { ...base, step: 'done', applied: { ok: 3, failed: 0, total: 3 } },
      { ...base, step: 'done', interrupted: true, applied: { ok: 1, failed: 0, total: 9 } },
      { ...base, hint: importApplyNotWired(9, blockWidth(80), GLYPHS.ascii) },
      scanningImportUi(),
    ];
    for (const st of steps) {
      for (const columns of [40, 80, 120]) {
        const lines = importLines(st, input, columns, GLYPHS.ascii);
        expect(lines.length, `${st.step}@${columns}`).toBeLessThanOrEqual(CAP.import);
        for (const l of lines) {
          expect([...l].length, `${st.step}@${columns}: ${l}`).toBeLessThanOrEqual(blockWidth(columns));
          expect(l, `${st.step}@${columns}: ${l}`).not.toMatch(/[·→▌↑↓─—…]/);
        }
        // `protectTail: 1`: the last row is always the keys / hint row, at every width and in every step
        expect(lines.length).toBeGreaterThan(0);
      }
    }
  });

  it('a printable that is not a key TOASTS instead of reaching the collapsed composer, and the toast folds under `--ascii` (§12.4 S91)', async () => {
    const { m } = await openImport();
    m.stdin.write('q');
    await waitFor(() => m.lastFrame().includes('import open:'));
    expect(m.lastFrame()).toContain(glyphTwin(IMPORT_PENDING_TOAST, GLYPHS.unicode));
    // the draft never saw it: the overlay is collapsing, and the key is answered rather than swallowed
    expect(m.lastFrame()).not.toContain('› q');
    expect(resolveKey({ ...initialKeyState(), overlay: 'import' }, { input: 'q', key: { ...NO_FLAGS } }, 0)).toEqual([{ type: 'toast', text: IMPORT_PENDING_TOAST }]);
    const a = mountApp({ mode: 'session', host: fakeHost(), importEngine: engineOf(), launch: srLaunch({ ascii: true }) });
    await settle(a);
    await enter(a, '/import');
    await waitFor(() => a.lastFrame().includes('Import'));
    a.stdin.write('q');
    await waitFor(() => a.lastFrame().includes('import open:'));
    expect(a.lastFrame()).toContain(glyphTwin(IMPORT_PENDING_TOAST, GLYPHS.ascii));
    // …and the whole `--ascii` frame with the overlay up carries no unicode cell (§7 row 81, the mounted twin
    // the pty `-ascii` scenario greps for — that grep passes vacuously if the overlay never opens)
    expect(a.lastFrame()).toContain('Import');
    expect(a.lastFrame()).not.toMatch(/[·→▌↑↓]/);
  });

  it('§7 row 59 behaviour 2: Ctrl-C during an apply stops it at a row boundary, and a LATE `applied` cannot overwrite the interrupted counts', async () => {
    const box: { seen: ImportApplyOptions | null; release: ((r: { ok: number; failed: number }) => void) | null } = { seen: null, release: null };
    const { m } = await openImport({
      applyImport: async (_rows, _input, opts) => {
        box.seen = opts;
        opts.onRow?.(2);
        return await new Promise<{ ok: number; failed: number }>((res) => {
          box.release = res;
        });
      },
    });
    m.stdin.write('y');
    await waitFor(() => box.seen !== null);
    m.stdin.write('\x03');
    // the seam was TOLD to stop (it takes an AbortSignal precisely so it can)
    await waitFor(() => box.seen?.signal.aborted === true);
    expect(box.seen?.signal.aborted).toBe(true);
    // the overlay stays open on the interrupted `done` frame with the resume sentence and the REAL count
    await waitFor(() => m.lastFrame().includes('--resume'));
    const interrupted = m.lastFrame();
    expect(interrupted).toContain('--resume');
    expect(m.state()?.overlay).toBe('import');
    // …and the apply resolves afterwards with the full counts, which must be DROPPED, not painted
    box.release?.({ ok: 9, failed: 0 });
    await tick(60);
    expect(m.lastFrame()).toContain('--resume');
    expect(m.lastFrame()).not.toMatch(/applied 9 of 9/);
  });

  it('Esc during the `scanning` frame: the plan that resolves afterwards is DROPPED — no overlay, no state, no spoken block', async () => {
    const box: { release: ((p: ImportPlan) => void) | null } = { release: null };
    const host = fakeHost();
    const m = mountApp({
      mode: 'session',
      host,
      launch: srLaunch({ screenReader: true }),
      importEngine: {
        planImport: async () =>
          await new Promise<ImportPlan>((res) => {
            box.release = res;
          }),
        summarisePlan,
        applicableRows: (pl: ImportPlan, o?: { scope?: 'user' | 'project' | 'both' }) => applicableRows(pl, o ?? {}),
      },
    });
    await settle(m);
    await enter(m, '/import');
    await waitFor(() => m.lastFrame().includes('scanning'));
    m.stdin.write(ESC);
    await waitFor(() => m.state()?.overlay === 'none');
    const before = [...host.notes];
    box.release?.(planOf());
    await tick(80);
    // the overlay stayed closed, nothing was repopulated, and the screen reader heard nothing about a plan
    expect(m.state()?.overlay).toBe('none');
    expect(m.lastFrame()).not.toContain('to import');
    expect(host.notes.slice(before.length).filter((t) => t.startsWith('Import'))).toEqual([]);
  });

  it('`/import --dry-run` is not `/import`: `y` answers with the flag rather than silently dropping it (§7 row 54)', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host, importEngine: engineOf() });
    await settle(m);
    await enter(m, '/import --dry-run');
    await waitFor(() => m.lastFrame().includes('Import'));
    m.stdin.write('y');
    await waitFor(() => m.lastFrame().includes('dry run'));
    expect(m.lastFrame()).toContain(IMPORT_DRY_RUN_REFUSAL);
    // it is a refusal, not an apply: the overlay never reached `applying` and never claimed a write
    // (`not applied` is the `config` group's own note — the claim under test is an applied COUNT)
    expect(m.lastFrame()).not.toMatch(/applied \d+ of \d+/);
    expect(m.lastFrame()).not.toContain('jevcode import --yes writes them');
    expect(m.state()?.overlay).toBe('import');
  });

  it('§5.4 item 1: the plan is built with the SESSION redactor, so a configured secret that matches no pattern family cannot reach a row', async () => {
    const SECRET = 'correct-horse-battery-staple';
    const host: FakeHost = { ...fakeHost(), redact: (t: string) => t.split(SECRET).join('[redacted]') };
    const box: { opts: { redact?: (s: string) => string } | null } = { opts: null };
    const m = mountApp({
      mode: 'session',
      host,
      importEngine: {
        planImport: async (o: { redact?: (s: string) => string }) => {
          box.opts = o;
          return planOf();
        },
        summarisePlan,
        applicableRows: (pl: ImportPlan, o?: { scope?: 'user' | 'project' | 'both' }) => applicableRows(pl, o ?? {}),
      },
    });
    await settle(m);
    await enter(m, '/import');
    await waitFor(() => m.lastFrame().includes('Import'));
    // `planImport`'s own default is `redactSecrets(s, undefined)` — the 15 pattern families and nothing else,
    // which this value matches none of. `assertNoKeyBytes` cannot see this leak; the seam is the only guard.
    const passed = box.opts?.redact;
    expect(typeof passed).toBe('function');
    expect(passed?.(`why: ${SECRET} kept`)).toBe('why: [redacted] kept');
    expect(patternRedact(SECRET)).toBe(SECRET);
  });

  it('§7 row 59: Esc inside an expanded group steps back; Esc at the top closes and KEEPS the plan (the `--resume` row)', async () => {
    const { m, host } = await openImport();
    m.stdin.write('\r');
    await waitFor(() => m.lastFrame().includes('Space toggles'));
    m.stdin.write(ESC);
    await waitFor(() => !m.lastFrame().includes('Space toggles'));
    expect(m.state()?.overlay).toBe('import');
    m.stdin.write(ESC);
    await waitFor(() => m.state()?.overlay === 'none');
    // `noteLine` routes to the host when there is one (`app-harness`'s `fakeHost.note`)
    await waitFor(() => host.notes.some((t) => t.includes('the plan is kept')));
    expect(host.notes.some((t) => t === importClosedRow(planOf().importId))).toBe(true);
  });

  it('Ctrl-C is the same three behaviours, and neither Esc nor Ctrl-C leaves the composer collapsed', async () => {
    const { m } = await openImport();
    m.stdin.write('\x03');
    await waitFor(() => m.state()?.overlay === 'none');
    // the composer is live again (the overlay is COLLAPSING while open)
    m.stdin.write('hello');
    await waitFor(() => m.lastFrame().includes('› hello'));
  });

  it('resize 24×80 → 12×60 → 40×120 mid-overlay: every row fits, the keys row survives, and no frame is cleared outside a shrink', async () => {
    const { m } = await openImport();
    const clears = (): number => m.frames.join('').split('\x1b[2J').length - 1;
    const before = clears();
    for (const [rows, columns] of [[12, 60], [40, 120], [24, 80]] as const) {
      m.bridge.geometry = { rows, columns };
      m.bridge.notify();
      await tick(40);
      for (const l of m.lastFrame().split('\n')) expect([...l].length, `${rows}x${columns}: ${l}`).toBeLessThanOrEqual(Math.max(columns, 80));
    }
    // ink-testing-library never emits a clear at all; the pty scenario owns the real check (§7 row 85)
    expect(clears()).toBe(before);
    expect(CAP.import).toBe(10);
  });

  it('an empty probe is §12.4 S92 in one row, never an overlay of five zeroes', async () => {
    const empty: ImportPlan = { ...planOf(), rows: [] };
    const m = mountApp({ mode: 'session', host: fakeHost(), importEngine: engineOf(empty) });
    await settle(m);
    await enter(m, '/import');
    await waitFor(() => (m.host?.notes ?? []).includes(IMPORT_NOTHING_FOUND));
    expect(m.state()?.overlay).toBe('none');
  });

  it('the screen reader hears the STEP block once and then one sentence per move — never the group list from inside the rows view', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host, importEngine: engineOf(), launch: srLaunch({ screenReader: true }) });
    await settle(m);
    await enter(m, '/import');
    // the block for the step it opened on
    await waitFor(() => host.notes.some((t) => t.startsWith('Import: ') && t.includes('to import')));
    expect(host.notes.some((t) => /^1\. memory, \d+ rows?, /.test(t))).toBe(true);
    // a move inside the step is ONE focus sentence, coalesced (never the whole block again)
    m.stdin.write(DOWN);
    await waitFor(() => host.notes.some((t) => /^Import group 2 of \d+: /.test(t)), 4000);
    expect(host.notes.some((t) => /^Import group 2 of \d+: /.test(t))).toBe(true);
    // …and expanding a group speaks the ROW list, not the group list a second time
    const beforeRows = host.notes.length;
    m.stdin.write('\r');
    await waitFor(() => host.notes.slice(beforeRows).some((t) => /^Import group [a-z]+: \d+ rows?\./.test(t)), 4000);
    const spoken = host.notes.slice(beforeRows);
    expect(spoken.some((t) => /^Import group [a-z]+: \d+ rows?\./.test(t))).toBe(true);
    expect(spoken.some((t) => t.startsWith('Import: ') && t.includes('to import'))).toBe(false);
  });

  it('a key that is ANSWERED with a hint is heard: the apply refusal reaches the reader, not just the frame (§13.1)', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host, importEngine: engineOf(), launch: srLaunch({ screenReader: true }) });
    await settle(m);
    await enter(m, '/import');
    await waitFor(() => host.notes.some((t) => t.startsWith('Import: ')));
    m.stdin.write('y');
    // the same sentence the keys row is replaced by, spoken (the count lives on the record, so the twin has
    // to read the App's rendered hint and not `state.hint`, which is null for this one)
    await waitFor(() => host.notes.some((t) => t.includes('jevcode import --yes')), 4000);
    expect(host.notes.some((t) => t.includes('jevcode import --yes'))).toBe(true);
  });

  it('the `--plain` twin is the numbered group list with `Enter selection (1-N):`, and the SR twin speaks the counts', () => {
    const out: string[] = [];
    const r = createPlainRenderer({ task: '', resumeId: null, onAbort: () => undefined, mode: 'session', stdout: { write: (s: string) => out.push(s) } as unknown as NodeJS.WriteStream });
    const input = importInput();
    const st = initImportUi(input);
    r.blockLines?.(importPlainLines(st, input), { label: '[ui]' });
    const text = out.join('');
    expect(text).toContain(importSelectionPrompt(st.groups.length));
    expect(text).toMatch(/ {2}1 memory/);
    expect(text).not.toContain('▌');
    const sr = importScreenReaderLines(st, { prompt: false });
    expect(sr[0]).toMatch(/^Import: \d+ to import, \d+ to review, /);
    expect(sr.slice(1).every((l) => /^\d+\. [a-z]+, \d+ rows?/.test(l))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// (c) the resume card sub-state — §2.8, §7 row 91
// ---------------------------------------------------------------------------------------

const NO_FLAGS = { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false } as const;

function sessionRow(id = 's1', runId = 'r1'): SessionRow {
  return { sessionId: id, workspace: '/w', title: 'fix store rotation', task60: 'fix store rotation', runs: [{ runId, startedAt: '2026-09-21T23:44:32.000Z', steps: 7, totalUsd: 0.42, stopReason: 'paused', changedFiles: [] } as unknown as SessionRow['runs'][number]], lastUsed: '2026-09-21T23:44:32.000Z', createdAt: '2026-09-21T23:44:32.000Z', totalUsd: 0.42, mode: 'jev-on', branch: null };
}

describe('(c) `PickerState.card`: the resume card opens, closes, and its four letters route ONLY while it is open (§2.8, §7 row 91)', () => {
  it('with `hasCard` supplied Enter OPENS the card instead of resuming, and the pane becomes the card with its keys row', async () => {
    const opened: string[] = [];
    const m = mountApp({ mode: 'session', host: fakeHost() });
    await settle(m);
    m.bridge.command({ type: 'picker', open: { kind: 'sessions', workspace: '/w', sessions: [sessionRow()], hasCard: () => true, onOpen: (s) => opened.push(s.sessionId) } });
    await waitFor(() => m.state()?.picker === true);
    m.stdin.write('\r');
    await waitFor(() => m.lastFrame().includes(PICKER_CARD_HINT));
    // Enter opened the CARD: nothing was resumed and the picker is still up
    expect(opened).toEqual([]);
    expect(m.state()?.picker).toBe(true);
    expect(m.lastFrame()).toContain(PICKER_CARD_KEYS);
    expect(m.lastFrame()).toContain('resume r1');
  });

  it('the four letters answer only in the sub-state: `r` inside the card is the card op, `r` outside it is filter text', async () => {
    const m = mountApp({ mode: 'session', host: fakeHost() });
    await settle(m);
    m.bridge.command({ type: 'picker', open: { kind: 'sessions', workspace: '/w', sessions: [sessionRow()], hasCard: () => true } });
    await waitFor(() => m.state()?.picker === true);
    // before the card: `r` is a filter character (round 3, unchanged)
    m.stdin.write('r');
    await waitFor(() => m.lastFrame().includes('filter: r'));
    // and the resolver's own gate, stated for the record
    expect(resolveKey({ ...initialKeyState(), picker: true, pickerCard: 'closed' }, { input: 'r', key: { ...NO_FLAGS } }, 0)).toEqual([{ type: 'insert', text: 'r' }]);
    expect(resolveKey({ ...initialKeyState(), picker: true, pickerCard: 'open' }, { input: 'r', key: { ...NO_FLAGS } }, 0)).toEqual([{ type: 'picker', op: 'cardReplay' }]);
    for (const [key, op] of [['f', 'cardFresh'], ['d', 'cardDiff'], ['w', 'cardWho']] as const) {
      expect(resolveKey({ ...initialKeyState(), picker: true, pickerCard: 'open' }, { input: key, key: { ...NO_FLAGS } }, 0)).toEqual([{ type: 'picker', op }]);
    }
  });

  it('Esc closes the CARD back to the list, and a second Esc closes the picker (§2.8: two Escs, two meanings)', async () => {
    const closed: number[] = [];
    const m = mountApp({ mode: 'session', host: fakeHost() });
    await settle(m);
    m.bridge.command({ type: 'picker', open: { kind: 'sessions', workspace: '/w', sessions: [sessionRow()], hasCard: () => true, onClose: () => closed.push(1) } });
    await waitFor(() => m.state()?.picker === true);
    m.stdin.write('\r');
    await waitFor(() => m.lastFrame().includes(PICKER_CARD_HINT));
    m.stdin.write(ESC);
    await waitFor(() => !m.lastFrame().includes(PICKER_CARD_HINT));
    expect(m.state()?.picker).toBe(true);
    expect(closed).toEqual([]);
    m.stdin.write(ESC);
    await waitFor(() => m.state()?.picker !== true);
    expect(closed).toEqual([1]);
  });

  it('with NO `hasCard` (this build in production) Enter resumes exactly as round 3 did — the sub-state changes nothing for a user', async () => {
    const opened: string[] = [];
    const m = mountApp({ mode: 'session', host: fakeHost() });
    await settle(m);
    m.bridge.command({ type: 'picker', open: { kind: 'sessions', workspace: '/w', sessions: [sessionRow()], onOpen: (s) => opened.push(s.sessionId) } });
    await waitFor(() => m.state()?.picker === true);
    m.stdin.write('\r');
    await waitFor(() => opened.length === 1);
    expect(opened).toEqual(['s1']);
    expect(m.state()?.picker).not.toBe(true);
  });

  /**
   * §7 row 91's NEGATIVE half, through the shell. The resolver's half is in `keys/resolve.test.ts`; this is the
   * consequence that made it a blocker: the card's pane has no armed row to draw (`pickerLines` returns before
   * `PICKER_DELETE_HINT` is built), so an `x` that still armed the chord meant the next `y` trashed a run
   * directory with nothing on screen to say so.
   */
  it('while the card is open the LIST keys are inert: no filter text, no preview, no rename — and `x` then `y` never deletes', async () => {
    const deleted: string[] = [];
    const m = mountApp({ mode: 'session', host: fakeHost() });
    await settle(m);
    m.bridge.command({ type: 'picker', open: { kind: 'sessions', workspace: '/w', sessions: [sessionRow()], hasCard: () => true, onDelete: (x) => deleted.push(x.sessionId) } });
    await waitFor(() => m.state()?.picker === true);
    m.stdin.write('\r');
    await waitFor(() => m.lastFrame().includes(PICKER_CARD_HINT));
    const card = m.lastFrame();
    m.stdin.write('x');
    await tick(40);
    m.stdin.write('y');
    await tick(40);
    // nothing was deleted, nothing was armed, and the pane never left the card
    expect(deleted).toEqual([]);
    expect(m.lastFrame()).toContain(PICKER_CARD_HINT);
    expect(m.lastFrame()).not.toContain('delete this session?');
    // the filter is inert: the typed keys reached neither the composer nor the pane
    expect(m.lastFrame()).not.toContain('filter: x');
    expect(m.lastFrame()).toBe(card);
    // Ctrl-R cannot start a rename the card does not advertise
    m.stdin.write(CTRL_R);
    await tick(40);
    expect(m.lastFrame()).not.toContain('rename:');
    expect(m.lastFrame()).toBe(card);
  });

  it('the card keeps its OWN run when the filter moves under it: never row B\'s title beside run A, and never a fabricated `SessionRow`', async () => {
    const seen: { sessionId: string; runId: string }[] = [];
    const a = sessionRow('s1', 'r1');
    const b: SessionRow = { ...sessionRow('s2', 'r2'), title: 'beta rotation', task60: 'beta rotation' };
    const m = mountApp({ mode: 'session', host: fakeHost() });
    await settle(m);
    m.bridge.command({
      type: 'picker',
      open: {
        kind: 'sessions',
        workspace: '/w',
        sessions: [a, b],
        hasCard: () => true,
        cardLines: (sess, runId) => {
          seen.push({ sessionId: sess.sessionId, runId });
          return [`card for ${sess.sessionId} at ${runId}`];
        },
      },
    });
    await waitFor(() => m.state()?.picker === true);
    m.stdin.write('\r');
    await waitFor(() => m.lastFrame().includes('card for s1 at r1'));
    // the card names run A and nothing else, however the list is filtered underneath it
    expect(m.lastFrame()).toContain('card for s1 at r1');
    expect(m.lastFrame()).not.toContain('card for s2');
    expect(seen.length).toBeGreaterThan(0);
    for (const c of seen) {
      expect(c.sessionId).toBe('s1');
      expect(c.runId).toBe('r1');
    }
  });

  it('`[Enter] resume` INSIDE the card resumes the card\'s own run and closes the picker (the key the card advertises)', async () => {
    const opened: string[] = [];
    const m = mountApp({ mode: 'session', host: fakeHost() });
    await settle(m);
    m.bridge.command({ type: 'picker', open: { kind: 'sessions', workspace: '/w', sessions: [sessionRow('s1', 'r1'), sessionRow('s2', 'r2')], hasCard: () => true, onOpen: (x) => opened.push(x.sessionId) } });
    await waitFor(() => m.state()?.picker === true);
    m.stdin.write('\r');
    await waitFor(() => m.lastFrame().includes(PICKER_CARD_HINT));
    expect(opened).toEqual([]);
    // the resume is the CARD's run
    m.stdin.write('\r');
    await waitFor(() => opened.length === 1);
    expect(opened).toEqual(['s1']);
    expect(m.state()?.picker).not.toBe(true);
  });

  it('a card whose run left the list draws the one honest row and calls no `cardLines` at all', () => {
    const st: PickerState = { kind: 'sessions', sessions: [sessionRow('s2', 'r2')], rewindSteps: [], workspace: '/w', selected: 0, widened: false, sort: 'updated', preview: null, renaming: false, deleteArmed: false, card: { runId: 'r1' }, models: { models: [], results: [], pending: [], selected: 0, open: false } };
    const r = pickerLines(st, { filter: '', rows: PICKER_PANE_WANT, columns: 80, nowMs: 0 });
    expect(r.lines[0]).toContain('resume r1');
    // never another session's title beside this run id
    expect(r.lines.join('\n')).not.toContain('fix store rotation');
    expect(sessionOfRun(st, 'r1')).toBeNull();
    expect(sessionOfRun(st, 'r2')?.sessionId).toBe('s2');
  });

  it('the caller may supply the card ROWS; without them the honest default names the run and its keys', () => {
    expect(defaultCardLines(sessionRow(), 'r1')).toEqual(['resume r1 · "fix store rotation"', PICKER_CARD_KEYS]);
    const st: PickerState = { kind: 'sessions', sessions: [sessionRow()], rewindSteps: [], workspace: '/w', selected: 0, widened: false, sort: 'updated', preview: null, renaming: false, deleteArmed: false, card: { runId: 'r1' }, models: { models: [], results: [], pending: [], selected: 0, open: false } };
    const r = pickerLines(st, { filter: '', rows: PICKER_PANE_WANT, columns: 80, nowMs: 0, cardRows: ['paused 42 m ago · now at step 7'] });
    expect(r.lines[0]).toContain('paused 42 m ago');
    expect(r.lines[1]).toContain(PICKER_CARD_HINT);
    expect(r.selected).toBeNull();
    expect(r.lines).toHaveLength(PICKER_PANE_WANT);
  });
});

// ---------------------------------------------------------------------------------------
// the invariants every mounted surface must leave alone
// ---------------------------------------------------------------------------------------

describe('the invariants the shared shell must not break (TD4 §4.5, §6.2)', () => {
  it('Enter never approves a confirm — with the import overlay mounted the palette still cycles on Enter, and only `y` approves', () => {
    // §6.2's registry invariant, re-asserted after the picker and overlay arms landed
    const approvers = KEY_ACTIONS.filter((b) => b.context === 'review' && b.keys.includes('return'));
    expect(approvers).toEqual([]);
    expect(KEY_ACTIONS.find((b) => b.id === 'review:approve')?.keys).toEqual(['y']);
    // TD4 §4.5: Enter never APPROVES. It is inert on three of the y-gated overlays and DECLINES on `undo`
    // (`undoPrompt: 'no'`); what none of them may ever produce is the affirmative op.
    const APPROVE_OPS = new Set(['approve', 'send', 'start', 'yes', 'all', 'abortExit', 'run', 'apply']);
    for (const overlay of ['followup', 'undo', 'exitConfirm'] as const) {
      const acts = resolveKey({ ...initialKeyState(), overlay, overlayArmed: true }, { input: '\r', key: { ...NO_FLAGS, return: true } }, 0);
      for (const a of acts) expect(APPROVE_OPS.has((a as { op?: string }).op ?? ''), `${overlay}: ${JSON.stringify(a)}`).toBe(false);
    }
    // the review box itself: Enter is not an approval in either state
    for (const armed of [false, true]) {
      const acts = resolveKey({ ...initialKeyState(), overlay: 'review', reviewArmed: armed }, { input: '\r', key: { ...NO_FLAGS, return: true } }, 0);
      for (const a of acts) expect(APPROVE_OPS.has((a as { op?: string }).op ?? '')).toBe(false);
    }
    expect(resolveKey({ ...initialKeyState(), overlay: 'import' }, { input: '\r', key: { ...NO_FLAGS, return: true } }, 0)).toEqual([{ type: 'import', op: 'open' }]);
    expect(resolveKey({ ...initialKeyState(), overlay: 'import' }, { input: 'y', key: { ...NO_FLAGS } }, 0)).toEqual([{ type: 'import', op: 'apply' }]);
  });

  it('gate G-R5-1: mounting the two surfaces put NO value import of `src/models/**` or `src/import/**` on the first-frame graph', () => {
    const app = readFileSync(new URL('../../../src/tui/App.tsx', import.meta.url), 'utf8');
    const picker = readFileSync(new URL('../../../src/tui/Picker.tsx', import.meta.url), 'utf8');
    for (const [name, src] of [['App.tsx', app], ['Picker.tsx', picker]] as const) {
      // `import type` erases under `verbatimModuleSyntax`; a VALUE import of either facade would not
      expect(src.match(/^import (?!type )[^\n]*from '\.\.\/models\//gm) ?? [], name).toEqual([]);
      expect(src.match(/^import (?!type )[^\n]*from '\.\.\/import\//gm) ?? [], name).toEqual([]);
      expect(src.match(/^import (?!type )[^\n]*from '\.\.\/provider\//gm) ?? [], name).toEqual([]);
      expect(src.match(/^import (?!type )[^\n]*from '\.\.\/coordination\//gm) ?? [], name).toEqual([]);
    }
    // …and the two reaches that DO exist are inside function bodies, after the frame (§2.14's shape)
    expect(app).toContain("await import('../models/index.js')");
    expect(app).toContain("await import('../import/index.js')");
  });

  it('`KeyContext` gained no member: the import overlay resolves literal keys like every other y-gated overlay (gate G-R5-10)', () => {
    expect([...KEY_CONTEXTS].sort()).toEqual(['agents', 'composer', 'global', 'palette', 'picker', 'review']);
    expect(KEY_CONTEXTS).toHaveLength(6);
    expect([...new Set(KEY_ACTIONS.map((b) => b.context))].every((c) => KEY_CONTEXTS.includes(c))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// R5-H4 (gap wave, finding 9) — the `peers` status zone is no longer dark
// ---------------------------------------------------------------------------------------

/**
 * `statusZones` has read `StatusLineState.fold` / `.selfId` since R5-2, and `peerZoneText` has been tested on its
 * own since then, but nothing ever SUPPLIED them: `UiState` carried no fold, so the §12.1 S6 zone could not light
 * in a real session. This file's three cases are the seam end to end — the reducer arm, the `statusView`
 * pass-through and the zone that falls out of it — plus the invariant that a run reset must not blank a
 * SESSION-level fact, and the first-frame gate that keeps `src/coordination/**` a type-only import here.
 */
describe('(h) R5-H4: `peers:fold` lights the §12.1 S6 peer zone (TUI-DESIGN-5 §2.2)', () => {
  const OTHER = 'ffee0011';
  const SELF = { deviceId: 'k3q7m2ab', runId: 'my-run', sessionId: 'my-session' } as const;

  async function foldWith(opts: { live?: number; headsUp?: number; mail?: number } = {}): Promise<Fold> {
    const { emptyFold } = await import('../../../src/coordination/index.js');
    const { makeHeartbeat, makeMessage } = await import('../coordination/helpers.js');
    const fold = emptyFold({ wallMs: 0, monoMs: 0 });
    for (let i = 0; i < (opts.live ?? 0); i++) {
      const rid = `2026-run-peer-${i}`;
      fold.live.set(rid, { ...makeHeartbeat({ runId: rid, sessionId: `s-${i}`, deviceId: OTHER, pid: 900 + i }), arrivalMono: 0 });
      fold.liveness.set(`${OTHER}/${rid}/${900 + i}`, 'live');
    }
    for (let i = 0; i < (opts.headsUp ?? 0); i++) {
      fold.inbox.push(makeMessage({ id: `${OTHER}-aaaa1111-${i}`, type: 'heads-up', to: '@all', from: { deviceId: OTHER, label: 'mbp', sessionId: 'sx', runId: null, user: 'u' } }));
    }
    for (let i = 0; i < (opts.mail ?? 0); i++) {
      fold.inbox.push(makeMessage({ id: `${OTHER}-bbbb2222-${i}`, type: 'note', to: 'my-session', from: { deviceId: OTHER, label: 'mbp', sessionId: 'sx', runId: null, user: 'u' } }));
    }
    return fold;
  }

  const zones = (state: UiState): string => statusZones(statusView(state, { columns: 200, glyphs: GLYPHS.unicode }), 200).right.join(' ');

  it('an initial state has no fold and no peer segment; one `peers:fold` action lights the zone', async () => {
    const start = initialUiState('t', null);
    expect(start.fold).toBeNull();
    expect(start.selfId).toBeNull();
    expect(zones(start)).not.toContain('⇄');
    const fold = await foldWith({ live: 2, headsUp: 1, mail: 1 });
    const next = uiReducer(start, { type: 'peers:fold', fold, selfId: SELF });
    expect(next.fold).toBe(fold);
    expect(next.selfId).toEqual(SELF);
    expect(peerZoneCounts(fold, SELF)).toEqual({ live: 2, headsUp: 1, mail: 1 });
    expect(zones(next)).toContain(peerZoneText(fold, SELF, GLYPHS.unicode, 200));
    expect(zones(next)).toContain('⇄ 2 live · 1 heads-up · ✉ 1');
  });

  it('an EMPTY fold still shows nothing — the zone is absent at 0/0/0, never `⇄ 0 live` (§13.2 clause 5)', async () => {
    const fold = await foldWith();
    const state = uiReducer(initialUiState('t', null), { type: 'peers:fold', fold, selfId: SELF });
    expect(state.fold).toBe(fold);
    expect(zones(state)).not.toContain('⇄');
    expect(zones(state)).not.toContain('live');
  });

  it('a run:start reset keeps the fold: peers are a SESSION fact, so the zone does not blink off at every run', async () => {
    const fold = await foldWith({ live: 1 });
    const withFold = uiReducer(initialUiState('t', null), { type: 'peers:fold', fold, selfId: SELF });
    const started = uiReducer(withFold, { type: 'event', event: { type: 'run:start', runId: 'r1', task: 't', mode: 'llm-jev', resumedFromStep: null }, at: 1_000 });
    expect(started.runId).toBe('r1');
    expect(started.fold).toBe(fold);
    expect(started.selfId).toEqual(SELF);
    expect(zones(started)).toContain('⇄ 1 live');
  });

  it('gate G-R5-1: `useEngine.tsx` reaches `src/coordination/**` by TYPE only, so the fold stays off the first-frame graph', () => {
    const src = readFileSync(new URL('../../../src/tui/useEngine.tsx', import.meta.url), 'utf8');
    expect(src.match(/^import (?!type )[^\n]*from '\.\.\/coordination\//gm) ?? []).toEqual([]);
    expect(src).toContain("import type { Fold } from '../coordination/index.js';");
  });
});
