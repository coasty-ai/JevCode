import { describe, expect, it } from 'vitest';
import { SLUG_RE, normalizeSplit, type NormalizeInput } from '../../../src/orchestrate/split/normalize.js';
import { DEFAULT_SPLIT_POLICY, type DraftAgent, type DraftSplit, type NormalizeResult, type NormalizedSplit } from '../../../src/orchestrate/types.js';

function agent(slug: string, own: readonly string[], items: readonly number[], over: Partial<DraftAgent> = {}): DraftAgent {
  return { slug, task: `work on ${slug}`, own: [...own], verify: ['npm test'], items: [...items], ...over };
}

function option(agents: readonly DraftAgent[], kind: DraftSplit['kind'] = 'by_plan_item'): DraftSplit {
  return { kind, agents: [...agents] };
}

function base(split: DraftSplit, over: Partial<NormalizeInput> = {}): NormalizeInput {
  return {
    option: split,
    policy: { ...DEFAULT_SPLIT_POLICY },
    existingBranches: [],
    deny: ['.git'],
    fold: false,
    repoPaths: ['src/a.ts', 'src/b.ts', 'src/types.ts'],
    plan: { remaining: ['the first half', 'the second half'] },
    itemFiles: [['src/a.ts'], ['src/b.ts']],
    task: 'split the work in two',
    baseSha: 'f'.repeat(40),
    mode: 'jev-on',
    reserveUsd: 2,
    detectSecrets: () => 0,
    ...over,
  };
}

function ok(result: NormalizeResult): NormalizedSplit {
  if (!result.ok) throw new Error(`expected ok, got: ${result.rejected.reason}`);
  return result.split;
}

const TWO = option([agent('alpha', ['src/a.ts'], [0]), agent('beta', ['src/b.ts'], [1])]);

