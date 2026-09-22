/**
 * TUI-DESIGN-5 §10 (R5-5 `import/lines.test.ts`): every `[import]` string at two glyph sets, imported from
 * `config/imports.ts` and **never re-declared** (§13, §13.1, §13.4), plus §12.4's overlay strings (S89–S92) and
 * §5.8's 40 / 80 / 120 behaviour.
 *
 * "Never re-declared" is asserted structurally AND textually: every name in `IMPORT_ITEM_BUILDERS` is the same
 * function object in both modules, and `src/tui/import/lines.ts`'s own source contains no second `[import]`
 * literal. A zero-match grep is a hard failure, not a skip (§13.4).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as cfg from '../../../../src/config/imports.js';
import * as lines from '../../../../src/tui/import/lines.js';
import { applicableRows, summarisePlan } from '../../../../src/import/index.js';
import type { ImportPlan } from '../../../../src/core/types.js';
import { GLYPHS, cellWidth, glyphTwin } from '../../../../src/tui/glyphs.js';
import { blockWidth } from '../../../../src/tui/block/lines.js';
import { IMPORT_HINT_NOTHING, IMPORT_HINT_NOT_APPLICABLE, importReducer, initImportUi, scanningImportUi as scanning, type ImportUiInput } from '../../../../src/tui/import/reducer.js';

const RAW = readFileSync(new URL('../../../fixtures/import/plan.json', import.meta.url), 'utf8');
const plan = (): ImportPlan => JSON.parse(RAW) as ImportPlan;
const LINES_SRC = readFileSync(new URL('../../../../src/tui/import/lines.ts', import.meta.url), 'utf8');
const U = GLYPHS.unicode;
const A = GLYPHS.ascii;

function inputOf(): ImportUiInput {
  const p = plan();
  return { plan: p, summary: summarisePlan(p), applicable: applicableRows(p, { scope: 'both' }) };
}

/** one call of every builder, in `IMPORT_ITEM_BUILDERS` order, against the given glyph set */
function allItems(g: cfg.ImportGlyphs): Record<string, string> {
  return {
    importPlanItem: cfg.importPlanItem('imp_20260921T120000Z_a1b2c3', 41, 9, 137, g),
    importReportItem: cfg.importReportItem('~/.jevcode/imports/imp_20260921T120000Z_a1b2c3/report.md'),
    importJevItem: cfg.importJevItem(1, 70, 0.0003, 6, g),
    importAppliedItem: cfg.importAppliedItem(41, 41, { memory: 29, commands: 6, rules: 0, mcp: 3 }, 38 * 1024, g),
    importCredentialItem: cfg.importCredentialItem('generator', '~/.claude/settings.json', 'env.ANTHROPIC_API_KEY', '3f2a9c11', g),
    importTrustRepinnedItem: cfg.importTrustRepinnedItem('1a2b3c4d00', '9f8e7d6c00', 'AGENTS.md', g),
    importTrustChangedItem: cfg.importTrustChangedItem('AGENTS.md', g),
    importActiveItem: cfg.importActiveItem(g),
    importCredentialsFoundItem: cfg.importCredentialsFoundItem(4, g),
    importSkippedSourceItem: cfg.importSkippedSourceItem(3371, 'transcripts', 2.7 * 1024 * 1024 * 1024, 'claude-transcripts', g),
    importNothingFoundItem: cfg.importNothingFoundItem(3, g),
    importUndoItem: cfg.importUndoItem('imp_20260921T120000Z_a1b2c3', 41, 0, g),
    importSourceChangedItem: cfg.importSourceChangedItem('~/.claude/CLAUDE.md', '9f8e7d6c00', '1a2b3c4d00', g),
    importWriteErrorItem: cfg.importWriteErrorItem('.jevcode/memory/MEMORY.md', 'EACCES', 40, 41, 'imp_20260921T120000Z_a1b2c3', g),
    importCancelledItem: cfg.importCancelledItem(g),
    importInterruptedItem: cfg.importInterruptedItem(9, 41, 'imp_20260921T120000Z_a1b2c3', g),
    importRetentionItem: cfg.importRetentionItem(3, 10),
    importSkippedRowItem: cfg.importSkippedRowItem('~/.codex/config.toml', 'unsupported format', g),
  };
}

