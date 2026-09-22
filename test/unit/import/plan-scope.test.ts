/**
 * §1 property 11 — **scope is meaning** (IMPORT-DESIGN §0 principle 7, §2.5, §8.3 gate
 * `plan-scope`).
 *
 * A Cursor `globs:`, a Claude `paths:`, a Windsurf `trigger: glob` and a Copilot `applyTo` all
 * land **path-scoped**, with their globs expanded, in `.jevcode/rules/` — and **none** of them is
 * appended to `AGENTS.md`.
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../src/core/hash.js';
import { formatOf } from '../../../src/import/classify.js';
import type { FileVerdict } from '../../../src/import/classify.js';
import { buildPlan, ruleSpecOf } from '../../../src/import/plan.js';
import type { PlanCandidate } from '../../../src/import/plan.js';
import type { Frontmatter, FrontmatterValue, MarkdownDoc, SourceItem, SourceTool } from '../../../src/import/types.js';

let seq = 0;
function item(realpath: string, tool: SourceTool): SourceItem {
  seq += 1;
  return {
    id: `id${String(seq).padStart(10, '0')}`,
    realpath,
    display: realpath,
    tools: [tool],
    artefact: 'rule',
    format: formatOf(realpath),
    scope: 'project',
    bytes: 900,
    sha256: sha256Hex(realpath),
    mtime: '2026-09-21T12:00:00.000Z',
    parse: { ok: true },
    notices: [],
  };
}

function fm(values: Record<string, FrontmatterValue>): Frontmatter {
  return { keys: Object.keys(values), values, bodyOffset: 0, broken: false };
}

function doc(text: string): MarkdownDoc {
  return {
    text,
    controlsRemoved: 0,
    frontmatter: null,
    headings: [],
    lines: 3,
    fences: 0,
    executables: [],
    refs: [],
    tokens: [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0))],
    normalisedSha256: sha256Hex(text),
    bands: [sha256Hex(text).slice(0, 8)],
  };
}

const ruleVerdict: FileVerdict = { class: 'rule', skip: null, rule: 7, p: 0.95, band: false, why: 'rule 7 (frontmatter globs)' };

const sources: { name: string; tool: SourceTool; path: string; values: Record<string, FrontmatterValue>; patterns: string[] }[] = [
  { name: 'cursor globs:', tool: 'cursor', path: '/ws/.cursor/rules/style.mdc', values: { globs: ['src/**/*.{ts,tsx}'] }, patterns: ['src/**/*.ts', 'src/**/*.tsx'] },
  { name: 'claude paths:', tool: 'claude-code', path: '/ws/.claude/rules/tests.md', values: { paths: ['test/**/*.ts'] }, patterns: ['test/**/*.ts'] },
  { name: 'windsurf trigger: glob', tool: 'windsurf', path: '/ws/.devin/rules/app.md', values: { trigger: 'glob', globs: ['app/**'] }, patterns: ['app/**'] },
  { name: 'copilot applyTo', tool: 'copilot', path: '/ws/.github/instructions/ts.instructions.md', values: { applyTo: '**/*.ts,**/*.tsx' }, patterns: ['**/*.ts', '**/*.tsx'] },
];

const candidates: PlanCandidate[] = sources.map((s) => ({
  item: item(s.path, s.tool),
  verdict: ruleVerdict,
  destination: { kind: 'rule', scope: 'project' },
  frontmatter: fm(s.values),
  doc: doc(`# ${s.name} rule body unique to ${s.tool}`),
}));

const plan = buildPlan({
  candidates,
  importId: 'imp_20260921T120000Z_a1b2c3',
  at: '2026-09-21T12:00:00.000Z',
  jevcodeVersion: '0.3.0',
  workspace: '/ws',
  workspaceKey: '/ws',
  gitRoot: '/ws',
  trust: 'trust',
  roots: [],
});

describe('§1 property 11 the four scoped-rule sources land path-scoped', () => {
  it('all four become rules under .jevcode/rules, one row each', () => {
    expect(plan.rows).toHaveLength(4);
    expect(plan.rows.map((r) => r.dest)).toEqual(['.jevcode/rules/style.md', '.jevcode/rules/tests.md', '.jevcode/rules/app.md', '.jevcode/rules/ts-instructions.md']);
    expect(plan.rows.every((r) => r.class === 'rule')).toBe(true);
    expect(plan.rows.every((r) => r.action === 'create')).toBe(true);
  });

  it('none is appended to AGENTS.md — the distinction §2.5 exists for', () => {
    for (const r of plan.rows) {
      expect(r.dest).not.toBe('AGENTS.md');
      expect(r.dest).not.toBe('~/.config/jevcode/AGENTS.md');
      expect(r.action).not.toBe('append');
    }
  });

  it('every one carries `trigger paths` and its expanded globs', () => {
    sources.forEach((s, i) => {
      const spec = ruleSpecOf(candidates[i] as PlanCandidate);
      expect(spec.trigger, s.name).toBe('paths');
      expect([...spec.patterns], s.name).toEqual(s.patterns);
      expect(plan.rows[i]?.why, s.name).toContain(`trigger paths, ${s.patterns.length} pattern`);
    });
  });

  it('a rule with no scope at all is `always` — a rule file with paths ["**"], never an AGENTS.md promotion (§2.5)', () => {
    const alwaysOn: PlanCandidate = {
      item: item('/ws/.cursorrules', 'cursor'),
      verdict: { ...ruleVerdict, why: 'rule 1 (atlas cursor.legacy-rules)' },
      destination: { kind: 'rule', scope: 'project' },
      doc: doc('# legacy always-on cursor rules'),
    };
    const p = buildPlan({ ...{ candidates: [alwaysOn] }, importId: 'i', at: 'a', jevcodeVersion: '0.3.0', workspace: '/ws', workspaceKey: '/ws', gitRoot: '/ws', trust: 'trust', roots: [] });
    expect(p.rows[0]?.dest).toBe('.jevcode/rules/cursorrules.md');
    expect(p.rows[0]?.why).toContain('trigger always, 1 pattern');
    expect(ruleSpecOf(alwaysOn).patterns).toEqual(['**']);
  });

  it('the glob budget caps with the design’s warning (§6 row 62)', () => {
    const many: PlanCandidate = {
      item: item('/ws/.cursor/rules/wide.mdc', 'cursor'),
      verdict: ruleVerdict,
      destination: { kind: 'rule', scope: 'project' },
      frontmatter: fm({ globs: Array.from({ length: 238 }, (_, i) => `p${i}/**`) }),
      doc: doc('# a very wide rule'),
    };
    const p = buildPlan({ candidates: [many], importId: 'i', at: 'a', jevcodeVersion: '0.3.0', workspace: '/ws', workspaceKey: '/ws', gitRoot: '/ws', trust: 'trust', roots: [] });
    expect(p.rows[0]?.warnings).toEqual(['glob budget 200 reached; 38 patterns dropped']);
    expect(p.notices.some((n) => n.includes('glob budget 200 reached; 38 patterns dropped'))).toBe(true);
  });
});
