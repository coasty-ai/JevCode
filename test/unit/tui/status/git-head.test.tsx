/**
 * TUI-DESIGN §19.0 (`useGitHead` row: `test/unit/tui/status/git-head.test`) / §12.2: detached / packed-refs / unborn /
 * symbolic-ref parse; the `HEAD`-only filter; the 100 ms debounce; a watch error freezes the value; zero spawns (no
 * child_process in the module); reftable repositories read as unknown (the probe's head stays); the packed-refs parse
 * is reused until the file changes; a `gitDir` change re-watches; the Ink hook over a real temp repository.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { FSWatcher, WatchListener, watch as fsWatch } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { GitHead } from '../../../../src/core/types.js';
import {
  HEAD_DEBOUNCE_MS,
  MAX_SYMREF_DEPTH,
  REFTABLE_HEAD_REF,
  branchName,
  nodeHeadFs,
  packedRefOid,
  parseHeadText,
  parsePackedRefs,
  readHead,
  resetPackedRefsCache,
  resolveRef,
  useGitHead,
  watchHead,
} from '../../../../src/tui/useGitHead.js';
import type { HeadFs } from '../../../../src/tui/useGitHead.js';
import * as gitstate from '../../../../src/workspace/gitstate.js';
import { git, write } from '../../workspace/helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const OID = 'a'.repeat(40);
const OID2 = 'b'.repeat(40);

let temps: string[] = [];
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'jev-head-')));
  temps.push(d);
  return d;
}
const closers: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const c of closers.splice(0)) c();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  temps = [];
  resetPackedRefsCache();
});

function initMain(ws: string, files: Record<string, string>): void {
  mkdirSync(ws, { recursive: true });
  git(ws, 'init', '-q', '-b', 'main', '.');
  for (const [rel, c] of Object.entries(files)) write(ws, rel, c);
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'init');
}

/** An in-memory HeadFs over `{ absPath: content }` that counts reads (no `stat`: the plain packed-refs path). */
function memFs(files: Record<string, string>): HeadFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readFile(p) {
      reads.push(p);
      return Object.prototype.hasOwnProperty.call(files, p) ? files[p]! : null;
    },
  };
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Ink wraps the probe's JSON at the stub stdout's 100 columns: join the rows back before reading it. */
function frameText(ui: { lastFrame: () => string | undefined }): string {
  return (ui.lastFrame() ?? '').replace(/\n/g, '');
}
function frameJson(ui: { lastFrame: () => string | undefined }): unknown {
  const text = frameText(ui);
  return JSON.parse(text.length > 0 ? text : '{}');
}
async function until(pred: () => boolean, ms = 8_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await tick(25);
  }
}

class FakeWatcher extends EventEmitter {
  closed = 0;
  close(): void {
    this.closed++;
  }
}
/** A scripted `fs.watch`: captures the listener so tests can inject events. */
function fakeWatch(): { watch: typeof fsWatch; watchers: FakeWatcher[]; listeners: WatchListener<string>[]; paths: string[] } {
  const watchers: FakeWatcher[] = [];
  const listeners: WatchListener<string>[] = [];
  const paths: string[] = [];
  const watch = ((path: string, _o: unknown, listener: WatchListener<string>): FSWatcher => {
    const w = new FakeWatcher();
    watchers.push(w);
    listeners.push(listener);
    paths.push(path);
    return w as unknown as FSWatcher;
  }) as unknown as typeof fsWatch;
  return { watch, watchers, listeners, paths };
}