describe('§13.1 — every `[import]` item lives in config/imports.ts and is only re-exported', () => {
  it('names eighteen builders, and the list COVERS every `*Item` export (a new builder cannot escape the pin)', () => {
    expect(cfg.IMPORT_ITEM_BUILDERS).toHaveLength(18);
    expect(new Set(cfg.IMPORT_ITEM_BUILDERS).size).toBe(18);
    // §13.4: derived from the module's own exports, so `importSkippedRowItem` (§12.4 S96) — which used to sit
    // outside the list and therefore outside both sweeps — cannot be omitted again
    const exported = Object.keys(cfg as unknown as Record<string, unknown>)
      .filter((k) => /Item$/.test(k) && typeof (cfg as unknown as Record<string, unknown>)[k] === 'function')
      .sort();
    expect(exported).toEqual([...cfg.IMPORT_ITEM_BUILDERS].sort());
    expect(cfg.IMPORT_ITEM_BUILDERS).toContain('importSkippedRowItem');
  });

  it('every builder is the SAME function object in both modules (a re-export, never a copy)', () => {
    const l = lines as unknown as Record<string, unknown>;
    const c = cfg as unknown as Record<string, unknown>;
    for (const name of cfg.IMPORT_ITEM_BUILDERS) {
      expect(typeof c[name], name).toBe('function');
      expect(l[name], name).toBe(c[name]);
    }
  });

  it('no producer outside `config/imports.ts` declares an `[import]` literal (§13.4; the grep covers three files)', () => {
    for (const rel of ['../../../../src/tui/import/lines.ts', '../../../../src/tui/import/reducer.ts', '../../../../src/cli/import.ts']) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code.match(/\[import\]/g) ?? [], rel).toEqual([]);
      // the grep must be able to match something in at least the file that names the label in prose
      expect(src.length, rel).toBeGreaterThan(0);
    }
  });

  it('`src/tui/import/lines.ts` declares no `[import]` literal of its own (§13.4: zero matches is a hard failure)', () => {
    // strip every comment first: the only `[import]` occurrences left must be zero — no STRING literal in this
    // file carries the label, so `config/imports.ts` is its one home
    const code = LINES_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code.match(/\[import\]/g) ?? []).toEqual([]);
    // the grep itself must be able to match something, or it is a vacuous pin (§13.4)
    expect(LINES_SRC.match(/\[import\]/g)?.length ?? 0).toBeGreaterThan(0);
    // and the label itself is re-exported, so the one home is `config/imports.ts`
    expect(lines.IMPORT_LABEL).toBe('[import]');
    expect(lines.IMPORT_LABEL).toBe(cfg.IMPORT_LABEL);
  });

  it('renders every item at both glyph sets, and the ascii twin carries no unicode glyph', () => {
    const uni = allItems(cfg.IMPORT_GLYPHS);
    const ascii = allItems(cfg.IMPORT_GLYPHS_ASCII);
    expect(Object.keys(uni)).toEqual([...cfg.IMPORT_ITEM_BUILDERS]);
    for (const name of cfg.IMPORT_ITEM_BUILDERS) {
      const u = uni[name] ?? '';
      const a = ascii[name] ?? '';
      expect(u.length, name).toBeGreaterThan(0);
      // no item ever repeats its own label — the label is `TranscriptItem.label`
      expect(u, name).not.toContain('[import]');
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7f]*$/.test(a), `${name}: ${a}`).toBe(true);
    }
    // the two sets differ exactly where a glyph was substituted
    expect(uni['importActiveItem']).toContain('·');
    expect(ascii['importActiveItem']).toContain(' - ');
    expect(uni['importTrustRepinnedItem']).toContain('→');
    expect(ascii['importTrustRepinnedItem']).toContain('->');
  });

  it('pins §12.4 S93 / S94 / S95 / S96 verbatim at the unicode set', () => {
    const g = cfg.IMPORT_GLYPHS;
    expect(cfg.importAppliedItem(41, 41, { memory: 29, commands: 6, rules: 0, mcp: 3 }, 38 * 1024, g)).toBe('applied 41 of 41 · memory 29 · commands 6 · rules 0 · mcp 3 (disabled) · 38 KiB');
    expect(cfg.importUndoItem('imp_20260921T120000Z_a1b2c3', 41, 0, g)).toBe('undo imp_…a1b2c3 · 41 files restored · 0 modified since');
    expect(cfg.importWriteErrorItem('<path>', 'EACCES', 40, 41, 'imp_20260921T120000Z_a1b2c3', g)).toBe('error: could not write <path>: EACCES (40 of 41 applied) — jevcode import --resume imp_…a1b2c3 continues');
    expect(cfg.importSkippedRowItem('~/.claude/x.md', 'unsupported format', g)).toBe('skipped ~/.claude/x.md — unsupported format');
  });

  it('§7 row 54: a malformed source renders its REASON, never a stack', () => {
    const row = cfg.importSkippedRowItem('~/.codex/config.toml', 'skip:unsupported (toml parse failed at line 3)');
    expect(row).toContain('skip:unsupported');
    expect(row).not.toMatch(/\bat \w+ \(/); // no stack frame shape
  });
});

