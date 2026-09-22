/**
 * docs/ORCHESTRATION-DESIGN.md §2.4 (the three ownership belts and the [G8] hole in belt 2),
 * §2.5(a)/(b) and corner rows 18, 19, 24, 54, 55.
 *
 * Belt 2 is the risk stage: a child's `edit | write | patch` whose target lies outside
 * `EngineOptions.orchestration.own` is refused IN CODE — before any Jev request and before any
 * write — as `outcome = { status: 'blocked', reason: "outside this agent's ownership: …" }`.
 * Belt 2 does NOT cover `run`, which is [G8]: the post-`run` diff against `own` is recorded on
 * `StepRecord.escaped` and reported, never blocked ("blocking after the command ran would be
 * theatre"). Three consecutive belt-2 refusals park the child with `scope-fight` (row 18).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './fakes.js';
import { createFakeSandbox, createFakeWorkspace, execResult, makeEngine, turn } from './fakes.js';
import { OWNERSHIP_REFUSAL_PREFIX, RESEARCH_REFUSAL_PREFIX, SCOPE_FIGHT_AFTER, isOwnershipRefusal, ownershipRefusal } from '../../../src/loop/stages/risk.js';
import { PROPOSE_ACTION_TOOL, proposeActionToolFor } from '../../../src/provider/actions.js';
import { RESEARCH_ACTION_KINDS } from '../../../src/core/types.js';
import type { Action, ActionKind, OrchestrationOptions } from '../../../src/core/types.js';
import { escapedPaths } from '../../../src/loop/launch.js';
import { tempRepo } from '../orchestrate/helpers.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

const child = (over: Partial<OrchestrationOptions> = {}): OrchestrationOptions => ({ depth: 1, slug: 'tui-rows', own: ['src/tui/**'], ...over });

describe('§2.4 belt 2 — the own refusal, in code', () => {
  it('ownershipRefusal names the path and the slice, verbatim (§2.4 table)', () => {
    const r = ownershipRefusal({ kind: 'write', path: 'src/y.ts', content: 'x' }, child());
    expect(r).toEqual({ status: 'blocked', reason: "outside this agent's ownership: src/y.ts (owns src/tui/**)" });
    expect(isOwnershipRefusal(r!.reason)).toBe(true);
    expect(r!.reason.startsWith(OWNERSHIP_REFUSAL_PREFIX)).toBe(true);
  });

  it('a target INSIDE own is not refused, and a patch is checked per touched path', () => {
    expect(ownershipRefusal({ kind: 'edit', path: 'src/tui/Pane.tsx', old: 'a', new: 'b' }, child())).toBeNull();
    const diff = '--- a/src/tui/Pane.tsx\n+++ b/src/tui/Pane.tsx\n@@\n+x\n--- a/src/loop/engine.ts\n+++ b/src/loop/engine.ts\n@@\n+y\n';
    const r = ownershipRefusal({ kind: 'patch', diff }, child());
    expect(r?.reason).toBe("outside this agent's ownership: src/loop/engine.ts (owns src/tui/**)");
  });

  it('[G8] a `run` action yields no targets, so belt 2 never refuses one', () => {
    expect(ownershipRefusal({ kind: 'run', command: 'npm run format' }, child())).toBeNull();
    expect(ownershipRefusal({ kind: 'read', paths: ['src/y.ts'] }, child())).toBeNull();
  });

  it('depth 0 (a parent) and an absent orchestration refuse nothing at all', () => {
    expect(ownershipRefusal({ kind: 'write', path: 'src/y.ts', content: 'x' }, undefined)).toBeNull();
    expect(ownershipRefusal({ kind: 'write', path: 'src/y.ts', content: 'x' }, { depth: 0, own: ['src/tui/**'] })).toBeNull();
  });

  it('a child refuses the write in the engine: blocked outcome, counters.blocked, ZERO risk requests', async () => {
    const h = await build({
      turns: [turn({ kind: 'write', path: 'src/y.ts', content: 'x' }), turn({ kind: 'done', summary: 'stop' })],
      engine: { orchestration: child() },
    });
    const result = await h.engine.run();
    const s1 = h.store.steps[0]!;
    expect(s1.outcome).toEqual({ status: 'blocked', reason: "outside this agent's ownership: src/y.ts (owns src/tui/**)" });
    expect(result.counters.blocked).toBeGreaterThanOrEqual(1);
    // the refusal is code, so no Jev money is spent on the risk stage of that step
    expect(h.decider.callsAt('risk').filter((c) => c.step === 1)).toHaveLength(0);
    // and nothing was written
    expect(h.workspace.files.has('src/y.ts')).toBe(false);
  });

  it('corner row 18: three consecutive belt-2 refusals park the child with scope-fight', async () => {
    const h = await build({
      turns: () => turn({ kind: 'write', path: 'src/y.ts', content: 'x' }),
      engine: { orchestration: child() },
    });
    const result = await h.engine.run();
    expect(SCOPE_FIGHT_AFTER).toBe(3);
    expect(result.stopReason).toBe('human_pause');
    expect(result.steps).toBe(3);
    const stop = h.of('transcript').map((t) => t.text).join('\n');
    expect(stop).toContain('scope-fight');
  });

  it('a step INSIDE own resets the run of refusals (they must be consecutive)', async () => {
    const turns = [
      turn({ kind: 'write', path: 'src/y.ts', content: 'x' }),
      turn({ kind: 'write', path: 'src/y.ts', content: 'x' }),
      turn({ kind: 'write', path: 'src/tui/ok.ts', content: 'x' }),
      turn({ kind: 'write', path: 'src/y.ts', content: 'x' }),
      turn({ kind: 'done', summary: 'stop' }),
    ];
    const h = await build({ turns, engine: { orchestration: child() }, confirmer: { identity: 'reviewer', confirm: async () => true } });
    const result = await h.engine.run();
    expect(result.stopReason).not.toBe('human_pause');
  });
});

describe('§2.5(b) / corner row 24 — role research is read-only in code AND in the tool schema', () => {
  it('the action space is read | run | done', () => {
    expect([...RESEARCH_ACTION_KINDS]).toEqual(['read', 'run', 'done']);
  });

  it('a research agent may never write code (in code)', () => {
    const r = ownershipRefusal({ kind: 'write', path: 'src/tui/inside.ts', content: 'x' }, child({ role: 'research' }));
    expect(r?.status).toBe('blocked');
    expect(r?.reason.startsWith(RESEARCH_REFUSAL_PREFIX)).toBe(true);
    // even inside its own slice
    expect(ownershipRefusal({ kind: 'patch', diff: '+++ b/src/tui/x.ts\n' }, child({ role: 'research' }))?.status).toBe('blocked');
    expect(ownershipRefusal({ kind: 'read', paths: ['anything.ts'] }, child({ role: 'research' }))).toBeNull();
    expect(ownershipRefusal({ kind: 'run', command: 'rg foo' }, child({ role: 'research' }))).toBeNull();
  });

  it('the propose_action tool schema drops edit | write | patch (the model is never offered them)', () => {
    const tool = proposeActionToolFor(RESEARCH_ACTION_KINDS);
    const kindsOf = (t: typeof PROPOSE_ACTION_TOOL): string[] => {
      const schema = t.inputSchema as { properties: { action: { oneOf: { properties: { kind: { const: string } } }[] } } };
      return schema.properties.action.oneOf.map((v) => v.properties.kind.const);
    };
    expect(kindsOf(PROPOSE_ACTION_TOOL)).toEqual(['read', 'edit', 'write', 'patch', 'run', 'done']);
    expect(kindsOf(tool)).toEqual(['read', 'run', 'done']);
    expect(tool.name).toBe(PROPOSE_ACTION_TOOL.name);
  });

  it('the full kind list returns the shared constant unchanged (no behaviour change off the research path)', () => {
    const all: readonly ActionKind[] = ['read', 'edit', 'write', 'patch', 'run', 'done'];
    expect(proposeActionToolFor(all)).toBe(PROPOSE_ACTION_TOOL);
  });

  it('a research child sends the restricted schema to the generator', async () => {
    const h = await build({
      turns: [turn({ kind: 'read', paths: ['src/a.py'] }), turn({ kind: 'done', summary: 'facts' })],
      engine: { orchestration: child({ role: 'research' }) },
    });
    await h.engine.run();
    const req = h.provider.requests[0]!;
    const schema = req.tools![0]!.inputSchema as { properties: { action: { oneOf: { properties: { kind: { const: string } } }[] } } };
    expect(schema.properties.action.oneOf.map((v) => v.properties.kind.const)).toEqual(['read', 'run', 'done']);
  });
});

describe('[G8] the post-run escape diff — reported, never blocked', () => {
  it('corner row 19: a run that writes outside own is recorded on StepRecord.escaped and surfaced, and still EXECUTES', async () => {
    const ws = createFakeWorkspace({ root: '/ws' });
    // what the formatter rewrote: one file inside the slice, one outside it
    const wrote = ['package-lock.json', 'src/tui/Pane.tsx'];
    ws.changedFiles = async () => [...wrote];
    const h = await build({
      turns: [turn({ kind: 'run', command: 'npm run format' }), turn({ kind: 'done', summary: 'stop' })],
      sandbox: createFakeSandbox(() => execResult({ exitCode: 0, stdout: 'formatted' })),
      workspace: ws,
      engine: { orchestration: child() },
    });
    await h.engine.run();
    const s1 = h.store.steps[0]!;
    // NOT blocked: "blocking after the command ran would be theatre" (§2.4)
    expect(s1.outcome?.status).toBe('executed');
    expect(s1.escaped).toEqual(['package-lock.json']);
    expect(h.of('transcript').map((t) => t.text).join('\n')).toContain('outside its slice: package-lock.json');
  });

  it('nothing escapes when every changed path is inside own, and nothing at all without orchestration', async () => {
    const ws = createFakeWorkspace({ root: '/ws' });
    ws.changedFiles = async () => ['src/tui/Pane.tsx'];
    const h = await build({
      turns: [turn({ kind: 'run', command: 'npm run format' }), turn({ kind: 'done', summary: 'stop' })],
      sandbox: createFakeSandbox(() => execResult({ exitCode: 0, stdout: 'ok' })),
      workspace: ws,
      engine: { orchestration: child() },
    });
    await h.engine.run();
    expect(h.store.steps[0]!.escaped).toBeUndefined();

    const ws2 = createFakeWorkspace({ root: '/ws' });
    ws2.changedFiles = async () => ['package-lock.json'];
    const plain = await build({
      turns: [turn({ kind: 'run', command: 'npm run format' }), turn({ kind: 'done', summary: 'stop' })],
      sandbox: createFakeSandbox(() => execResult({ exitCode: 0, stdout: 'ok' })),
      workspace: ws2,
    });
    await plain.engine.run();
    expect(plain.store.steps[0]!.escaped).toBeUndefined();
  });

  it('escapedPaths subtracts the STILL-CARRIED subset, never the whole syncedDirty list [D2]', async () => {
    // corner row 55 at the diff level is asserted in engine-orchestration.test.ts; here the unit:
    // a synced-dirty path the agent REWROTE is not carried, so it IS reported.
    const { escapedPaths } = await import('../../../src/loop/launch.js');
    const out = await escapedPaths('/nowhere', { changed: ['package-lock.json', 'src/tui/Pane.tsx'], own: ['src/tui/**'], syncedDirty: [] });
    expect(out).toEqual(['package-lock.json']);
  });
});

describe('review 2026-09-22 finding 4 — belt 2 fails CLOSED on an empty or absent `own`', () => {
  const codeChild = (own?: readonly string[]): OrchestrationOptions => ({ depth: 1, role: 'code', ...(own === undefined ? {} : { own }) });

  it('a depth-1 `code` child with NO `own` refuses every write target', () => {
    // `OrchestrationOptions.own` is optional, so this is a reachable spawn, and it used to mean "owns everything".
    // Everywhere else in the design an absent or unparsable `own` owns NOTHING; belt 2 was the one place it inverted.
    for (const action of [
      { kind: 'write', path: 'src/a.ts', content: 'x' },
      { kind: 'edit', path: 'src/a.ts', old: 'a', new: 'b' },
      { kind: 'patch', diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n' },
    ] satisfies Action[]) {
      const r = ownershipRefusal(action, codeChild());
      expect(r, `${action.kind} must be refused`).not.toBeNull();
      expect(r!.status).toBe('blocked');
      expect(isOwnershipRefusal(r!.reason)).toBe(true);
      expect(r!.reason).toContain('owns nothing');
    }
    // an explicitly EMPTY list is the same case
    expect(ownershipRefusal({ kind: 'write', path: 'src/a.ts', content: 'x' }, codeChild([]))).not.toBeNull();
  });

  it('…but read / run / done are still allowed, and a depth-0 run is untouched', () => {
    for (const action of [{ kind: 'read', paths: ['src/a.ts'] }, { kind: 'run', command: 'npm test' }, { kind: 'done', summary: 'x' }] satisfies Action[]) {
      expect(ownershipRefusal(action, codeChild())).toBeNull();
    }
    // depth 0 is an ordinary run: no ownership model at all
    expect(ownershipRefusal({ kind: 'write', path: 'src/a.ts', content: 'x' }, { depth: 0 })).toBeNull();
    expect(ownershipRefusal({ kind: 'write', path: 'src/a.ts', content: 'x' }, undefined)).toBeNull();
  });

  it('an `own` list that parses to NOTHING is an empty own, not a free pass', () => {
    // every glob rejected by the §3.4 sub-language: the agent owns nothing, so it may write nothing
    const r = ownershipRefusal({ kind: 'write', path: 'src/a.ts', content: 'x' }, { depth: 1, role: 'code', own: ['../escape/**', '/etc/passwd', '!not-this'] });
    expect(r).not.toBeNull();
    expect(isOwnershipRefusal(r!.reason)).toBe(true);
  });

  it('the post-`run` escape diff also fails closed: with no `own`, every changed path escaped', async () => {
    const dir = tempRepo({ 'a.ts': 'a\n' });
    try {
      // `escapedPaths` returned [] on an empty own, so a `run` in a child with no slice reported nothing escaped
      const escaped = await escapedPaths(dir.ws, { changed: ['a.ts', 'src/b.ts'], own: [], syncedDirty: [] });
      expect(escaped).toEqual(['a.ts', 'src/b.ts']);
      // and with a real slice only the outside paths are reported, as before
      expect(await escapedPaths(dir.ws, { changed: ['a.ts', 'src/b.ts'], own: ['src/**'], syncedDirty: [] })).toEqual(['a.ts']);
    } finally {
      dir.cleanup();
    }
  });
});