describe('parsers (§12.2)', () => {
  it('the reader lives in workspace/gitstate.ts (no React import for the workspace) and is re-exported here unchanged', () => {
    expect(readHead).toBe(gitstate.readHead);
    expect(resolveRef).toBe(gitstate.resolveRef);
    expect(parseHeadText).toBe(gitstate.parseHeadText);
    expect(nodeHeadFs).toBe(gitstate.nodeHeadFs);
    expect(REFTABLE_HEAD_REF).toBe('refs/heads/.invalid');
    const src = readFileSync(join(here, '..', '..', '..', '..', 'src', 'workspace', 'gitstate.ts'), 'utf8');
    expect(src).not.toContain("from 'react'");
    expect(src).not.toContain("from 'ink'");
  });
  it('parseHeadText: symbolic ref, oid (sha1 and sha256), CRLF, garbage', () => {
    expect(parseHeadText('ref: refs/heads/main\n')).toEqual({ ref: 'refs/heads/main' });
    expect(parseHeadText('ref: refs/heads/feature/x\r\n')).toEqual({ ref: 'refs/heads/feature/x' });
    expect(parseHeadText(`${OID}\n`)).toEqual({ oid: OID });
    expect(parseHeadText('c'.repeat(64))).toEqual({ oid: 'c'.repeat(64) });
    expect(parseHeadText('')).toBeNull();
    expect(parseHeadText(null)).toBeNull();
    expect(parseHeadText('ref:\n')).toBeNull();
    expect(parseHeadText('deadbeef\n')).toBeNull();
    expect(parseHeadText('ref: refs/heads/main\nextra line ignored\n')).toEqual({ ref: 'refs/heads/main' });
  });
  it('branchName strips refs/heads/ only', () => {
    expect(branchName('refs/heads/main')).toBe('main');
    expect(branchName('refs/heads/feature/x')).toBe('feature/x');
    expect(branchName('refs/remotes/origin/main')).toBe('refs/remotes/origin/main');
  });
  it('packedRefOid / parsePackedRefs: headers and peeled lines skipped, exact ref match, malformed oid → null, first line wins', () => {
    const packed = `# pack-refs with: peeled fully-peeled sorted \n${OID} refs/heads/main\n${OID2} refs/tags/v1\n^${'d'.repeat(40)}\nzzz refs/heads/bad\n${OID2} refs/heads/main\n`;
    expect(packedRefOid(packed, 'refs/heads/main')).toBe(OID);
    expect(packedRefOid(packed, 'refs/tags/v1')).toBe(OID2);
    expect(packedRefOid(packed, 'refs/heads/mai')).toBeNull();
    expect(packedRefOid(packed, 'refs/heads/bad')).toBeNull();
    expect(packedRefOid(null, 'refs/heads/main')).toBeNull();
    expect(packedRefOid('', 'refs/heads/main')).toBeNull();
    const map = parsePackedRefs(packed);
    expect([...map.keys()]).toEqual(['refs/heads/main', 'refs/tags/v1', 'refs/heads/bad']);
    expect(map.get('refs/heads/bad')).toBeNull();
    expect(parsePackedRefs(null).size).toBe(0);
  });
  it('resolveRef: loose in gitDir, loose in commonDir, packed, symref chain, depth cap, unsafe names', () => {
    const fs = memFs({
      '/wt/.git/refs/heads/local': `${OID2}\n`,
      '/main/.git/refs/heads/main': `${OID}\n`,
      '/main/.git/refs/heads/alias': 'ref: refs/heads/main\n',
      '/main/.git/refs/heads/loop': 'ref: refs/heads/loop\n',
      '/main/.git/packed-refs': `${OID2} refs/heads/packed\n`,
    });
    expect(resolveRef('refs/heads/local', '/wt/.git', '/main/.git', fs)).toBe(OID2);
    expect(resolveRef('refs/heads/main', '/wt/.git', '/main/.git', fs)).toBe(OID);
    expect(resolveRef('refs/heads/packed', '/wt/.git', '/main/.git', fs)).toBe(OID2);
    expect(resolveRef('refs/heads/alias', '/wt/.git', '/main/.git', fs)).toBe(OID);
    expect(resolveRef('refs/heads/loop', '/wt/.git', '/main/.git', fs)).toBeNull();
    expect(resolveRef('refs/heads/nope', '/wt/.git', '/main/.git', fs)).toBeNull();
    expect(resolveRef('../../etc/passwd', '/wt/.git', '/main/.git', fs)).toBeNull();
    expect(resolveRef('', '/wt/.git', '/main/.git', fs)).toBeNull();
    expect(MAX_SYMREF_DEPTH).toBeGreaterThanOrEqual(3);
  });
  it('readHead over an in-memory tree: branch, detached, unborn, missing, torn; commonDir defaults to gitDir', () => {
    const fs = memFs({
      '/r/.git/HEAD': 'ref: refs/heads/main\n',
      '/r/.git/refs/heads/main': `${OID}\n`,
      '/d/.git/HEAD': `${OID2}\n`,
      '/u/.git/HEAD': 'ref: refs/heads/main\n',
      '/t/.git/HEAD': 'garbage',
      '/wt/.git/worktrees/x/HEAD': 'ref: refs/heads/feature/y\n',
      '/wt/.git/refs/heads/feature/y': `${OID}\n`,
    });
    expect(readHead('/r/.git', null, fs)).toEqual({ kind: 'branch', name: 'main', oid: OID });
    expect(readHead('/d/.git', null, fs)).toEqual({ kind: 'detached', oid: OID2 });
    expect(readHead('/u/.git', null, fs)).toEqual({ kind: 'unborn', name: 'main' });
    expect(readHead('/t/.git', null, fs)).toBeNull();
    expect(readHead('/missing/.git', null, fs)).toBeNull();
    expect(readHead('/wt/.git/worktrees/x', '/wt/.git', fs)).toEqual({ kind: 'branch', name: 'feature/y', oid: OID });
  });
  // fix-pass finding 5
  it('reftable: `HEAD = ref: refs/heads/.invalid` (or a reftable/tables.list) reads as unknown, never as an unborn `.invalid`', () => {
    const fs = memFs({
      '/rt/.git/HEAD': `ref: ${REFTABLE_HEAD_REF}\n`,
      '/rt/.git/refs/heads': 'this repository uses the reftable format\n',
      '/rt/.git/reftable/tables.list': '0x000000000001-0x000000000001-03922c45.ref\n',
      // a (hypothetical) reftable repo whose HEAD still names a branch: the tables.list is the second signal
      '/rt2/.git/HEAD': 'ref: refs/heads/main\n',
      '/rt2/.git/reftable/tables.list': 'x.ref\n',
    });
    expect(readHead('/rt/.git', null, fs)).toBeNull();
    expect(readHead('/rt2/.git', null, fs)).toBeNull();
    // a linked worktree of a reftable repository: the common dir holds the tables
    expect(readHead('/rt/.git/worktrees/w', '/rt/.git', memFs({ '/rt/.git/worktrees/w/HEAD': `ref: ${REFTABLE_HEAD_REF}\n` }))).toBeNull();
  });
  // fix-pass finding 10
  it('packed-refs is parsed once per (path, mtimeMs, size) when the fs can stat; a rewrite re-reads, a removal forgets', () => {
    const files: Record<string, string> = {
      '/p/.git/HEAD': 'ref: refs/heads/main\n',
      '/p/.git/packed-refs': `${OID} refs/heads/main\n${OID2} refs/tags/v1\n`,
    };
    const stats: Record<string, { mtimeMs: number; size: number }> = { '/p/.git/packed-refs': { mtimeMs: 1_000, size: 100 } };
    const reads: string[] = [];
    const fs: HeadFs = {
      readFile: (p) => {
        reads.push(p);
        return Object.prototype.hasOwnProperty.call(files, p) ? files[p]! : null;
      },
      stat: (p) => stats[p] ?? null,
    };
    const packedReads = (): number => reads.filter((p) => p === '/p/.git/packed-refs').length;
    expect(readHead('/p/.git', null, fs)).toEqual({ kind: 'branch', name: 'main', oid: OID });
    expect(packedReads()).toBe(1);
    expect(readHead('/p/.git', null, fs)).toEqual({ kind: 'branch', name: 'main', oid: OID });
    expect(readHead('/p/.git', null, fs)).toEqual({ kind: 'branch', name: 'main', oid: OID });
    expect(packedReads()).toBe(1);
    // the same file rewritten (new mtime): re-read once, the new oid shows
    files['/p/.git/packed-refs'] = `${OID2} refs/heads/main\n`;
    stats['/p/.git/packed-refs'] = { mtimeMs: 2_000, size: 60 };
    expect(readHead('/p/.git', null, fs)).toEqual({ kind: 'branch', name: 'main', oid: OID2 });
    expect(packedReads()).toBe(2);
    expect(readHead('/p/.git', null, fs)).toEqual({ kind: 'branch', name: 'main', oid: OID2 });
    expect(packedReads()).toBe(2);
    // packed-refs removed (refs unpacked again): no read, no stale answer
    delete stats['/p/.git/packed-refs'];
    delete files['/p/.git/packed-refs'];
    expect(readHead('/p/.git', null, fs)).toEqual({ kind: 'unborn', name: 'main' });
    expect(packedReads()).toBe(2);
    files['/p/.git/refs/heads/main'] = `${OID}\n`;
    expect(readHead('/p/.git', null, fs)).toEqual({ kind: 'branch', name: 'main', oid: OID });
    // without `stat` the plain read path is used every time (the memFs of the other tests)
    const plain = memFs({ '/q/.git/HEAD': 'ref: refs/heads/main\n', '/q/.git/packed-refs': `${OID} refs/heads/main\n` });
    readHead('/q/.git', null, plain);
    readHead('/q/.git', null, plain);
    expect(plain.reads.filter((p) => p === '/q/.git/packed-refs').length).toBe(2);
    resetPackedRefsCache();
  });
});

