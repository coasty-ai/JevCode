/**
 * §1 property 2 — **nothing is silently lost** (IMPORT-DESIGN §8.3 gate `plan-total`).
 *
 * Every discovered artefact appears in the report with exactly one action, there is no "other"
 * bucket, and **every `ImportAction` value appears in at least one fixture row** — so a new
 * action that nothing produces, or an action that quietly swallows a row, fails here.
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../src/core/hash.js';
import { classifyKey, formatOf } from '../../../src/import/classify.js';
import type { FileVerdict } from '../../../src/import/classify.js';
import { buildPlan } from '../../../src/import/plan.js';
import type { PlanCandidate } from '../../../src/import/plan.js';
import type { ImportAction, ImportManifest, ImportSkipAction, SourceItem } from '../../../src/import/types.js';

/** The full `ImportAction` union of `src/import/types.ts`, written out so a new member fails this file. */
const SKIP_ACTIONS: readonly ImportSkipAction[] = [
  'skip:unchanged',
  'skip:self',
  'skip:secret',
  'skip:executable',
  'skip:unsupported',
  'skip:oversize',
  'skip:not-text',
  'skip:not-a-file',
  'skip:parse-error',
  'skip:symlink',
  'skip:transcript',
  'skip:third-party',
  'skip:tool-managed',
  'skip:unknown-format',
  'skip:remote',
  'skip:unrelated',
  'skip:untrusted',
];
const ALL_ACTIONS: readonly ImportAction[] = ['create', 'append', 'update', 'merge', 'review', 'suggest', ...SKIP_ACTIONS];

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
    scope: 'user',
    bytes: 400,
    sha256: sha256Hex(realpath),
    mtime: '2026-09-21T12:00:00.000Z',
    parse: { ok: true },
    notices: [],
  };
  return { ...base, ...over };
}

function skipVerdict(skip: ImportSkipAction, rule: number): FileVerdict {
  return { class: 'memory', skip, rule, p: 1, band: false, why: `rule ${rule} (${skip})` };
}
const memoryVerdict: FileVerdict = { class: 'memory', skip: null, rule: 9, p: 0.9, band: false, why: 'rule 9' };
const configVerdict: FileVerdict = { class: 'config', skip: null, rule: 1, p: 1, band: false, why: 'rule 1 (atlas claude.settings)' };

const IMPORT_ID = 'imp_20260921T120000Z_a1b2c3';
const USER = '~/.config/jevcode/';

// the seven non-skip / manifest-driven rows
const fresh = item('/h/.claude/memory/fresh.md');
const appended = item('/h/.claude/CLAUDE.md');
const updated = item('/h/.claude/memory/updated.md');
const merged = item('/h/.cursor/mcp.json');
const reviewed = item('/h/.claude/memory/existing.md');
const suggested = item('/h/.claude/settings.json');
const unchanged = item('/h/.claude/memory/unchanged.md');
const untrusted = item('/ws/AGENTS.md', { scope: 'project' });

const manifest: ImportManifest = {
  v: 1,
  user: [
    { importId: IMPORT_ID, dest: `${USER}memory/updated.md`, sourceSha256: 'stale', destSha256: 'd-updated', scope: 'user', at: '2026-09-20T00:00:00.000Z', by: 'tty' },
    { importId: IMPORT_ID, dest: `${USER}memory/unchanged.md`, sourceSha256: unchanged.sha256, destSha256: 'd-unchanged', scope: 'user', at: '2026-09-20T00:00:00.000Z', by: 'tty' },
  ],
  workspaces: {},
};

const destState = {
  [`${USER}AGENTS.md`]: { sha256: 'd-agents', markers: [] },
  [`${USER}memory/updated.md`]: { sha256: 'd-updated', markers: [IMPORT_ID] },
  [`${USER}memory/unchanged.md`]: { sha256: 'd-unchanged', markers: [IMPORT_ID] },
  [`${USER}memory/existing.md`]: { sha256: 'd-existing', markers: [] },
  [`${USER}mcp.json`]: { sha256: 'd-mcp', markers: [] },
};

