/**
 * src/import/report.ts (IMPORT-DESIGN §4.6.1 `--json`, §4.6.2 `report.md`, §8.2 **R5**,
 * §6 rows 5 and 89, §1 property 4).
 *
 * The fixture is the committed W2→W3 seam `test/fixtures/import/plan.json` (§7.7): the report is
 * rendered from it, read back with `parseReport`, and the recovered ids, actions and
 * destinations are compared against the plan — *the report is not allowed to say something the
 * plan does not*.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS } from '../../../src/core/limits.js';
import { REDACTING_PATTERNS, WARN_ONLY_PATTERNS } from '../../../src/core/redact.js';
import { REPORT_SECTIONS, parseReport, renderPlanJson, renderReport } from '../../../src/import/report.js';
import type { ImportPlan, PlanRow } from '../../../src/import/types.js';

const FIXTURE = join(import.meta.dirname, '../../fixtures/import/plan.json');
const raw = readFileSync(FIXTURE, 'utf8');
const plan = JSON.parse(raw) as ImportPlan;

describe('the fixture is the W2→W3 seam', () => {
  it('parses as an ImportPlan with rows in every class', () => {
    expect(plan.v).toBe(1);
    expect(plan.rows.length).toBeGreaterThan(10);
    expect(new Set(plan.rows.map((r) => r.class)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(plan.rows.map((r) => r.id)).size).toBe(plan.rows.length);
  });
});

describe('§4.6.2 renderReport', () => {
  const report = renderReport(plan);

  it('renders every section head, in order, including an empty one (§6 row 5)', () => {
    const heads = parseReport(report).sections;
    for (const want of REPORT_SECTIONS) expect(heads.some((h) => h === want || h.startsWith(`${want} `) || h.startsWith(`${want} `)), want).toBe(true);
    const indexes = REPORT_SECTIONS.map((want) => heads.findIndex((h) => h === want || h.startsWith(`${want} `)));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    const empty = renderReport({ ...plan, cannotRead: [], notices: [], rows: [] });
    for (const want of REPORT_SECTIONS) expect(empty.includes(`## ${want}`), want).toBe(true);
    expect(empty).toContain('## Cannot be read from disk  (0)');
  });

  it('§8.2 R5 — parseReport recovers the same row ids, actions and destinations', () => {
    const recovered = parseReport(report).rows;
    expect(recovered.map((r) => r.id).sort()).toEqual(plan.rows.map((r) => r.id).sort());
    const byId = new Map(recovered.map((r) => [r.id, r]));
    for (const row of plan.rows) {
      const got = byId.get(row.id);
      expect(got, row.id).toBeDefined();
      expect(got?.action, `${row.id} action`).toBe(row.action);
      expect(got?.dest, `${row.id} dest`).toBe(row.dest);
    }
  });

  it('is deterministic, ASCII-escape free and under reportBytes', () => {
    expect(renderReport(plan)).toBe(report);
    // eslint-disable-next-line no-control-regex
    expect(/\u001b\[/.test(report)).toBe(false);
    expect(Buffer.byteLength(report, 'utf8')).toBeLessThanOrEqual(IMPORT_LIMITS.reportBytes);
    expect(report.endsWith('\n')).toBe(true);
  });

  it('opens with the "nothing has been written" line [G2.6] and the summary counts', () => {
    expect(report).toContain(`# jevcode import — dry run ${plan.importId}`);
    expect(report).toContain(`Nothing outside ~/.jevcode/imports/${plan.importId}/ has been written.`);
    const toImport = plan.rows.filter((r) => !r.action.startsWith('skip:') && r.action !== 'review' && r.action !== 'suggest').length;
    const toReview = plan.rows.filter((r) => r.action === 'review').length;
    const skipped = plan.rows.filter((r) => r.action.startsWith('skip:')).length;
    expect(report).toContain(`${toImport} to import · ${toReview} to review · ${skipped} skipped · 0 bytes of secrets copied`);
  });

  it('names every root, and every notice and cannot-read row', () => {
    for (const root of plan.roots) expect(report).toContain(root.tool);
    for (const n of plan.notices) expect(report).toContain(n);
    for (const c of plan.cannotRead) {
      expect(report).toContain(c.what);
      expect(report).toContain(c.paste);
    }
  });

  it('closes with the three apply commands', () => {
    expect(report).toContain('jevcode import --yes ');
    expect(report).toContain('jevcode import --yes --scope=user');
    expect(report).toContain(`jevcode import --undo ${plan.importId}`);
  });

  it('§6 row 89 — the ascii twin carries no unicode glyph', () => {
    const ascii = renderReport(plan, 'ascii');
    for (const glyph of ['→', '←', '·', '—', '≈', '…']) expect(ascii.includes(glyph), glyph).toBe(false);
    expect(ascii).toContain('## Memory  -> .jevcode/memory');
    // the same rows are recoverable from either twin
    expect(parseReport(ascii).rows.map((r) => r.id).sort()).toEqual(plan.rows.map((r) => r.id).sort());
  });
});

describe('§1 property 4 no rendered line carries a secret', () => {
  const views = [renderReport(plan), renderReport(plan, 'ascii')];

  it('no line matches any REDACTING_PATTERNS or WARN_ONLY_PATTERNS family', () => {
    const families = [...REDACTING_PATTERNS.map((p) => ({ family: p.family, re: p.re })), ...WARN_ONLY_PATTERNS];
    for (const view of views) {
      for (const [i, line] of view.split('\n').entries()) {
        for (const { family, re } of families) {
          const probe = new RegExp(re.source, re.flags.replace('g', ''));
          expect(probe.test(line), `${family} matched line ${i + 1}`).toBe(false);
        }
      }
    }
  });

  it('a secret that reached a `why` string is refused at render time, without echoing it', () => {
    const first = plan.rows[0] as PlanRow;
    const poisoned: ImportPlan = { ...plan, rows: [{ ...first, why: `key rule 9 — ghp_${'A'.repeat(36)}` }] };
    expect(() => renderReport(poisoned)).toThrowError(/matches the github secret family/);
    try {
      renderReport(poisoned);
    } catch (e) {
      expect(String(e)).not.toContain('AAAA');
    }
  });

  it('no full source sha256 is printed — only its eight-character prefix', () => {
    const report = renderReport(plan);
    for (const row of plan.rows) {
      expect(report).not.toContain(row.source.sha256);
      expect(report).toContain(row.source.sha256.slice(0, 8));
    }
  });
});

describe('§4.6.1 renderPlanJson', () => {
  const json = renderPlanJson(plan);

  it('is one object, no prose, no ANSI, and round-trips', () => {
    expect(json.trimStart().startsWith('{')).toBe(true);
    expect(json.trimEnd().endsWith('}')).toBe(true);
    // eslint-disable-next-line no-control-regex
    expect(/\u001b\[/.test(json)).toBe(false);
    expect(JSON.parse(json)).toEqual(plan);
    expect(renderPlanJson(plan)).toBe(json);
  });

  it('round-trips through the renderer too — the plan the report was made from', () => {
    const again = JSON.parse(renderPlanJson(JSON.parse(json) as ImportPlan)) as ImportPlan;
    expect(renderReport(again)).toBe(renderReport(plan));
  });
});

describe('parseReport is strict', () => {
  it('recovers nothing from prose, and maps a report-only row to a null destination', () => {
    expect(parseReport('# a title\n\njust prose, no rows here\n').rows).toEqual([]);
    const reportOnly = plan.rows.find((r) => r.dest === null);
    expect(reportOnly).toBeDefined();
    const got = parseReport(renderReport(plan)).rows.find((r) => r.id === reportOnly?.id);
    expect(got?.dest).toBe(null);
  });

  it('never returns a duplicate id even though secrets are listed twice', () => {
    const rows = parseReport(renderReport(plan)).rows;
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });
});

describe('§2.8 the report is byte-capped', () => {
  it('a plan far over reportBytes is clipped with a notice, not truncated silently', () => {
    const first = plan.rows[0] as PlanRow;
    const many: PlanRow[] = Array.from({ length: 12_000 }, (_, i) => ({
      ...first,
      id: i.toString(16).padStart(12, '0'),
      dest: `.jevcode/memory/${'n'.repeat(60)}-${i}.md`,
      why: `rule 10 (markdown, 1 heading, 40 lines) ${'x'.repeat(120)}`,
    }));
    const big = renderReport({ ...plan, rows: many });
    expect(Buffer.byteLength(big, 'utf8')).toBeLessThanOrEqual(IMPORT_LIMITS.reportBytes);
    expect(big).toContain('_report clipped at 1,048,576 bytes_');
  });
});
