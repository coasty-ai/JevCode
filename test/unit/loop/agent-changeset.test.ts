/**
 * docs/AGENT-LOOP-DESIGN.md §3.4 / §2.2 / §3.3 / §15 S4 — the per-step change set and what it decides. For a command:
 *   (after \ before) ∪ (before \ after) ∪ { p in the pre-image whose bytes, size or existence differ now }
 * `observe()` receives it (not the run-cumulative changedFiles) before state.json is written, and a command other than the test
 * command with a non-empty set makes every earlier test run stale. So: edit, green test, `git diff`, finish → no verify, complete;
 * green test, `sed -i` through bash, finish → never complete (unless the driver verifies again).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writePreImages } from '../../../src/checkpoint/images.js';
import type { Action, ActionOutcome, GitState } from '../../../src/core/types.js';
import { stepChangeSet } from '../../../src/loop/stages/agent.js';
import type { AgentHarness, FakeWorkspace, ScriptedDriverOptions, ToolTurn } from './fakes.js';
import { createFakeSandbox, createFakeWorkspace, execResult, makeAgentEngine, passingTests, repoState } from './fakes.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jevcode-agent-cs-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

// ---------------------------------------------------------------------------------------
// the helper, on real files
// ---------------------------------------------------------------------------------------

describe('stepChangeSet (§3.4)', () => {
  const run: Action = { kind: 'run', command: 'make gen' };
  const executed: ActionOutcome = { status: 'executed', summary: 'exit 0', changedFiles: [] };

  it('edit / write: the executed target, nothing when the action failed; a read, a done, a refused or declined command: nothing', async () => {
    const base = { before: [], after: [], pre: null, preChanged: null, post: null, root: '/nowhere', runDir: '/nowhere', step: 1 };
    expect(await stepChangeSet({ ...base, action: { kind: 'edit', path: 'a.py', old: 'x', new: 'y' }, outcome: { status: 'executed', summary: 's', changedFiles: ['a.py'] } })).toEqual(['a.py']);
    expect(await stepChangeSet({ ...base, action: { kind: 'write', path: 'a.py', content: 'x' }, outcome: { status: 'failed', error: 'path_escape' } })).toEqual([]);
    expect(await stepChangeSet({ ...base, action: { kind: 'read', paths: ['a.py'] }, outcome: executed })).toEqual([]);
    expect(await stepChangeSet({ ...base, action: { kind: 'done', summary: 'x' }, outcome: { status: 'noop', summary: 'x' } })).toEqual([]);
    expect(await stepChangeSet({ ...base, action: run, after: ['a.py'], outcome: { status: 'blocked', reason: 'rule' } })).toEqual([]);
    expect(await stepChangeSet({ ...base, action: run, after: ['a.py'], outcome: { status: 'declined', reason: 'no' } })).toEqual([]);
  });

  it('a command: files new to the run-changed set, files that left it, and pre-imaged files whose bytes differ now', async () => {
    const root = tempRoot();
    const runDir = join(root, '.run');
    put(root, 'same.py', 'x = 1\n');
    put(root, 'edited.py', 'y = 1\n');
    put(root, 'dirty-at-start.py', 'z = 1\n');
    put(root, 'deleted.py', 'gone\n');
    const pre = await writePreImages(runDir, 3, ['same.py', 'edited.py', 'dirty-at-start.py', 'deleted.py'], { root, source: 'run' });
    // the command rewrites two files in place (same size for one of them) and deletes one
    put(root, 'edited.py', 'y = 2\n');
    put(root, 'dirty-at-start.py', 'z = 1 # longer\n');
    rmSync(join(root, 'deleted.py'));
    const changed = await stepChangeSet({ action: run, outcome: executed, before: ['same.py', 'edited.py', 'reverted.py', 'deleted.py'], after: ['same.py', 'edited.py', 'deleted.py', 'new.py'], pre, preChanged: null, post: null, root, runDir, step: 3 });
    expect(changed).toEqual(['deleted.py', 'dirty-at-start.py', 'edited.py', 'new.py', 'reverted.py']);
  });

  it('a before ∩ after file with no pre-image entry counts as changed (the image failed: unknown is changed); a same-size skip is unchanged', async () => {
    const root = tempRoot();
    const runDir = join(root, '.run');
    put(root, 'big.bin', 'a'.repeat(64));
    const pre = await writePreImages(runDir, 1, ['big.bin'], { root, source: 'run', maxFileBytes: 8 });
    expect(pre.entries[0]).toMatchObject({ copied: false, skipped: 'size' });
    put(root, 'big.bin', 'b'.repeat(64));
    // open risk 11: no copy and the same size → unchanged
    expect(await stepChangeSet({ action: run, outcome: executed, before: ['big.bin'], after: ['big.bin'], pre, preChanged: null, post: null, root, runDir, step: 1 })).toEqual([]);
    put(root, 'big.bin', 'b'.repeat(65));
    expect(await stepChangeSet({ action: run, outcome: executed, before: ['big.bin'], after: ['big.bin'], pre, preChanged: null, post: null, root, runDir, step: 1 })).toEqual(['big.bin']);
    expect(await stepChangeSet({ action: run, outcome: executed, before: ['x.py'], after: ['x.py'], pre: null, preChanged: null, post: null, root, runDir, step: 1 })).toEqual(['x.py']);
  });
});

// ---------------------------------------------------------------------------------------
// through the engine: what the set decides
// ---------------------------------------------------------------------------------------

interface Disk {
  root: string;
  workspace: FakeWorkspace;
  /** paths a command changed, reported by changedFiles() the way git status would */
  external: Set<string>;
}

