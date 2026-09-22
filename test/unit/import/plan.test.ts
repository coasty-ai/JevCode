/**
 * src/import/plan.ts (IMPORT-DESIGN §4.5 the four passes, §4.6.1 the plan shape,
 * §4.7.3 **[G1.2]** `slugOf`, §4.7.5 **[G1.3]** the nine-cell re-run matrix, §6 group E rows
 * 55–64 and §6 rows 59–60, 83–85).
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../src/core/hash.js';
import { IMPORT_LIMITS } from '../../../src/core/limits.js';
import type { Answer } from '../../../src/core/types.js';
import { classifyKey, formatOf } from '../../../src/import/classify.js';
import type { FileVerdict } from '../../../src/import/classify.js';
import {
  allocateSlug,
  buildPlan,
  dedupe,
  displayPath,
  expandGlobs,
  findConflicts,
  jaccardOf,
  rankIndex,
  rerunAction,
  ruleSpecOf,
  slugOf,
} from '../../../src/import/plan.js';
import type { PlanCandidate, PlanInput } from '../../../src/import/plan.js';
import type { DestinationSpec, Frontmatter, FrontmatterValue, ImportManifest, ImportManifestEntry, MarkdownDoc, PlanRoot, PlanRow, SourceItem, SourceScope, SourceTool } from '../../../src/import/types.js';

// ---------------------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------------------

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
    bytes: 800,
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

function doc(text: string, over: Partial<MarkdownDoc> = {}): MarkdownDoc {
  const base: MarkdownDoc = {
    text,
    controlsRemoved: 0,
    frontmatter: null,
    headings: [],
    lines: text.split('\n').length,
    fences: 0,
    executables: [],
    refs: [],
    tokens: [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0))],
    normalisedSha256: sha256Hex(text),
    bands: [sha256Hex(text).slice(0, 8)],
  };
  return { ...base, ...over };
}

const okVerdict: FileVerdict = { class: 'memory', skip: null, rule: 9, p: 0.9, band: false, why: 'rule 9 (frontmatter name+description+metadata.type)' };

function candidate(over: Partial<PlanCandidate> & { item: SourceItem }): PlanCandidate {
  return { verdict: okVerdict, destination: { kind: 'memory-topic', scope: 'project' }, ...over };
}

const ROOTS: readonly PlanRoot[] = [{ display: '~/.claude', tool: 'claude-code', via: 'default', exists: true }];

function planInput(candidates: readonly PlanCandidate[], over: Partial<PlanInput> = {}): PlanInput {
  const base: PlanInput = {
    candidates,
    importId: 'imp_20260921T120000Z_a1b2c3',
    at: '2026-09-21T12:00:00.000Z',
    jevcodeVersion: '0.3.0',
    workspace: '/ws',
    workspaceKey: '/ws',
    gitRoot: '/ws',
    trust: 'trust',
    roots: ROOTS,
  };
  return { ...base, ...over };
}

// ---------------------------------------------------------------------------------------
// §4.7.3 [G1.2] — slugOf
// ---------------------------------------------------------------------------------------

describe('§4.7.3 [G1.2] slugOf confines every destination name', () => {
  const seed = '/h/.cursor/rules/style.mdc';
  const hash = sha256Hex(seed).slice(0, 8);

  it('the four hostile names of §1 property 8', () => {
    expect(slugOf('../../.git/hooks/pre-commit', seed)).toBe('git-hooks-pre-commit');
    expect(slugOf('notes..md', seed)).toBe('notes-md');
    const long = slugOf('ünïcödé-'.repeat(50), seed);
    expect(long.length).toBeLessThanOrEqual(IMPORT_LIMITS.slugMaxChars);
    expect(slugOf('…／／…', seed)).toBe(hash);
  });

  it('no output can ever contain a separator, a dot segment or an empty name', () => {
    for (const name of ['../../etc/passwd', 'a/b/c', 'a\\b\\c', '.', '..', '', '   ', '!!!', '\u0000evil']) {
      const s = slugOf(name, seed);
      expect(s, name).not.toContain('/');
      expect(s, name).not.toContain('\\');
      expect(s, name).not.toContain('..');
      expect(s.length, name).toBeGreaterThan(0);
      expect(s.length, name).toBeLessThanOrEqual(IMPORT_LIMITS.slugMaxChars);
    }
  });

  it('§6 row 85 — the Windows device names and trailing dot/space are refused', () => {
    for (const name of ['CON', 'con', 'PRN.md', 'AUX', 'NUL', 'COM1', 'com9.txt', 'LPT1', 'lpt9']) expect(slugOf(name, seed), name).toBe(hash);
    expect(slugOf('notes.', seed)).toBe(hash);
    expect(slugOf('notes ', seed)).toBe(hash);
    // a device name as a *substring* is fine
    expect(slugOf('contacts', seed)).toBe('contacts');
  });

  it('the fallback is stable and depends only on the seed', () => {
    expect(slugOf('', seed)).toBe(slugOf('.', seed));
    expect(slugOf('', 'other-seed')).not.toBe(hash);
  });

  it('§6 row 85 — displayed paths normalise the separator', () => {
    expect(displayPath('C:\\Users\\x\\AGENTS.md')).toBe('C:/Users/x/AGENTS.md');
  });
});

// ---------------------------------------------------------------------------------------
// §2.5 — glob expansion and its budget (§6 row 62)
// ---------------------------------------------------------------------------------------

describe('§2.5 expandGlobs', () => {
  it('brace-expands, then caps at rulePatterns', () => {
    const one = expandGlobs(['src/**/*.{ts,tsx,js,jsx,mjs,cjs}']);
    expect(one.patterns).toEqual(['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.js', 'src/**/*.jsx', 'src/**/*.mjs', 'src/**/*.cjs']);
    expect(one.capped).toBe(false);
    const many = expandGlobs(Array.from({ length: 300 }, (_, i) => `p${i}/**`));
    expect(many.patterns).toHaveLength(IMPORT_LIMITS.rulePatterns);
    expect(many.capped).toBe(true);
  });

  it('dedupes, normalises separators and survives an unbalanced brace', () => {
    expect(expandGlobs(['a/**', 'a/**']).patterns).toEqual(['a/**']);
    expect(expandGlobs(['src\\**\\*.ts']).patterns).toEqual(['src/**/*.ts']);
    expect(expandGlobs(['src/{a,b']).patterns).toEqual(['src/{a,b']);
  });
});