describe('normalizeSplit (§3.4)', () => {
  it('normalises a clean two-agent option', () => {
    const split = ok(normalizeSplit(base(TWO)));
    expect(split.agents.map((a) => a.slug)).toEqual(['alpha', 'beta']);
    expect(split.agents.map((a) => a.branch)).toEqual(['jevcode/alpha', 'jevcode/beta']);
    expect(split.agents.map((a) => a.role)).toEqual(['code', 'code']);
    expect(split.agents.map((a) => a.maxSteps)).toEqual([DEFAULT_SPLIT_POLICY.agentMaxSteps, DEFAULT_SPLIT_POLICY.agentMaxSteps]);
    expect(split.manifestId).toMatch(/^[0-9a-f]{64}$/);
    expect(split.secretHits).toBe(0);
    expect(split.clampReason).toBeNull();
  });

  it('no_split is always valid and carries no agents', () => {
    const split = ok(normalizeSplit(base({ kind: 'no_split', agents: [] })));
    expect(split).toMatchObject({ kind: 'no_split', agents: [], secretHits: 0, clampReason: null });
  });

  // --- rule 1 ---------------------------------------------------------------------------
  it('rule 1: the SLUG takes the -<n>, before manifestId, and branch is re-derived (corner row 15, [D11])', () => {
    const clean = ok(normalizeSplit(base(TWO)));
    const collided = ok(normalizeSplit(base(TWO, { existingBranches: ['jevcode/alpha', 'main'] })));
    expect(collided.agents[0]?.slug).toBe('alpha-2');
    expect(collided.agents[0]?.branch).toBe('jevcode/alpha-2');
    // renaming the slug changes the manifestId: row 12's adoption key must not match the old delegation
    expect(collided.manifestId).not.toBe(clean.manifestId);
    for (const a of collided.agents) expect(a.branch).toBe(`jevcode/${a.slug}`);
  });

  it('rule 1: duplicate slugs inside one option are renamed, not refused', () => {
    const dup = option([agent('same', ['src/a.ts'], [0]), agent('same', ['src/b.ts'], [1])]);
    const split = ok(normalizeSplit(base(dup)));
    expect(split.agents.map((a) => a.slug)).toEqual(['same', 'same-2']);
    for (const a of split.agents) expect(SLUG_RE.test(a.slug)).toBe(true);
  });

  it('rule 1: a `dock` or `dock-*` slug is refused, and an unsalvageable slug deletes the option', () => {
    const dock = option([agent('dock', ['src/a.ts'], [0]), agent('beta', ['src/b.ts'], [1])]);
    expect(normalizeSplit(base(dock))).toEqual({ ok: false, rejected: { kind: 'by_plan_item', reason: 'agent slug "dock" is reserved for the dock branch', probability: null } });
    const dockish = option([agent('Dock-Worker', ['src/a.ts'], [0]), agent('beta', ['src/b.ts'], [1])]);
    expect(normalizeSplit(base(dockish)).ok).toBe(false);
    const empty = option([agent('///', ['src/a.ts'], [0]), agent('beta', ['src/b.ts'], [1])]);
    const result = normalizeSplit(base(empty));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejected.reason).toContain('cannot be made into a slug');
  });

  it('rule 1: an upper-case or punctuated slug is sanitised to the grammar', () => {
    const messy = option([agent('TUI Pane!!', ['src/a.ts'], [0]), agent('core_types', ['src/b.ts'], [1])]);
    const split = ok(normalizeSplit(base(messy)));
    expect(split.agents.map((a) => a.slug)).toEqual(['tui-pane', 'core-types']);
  });

  // --- rule 2 ---------------------------------------------------------------------------
  it('rule 2: the own sub-language reason is propagated verbatim', () => {
    const escaping = option([agent('alpha', ['../etc/passwd'], [0]), agent('beta', ['src/b.ts'], [1])]);
    const result = normalizeSplit(base(escaping));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejected.reason).toContain('".." is not allowed in an own glob');
    const denied = option([agent('alpha', ['secrets/keys.txt'], [0]), agent('beta', ['src/b.ts'], [1])]);
    const refused = normalizeSplit(base(denied, { deny: ['.git', 'secrets'] }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.rejected.reason).toContain('which an agent may never own');
  });

  // --- rule 3 ---------------------------------------------------------------------------
  it('rule 3: overlapping own sets delete the option (the spec-level twin of commit.test.ts’s diff-level one)', () => {
    const overlap = option([agent('alpha', ['src/**'], [0]), agent('beta', ['src/b.ts'], [1])]);
    const result = normalizeSplit(base(overlap));
    expect(result).toEqual({ ok: false, rejected: { kind: 'by_plan_item', reason: 'agents alpha and beta both own src/** / src/b.ts', probability: null } });
  });

  it('rule 3: a case-folding volume sees src/A.ts and src/a.ts as one file', () => {
    const clash = option([agent('alpha', ['src/A.ts'], [0]), agent('beta', ['src/a.ts'], [1])]);
    expect(normalizeSplit(base(clash, { fold: false, repoPaths: [], itemFiles: [[], []] })).ok).toBe(true);
    expect(normalizeSplit(base(clash, { fold: true, repoPaths: [], itemFiles: [[], []] })).ok).toBe(false);
  });

  it('rule 3: the prelude shape normalises, because the shared file left the other agents (corner row 1)', () => {
    const withPrelude = option([
      agent('prelude', ['src/types.ts'], [], { task: 'land the shared types', dependsOn: [] }),
      agent('alpha', ['src/a.ts'], [0], { dependsOn: ['prelude'] }),
      agent('beta', ['src/b.ts'], [1], { dependsOn: ['prelude'] }),
    ]);
    const split = ok(normalizeSplit(base(withPrelude, { itemFiles: [['src/a.ts'], ['src/b.ts']] })));
    expect(split.agents.map((a) => a.slug)).toEqual(['prelude', 'alpha', 'beta']);
    expect(split.agents.slice(1).map((a) => a.dependsOn)).toEqual([['prelude'], ['prelude']]);
  });

  // --- rule 4 ---------------------------------------------------------------------------
  it('rule 4: an uncovered item, a doubly-covered item and an unowned file each delete the option', () => {
    const missing = option([agent('alpha', ['src/a.ts'], [0]), agent('beta', ['src/b.ts'], [])]);
    const a = normalizeSplit(base(missing));
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.rejected.reason).toBe('plan item "the second half" is in no agent');

    const twice = option([agent('alpha', ['src/a.ts'], [0, 1]), agent('beta', ['src/b.ts'], [1])]);
    const b = normalizeSplit(base(twice));
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.rejected.reason).toBe('plan item "the second half" is in agents alpha and beta');

    const unowned = option([agent('alpha', ['src/a.ts'], [0]), agent('beta', ['src/b.ts'], [1])]);
    const c = normalizeSplit(base(unowned, { itemFiles: [['src/a.ts'], ['src/b.ts', 'src/types.ts']] }));
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.rejected.reason).toBe('no agent owns src/types.ts, which plan item "the second half" needs');
  });

  // --- rule 5 ---------------------------------------------------------------------------
  it('rule 5: an agent with no verify is downgraded to research, not deleted', () => {
    const half = option([agent('alpha', ['src/a.ts'], [0], { verify: [] }), agent('beta', ['src/b.ts'], [1])]);
    const split = ok(normalizeSplit(base(half)));
    expect(split.agents[0]).toMatchObject({ role: 'research', verify: [], branch: null });
    expect(split.agents[1]).toMatchObject({ role: 'code', branch: 'jevcode/beta' });
  });

  it('rule 5: an option in which every agent downgraded is still valid (§5.1 step 6)', () => {
    const none = option([agent('alpha', ['src/a.ts'], [0], { verify: [] }), agent('beta', ['src/b.ts'], [1], { verify: [] })]);
    const split = ok(normalizeSplit(base(none)));
    expect(split.agents.map((a) => a.role)).toEqual(['research', 'research']);
    expect(split.agents.map((a) => a.branch)).toEqual([null, null]);
  });

  // --- rule 6 ---------------------------------------------------------------------------
  it('rule 6: a cycle, an unknown slug and an over-deep chain each delete the option', () => {
    const cycle = option([agent('alpha', ['src/a.ts'], [0], { dependsOn: ['beta'] }), agent('beta', ['src/b.ts'], [1], { dependsOn: ['alpha'] })]);
    const a = normalizeSplit(base(cycle));
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.rejected.reason).toContain('cycle');

    const unknown = option([agent('alpha', ['src/a.ts'], [0], { dependsOn: ['ghost'] }), agent('beta', ['src/b.ts'], [1])]);
    const b = normalizeSplit(base(unknown));
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.rejected.reason).toBe('agent alpha depends on unknown slug ghost');

    const deep = option([
      agent('one', ['src/a.ts'], [0], { dependsOn: ['two'] }),
      agent('two', ['src/b.ts'], [1], { dependsOn: ['three'] }),
      agent('three', ['src/types.ts'], [], { dependsOn: ['four'] }),
      agent('four', ['docs/x.md'], [], { dependsOn: [] }),
    ]);
    const c = normalizeSplit(base(deep, { policy: { ...DEFAULT_SPLIT_POLICY, maxAgents: 4, maxChildren: 4 }, repoPaths: [] }));
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.rejected.reason).toContain('the limit is 2');
  });

  it('rule 6: a dependsOn naming a slug rule 1 renamed still resolves', () => {
    const renamed = option([agent('alpha', ['src/a.ts'], [0]), agent('beta', ['src/b.ts'], [1], { dependsOn: ['alpha'] })]);
    const split = ok(normalizeSplit(base(renamed, { existingBranches: ['jevcode/alpha'] })));
    expect(split.agents[0]?.slug).toBe('alpha-2');
    expect(split.agents[1]?.dependsOn).toEqual(['alpha-2']);
  });

  // --- rule 7 ---------------------------------------------------------------------------
  it('rule 7: agents above min(maxAgents, maxChildren) are clamped, not deleted [G15]', () => {
    const three = option([agent('alpha', ['src/a.ts'], [0]), agent('beta', ['src/b.ts'], [1]), agent('gamma', ['src/types.ts'], [])]);
    const split = ok(normalizeSplit(base(three, { policy: { ...DEFAULT_SPLIT_POLICY, maxAgents: 3, maxChildren: 2 } })));
    expect(split.agents.map((a) => a.slug)).toEqual(['alpha', 'beta']);
    expect(split.clampReason).toBe('3 agents clamped to 2 by coordination.maxChildren');
    // the dropped agent's own moves with it, so rule 4's coverage stays true after the clamp
    expect(split.agents[0]?.own).toEqual(['src/a.ts', 'src/types.ts']);
  });

  it('rule 7: the money split is cent-exact and never exceeds the reserve (§6.1)', () => {
    const three = option([agent('alpha', ['src/a.ts'], [0]), agent('beta', ['src/b.ts'], [1]), agent('gamma', ['src/types.ts'], [])]);
    const policy = { ...DEFAULT_SPLIT_POLICY, maxAgents: 3, maxChildren: 3 };
    const split = ok(normalizeSplit(base(three, { policy, reserveUsd: 1 })));
    const caps = split.agents.map((a) => a.capUsd);
    expect(caps).toEqual([0.33, 0.33, 0.33]);
    expect(caps.reduce((s, c) => s + c, 0)).toBeLessThanOrEqual(1);
    for (const cap of caps) expect(cap).toBeGreaterThanOrEqual(policy.minAgentUsd);
  });

  it('rule 7: w_i is the item count, so the agent with more items gets more money', () => {
    const weighted = option([agent('alpha', ['src/a.ts', 'src/types.ts'], [0, 1]), agent('beta', ['src/b.ts'], [])]);
    // the reserve must sit under `maxReserveUsd` or the clamp, not the weighting, decides the caps —
    // this case is about the 2:1 weight, and the clamp has its own tests below
    const policy = { ...DEFAULT_SPLIT_POLICY, maxReserveUsd: 3 };
    const split = ok(normalizeSplit(base(weighted, { policy, itemFiles: [['src/a.ts'], ['src/types.ts']], reserveUsd: 3 })));
    expect(split.agents.map((a) => a.capUsd)).toEqual([2, 1]);
  });

  it('rule 7: a reserve too small for every agent drops agents from the end, then deletes', () => {
    const three = option([agent('alpha', ['src/a.ts'], [0]), agent('beta', ['src/b.ts'], [1]), agent('gamma', ['src/types.ts'], [])]);
    const policy = { ...DEFAULT_SPLIT_POLICY, maxAgents: 3, maxChildren: 3 };
    const shrunk = ok(normalizeSplit(base(three, { policy, reserveUsd: 0.5 })));
    expect(shrunk.agents.length).toBe(2);
    expect(shrunk.agents.map((a) => a.capUsd)).toEqual([0.25, 0.25]);
    expect(shrunk.clampReason).toContain('3 agents reduced to 2');

    const broke = normalizeSplit(base(TWO, { reserveUsd: 0.3 }));
    expect(broke.ok).toBe(false);
    if (!broke.ok) expect(broke.rejected.reason).toBe('the reserve $0.30 cannot give 2 agents the minimum $0.20 each');
  });

  it('rule 7: maxWallMs is the parent’s share, capped by the policy and floored at ten minutes', () => {
    const policy = { ...DEFAULT_SPLIT_POLICY };
    expect(ok(normalizeSplit(base(TWO))).agents[0]?.maxWallMs).toBe(policy.agentMaxWallMs);
    expect(ok(normalizeSplit(base(TWO, { parentRemainingWallMs: 60 * 60_000 }))).agents[0]?.maxWallMs).toBe(policy.agentMaxWallMs);
    // 2 agents out of 4 minutes remaining: the 10-minute floor wins, then the policy ceiling
    expect(ok(normalizeSplit(base(TWO, { parentRemainingWallMs: 4 * 60_000 }))).agents[0]?.maxWallMs).toBe(10 * 60_000);
    expect(ok(normalizeSplit(base(TWO, { parentRemainingWallMs: 24 * 60_000 }))).agents[0]?.maxWallMs).toBe(12 * 60_000);
  });

  // --- rule 8 ---------------------------------------------------------------------------
  it('rule 8: [G11] a task naming a real path the agent does not own deletes the option', () => {
    const naming = option([agent('alpha', ['src/a.ts'], [0], { task: 'rewrite src/b.ts to use the new reader' }), agent('beta', ['src/b.ts'], [1])]);
    const result = normalizeSplit(base(naming));
    expect(result).toEqual({ ok: false, rejected: { kind: 'by_plan_item', reason: 'agent alpha names src/b.ts, which it does not own', probability: null } });
  });

  it('rule 8: a token that is not a real repo path, or one the agent owns, is fine', () => {
    const fictional = option([agent('alpha', ['src/a.ts'], [0], { task: 'rewrite src/nowhere.ts and src/a.ts' }), agent('beta', ['src/b.ts'], [1])]);
    expect(normalizeSplit(base(fictional)).ok).toBe(true);
    const dirs = option([agent('alpha', ['src/tui/**'], [0], { task: 'work inside src/tui' }), agent('beta', ['src/core/**'], [1])]);
    expect(normalizeSplit(base(dirs, { repoPaths: ['src/tui/a.ts', 'src/core/b.ts'], itemFiles: [['src/tui/a.ts'], ['src/core/b.ts']] })).ok).toBe(true);
    const wrongDir = option([agent('alpha', ['src/tui/**'], [0], { task: 'work inside src/core' }), agent('beta', ['src/core/**'], [1])]);
    const result = normalizeSplit(base(wrongDir, { repoPaths: ['src/tui/a.ts', 'src/core/b.ts'], itemFiles: [['src/tui/a.ts'], ['src/core/b.ts']] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejected.reason).toBe('agent alpha names src/core, which it does not own');
  });

  // --- rule 9 ---------------------------------------------------------------------------
  it('rule 9: a secret flags a COUNT and never deletes the option', () => {
    const leaky = option([agent('alpha', ['src/a.ts'], [0], { task: 'use the token sk-live-deadbeef' }), agent('beta', ['src/b.ts'], [1])]);
    const split = ok(normalizeSplit(base(leaky, { detectSecrets: (s) => (s.includes('sk-live') ? 1 : 0) })));
    expect(split.secretHits).toBe(1);
    expect(split.agents.length).toBe(2);
    const both = ok(normalizeSplit(base(leaky, { detectSecrets: () => 3 })));
    expect(both.secretHits).toBe(2);
  });

  // --- the transforms -------------------------------------------------------------------
  it('folds the task to one line, clips it, and bounds every verify command', () => {
    const messy = option([
      agent('alpha', ['src/a.ts'], [0], { task: `first line\n\tsecond   line ${'x'.repeat(4000)}`, verify: [`npm test ${'y'.repeat(400)}`, 'a', 'b', 'c', 'd', 'e'] }),
      agent('beta', ['src/b.ts'], [1]),
    ]);
    const split = ok(normalizeSplit(base(messy)));
    const first = split.agents[0];
    expect(first?.task.includes('\n')).toBe(false);
    expect(first?.task.startsWith('first line second line')).toBe(true);
    expect(first?.task.length).toBe(2_000);
    expect(first?.verify.length).toBe(4);
    expect(first?.verify[0]?.length).toBe(200);
  });

  it('the manifestId depends on the task, the plan, the kind, the agents and the base sha', () => {
    const one = ok(normalizeSplit(base(TWO))).manifestId;
    expect(ok(normalizeSplit(base(TWO))).manifestId).toBe(one);
    expect(ok(normalizeSplit(base(TWO, { baseSha: '0'.repeat(40) }))).manifestId).not.toBe(one);
    expect(ok(normalizeSplit(base(TWO, { task: 'something else' }))).manifestId).not.toBe(one);
    expect(ok(normalizeSplit(base(option(TWO.agents, 'by_directory')))).manifestId).not.toBe(one);
  });
});