/** The fake workspace with its files on disk: file actions write through, commands change files the sandbox script names. */
function disk(files: Record<string, string>, git: GitState = repoState()): Disk {
  const root = tempRoot();
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  const workspace = createFakeWorkspace({ root, files, gitState: git });
  const external = new Set<string>();
  const applyEdit = workspace.applyEdit.bind(workspace);
  workspace.applyEdit = async (a) => {
    const r = await applyEdit(a);
    put(root, a.path, workspace.files.get(a.path)!);
    return r;
  };
  const changedFiles = workspace.changedFiles.bind(workspace);
  workspace.changedFiles = async () => [...new Set([...(await changedFiles()), ...external])].sort();
  return { root, workspace, external };
}

/** `pytest -q` passes; `sed -i s/<a>/<b>/ <file>` rewrites the file on disk; anything else prints and changes nothing. */
function shell(d: Disk): ReturnType<typeof createFakeSandbox> {
  return createFakeSandbox((command) => {
    if (command === 'pytest -q') return passingTests;
    const sed = /^sed -i s\/(.+)\/(.+)\/ (\S+)$/.exec(command);
    if (sed !== null) {
      const rel = sed[3]!;
      const text = (d.workspace.files.get(rel) ?? '').replace(sed[1]!, sed[2]!);
      d.workspace.files.set(rel, text);
      put(d.root, rel, text);
      d.external.add(rel);
      return execResult({ exitCode: 0 });
    }
    if (command === 'git diff') return execResult({ exitCode: 0, stdout: 'diff --git a/src/a.py b/src/a.py\n-    return 1\n+    return 2\n' });
    return execResult({ exitCode: 0, stdout: '1\n' });
  });
}

const FILES = { 'src/a.py': 'def f():\n    return 1\n', 'tests/test_a.py': 'from src.a import f\n\ndef test_f():\n    assert f() == 2\n' };
const edit: ToolTurn = { toolCalls: [{ name: 'edit_file', input: { path: 'src/a.py', old_string: 'return 1', new_string: 'return 2' } }] };
const bash = (command: string): ToolTurn => ({ toolCalls: [{ name: 'bash', input: { command } }] });

async function agentOn(d: Disk, turns: ToolTurn[], driver: ScriptedDriverOptions = {}): Promise<AgentHarness> {
  const h = await makeAgentEngine(turns, { runsDir: d.root, workspace: d.workspace, probeGitState: repoState(), sandbox: shell(d), driver });
  cleanups.push(() => h.cleanup());
  return h;
}

