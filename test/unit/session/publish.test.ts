/**
 * TUI-DESIGN-5 §2.14 / §10 (slot R5-1) — the WRITE half's three invariants:
 * the heartbeat writer starts only after a **resolved** `firstFrame()` promise, it is stopped in the `finally`,
 * and the claim is minted **after** `claimRefusal` returns null.
 */
import { describe, expect, it } from 'vitest';
import type { LeaseIntent } from '../../../src/coordination/index.js';
import { createPublisher, forceTakebackOf, gitInputOf, headOidOf, probeRepoFacts, type PublishLedger, type PublishRefusal } from '../../../src/session/publish.js';
import type { GitState } from '../../../src/core/types.js';

interface Trace {
  readonly log: string[];
  readonly ledger: PublishLedger;
  stopped: number;
}

function fakeLedger(o: { refusal?: PublishRefusal | null; openThrows?: string; mintGate?: Promise<void> } = {}): Trace {
  const log: string[] = [];
  const t: Trace = {
    log,
    stopped: 0,
    ledger: {
      async open() {
        if (o.openThrows !== undefined) throw new Error(o.openThrows);
        log.push('open');
      },
      async close() {
        log.push('close');
      },
      claimRefusal() {
        log.push('claimRefusal');
        return o.refusal ?? null;
      },
      async mintClaim(opts) {
        log.push(`mintClaim:start(force=${String(opts.forceTakeback)})`);
        if (o.mintGate !== undefined) await o.mintGate;
        log.push(`mintClaim(force=${String(opts.forceTakeback)})`);
      },
      startHeartbeat() {
        log.push('startHeartbeat');
        return {
          stop() {
            t.stopped += 1;
            log.push('stopHeartbeat');
          },
        };
      },
      async declare(intent: LeaseIntent) {
        log.push(`declare(${intent.paths.join(',')})`);
        return {
          release(outcome) {
            log.push(`release(${outcome})`);
          },
        };
      },
    },
  };
  return t;
}

const intent = (paths: string[]): LeaseIntent => ({ paths, type: 'intent', reason60: 'step 7', step: 7, stage: 'execute', branch: 'main', head: null });

describe('createPublisher — §2.14 invariant 1: nothing is written before the first frame', () => {
  it('neither the import nor `open()` nor a beat happens until `firstFrame()` RESOLVES', async () => {
    const t = fakeLedger();
    let release = (): void => undefined;
    const frame = new Promise<void>((r) => {
      release = r;
    });
    let opened = false;
    const p = createPublisher({ firstFrame: () => frame, open: async () => { opened = true; return t.ledger; } });
    const started = p.start();
    await Promise.resolve();
    await Promise.resolve();
    // gate G-R5-1: the dynamic import has not been reached, so the coordination tree is not on the argv path
    expect(opened).toBe(false);
    expect(t.log).toEqual([]);
    expect(p.beating).toBe(false);
    release();
    await started;
    expect(opened).toBe(true);
    expect(t.log).toEqual(['open', 'claimRefusal', 'mintClaim:start(force=false)', 'mintClaim(force=false)', 'startHeartbeat']);
    expect(p.beating).toBe(true);
  });

  it('the heartbeat writer is started LAST, after `open()` and after the mint', async () => {
    const t = fakeLedger();
    await createPublisher({ firstFrame: () => Promise.resolve(), open: async () => t.ledger }).start();
    expect(t.log.indexOf('startHeartbeat')).toBeGreaterThan(t.log.indexOf('open'));
    expect(t.log.indexOf('startHeartbeat')).toBeGreaterThan(t.log.indexOf('mintClaim(force=false)'));
  });

  it('a ledger that cannot open is a NOTICE, not a dead session — every §2 surface keeps its empty state', async () => {
    const t = fakeLedger({ openThrows: 'EACCES on ~/.jevcode/coordination' });
    const notices: string[] = [];
    const p = createPublisher({ firstFrame: () => Promise.resolve(), open: async () => t.ledger, onNotice: (s) => notices.push(s) });
    expect(await p.start()).toEqual({ kind: 'unavailable', reason: 'EACCES on ~/.jevcode/coordination' });
    expect(notices[0]).toContain('the session ledger could not open');
    expect(notices[0]).toContain('/who and /peers show their empty state');
    expect(p.beating).toBe(false);
    await expect(p.stop()).resolves.toBeUndefined();
  });
});