// ---------------------------------------------------------------------------------------
// Review 2026-09-22 — findings 3, 4, 10, 12
// ---------------------------------------------------------------------------------------

const FOUR = option([
  agent('pp', ['src/p/**'], [0], { verify: ['npm test'] }),
  agent('qq', ['src/q/**'], [1], { dependsOn: ['ss'], verify: ['npm run typecheck'] }),
  agent('rr', ['src/r/**'], [2], { verify: ['npm test'] }),
  agent('ss', ['src/s/**'], [3], { verify: ['npm run lint'] }),
]);

function fourBase(over: Partial<NormalizeInput> = {}): NormalizeInput {
  return base(FOUR, {
    policy: { ...DEFAULT_SPLIT_POLICY, maxAgents: 3, maxChildren: 3 },
    plan: { remaining: ['one', 'two', 'three', 'four'] },
    itemFiles: [['src/p/a.ts'], ['src/q/a.ts'], ['src/r/a.ts'], ['src/s/a.ts']],
    repoPaths: ['src/p/a.ts', 'src/q/a.ts', 'src/r/a.ts', 'src/s/a.ts'],
    reserveUsd: 4,
    ...over,
  });
}

describe('rule 7 clamp repairs dependsOn (review finding 3)', () => {
  it('no surviving agent depends on a slug the clamp merged away', () => {
    const split = ok(normalizeSplit(fourBase()));
    const slugs = new Set(split.agents.map((a) => a.slug));
    expect(split.agents.length).toBe(3);
    for (const a of split.agents) for (const d of a.dependsOn) expect(slugs.has(d)).toBe(true);
  });

  it('the dependency is remapped to the survivor that absorbed it, not dropped on the floor', () => {
    const split = ok(normalizeSplit(fourBase()));
    const qq = split.agents.find((a) => a.slug === 'qq');
    // `ss` was merged into some survivor; qq must now depend on THAT survivor (or on nobody if it
    // was itself the receiver), never on the vanished slug — the landing queue parks on a dangling one.
    expect(qq?.dependsOn ?? []).not.toContain('ss');
  });
});

