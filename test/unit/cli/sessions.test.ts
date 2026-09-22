/**
 * TUI-DESIGN §1 / §8.2 / §8.5 / §19.0 `src/cli/sessions.ts`: `sessions list` (rows, empty message, the reindex
 * hint, `--json`), `reindex` from run.json files, `prune` reporting runs whose directory is gone, and `unlock`
 * (no lock / dead pid removed / live pid refused with the §24 message).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BROADCAST_TARGET,
  LOCK_REFUSE_REASONS,
  LOCK_REPLACE_REASONS,
  LOCK_REPLACE_SENTENCE,
  SESSIONS_INBOX_JSON_CLAUSE,
  SESSIONS_VERBS,
  WHO_PIPED_COLUMNS,
  commandSessions,
  sessionsUnlock,
  type SessionsAckRow,
  type SessionsCoordination,
  type SessionsDeviceRow,
  type SessionsIo,
  type SessionsTarget,
} from '../../../src/cli/sessions.js';
import { BROADCAST_ALL } from '../../../src/coordination/index.js';
import { SESSIONS_OPS, parseCliArgs } from '../../../src/cli/args.js';
import { whoPlainRow } from '../../../src/session/peers.js';
import { glyphSet } from '../../../src/tui/glyphs.js';
import type { SessionActivityView } from '../../../src/core/types.js';
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
    // TUI-DESIGN-5 §2.10 / §12.1 S38a: the live-lock refusal now names `lockReplaceVerdict`'s own `detail60` shape
    expect(s.io.err.join('')).toContain('pid 4242 is alive on h; not removed');
    expect(sessionsUnlock(id, s.io)).toBe(0);
    // §12.1 S38a: the three REPLACEABLE reasons carry no `detail60`, so the CLI supplies its own sentence
    expect(s.io.out.join('')).toContain(`removed run.lock of ${id} — the lock's pid is gone — taking it`);
  });
});

// ── TUI-DESIGN-5 §2.10 / §10 (slot R5-1): all seventeen verbs over the injected I/O seam ────────────────────────

const VIEW: SessionActivityView = {
  runId: '20260921-234432-rpywkq2v',
  sessionId: '20260921-234432-rpywkq2v',
  label: 'mbp',
  parentSessionId: null,
  deviceId8: 'zz5wq7cd',
  sameDevice: false,
  kind: 'run',
  liveness: 'live',
  authority: 'trusted',
  flags: { hung: false, skewed: false, forked: false, takenOver: false, noLock: false, ignoredDevice: true, unverified: false, cloned: false },
  beatAgeMs: 2_000,
  arrivalAgeMs: 2_000,
  skewMs: null,
  syncLagMs: null,
  sameRepo: true,
  sameBranch: true,
  leaseCount: 0,
  step: 7,
  maxSteps: 40,
  stage: 'propose',
  mode: 'jev-on',
  branch: 'main',
  head: '3f9a2c1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ctxPct: 41,
  spend: { totalUsd: 0.12, capUsd: 2 },
  editing: ['src/loop/engine.ts'],
  subwork: { lanes: 2, samples: 3, probes: 0, children: 0 },
  bench: null,
};

interface FakeCoord extends SessionsCoordination {
  readonly calls: string[];
}

function fakeCoordination(o: { rows?: readonly SessionActivityView[]; skipped?: number; target?: SessionsTarget; devicesPastCap?: readonly string[]; acks?: readonly SessionsAckRow[] } = {}): FakeCoord {
  const calls: string[] = [];
  const devices: SessionsDeviceRow[] = [
    { id8: 'k3q7m2ab', label: 'mbp', paired: true, ignored: false },
    { id8: 'zz5wq7cd', label: 'air', paired: false, ignored: false },
  ];
  return {
    calls,
    self: () => ({ deviceId8: 'k3q7m2ab', label: 'mbp', sameDeviceCount: 1 }),
    activity: async (opts) => {
      calls.push(`activity(all=${String(opts.all === true)})`);
      return o.rows ?? [VIEW];
    },
    skipped: () => o.skipped ?? 0,
    resolve: async (text) => {
      calls.push(`resolve(${text})`);
      return o.target ?? { kind: 'resolved', runId: VIEW.runId, id8: 'rpywkq2v', label: 'mbp' };
    },
    send: async (input) => {
      calls.push(`send(${input.type},${input.to},${input.text})`);
      return { messageId: 'm-1', delivered: 1, refused: [] };
    },
    inbox: async () => {
      calls.push('inbox');
      return [{ id: 'm-1', from: 'air', type: 'heads-up', text: 'editing store.ts', at: '2026-09-21T23:00:00.000Z', unverified: true }];
    },
    acks: async () => {
      calls.push('acks');
      return o.acks ?? [{ msgId: 'm-1', by: 'S1-aaaaaaaa', deviceId: 'k3q7m2ab', at: '2026-09-21T23:00:05.000Z', outcome: 'applied' }];
    },
    label: async (next) => {
      calls.push(`label(${next})`);
      return { id8: 'k3q7m2ab', label: next, paired: true, ignored: false };
    },
    pair: async ({ rotate }) => {
      calls.push(`pair(rotate=${String(rotate)})`);
      return { phrase: 'amber-ferry-lilac-otter', rotated: rotate, devices };
    },
    unpair: async (ref) => {
      calls.push(`unpair(${ref})`);
      return { label: 'air', devices };
    },
    gc: async (opts) => {
      calls.push(`gc(${opts.device ?? '-'})`);
      // §7 row 14: the label resolves past the 16-device fold cap because `gc` walks the DISK to MAX_GC_DEVICES
      const past = (o.devicesPastCap ?? []).includes(opts.device ?? '');
      return { removed: past ? 12 : 3, devices };
    },
    syncStatus: async () => {
      calls.push('syncStatus');
      return { mode: 'shared-dir', state: 'online', lagMs: 4_000, reason: null, devices };
    },
    syncDisable: async () => {
      calls.push('syncDisable');
      return { removed: ['registry', 'leases', 'inbox', 'acks', 'devices'], devices };
    },
    close: async () => {
      calls.push('close');
    },
  };
}

describe('the seventeen verbs (§2.10)', () => {
  it('`SESSIONS_VERBS` is exactly the seventeen §2.10 names, in the documented order', () => {
    expect([...SESSIONS_VERBS]).toEqual(['list', 'reindex', 'prune', 'unlock', 'who', 'pause', 'resume', 'end', 'tell', 'headsup', 'request', 'inbox', 'label', 'pair', 'unpair', 'gc', 'sync']);
    expect(SESSIONS_VERBS).toHaveLength(17);
    expect(new Set(SESSIONS_VERBS).size).toBe(17);
  });

  it('every verb answers honestly — and exits non-zero — when this build has no ledger (D-AN)', async () => {
    for (const verb of SESSIONS_VERBS) {
      if (verb === 'list' || verb === 'reindex' || verb === 'prune' || verb === 'unlock') continue;
      const s = setup();
      const code = await commandSessions({ command: 'sessions' }, { ...s.io, verb, args: ['x'] });
      expect(code, verb).toBe(2);
      expect(s.io.err.join(''), verb).toContain(`jevcode sessions ${verb}: the session ledger is not available in this build`);
    }
  });

  it('the dispatcher closes the ledger in a `finally`, even when the verb refused', async () => {
    const s = setup();
    const coord = fakeCoordination({ target: { kind: 'notFound', text: 'nope', message: 'no session matches "nope"' } });
    await commandSessions({ command: 'sessions', json: true }, { ...s.io, verb: 'pause', args: ['nope'], coordination: coord });
    expect(coord.calls.at(-1)).toBe('close');
  });
});

describe('sessions who (§2.3, §13.3)', () => {
  it('prints the header, one row per session and the flag row; `--all` reaches the fold’s wider list', async () => {
    const s = setup();
    const coord = fakeCoordination();
    expect(await commandSessions({ command: 'sessions' }, { ...s.io, verb: 'who', args: ['--all'], coordination: coord })).toBe(0);
    const text = s.io.out.join('');
    expect(text).toContain('who · 1 live, 0 gone');
    expect(text).toContain('● mbp');
    expect(text).toContain('step 7/40 propose');
    expect(text).toContain('ignored');
    expect(coord.calls).toContain('activity(all=true)');
  });

  it('S8 — the empty state, and S9 only under `--all` (§7 row 11), exactly as `whoRows` gates it', async () => {
    const s = setup();
    expect(await commandSessions({ command: 'sessions' }, { ...s.io, verb: 'who', coordination: fakeCoordination({ rows: [], skipped: 4 }) })).toBe(0);
    expect(s.io.out.join('')).toContain('no other jevcode is working here — /who --all includes sessions gone more than 10 minutes');
    // the TUI builder prints the notice only under `--all`; the CLI printed it always — one fold, two outputs
    expect(s.io.out.join('')).not.toContain('past the fold cap');
    const all = setup();
    expect(await commandSessions({ command: 'sessions' }, { ...all.io, verb: 'who', args: ['--all'], coordination: fakeCoordination({ rows: [], skipped: 4 }) })).toBe(0);
    expect(all.io.out.join('')).toContain('4 devices past the fold cap — jevcode sessions gc lists them');
  });

  it('§13.2 clause 1: piped (no TTY width) renders the 120-column form, not the 80-column one', async () => {
    const s = setup();
    const piped: SessionsIo = { ...s.io, stdout: { write: (x: string) => s.io.out.push(x) } };
    expect(WHO_PIPED_COLUMNS).toBe(120);
    expect(await commandSessions({ command: 'sessions' }, { ...piped, verb: 'who', coordination: fakeCoordination() })).toBe(0);
    const g = glyphSet({});
    // this fixture's peer shares the label `mbp` with THIS device, so §2.3 qualifies both — and the twin agrees
    const label = `mbp#${VIEW.deviceId8}`;
    expect(s.io.out.join('')).toContain(whoPlainRow(VIEW, { width: WHO_PIPED_COLUMNS, g, label }));
    // the 80-column form is strictly narrower, and is NOT what a pipe gets
    expect(whoPlainRow(VIEW, { width: 80, g, label }).length).toBeLessThan(whoPlainRow(VIEW, { width: WHO_PIPED_COLUMNS, g, label }).length);
  });

  it('gate G-R5-6: at 40 columns every `who` line fits, the eight-flag row included', async () => {
    const s = setup();
    const flagged: SessionActivityView = { ...VIEW, flags: { hung: true, skewed: true, forked: true, takenOver: true, noLock: true, ignoredDevice: true, unverified: true, cloned: true }, skewMs: 412_000 };
    const io: SessionsIo = { ...s.io, stdout: { write: (x: string) => s.io.out.push(x), columns: 40 } };
    expect(await commandSessions({ command: 'sessions' }, { ...io, verb: 'who', coordination: fakeCoordination({ rows: [flagged] }) })).toBe(0);
    const lines = s.io.out.join('').split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(3);
    for (const line of lines) expect([...line].length, line).toBeLessThanOrEqual(40);
  });

  it('§12.1 S1–S5 SR: `screenReader` makes each row the spoken sentence', async () => {
    const s = setup();
    expect(await commandSessions({ command: 'sessions' }, { ...s.io, screenReader: true, verb: 'who', coordination: fakeCoordination() })).toBe(0);
    expect(s.io.out.join('')).toContain(`mbp#${VIEW.deviceId8}, live, main at 3f9a2c1, step 7 of 40 propose`);
    expect(s.io.out.join('')).toContain('spent 12 cents of 2 dollars');
  });

  it('--json emits the TWO VIEWS and never a `hostKey` (§13.3, §7 row 61)', async () => {
    const s = setup();
    expect(await commandSessions({ command: 'sessions', json: true }, { ...s.io, verb: 'who', coordination: fakeCoordination() })).toBe(0);
    const parsed = JSON.parse(s.io.out.join('')) as { sessions: unknown[]; self: Record<string, unknown>; at: string };
    expect(Object.keys(parsed).sort()).toEqual(['at', 'self', 'sessions']);
    expect(Object.keys(parsed.self).sort()).toEqual(['deviceId8', 'label', 'sameDeviceCount']);
    expect(parsed.sessions).toEqual([VIEW]);
    expect(s.io.out.join('')).not.toContain('hostKey');
    expect(parsed.at).toBe('2026-09-20T15:00:00.000Z');
  });
});

describe('sessions pause | resume | end (§2.6, §2.7, §13.3)', () => {
  it.each(['pause', 'resume', 'end'] as const)('%s <target> [now] routes one message and answers `{ ok, runId, at, reason }`', async (verb) => {
    const s = setup();
    const coord = fakeCoordination();
    expect(await commandSessions({ command: 'sessions', json: true }, { ...s.io, verb, args: ['mbp', 'now'], coordination: coord })).toBe(0);
    expect(JSON.parse(s.io.out.join(''))).toEqual({ ok: true, runId: VIEW.runId, at: 'now', reason: 'asked mbp' });
    expect(coord.calls).toContain(`send(${verb},${VIEW.runId},${verb} now)`);
  });

  it('with no `now` the default is the step boundary', async () => {
    const s = setup();
    expect(await commandSessions({ command: 'sessions', json: true }, { ...s.io, verb: 'pause', args: ['mbp'], coordination: fakeCoordination() })).toBe(0);
    expect((JSON.parse(s.io.out.join('')) as { at: string }).at).toBe('step');
  });

  it('a missing target is refused before any write', async () => {
    const s = setup();
    const coord = fakeCoordination();
    expect(await commandSessions({ command: 'sessions' }, { ...s.io, verb: 'end', args: [], coordination: coord })).toBe(2);
    expect(s.io.err.join('')).toContain('jevcode sessions end needs a target');
    expect(coord.calls.filter((c) => c.startsWith('send'))).toEqual([]);
  });

  it('§13.3: an AMBIGUOUS target emits the `TargetResult` fields, never a re-modelled shape', async () => {
    const s = setup();
    const target: SessionsTarget = { kind: 'ambiguous', text: 'fix', candidates: [{ id8: 'aaaaaaaa', title60: 'fix store', label: 'mbp' }, { id8: 'bbbbbbbb', title60: 'fix tz', label: 'air' }], truncated: false, message: '2 sessions match "fix" — aaaaaaaa, bbbbbbbb' };
    expect(await commandSessions({ command: 'sessions', json: true }, { ...s.io, verb: 'pause', args: ['fix'], coordination: fakeCoordination({ target }) })).toBe(2);
    expect(JSON.parse(s.io.out.join(''))).toEqual({ ok: false, reason: 'ambiguous', candidates: target.candidates, message: target.message });
  });

  it('§13.3: a NOT-FOUND target emits `{ ok:false, reason:"notFound", message }` with no `candidates` key', async () => {
    const s = setup();
    const target: SessionsTarget = { kind: 'notFound', text: 'zzz', message: 'no session matches "zzz"' };
    expect(await commandSessions({ command: 'sessions', json: true }, { ...s.io, verb: 'resume', args: ['zzz'], coordination: fakeCoordination({ target }) })).toBe(2);
    const parsed = JSON.parse(s.io.out.join('')) as Record<string, unknown>;
    expect(parsed).toEqual({ ok: false, reason: 'notFound', message: 'no session matches "zzz"' });
    expect('candidates' in parsed).toBe(false);
  });
});

describe('sessions tell | headsup | request (§2.9, §13.3)', () => {
  it.each([['tell', 'note'], ['request', 'request-release']] as const)('%s <target> <text> maps to the `%s` message type and answers the four-field shape', async (verb, type) => {
    const s = setup();
    const coord = fakeCoordination();
    expect(await commandSessions({ command: 'sessions', json: true }, { ...s.io, verb, args: ['mbp', 'commit', 'and', 'move', 'on'], coordination: coord })).toBe(0);
    expect(JSON.parse(s.io.out.join(''))).toEqual({ ok: true, messageId: 'm-1', delivered: 1, refused: [] });
    expect(coord.calls).toContain(`send(${type},${VIEW.runId},commit and move on)`);
  });

  it('§2.9: `headsup <text>` is a BROADCAST with NO target — the whole tail is the body', async () => {
    const s = setup();
    const coord = fakeCoordination();
    expect(await commandSessions({ command: 'sessions', json: true }, { ...s.io, verb: 'headsup', args: ['editing', 'src/loop/engine.ts'], coordination: coord })).toBe(0);
    expect(JSON.parse(s.io.out.join(''))).toEqual({ ok: true, messageId: 'm-1', delivered: 1, refused: [] });
    // `editing` is the first word of the MESSAGE, never a target: nothing is resolved at all
    expect(coord.calls.filter((c) => c.startsWith('resolve'))).toEqual([]);
    expect(coord.calls).toContain(`send(heads-up,${BROADCAST_TARGET},editing src/loop/engine.ts)`);
  });

  it('the re-declared broadcast target is the facade’s own `BROADCAST_ALL` (§2.1 rule 6)', () => {
    expect(BROADCAST_TARGET).toBe(BROADCAST_ALL);
  });

  it('`headsup` with no text at all is refused before any write', async () => {
    const s = setup();
    const coord = fakeCoordination();
    expect(await commandSessions({ command: 'sessions' }, { ...s.io, verb: 'headsup', args: [], coordination: coord })).toBe(2);
    expect(s.io.err.join('')).toContain('jevcode sessions headsup needs a message');
    expect(coord.calls.filter((c) => c.startsWith('send'))).toEqual([]);
  });

  it('§7 row 93: the body goes through the caller’s redactor before the write', async () => {
    const s = setup();
    const coord = fakeCoordination();
    await commandSessions({ command: 'sessions', json: true }, { ...s.io, redact: (x) => x.replace('sk-live-abc', '[redacted]'), verb: 'tell', args: ['mbp', 'the', 'key', 'is', 'sk-live-abc'], coordination: coord });
    expect(coord.calls.join('')).toContain('the key is [redacted]');
    expect(coord.calls.join('')).not.toContain('sk-live-abc');
  });

  it('a DIRECTED verb with a target and no message is refused', async () => {
    const s = setup();
    const coord = fakeCoordination();
    expect(await commandSessions({ command: 'sessions' }, { ...s.io, verb: 'tell', args: ['mbp'], coordination: coord })).toBe(2);
    expect(s.io.err.join('')).toContain('needs a message after the target');
    expect(coord.calls.filter((c) => c.startsWith('send'))).toEqual([]);
  });
});

describe('sessions inbox (§2.9, §13.3)', () => {
  it('prints one row per message with `(unverified)` on an unpaired sender (§7 row 18); --json emits `{ messages, acks }`', async () => {
    const s = setup();
    expect(await commandSessions({ command: 'sessions' }, { ...s.io, verb: 'inbox', coordination: fakeCoordination() })).toBe(0);
    expect(s.io.out.join('')).toBe('air (unverified) heads-up: editing store.ts\n');
    const j = setup();
    expect(await commandSessions({ command: 'sessions', json: true }, { ...j.io, verb: 'inbox', coordination: fakeCoordination() })).toBe(0);
    const parsed = JSON.parse(j.io.out.join('')) as { messages: unknown[]; acks: Record<string, unknown>[] };
    expect(Object.keys(parsed).sort()).toEqual(['acks', 'messages']);
    // §13.2's eighth clause: `acks` is a REAL read, and neither projection carries a hostKey / checksum / hmac
    expect(parsed.acks).toEqual([{ msgId: 'm-1', by: 'S1-aaaaaaaa', deviceId: 'k3q7m2ab', at: '2026-09-21T23:00:05.000Z', outcome: 'applied' }]);
    for (const key of ['hostKey', 'checksum', 'hmac']) expect(j.io.out.join('')).not.toContain(key);
    expect(SESSIONS_INBOX_JSON_CLAUSE).toContain('no hostKey');
  });

  it('a build whose seam has no ack read still emits the shape, with an honest empty list', async () => {
    const s = setup();
    const coord = fakeCoordination();
    const { acks: _acks, ...noAcks } = coord;
    expect(await commandSessions({ command: 'sessions', json: true }, { ...s.io, verb: 'inbox', coordination: noAcks as SessionsCoordination })).toBe(0);
    expect((JSON.parse(s.io.out.join('')) as { acks: unknown[] }).acks).toEqual([]);
  });
});

describe('sessions label | pair | unpair | gc | sync (§2.10, §13.3 — one device-list shape)', () => {
  it('label renames this device', async () => {
    const s = setup();
    const coord = fakeCoordination();
    expect(await commandSessions({ command: 'sessions' }, { ...s.io, verb: 'label', args: ['studio'], coordination: coord })).toBe(0);
    expect(s.io.out.join('')).toBe('this device is now "studio" (k3q7m2ab)\n');
    expect(coord.calls).toContain('label(studio)');
    const empty = setup();
    expect(await commandSessions({ command: 'sessions' }, { ...empty.io, verb: 'label', args: [], coordination: fakeCoordination() })).toBe(2);
  });

  it('pair prints the PHRASE and never a key; `--rotate` prints S36 first', async () => {
    const s = setup();
    expect(await commandSessions({ command: 'sessions' }, { ...s.io, verb: 'pair', coordination: fakeCoordination() })).toBe(0);
    expect(s.io.out.join('')).toBe('pairing phrase: amber-ferry-lilac-otter\n');
    const r = setup();
    expect(await commandSessions({ command: 'sessions' }, { ...r.io, verb: 'pair', args: ['--rotate'], coordination: fakeCoordination() })).toBe(0);
    expect(r.io.out.join('')).toContain('this device took a new id (k3q7m2ab) and a new key — run \'jevcode sessions pair\' with each peer again');
    expect(/[0-9a-f]{32,}/.test(r.io.out.join(''))).toBe(false);
  });

  it('S35 — unpair prints the whole sentence, never a silent continue (§7 row 19)', async () => {
    const s = setup();
    expect(await commandSessions({ command: 'sessions' }, { ...s.io, verb: 'unpair', args: ['air'], coordination: fakeCoordination() })).toBe(0);
    expect(s.io.out.join('')).toBe("unpaired air — it can no longer steer, stop, resume, end or import your runs. It still holds this device's key: run 'jevcode sessions pair --rotate' to invalidate it everywhere.\n");
  });

  it('§7 row 14 — `gc --device <label>` resolves a label PAST the 16-device fold cap', async () => {
    const s = setup();
    const coord = fakeCoordination({ devicesPastCap: ['ancient-laptop'] });
    expect(await commandSessions({ command: 'sessions' }, { ...s.io, verb: 'gc', args: ['--device', 'ancient-laptop'], coordination: coord })).toBe(0);
    // the seam walks the DISK (MAX_GC_DEVICES = 1,024), so the junk past the fold's 16 is reachable and removed
    expect(coord.calls).toContain('gc(ancient-laptop)');
    expect(s.io.out.join('')).toBe('gc removed 12 records of ancient-laptop\n');
    const bare = setup();
    await commandSessions({ command: 'sessions' }, { ...bare.io, verb: 'gc', coordination: fakeCoordination() });
    expect(bare.io.out.join('')).toBe('gc removed 3 records\n');
    const missing = setup();
    expect(await commandSessions({ command: 'sessions' }, { ...missing.io, verb: 'gc', args: ['--device'], coordination: fakeCoordination() })).toBe(2);
    expect(missing.io.err.join('')).toContain('gc --device needs a device');
  });

  it('sync defaults to `status`, accepts `disable`, and refuses anything else', async () => {
    const s = setup();
    expect(await commandSessions({ command: 'sessions' }, { ...s.io, verb: 'sync', coordination: fakeCoordination() })).toBe(0);
    expect(s.io.out.join('')).toBe('sync shared-dir: online (lag 4s)\n');
    const d = setup();
    expect(await commandSessions({ command: 'sessions' }, { ...d.io, verb: 'sync', args: ['disable'], coordination: fakeCoordination() })).toBe(0);
    expect(d.io.out.join('')).toBe('sync disabled — removed 5 subtrees from the mirror\n');
    const bad = setup();
    expect(await commandSessions({ command: 'sessions' }, { ...bad.io, verb: 'sync', args: ['off'], coordination: fakeCoordination() })).toBe(2);
    expect(bad.io.err.join('')).toContain('expected status|disable, got "off"');
  });

  it('§13.3: `pair|unpair|label|gc|sync --json` all emit `{ ok, devices: {id8,label,paired,ignored}[] }`', async () => {
    for (const [verb, args] of [['label', ['studio']], ['pair', []], ['unpair', ['air']], ['gc', []], ['sync', ['status']]] as const) {
      const s = setup();
      expect(await commandSessions({ command: 'sessions', json: true }, { ...s.io, verb, args: [...args], coordination: fakeCoordination() }), verb).toBe(0);
      const parsed = JSON.parse(s.io.out.join('')) as { ok: boolean; devices: Record<string, unknown>[] };
      expect(parsed.ok, verb).toBe(true);
      for (const d of parsed.devices) expect(Object.keys(d).sort(), verb).toEqual(['id8', 'ignored', 'label', 'paired']);
    }
  });
});

describe('the verb/flag surface (§2.10, §9.2 — the `args.ts` hunk owed to R5-6)', () => {
  it('the documented precedence holds: a verb `args.ts` PARSED wins over the injected seam', async () => {
    const s = setup();
    // both supplied: `flags.sessionsOp` is what the `SessionsIo.verb` doc comment says wins
    expect(await commandSessions({ command: 'sessions', sessionsOp: 'reindex' }, { ...s.io, verb: 'who', coordination: fakeCoordination() })).toBe(0);
    expect(s.io.out.join('')).toContain('reindexed 0 runs');
    const seam = setup();
    expect(await commandSessions({ command: 'sessions' }, { ...seam.io, verb: 'who', coordination: fakeCoordination() })).toBe(0);
    expect(seam.io.out.join('')).toContain('who · 1 live, 0 gone');
  });

  it('`--all`, `--device <label>` and `--rotate` are read from the PARSED flags too, not only the raw tail', async () => {
    const all = setup();
    const coordAll = fakeCoordination();
    expect(await commandSessions({ command: 'sessions', all: true }, { ...all.io, verb: 'who', coordination: coordAll })).toBe(0);
    expect(coordAll.calls).toContain('activity(all=true)');
    const gc = setup();
    const coordGc = fakeCoordination({ devicesPastCap: ['ancient-laptop'] });
    expect(await commandSessions({ command: 'sessions', ...{ device: 'ancient-laptop' } }, { ...gc.io, verb: 'gc', coordination: coordGc })).toBe(0);
    expect(coordGc.calls).toContain('gc(ancient-laptop)');
    const pair = setup();
    const coordPair = fakeCoordination();
    expect(await commandSessions({ command: 'sessions', ...{ rotate: true } }, { ...pair.io, verb: 'pair', coordination: coordPair })).toBe(0);
    expect(coordPair.calls).toContain('pair(rotate=true)');
  });

  /**
   * §9.2 / §2.10: the integration pass landed R5-1's `src/cli/args.ts` hunk in R5-6's file, so this test is the
   * FLIP its earlier form was written for — every one of the seventeen verbs parses, the words after the verb
   * reach `commandSessions` as `sessionsArgs`, and `--all` / `--device` / `--rotate` are real flags rather than
   * unknown ones. `SessionsIo.verb`/`args` is still the seam the verbs are driven by; argv now feeds it.
   */
  it('argv: the seventeen verbs parse, their words become `sessionsArgs`, and `--all`/`--device`/`--rotate` are flags (§2.10)', () => {
    expect(SESSIONS_OPS).toHaveLength(17);
    for (const op of SESSIONS_OPS) expect(parseCliArgs(['sessions', op === 'unlock' ? 'list' : op]).sessionsOp, op).toBe(op === 'unlock' ? 'list' : op);
    expect(parseCliArgs(['sessions', 'who', '--all']).sessionsOp).toBe('who');
    expect(parseCliArgs(['sessions', 'who', '--all']).all).toBe(true);
    expect(parseCliArgs(['sessions', 'gc', '--device', 'ancient-laptop']).device).toBe('ancient-laptop');
    expect(parseCliArgs(['sessions', 'pair', '--rotate']).rotate).toBe(true);
    // §2.10: the words after the verb are the verb's own arguments and reach the command verbatim
    expect(parseCliArgs(['sessions', 'tell', 'mbp', 'do', 'not', 'touch', 'the', 'tests']).sessionsArgs).toEqual(['mbp', 'do', 'not', 'touch', 'the', 'tests']);
    expect(parseCliArgs(['sessions', 'label', 'mbp']).sessionsArgs).toEqual(['mbp']);
    expect(parseCliArgs(['sessions', 'list']).sessionsArgs).toBeUndefined();
    // the three read verbs still refuse a stray word, and `unlock` still needs exactly one run id
    expect(() => parseCliArgs(['sessions', 'list', 'nonsense'])).toThrow(/takes no further arguments/);
    expect(() => parseCliArgs(['sessions', 'unlock'])).toThrow();
    expect(() => parseCliArgs(['sessions', 'nope'])).toThrow(/expected one of list\|reindex\|prune\|unlock\|who/);
    // the four verbs that always parsed still parse, and `--json` still reaches them
    expect(parseCliArgs(['sessions', 'prune', '--json']).sessionsOp).toBe('prune');
  });
});