describe('§2.14 invariant 2: the claim is minted only after `claimRefusal` returns null', () => {
  it('a qualified foreign claim refuses — no mint, no beat, and the run does not appear as a second writer', async () => {
    const refusal: PublishRefusal = { kind: 'taken-over', message: 'taken over by mbp at 14:02 (claim 4); /resume --force-takeback re-takes it' };
    const t = fakeLedger({ refusal });
    const notices: string[] = [];
    const p = createPublisher({ firstFrame: () => Promise.resolve(), open: async () => t.ledger, onNotice: (s) => notices.push(s) });
    expect(await p.start()).toEqual({ kind: 'refused', refusal });
    expect(t.log).toEqual(['open', 'claimRefusal']);
    expect(t.log).not.toContain('mintClaim(force=false)');
    expect(t.log).not.toContain('startHeartbeat');
    expect(p.beating).toBe(false);
    expect(notices).toEqual([refusal.message]);
  });

  it('the epoch ceiling refuses the same way (S15) — a stated permanent limit, never a silent hang', async () => {
    const refusal: PublishRefusal = { kind: 'ceiling', message: 'claim epochs for this run reached the bound (1e9); nothing can take it over — start a new run from this state' };
    const t = fakeLedger({ refusal });
    const r = await createPublisher({ firstFrame: () => Promise.resolve(), open: async () => t.ledger }).start();
    expect(r).toEqual({ kind: 'refused', refusal });
    expect(t.log).not.toContain('startHeartbeat');
  });

  it('`--force-takeback` bumps the epoch; an ordinary resume does not (§7 row 26)', async () => {
    const plain = fakeLedger();
    await createPublisher({ firstFrame: () => Promise.resolve(), open: async () => plain.ledger }).start();
    expect(plain.log).toContain('mintClaim(force=false)');
    const forced = fakeLedger();
    await createPublisher({ firstFrame: () => Promise.resolve(), open: async () => forced.ledger, forceTakeback: true }).start();
    expect(forced.log).toContain('mintClaim(force=true)');
  });

  it('`claimRefusal` is read exactly once per start, however many times `start()` is called', async () => {
    const t = fakeLedger();
    const p = createPublisher({ firstFrame: () => Promise.resolve(), open: async () => t.ledger });
    const [a, b] = await Promise.all([p.start(), p.start()]);
    expect(a).toEqual(b);
    expect(await p.start()).toEqual(a);
    expect(t.log.filter((x) => x === 'claimRefusal')).toHaveLength(1);
    expect(t.log.filter((x) => x === 'startHeartbeat')).toHaveLength(1);
  });
});