const candidates: PlanCandidate[] = [
  { item: fresh, verdict: memoryVerdict, destination: { kind: 'memory-topic', scope: 'user' } },
  { item: appended, verdict: memoryVerdict, destination: { kind: 'agents-append', scope: 'user' } },
  { item: updated, verdict: memoryVerdict, destination: { kind: 'memory-topic', scope: 'user' } },
  { item: merged, verdict: configVerdict, destination: { kind: 'report-only', scope: 'user' }, keys: [classifyKey({ path: ['mcpServers', 'github', 'command'], dotted: 'mcpServers.github.command', value: 'npx' })] },
  { item: reviewed, verdict: memoryVerdict, destination: { kind: 'memory-topic', scope: 'user' } },
  { item: suggested, verdict: configVerdict, destination: { kind: 'report-only', scope: 'user' }, keys: [classifyKey({ path: ['permissions', 'allow', '0'], dotted: 'permissions.allow.0', value: 'Bash(ls)' })] },
  { item: unchanged, verdict: memoryVerdict, destination: { kind: 'memory-topic', scope: 'user' } },
  { item: untrusted, verdict: memoryVerdict, destination: { kind: 'agents-append', scope: 'project' } },
  ...SKIP_ACTIONS.filter((s) => s !== 'skip:unchanged' && s !== 'skip:untrusted').map((skip, i) => ({
    item: item(`/h/.claude/skipped-${skip.replace(':', '-')}-${i}.md`),
    verdict: skipVerdict(skip, 2 + i),
    destination: { kind: 'memory-topic' as const, scope: 'user' as const },
  })),
];

const plan = buildPlan({
  candidates,
  importId: IMPORT_ID,
  at: '2026-09-21T12:00:00.000Z',
  jevcodeVersion: '0.3.0',
  workspace: '/ws',
  workspaceKey: '/ws',
  gitRoot: '/ws',
  trust: 'none',
  roots: [{ display: '~/.claude', tool: 'claude-code', via: 'default', exists: true }],
  manifest,
  destState,
});

describe('§1 property 2 nothing is silently lost', () => {
  it('rows grouped by action sum to the candidate count', () => {
    const byAction = new Map<string, number>();
    for (const r of plan.rows) byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
    const summed = [...byAction.values()].reduce((a, b) => a + b, 0);
    expect(summed).toBe(plan.rows.length);
    expect(plan.rows.length).toBe(candidates.length);
  });

  it('every discovered artefact appears exactly once, with exactly one action', () => {
    const sourceIds = plan.rows.map((r) => r.source.id);
    expect(new Set(sourceIds).size).toBe(candidates.length);
    for (const c of candidates) expect(sourceIds, c.item.realpath).toContain(c.item.id);
    for (const r of plan.rows) expect(ALL_ACTIONS, `${r.source.display} → ${r.action}`).toContain(r.action);
  });

  it('every ImportAction value appears in at least one fixture row', () => {
    const seen = new Set(plan.rows.map((r) => r.action));
    const missing = ALL_ACTIONS.filter((a) => !seen.has(a));
    expect(missing).toEqual([]);
  });

  it('there is no "other" bucket — every skip is one of the seventeen named reasons', () => {
    for (const r of plan.rows) {
      if (!r.action.startsWith('skip:')) continue;
      expect(SKIP_ACTIONS, r.action).toContain(r.action);
      expect(r.bytes).toBe(0);
    }
  });

  it('every row id is a distinct 12-hex string, and every why is non-empty', () => {
    expect(new Set(plan.rows.map((r) => r.id)).size).toBe(plan.rows.length);
    for (const r of plan.rows) {
      expect(r.id).toMatch(/^[0-9a-f]{12}$/);
      expect(r.why.length).toBeGreaterThan(0);
    }
  });

  it('no row of any class carries a destination outside the two trees', () => {
    for (const r of plan.rows) {
      if (r.dest === null) continue;
      const ok = r.dest.startsWith('.jevcode/') || r.dest.startsWith('~/.config/jevcode/') || r.dest === 'AGENTS.md';
      expect(ok, r.dest).toBe(true);
    }
  });
});
