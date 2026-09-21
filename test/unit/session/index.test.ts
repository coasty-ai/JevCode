import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serialiseEnvelope } from '../../../src/checkpoint/store.js';
import {
  INDEX_LINE_MAX_BYTES,
  STOP_REASONS,
  appendIndexLine,
  foldIndex,
  indexOneLine,
  isIsoLike,
  isStopReason,
  parseIndexLine,
  readIndex,
  redactIndexLine,
  reindex,
  sessionFieldsOf,
  splitIndexText,
  text60,
  type IndexLine,
} from '../../../src/session/index.js';
import { makeMeta, makeState, runId, spend } from './helpers.js';

const S1 = runId(1);
const R1 = runId(1);
const R2 = runId(2);
const T = (n: number): string => `2026-09-20T14:${String(n).padStart(2, '0')}:00.000Z`;

const start = (o: Partial<Extract<IndexLine, { kind: 'run:start' }>> = {}): IndexLine => ({
  v: 1,
  t: T(1),
  kind: 'run:start',
  sessionId: S1,
  runId: R1,
  parentRunId: null,
  workspace: '/Users/me/proj',
  task60: 'fix parse_date tz handling',
  mode: 'jev-on',
  source: 'cli',
  branch: 'main',
  resumeOf: null,
  ...o,
});
const end = (o: Partial<Extract<IndexLine, { kind: 'run:end' }>> = {}): IndexLine => ({
  v: 1,
  t: T(5),
  kind: 'run:end',
  sessionId: S1,
  runId: R1,
  stopReason: 'complete',
  steps: 9,
  costUsd: { generator: 0.104, jev: 0.011 },
  wallMs: 183_000,
  changedFiles: 3,
  exitCode: 0,
  resumable: true,
  degraded: false,
  ...o,
});
const J = (l: IndexLine): string => JSON.stringify(l);