describe('§2.14 invariant 3: the writer is stopped in the `finally`', () => {
  it('`stop()` stops the writer and closes the ledger, and is idempotent', async () => {
    const t = fakeLedger();
    const p = createPublisher({ firstFrame: () => Promise.resolve(), open: async () => t.ledger });
    await p.start();
    await p.stop();
    await p.stop();
    expect(t.stopped).toBe(1);
    expect(t.log).toEqual(['open', 'claimRefusal', 'mintClaim:start(force=false)', 'mintClaim(force=false)', 'startHeartbeat', 'stopHeartbeat', 'close']);
    expect(p.beating).toBe(false);
  });

  it('the exit `finally` runs it even when the body threw, and a failing stop never fails the exit path', async () => {
    const t = fakeLedger();
    const broken: PublishLedger = { ...t.ledger, startHeartbeat: () => ({ stop() { throw new Error('the beat file vanished'); } }), close: () => Promise.reject(new Error('EIO')) };
    const p = createPublisher({ firstFrame: () => Promise.resolve(), open: async () => broken });
    await p.start();
    let thrown: unknown = null;
    try {
      throw new Error('the run failed');
    } catch (e) {
      thrown = e;
    } finally {
      await expect(p.stop()).resolves.toBeUndefined();
    }
    expect((thrown as Error).message).toBe('the run failed');
  });

  it('nothing writes a "clean" terminal beat — `stop()` calls the writer’s own `stop`, never a final `startHeartbeat`', async () => {
    const t = fakeLedger();
    const p = createPublisher({ firstFrame: () => Promise.resolve(), open: async () => t.ledger });
    await p.start();
    await p.stop();
    expect(t.log.filter((x) => x === 'startHeartbeat')).toHaveLength(1);
    expect(t.log.at(-1)).toBe('close');
  });

  /**
   * Round-5 fix pass, blocker 2. `run()` checked `stopped` only once, right after `open()`; with `stop()` landing
   * inside `await l.mintClaim(...)` — which is exactly what a short `--mock` run or a Ctrl-C does, because
   * `src/cli/session.ts` fires `void p.start()` and `finishSession`'s exit path calls `stopPublishing()` — the
   * teardown ran and THEN `startHeartbeat()` was called on a closed ledger, so the beats outlived the session.
   */
  it('`stop()` DURING an in-flight `mintClaim` leaves `beating === false` and never calls `startHeartbeat`', async () => {
    let openGate = (): void => undefined;
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    const t = fakeLedger({ mintGate: gate });
    const p = createPublisher({ firstFrame: () => Promise.resolve(), open: async () => t.ledger });
    const started = p.start();
    // let `run()` reach the await inside `mintClaim`
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(t.log).toEqual(['open', 'claimRefusal', 'mintClaim:start(force=false)']);
    const stopping = p.stop();
    openGate();
    await Promise.all([stopping, started]);
    expect(t.log).not.toContain('startHeartbeat');
    expect(p.beating).toBe(false);
    expect(t.stopped).toBe(0);
    expect(await started).toMatchObject({ kind: 'unavailable' });
    // and the ledger it opened is closed exactly once, by whichever side got there first
    expect(t.log.filter((x) => x === 'close').length).toBeGreaterThanOrEqual(1);
  });

  it('`stop()` before the first frame never hangs, even though `start()` is still parked on `firstFrame()`', async () => {
    const t = fakeLedger();
    const p = createPublisher({ firstFrame: () => new Promise<void>(() => undefined), open: async () => t.ledger });
    void p.start();
    await expect(p.stop()).resolves.toBeUndefined();
    expect(p.beating).toBe(false);
    expect(t.log).toEqual([]);
  });

  it('an exit that races the open closes the ledger and never starts a beat', async () => {
    const t = fakeLedger();
    let release = (): void => undefined;
    const frame = new Promise<void>((r) => {
      release = r;
    });
    const p = createPublisher({ firstFrame: () => frame, open: async () => t.ledger });
    const started = p.start();
    await p.stop();
    release();
    expect(await started).toMatchObject({ kind: 'unavailable' });
    expect(t.log).toEqual(['open', 'close']);
  });
});

describe('leases (§2.14 row 3) — advisory, and never a blocker', () => {
  it('a declared lease reaches the ledger and releases with its outcome', async () => {
    const t = fakeLedger();
    const p = createPublisher({ firstFrame: () => Promise.resolve(), open: async () => t.ledger });
    await p.start();
    const handle = await p.declare(intent(['src/loop/engine.ts']));
    expect(handle).not.toBeNull();
    await handle?.release('committed');
    expect(t.log).toContain('declare(src/loop/engine.ts)');
    expect(t.log).toContain('release(committed)');
  });

  it('a failed declare answers null — §1.4 promise 2: nothing a lease does can stall a local step', async () => {
    const t = fakeLedger();
    const broken: PublishLedger = { ...t.ledger, declare: () => Promise.reject(new Error('ENOSPC')) };
    const p = createPublisher({ firstFrame: () => Promise.resolve(), open: async () => broken });
    await p.start();
    await expect(p.declare(intent(['src/x.ts']))).resolves.toBeNull();
  });

  it('declaring before `start()` (or after a refusal, or after `stop()`) is a no-op, never a throw', async () => {
    const t = fakeLedger({ refusal: { kind: 'taken-over', message: 'taken over' } });
    const refused = createPublisher({ firstFrame: () => Promise.resolve(), open: async () => t.ledger });
    expect(await refused.declare(intent(['a.ts']))).toBeNull();
    await refused.start();
    expect(await refused.declare(intent(['a.ts']))).toBeNull();

    const ok = fakeLedger();
    const p = createPublisher({ firstFrame: () => Promise.resolve(), open: async () => ok.ledger });
    await p.start();
    await p.stop();
    expect(await p.declare(intent(['a.ts']))).toBeNull();
  });
});