// ---------------------------------------------------------------------------------------
// §4.5 passes 1–2 — dedupe (§6 rows 55, 56, 64)
// ---------------------------------------------------------------------------------------

describe('§4.5 dedupe', () => {
  it('pass 1 — identical normalised sha256 is one group, no Jev (§6 row 56)', () => {
    const out = dedupe([
      { id: 'a', sha256: 'same', bands: ['b1'], tokens: ['x'] },
      { id: 'b', sha256: 'same', bands: ['b1'], tokens: ['x'] },
      { id: 'c', sha256: 'other', bands: ['b2'], tokens: ['y'] },
    ]);
    expect(out.groups).toEqual([['a', 'b']]);
    expect(out.band).toEqual([]);
  });

  it('pass 2 — Jaccard ≥ 0.9 joins the group; [0.6, 0.9) is reported for Jev; < 0.6 is different', () => {
    const base = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const near = [...base.slice(0, 9), 'z']; // jaccard 9/11 ≈ 0.82 → band
    const same = [...base, 'z']; // jaccard 10/11 ≈ 0.91 → same
    const different = ['q', 'r', 's'];
    const out = dedupe([
      { id: 'A', sha256: '1', bands: ['B'], tokens: base },
      { id: 'N', sha256: '2', bands: ['B'], tokens: near },
      { id: 'S', sha256: '3', bands: ['B'], tokens: same },
      { id: 'D', sha256: '4', bands: ['B'], tokens: different },
    ]);
    expect(out.groups.some((g) => g.includes('A') && g.includes('S'))).toBe(true);
    expect(out.band.map((b) => `${b.a}~${b.b}`)).toContain('A~N');
    expect(out.band.some((b) => b.a === 'D' || b.b === 'D')).toBe(false);
  });

  it('only compares inside a minhash bucket, and caps the pair count [G1.6] (§6 row 64)', () => {
    const singles = Array.from({ length: 50 }, (_, i) => ({ id: `x${i}`, sha256: `s${i}`, bands: [`band${i}`], tokens: [`t${i}`] }));
    expect(dedupe(singles).pairs).toBe(0);
    const oneBucket = Array.from({ length: 50 }, (_, i) => ({ id: `y${i}`, sha256: `s${i}`, bands: ['same'], tokens: [`t${i}`] }));
    const capped = dedupe(oneBucket, 100);
    expect(capped.pairs).toBe(100);
    expect(capped.capped).toBe(true);
  });

  it('jaccardOf is |A ∩ B| / |A ∪ B|', () => {
    expect(jaccardOf(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccardOf(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3, 10);
    expect(jaccardOf(new Set(), new Set())).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// §4.7.5 — the nine-cell re-run matrix, including the absent-destination cell [G1.3]
// ---------------------------------------------------------------------------------------

describe('§4.7.5 rerunAction — all nine cells', () => {
  const entry: ImportManifestEntry = {
    importId: 'imp_1',
    dest: 'AGENTS.md',
    sourceSha256: 's1',
    destSha256: 'd1',
    scope: 'project',
    at: '2026-09-21T12:00:00.000Z',
    by: 'tty',
  };
  const M = ['imp_1'];

  it('row 1 — entry, source unchanged, markers present, destination unchanged ⇒ skip:unchanged', () => {
    expect(rerunAction({ manifestEntry: entry, sourceSha256: 's1', destExists: true, destSha256: 'd1', markers: M, markerInteriorChanged: false }).action).toBe('skip:unchanged');
  });
  it('row 2 — source changed ⇒ update', () => {
    const r = rerunAction({ manifestEntry: entry, sourceSha256: 's2', destExists: true, destSha256: 'd1', markers: M, markerInteriorChanged: false });
    expect(r.action).toBe('update');
    expect(r.why).toBe('manifest entry exists, source sha256 changed');
  });
  it('row 3 — destination changed OUTSIDE the block ⇒ skip:unchanged', () => {
    expect(rerunAction({ manifestEntry: entry, sourceSha256: 's1', destExists: true, destSha256: 'd2', markers: M, markerInteriorChanged: false }).action).toBe('skip:unchanged');
  });
  it('row 4 — destination changed INSIDE the block ⇒ review', () => {
    const r = rerunAction({ manifestEntry: entry, sourceSha256: 's1', destExists: true, destSha256: 'd2', markers: M, markerInteriorChanged: true });
    expect(r.action).toBe('review');
    expect(r.why).toBe('the block was edited; nothing was written');
  });
  it('row 5 — the markers are gone ⇒ review (§6 row 67)', () => {
    const r = rerunAction({ manifestEntry: entry, sourceSha256: 's1', destExists: true, destSha256: 'd2', markers: [], markerInteriorChanged: false });
    expect(r.action).toBe('review');
    expect(r.why).toBe('the block was edited or removed; nothing was written');
  });
  it('row 6 [G1.3] — the destination is gone ⇒ create, not skip:unchanged', () => {
    const r = rerunAction({ manifestEntry: entry, sourceSha256: 's1', destExists: false, destSha256: null, markers: [], markerInteriorChanged: false });
    expect(r.action).toBe('create');
    expect(r.why).toContain('removed since imp_1');
  });
  it('row 7 — no entry but another import is already in the file ⇒ merge', () => {
    expect(rerunAction({ manifestEntry: null, sourceSha256: 's1', destExists: true, destSha256: 'd1', markers: ['imp_0'], markerInteriorChanged: false }).action).toBe('merge');
  });
  it('row 8 — no entry, no markers, the destination exists ⇒ append', () => {
    expect(rerunAction({ manifestEntry: null, sourceSha256: 's1', destExists: true, destSha256: 'd1', markers: [], markerInteriorChanged: false }).action).toBe('append');
  });
  it('row 9 — no entry, the destination is absent ⇒ create', () => {
    expect(rerunAction({ manifestEntry: null, sourceSha256: 's1', destExists: false, destSha256: null, markers: [], markerInteriorChanged: false }).action).toBe('create');
  });
});

// ---------------------------------------------------------------------------------------
// §6 rows 59–60 — the slug allocator
// ---------------------------------------------------------------------------------------

describe('§6 rows 59–60 the slug allocator', () => {
  it('a second source from a different tool gets -<tool>, a third gets -2', () => {
    const taken = new Map<string, { tool: SourceTool | undefined; n: number }>();
    expect(allocateSlug('test', 'claude-code', taken)).toBe('test');
    expect(allocateSlug('test', 'codex', taken)).toBe('test-codex');
    expect(allocateSlug('test', 'cursor', taken)).toBe('test-cursor');
    expect(allocateSlug('test', 'claude-code', taken)).toBe('test-2');
  });

  it('two sources from the same tool collide into -2, -3', () => {
    const taken = new Map<string, { tool: SourceTool | undefined; n: number }>();
    expect(allocateSlug('project-jevcode', 'claude-code', taken)).toBe('project-jevcode');
    expect(allocateSlug('project-jevcode', 'claude-code', taken)).toBe('project-jevcode-2');
    expect(allocateSlug('project-jevcode', 'claude-code', taken)).toBe('project-jevcode-3');
  });

  it('the allocator is visible in the plan (§6 row 59)', () => {
    const a = candidate({ item: item('/h/.claude/commands/test.md', { tools: ['claude-code'], scope: 'user' }), destination: { kind: 'command', scope: 'user' }, verdict: { ...okVerdict, class: 'command', rule: 8, why: 'rule 8' }, doc: doc('one body') });
    const b = candidate({ item: item('/h/.codex/prompts/test.md', { tools: ['codex'], scope: 'user' }), destination: { kind: 'command', scope: 'user' }, verdict: { ...okVerdict, class: 'command', rule: 8, why: 'rule 8' }, doc: doc('a wholly different body here') });
    const plan = buildPlan(planInput([a, b]));
    expect(plan.rows.map((r) => r.dest)).toEqual(['~/.config/jevcode/commands/test.md', '~/.config/jevcode/commands/test-codex.md']);
    for (const r of plan.rows) expect(r.source.tools.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------
// §4.6.1 — buildPlan
// ---------------------------------------------------------------------------------------

describe('buildPlan', () => {
  it('produces the §4.6.1 shape, with the destinations of §2.2', () => {
    const cands: PlanCandidate[] = [
      candidate({ item: item('/h/.claude/projects/-ws/memory/project-notes.md', { scope: 'project' }), doc: doc('# project notes\n\nuse the fast path') }),
      candidate({ item: item('/h/.claude/CLAUDE.md', { scope: 'user' }), destination: { kind: 'agents-append', scope: 'user' }, doc: doc('# user rules\n\nbe terse') }),
      candidate({ item: item('/ws/CLAUDE.local.md', { scope: 'project-local' }), destination: { kind: 'memory-local', scope: 'project-local' }, doc: doc('personal scratch') }),
      candidate({ item: item('/ws/.cursor/rules/style.mdc'), destination: { kind: 'rule', scope: 'project' }, verdict: { ...okVerdict, class: 'rule', rule: 7, p: 0.95, why: 'rule 7 (frontmatter globs)' }, frontmatter: fm({ globs: ['src/**/*.ts', 'test/**'] }), doc: doc('# style rules for typescript') }),
    ];
    const plan = buildPlan(planInput(cands));
    expect(plan.v).toBe(1);
    expect(plan.importId).toBe('imp_20260921T120000Z_a1b2c3');
    expect(plan.rows.map((r) => r.dest)).toEqual(['.jevcode/memory/project-notes.md', '~/.config/jevcode/AGENTS.md', '.jevcode/memory-local/claude-local.md', '.jevcode/rules/style.md']);
    expect(plan.rows.map((r) => r.action)).toEqual(['create', 'create', 'create', 'create']);
    expect(plan.rows.every((r) => /^[0-9a-f]{12}$/.test(r.id))).toBe(true);
    expect(new Set(plan.rows.map((r) => r.id)).size).toBe(4);
    expect(plan.budget.memoryMax).toBe(IMPORT_LIMITS.memoryDirBytes);
    expect(plan.jev).toEqual({ requests: 0, questions: 0, usd: 0, fallbacks: 0 });
  });

  it('carries a rule\u2019s trigger and pattern count in `why` (§1 property 11)', () => {
    const c = candidate({
      item: item('/ws/.cursor/rules/style.mdc'),
      destination: { kind: 'rule', scope: 'project' },
      verdict: { ...okVerdict, class: 'rule', rule: 7, why: 'rule 7 (frontmatter globs)' },
      frontmatter: fm({ globs: ['src/**/*.{ts,tsx}'] }),
      doc: doc('# style'),
    });
    const row = buildPlan(planInput([c])).rows[0];
    expect(row?.why).toBe('rule 7 (frontmatter globs) — trigger paths, 2 patterns');
    expect(ruleSpecOf(c).patterns).toEqual(['src/**/*.ts', 'src/**/*.tsx']);
  });

  it('clips over-cap bodies with the design\u2019s warning and a notice (§6 row 63)', () => {
    const c = candidate({
      item: item('/ws/.devin/rules/long.md', { bytes: 12_000 }),
      destination: { kind: 'rule', scope: 'project' },
      verdict: { ...okVerdict, class: 'rule', rule: 7, why: 'rule 7 (frontmatter trigger)' },
      frontmatter: fm({ trigger: 'always_on' }),
      doc: doc('# long rule'),
    });
    const plan = buildPlan(planInput([c]));
    expect(plan.rows[0]?.bytes).toBe(IMPORT_LIMITS.ruleBytes);
    expect(plan.rows[0]?.warnings).toEqual(['clipped 12,000 → 4,096 bytes']);
    expect(plan.notices.some((n) => n.startsWith('clip: /ws/.devin/rules/long.md clipped 12,000 → 4,096 bytes'))).toBe(true);
  });

  it('a named skip keeps its class and never reaches a destination', () => {
    const c = candidate({ item: item('/ws/data.csv'), verdict: { class: 'memory', skip: 'skip:unrelated', rule: 12, p: 0.45, band: true, why: 'rule 12 (no rule matched)' } });
    const row = buildPlan(planInput([c])).rows[0];
    expect(row).toMatchObject({ action: 'skip:unrelated', dest: null, bytes: 0, class: 'memory' });
  });

  it('--all promotes a rule-12 skip to review, and nothing else', () => {
    const c = candidate({ item: item('/ws/data.csv'), verdict: { class: 'memory', skip: 'skip:unrelated', rule: 12, p: 0.45, band: true, why: 'rule 12' } });
    const secret = candidate({ item: item('/ws/.env'), verdict: { class: 'secret', skip: 'skip:secret', rule: 3, p: 1, band: false, why: 'rule 3' } });
    const plan = buildPlan(planInput([c, secret], { all: true }));
    expect(plan.rows[0]?.action).toBe('review');
    expect(plan.rows[0]?.why).toContain('promoted by --all');
    expect(plan.rows[1]?.action).toBe('skip:secret');
  });

  it('one settings.json becomes several rows — §0 principle 5', () => {
    const keys = [
      classifyKey({ path: ['env', 'ANTHROPIC_API_KEY'], dotted: 'env.ANTHROPIC_API_KEY', value: 'x'.repeat(48) }),
      classifyKey({ path: ['permissions', 'allow', '0'], dotted: 'permissions.allow.0', value: 'Bash(ls)' }),
      classifyKey({ path: ['hooks', 'PreToolUse', '0', 'command'], dotted: 'hooks.PreToolUse.0.command', value: 'echo hi' }),
      classifyKey({ path: ['mcpServers', 'github', 'command'], dotted: 'mcpServers.github.command', value: 'npx' }),
    ];
    const c = candidate({
      item: item('/h/.claude/settings.json', { scope: 'user' }),
      verdict: { class: 'config', skip: null, rule: 1, p: 1, band: false, why: 'rule 1 (atlas claude.settings)' },
      destination: { kind: 'report-only', scope: 'user' },
      keys,
    });
    const plan = buildPlan(planInput([c]));
    expect(plan.rows.map((r) => `${r.class}:${r.action}`)).toEqual(['secret:skip:secret', 'config:suggest', 'config:skip:executable', 'mcp:create']);
    expect(plan.rows[0]?.why).toMatch(/sha256:[0-9a-f]{8}/);
    expect(plan.rows[0]?.dest).toBe(null);
    expect(plan.rows[1]?.dest).toBe(null);
    expect(plan.rows[3]?.dest).toBe('~/.config/jevcode/mcp.json');
    expect(new Set(plan.rows.map((r) => r.id)).size).toBe(4);
    // not one byte of a value anywhere in the plan
    expect(JSON.stringify(plan)).not.toContain('x'.repeat(20));
  });

  it('a band key with no Jev answer is a secret — the conservative side (§6 row 45)', () => {
    const keys = [classifyKey({ path: ['integration', 'clientId'], dotted: 'integration.clientId', value: 'a7f3b2c1d4e5f60718293a4b5c6d7e8f' })];
    expect(keys[0]?.band).toBe(true);
    const c = candidate({ item: item('/h/.cursor/mcp.json', { scope: 'user' }), verdict: { class: 'config', skip: null, rule: 1, p: 1, band: false, why: 'rule 1' }, keys });
    const plan = buildPlan(planInput([c], { jev: { answers: {}, requests: 0, questions: 0, usd: 0, fallbacks: 1, reason: 'not asked (--no-jev)' } }));
    expect(plan.rows[0]).toMatchObject({ class: 'secret', action: 'skip:secret' });
  });

  // review defect 5 — the facade numbers `secret_<i>` across the whole plan, so a per-file
  // counter reads file 2's key with file 1's answer. That can *demote* a real credential.
  describe('Jev is_secret answers are keyed plan-wide, not per file (review defect 5)', () => {
    // two files, one band key each, in plan order
    const bandKeys = (dotted: string, value: string) => [classifyKey({ path: dotted.split('.'), dotted, value })];
    function twoFiles(): PlanCandidate[] {
      const a = candidate({
        item: item('/h/.cursor/mcp.json', { scope: 'user' }),
        verdict: { class: 'config', skip: null, rule: 6, p: 1, band: false, why: 'rule 6' },
        keys: bandKeys('integration.clientId', 'a7f3b2c1d4e5f60718293a4b5c6d7e8f'),
      });
      const b = candidate({
        item: item('/h/.codex/config.toml', { scope: 'user' }),
        verdict: { class: 'config', skip: null, rule: 6, p: 1, band: false, why: 'rule 6' },
        keys: bandKeys('service.clientId', 'Zt4Qx9Lm2Vb7Nk1Pr6Ws3Yd8Hc5Jf0Ga'),
      });
      expect(a.keys?.[0]?.band, 'file 1 key is in the rule-8 band').toBe(true);
      expect(b.keys?.[0]?.band, 'file 2 key is in the rule-8 band').toBe(true);
      return [a, b];
    }
    const jevOf = (answers: Record<string, Answer>): NonNullable<PlanInput['jev']> => ({ answers, requests: 1, questions: 2, usd: 0.0001, fallbacks: 0 });

    it('secret_0 → file 1, secret_1 → file 2 — the second answer is not file 1’s again', () => {
      const plan = buildPlan(
        planInput(twoFiles(), { jev: jevOf({ secret_0: { type: 'noul', noul: 0.95 }, secret_1: { type: 'noul', noul: 0.05 } }) }),
      );
      const rows = plan.rows.filter((r) => r.class === 'secret');
      expect(rows.map((r) => r.source.display), 'only file 1 is a secret').toEqual(['/h/.cursor/mcp.json']);
      expect(rows[0]?.why).toContain('p=0.95');
    });

    it('with the answers flipped, the credential is file 2 — a per-file counter demotes it', () => {
      const plan = buildPlan(
        planInput(twoFiles(), { jev: jevOf({ secret_0: { type: 'noul', noul: 0.05 }, secret_1: { type: 'noul', noul: 0.95 } }) }),
      );
      const rows = plan.rows.filter((r) => r.class === 'secret');
      expect(rows.map((r) => r.source.display), 'only file 2 is a secret').toEqual(['/h/.codex/config.toml']);
      expect(rows[0]?.why).toContain('p=0.95');
    });

    it('a file with no band key does not consume a question id', () => {
      const [a, b] = twoFiles();
      const plain = candidate({
        item: item('/h/.claude/settings.json', { scope: 'user' }),
        verdict: { class: 'config', skip: null, rule: 6, p: 1, band: false, why: 'rule 6' },
        keys: [classifyKey({ path: ['model'], dotted: 'model', value: 'z-ai/glm-5.3-flash' })],
      });
      expect(plain.keys?.[0]?.band).toBe(false);
      const plan = buildPlan(
        planInput([a!, plain, b!], { jev: jevOf({ secret_0: { type: 'noul', noul: 0.05 }, secret_1: { type: 'noul', noul: 0.95 } }) }),
      );
      expect(plan.rows.filter((r) => r.class === 'secret').map((r) => r.source.display)).toEqual(['/h/.codex/config.toml']);
    });
  });

  it('exact duplicates become one row with the tools unioned (§6 rows 12, 56)', () => {
    const body = '# agents\n\nthe same text in five places';
    const cands = (['codex', 'opencode', 'copilot', 'cursor', 'claude-code'] as SourceTool[]).map((t) => candidate({ item: item(`/ws/${t}/AGENTS.md`, { tools: [t] }), doc: doc(body) }));
    const plan = buildPlan(planInput(cands));
    expect(plan.rows).toHaveLength(1);
    expect([...plan.rows[0]?.source.tools ?? []].sort()).toEqual(['claude-code', 'codex', 'copilot', 'cursor', 'opencode']);
  });

  it('an unresolved near-duplicate keeps both rows and groups them (§6 row 55)', () => {
    const shared = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
    const a = candidate({ item: item('/ws/a.md'), doc: doc(`${shared} lambda`, { bands: ['dupbucket'] }) });
    const b = candidate({ item: item('/ws/b.md'), doc: doc(`${shared} mu nu`, { bands: ['dupbucket'] }) });
    const plan = buildPlan(planInput([a, b], { jev: { answers: {}, requests: 0, questions: 0, usd: 0, fallbacks: 1, reason: 'not asked (--no-jev)' } }));
    expect(plan.rows).toHaveLength(2);
    expect(plan.rows.every((r) => r.group === 'dup-1')).toBe(true);
    expect(plan.rows.every((r) => r.action === 'review')).toBe(true);
  });

  it('Jev resolving a near-duplicate as the same thing folds the two into one row', () => {
    const shared = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
    const a = candidate({ item: item('/ws/a.md', { tools: ['claude-code'] }), doc: doc(`${shared} lambda`, { bands: ['dupbucket'] }) });
    const b = candidate({ item: item('/ws/b.md', { tools: ['codex'] }), doc: doc(`${shared} mu nu`, { bands: ['dupbucket'] }) });
    const answers: Record<string, Answer> = { same_meaning_0: { type: 'noul', noul: 0.84 } };
    const plan = buildPlan(planInput([a, b], { jev: { answers, requests: 1, questions: 1, usd: 0.0001, fallbacks: 0 } }));
    expect(plan.rows).toHaveLength(1);
    expect([...plan.rows[0]?.source.tools ?? []].sort()).toEqual(['claude-code', 'codex']);
  });

  // review, lower — `findConflicts` was an unbucketed O(n²) pass that truncated at `dedupePairs`
  // with no notice at all, so a large plan silently stopped looking for conflicts
  describe('§4.5 pass 3 is bucketed, and says so when it truncates (review, lower)', () => {
    const verdictsOf = (cs: readonly PlanCandidate[]) => new Map(cs.map((c) => [c.item.id, okVerdict] as const));

    it('candidates with no opposed noun in common are never compared at all', () => {
      const many = Array.from({ length: 200 }, (_, i) =>
        candidate({ item: item(`/ws/n${i}.md`), doc: doc(`always use widget${i} in this project`, { bands: [`band${i}`] }) }),
      );
      const out = findConflicts(many, verdictsOf(many), []);
      expect(out.pairs, 'an all-pairs pass would be 19,900').toBe(0);
      expect(out.conflicts).toEqual([]);
      expect(out.capped).toBe(false);
    });

    it('the pair count is capped, and the cap is reported rather than swallowed', () => {
      const many = Array.from({ length: 12 }, (_, i) =>
        candidate({ item: item(`/ws/c${i}.md`), doc: doc(`always use the patch here.\nnever use the patch there. filler${i}`, { bands: [`band${i}`] }) }),
      );
      const out = findConflicts(many, verdictsOf(many), [], 10);
      expect(out.pairs).toBe(10);
      expect(out.capped).toBe(true);
    });

    it('buildPlan turns the truncation into a notice, in the dedupe pass’s style', () => {
      // 201 candidates that all share the opposed noun "patch" ⇒ 20 100 distinct pairs, over the
      // 20 000 cap; their Jaccard is far below 0.3, so none of them is an actual conflict
      const n = 201;
      const many = Array.from({ length: n }, (_, i) => {
        const filler = Array.from({ length: 24 }, (_, k) => `w${i}x${k}`).join(' ');
        return candidate({
          item: item(`/ws/big${i}.md`),
          doc: doc(`always use the patch. never use the patch. ${filler}`, { bands: [`band${i}`] }),
        });
      });
      const out = findConflicts(many, verdictsOf(many), []);
      expect(out.capped).toBe(true);
      expect(out.conflicts).toEqual([]);
      const plan = buildPlan(planInput(many));
      expect(plan.notices).toContain(`conflict scan capped at 20,000 pairs (${n} candidates)`);
    });
  });

  it('opposed polarity on a shared noun groups two rows for review (§6 row 57)', () => {
    const a = candidate({ item: item('/h/.claude/CLAUDE.md'), doc: doc('# rules for patching\n\nalways explain before patching the code in this repository') });
    const b = candidate({ item: item('/h/.codex/AGENTS.md'), doc: doc('# rules for patching\n\nnever write prose before a patch of the code in this repository') });
    const found = findConflicts([a, b], new Map([[a.item.id, okVerdict], [b.item.id, okVerdict]]), []);
    expect(found.conflicts).toHaveLength(1);
    expect(found.conflicts[0]?.noun).toBe('patch');
    const plan = buildPlan(planInput([a, b]));
    expect(plan.rows.every((r) => r.action === 'review')).toBe(true);
    expect(plan.rows.every((r) => r.group === 'conflict-1')).toBe(true);
    expect(plan.rows[0]?.why).toContain('conflict: opposed polarity on "patch"');
  });

  it('§4.4.3 group II — a Jev answer overrides a banded file rule, and the fallback names the reason', () => {
    const banded: FileVerdict = { class: 'memory', skip: 'skip:unrelated', rule: 12, p: 0.45, band: true, why: 'rule 12 (no rule matched)' };
    const c = candidate({ item: item('/ws/notes.md'), verdict: banded, doc: doc('a plain note about the build') });
    const answers: Record<string, Answer> = {
      kind_0: { type: 'choice', choice: 'instructions_for_an_agent', probabilities: { instructions_for_an_agent: 0.82 }, confidence: 0.82 },
      can_instructions_for_an_agent_0: { type: 'noul', noul: 0.71 },
    };
    const withJev = buildPlan(planInput([c], { jev: { answers, requests: 1, questions: 6, usd: 0.0003, fallbacks: 0 } }));
    expect(withJev.rows[0]).toMatchObject({ action: 'create', class: 'memory' });
    expect(withJev.rows[0]?.why).toBe('jev kind_0 instructions_for_an_agent p=0.82 can_=0.71');

    const without = buildPlan(planInput([c], { jev: { answers: {}, requests: 0, questions: 0, usd: 0, fallbacks: 1, reason: '--no-jev' } }));
    expect(without.rows[0]?.action).toBe('skip:unrelated');
    expect(without.rows[0]?.why).toBe('rule 12 (no rule matched) (code fallback; jev unavailable: --no-jev)');
  });

  it('the re-run matrix drives the action from the manifest and the destination state (§6 row 65)', () => {
    const c = candidate({ item: item('/h/.claude/projects/-ws/memory/project-notes.md'), doc: doc('# notes') });
    const dest = '.jevcode/memory/project-notes.md';
    const entry: ImportManifestEntry = { importId: 'imp_0', dest, sourceSha256: c.item.sha256, destSha256: 'dd', scope: 'project', at: '2026-09-20T00:00:00.000Z', by: 'tty' };
    const manifest: ImportManifest = { v: 1, user: [], workspaces: { '/ws': [entry] } };
    const unchanged = buildPlan(planInput([c], { manifest, destState: { [dest]: { sha256: 'dd', markers: ['imp_0'] } } }));
    expect(unchanged.rows[0]).toMatchObject({ action: 'skip:unchanged', bytes: 0 });

    const removed = buildPlan(planInput([c], { manifest, destState: {} }));
    expect(removed.rows[0]?.action).toBe('create');
    expect(removed.notices.some((n) => n.includes('removed since imp_0'))).toBe(true);

    // [G1.3] the manifest is keyed by workspace: a second clone of the same repo is a full create
    const clone: ImportManifest = { v: 1, user: [], workspaces: { '/other': [entry] } };
    expect(buildPlan(planInput([c], { manifest: clone, destState: {} })).rows[0]?.action).toBe('create');
  });

  it('a discrete destination that no import wrote is never overwritten', () => {
    const c = candidate({ item: item('/h/.claude/memory/notes.md'), doc: doc('# notes') });
    const plan = buildPlan(planInput([c], { destState: { '.jevcode/memory/notes.md': { sha256: 'zz', markers: [] } } }));
    expect(plan.rows[0]?.action).toBe('review');
    expect(plan.rows[0]?.why).toContain('no import wrote it');
  });

  it('§4.9 — an untrusted workspace skips project rows and keeps user rows', () => {
    const project = candidate({ item: item('/ws/AGENTS.md', { scope: 'project' }), destination: { kind: 'agents-append', scope: 'project' }, doc: doc('# project') });
    const user = candidate({ item: item('/h/.claude/CLAUDE.md', { scope: 'user' }), destination: { kind: 'agents-append', scope: 'user' }, doc: doc('# user rules here') });
    const plan = buildPlan(planInput([project, user], { trust: 'none' }));
    expect(plan.rows[0]?.action).toBe('skip:untrusted');
    expect(plan.rows[1]?.action).toBe('create');
  });

  it('§6 rows 83–84 — project scope unavailable carries its reason', () => {
    const project = candidate({ item: item('/ws/AGENTS.md', { scope: 'project' }), destination: { kind: 'agents-append', scope: 'project' }, doc: doc('# project') });
    const noGit = buildPlan(planInput([project], { gitRoot: null, workspaceKey: '/ws' }));
    expect(noGit.rows[0]?.action).toBe('skip:untrusted');
    expect(noGit.notices).toContain('project scope unavailable (no git root)');
    const readOnly = buildPlan(planInput([project], { projectWritable: false }));
    expect(readOnly.notices).toContain('project scope unavailable (read-only)');
    const scoped = buildPlan(planInput([project], { gitRoot: null, scope: 'project' }));
    expect(scoped.notices.some((n) => n.startsWith('--scope=project:'))).toBe(true);
    expect(scoped.rows.every((r) => r.action.startsWith('skip:'))).toBe(true);
  });

  it('--scope=user leaves project rows in the plan but out of the applicable set', () => {
    const project = candidate({ item: item('/ws/AGENTS.md', { scope: 'project' }), destination: { kind: 'agents-append', scope: 'project' }, doc: doc('# project') });
    const user = candidate({ item: item('/h/.claude/CLAUDE.md', { scope: 'user' }), destination: { kind: 'agents-append', scope: 'user' }, doc: doc('# user rules here') });
    const plan = buildPlan(planInput([project, user], { scope: 'user' }));
    expect(plan.rows).toHaveLength(2);
    expect(plan.rows[0]?.action).toBe('skip:unrelated');
    expect(plan.rows[0]?.why).toContain('out of scope (--scope=user)');
    expect(plan.rows[1]?.action).toBe('create');
  });

  it('§6 row 61 — over the index budget nothing is dropped, only moved on demand', () => {
    const cands = Array.from({ length: 210 }, (_, i) =>
      candidate({ item: item(`/h/.claude/memory/n${i}.md`, { bytes: 200 }), doc: doc(`# note ${i}\n\nunique body ${i}`, { bands: [`b${i}`] }) }),
    );
    const plan = buildPlan(planInput(cands));
    expect(plan.rows).toHaveLength(210);
    expect(plan.rows.every((r) => r.dest !== null && r.action === 'create')).toBe(true);
    expect(plan.budget.indexLines).toBe(IMPORT_LIMITS.memoryIndexLines);
    expect(plan.budget.indexMax).toBe(IMPORT_LIMITS.memoryIndexLines);
    expect(plan.notices).toContain('210 notes → 200 indexed, 10 on demand (512 KiB budget)');
  });

  it('caps the plan at planRows with a notice', () => {
    const cands = Array.from({ length: IMPORT_LIMITS.planRows + 5 }, (_, i) => candidate({ item: item(`/ws/x${i}.md`), verdict: { ...okVerdict, skip: 'skip:unrelated' } }));
    const plan = buildPlan(planInput(cands));
    expect(plan.rows).toHaveLength(IMPORT_LIMITS.planRows);
    expect(plan.notices.some((n) => n.startsWith('plan capped at 2,000 rows'))).toBe(true);
  });

  it('passes notices, cannotRead, roots and the jev block straight through', () => {
    const plan = buildPlan(
      planInput([], {
        notices: ['walk: ~/.claude/projects stopped at 20,000 entries (3 rows may be missing)'],
        cannotRead: [{ what: 'Cursor User Rules', why: 'stored on your Cursor account', paste: '/memory add' }],
        jev: { answers: {}, requests: 1, questions: 70, usd: 0.0003, fallbacks: 6, reason: 'HTTP 429' },
      }),
    );
    expect(plan.notices[0]).toContain('20,000 entries');
    expect(plan.cannotRead).toHaveLength(1);
    expect(plan.roots).toEqual(ROOTS);
    expect(plan.jev).toEqual({ requests: 1, questions: 70, usd: 0.0003, fallbacks: 6, reason: 'HTTP 429' });
  });
});

// ---------------------------------------------------------------------------------------
// §4.4.3 group IV — rankIndex
// ---------------------------------------------------------------------------------------

describe('§4.4.3 group IV rankIndex', () => {
  function row(over: Partial<PlanRow> & { id: string }): PlanRow {
    const base: PlanRow = {
      id: over.id,
      source: { id: over.id, display: `${over.id}.md`, tools: ['claude-code'], sha256: 'a'.repeat(64), bytes: 100, mtimeMs: 1 },
      class: 'memory',
      dest: `.jevcode/memory/${over.id}.md`,
      action: 'create',
      scope: 'project',
      bytes: 100,
      why: '',
      warnings: [],
    };
    return { ...base, ...over };
  }

  it('the code order is scope → class → modified desc → bytes asc', () => {
    const rows = [
      row({ id: 'u', scope: 'user' }),
      row({ id: 'pl', scope: 'project-local' }),
      row({ id: 'p1', scope: 'project', source: { id: 'p1', display: 'p1', tools: [], sha256: '', bytes: 0, mtimeMs: 10 } }),
      row({ id: 'p2', scope: 'project', source: { id: 'p2', display: 'p2', tools: [], sha256: '', bytes: 0, mtimeMs: 99 } }),
    ];
    expect(rankIndex(rows).map((r) => r.id)).toEqual(['p2', 'p1', 'pl', 'u']);
  });

  it('a Jev Score level leads the order, ties falling back to the code order', () => {
    const rows = [row({ id: 'a', scope: 'project' }), row({ id: 'b', scope: 'user' })];
    expect(rankIndex(rows, { a: 4, b: 0 }).map((r) => r.id)).toEqual(['b', 'a']);
    expect(rankIndex(rows, {}).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('is stable and total — every row comes back exactly once', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ id: `r${i}` }));
    expect(rankIndex(rows).map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
  });
});

// ---------------------------------------------------------------------------------------
// §2.5 — the trigger table
// ---------------------------------------------------------------------------------------

describe('§2.5 ruleSpecOf', () => {
  const cases: [Record<string, FrontmatterValue>, string, number][] = [
    [{ alwaysApply: true }, 'always', 1],
    [{ globs: ['src/**'] }, 'paths', 1],
    [{ description: 'only when asked' }, 'always', 1],
    [{ paths: ['a/**', 'b/**'] }, 'paths', 2],
    [{ trigger: 'always_on' }, 'always', 1],
    [{ trigger: 'glob', globs: ['x/**'] }, 'paths', 1],
    [{ trigger: 'model_decision' }, 'manual', 0],
    [{ applyTo: '**/*.ts,**/*.tsx' }, 'paths', 2],
  ];
  it('maps every source spelling of §2.5', () => {
    for (const [values, trigger, count] of cases) {
      const c = candidate({ item: item('/ws/.cursor/rules/r.mdc'), frontmatter: fm(values) });
      const spec = ruleSpecOf(c);
      expect(spec.trigger, JSON.stringify(values)).toBe(trigger);
      expect(spec.patterns.length, JSON.stringify(values)).toBe(count);
    }
  });
});

// ---------------------------------------------------------------------------------------
// typing guard — the destination kinds are exhaustive
// ---------------------------------------------------------------------------------------

describe('§2.2 every destination kind lands somewhere', () => {
  const kinds: DestinationSpec['kind'][] = ['agents-append', 'memory-topic', 'memory-local', 'memory-index', 'rule', 'command', 'mcp', 'report-only'];
  it('each one produces a destination (or a deliberate null)', () => {
    for (const kind of kinds) {
      for (const scope of ['user', 'project', 'project-local'] as const) {
        const sourceScope: SourceScope = scope;
        const c = candidate({ item: item(`/ws/${kind}.md`, { scope: sourceScope }), destination: { kind, scope }, doc: doc(`# ${kind} ${scope}`) });
        const row = buildPlan(planInput([c])).rows[0];
        expect(row, `${kind}/${scope}`).toBeDefined();
        if (kind === 'report-only') expect(row?.dest).toBe(null);
        else {
          expect(row?.dest, `${kind}/${scope}`).not.toBe(null);
          expect(row?.dest ?? '', `${kind}/${scope}`).not.toContain('..');
        }
      }
    }
  });
});