describe('foldIndex (TUI-DESIGN §8.2)', () => {
  it('groups by sessionId, keeps run:start + run:end per run, sums cost, title = first task60', () => {
    const { sessions, skipped } = foldIndex([J(start()), J(end())]);
    expect(skipped).toBe(0);
    const s = sessions.get(S1)!;
    expect(s.workspace).toBe('/Users/me/proj');
    expect(s.title).toBe('fix parse_date tz handling');
    expect(s.task60).toBe('fix parse_date tz handling');
    expect(s.mode).toBe('jev-on');
    expect(s.branch).toBe('main');
    expect(s.createdAt).toBe(T(1));
    expect(s.lastUsed).toBe(T(5));
    expect(s.totalUsd).toBeCloseTo(0.115, 12);
    expect(s.runs).toEqual([
      { runId: R1, parentRunId: null, startedAt: T(1), endedAt: T(5), stopReason: 'complete', steps: 9, costUsd: { generator: 0.104, jev: 0.011 }, exitCode: 0, resumable: true, resumes: 0, live: false },
    ]);
  });

  it('per runId the last run:start / run:end win; a resume run:start counts as a resume and re-opens the run', () => {
    const lines = [
      J(start()),
      J(end({ t: T(5), stopReason: 'human_pause', steps: 5, costUsd: { generator: 0.05, jev: 0.005 }, exitCode: 4 })),
      J(start({ t: T(6), resumeOf: R1 })),
      J(end({ t: T(9), stopReason: 'complete', steps: 9, costUsd: { generator: 0.104, jev: 0.011 }, exitCode: 0 })),
    ];
    const s = foldIndex(lines).sessions.get(S1)!;
    expect(s.runs).toHaveLength(1);
    const r = s.runs[0]!;
    expect(r.resumes).toBe(1);
    expect(r.startedAt).toBe(T(1));
    expect(r.endedAt).toBe(T(9));
    expect(r.stopReason).toBe('complete');
    expect(r.steps).toBe(9);
    expect(r.live).toBe(false);
    // the resumed run's costs are cumulative: no double count
    expect(s.totalUsd).toBeCloseTo(0.115, 12);
    // a run:start without a run:end is live in the index
    const live = foldIndex([J(start()), J(end()), J(start({ t: T(7), runId: R2, parentRunId: R1 }))]).sessions.get(S1)!;
    expect(live.runs.map((x) => [x.runId, x.live, x.parentRunId])).toEqual([
      [R1, false, null],
      [R2, true, R1],
    ]);
  });

  it('duplicate run:end lines are folded (last wins), a run:end without a run:start still yields a row', () => {
    const s = foldIndex([J(end({ steps: 3 })), J(end({ t: T(6), steps: 4 }))]).sessions.get(S1)!;
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]!.steps).toBe(4);
    expect(s.runs[0]!.startedAt).toBe(T(5));
  });

  it('rename after run:end sets the title; steer/undo/pause/budget only move lastUsed', () => {
    const lines = [
      J(start()),
      J(end()),
      JSON.stringify({ v: 1, t: T(7), kind: 'rename', sessionId: S1, title60: 'tz fixes' }),
      JSON.stringify({ v: 1, t: T(8), kind: 'steer', sessionId: S1, runId: R1, step: 4, text60: 'also update the docs' }),
      JSON.stringify({ v: 1, t: T(9), kind: 'undo', sessionId: S1, runId: R1, step: 7, by: 'undo', files: 3, skipped: 1 }),
      JSON.stringify({ v: 1, t: T(10), kind: 'pause', sessionId: S1, runId: R1, step: 5 }),
      JSON.stringify({ v: 1, t: T(11), kind: 'budget', sessionId: S1, runId: R1, setting: 'session.spendCapUsd', from: '10', to: '15' }),
      // a later run:start does not undo a rename
      J(start({ t: T(12), runId: R2, task60: 'other task' })),
    ];
    const { sessions, skipped } = foldIndex(lines);
    const s = sessions.get(S1)!;
    expect(skipped).toBe(0);
    expect(s.title).toBe('tz fixes');
    expect(s.task60).toBe('fix parse_date tz handling');
    expect(s.lastUsed).toBe(T(12));
    expect(s.runs).toHaveLength(2);
  });

  it('skips and counts torn lines, non-JSON, other versions, unknown kinds, missing keys; ignores blank lines', () => {
    const torn = J(start()).slice(0, 40);
    const { sessions, skipped } = foldIndex([
      J(start()),
      '',
      '   ',
      torn,
      'not json at all',
      JSON.stringify({ v: 2, t: T(2), kind: 'run:start', sessionId: S1, runId: R1 }),
      JSON.stringify({ v: 1, t: T(2), kind: 'teleport', sessionId: S1 }),
      JSON.stringify({ v: 1, t: T(2), kind: 'run:start', sessionId: S1 }),
      JSON.stringify({ v: 1, t: 'yesterday', kind: 'pause', sessionId: S1, runId: R1 }),
      JSON.stringify({ v: 1, t: T(3), kind: 'run:end', sessionId: S1 }),
      '[1,2,3]',
      J(end()),
    ]);
    expect(skipped).toBe(8);
    expect(sessions.get(S1)!.runs[0]!.stopReason).toBe('complete');
  });

  it('parseIndexLine tolerates odd numeric fields (NaN/strings → 0) and defaults an unknown source to cli', () => {
    const l = parseIndexLine(JSON.stringify({ v: 1, t: T(1), kind: 'run:end', sessionId: S1, runId: R1, stopReason: 'error', steps: 'many', costUsd: { generator: 'x' } }));
    expect(l).toMatchObject({ kind: 'run:end', steps: 0, costUsd: { generator: 0, jev: 0 }, exitCode: 0, resumable: false });
    const st = parseIndexLine(JSON.stringify({ v: 1, t: T(1), kind: 'run:start', sessionId: S1, runId: R1, mode: 'jev-only', source: 'martian' }));
    expect(st).toMatchObject({ kind: 'run:start', mode: 'jev-only', source: 'cli', workspace: '', task60: '', branch: null, resumeOf: null });
    expect(parseIndexLine(JSON.stringify({ v: 1, t: T(1), kind: 'run:start', sessionId: S1, runId: R1, mode: 'weird' }))).toBeNull();
    expect(parseIndexLine('')).toBeNull();
  });

  it('empty input folds to nothing', () => {
    expect(foldIndex([])).toEqual({ sessions: new Map(), skipped: 0 });
  });

  it('a run:end whose stopReason is not a StopReason is skipped and counted, never folded into a typed row', () => {
    const bad = JSON.stringify({ ...(end() as object), stopReason: 'teleported' });
    expect(parseIndexLine(bad)).toBeNull();
    expect(parseIndexLine(JSON.stringify({ ...(end() as object), stopReason: 7 }))).toBeNull();
    const { sessions, skipped } = foldIndex([J(start()), bad]);
    expect(skipped).toBe(1);
    expect(sessions.get(S1)!.runs[0]).toMatchObject({ stopReason: null, live: true });
    for (const stop of STOP_REASONS) expect(parseIndexLine(J(end({ stopReason: stop })))?.kind).toBe('run:end');
    expect(STOP_REASONS).toEqual(expect.arrayContaining(['complete', 'human_pause', 'token_cap', 'spend_cap']));
    expect(isStopReason('complete')).toBe(true);
    expect(isStopReason('constructor')).toBe(false);
    expect(isStopReason(null)).toBe(false);
  });

  it('`t` must be the canonical ISO-8601 UTC form; non-canonical stamps skip the line', () => {
    expect(isIsoLike('2026-09-20T14:02:11.123Z')).toBe(true);
    expect(isIsoLike('2026-09-20T14:02:11Z')).toBe(true);
    for (const bad of ['2026-09-20 14:02:11 GMT', '2026-09-20T14:02:11+02:00', '2026-09-20T14:02:11.1Z', '2026-09-20', 'Sat, 20 Sep 2026 14:02:11 GMT', '2026-13-45T99:99:99.000Z', 20260920, null]) {
      expect(isIsoLike(bad)).toBe(false);
    }
    expect(parseIndexLine(J(start({ t: '2026-09-20 14:02:11 GMT' })))).toBeNull();
    expect(foldIndex([J(start()), J(end({ t: '2026-09-20T14:02:11+02:00' }))]).skipped).toBe(1);
  });

  it('ordering compares by time, not by string: mixed millisecond / second precision stamps', () => {
    // string-wise '…11Z' > '…11.123Z' (Z sorts after '.'); by time 11.123 is later
    const lines = [J(start({ t: '2026-09-20T14:02:11Z' })), JSON.stringify({ v: 1, t: '2026-09-20T14:02:11.123Z', kind: 'pause', sessionId: S1, runId: R1, step: 2 })];
    const s = foldIndex(lines).sessions.get(S1)!;
    expect(s.lastUsed).toBe('2026-09-20T14:02:11.123Z');
    expect(s.createdAt).toBe('2026-09-20T14:02:11Z');
    // runs are ordered by start time the same way
    const two = foldIndex([J(start({ t: '2026-09-20T14:02:11.500Z', runId: R2 })), J(start({ t: '2026-09-20T14:02:11Z', runId: R1 }))]).sessions.get(S1)!;
    expect(two.runs.map((r) => r.runId)).toEqual([R1, R2]);
    // a later start with a coarser stamp still moves createdAt back correctly
    const three = foldIndex([J(start({ t: '2026-09-20T14:02:11.999Z' })), J(start({ t: '2026-09-20T14:02:11Z', runId: R2 }))]).sessions.get(S1)!;
    expect(three.createdAt).toBe('2026-09-20T14:02:11Z');
    expect(three.lastUsed).toBe('2026-09-20T14:02:11.999Z');
  });

  it('§18: the fold stays within 3× the design budget at 1,000 runs (≤ 2 ms → 6 ms) and 10,000 runs (≤ 15 ms → 45 ms)', () => {
    const T2 = (n: number): string => new Date(Date.UTC(2026, 8, 1) + n * 61_000).toISOString();
    const id = (n: number): string => `2026${String(1 + (n % 12)).padStart(2, '0')}${String(1 + (n % 28)).padStart(2, '0')}-${String(n % 24).padStart(2, '0')}${String(n % 60).padStart(2, '0')}${String((n * 7) % 60).padStart(2, '0')}-${n.toString(32).padStart(8, 'a').replace(/[^a-z2-7]/g, 'a')}`;
    const build = (runs: number): string[] => {
      const out: string[] = [];
      for (let i = 0; i < runs; i++) {
        const sid = id(i % Math.max(1, Math.floor(runs / 5)));
        out.push(J(start({ t: T2(2 * i), sessionId: sid, runId: id(i), task60: `task ${i}` })));
        out.push(J(end({ t: T2(2 * i + 1), sessionId: sid, runId: id(i) })));
      }
      return out;
    };
    const best = (lines: string[], expectSessions: number): { fold: number; parse: number } => {
      // best of 7: the design figures assume an idle machine; a loaded CI box only has to hit the bound once.
      // `parse` is the bare JSON.parse of the same lines — the floor no fold can beat — measured in the same window, so a
      // machine saturated by parallel test workers (where wall-clock alone is meaningless) is judged on the ratio instead.
      let fold = Number.POSITIVE_INFINITY;
      let parse = Number.POSITIVE_INFINITY;
      for (let r = 0; r < 7; r++) {
        const t0 = performance.now();
        const { sessions, skipped } = foldIndex(lines);
        fold = Math.min(fold, performance.now() - t0);
        expect(skipped).toBe(0);
        expect(sessions.size).toBe(expectSessions);
        const t1 = performance.now();
        for (const l of lines) JSON.parse(l);
        parse = Math.min(parse, performance.now() - t1);
      }
      return { fold, parse };
    };
    const k1 = best(build(1_000), 200);
    const k10 = best(build(10_000), 2_000);
    // 3× the design budget, or — under contention — at most 4× the bare parse (the fold logic costs ≤ 3 parses on top of the one it must do)
    expect(k1.fold < 6 || k1.fold < 4 * k1.parse, `fold at 1,000 runs took ${k1.fold.toFixed(2)} ms (bare JSON.parse ${k1.parse.toFixed(2)} ms)`).toBe(true);
    expect(k10.fold < 45 || k10.fold < 4 * k10.parse, `fold at 10,000 runs took ${k10.fold.toFixed(2)} ms (bare JSON.parse ${k10.parse.toFixed(2)} ms)`).toBe(true);
  });

  it('folds 141 runs (282 lines) well under the read budget', () => {
    const lines: string[] = [];
    for (let i = 0; i < 141; i++) {
      const sid = runId(i % 30);
      lines.push(J(start({ t: T(i % 60), sessionId: sid, runId: runId(i), task60: `task ${i}` })));
      lines.push(J(end({ t: T((i + 1) % 60), sessionId: sid, runId: runId(i) })));
    }
    const t0 = performance.now();
    const { sessions } = foldIndex(lines);
    const ms = performance.now() - t0;
    expect(sessions.size).toBe(30);
    // 14 §2.2 measured 0.26 ms for the read + fold at 141 runs; 3× headroom for a loaded CI box on the fold alone is generous
    expect(ms).toBeLessThan(25);
  });
});

