/**
 * Found by the discover/report agent while fixing review defect 9, and deliberately left open by
 * it as out of its scope: **`renderPlanJson` is not redacted.**
 *
 * Defect 9 redacted `report.md` because its own leak assertion was crashing on a hostile
 * filename. `plan.json` has no such assertion, so nothing forced the issue — but §1 property 4
 * names `plan.json` in the same breath as `report.md` ("grep `report.md`, `plan.json`,
 * `sources.jsonl`, …"), and `--json` puts exactly this string on stdout (§4.6.2). A repository
 * that ships `docs/AKIAIOSFODNN7EXAMPLE.md` therefore gets that string echoed verbatim into an
 * artefact and onto the terminal, from a path the human never typed.
 *
 * The source-controlled strings that reach the plan are `source.display`, `why`, `warnings` and
 * `notices`. None of them should ever be able to carry a credential shape.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REDACTING_PATTERNS, WARN_ONLY_PATTERNS } from '../../../src/core/redact.js';
import { asImportPlan, renderPlanJson, renderReport } from '../../../src/import/index.js';
import type { ImportPlan } from '../../../src/import/index.js';

const ROOT = join(import.meta.dirname, '../../..');
const base = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/import/plan.json'), 'utf8')) as ImportPlan;

/** One synthetic needle per family, matching each family's own regex. */
const NEEDLES: readonly string[] = [
  'sk-or-v1-0123456789abcdef0123456789abcdef',
  'sk-ant-api03-0123456789abcdef0123456789abcdef',
  'sk-0123456789abcdef0123456789abcdef',
  'AIzaSyA0123456789abcdefghijklmnopqrstuvw',
  'ghp_0123456789abcdefghijklmnopqrstuvwxyz12',
  'AKIAIOSFODNN7EXAMPLE',
  'xoxb-123456789012-0123456789abcdefghij',
  'npm_0123456789abcdefghijklmnopqrstuvwxyz12',
  'glpat-0123456789abcdefghij',
];

/** A plan whose source-controlled strings are poisoned exactly as a hostile repository would. */
function poisoned(): ImportPlan {
  const first = base.rows[0]!;
  return {
    ...base,
    rows: [
      {
        ...first,
        source: { ...first.source, display: `docs/${NEEDLES[5]}.md` },
        why: `rule 9 — matched ${NEEDLES[0]}`,
        warnings: [`a warning naming ${NEEDLES[4]}`],
      },
      ...base.rows.slice(1),
    ],
    notices: [...base.notices, `walk: skipped ${NEEDLES[6]}`],
  };
}

describe('§1 property 4 — plan.json is an artefact too', () => {
  it('renderPlanJson redacts every source-controlled string, like renderReport does', () => {
    const json = renderPlanJson(poisoned());
    for (const needle of NEEDLES) {
      expect(json.includes(needle), `plan.json leaked ${needle.slice(0, 6)}…`).toBe(false);
    }
  });

  it('report.md and plan.json agree — neither leaks what the other redacts', () => {
    const p = poisoned();
    const both = `${renderReport(p)}\n${renderPlanJson(p)}`;
    for (const { re } of [...REDACTING_PATTERNS, ...WARN_ONLY_PATTERNS]) {
      const rx = new RegExp(re.source, re.flags.replace('g', ''));
      expect(rx.test(both), `a ${re.source.slice(0, 18)}… shape survived rendering`).toBe(false);
    }
  });

  it('a clean plan still round-trips: redaction must not corrupt the JSON contract', () => {
    const json = renderPlanJson(base);
    const back = asImportPlan(JSON.parse(json) as never);
    expect(back).not.toBeNull();
    expect(back?.importId).toBe(base.importId);
    expect(back?.rows.length).toBe(base.rows.length);
    // an untouched plan is byte-identical through the renderer, so nothing is silently rewritten
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(base)));
  });
});
