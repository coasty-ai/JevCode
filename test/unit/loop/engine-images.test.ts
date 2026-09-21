/**
 * TUI-DESIGN §12.3 (A143, A144, Q33): pre-images of the targets (edit|write|patch) or the dirty set (run) right before
 * execute, post-images right after with `cleanAtStart` and the HEAD oid, `imagesMs` inside `harnessMs`, the post image
 * on disk before state.json, and an image failure that never fails the step.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPostImages, readPreIndex } from '../../../src/checkpoint/images.js';
import type { Harness } from './fakes.js';
import { FIXED_RUN_ID, createFakeSandbox, createFakeWorkspace, makeEngine, passingTests, repoState, turn } from './fakes.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

/** A runs dir whose root doubles as the workspace, with the fake workspace's files really on disk. */
function realFiles(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jevcode-images-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.py'), 'def f():\n    return 1\n');
  writeFileSync(join(dir, 'tests', 'test_a.py'), 'from src.a import f\n\ndef test_f():\n    assert f() == 2\n');
  return dir;
}

describe('pre/post images around execute (§12.3)', () => {
  it('edit: pre-image of the target, post-image with sha256, source, preImage, cleanAtStart and headOid; imagesMs inside harnessMs; post image before state.json', async () => {
    const runsDir = realFiles();
    const git = repoState({ untracked: ['tests/test_a.py'] });
    const h = await build({
      runsDir,
      workspace: createFakeWorkspace({ root: runsDir, gitState: git }),
      probeGitState: git,
      turns: [turn({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' })],
      limits: { maxSteps: 1 },
    });
    const runDir = join(runsDir, FIXED_RUN_ID);
    let postExistedAtStateWrite: boolean | null = null;
    const realWrite = h.store.writeState.bind(h.store);
    h.store.writeState = async (state) => {
      if (state.step === 1 && postExistedAtStateWrite === null) postExistedAtStateWrite = existsSync(join(runDir, 'post', '1.json'));
      return realWrite(state);
    };
    const r = await h.engine.run();
    expect(r.steps).toBe(1);
    expect(h.store.steps[0]!.outcome?.status).toBe('executed');
    const pre = await readPreIndex(runDir, 1);
    expect(pre).toMatchObject({ v: 1, step: 1, source: 'edit' });
    expect(pre!.entries).toEqual([{ path: 'src/a.py', existed: true, bytes: 22, mode: expect.any(Number), copied: true, skipped: null }]);
    expect(await readFile(join(runDir, 'pre', '1', 'dirs.json'), 'utf8')).toBe('[]\n');
    const post = await readPostImages(runDir, 1);
    expect(post.ok).toBe(true);
    if (!post.ok) return;
    expect(post.image).toMatchObject({ v: 1, step: 1, headOid: '7d731c0e9f1e4b2a8c6d5e4f3a2b1c0d9e8f7a6b', hashSkipped: false, skipped: [] });
    expect(post.image.files['src/a.py']).toMatchObject({ source: 'edit', preImage: true, cleanAtStart: true, bytes: 22 });
    expect(post.image.files['src/a.py']!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // timing: image time is recorded and lives inside harnessMs (§15 item 3)
    const timing = h.store.steps[0]!.timing;
    expect(timing.imagesMs).toBeGreaterThan(0);
    expect(timing.imagesMs!).toBeLessThanOrEqual(timing.harnessMs);
    expect(r.timing.imagesMs).toBe(timing.imagesMs);
    // §19.4: the post image was on disk before state.json for that step
    expect(postExistedAtStateWrite).toBe(true);
    // the images are never hashed inside the overlapped checkpoint: the checkpoint event follows the outcome
    const types = h.events.map((e) => e.type);
    expect(types.indexOf('outcome')).toBeLessThan(types.indexOf('checkpoint'));
  });

  it('run: the dirty set from workspace.dirtySet() is copied (source run) and the untracked/dirty files are not clean at start; read/done take no images', async () => {
    const runsDir = realFiles();
    const git = repoState({ dirty: ['src/a.py'] });
    const h = await build({
      runsDir,
      workspace: createFakeWorkspace({ root: runsDir, gitState: git, dirtySet: new Set(['src/a.py']) }),
      probeGitState: git,
      turns: [turn({ kind: 'run', command: 'pytest -q' }), turn({ kind: 'read', paths: ['src/a.py'] }), turn({ kind: 'done', summary: 'x' })],
      sandbox: createFakeSandbox(() => passingTests),
      limits: { maxSteps: 3 },
    });
    await h.engine.run();
    const runDir = join(runsDir, FIXED_RUN_ID);
    const pre = await readPreIndex(runDir, 1);
    expect(pre).toMatchObject({ source: 'run' });
    expect(pre!.entries.map((e) => [e.path, e.copied])).toEqual([['src/a.py', true]]);
    const post = await readPostImages(runDir, 1);
    expect(post.ok).toBe(true);
    if (post.ok) {
      // the fake sandbox changed nothing: an empty file map, the pre-image skips carried (none)
      expect(post.image.files).toEqual({});
    }
    // read and done: no images at all, no imagesMs
    expect(existsSync(join(runDir, 'pre', '2'))).toBe(false);
    expect(existsSync(join(runDir, 'post', '2.json'))).toBe(false);
    expect(existsSync(join(runDir, 'post', '3.json'))).toBe(false);
    expect(h.store.steps[1]!.timing.imagesMs).toBeUndefined();
    expect(h.store.steps[2]!.timing.imagesMs).toBeUndefined();
  });

  it('a run with nothing dirty and nothing changed records no image; write of a new file records `created` and its new directory', async () => {
    const runsDir = realFiles();
    const h = await build({
      runsDir,
      workspace: createFakeWorkspace({ root: runsDir, gitState: repoState() }),
      probeGitState: repoState(),
      turns: [turn({ kind: 'run', command: 'ls' }), turn({ kind: 'write', path: 'src/new/b.py', content: 'x = 1\n' })],
      limits: { maxSteps: 2 },
    });
    await h.engine.run();
    const runDir = join(runsDir, FIXED_RUN_ID);
    expect(existsSync(join(runDir, 'pre', '1'))).toBe(false);
    expect(existsSync(join(runDir, 'post', '1.json'))).toBe(false);
    const pre = await readPreIndex(runDir, 2);
    expect(pre!.entries).toEqual([{ path: 'src/new/b.py', existed: false, bytes: null, mode: null, copied: false, skipped: null }]);
    expect(JSON.parse(await readFile(join(runDir, 'pre', '2', 'dirs.json'), 'utf8'))).toEqual(['src/new/']);
    const post = await readPostImages(runDir, 2);
    expect(post.ok).toBe(true);
    // the fake workspace writes in memory only: the file is absent on disk after the step, and a target that never existed is not a deletion
    if (post.ok) expect(post.image.files).toEqual({});
  });

  it('without a repository nothing is clean at start and headOid is null; the probe\'s state is used when the workspace has none', async () => {
    const runsDir = realFiles();
    const h = await build({ runsDir, workspace: createFakeWorkspace({ root: runsDir }), turns: [turn({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' })], limits: { maxSteps: 1 } });
    await h.engine.run();
    const post = await readPostImages(join(runsDir, FIXED_RUN_ID), 1);
    expect(post.ok).toBe(true);
    if (post.ok) {
      expect(post.image.headOid).toBeNull();
      expect(post.image.files['src/a.py']).toMatchObject({ cleanAtStart: false, preImage: true });
    }
    const git = repoState({ oid: 'abcdef0123456789abcdef0123456789abcdef01' });
    const h2 = await build({ runsDir: realFiles(), turns: [turn({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' })], limits: { maxSteps: 1 }, probeGitState: git });
    await h2.engine.run();
    const post2 = await readPostImages(join(h2.runsDir, FIXED_RUN_ID), 1);
    expect(post2.ok && post2.image.headOid).toBe('abcdef0123456789abcdef0123456789abcdef01');
  });

  it('an image write that fails never fails the step: a warning line, the step commits, imagesMs still recorded', async () => {
    const runsDir = realFiles();
    const runDir = join(runsDir, FIXED_RUN_ID);
    const h = await build({ runsDir, workspace: createFakeWorkspace({ root: runsDir }), turns: [turn({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' })], limits: { maxSteps: 1 } });
    // `pre` as a regular file: the pre-image directory cannot be created
    writeFileSync(join(runDir, 'pre'), 'not a directory');
    writeFileSync(join(runDir, 'post'), 'not a directory');
    const r = await h.engine.run();
    expect(r.steps).toBe(1);
    expect(h.store.steps[0]!.outcome?.status).toBe('executed');
    const warnings = h.of('transcript').filter((t) => /images write failed/.test(t.text));
    expect(warnings.map((w) => w.text.split(':')[0])).toEqual(['pre-images write failed', 'post-images write failed']);
    expect(h.store.steps[0]!.timing.imagesMs).toBeGreaterThanOrEqual(0);
    expect(h.of('blocking:request')).toEqual([]);
  });
});