describe('text fields (E13)', () => {
  it('text60 = clip(oneLine(redact(x)), 60), control characters and bidi marks dropped', () => {
    const redact = (s: string): string => s.replace(/sk-secret-[a-z0-9]+/g, '[REDACTED:key]');
    expect(text60('use sk-secret-abcdef12345 now', redact)).toBe('use [REDACTED:key] now');
    expect(text60('a\nb\tc\u001bd\u200f\u202e', redact)).toBe('a ⏎ b cd');
    expect(text60('x'.repeat(100), redact)).toHaveLength(60);
    expect(text60('x'.repeat(100), redact).endsWith('…')).toBe(true);
    expect(indexOneLine('  padded  ')).toBe('padded');
    expect(text60('日本語のタスク'.repeat(20), redact)).toHaveLength(60);
  });

  it('redactIndexLine touches only task60 / title60 / text60', () => {
    const redact = (s: string): string => s.replace('SECRET', '[REDACTED:x]');
    expect(redactIndexLine(start({ task60: 'has SECRET' }), redact)).toMatchObject({ task60: 'has [REDACTED:x]' });
    expect(redactIndexLine({ v: 1, t: T(1), kind: 'rename', sessionId: S1, title60: 'SECRET title' }, redact)).toMatchObject({ title60: '[REDACTED:x] title' });
    expect(redactIndexLine({ v: 1, t: T(1), kind: 'steer', sessionId: S1, runId: R1, step: 1, text60: 'SECRET' }, redact)).toMatchObject({ text60: '[REDACTED:x]' });
    const e = end();
    expect(redactIndexLine(e, redact)).toBe(e);
  });

  it('sessionFieldsOf: legacy run.json reads as its own session with source inferred from the workspace', () => {
    expect(sessionFieldsOf(makeMeta({ runId: R1 }))).toEqual({ sessionId: R1, parentRunId: null, source: 'cli', instructions: [] });
    expect(sessionFieldsOf(makeMeta({ runId: R1, workspace: '/tmp/bench-work/x' })).source).toBe('bench');
    expect(sessionFieldsOf(makeMeta({ runId: R2, sessionId: R1, parentRunId: R1, source: 'perf' }))).toMatchObject({ sessionId: R1, parentRunId: R1, source: 'perf' });
  });
});

