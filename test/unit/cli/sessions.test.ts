/**
 * TUI-DESIGN §1 / §8.2 / §8.5 / §19.0 `src/cli/sessions.ts`: `sessions list` (rows, empty message, the reindex
 * hint, `--json`), `reindex` from run.json files, `prune` reporting runs whose directory is gone, and `unlock`
 * (no lock / dead pid removed / live pid refused with the §24 message).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandSessions, sessionsUnlock, type SessionsIo } from '../../../src/cli/sessions.js';
import { appendIndexLine, readIndex } from '../../../src/session/index.js';
import { finishedRunLines, scriptedRunId } from './helpers.js';
import { makeMeta } from '../session/helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(): { home: string; runsDir: string; indexPath: string; io: SessionsIo & { out: string[]; err: string[] } } {
  const home = mkdtempSync(join(tmpdir(), 'jevcode-sessions-'));
  dirs.push(home);
  const runsDir = join(home, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const indexPath = join(home, 'sessions', 'index.jsonl');
  const out: string[] = [];
  const err: string[] = [];
  const io = { out, err, stdout: { write: (s: string) => out.push(s), columns: 100 }, stderr: { write: (s: string) => err.push(s) }, runsDir, indexPath, workspace: '/w', redact: (s: string) => s, now: () => Date.parse('2026-09-20T15:00:00.000Z'), isAlive: () => false };
  return { home, runsDir, indexPath, io };
}

function writeRun(runsDir: string, runId: string, o: { workspace?: string; source?: 'cli' | 'bench' } = {}): void {
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(makeMeta({ runId, workspace: o.workspace ?? '/w', source: o.source ?? 'cli', sessionId: runId, parentRunId: null, createdAt: '2026-09-20T14:00:00.000Z' })));
  writeFileSync(join(dir, 'state.json'), '{}');
}

describe('sessions list', () => {
  it('prints the header and one row per session of any workspace; --json prints the fold', async () => {
    const s = setup();
    for (const l of finishedRunLines({ sessionId: 'S1', runId: scriptedRunId(1), workspace: '/w', task: 'fix parse_date', cost: { generator: 0.1, jev: 0.01 }, title: 'tz fixes' })) appendIndexLine(s.indexPath, l, (x) => x);
    expect(await commandSessions({ command: 'sessions', sessionsOp: 'list' }, s.io)).toBe(0);
    const text = s.io.out.join('');
    expect(text).toMatch(/^─── sessions/);
    expect(text).toContain('tz fixes');
    s.io.out.length = 0;
    expect(await commandSessions({ command: 'sessions', sessionsOp: 'list', json: true }, s.io)).toBe(0);
    const parsed = JSON.parse(s.io.out.join('')) as { sessions: { sessionId: string }[]; skipped: number };
    expect(parsed.sessions[0]?.sessionId).toBe('S1');
  });
  it('an empty index prints the §24 no-session line and offers reindex when runs exist', async () => {
    const s = setup();
    writeRun(s.runsDir, scriptedRunId(2));
    expect(await commandSessions({ command: 'sessions' }, s.io)).toBe(0);
    expect(s.io.out.join('')).toBe("no session in /w yet\nthe index is missing but runs exist: run 'jevcode sessions reindex'\n");
  });
});

describe('sessions reindex / prune', () => {
  it('rebuilds the index from cli run.json files (bench runs excluded) and prune reports the runs whose directory is gone', async () => {
    const s = setup();
    const a = scriptedRunId(3);
    const b = scriptedRunId(4);
    const bench = scriptedRunId(5);
    writeRun(s.runsDir, a);
    writeRun(s.runsDir, b);
    writeRun(s.runsDir, bench, { source: 'bench' });
    expect(await commandSessions({ command: 'sessions', sessionsOp: 'reindex' }, s.io)).toBe(0);
    expect(s.io.out.join('')).toBe(`reindexed 2 runs into ${s.indexPath}\n`);
    const folded = await readIndex(s.indexPath);
    expect(folded.sessions.map((x) => x.sessionId).sort()).toEqual([a, b].sort());
    // one run dir disappears (moved to trash by the picker): prune drops it and says so
    rmSync(join(s.runsDir, b), { recursive: true, force: true });
    s.io.out.length = 0;
    expect(await commandSessions({ command: 'sessions', sessionsOp: 'prune' }, s.io)).toBe(0);
    expect(s.io.out.join('')).toContain('pruned 1 of 2 indexed runs whose directory is gone');
    expect((await readIndex(s.indexPath)).sessions.map((x) => x.sessionId)).toEqual([a]);
    expect(readFileSync(s.indexPath, 'utf8')).not.toContain(b);
  });
});

describe('sessions unlock (§8.5)', () => {
  it('no run → 2; no lock → 0; a dead pid\'s lock is removed; a live pid is refused with the §24 message', () => {
    const s = setup();
    const id = scriptedRunId(6);
    expect(sessionsUnlock(id, s.io)).toBe(2);
    writeRun(s.runsDir, id);
    expect(sessionsUnlock(id, s.io)).toBe(0);
    expect(s.io.out.join('')).toContain('has no run.lock');
    writeFileSync(join(s.runsDir, id, 'run.lock'), JSON.stringify({ pid: 4242, startedAt: '2026-09-20T14:00:00.000Z', host: 'h' }));
    const live = { ...s.io, isAlive: () => true };
    expect(sessionsUnlock(id, live)).toBe(2);
    expect(s.io.err.join('')).toContain(`run ${id} is in use by pid 4242 since 2026-09-20T14:00:00.000Z (another jevcode?); run 'jevcode sessions unlock ${id}' if that process is gone`);
    expect(sessionsUnlock(id, s.io)).toBe(0);
    expect(s.io.out.join('')).toContain(`removed run.lock of ${id} (pid 4242 is gone)`);
  });
});