describe('the `GitState` → `SessionLedgerInput` mapping (§2.14, §12.1 S1)', () => {
  const git = (patch: Partial<GitState> = {}): GitState => ({
    repo: true,
    gitDir: '/w/.git',
    commonDir: '/w/.git',
    topLevel: '/w',
    prefix: '',
    linkedWorktree: false,
    head: { kind: 'branch', name: 'main', oid: '3f9a2c1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    upstream: null,
    ahead: null,
    behind: null,
    dirty: { modified: 0, staged: 0, untracked: 0, renamed: 0, unmerged: 0, submodules: 0, entries: [] },
    probedAt: '2026-09-22T10:00:00.000Z',
    probeMs: 4,
    ...patch,
  });

  it('a BRANCH head carries an oid — reading only the detached arm published `head: null` everywhere (finding 5)', () => {
    expect(headOidOf({ kind: 'branch', name: 'main', oid: 'abc1234' })).toBe('abc1234');
    expect(headOidOf({ kind: 'detached', oid: 'def5678' })).toBe('def5678');
    expect(headOidOf({ kind: 'branch', name: 'main', oid: null })).toBeNull();
    expect(headOidOf({ kind: 'unborn', name: 'main' })).toBeNull();
    expect(headOidOf(null)).toBeNull();
  });

  it('`gitInputOf` maps branch, head, dirty, linkedWorktree and commonDir from the one probe', () => {
    expect(gitInputOf(git())).toEqual({ branch: 'main', head: '3f9a2c1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', dirtyAtStart: false, linkedWorktree: false, commonDir: '/w/.git' });
    // a LINKED worktree says so, and its commonDir is the parent checkout's (§7 row 8)
    expect(gitInputOf(git({ linkedWorktree: true, commonDir: '/main/.git', dirty: { modified: 2, staged: 1, untracked: 0, renamed: 0, unmerged: 0, submodules: 0, entries: [] } }))).toEqual({
      branch: 'main',
      head: '3f9a2c1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      dirtyAtStart: true,
      linkedWorktree: true,
      commonDir: '/main/.git',
    });
    expect(gitInputOf(git({ head: { kind: 'detached', oid: 'aaa' } })).branch).toBeNull();
    expect(gitInputOf(null)).toEqual({ branch: null, head: null, dirtyAtStart: false, linkedWorktree: false, commonDir: null });
  });

  it('§7 row 26: `--force` alone never bumps the epoch — only `--force-takeback` does', () => {
    expect(forceTakebackOf({ resumed: true, force: true })).toBe(false);
    expect(forceTakebackOf({ resumed: true, forceTakeback: true })).toBe(true);
    expect(forceTakebackOf({ resumed: true, force: true, forceTakeback: true })).toBe(true);
    // a fresh run is never a takeback, whatever was typed
    expect(forceTakebackOf({ resumed: false, forceTakeback: true })).toBe(false);
  });
});

describe('probeRepoFacts (§3.2 / §7 rows 7–9)', () => {
  it('reads the root commits, the shallow flag and the origin URL, and never throws', async () => {
    const seen: string[][] = [];
    const exec = async (args: readonly string[]): Promise<string | null> => {
      seen.push([...args]);
      if (args[0] === 'rev-list') return 'aaaa1111\nbbbb2222\n';
      if (args[0] === 'rev-parse') return 'false\n';
      return 'git@github.com:me/repo.git\n';
    };
    expect(await probeRepoFacts('/w', { exec })).toEqual({ rootOids: ['aaaa1111', 'bbbb2222'], shallow: false, originUrl: 'git@github.com:me/repo.git' });
    expect(seen.map((a) => a[0]).sort()).toEqual(['config', 'rev-list', 'rev-parse']);
  });

  it('a shallow clone has no repoKey source, an unborn HEAD has no roots, and git missing is `null`', async () => {
    const shallow = await probeRepoFacts('/w', { exec: async (a) => (a[0] === 'rev-parse' ? 'true\n' : a[0] === 'rev-list' ? '' : '') });
    expect(shallow).toEqual({ rootOids: [], shallow: true, originUrl: null });
    expect(await probeRepoFacts('/w', { exec: async () => null })).toBeNull();
  });
});