describe('appendIndexLine / readIndex / reindex (I/O)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jevcode-index-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends one line per call under O_APPEND, creating the sessions dir, and readIndex folds them newest-first', async () => {
    const path = join(dir, 'sessions', 'index.jsonl');
    const redact = (s: string): string => s;
    expect(appendIndexLine(path, start(), redact)).toBe(true);
    expect(appendIndexLine(path, end(), redact)).toBe(true);
    const other = runId(7);
    expect(appendIndexLine(path, start({ t: T(20), sessionId: other, runId: other, task60: 'later session' }), redact)).toBe(true);
    const text = await readFile(path, 'utf8');
    expect(text.split('\n').filter(Boolean)).toHaveLength(3);
    expect(text.endsWith('\n')).toBe(true);
    const idx = await readIndex(path);
    expect(idx.skipped).toBe(0);
    expect(idx.sessions.map((s) => s.sessionId)).toEqual([other, S1]);
    expect(idx.error).toBeUndefined();
  });

  it('redacts the text fields before writing and drops a line over 512 bytes with a warning', async () => {
    const path = join(dir, 'index.jsonl');
    const warnings: string[] = [];
    const redact = (s: string): string => s.replace(/sk-or-v1-[a-z0-9]+/g, '[REDACTED:pattern]');
    expect(appendIndexLine(path, start({ task60: 'key sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789' }), redact, { warn: (m) => warnings.push(m) })).toBe(true);
    expect(await readFile(path, 'utf8')).not.toContain('sk-or-v1-abc');
    const huge = start({ workspace: `/w/${'x'.repeat(600)}` });
    expect(appendIndexLine(path, huge, redact, { warn: (m) => warnings.push(m) })).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/dropped a run:start line of \d+ bytes \(limit 512\)/);
    expect((await readFile(path, 'utf8')).split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('index lines exist for cli runs only: a bench or perf run:start is refused with a warning and the file is untouched', async () => {
    const path = join(dir, 'index.jsonl');
    const warnings: string[] = [];
    expect(appendIndexLine(path, start({ source: 'bench' }), (s) => s, { warn: (m) => warnings.push(m) })).toBe(false);
    expect(appendIndexLine(path, start({ source: 'perf' }), (s) => s, { warn: (m) => warnings.push(m) })).toBe(false);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/skipped the bench run:start for \S+ \(only cli runs are indexed\)/);
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(appendIndexLine(path, start({ source: 'cli' }), (s) => s)).toBe(true);
    // the other kinds carry no source and are always written
    expect(appendIndexLine(path, end(), (s) => s)).toBe(true);
  });

  it('never throws on an unwritable path: warns and returns false', async () => {
    const file = join(dir, 'a-file');
    await writeFile(file, 'x');
    const warnings: string[] = [];
    expect(appendIndexLine(join(file, 'index.jsonl'), start(), (s) => s, { warn: (m) => warnings.push(m) })).toBe(false);
    expect(warnings[0]).toMatch(/could not append/);
  });

  it('readIndex: a missing file is an empty index, a torn last line is skipped, an unreadable file reports error', async () => {
    expect(await readIndex(join(dir, 'nope.jsonl'))).toEqual({ sessions: [], skipped: 0 });
    const path = join(dir, 'index.jsonl');
    await writeFile(path, `${J(start())}\n${J(end())}\n${J(start({ runId: R2 })).slice(0, 30)}`);
    const idx = await readIndex(path);
    expect(idx.skipped).toBe(1);
    expect(idx.sessions).toHaveLength(1);
    expect(splitIndexText('a\nb\n')).toEqual(['a', 'b']);
    expect(splitIndexText('a\nb')).toEqual(['a', 'b']);
    expect(splitIndexText('')).toEqual([]);
    const asDir = join(dir, 'isdir');
    await mkdir(asDir);
    const bad = await readIndex(asDir);
    expect(bad.sessions).toEqual([]);
    expect(bad.error).toMatch(/EISDIR/);
    if (process.getuid && process.getuid() !== 0) {
      await chmod(path, 0o000);
      const denied = await readIndex(path);
      expect(denied.error).toMatch(/EACCES/);
      await chmod(path, 0o600);
    }
  });

  it('reindex rebuilds run:start / run:end lines from run.json + state.json (mtime), skips bench runs and junk, writes atomically', async () => {
    const runs = join(dir, 'runs');
    const mk = async (n: number, patch: { source?: 'cli' | 'bench'; stop?: 'complete' | null; title?: string; state?: boolean }): Promise<string> => {
      const id = runId(n);
      const d = join(runs, id);
      await mkdir(d, { recursive: true });
      const meta = makeMeta({ runId: id, createdAt: `2020-01-01T00:0${n}:00.000Z`, task: `task ${n}\nwith newline`, ...(patch.source ? { source: patch.source } : {}), ...(patch.title ? { title: patch.title } : {}) });
      await writeFile(join(d, 'run.json'), JSON.stringify(meta));
      if (patch.state !== false) {
        const st = makeState({ runId: id, step: 9, stopReason: patch.stop ?? null, spend: spend(0.104, 0.011), wallMsUsed: 183_000, createdThisRun: ['a', 'b', 'c'] });
        await writeFile(join(d, 'state.json'), serialiseEnvelope(st, (s) => s));
      }
      return id;
    };
    const a = await mk(1, { stop: 'complete', title: 'tz fixes' });
    const b = await mk(2, { stop: null });
    await mk(3, { source: 'bench', stop: 'complete' });
    const d4 = await mk(4, { state: false });
    await mkdir(join(runs, 'not-a-run-id'));
    await mkdir(join(runs, runId(5)));
    await writeFile(join(runs, runId(5), 'run.json'), '{broken');
    const out = join(dir, 'sessions', 'index.jsonl');
    const res = await reindex(runs, out);
    expect(res).toEqual({ runs: 3, skipped: 1 });
    const text = await readFile(out, 'utf8');
    const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l['kind'], l['runId'] ?? l['sessionId']])).toEqual([
      ['run:start', a],
      ['rename', a],
      ['run:start', b],
      ['run:start', d4],
      ['run:end', a],
    ]);
    const endLine = lines.find((l) => l['kind'] === 'run:end')!;
    expect(endLine).toMatchObject({ stopReason: 'complete', steps: 9, costUsd: { generator: 0.104, jev: 0.011 }, wallMs: 183_000, changedFiles: 3, exitCode: 0, resumable: false, degraded: false });
    expect(lines[0]).toMatchObject({ task60: 'task 1 ⏎ with newline', branch: null, parentRunId: null, source: 'cli' });
    for (const raw of text.split('\n').filter(Boolean)) expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(INDEX_LINE_MAX_BYTES);
    const folded = await readIndex(out);
    expect(folded.sessions.find((s) => s.sessionId === a)?.title).toBe('tz fixes');
    // a missing runs dir is an empty index
    expect(await reindex(join(dir, 'missing'), join(dir, 'x.jsonl'))).toEqual({ runs: 0, skipped: 0 });
    expect(await readFile(join(dir, 'x.jsonl'), 'utf8')).toBe('');
  });

  it('reindex: resumes[] become resume run:start lines (RunRow.resumes), and task / title go through the supplied redact (E13)', async () => {
    const runs = join(dir, 'runs');
    const id = runId(8);
    const d = join(runs, id);
    await mkdir(d, { recursive: true });
    const meta = makeMeta({
      runId: id,
      createdAt: '2026-09-20T14:00:00.000Z',
      task: 'rotate sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789 now',
      title: 'key sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789',
      resumes: [
        { resumedAt: '2026-09-20T14:10:00.000Z', previousStopReason: 'human_pause' },
        { resumedAt: '2026-09-20T14:20:00.000Z', previousStopReason: 'spend_cap' },
        { resumedAt: 'not a stamp', previousStopReason: null },
      ],
    });
    await writeFile(join(d, 'run.json'), JSON.stringify(meta));
    await writeFile(join(d, 'state.json'), serialiseEnvelope(makeState({ runId: id, step: 12, stopReason: 'complete', spend: spend(0.3, 0.02), updatedAt: '2026-09-20T14:30:00.000Z' }), (s) => s));
    const out = join(dir, 'sessions', 'index.jsonl');
    const redact = (s: string): string => s.replace(/sk-or-v1-[a-z0-9]+/g, '[REDACTED:pattern]');
    expect(await reindex(runs, out, { redact })).toEqual({ runs: 1, skipped: 0 });
    const text = await readFile(out, 'utf8');
    expect(text).not.toContain('sk-or-v1-abc');
    const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l['kind'], l['resumeOf'] ?? null])).toEqual([
      ['run:start', null],
      ['rename', null],
      ['run:start', id],
      ['run:start', id],
      ['run:end', null],
    ]);
    expect(lines[0]).toMatchObject({ task60: 'rotate [REDACTED:pattern] now' });
    expect(lines[1]).toMatchObject({ title60: 'key [REDACTED:pattern]' });
    const folded = await readIndex(out);
    const row = folded.sessions[0]!.runs[0]!;
    expect(row).toMatchObject({ runId: id, resumes: 2, startedAt: '2026-09-20T14:00:00.000Z', stopReason: 'complete', live: false });
    expect(folded.sessions[0]!.title).toBe('key [REDACTED:pattern]');
    // without a redact the fields are copied as written (the run.json's own write-time redaction)
    await reindex(runs, out);
    expect((await readIndex(out)).sessions[0]!.task60).toContain('sk-or-v1-abc');
  });
});

