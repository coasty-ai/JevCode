/**
 * docs/IMPORT-DESIGN.md §4.1 / §5.2 / §5.5: the facade the interactive session imports. The plan summary
 * and the `--yes` row set are engine policy — every surface quotes them rather than re-deriving
 * them, so the overlay, the `[import]` items, `--plain` and `--json` can never disagree.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { applicableRows, asImportPlan, isImportId, newImportId, summarisePlan } from '../../../src/import/index.js';
import type { ImportPlan } from '../../../src/import/types.js';

const ROOT = join(import.meta.dirname, '../../..');
const plan = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/import/plan.json'), 'utf8')) as ImportPlan;

describe('newImportId / isImportId (§0)', () => {
  it('builds `imp_<ISO compact>_<6 hex>` and round-trips through the validator', () => {
    const id = newImportId(new Date('2026-09-21T12:00:00.000Z'), 'seed');
    expect(id).toMatch(/^imp_20260921T120000Z_[0-9a-f]{6}$/);
    expect(isImportId(id)).toBe(true);
  });

  it('is deterministic given the same clock and seed, and differs on a different seed', () => {
    const at = new Date('2026-09-21T12:00:00.000Z');
    expect(newImportId(at, 'a')).toBe(newImportId(at, 'a'));
    expect(newImportId(at, 'a')).not.toBe(newImportId(at, 'b'));
  });

  it('rejects anything that is not an import id', () => {
    for (const bad of ['', 'imp_', 'imp_20260921T120000Z_XYZ123', 'imp_2026-09-21_a1b2c3', '../../etc/passwd']) {
      expect(isImportId(bad), bad).toBe(false);
    }
  });
});

describe('summarisePlan (§5.2)', () => {
  it('groups every row exactly once — nothing is silently lost (§1 property 2)', () => {
    const s = summarisePlan(plan);
    const total = s.groups.reduce((n, g) => n + g.rows, 0);
    expect(total).toBe(plan.rows.length);
  });

  it('review and skipped are never applicable; the headline counts follow from the groups', () => {
    const s = summarisePlan(plan);
    for (const g of s.groups) {
      if (g.key === 'review' || g.key === 'skipped') expect(g.applicable, g.key).toBe(false);
      else expect(g.applicable, g.key).toBe(true);
    }
    expect(s.toImport + s.toReview + s.skipped).toBe(plan.rows.length);
    expect(s.toReview).toBe(plan.rows.filter((r) => r.action === 'review').length);
    expect(s.skipped).toBe(plan.rows.filter((r) => r.action.startsWith('skip:')).length);
  });

  it('counts the credentials found without ever naming one', () => {
    const s = summarisePlan(plan);
    expect(s.credentialsFound).toBe(plan.rows.filter((r) => r.class === 'secret').length);
    expect(JSON.stringify(s)).not.toMatch(/sk-|ghp_|AIza/);
  });

  it('bytes sum only over applicable groups', () => {
    const s = summarisePlan(plan);
    const expected = plan.rows
      .filter((r) => r.action !== 'review' && !r.action.startsWith('skip:'))
      .reduce((n, r) => n + r.bytes, 0);
    expect(s.bytes).toBe(expected);
  });
});

describe('applicableRows (§4.5 pass 3 / §4.8.2)', () => {
  it('never returns a review, suggest, skip or credential row', () => {
    const ids = new Set(applicableRows(plan));
    for (const r of plan.rows) {
      const excluded = r.action === 'review' || r.action === 'suggest' || r.action.startsWith('skip:') || r.class === 'secret';
      expect(ids.has(r.id), `${r.id} ${r.action} ${r.class}`).toBe(!excluded);
    }
  });

  it('a conflict group’s rows are excluded from --yes by construction', () => {
    const conflict = plan.rows.filter((r) => r.group?.startsWith('conflict') === true);
    expect(conflict.length).toBeGreaterThan(0);
    const ids = new Set(applicableRows(plan));
    for (const r of conflict) expect(ids.has(r.id), r.id).toBe(false);
  });

  it('--scope=user and --scope=project partition the applicable set', () => {
    const all = applicableRows(plan, { scope: 'both' });
    const user = applicableRows(plan, { scope: 'user' });
    const project = applicableRows(plan, { scope: 'project' });
    expect(user.length + project.length).toBe(all.length);
    expect(new Set([...user, ...project]).size).toBe(all.length);
    // project-local rows belong to the project side, never to the user side
    const byId = new Map(plan.rows.map((r) => [r.id, r] as const));
    for (const id of project) expect(byId.get(id)?.scope).not.toBe('user');
    for (const id of user) expect(byId.get(id)?.scope).toBe('user');
  });
});

describe('asImportPlan', () => {
  it('accepts the committed fixture and rejects anything else', () => {
    expect(asImportPlan(JSON.parse(readFileSync(join(ROOT, 'test/fixtures/import/plan.json'), 'utf8')))).not.toBeNull();
    expect(asImportPlan(null)).toBeNull();
    expect(asImportPlan([])).toBeNull();
    expect(asImportPlan({ v: 2, importId: 'x', rows: [] })).toBeNull();
    expect(asImportPlan({ v: 1, rows: [] })).toBeNull();
  });
});