describe('§12.4 S89–S92 — the overlay strings', () => {
  it('S89 is the widest head rung, verbatim, and the ladder is §5.8’s three widths', () => {
    expect(lines.importHead(41, 9, 137, 38 * 1024, 200, U)).toBe('Import — 41 to import · 9 to review · 137 skipped · 38 KiB');
    expect(lines.importHead(41, 9, 137, 38 * 1024, 52, U)).toBe('Import — 41 to import · 9 to review · 137 skipped');
    expect(lines.importHead(41, 9, 137, 38 * 1024, 30, U)).toBe('Import — 41 · 9 · 137');
    // §5.8: at 40 columns the narrow rung is what fits
    expect(cellWidth(lines.importHead(41, 9, 137, 38 * 1024, blockWidth(40), U))).toBeLessThanOrEqual(blockWidth(40));
  });

  it('the head is measured in the glyph set it is drawn in (§2.6 edge 2)', () => {
    const a = lines.importHead(41, 9, 137, 38 * 1024, 200, A);
    expect(a).toBe('Import - 41 to import - 9 to review - 137 skipped - 38 KiB');
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f]*$/.test(a)).toBe(true);
  });

  it('S91 is the widest keys rung, and §5.8’s 40-column form is the narrow one', () => {
    expect(lines.importKeys(41, 200, U)).toBe('[y] import all 41   [Enter] expand a group   [r] review   [Esc] later');
    expect(lines.importKeys(41, 30, U)).toBe('y all · Enter open · Esc');
    expect(lines.importKeys(41, 12, U)).toBe('y all · Esc');
    for (const columns of [24, 40, 60, 80, 120, 200]) {
      const w = blockWidth(columns);
      expect(cellWidth(lines.importKeys(41, w, U)), `${columns}`).toBeLessThanOrEqual(w);
      expect(cellWidth(lines.importKeys(41, w, A)), `${columns} ascii`).toBeLessThanOrEqual(w);
    }
  });

  it('S92 is verbatim', () => {
    expect(lines.IMPORT_NOTHING_FOUND).toBe('nothing to import — no claude-code, codex or cursor configuration found');
  });

  it('S90: the review row’s breakdown is counted from the plan, and mcp says `disabled on import`', () => {
    const input = inputOf();
    const s = initImportUi(input);
    const review = s.groups.find((g) => g.key === 'review');
    const mcp = s.groups.find((g) => g.key === 'mcp');
    expect(review).toBeDefined();
    expect(lines.groupRowCells(review!, input.plan, 120, U)[2]).toBe(lines.reviewBreakdown(input.plan, U));
    expect(lines.reviewBreakdown(input.plan, U)).toBe('2 conflicts');
    expect(lines.groupRowCells(mcp!, input.plan, 120, U)[2]).toBe('disabled on import');
  });

  it('§5.8: the group row is two cells at 40, three at 80, and the whole source list at 120', () => {
    const input = inputOf();
    const s = initImportUi(input);
    const memory = s.groups.find((g) => g.key === 'memory');
    expect(memory).toBeDefined();
    expect(lines.groupRowCells(memory!, input.plan, blockWidth(40), U)).toHaveLength(2);
    const at80 = lines.groupRowCells(memory!, input.plan, blockWidth(80), U);
    const at120 = lines.groupRowCells(memory!, input.plan, blockWidth(120), U);
    expect(at80).toHaveLength(3);
    expect(at80[2]).toMatch(/more$/);
    expect(at120[2]?.split(', ').length).toBeGreaterThan(1);
  });
});