describe('the change set decides verification and completion (§3.3, §3.4)', () => {
  it('edit, green test, `git diff`, finish → no verify step, stop complete; observe() gets the per-step sets', async () => {
    const d = disk(FILES);
    const h = await agentOn(d, [edit, bash('pytest -q'), bash('git diff'), { text: 'Fixed.' }], { verify: true });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('complete');
    expect(h.store.steps.map((s) => s.agent?.kind)).toEqual(['act', 'act', 'observe', 'finish']);
    // the edit changed its target; the test run changed nothing (the edited file's bytes equal its pre copy); `git diff` is read-only
    expect(h.driver.observations.map((o) => [o.step, o.changedFiles])).toEqual([
      [1, ['src/a.py']],
      [2, []],
      [4, []],
    ]);
    expect(h.store.steps[2]!.proposal?.action.kind).toBe('read');
    expect(h.sandbox.commands).toEqual(['pytest -q', 'git diff']);
  });

  it('green test, `sed -i` through bash, finish → never complete: the command changed a file after the green run (generator_done)', async () => {
    const d = disk(FILES);
    const h = await agentOn(d, [bash('pytest -q'), bash('sed -i s/1/3/ src/a.py'), { text: 'Done.' }]);
    const r = await h.engine.run();
    expect(r.stopReason).toBe('generator_done');
    expect(h.driver.observations[1]!.changedFiles).toEqual(['src/a.py']);
    expect(h.store.last()!.lastChangeStep).toBe(2);
    expect(h.store.last()!.lastTestRun).toMatchObject({ step: 1, allPassed: true });
  });

  it('the same after an earlier edit of the file (before ∩ after): the pre copy differs from the post image, so the test run is stale', async () => {
    const d = disk(FILES);
    const h = await agentOn(d, [edit, bash('pytest -q'), bash('sed -i s/2/3/ src/a.py'), { text: 'Done.' }]);
    const r = await h.engine.run();
    expect(r.stopReason).toBe('generator_done');
    expect(h.driver.observations.map((o) => o.changedFiles)).toEqual([['src/a.py'], [], ['src/a.py'], []]);
    expect(h.store.last()!.lastChangeStep).toBe(3);
  });

  it('a command that changes nothing after the green run keeps it current: complete', async () => {
    const d = disk(FILES);
    const h = await agentOn(d, [edit, bash('pytest -q'), bash("python3 -c 'print(1)'"), { text: 'Done.' }]);
    const r = await h.engine.run();
    expect(r.stopReason).toBe('complete');
    expect(h.driver.observations[2]!.changedFiles).toEqual([]);
  });

  it('with the verification rule on, the stale green run gets a harness verify step — its fresh green run completes', async () => {
    const d = disk(FILES);
    const h = await agentOn(d, [bash('pytest -q'), bash('sed -i s/1/3/ src/a.py'), { text: 'Done.' }, { text: 'Verified and done.' }], { verify: true });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('complete');
    expect(h.store.steps.map((s) => s.agent?.kind)).toEqual(['act', 'act', 'verify', 'finish']);
    expect(h.store.steps[2]!.proposal?.action).toEqual({ kind: 'run', command: 'pytest -q' });
    expect(h.store.last()!.lastTestRun).toMatchObject({ step: 3, allPassed: true });
  });

  it('observe() runs BEFORE the step’s state.json is written (the tool result is in the transcript when the checkpoint lands)', async () => {
    const d = disk(FILES);
    const h = await agentOn(d, [edit, bash('pytest -q'), { text: 'Fixed.' }]);
    const seen: { step: number; observed: number[]; seq: unknown }[] = [];
    const write = h.store.writeState.bind(h.store);
    h.store.writeState = async (state) => {
      seen.push({ step: state.step, observed: h.driver.observations.map((o) => o.step), seq: (state.agentState as { transcriptSeq?: number } | undefined)?.transcriptSeq });
      return write(state);
    };
    await h.engine.run();
    for (const step of [1, 2, 3]) {
      const at = seen.find((s) => s.step === step)!;
      expect(at.observed).toContain(step);
      // and the checkpoint's seq is the step's own seqAfter
      expect(at.seq).toBe(h.store.steps[step - 1]!.agent!.seqAfter);
    }
  });
});