describe('sessions unlock — the six `LockReplace` reasons (§2.10, §12.1 S38a, §14.2 #26)', () => {
  it('`LOCK_REPLACE_REASONS` is the full six-word vocabulary, split into the replaceable three and the refusing three', () => {
    expect([...LOCK_REPLACE_REASONS]).toEqual(['no-lock', 'dead-pid', 'other-boot', 'peer-live', 'boot-unknown', 'held']);
    expect(Object.keys(LOCK_REPLACE_SENTENCE).sort()).toEqual(['dead-pid', 'no-lock', 'other-boot']);
    expect([...LOCK_REFUSE_REASONS]).toEqual(['peer-live', 'boot-unknown', 'held']);
    expect([...Object.keys(LOCK_REPLACE_SENTENCE), ...LOCK_REFUSE_REASONS].sort()).toEqual([...LOCK_REPLACE_REASONS].sort());
  });

  it('the three REPLACEABLE reasons carry NO `detail60` and emit the CLI’s own S38a sentence', () => {
    expect(LOCK_REPLACE_SENTENCE['no-lock']).toBe('no lock file — taking it');
    expect(LOCK_REPLACE_SENTENCE['dead-pid']).toBe("the lock's pid is gone — taking it");
    expect(LOCK_REPLACE_SENTENCE['other-boot']).toBe('the lock is from another boot — taking it');
    const s = setup();
    const id = scriptedRunId(7);
    writeRun(s.runsDir, id);
    // no lock
    expect(sessionsUnlock(id, s.io, { command: 'sessions', json: true })).toBe(0);
    expect(JSON.parse(s.io.out.join(''))).toEqual({ ok: true, reason: 'no-lock' });
    expect('detail60' in (JSON.parse(s.io.out.join('')) as object)).toBe(false);
    // dead pid
    const dead = setup();
    writeRun(dead.runsDir, id);
    writeFileSync(join(dead.runsDir, id, 'run.lock'), JSON.stringify({ pid: 4242, startedAt: '2026-09-20T14:00:00.000Z', host: 'h' }));
    expect(sessionsUnlock(id, dead.io, { command: 'sessions', json: true })).toBe(0);
    expect(JSON.parse(dead.io.out.join(''))).toEqual({ ok: true, reason: 'dead-pid' });
  });

  it('a refusing reason DOES carry `detail60` — the asymmetry is a documented state, not a blank cell', () => {
    const s = setup();
    const id = scriptedRunId(8);
    writeRun(s.runsDir, id);
    writeFileSync(join(s.runsDir, id, 'run.lock'), JSON.stringify({ pid: 4242, startedAt: '2026-09-20T14:00:00.000Z', host: 'h' }));
    expect(sessionsUnlock(id, { ...s.io, isAlive: () => true }, { command: 'sessions', json: true })).toBe(2);
    expect(JSON.parse(s.io.out.join(''))).toEqual({ ok: false, reason: 'peer-live', detail60: 'pid 4242 is alive on h' });
  });

  it('every one of the six reasons is PRODUCED by the verb, not just exported as a constant', () => {
    const BOOT = '2026-09-20T09:00:00.000Z';
    const lock = (extra: Record<string, unknown> = {}): string => JSON.stringify({ pid: 4242, startedAt: '2026-09-20T14:00:00.000Z', host: 'h', ...extra });
    const run = (o: { lock?: string; alive: boolean; host: string; bootAt?: string }): { code: number; json: Record<string, unknown> } => {
      const s = setup();
      const id = scriptedRunId(10);
      writeRun(s.runsDir, id);
      if (o.lock !== undefined) writeFileSync(join(s.runsDir, id, 'run.lock'), o.lock);
      const code = sessionsUnlock(id, { ...s.io, isAlive: () => o.alive, hostname: o.host, bootAt: o.bootAt ?? BOOT }, { command: 'sessions', json: true });
      return { code, json: JSON.parse(s.io.out.join('')) as Record<string, unknown> };
    };
    // the three REPLACEABLE reasons: exit 0, no `detail60`
    expect(run({ alive: false, host: 'h' })).toEqual({ code: 0, json: { ok: true, reason: 'no-lock' } });
    expect(run({ lock: lock(), alive: false, host: 'h' })).toEqual({ code: 0, json: { ok: true, reason: 'dead-pid' } });
    expect(run({ lock: lock({ bootAt: '2026-09-19T09:00:00.000Z' }), alive: true, host: 'h' })).toEqual({ code: 0, json: { ok: true, reason: 'other-boot' } });
    // the three REFUSING reasons: exit 2, each with its own `detail60`
    const peer = run({ lock: lock(), alive: true, host: 'other-machine' });
    expect(peer.code).toBe(2);
    expect(peer.json).toEqual({ ok: false, reason: 'peer-live', detail60: 'pid 4242 is alive on h' });
    const unknownBoot = run({ lock: lock(), alive: true, host: 'h' });
    expect(unknownBoot.code).toBe(2);
    expect(unknownBoot.json['reason']).toBe('boot-unknown');
    expect(String(unknownBoot.json['detail60']).length).toBeLessThanOrEqual(60);
    const held = run({ lock: lock({ bootAt: BOOT }), alive: true, host: 'h' });
    expect(held.code).toBe(2);
    expect(held.json).toEqual({ ok: false, reason: 'held', detail60: 'pid 4242 holds this run on this boot' });
  });

  it('S38a: the `other-boot` sentence finally has a caller', () => {
    const s = setup();
    const id = scriptedRunId(11);
    writeRun(s.runsDir, id);
    writeFileSync(join(s.runsDir, id, 'run.lock'), JSON.stringify({ pid: 4242, startedAt: '2026-09-20T14:00:00.000Z', host: 'h', bootAt: '2026-09-19T09:00:00.000Z' }));
    expect(sessionsUnlock(id, { ...s.io, isAlive: () => true, hostname: 'h', bootAt: '2026-09-20T09:00:00.000Z' })).toBe(0);
    expect(s.io.out.join('')).toContain('the lock is from another boot — taking it');
  });

  it('the plain twin prints the S38a sentence for each replaceable reason', () => {
    const s = setup();
    const id = scriptedRunId(9);
    writeRun(s.runsDir, id);
    expect(sessionsUnlock(id, s.io)).toBe(0);
    expect(s.io.out.join('')).toContain(LOCK_REPLACE_SENTENCE['no-lock']);
    writeFileSync(join(s.runsDir, id, 'run.lock'), JSON.stringify({ pid: 4242, startedAt: '2026-09-20T14:00:00.000Z', host: 'h' }));
    expect(sessionsUnlock(id, s.io)).toBe(0);
    expect(s.io.out.join('')).toContain(LOCK_REPLACE_SENTENCE['dead-pid']);
  });
});
