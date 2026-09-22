/**
 * §6 rows 17 and 18 — **the monorepo**: `packages/*/AGENTS.md` and `packages/*/.cursor/rules/*`
 * are scoped by their own directory, never flattened into one always-on `AGENTS.md`; the root
 * `AGENTS.md` still lands at the repository root; and `ruleFiles: 200` **[G1.6]** caps the number
 * of rule files a session will match against per step.
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../src/core/hash.js';
import { IMPORT_LIMITS } from '../../../src/core/limits.js';
import { formatOf } from '../../../src/import/classify.js';
import type { FileVerdict } from '../../../src/import/classify.js';
import { buildPlan, relativeDir } from '../../../src/import/plan.js';
import type { PlanCandidate, PlanInput } from '../../../src/import/plan.js';
import type { DestinationSpec, Frontmatter, FrontmatterValue, MarkdownDoc, SourceItem } from '../../../src/import/types.js';

let seq = 0;
function item(realpath: string, over: Partial<SourceItem> = {}): SourceItem {
  seq += 1;
  const base: SourceItem = {
    id: `id${String(seq).padStart(10, '0')}`,
    realpath,
    display: realpath,
    tools: ['claude-code'],
    artefact: 'fixture',
    format: formatOf(realpath),
    scope: 'project',
    bytes: 600,
    sha256: sha256Hex(realpath),
    mtime: '2026-09-21T12:00:00.000Z',
    parse: { ok: true },
    notices: [],
  };
  return { ...base, ...over };
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
    lines: 4,
    fences: 0,
    executables: [],
    refs: [],
    tokens: [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0))],
    normalisedSha256: sha256Hex(text),
    bands: [sha256Hex(text).slice(0, 8)],
  };
}

const memoryVerdict: FileVerdict = { class: 'memory', skip: null, rule: 10, p: 0.75, band: false, why: 'rule 10 (markdown, 1 heading, 4 lines)' };
const ruleVerdict: FileVerdict = { class: 'rule', skip: null, rule: 7, p: 0.95, band: false, why: 'rule 7 (frontmatter globs)' };

function planInput(candidates: readonly PlanCandidate[], over: Partial<PlanInput> = {}): PlanInput {
  return {
    candidates,
    importId: 'imp_20260921T120000Z_a1b2c3',
    at: '2026-09-21T12:00:00.000Z',
    jevcodeVersion: '0.3.0',
    workspace: '/ws',
    workspaceKey: '/ws',
    gitRoot: '/ws',
    trust: 'trust',
    roots: [],
    ...over,
  };
}

const AGENTS: DestinationSpec = { kind: 'agents-append', scope: 'project' };

describe('§6 row 17 a monorepo is never flattened', () => {
  const root: PlanCandidate = { item: item('/ws/AGENTS.md'), verdict: memoryVerdict, destination: AGENTS, doc: doc('# repository rules\n\nthe root instructions for everyone') };
  const web: PlanCandidate = { item: item('/ws/packages/web/AGENTS.md'), verdict: memoryVerdict, destination: AGENTS, doc: doc('# web package\n\nreact conventions live here') };
  const api: PlanCandidate = { item: item('/ws/packages/api/AGENTS.md'), verdict: memoryVerdict, destination: AGENTS, doc: doc('# api package\n\nfastify conventions live here') };
  const nested: PlanCandidate = {
    item: item('/ws/packages/web/.cursor/rules/style.mdc'),
    verdict: ruleVerdict,
    destination: { kind: 'rule', scope: 'project' },
    frontmatter: fm({ globs: ['packages/web/src/**'] }),
    doc: doc('# web style rules for the package'),
  };
  const plan = buildPlan(planInput([root, web, api, nested]));

  it('the root AGENTS.md still lands at the repository root', () => {
    expect(plan.rows[0]).toMatchObject({ dest: 'AGENTS.md', class: 'memory' });
  });

  it('each package file becomes a path-scoped rule derived from its own directory', () => {
    expect(plan.rows[1]).toMatchObject({ dest: '.jevcode/rules/packages-web-agents.md', class: 'rule' });
    expect(plan.rows[1]?.why).toContain('trigger paths, 1 pattern');
    expect(plan.rows[2]).toMatchObject({ dest: '.jevcode/rules/packages-api-agents.md', class: 'rule' });
    for (const r of plan.rows.slice(1)) expect(r.dest).not.toBe('AGENTS.md');
  });

  it('a rule already inside a package keeps its own globs, and its tool directory never scopes it', () => {
    expect(relativeDir('/ws/packages/web/.cursor/rules/style.mdc', '/ws')).toBe('packages/web');
    expect(relativeDir('/ws/.cursor/rules/style.mdc', '/ws')).toBe(null);
    expect(relativeDir('/ws/AGENTS.md', '/ws')).toBe(null);
    expect(relativeDir('/elsewhere/AGENTS.md', '/ws')).toBe(null);
    expect(relativeDir('/ws/AGENTS.md', null)).toBe(null);
    expect(plan.rows[3]).toMatchObject({ dest: '.jevcode/rules/packages-web-style.md', class: 'rule' });
  });

  it('every destination stays inside the two trees, whatever the package is called', () => {
    const hostile: PlanCandidate = { item: item('/ws/packages/../../etc/AGENTS.md'), verdict: memoryVerdict, destination: AGENTS, doc: doc('# hostile package name') };
    const p = buildPlan(planInput([hostile]));
    const dest = p.rows[0]?.dest ?? '';
    expect(dest).not.toContain('..');
    expect(dest === 'AGENTS.md' || dest.startsWith('.jevcode/')).toBe(true);
  });
});

describe('§6 row 18 the rule-file budget [G1.6]', () => {
  const many: PlanCandidate[] = Array.from({ length: IMPORT_LIMITS.ruleFiles + 14 }, (_, i) => ({
    item: item(`/ws/packages/p${String(i).padStart(3, '0')}/AGENTS.md`),
    verdict: memoryVerdict,
    destination: AGENTS,
  }));
  const plan = buildPlan(planInput(many));

  it('caps at ruleFiles, keeps the most specific, and says so', () => {
    const kept = plan.rows.filter((r) => r.class === 'rule' && r.action === 'create');
    const dropped = plan.rows.filter((r) => r.action === 'skip:unsupported');
    expect(kept).toHaveLength(IMPORT_LIMITS.ruleFiles);
    expect(dropped).toHaveLength(14);
    expect(plan.notices).toContain('rule budget 200 reached; 14 rules not imported (most specific kept)');
  });

  it('nothing is lost: every candidate still has exactly one row', () => {
    expect(plan.rows).toHaveLength(many.length);
    expect(new Set(plan.rows.map((r) => r.source.id)).size).toBe(many.length);
    for (const r of plan.rows.filter((x) => x.action === 'skip:unsupported')) {
      expect(r.dest).toBe(null);
      expect(r.bytes).toBe(0);
      expect(r.why).toContain('rule budget 200 reached');
    }
  });
});