describe('the block (D-AO) and the twins', () => {
  it('every rendered row fits `blockWidth(columns)` at every width from 1 to 200, both glyph sets', () => {
    const input = inputOf();
    const s = initImportUi(input);
    for (let columns = 1; columns <= 200; columns++) {
      const w = blockWidth(columns);
      for (const g of [U, A]) {
        for (const row of lines.importLines(s, input, columns, g)) {
          expect(cellWidth(row), `${columns}:${g.mode}:${row}`).toBeLessThanOrEqual(w);
        }
      }
    }
  });

  it('every step, hint and glyph set: the `--ascii` twin carries no unicode cell of OUR making', () => {
    const input = inputOf();
    const base = initImportUi(input);
    // the plan's own text (a source display path, the engine's `why` sentence) is NEVER glyph-substituted —
    // §12's rule is "code-generated strings only, never user text" — so the sweep reads the rows the overlay
    // itself builds: the head, the group rows, the keys row and every hint. This is a DECLARED exclusion.
    const planText = input.plan.rows.flatMap((r) => [r.source.display, r.dest ?? '', r.why]).join('\n');
    // a row is OURS unless it carries the plan's own text: the `review` body is `kv` rows of `source` / `why` /
    // `dest` straight from the engine, and the group rows' hint column is a source display path
    const ours = (row: string, step: string): boolean => {
      const t = row.trim();
      if (t.length === 0) return false;
      // `source` / `dest` are PATHS (never rewritten); the engine's `why` IS substituted and is swept
      if (step === 'review' && /^(source|dest)\b/.test(t)) return false;
      const head = t.replace(/^(source|why|dest)\s+/, '').replace(/[…]+$/, '').trim();
      return head.length > 0 && !planText.includes(head);
    };
    const states = [
      base,
      scanning(),
      importReducer(base, { type: 'review' }, input),
      importReducer(base, { type: 'apply' }, input),
      importReducer(importReducer(base, { type: 'apply' }, input), { type: 'interrupt' }, input),
      importReducer(base, { type: 'open' }, input),
      { ...base, hint: IMPORT_HINT_NOTHING },
      { ...base, hint: IMPORT_HINT_NOT_APPLICABLE },
    ];
    for (const st of states) {
      for (const columns of [24, 40, 60, 80, 120]) {
        for (const row of lines.importLines(st, input, columns, A)) {
          if (!ours(row, st.step)) continue;
          // eslint-disable-next-line no-control-regex
          expect(/^[\x00-\x7f]*$/.test(row), `${st.step}:${columns}: ${row}`).toBe(true);
        }
      }
    }
  });

  it('the keys row (§12.4 S91) and the `review` row (§5.8) survive at EVERY width and both glyph sets', () => {
    const input = inputOf();
    const s = initImportUi(input);
    for (let columns = 24; columns <= 200; columns++) {
      for (const g of [U, A]) {
        const rows = lines.importLines(s, input, columns, g);
        const keys = lines.importKeys(input.summary.toImport, blockWidth(columns), g);
        expect(rows[rows.length - 1], `${columns}:${g.mode}`).toBe(keys);
        expect(rows.some((r) => /^review\s+2/.test(r)), `${columns}:${g.mode} review row`).toBe(true);
        // §5.2: the head, the group rows and the keys row — never more than `CAP.import`, never fewer than all of them
        expect(rows.length, `${columns}:${g.mode}`).toBe(2 + s.groups.length);
      }
    }
  });

  it('a budget narrower than the block keeps the head and the keys row, and says what it dropped', () => {
    const input = inputOf();
    const s = importReducer(initImportUi(input), { type: 'open' }, input);
    for (const budget of [3, 4, 6, 10]) {
      const rows = lines.importLines(s, input, 80, U, budget);
      expect(rows.length, `${budget}`).toBeLessThanOrEqual(budget);
      expect(rows[0], `${budget}`).toContain('Import');
      expect(rows[rows.length - 1], `${budget}`).toBe(lines.IMPORT_HINT_ROWS);
      if (rows.length === budget && budget < 7) expect(rows.some((r) => /more rows$/.test(r)), `${budget}`).toBe(true);
    }
  });

  it('§5.8 at 40 columns: the group row is ONE row (`memory  5`), never the stacked two', () => {
    const input = inputOf();
    const rows = lines.importLines(initImportUi(input), input, 40, U);
    expect(rows.filter((r) => /^memory/.test(r))).toHaveLength(1);
    expect(rows[1]).toMatch(/^memory\s+5$/);
    expect(rows[rows.length - 1]).toBe('y all · Enter open · Esc');
  });

  it('every step produces rows, and none of them is empty at 80 columns', () => {
    const input = inputOf();
    let s = initImportUi(input);
    const steps: string[] = [];
    for (const action of [{ type: 'open' } as const, { type: 'back' } as const, { type: 'review' } as const, { type: 'back' } as const, { type: 'apply' } as const, { type: 'applied', ok: 9, failed: 0, total: 9 } as const]) {
      s = importReducer(s, action, input);
      steps.push(s.step);
      expect(lines.importLines(s, input, 80, U).length, s.step).toBeGreaterThan(0);
    }
    expect(steps).toEqual(['rows', 'groups', 'review', 'groups', 'applying', 'done']);
  });

  it('`--plain` is the numbered twin with the same head and the same counts (§5.7, §13.1)', () => {
    const input = inputOf();
    const s = initImportUi(input);
    const plain = lines.importPlainLines(s, input, 120, U);
    expect(plain[0]).toBe(lines.importHead(input.summary.toImport, input.summary.toReview, input.summary.skipped, input.summary.bytes, blockWidth(120), U));
    expect(plain.filter((l) => /^ {2}\d+ /.test(l))).toHaveLength(s.groups.length);
    expect(plain[plain.length - 1]).toBe(lines.importSelectionPrompt(s.groups.length));
    expect(plain.some((l) => l.includes('[needs you]'))).toBe(true);
  });

  it('the screen-reader twin is numbered, spoken and glyph-free (§12.4 S89/S90 SR)', () => {
    const input = inputOf();
    const s = initImportUi(input);
    const sr = lines.importScreenReaderLines(s);
    expect(sr[0]).toBe(`Import: ${input.summary.toImport} to import, ${input.summary.toReview} to review, ${input.summary.skipped} skipped, ${lines.importSize(input.summary.bytes).replace(' KiB', ' kibibytes')}`);
    for (const row of sr) {
      expect(row).not.toContain('·');
      expect(row).not.toContain('—');
      expect(row).not.toContain('…');
    }
    expect(sr[sr.length - 1]).toBe(lines.importSelectionPrompt(s.groups.length));
  });
});