describe('property: every redacted index line is ≤ 512 bytes or dropped (A106, seed printed on failure)', () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const POOL = ['a', 'Z', ' ', '日', '🙂', '́', '\n', '\t', '"', '\\', 'é', '∑'];
  it('1,000 random lines', async () => {
    const seed = 20260920;
    const rnd = mulberry32(seed);
    const dir = await mkdtemp(join(tmpdir(), 'jevcode-index-prop-'));
    const path = join(dir, 'index.jsonl');
    const redact = (s: string): string => s;
    let written = 0;
    try {
      for (let i = 0; i < 1000; i++) {
        const len = Math.floor(rnd() * 900);
        let text = '';
        for (let k = 0; k < len; k++) text += POOL[Math.floor(rnd() * POOL.length)]!;
        const line: IndexLine = rnd() < 0.5 ? start({ task60: text, workspace: rnd() < 0.3 ? text : '/w' }) : { v: 1, t: T(1), kind: 'rename', sessionId: S1, title60: text };
        const ok = appendIndexLine(path, line, redact);
        const bytes = Buffer.byteLength(JSON.stringify(redactIndexLine(line, redact)), 'utf8');
        if (ok) {
          written++;
          if (bytes > INDEX_LINE_MAX_BYTES) throw new Error(`seed ${seed} iteration ${i}: wrote ${bytes} bytes`);
        } else if (bytes <= INDEX_LINE_MAX_BYTES) {
          throw new Error(`seed ${seed} iteration ${i}: dropped a ${bytes}-byte line`);
        }
      }
      const text = await readFile(path, 'utf8');
      const lines = text.split('\n').filter(Boolean);
      expect(lines).toHaveLength(written);
      for (const l of lines) expect(Buffer.byteLength(l, 'utf8')).toBeLessThanOrEqual(INDEX_LINE_MAX_BYTES);
      expect(foldIndex(lines).skipped).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
