/**
 * TUI-DESIGN-5 §10 (R5-5 `import/reducer.test.ts`): the five-group default view from a `summarisePlan` fixture;
 * `y` applies exactly `applicableRows`' output and **never** a `class === 'secret'` row even when one is planted
 * in an applicable group (§7 row 58); expand/collapse; the review sub-view.
 *
 * The plan is the repo's own `test/fixtures/import/plan.json`, and the two engine functions are the REAL ones
 * (`src/import/index.ts`) — the point of §7 row 58 is that the TUI agrees with the engine, which a hand-written
 * `applicable` array would assume rather than prove.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applicableRows, summarisePlan } from '../../../../src/import/index.js';
import type { ImportPlan, PlanRow } from '../../../../src/core/types.js';
import {
  GROUP_VIEW_ORDER,
  groupKeyOf,
  importReducer,
  initImportUi,
  isWritableRow,
  reviewRowsOf,
  rowsOfGroup,
  selectedRowIds,
  scanningImportUi,
  IMPORT_HINT_NOTHING,
  IMPORT_HINT_NOT_APPLICABLE,
  type ImportUiInput,
  type ImportUiState,
} from '../../../../src/tui/import/reducer.js';

const RAW = readFileSync(new URL('../../../fixtures/import/plan.json', import.meta.url), 'utf8');
const plan = (): ImportPlan => JSON.parse(RAW) as ImportPlan;

function inputOf(p: ImportPlan = plan()): ImportUiInput {
  return { plan: p, summary: summarisePlan(p), applicable: applicableRows(p, { scope: 'both' }) };
}

describe('the default view (§5.2 [G2.5])', () => {
  it('is the named groups in GROUP_VIEW_ORDER, with the engine’s own counts', () => {
    const input = inputOf();
    const s = initImportUi(input);
    expect(s.step).toBe('groups');
    expect(s.groups.map((g) => g.key)).toEqual(['memory', 'rules', 'commands', 'mcp', 'config', 'review']);
    // every rendered key is in the declared order, and `skipped` is NEVER a row (its count is in the head)
    for (const g of s.groups) expect(GROUP_VIEW_ORDER).toContain(g.key);
    expect(s.groups.map((g) => g.key)).not.toContain('skipped');
    const byKey = Object.fromEntries(input.summary.groups.map((g) => [g.key, g.rows]));
    for (const g of s.groups) expect(g.rows, g.key).toBe(byKey[g.key]);
  });

  it('hides the `config` row when the group is empty — five rows, exactly §5.2’s frame', () => {
    const p = plan();
    const trimmed: ImportPlan = { ...p, rows: p.rows.filter((r) => groupKeyOf(r) !== 'config') };
    const s = initImportUi(inputOf(trimmed));
    expect(s.groups.map((g) => g.key)).toEqual(['memory', 'rules', 'commands', 'mcp', 'review']);
  });

  it('`groupKeyOf` agrees row-for-row with `summarisePlan`’s own grouping', () => {
    const input = inputOf();
    for (const g of input.summary.groups) {
      expect(input.plan.rows.filter((r) => groupKeyOf(r) === g.key).length, g.key).toBe(g.rows);
    }
  });

  it('`selectable` is the per-row intersection, not the group flag — the `config`/`suggest` row proves they differ', () => {
    const input = inputOf();
    const config = input.summary.groups.find((g) => g.key === 'config');
    expect(config?.applicable).toBe(true); // the ENGINE's group flag says yes …
    const row = input.plan.rows.find((r) => r.action === 'suggest');
    expect(row).toBeDefined();
    expect(input.applicable).not.toContain(row?.id); // … and `applicableRows` refuses the row
    const s = initImportUi(input);
    expect(s.groups.find((g) => g.key === 'config')?.selectable).toBe(0);
  });
});

describe('`y` — §7 row 58', () => {
  it('applies exactly `applicableRows`’ output when nothing is toggled off', () => {
    const input = inputOf();
    const s = initImportUi(input);
    expect([...selectedRowIds(s, input)].sort()).toEqual([...input.applicable].sort());
  });

  it('never a `class === "secret"` row, even when one is planted in an applicable group AND in `applicable`', () => {
    const p = plan();
    const donor = p.rows.find((r) => r.class === 'memory' && r.action === 'create');
    expect(donor).toBeDefined();
    // The planted row: a CREDENTIAL with a plain `create` action. `groupOf` switches on `row.class` and has no
    // `secret` arm, so it lands in `config` — an APPLICABLE group (`key !== 'review' && key !== 'skipped'`).
    // That is §7 row 58's fault exactly: a UI trusting `PlanGroup.applicable` would write this row.
    const planted: PlanRow = { ...(donor as PlanRow), id: 'planted00000', class: 'secret', dest: '.jevcode/memory/leaked.md' };
    const p2: ImportPlan = { ...p, rows: [...p.rows, planted] };
    expect(groupKeyOf(planted)).toBe('config');
    expect(summarisePlan(p2).groups.find((x) => x.key === 'config')?.applicable).toBe(true);
    // the engine itself already refuses it — that is the invariant the TUI must not re-derive around
    expect(applicableRows(p2, { scope: 'both' })).not.toContain('planted00000');
    // …and the TUI refuses it a second time, even when the caller hands it an `applicable` list that says yes
    const rigged: ImportUiInput = { plan: p2, summary: summarisePlan(p2), applicable: [...applicableRows(p2, { scope: 'both' }), 'planted00000'] };
    const s = initImportUi(rigged);
    expect(selectedRowIds(s, rigged)).not.toContain('planted00000');
    expect(isWritableRow(planted, new Set(['planted00000']))).toBe(false);
    // and the applicable group's `selectable` count does not include it either
    const config = s.groups.find((g) => g.key === 'config');
    expect(config?.applicable).toBe(true);
    expect(config?.rows).toBe(2);
    expect(config?.selectable).toBe(0);
  });

  it('honours the scope the caller asked the engine for', () => {
    const p = plan();
    const userOnly: ImportUiInput = { plan: p, summary: summarisePlan(p), applicable: applicableRows(p, { scope: 'user' }) };
    const s = initImportUi(userOnly);
    const ids = selectedRowIds(s, userOnly);
    for (const id of ids) expect(p.rows.find((r) => r.id === id)?.scope).toBe('user');
  });

  it('a group toggled off drops exactly its writable rows; toggling again restores them', () => {
    const input = inputOf();
    let s = initImportUi(input);
    const memoryIds = rowsOfGroup(input.plan, 'memory')
      .filter((r) => input.applicable.includes(r.id))
      .map((r) => r.id);
    s = importReducer(s, { type: 'toggle' }, input); // cursor is on `memory`
    const after = selectedRowIds(s, input);
    for (const id of memoryIds) expect(after).not.toContain(id);
    expect(after.length).toBe(input.applicable.length - memoryIds.length);
    s = importReducer(s, { type: 'toggle' }, input);
    expect([...selectedRowIds(s, input)].sort()).toEqual([...input.applicable].sort());
  });

  it('`y` with nothing selected answers, rather than applying nothing silently', () => {
    const input = inputOf();
    let s = initImportUi(input);
    for (let i = 0; i < input.summary.groups.length + 2; i++) {
      s = importReducer(s, { type: 'toggle' }, input);
      s = importReducer(s, { type: 'move', by: 1 }, input);
    }
    expect(selectedRowIds(s, input)).toEqual([]);
    s = importReducer(s, { type: 'apply' }, input);
    expect(s.step).toBe('groups');
    expect(s.hint).toBe(IMPORT_HINT_NOTHING);
  });

  it('`y` with a selection moves to `applying`, and `applied` records the counts', () => {
    const input = inputOf();
    let s = importReducer(initImportUi(input), { type: 'apply' }, input);
    expect(s.step).toBe('applying');
    s = importReducer(s, { type: 'applied', ok: 9, failed: 0, total: 9 }, input);
    expect(s.step).toBe('done');
    expect(s.applied).toEqual({ ok: 9, failed: 0, total: 9 });
  });
});

describe('expand / collapse', () => {
  it('Enter opens the group under the cursor and Enter (or Esc) collapses it', () => {
    const input = inputOf();
    let s = initImportUi(input);
    s = importReducer(s, { type: 'open' }, input);
    expect(s.step).toBe('rows');
    expect(s.expanded).toBe('memory');
    s = importReducer(s, { type: 'open' }, input);
    expect(s.step).toBe('groups');
    expect(s.expanded).toBeNull();
    s = importReducer(importReducer(s, { type: 'open' }, input), { type: 'escape' }, input);
    expect(s.step).toBe('groups');
    expect(s.closed).toBe(false); // Esc inside a group goes BACK, it does not close the overlay
  });

  it('the cursor is clamped at both ends and `move` walks rows inside an expanded group', () => {
    const input = inputOf();
    let s = initImportUi(input);
    s = importReducer(s, { type: 'move', by: -1 }, input);
    expect(s.cursor).toBe(0);
    for (let i = 0; i < 20; i++) s = importReducer(s, { type: 'move', by: 1 }, input);
    expect(s.cursor).toBe(s.groups.length - 1);
    s = importReducer({ ...s, cursor: 0 }, { type: 'open' }, input);
    s = importReducer(s, { type: 'move', by: 1 }, input);
    expect(s.rowCursor).toBe(1);
    for (let i = 0; i < 50; i++) s = importReducer(s, { type: 'move', by: 1 }, input);
    expect(s.rowCursor).toBe(rowsOfGroup(input.plan, 'memory').length - 1);
  });

  it('Space toggles one row; `a` / `n` are all-on / all-off inside the group only', () => {
    const input = inputOf();
    let s = importReducer(initImportUi(input), { type: 'open' }, input);
    const first = rowsOfGroup(input.plan, 'memory')[0];
    expect(first).toBeDefined();
    s = importReducer(s, { type: 'toggle' }, input);
    expect(selectedRowIds(s, input)).not.toContain(first?.id);
    s = importReducer(s, { type: 'all' }, input);
    expect([...selectedRowIds(s, input)].sort()).toEqual([...input.applicable].sort());
    s = importReducer(s, { type: 'none' }, input);
    for (const r of rowsOfGroup(input.plan, 'memory')) expect(selectedRowIds(s, input)).not.toContain(r.id);
  });

  it('Space on a row `y` can never write answers instead of pretending', () => {
    const input = inputOf();
    let s = initImportUi(input);
    // walk to the `review` group and open it through `move` + `open` — Enter on `review` is the review queue,
    // so reach the non-writable rows through the `config` group instead (its one row is `suggest`)
    const at = s.groups.findIndex((g) => g.key === 'config');
    s = importReducer({ ...s, cursor: at }, { type: 'open' }, input);
    expect(s.expanded).toBe('config');
    s = importReducer(s, { type: 'toggle' }, input);
    expect(s.hint).toBe(IMPORT_HINT_NOT_APPLICABLE);
    expect(s.off.size).toBe(0);
  });
});

describe('the review sub-view', () => {
  it('`r` opens it, `move` walks the queue, `Esc` returns to the groups', () => {
    const input = inputOf();
    const queue = reviewRowsOf(input.plan);
    expect(queue.length).toBe(2);
    let s = importReducer(initImportUi(input), { type: 'review' }, input);
    expect(s.step).toBe('review');
    expect(s.reviewAt).toBe(0);
    s = importReducer(s, { type: 'move', by: 1 }, input);
    expect(s.reviewAt).toBe(1);
    s = importReducer(s, { type: 'move', by: 1 }, input);
    expect(s.reviewAt).toBe(1); // clamped at the end of the queue
    s = importReducer(s, { type: 'escape' }, input);
    expect(s.step).toBe('groups');
  });

  it('Enter on the `review` group row goes to the queue, never into a dead list', () => {
    const input = inputOf();
    const s0 = initImportUi(input);
    const at = s0.groups.findIndex((g) => g.key === 'review');
    const s = importReducer({ ...s0, cursor: at }, { type: 'open' }, input);
    expect(s.step).toBe('review');
  });

  it('a review row is never writable, whatever the human does in the queue', () => {
    const input = inputOf();
    const applicable = new Set(input.applicable);
    for (const r of reviewRowsOf(input.plan)) expect(isWritableRow(r, applicable)).toBe(false);
  });
});

describe('Esc and the scanning frame (§7 row 59, behaviour 3)', () => {
  it('Esc on the default view closes the overlay and keeps the plan', () => {
    const input = inputOf();
    const s = importReducer(initImportUi(input), { type: 'escape' }, input);
    expect(s.closed).toBe(true);
    expect(s.step).toBe('groups'); // the plan is untouched; nothing was written and nothing was discarded
  });

  it('`scanningImportUi` is a legal, empty state — no group rows, nothing selectable', () => {
    const s: ImportUiState = scanningImportUi('imp_20260921T120000Z_a1b2c3');
    expect(s.step).toBe('scanning');
    expect(s.groups).toEqual([]);
    const input = inputOf();
    expect(importReducer(s, { type: 'apply' }, input).step).toBe('scanning');
  });
});

describe('§7 row 59 — the THREE Ctrl-C behaviours, as far as the overlay carries them', () => {
  it('behaviour 2: Esc / Ctrl-C while APPLYING stops at the row boundary and keeps the resume hint', () => {
    const input = inputOf();
    const applying = importReducer(initImportUi(input), { type: 'apply' }, input);
    expect(applying.step).toBe('applying');
    const stopped = importReducer(applying, { type: 'escape' }, input);
    // it does NOT close (that is behaviour 3's answer, and the rows already written are the human's business)
    expect(stopped.closed).toBe(false);
    expect(stopped.step).toBe('done');
    expect(stopped.interrupted).toBe(true);
    expect(stopped.applied).toEqual({ ok: 0, failed: 0, total: selectedRowIds(applying, input).length });
  });

  it('the interrupt carries the counts the host knows, and `applied` clears the flag again', () => {
    const input = inputOf();
    const applying = importReducer(initImportUi(input), { type: 'apply' }, input);
    const stopped = importReducer(applying, { type: 'interrupt', ok: 4, total: 9 }, input);
    expect(stopped.applied).toEqual({ ok: 4, failed: 0, total: 9 });
    const done = importReducer(applying, { type: 'applied', ok: 9, failed: 0, total: 9 }, input);
    expect(done.interrupted).toBe(false);
  });

  it('`interrupt` is ignored anywhere but `applying` — no other step can pretend an apply was stopped', () => {
    const input = inputOf();
    const s = initImportUi(input);
    expect(importReducer(s, { type: 'interrupt' }, input)).toBe(s);
    expect(importReducer(scanningImportUi(), { type: 'interrupt' }, input).step).toBe('scanning');
  });

  it('behaviour 3 is unchanged: Esc from the default view closes and keeps the plan', () => {
    const input = inputOf();
    const s = importReducer(initImportUi(input), { type: 'escape' }, input);
    expect(s.closed).toBe(true);
    expect(s.interrupted).toBe(false);
  });
});

describe('a group `y` can never write answers the key, it never swallows it', () => {
  it('Space on the `review` group says so, exactly as the row view does', () => {
    const input = inputOf();
    const s0 = initImportUi(input);
    const at = s0.groups.findIndex((g) => g.key === 'review');
    const s = importReducer({ ...s0, cursor: at }, { type: 'toggle' }, input);
    expect(s.hint).toBe(IMPORT_HINT_NOT_APPLICABLE);
    expect(s.off.size).toBe(0);
  });

  it('Space on a group with writable rows still toggles the whole group', () => {
    const input = inputOf();
    const s0 = initImportUi(input);
    const at = s0.groups.findIndex((g) => g.key === 'memory');
    const s = importReducer({ ...s0, cursor: at }, { type: 'toggle' }, input);
    expect(s.hint).toBeNull();
    expect(s.off.size).toBeGreaterThan(0);
    expect(selectedRowIds(s, input).some((id) => groupKeyOf(input.plan.rows.find((r) => r.id === id)!) === 'memory')).toBe(false);
  });
});