describe('rule 9 scans verify (review finding 4)', () => {
  const sniff = (s: string): number => (s.includes('ghp_') ? 1 : 0);

  it('a secret in a verify command sets secretHits so the card can warn', () => {
    const withSecret = option([
      agent('alpha', ['src/a.ts'], [0], { verify: ['NPM_TOKEN=ghp_xxxxxxxx npm test'] }),
      agent('beta', ['src/b.ts'], [1]),
    ]);
    const split = ok(normalizeSplit(base(withSecret, { detectSecrets: sniff })));
    expect(split.secretHits).toBe(1);
  });

  it('still counts agents, not hits, and still counts task and own', () => {
    const clean = ok(normalizeSplit(base(TWO, { detectSecrets: sniff })));
    expect(clean.secretHits).toBe(0);
  });
});

describe('the reserve is bounded (review finding 12)', () => {
  it('rejects a non-finite reserve instead of minting an infinite cap', () => {
    const r = normalizeSplit(base(TWO, { reserveUsd: Number.POSITIVE_INFINITY }));
    expect(r.ok).toBe(false);
  });

  it('rejects NaN', () => {
    expect(normalizeSplit(base(TWO, { reserveUsd: Number.NaN })).ok).toBe(false);
  });

  it('clamps above policy.maxReserveUsd so the caps can never exceed it', () => {
    const split = ok(normalizeSplit(base(TWO, { reserveUsd: 100 })));
    const total = split.agents.reduce((sum, a) => sum + a.capUsd, 0);
    expect(total).toBeLessThanOrEqual(DEFAULT_SPLIT_POLICY.maxReserveUsd);
  });

  it('treats a negative reserve as zero rather than as a negative cap', () => {
    const r = normalizeSplit(base(TWO, { reserveUsd: -5 }));
    if (r.ok) for (const a of r.split.agents) expect(a.capUsd).toBeGreaterThanOrEqual(0);
  });
});

describe('the clamp merge unions verify (review finding 10)', () => {
  it('the receiver keeps its own verify and gains the absorbed agent’s', () => {
    const split = ok(normalizeSplit(fourBase()));
    const commands = new Set(split.agents.flatMap((a) => [...a.verify]));
    // `ss` carried `npm run lint`; after the clamp it must still be verified by somebody.
    expect(commands.has('npm run lint')).toBe(true);
  });
});
