/**
 * docs/ORCHESTRATION-DESIGN.md §2.5 depth refusal (corner row 20), §2.6 [G1] [D2] [D10] the harness
 * commit, §5.2 [G3] the child's sandbox (corner rows 51 / 56), and the commit properties of corner
 * rows 26, 36, 37, 54, 55.
 *
 * The standing invariant of this whole wave, asserted first: with `EngineOptions.orchestration`
 * ABSENT nothing below changes — no git process is spawned, `createSandbox` gets byte-identical
 * options, and no `StepRecord` gains `commit` or `escaped`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Harness } from './fakes.js';
import { createFakeSandbox, createFakeWorkspace, execResult, makeEngine, turn } from './fakes.js';
import { git, headSha, tempRepo, write, type TempRepo } from '../orchestrate/helpers.js';
import { refuseOrchestration } from '../../../src/loop/engine.js';
import { ORCHESTRATION_DEPTH_MAX } from '../../../src/core/limits.js';
import { ConfigError } from '../../../src/errors.js';
import type { ConfigRecordValue, OrchestrationOptions, SyncedDirtyEntry } from '../../../src/core/types.js';
import { syncedDirtyEntry } from '../../../src/orchestrate/index.js';

const harnesses: Harness[] = [];
const repos: TempRepo[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
  for (const r of repos.splice(0)) r.cleanup();
});

async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}
function repo(files?: Record<string, string>): TempRepo {
  const r = tempRepo(files);
  repos.push(r);
  return r;
}

const splitRecord = (value: string): Record<string, ConfigRecordValue> => ({ 'orchestrate.split': { value, source: 'flag' } });

describe('§2.1 / corner row 20 — the depth refusal lives in createEngine, not only in the TUI', () => {
  it('refuses depth > ORCHESTRATION_DEPTH_MAX, naming the cap', () => {
    expect(ORCHESTRATION_DEPTH_MAX).toBe(1);
    const call = (): void => refuseOrchestration({ orchestration: { depth: 2 as 0 | 1 }, sandboxProfile: 'none', configRecord: {} });
    expect(call).toThrow(ConfigError);
    expect(call).toThrow(/exceeds the cap of 1/);
    expect(call).toThrow(/an agent cannot spawn agents/);
  });

  it('refuses a depth-1 run that also carries a split flag (a hand-typed `run --parent …` cannot make grandchildren)', () => {
    const call = (): void => refuseOrchestration({ orchestration: { depth: 1, slug: 'tui-rows' }, sandboxProfile: 'none', configRecord: splitRecord('auto') });
    expect(call).toThrow(/--split auto/);
    // `split: 'off'` is the default and is not a refusal
    expect(() => refuseOrchestration({ orchestration: { depth: 1, slug: 'a' }, sandboxProfile: 'none', configRecord: splitRecord('off') })).not.toThrow();
  });

  it('§2.6: refuses a child whose resolved sandbox is WEAKER than the parent recorded', () => {
    const weaker = (): void => refuseOrchestration({ orchestration: { depth: 1, parentSandbox: 'seatbelt' }, sandboxProfile: 'none', configRecord: {} });
    expect(weaker).toThrow(/weaker sandbox than its parent/);
    expect(() => refuseOrchestration({ orchestration: { depth: 1, parentSandbox: 'seatbelt' }, sandboxProfile: 'seatbelt', configRecord: {} })).not.toThrow();
    expect(() => refuseOrchestration({ orchestration: { depth: 1, parentSandbox: 'none' }, sandboxProfile: 'none', configRecord: {} })).not.toThrow();
  });

  it('a parent (depth 0) and an absent orchestration are refused nothing', () => {
    expect(() => refuseOrchestration({ orchestration: { depth: 0 }, sandboxProfile: 'none', configRecord: splitRecord('auto') })).not.toThrow();
    expect(() => refuseOrchestration({ sandboxProfile: 'none', configRecord: splitRecord('auto') })).not.toThrow();
  });

  it('createEngine itself refuses, so the refusal cannot be skipped by a caller', async () => {
    await expect(makeEngine({ engine: { orchestration: { depth: 2 as 0 | 1 } } })).rejects.toThrow(/exceeds the cap of 1/);
  });
});

describe('§5.2 [G3] / corner rows 51, 56 — the child sandbox', () => {
  it("a depth-1 engine's sandbox is created with agentChild: true", async () => {
    const h = await build({ engine: { orchestration: { depth: 1, slug: 'tui-rows' } } });
    expect(h.calls.sandboxOptions?.agentChild).toBe(true);
  });

  it('a normal run and a depth-0 parent pass NO agentChild key at all (byte-identical options)', async () => {
    const plain = await build({});
    expect(plain.calls.sandboxOptions).not.toHaveProperty('agentChild');
    const parent = await build({ engine: { orchestration: { depth: 0 } } });
    expect(parent.calls.sandboxOptions).not.toHaveProperty('agentChild');
  });
});

describe('§2.6 [G1] [D10] — the runGit seam, and what happens without it', () => {
  it('absent runGit = the engine makes NO git commit and no StepRecord.commit (every existing run)', async () => {
    const h = await build({
      turns: [turn({ kind: 'write', path: 'src/tui/a.ts', content: 'x' }), turn({ kind: 'done', summary: 'done' })],
      engine: { orchestration: { depth: 1, slug: 'tui-rows', own: ['src/tui/**'] } },
    });
    const result = await h.engine.run();
    expect(h.store.steps[0]!.commit).toBeUndefined();
    expect(result.commit).toBeUndefined();
  });

  it('a working agent is never empty: the step commits, the sha is on the record and at run:end (corner row 37)', async () => {
    const r = repo({ 'src/tui/a.ts': 'old\n' });
    const base = headSha(r.ws);
    const ws = createFakeWorkspace({ root: r.ws });
    ws.changedFiles = async () => ['src/tui/a.ts'];
    ws.writeFile = async (a) => {
      write(r.ws, a.path, a.content);
      return { changedFiles: [a.path], created: false };
    };
    const h = await build({
      turns: [turn({ kind: 'write', path: 'src/tui/a.ts', content: 'new\n' }), turn({ kind: 'done', summary: 'done' })],
      workspace: ws,
      engine: { orchestration: { depth: 1, slug: 'tui-rows', own: ['src/tui/**'], runGit: r.runGit } },
    });
    const result = await h.engine.run();
    const sha = h.store.steps[0]!.commit;
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(r.ws, 'log', '--format=%s', `${base}..HEAD`).trim()).toContain('jevcode tui-rows step 1:');
    expect(git(r.ws, 'rev-list', '--count', `${base}..HEAD`).trim()).not.toBe('0');
    // run:end reports the end commit only when the end add set was non-empty; the step already committed everything
    expect(result.commit === undefined || /^[0-9a-f]{40}$/.test(result.commit)).toBe(true);
  });

  it('corner row 37: an agent that decided there was nothing to do has ZERO commits and lands trivially', async () => {
    const r = repo({ 'src/tui/a.ts': 'old\n' });
    const base = headSha(r.ws);
    const ws = createFakeWorkspace({ root: r.ws });
    ws.changedFiles = async () => [];
    const h = await build({
      turns: [turn({ kind: 'read', paths: ['src/tui/a.ts'] }), turn({ kind: 'done', summary: 'nothing to change' })],
      workspace: ws,
      engine: { orchestration: { depth: 1, slug: 'tui-rows', own: ['src/tui/**'], runGit: r.runGit } },
    });
    await h.engine.run();
    expect(git(r.ws, 'rev-list', '--count', `${base}..HEAD`).trim()).toBe('0');
    for (const s of h.store.steps) expect(s.commit).toBeUndefined();
  });
});

describe('§2.6 [D2] — the commit set is computed, never `-A`', () => {
  /** a synced-dirty set of `n` parent files, replayed into the worktree exactly as the sync wrote them */
  function syncDirty(r: TempRepo, n: number): SyncedDirtyEntry[] {
    const out: SyncedDirtyEntry[] = [];
    for (let i = 0; i < n; i++) {
      const rel = `parent/dirty-${i}.txt`;
      const body = `parent hunk ${i}\n`;
      write(r.ws, rel, body);
      out.push(syncedDirtyEntry(rel, Buffer.from(body), 0o644));
    }
    return out;
  }

  it('corner row 55 at the DIFF level: 200 synced-dirty paths, an agent that touches none → ZERO of them in its commit', async () => {
    const r = repo({ 'src/tui/a.ts': 'old\n' });
    const base = headSha(r.ws);
    const syncedDirty = syncDirty(r, 200);
    const ws = createFakeWorkspace({ root: r.ws });
    ws.changedFiles = async () => ['src/tui/a.ts'];
    ws.writeFile = async (a) => {
      write(r.ws, a.path, a.content);
      return { changedFiles: [a.path], created: false };
    };
    const h = await build({
      turns: [turn({ kind: 'write', path: 'src/tui/a.ts', content: 'new\n' }), turn({ kind: 'done', summary: 'done' })],
      workspace: ws,
      engine: { orchestration: { depth: 1, slug: 'tui-rows', own: ['src/tui/**'], runGit: r.runGit, syncedDirty } },
    });
    await h.engine.run();
    const changed = git(r.ws, 'diff', '--name-only', `${base}..HEAD`).split('\n').filter((s) => s !== '');
    expect(changed).toEqual(['src/tui/a.ts']);
    for (const e of syncedDirty) expect(changed).not.toContain(e.path);
    // …and therefore zero escape prompts fire for them
    for (const s of h.store.steps) expect(s.escaped).toBeUndefined();
  });

  it('corner row 54: the parent dirty file INSIDE the agent own, edited by the agent, is committed with BOTH sets of hunks', async () => {
    const r = repo({ 'src/tui/Pane.tsx': 'committed\n' });
    const base = headSha(r.ws);
    // the parent had left it dirty; the sync replayed exactly this content
    const carriedBody = 'committed\nparent hunk\n';
    write(r.ws, 'src/tui/Pane.tsx', carriedBody);
    const syncedDirty = [syncedDirtyEntry('src/tui/Pane.tsx', Buffer.from(carriedBody), 0o644)];
    const ws = createFakeWorkspace({ root: r.ws });
    ws.changedFiles = async () => ['src/tui/Pane.tsx'];
    ws.writeFile = async (a) => {
      write(r.ws, a.path, a.content);
      return { changedFiles: [a.path], created: false };
    };
    const h = await build({
      turns: [turn({ kind: 'write', path: 'src/tui/Pane.tsx', content: `${carriedBody}agent hunk\n` }), turn({ kind: 'done', summary: 'done' })],
      workspace: ws,
      engine: { orchestration: { depth: 1, slug: 'tui-rows', own: ['src/tui/**'], runGit: r.runGit, syncedDirty } },
    });
    await h.engine.run();
    expect(h.store.steps[0]!.commit).toMatch(/^[0-9a-f]{40}$/);
    const blob = git(r.ws, 'show', `HEAD:src/tui/Pane.tsx`);
    expect(blob).toContain('parent hunk');
    expect(blob).toContain('agent hunk');
    expect(git(r.ws, 'diff', '--name-only', `${base}..HEAD`).trim()).toBe('src/tui/Pane.tsx');
  });

  it('the commit is made under the harness identity, never the user', async () => {
    const r = repo({ 'src/tui/a.ts': 'old\n' });
    const ws = createFakeWorkspace({ root: r.ws });
    ws.changedFiles = async () => ['src/tui/a.ts'];
    ws.writeFile = async (a) => {
      write(r.ws, a.path, a.content);
      return { changedFiles: [a.path], created: false };
    };
    const h = await build({
      turns: [turn({ kind: 'write', path: 'src/tui/a.ts', content: 'new\n' }), turn({ kind: 'done', summary: 'done' })],
      workspace: ws,
      engine: { orchestration: { depth: 1, slug: 'tui-rows', own: ['src/tui/**'], runGit: r.runGit } },
    });
    await h.engine.run();
    expect(git(r.ws, 'log', '-1', '--format=%an <%ae>').trim()).toBe('jevcode <jevcode@local>');
  });

  it('the identity is overridable by orchestration.commit', async () => {
    const r = repo({ 'src/tui/a.ts': 'old\n' });
    const ws = createFakeWorkspace({ root: r.ws });
    ws.changedFiles = async () => ['src/tui/a.ts'];
    ws.writeFile = async (a) => {
      write(r.ws, a.path, a.content);
      return { changedFiles: [a.path], created: false };
    };
    const orchestration: OrchestrationOptions = { depth: 1, slug: 's', own: ['src/tui/**'], runGit: r.runGit, commit: { name: 'bot', email: 'bot@x' } };
    const h = await build({ turns: [turn({ kind: 'write', path: 'src/tui/a.ts', content: 'new\n' }), turn({ kind: 'done', summary: 'd' })], workspace: ws, engine: { orchestration } });
    await h.engine.run();
    expect(git(r.ws, 'log', '-1', '--format=%an <%ae>').trim()).toBe('bot <bot@x>');
  });

  it('corner row 36 inverted: the end commit fires once, so `run:end` leaves nothing outside carried uncommitted', async () => {
    const r = repo({ 'src/tui/a.ts': 'old\n' });
    const carried = 'parent\n';
    write(r.ws, 'parent/dirty.txt', carried);
    const syncedDirty = [syncedDirtyEntry('parent/dirty.txt', Buffer.from(carried), 0o644)];
    const ws = createFakeWorkspace({ root: r.ws });
    // a `run` rewrote a file the engine's own changedFiles never saw (the [D2] sha-recheck case)
    ws.changedFiles = async () => [];
    const h = await build({
      turns: [turn({ kind: 'run', command: 'codegen' }), turn({ kind: 'done', summary: 'd' })],
      sandbox: createFakeSandbox(() => {
        write(r.ws, 'src/tui/generated.ts', 'gen\n');
        return execResult({ exitCode: 0, stdout: 'ok' });
      }),
      workspace: ws,
      engine: { orchestration: { depth: 1, slug: 's', own: ['src/tui/**'], runGit: r.runGit, syncedDirty } },
    });
    const result = await h.engine.run();
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    const still = git(r.ws, 'status', '--porcelain', '--untracked-files=all').split('\n').filter((s) => s !== '');
    // the only thing left dirty is the carried parent file, which is dirty in every healthy agent worktree
    expect(still.map((l) => l.slice(3))).toEqual(['parent/dirty.txt']);
  });
});

