import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { collectTree, killTree, parsePs, snapshotProcesses } from '../../../src/sandbox/kill.js';
import type { ProcEntry } from '../../../src/sandbox/kill.js';
import { pidAlive } from './helpers.js';

const PS = `  PID  PPID  PGID STAT
    1     0     1 Ss
  100     1   100 S
  101   100   100 S
  102   101   102 S
  103     1   100 S
  200     1   200 Z
`;

describe('parsePs / collectTree', () => {
  it('parses the BSD columns and ignores the header', () => {
    const rows = parsePs(PS);
    expect(rows).toHaveLength(6);
    expect(rows[1]).toEqual({ pid: 100, ppid: 1, pgid: 100, stat: 'S' });
    expect(rows[5]!.stat).toBe('Z');
  });

  it('walks descendants by ppid and unions the process group', () => {
    const tree = collectTree(parsePs(PS), 100);
    // 101 child, 102 grandchild that setsid'ed, 103 re-parented but still in the group
    expect([...tree].sort((a, b) => a - b)).toEqual([100, 101, 102, 103]);
  });
});

describe('killTree with injected snapshot/kill', () => {
  it('sends SIGTERM to group and pids, then SIGKILL, and reports survivors as orphans', async () => {
    const alive = new Set([100, 101, 102]);
    const snapshots: ProcEntry[][] = [];
    const sent: [number, string][] = [];
    const snapshot = async (): Promise<ProcEntry[]> => {
      const rows = parsePs(PS).filter((r) => alive.has(r.pid) || r.pid === 1);
      snapshots.push(rows);
      return rows;
    };
    const kill = (pid: number, sig: NodeJS.Signals): void => {
      sent.push([pid, sig]);
      // 102 ignores SIGTERM and survives SIGKILL (simulated unkillable state); 101 dies on TERM
      if (sig === 'SIGTERM' && pid === 101) alive.delete(101);
      if (sig === 'SIGKILL' && pid === 100) alive.delete(100);
      if (pid < 0 && !alive.has(-pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    };
    const r = await killTree(100, { snapshot, kill, graceMs: 50, pollMs: 10, settleMs: 0, sleep: async () => undefined });
    expect(sent).toContainEqual([-100, 'SIGTERM']);
    expect(sent).toContainEqual([101, 'SIGTERM']);
    expect(sent).toContainEqual([-100, 'SIGKILL']);
    expect(sent).toContainEqual([102, 'SIGKILL']);
    expect(r.orphans).toEqual([102]);
    expect(r.tree).toEqual([100, 101, 102]);
    expect(r.snapshotFailed).toBe(false);
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
  });

  it('a failing ps still kills the group and flags snapshotFailed', async () => {
    const sent: number[] = [];
    const r = await killTree(4242, {
      snapshot: async () => {
        throw new Error('ps unavailable');
      },
      kill: (pid) => {
        sent.push(pid);
      },
      graceMs: 0,
      settleMs: 0,
      sleep: async () => undefined,
    });
    expect(r.snapshotFailed).toBe(true);
    expect(sent).toContain(-4242);
    expect(sent).toContain(4242);
    expect(r.orphans).toEqual([]);
  });

  it('refuses pid <= 1', async () => {
    const r = await killTree(1, { kill: () => undefined, snapshot: async () => [] });
    expect(r.tree).toEqual([]);
  });

  it('kills a real detached tree and the snapshot sees this process', async () => {
    const snap = await snapshotProcesses();
    expect(snap.some((e) => e.pid === process.pid)).toBe(true);
    const child = spawn('/bin/sh', ['-c', 'sleep 300 & sleep 300 & wait'], { detached: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 150));
    const pid = child.pid!;
    const before = collectTree(await snapshotProcesses(), pid);
    expect(before.size).toBe(3);
    const r = await killTree(pid, { graceMs: 500, pollMs: 25 });
    expect(r.orphans).toEqual([]);
    for (const p of before) if (p !== pid) expect(pidAlive(p)).toBe(false);
    child.unref();
  });
});