describe('readHead over real repositories (§12.2, no spawn)', () => {
  it('branch with a loose ref, after pack-refs, detached, unborn, nested branch name, symbolic ref, linked worktree', () => {
    const base = tmp();
    const ws = join(base, 'ws');
    initMain(ws, { 'a.txt': 'a\n' });
    const gitDir = join(ws, '.git');
    const oid = git(ws, 'rev-parse', 'HEAD').trim();
    expect(readHead(gitDir)).toEqual({ kind: 'branch', name: 'main', oid });
    git(ws, 'pack-refs', '--all');
    expect(readFileSync(join(gitDir, 'packed-refs'), 'utf8')).toContain('refs/heads/main');
    expect(readHead(gitDir)).toEqual({ kind: 'branch', name: 'main', oid });
    // a second commit after pack-refs: the loose ref wins over the (cached) packed entry
    write(ws, 'a.txt', 'b\n');
    git(ws, 'commit', '-q', '-am', 'two');
    const oid2 = git(ws, 'rev-parse', 'HEAD').trim();
    expect(readHead(gitDir)).toEqual({ kind: 'branch', name: 'main', oid: oid2 });
    git(ws, 'pack-refs', '--all');
    expect(readHead(gitDir)).toEqual({ kind: 'branch', name: 'main', oid: oid2 });
    git(ws, 'checkout', '-q', '-b', 'feature/x');
    expect(readHead(gitDir)).toEqual({ kind: 'branch', name: 'feature/x', oid: oid2 });
    git(ws, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/main');
    git(ws, 'symbolic-ref', 'HEAD', 'refs/heads/alias');
    expect(readHead(gitDir)).toEqual({ kind: 'branch', name: 'alias', oid: oid2 });
    git(ws, 'checkout', '-q', '--detach', 'main');
    expect(readHead(gitDir)).toEqual({ kind: 'detached', oid: oid2 });
    git(ws, 'checkout', '-q', '--orphan', 'fresh');
    expect(readHead(gitDir)).toEqual({ kind: 'unborn', name: 'fresh' });
    // linked worktree: HEAD in the worktree's git dir, the ref in the common dir
    git(ws, 'checkout', '-q', 'main');
    const wt = join(base, 'wt');
    git(ws, 'worktree', 'add', '-q', wt, '-b', 'wtb');
    const wtGitDir = join(gitDir, 'worktrees', 'wt');
    expect(readHead(wtGitDir, gitDir)).toEqual({ kind: 'branch', name: 'wtb', oid: oid2 });
    // a fresh `git init`: unborn main
    const fresh = join(base, 'fresh');
    mkdirSync(fresh);
    git(fresh, 'init', '-q', '-b', 'main', '.');
    expect(readHead(join(fresh, '.git'))).toEqual({ kind: 'unborn', name: 'main' });
    expect(nodeHeadFs.readFile(join(base, 'nope'))).toBeNull();
    expect(nodeHeadFs.stat?.(join(base, 'nope'))).toBeNull();
    expect(nodeHeadFs.stat?.(join(gitDir, 'HEAD'))).toMatchObject({ size: expect.any(Number) as number, mtimeMs: expect.any(Number) as number });
  });

  it('a real `git init --ref-format=reftable` repository reads as unknown (null) even after a commit', () => {
    const base = tmp();
    const ws = join(base, 'rt');
    mkdirSync(ws);
    let supported = true;
    try {
      git(ws, 'init', '-q', '-b', 'main', '--ref-format=reftable', '.');
    } catch {
      supported = false;
    }
    if (!supported) return; // git < 2.45: nothing to assert (the memFs test covers the shape)
    const gitDir = join(ws, '.git');
    expect(readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()).toBe(`ref: ${REFTABLE_HEAD_REF}`);
    expect(readHead(gitDir)).toBeNull();
    write(ws, 'a.txt', 'a\n');
    git(ws, 'add', '-A');
    git(ws, 'commit', '-q', '-m', 'init');
    expect(readHead(gitDir)).toBeNull();
    git(ws, 'checkout', '-q', '--detach');
    expect(readHead(gitDir)).toBeNull();
  });

  it('the module never touches child_process', () => {
    const src = readFileSync(join(here, '..', '..', '..', '..', 'src', 'tui', 'useGitHead.ts'), 'utf8');
    expect(src).not.toContain('child_process');
    expect(src).not.toMatch(/\b(execFile|execFileSync|exec|execSync|spawn|spawnSync|fork)\s*\(/);
    expect(src).not.toContain('setInterval(');
  });
});

describe('watchHead (§12.2): filter, debounce, error → frozen', () => {
  it('only `HEAD` (or an unnamed event) schedules a read; a burst collapses into one read after the debounce', async () => {
    const fw = fakeWatch();
    const fs = memFs({ '/r/.git/HEAD': 'ref: refs/heads/main\n', '/r/.git/refs/heads/main': `${OID}\n` });
    const seen: (GitHead | null)[] = [];
    let errors = 0;
    const w = watchHead('/r/.git', (h) => seen.push(h), () => errors++, { watch: fw.watch, fs, debounceMs: 60 });
    closers.push(() => w.close());
    expect(fw.paths).toEqual(['/r/.git']);
    const l = fw.listeners[0]!;
    l('change', 'index');
    l('rename', 'ORIG_HEAD');
    l('change', 'HEAD.lock');
    l('rename', 'logs/HEAD');
    await tick(120);
    expect(seen).toEqual([]);
    expect(fs.reads).toEqual([]);
    for (let i = 0; i < 5; i++) l('rename', 'HEAD');
    await tick(30);
    expect(seen).toEqual([]);
    await tick(80);
    expect(seen).toEqual([{ kind: 'branch', name: 'main', oid: OID }]);
    expect(fs.reads.filter((p) => p.endsWith('/HEAD')).length).toBe(1);
    // an unnamed event (some platforms omit the filename) counts as a possible HEAD change
    l('change', null);
    await tick(100);
    expect(seen.length).toBe(2);
    // after close nothing is delivered and the watcher was closed exactly once
    w.close();
    l('rename', 'HEAD');
    await tick(100);
    expect(seen.length).toBe(2);
    expect(fw.watchers[0]!.closed).toBe(1);
    expect(errors).toBe(0);
    expect(HEAD_DEBOUNCE_MS).toBe(100);
  });

  it('a watcher error fires onError once, cancels a pending read and delivers nothing afterwards; a throwing watch() is an immediate error', async () => {
    const fw = fakeWatch();
    const fs = memFs({ '/r/.git/HEAD': `${OID}\n` });
    const seen: (GitHead | null)[] = [];
    let errors = 0;
    const w = watchHead('/r/.git', (h) => seen.push(h), () => errors++, { watch: fw.watch, fs, debounceMs: 40 });
    closers.push(() => w.close());
    fw.listeners[0]!('rename', 'HEAD');
    fw.watchers[0]!.emit('error', new Error('EMFILE'));
    fw.watchers[0]!.emit('error', new Error('again'));
    await tick(100);
    expect(errors).toBe(1);
    expect(seen).toEqual([]);
    expect(fw.watchers[0]!.closed).toBe(1);
    fw.listeners[0]!('rename', 'HEAD');
    await tick(80);
    expect(seen).toEqual([]);
    const throwing = ((): FSWatcher => {
      throw new Error('ENOENT');
    }) as unknown as typeof fsWatch;
    let errors2 = 0;
    const w2 = watchHead('/gone/.git', () => undefined, () => errors2++, { watch: throwing, fs });
    expect(errors2).toBe(1);
    w2.close();
    // a missing git dir with the real fs.watch is also an error, never a throw
    let errors3 = 0;
    const w3 = watchHead(join(tmp(), 'no-such-dir'), () => undefined, () => errors3++);
    closers.push(() => w3.close());
    await until(() => errors3 === 1, 2_000);
  });

  it('real repository: a checkout is observed within the debounce window; index writes are not read', async () => {
    const base = tmp();
    const ws = join(base, 'ws');
    initMain(ws, { 'a.txt': 'a\n' });
    const gitDir = join(ws, '.git');
    const reads: string[] = [];
    const fs: HeadFs = { readFile: (p) => (reads.push(p), nodeHeadFs.readFile(p)) };
    const seen: (GitHead | null)[] = [];
    let errors = 0;
    const w = watchHead(gitDir, (h) => seen.push(h), () => errors++, { fs });
    closers.push(() => w.close());
    await tick(150);
    git(ws, 'checkout', '-q', '-b', 'other');
    await until(() => seen.some((h) => h?.kind === 'branch' && h.name === 'other'));
    expect(errors).toBe(0);
    const headReads = reads.filter((p) => p === join(gitDir, 'HEAD')).length;
    expect(headReads).toBeGreaterThanOrEqual(1);
    expect(headReads).toBeLessThanOrEqual(3);
    // a write to another entry of the git dir never reaches the reader
    await tick(200);
    const before = reads.length;
    writeFileSync(join(gitDir, 'ORIG_HEAD'), `${OID}\n`);
    writeFileSync(join(gitDir, 'FETCH_HEAD'), '');
    await tick(400);
    expect(reads.length).toBe(before);
    git(ws, 'checkout', '-q', '--detach');
    await until(() => seen.some((h) => h?.kind === 'detached'));
    w.close();
  });
});

function Probe({ gitDir, commonDir, initial, watch, fs }: { gitDir: string | null; commonDir: string | null; initial: GitHead | null; watch?: typeof fsWatch; fs?: HeadFs }): React.JSX.Element {
  const view = useGitHead(gitDir, commonDir, initial, { ...(watch ? { watch } : {}), ...(fs ? { fs } : {}) });
  return <Text>{JSON.stringify(view)}</Text>;
}

describe('useGitHead hook (§12.2, ink-testing-library)', () => {
  it('reads HEAD on mount, follows a checkout in a real repository, and closes the watcher on unmount', async () => {
    const base = tmp();
    const ws = join(base, 'ws');
    initMain(ws, { 'a.txt': 'a\n' });
    const gitDir = join(ws, '.git');
    const oid = git(ws, 'rev-parse', 'HEAD').trim();
    const initial: GitHead = { kind: 'branch', name: 'stale', oid: OID };
    const ui = render(<Probe gitDir={gitDir} commonDir={gitDir} initial={initial} />);
    await until(() => frameText(ui).includes('"name":"main"'), 2_000);
    expect(frameJson(ui)).toEqual({ head: { kind: 'branch', name: 'main', oid }, frozen: false });
    git(ws, 'checkout', '-q', '-b', 'topic');
    await until(() => frameText(ui).includes('"name":"topic"'));
    expect(frameJson(ui)).toEqual({ head: { kind: 'branch', name: 'topic', oid }, frozen: false });
    ui.unmount();
  });

  it('a watcher error freezes the value: the last head stays, frozen becomes true, later events change nothing', async () => {
    const fw = fakeWatch();
    const fs = memFs({ '/r/.git/HEAD': 'ref: refs/heads/main\n', '/r/.git/refs/heads/main': `${OID}\n` });
    const ui = render(<Probe gitDir="/r/.git" commonDir={null} initial={null} watch={fw.watch} fs={fs} />);
    await until(() => frameText(ui).includes('"name":"main"'), 2_000);
    expect(frameJson(ui)).toEqual({ head: { kind: 'branch', name: 'main', oid: OID }, frozen: false });
    expect(fw.watchers.length).toBe(1);
    fw.watchers[0]!.emit('error', new Error('EMFILE'));
    await until(() => frameText(ui).includes('"frozen":true'), 2_000);
    expect(frameJson(ui)).toEqual({ head: { kind: 'branch', name: 'main', oid: OID }, frozen: true });
    fs.readFile = () => 'ref: refs/heads/other\n';
    fw.listeners[0]!('rename', 'HEAD');
    await tick(200);
    expect(frameJson(ui)).toEqual({ head: { kind: 'branch', name: 'main', oid: OID }, frozen: true });
    ui.unmount();
    expect(fw.watchers[0]!.closed).toBeGreaterThanOrEqual(1);
  });

  it('no repository (gitDir null) → the initial head, nothing watched; an unreadable HEAD falls back to the initial value', async () => {
    const fw = fakeWatch();
    const initial: GitHead = { kind: 'detached', oid: OID2 };
    const ui = render(<Probe gitDir={null} commonDir={null} initial={initial} watch={fw.watch} />);
    await tick(20);
    expect(frameJson(ui)).toEqual({ head: initial, frozen: false });
    expect(fw.watchers.length).toBe(0);
    ui.unmount();
    const fs = memFs({});
    const ui2 = render(<Probe gitDir="/r/.git" commonDir={null} initial={initial} watch={fw.watch} fs={fs} />);
    await tick(20);
    expect(frameJson(ui2)).toEqual({ head: initial, frozen: false });
    expect(fw.watchers.length).toBe(1);
    // a later event whose read fails keeps the previous head rather than clearing the zone
    fw.listeners[0]!('rename', 'HEAD');
    await tick(200);
    expect(frameJson(ui2)).toEqual({ head: initial, frozen: false });
    ui2.unmount();
  });

  // fix-pass finding 5
  it('a reftable repository keeps the probe\'s initial head on mount and after HEAD events (never `.invalid`)', async () => {
    const fw = fakeWatch();
    const fs = memFs({ '/rt/.git/HEAD': `ref: ${REFTABLE_HEAD_REF}\n`, '/rt/.git/reftable/tables.list': 'x.ref\n' });
    const initial: GitHead = { kind: 'branch', name: 'main', oid: OID };
    const ui = render(<Probe gitDir="/rt/.git" commonDir="/rt/.git" initial={initial} watch={fw.watch} fs={fs} />);
    await tick(30);
    expect(frameJson(ui)).toEqual({ head: initial, frozen: false });
    expect(frameText(ui)).not.toContain('.invalid');
    fw.listeners[0]!('rename', 'HEAD');
    await tick(200);
    expect(frameJson(ui)).toEqual({ head: initial, frozen: false });
    ui.unmount();
  });

  it('a gitDir change (a new run in another worktree) closes the old watcher, re-reads HEAD and watches the new dir', async () => {
    const fw = fakeWatch();
    const fs = memFs({
      '/a/.git/HEAD': 'ref: refs/heads/main\n',
      '/a/.git/refs/heads/main': `${OID}\n`,
      '/main/.git/worktrees/b/HEAD': 'ref: refs/heads/wtb\n',
      '/main/.git/refs/heads/wtb': `${OID2}\n`,
    });
    const initial: GitHead = { kind: 'branch', name: 'stale', oid: null };
    const ui = render(<Probe gitDir="/a/.git" commonDir="/a/.git" initial={initial} watch={fw.watch} fs={fs} />);
    await until(() => frameText(ui).includes('"name":"main"'), 2_000);
    expect(fw.paths).toEqual(['/a/.git']);
    ui.rerender(<Probe gitDir="/main/.git/worktrees/b" commonDir="/main/.git" initial={initial} watch={fw.watch} fs={fs} />);
    await until(() => frameText(ui).includes('"name":"wtb"'), 2_000);
    expect(frameJson(ui)).toEqual({ head: { kind: 'branch', name: 'wtb', oid: OID2 }, frozen: false });
    expect(fw.paths).toEqual(['/a/.git', '/main/.git/worktrees/b']);
    expect(fw.watchers[0]!.closed).toBe(1);
    expect(fw.watchers[1]!.closed).toBe(0);
    // an event on the OLD watcher changes nothing; one on the new dir is followed
    fs.readFile = (p) => (p === '/a/.git/HEAD' ? `${OID}\n` : p === '/main/.git/worktrees/b/HEAD' ? `${OID2}\n` : null);
    fw.listeners[0]!('rename', 'HEAD');
    await tick(200);
    expect(frameJson(ui)).toEqual({ head: { kind: 'branch', name: 'wtb', oid: OID2 }, frozen: false });
    fw.listeners[1]!('rename', 'HEAD');
    await until(() => frameText(ui).includes('"detached"'), 2_000);
    expect(frameJson(ui)).toEqual({ head: { kind: 'detached', oid: OID2 }, frozen: false });
    // back to no repository: the initial head, the second watcher closed
    ui.rerender(<Probe gitDir={null} commonDir={null} initial={initial} watch={fw.watch} fs={fs} />);
    await until(() => frameText(ui).includes('"stale"'), 2_000);
    expect(fw.watchers[1]!.closed).toBe(1);
    expect(fw.watchers.length).toBe(2);
    ui.unmount();
  });
});