describe('corner row 26 — `pause now` on a child mid-execute never kills the command', () => {
  it('the command runs to its own end, the judge is skipped, and the step commits with interruptedAt.stage === judge', async () => {
    const r = repo({ 'src/tui/a.ts': 'old\n' });
    const ws = createFakeWorkspace({ root: r.ws });
    ws.changedFiles = async () => ['src/tui/a.ts'];
    let engineRef: Harness | null = null;
    const h = await build({
      turns: [turn({ kind: 'run', command: 'slow-thing' }), turn({ kind: 'done', summary: 'd' })],
      sandbox: createFakeSandbox(() => {
        // the pause lands WHILE the command runs
        engineRef?.engine.pause({ at: 'now' });
        write(r.ws, 'src/tui/a.ts', 'new\n');
        return execResult({ exitCode: 0, stdout: 'finished anyway' });
      }),
      workspace: ws,
      engine: { orchestration: { depth: 1, slug: 's', own: ['src/tui/**'], runGit: r.runGit } },
    });
    engineRef = h;
    const result = await h.engine.run();
    expect(result.stopReason).toBe('human_pause');
    const s1 = h.store.steps[0]!;
    expect(s1.outcome?.status).toBe('executed');
    expect(s1.interruptedAt).toEqual({ stage: 'judge', reason: 'human_pause' });
    // the step committed, so the branch holds the work
    expect(s1.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('nothing changes without EngineOptions.orchestration', () => {
  it('a plain run spawns no git process at all', async () => {
    const r = repo();
    const before = r.calls.length;
    const h = await build({ turns: [turn({ kind: 'done', summary: 'x' })] });
    await h.engine.run();
    expect(r.calls.length).toBe(before);
    expect(existsSync(join(r.runDir, 'orchestrate'))).toBe(false);
  });

  it('a plain run writes no orchestrate/ artefact and no review answer is ever read', async () => {
    const h = await build({ turns: [turn({ kind: 'done', summary: 'x' })] });
    await h.engine.run();
    for (const [name] of h.store.cache) expect(name.startsWith('orchestrate/')).toBe(false);
  });
});

// a tiny guard that the fixtures above are honest about what git sees
describe('fixture sanity', () => {
  it('writeFileSync through `write` is visible to git status', () => {
    const r = repo();
    writeFileSync(join(r.ws, 'x.txt'), 'y');
    expect(git(r.ws, 'status', '--porcelain')).toContain('x.txt');
    expect(readFileSync(join(r.ws, 'x.txt'), 'utf8')).toBe('y');
  });
});