describe('§13.1 — one producer per string', () => {
  it('the §5.1 probe summary is NOT re-declared here: `importProbeSummary` (onboarding/lines.ts) is its one home', () => {
    expect((lines as unknown as Record<string, unknown>)['probeSummary']).toBeUndefined();
    expect(LINES_SRC).not.toContain('found ${');
  });

  it('§13.1 PENDING: the `[import]` identity row waits on `UiLabel += "[import]"` (the clause, declared now)', () => {
    // The clause, written down so it is not absent: `transcript.log == --plain == TUI` for every `[import]` item
    // holds by construction TODAY — all three sinks call the same builder in `config/imports.ts` (asserted
    // above) — but the row cannot join `r5-identity.test.ts`'s sweep until the label exists on `UiLabel`
    // (`src/core/types.ts:1849`, seven members, harness-owned; the request is in the implementer report).
    const types = readFileSync(new URL('../../../../src/core/types.ts', import.meta.url), 'utf8');
    const union = /export type UiLabel = [^;]+;/.exec(types)?.[0] ?? '';
    expect(union).not.toBe('');
    // when this flips, move the row into the identity sweep rather than deleting this test
    expect(union.includes("'[import]'"), 'UiLabel now carries [import]: add the identity row').toBe(false);
  });

  it('§12.4 S91 / IMPORT-DESIGN §5.2: every hint is ASCII-clean after substitution, including the review prompt', () => {
    expect(lines.IMPORT_HINT_PICK).toBe('pick 1-4 · Esc back');
    // an EN DASH would be in no glyph table, so no `--ascii` twin could ever reach it
    expect(lines.IMPORT_HINT_PICK).not.toContain('–');
    for (const text of [lines.IMPORT_HINT_PICK, lines.IMPORT_HINT_ROWS, lines.IMPORT_HINT_APPLYING, lines.IMPORT_SCANNING_ROW, lines.IMPORT_NOTHING_FOUND]) {
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7f]*$/.test(glyphTwin(text, A)), text).toBe(true);
    }
  });
});
