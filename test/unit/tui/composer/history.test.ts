/**
 * TUI-DESIGN §4.6, §10.7, §15 item 16, §19.0–19.1 (`history.test.ts`): JSONL shape, redaction through the injected
 * function, 4 KiB clip, consecutive-duplicate drop, 1,000 cap with atomic rewrite, workspace filter + `all` widening,
 * writes off (bench/perf, --no-history) with reads intact, torn/oversized files, EACCES/ENOTDIR never fatal, cleared-draft rule.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DRAFT_REDACTED,
  HISTORY_DIR_MODE,
  HISTORY_MAX_ENTRIES,
  HISTORY_MAX_ENTRY_BYTES,
  HISTORY_MAX_READ_BYTES,
  HISTORY_REDACT_ERROR,
  HISTORY_REWRITE_SLACK,
  clipBytes,
  createHistoryStore,
  maskDraft,
  parseHistoryLine,
  type HistoryEntry,
} from '../../../../src/tui/composer/history.js';
import { bestMs, medianMs } from './helpers.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'jevcode-history-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      /* ignore */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

const WS = '/Users/dev/proj';
const OTHER = '/Users/dev/other';
const SECRET = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
const redact = (s: string): string => s.split(SECRET).join('[REDACTED:composer#1]');
let tick = 0;
const clock = (): string => new Date(Date.UTC(2026, 8, 20, 12, 0, tick++)).toISOString();

function make(path: string, over: Partial<Parameters<typeof createHistoryStore>[0]> = {}) {
  return createHistoryStore({ path, workspace: WS, redact, writes: true, now: clock, ...over });
}

function lines(path: string): HistoryEntry[] {
  const raw = readFileSync(path, 'utf8');
  expect(raw.endsWith('\n')).toBe(true);
  return raw.slice(0, -1).split('\n').map((l) => JSON.parse(l) as HistoryEntry);
}

describe('append and the file shape', () => {
  it('writes one JSONL line { t, workspace, kind, text } per submission, redacted, control-free, mode 0600', () => {
    const path = join(tmp(), 'history.jsonl');
    const store = make(path);
    store.append('prompt', `fix the bug with ${SECRET} please\u0007`);
    store.append('steer', 'go faster');
    store.append('command', '/diff');
    const ls = lines(path);
    expect(ls.length).toBe(3);
    expect(Object.keys(ls[0] ?? {})).toEqual(['t', 'workspace', 'kind', 'text']);
    expect(ls[0]).toEqual({ t: '2026-09-20T12:00:00.000Z', workspace: WS, kind: 'prompt', text: 'fix the bug with [REDACTED:composer#1] please' });
    expect(ls[1]?.kind).toBe('steer');
    expect(ls[2]).toMatchObject({ kind: 'command', text: '/diff' });
    expect(readFileSync(path, 'utf8').includes(SECRET)).toBe(false);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(store.entries('workspace')).toEqual(['fix the bug with [REDACTED:composer#1] please', 'go faster', '/diff']);
  });

  it('creates the parent directory, skips empty / whitespace-only / unknown-kind entries', () => {
    const path = join(tmp(), 'nested', 'deeper', 'history.jsonl');
    const store = make(path);
    store.append('prompt', '   ');
    store.append('prompt', '');
    store.append('prompt', '\u0000\u001b');
    expect(existsSync(path)).toBe(false);
    store.append('prompt', 'real');
    expect(lines(path).length).toBe(1);
    (store.append as (k: string, t: string) => void)('bogus', 'x');
    expect(store.all.length).toBe(1);
  });

  it('clips entries to 4 KiB of UTF-8 on a code point boundary with …', () => {
    const path = join(tmp(), 'history.jsonl');
    const store = make(path);
    const long = '日'.repeat(3000); // 9,000 bytes
    store.append('prompt', long);
    const text = store.entries('all')[0] ?? '';
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(HISTORY_MAX_ENTRY_BYTES);
    expect(text.endsWith('…')).toBe(true);
    expect(text.includes('�')).toBe(false);
    expect(HISTORY_MAX_ENTRY_BYTES).toBe(4096);
    expect(clipBytes('abc', 3)).toBe('abc');
    expect(clipBytes('abcd', 3)).toBe('…'); // 3 bytes is exactly the ellipsis
    expect(clipBytes('abcdef', 5)).toBe('ab…');
    expect(clipBytes('日本語', 6)).toBe('日…'); // 3 + 3
    expect(clipBytes('', 0)).toBe('');
  });

  it('drops consecutive duplicates (same workspace) and keeps non-consecutive repeats', () => {
    const path = join(tmp(), 'history.jsonl');
    const store = make(path);
    store.append('prompt', 'same');
    store.append('prompt', 'same');
    store.append('steer', 'same'); // kind differs, text equal → still a consecutive duplicate
    store.append('prompt', 'other');
    store.append('prompt', 'same');
    expect(store.entries('workspace')).toEqual(['same', 'other', 'same']);
    expect(lines(path).length).toBe(3);
  });

  it('dedupes against the last entry of the SAME workspace, so an interleaved workspace never lets a consecutive duplicate through', () => {
    const path = join(tmp(), 'history.jsonl');
    const a = make(path);
    const b = make(path, { workspace: OTHER });
    a.append('prompt', 'x');
    b.append('prompt', 'y');
    // a second store instance on /a would not see b's write; use one instance per workspace and reload to check the file
    a.append('prompt', 'x'); // the globally last entry is b's 'y', but for /a the last is 'x' → dropped
    expect(a.entries('workspace')).toEqual(['x']);
    const reloaded = make(path);
    expect(reloaded.entries('workspace')).toEqual(['x']);
    expect(reloaded.entries('all')).toEqual(['x', 'y']);
    // and the other direction: /b may repeat what /a said last
    b.append('prompt', 'x');
    expect(make(path, { workspace: OTHER }).entries('workspace')).toEqual(['y', 'x']);
  });

  it('never blocks a duplicate across workspaces and filters per workspace with `all` widening', () => {
    const path = join(tmp(), 'history.jsonl');
    const a = make(path);
    a.append('prompt', 'shared text');
    const b = make(path, { workspace: OTHER });
    b.append('prompt', 'shared text');
    b.append('prompt', 'only other');
    const again = make(path);
    expect(again.entries('workspace')).toEqual(['shared text']);
    expect(again.entries('all')).toEqual(['shared text', 'shared text', 'only other']);
    expect(again.records('all').map((e) => e.workspace)).toEqual([WS, OTHER, OTHER]);
  });
});

describe('cap and atomic rewrite', () => {
  it('keeps the newest 1,000 in memory; the file may grow 100 lines past the cap, then one atomic rewrite compacts it', () => {
    const dir = tmp();
    const path = join(dir, 'history.jsonl');
    const store = make(path);
    for (let i = 0; i < HISTORY_MAX_ENTRIES + 5; i++) store.append('prompt', `entry ${i}`);
    expect(HISTORY_MAX_ENTRIES).toBe(1000);
    expect(HISTORY_REWRITE_SLACK).toBe(100);
    expect(store.all.length).toBe(1000);
    expect(store.all[0]?.text).toBe('entry 5');
    expect(lines(path).length).toBe(1005); // within the slack: plain appends
    for (let i = HISTORY_MAX_ENTRIES + 5; i < HISTORY_MAX_ENTRIES + HISTORY_REWRITE_SLACK + 1; i++) store.append('prompt', `entry ${i}`);
    const ls = lines(path);
    expect(ls.length).toBe(1000); // the 1,101st line triggered the rewrite of the newest 1,000
    expect(ls[0]?.text).toBe('entry 101');
    expect(ls[999]?.text).toBe('entry 1100');
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    // a reload sees the same 1,000
    expect(make(path).all.length).toBe(1000);
  });

  it('rewriteSlack 0 rewrites as soon as the cap is exceeded (the literal §4.6 reading)', () => {
    const path = join(tmp(), 'history.jsonl');
    const store = make(path, { maxEntries: 3, rewriteSlack: 0 });
    for (const t of ['a', 'b', 'c', 'd']) store.append('prompt', t);
    expect(store.entries('all')).toEqual(['b', 'c', 'd']);
    expect(lines(path).map((e) => e.text)).toEqual(['b', 'c', 'd']);
    store.append('prompt', 'e');
    expect(lines(path).map((e) => e.text)).toEqual(['c', 'd', 'e']);
  });

  it('a file already over cap + slack on disk is compacted by the first append, not on load', () => {
    const path = join(tmp(), 'history.jsonl');
    const rows: string[] = [];
    for (let i = 0; i < 20; i++) rows.push(JSON.stringify({ t: 't', workspace: WS, kind: 'prompt', text: `r${i}` }));
    writeFileSync(path, rows.join('\n') + '\n');
    const store = make(path, { maxEntries: 5, rewriteSlack: 2 });
    expect(lines(path).length).toBe(20); // load never writes
    store.append('prompt', 'new');
    expect(lines(path).map((e) => e.text)).toEqual(['r16', 'r17', 'r18', 'r19', 'new']);
  });

  it.skipIf(process.platform === 'win32')('steady state at the cap: 150 appends perform exactly one rewrite (at cap + slack) and each append stays well under a millisecond', () => {
    const path = join(tmp(), 'history.jsonl');
    const row = JSON.stringify({ t: '2026-09-20T12:00:00.000Z', workspace: WS, kind: 'prompt', text: 'y'.repeat(4000) });
    writeFileSync(path, (row + '\n').repeat(HISTORY_MAX_ENTRIES)); // exactly at the cap, ≈ 4 MiB
    const store = make(path);
    expect(store.all.length).toBe(HISTORY_MAX_ENTRIES);
    let inode = statSync(path).ino;
    let rewrites = 0;
    let i = 0;
    const appendOnce = (): void => {
      store.append('prompt', `steady ${i++}`);
      const now = statSync(path).ino;
      if (now !== inode) {
        rewrites++; // rename(2) over the file changes its inode; O_APPEND writes never do
        inode = now;
      }
    };
    const timings: number[] = [];
    for (let k = 0; k < 150; k++) {
      const t0 = performance.now();
      appendOnce();
      timings.push(performance.now() - t0);
    }
    const max = Math.max(...timings);
    timings.sort((a, b) => a - b);
    const best = timings[0] ?? 0;
    const median = timings[Math.floor(timings.length / 2)] ?? 0;
    process.stdout.write(`[measured] append at the 1,000 cap over 150 submits: best ${best.toFixed(3)} ms, median ${median.toFixed(3)} ms, max (the one rewrite) ${max.toFixed(2)} ms, rewrites ${rewrites}\n`);
    expect(rewrites).toBe(1); // the 101st append past the cap; the 100 before and the 49 after were plain appends
    expect(best).toBeLessThan(1);
    expect(median).toBeLessThan(3);
    expect(store.all.length).toBe(HISTORY_MAX_ENTRIES);
    expect(store.all[HISTORY_MAX_ENTRIES - 1]?.text).toBe('steady 149');
    // the rewrite happened exactly once the slack was used up; the file holds cap ≤ n ≤ cap + slack lines
    const n = lines(path).length;
    expect(n).toBeGreaterThanOrEqual(HISTORY_MAX_ENTRIES);
    expect(n).toBeLessThanOrEqual(HISTORY_MAX_ENTRIES + HISTORY_REWRITE_SLACK);
    expect(medianMs(() => store.entries('workspace'), 3)).toBeLessThan(20);
  });
});

describe('loading', () => {
  it('a missing file is an empty store; a torn last line and junk lines are tolerated', () => {
    const path = join(tmp(), 'history.jsonl');
    expect(make(path).all).toEqual([]);
    const good = JSON.stringify({ t: 't1', workspace: WS, kind: 'prompt', text: 'ok' });
    writeFileSync(path, `${good}\nnot json\n{"t":"x"}\n{"t":"t","workspace":"${WS}","kind":"weird","text":"no"}\n${good.slice(0, 20)}`);
    const store = make(path);
    expect(store.entries('all')).toEqual(['ok']);
    expect(parseHistoryLine('')).toBeNull();
    expect(parseHistoryLine('[]')).toBeNull();
    expect(parseHistoryLine('null')).toBeNull();
    expect(parseHistoryLine(good)).toEqual({ t: 't1', workspace: WS, kind: 'prompt', text: 'ok' });
  });

  it('reads only the tail of an oversized file and drops the torn first line', () => {
    const path = join(tmp(), 'history.jsonl');
    const rows: string[] = [];
    for (let i = 0; i < 50; i++) rows.push(JSON.stringify({ t: 't', workspace: WS, kind: 'prompt', text: `row ${i} ${'x'.repeat(40)}` }));
    writeFileSync(path, rows.join('\n') + '\n');
    const store = make(path, { maxReadBytes: 600 });
    expect(store.all.length).toBeGreaterThan(0);
    expect(store.all.length).toBeLessThan(50);
    expect(store.all[store.all.length - 1]?.text.startsWith('row 49')).toBe(true);
    for (const e of store.all) expect(e.text).toMatch(/^row \d+ x+$/);
    expect(HISTORY_MAX_READ_BYTES).toBe(4 * 1024 * 1024);
  });

  it('keeps only the newest maxEntries when the file holds more', () => {
    const path = join(tmp(), 'history.jsonl');
    const rows: string[] = [];
    for (let i = 0; i < 10; i++) rows.push(JSON.stringify({ t: 't', workspace: WS, kind: 'prompt', text: `r${i}` }));
    writeFileSync(path, rows.join('\n') + '\n');
    expect(make(path, { maxEntries: 4 }).entries('all')).toEqual(['r6', 'r7', 'r8', 'r9']);
  });

  it('a 4 MiB file: the synchronous construction reads only bytes (≈ 3 ms in §4.6; asserted at 3× = 10 ms best of 5) and the first access parses', () => {
    const path = join(tmp(), 'history.jsonl');
    const row = JSON.stringify({ t: '2026-09-20T12:00:00.000Z', workspace: WS, kind: 'prompt', text: 'y'.repeat(4000) });
    writeFileSync(path, (row + '\n').repeat(1000)); // ≈ 4 MiB
    const size = (statSync(path).size / 1048576).toFixed(2);
    const construct = bestMs(() => {
      make(path);
    }, 5);
    const store = make(path);
    expect(store.loaded).toBe(false); // nothing parsed yet: Up has not been pressed
    const t0 = performance.now();
    const n = store.all.length;
    const parse = performance.now() - t0;
    expect(store.loaded).toBe(true);
    process.stdout.write(`[measured] history construct (read ${size} MiB tail) best of 5: ${construct.toFixed(2)} ms; first-access parse: ${parse.toFixed(2)} ms\n`);
    expect(n).toBe(1000);
    expect(construct).toBeLessThan(10);
    expect(parse).toBeLessThan(150); // reported; paid on the first Up/Ctrl-R/submit, inside the keystroke budget on an idle machine
    // the parse happens once
    expect(medianMs(() => store.entries('all'), 3)).toBeLessThan(5);
  });

  it('append on a never-read store parses first, so dedupe and the cap see the file', () => {
    const path = join(tmp(), 'history.jsonl');
    writeFileSync(path, JSON.stringify({ t: 't', workspace: WS, kind: 'prompt', text: 'dup' }) + '\n');
    const store = make(path);
    expect(store.loaded).toBe(false);
    store.append('prompt', 'dup');
    expect(store.loaded).toBe(true);
    expect(lines(path).length).toBe(1);
    expect(store.entries('workspace')).toEqual(['dup']);
  });
});

describe('writes off (bench/perf, --no-history, JEVCODE_NO_HISTORY=1)', () => {
  it('never touches the disk but still recalls in memory; reads of an existing file work', () => {
    const path = join(tmp(), 'history.jsonl');
    writeFileSync(path, JSON.stringify({ t: 't', workspace: WS, kind: 'prompt', text: 'from disk' }) + '\n');
    const store = make(path, { writes: false });
    expect(store.writesEnabled).toBe(false);
    store.append('prompt', 'in memory only');
    store.appendCleared('draft', []);
    expect(store.entries('workspace')).toEqual(['from disk', 'in memory only', 'draft']);
    expect(lines(path).length).toBe(1);
    store.clear();
    expect(store.all).toEqual([]);
    expect(lines(path).length).toBe(1);
  });
});

describe('write failures are toasts, never exceptions', () => {
  it.skipIf(process.platform === 'win32' || (process.getuid?.() ?? 1) === 0)('EACCES on append reports { file, code } once per failed write and keeps the entry in memory', () => {
    const dir = tmp();
    const path = join(dir, 'history.jsonl');
    writeFileSync(path, '');
    chmodSync(path, 0o400);
    const errors: { file: string; code: string }[] = [];
    const store = make(path, { onWriteError: (e) => errors.push(e) });
    expect(() => store.append('prompt', 'hello')).not.toThrow();
    expect(errors).toEqual([{ file: 'history.jsonl', code: 'EACCES' }]);
    expect(store.entries('all')).toEqual(['hello']);
    // the atomic rewrite needs a writable directory: lock it and /history clear must fail softly too
    chmodSync(dir, 0o500);
    expect(() => store.clear()).not.toThrow();
    expect(errors.length).toBe(2);
    expect(errors[1]?.code).toBe('EACCES');
    expect(store.entries('all')).toEqual([]);
  });

  it('a parent that is a file (ENOTDIR): append, rewrite and clear all fail softly', () => {
    const dir = tmp();
    const parent = join(dir, 'file');
    writeFileSync(parent, 'x');
    const path = join(parent, 'history.jsonl');
    const errors: { file: string; code: string }[] = [];
    const store = make(path, { onWriteError: (e) => errors.push(e), maxEntries: 1, rewriteSlack: 0 });
    store.append('prompt', 'a');
    store.append('prompt', 'b');
    store.clear(); // the atomic rewrite path
    expect(errors.length).toBe(3);
    for (const e of errors) expect(['ENOTDIR', 'EEXIST', 'ENOENT']).toContain(e.code);
    expect(store.entries('all')).toEqual([]);
  });

  it('a throwing redactor never propagates out of append/appendCleared, writes nothing and reports EREDACT', () => {
    const path = join(tmp(), 'history.jsonl');
    const errors: { file: string; code: string }[] = [];
    const store = make(path, {
      onWriteError: (e) => errors.push(e),
      redact: (s) => {
        if (s.includes('boom')) throw new Error('regex blew up');
        return s;
      },
    });
    expect(() => store.append('prompt', 'boom now')).not.toThrow();
    expect(() => store.appendCleared('boom draft', [])).not.toThrow();
    expect(errors).toEqual([
      { file: 'history.jsonl', code: HISTORY_REDACT_ERROR },
      { file: 'history.jsonl', code: HISTORY_REDACT_ERROR },
    ]);
    expect(HISTORY_REDACT_ERROR).toBe('EREDACT');
    expect(store.all).toEqual([]);
    expect(existsSync(path)).toBe(false); // the unredacted text never reached the disk
    store.append('prompt', 'fine');
    expect(lines(path).map((e) => e.text)).toEqual(['fine']);
    // a redactor returning a non-string is treated the same way
    const bad = make(join(tmp(), 'h.jsonl'), { onWriteError: (e) => errors.push(e), redact: (() => 42) as unknown as (s: string) => string });
    bad.append('prompt', 'x');
    expect(errors[errors.length - 1]?.code).toBe(HISTORY_REDACT_ERROR);
    expect(bad.all).toEqual([]);
  });

  it('a missing onWriteError hook is fine', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'ro'));
    const path = join(dir, 'ro', 'history.jsonl');
    writeFileSync(path, '');
    if (process.platform !== 'win32' && (process.getuid?.() ?? 1) !== 0) chmodSync(path, 0o400);
    const store = make(path);
    expect(() => store.append('prompt', 'x')).not.toThrow();
  });
});

describe('cleared drafts (§10.7) and /history clear', () => {
  it('appendCleared masks every hit span with [REDACTED:draft] before the normal append', () => {
    const path = join(tmp(), 'history.jsonl');
    const store = make(path);
    const draft = `use AKIAIOSFODNN7EXAMPLE and ${SECRET} now`;
    const a = draft.indexOf('AKIA');
    const b = draft.indexOf(SECRET);
    store.appendCleared(draft, [{ start: a, end: a + 20 }, { start: b, end: b + SECRET.length }]);
    expect(store.entries('all')).toEqual([`use ${DRAFT_REDACTED} and ${DRAFT_REDACTED} now`]);
    expect(readFileSync(path, 'utf8').includes('AKIAIOSFODNN7EXAMPLE')).toBe(false);
    expect(lines(path)[0]?.kind).toBe('prompt');
  });
  it('maskDraft merges overlapping spans and clamps out-of-range ones', () => {
    expect(maskDraft('abcdef', [{ start: 1, end: 3 }, { start: 2, end: 5 }])).toBe(`a${DRAFT_REDACTED}f`);
    expect(maskDraft('abcdef', [{ start: -4, end: 2 }, { start: 4, end: 99 }])).toBe(`${DRAFT_REDACTED}cd${DRAFT_REDACTED}`);
    expect(maskDraft('abc', [{ start: 2, end: 1 }, { start: Number.NaN, end: 2 }])).toBe('abc');
    expect(maskDraft('abc', [])).toBe('abc');
    expect(maskDraft('', [{ start: 0, end: 5 }])).toBe('');
  });
  it('clear() truncates the file and the memory', () => {
    const path = join(tmp(), 'history.jsonl');
    const store = make(path);
    store.append('prompt', 'a');
    store.append('prompt', 'b');
    store.clear();
    expect(store.entries('all')).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe('');
    expect(make(path).all).toEqual([]);
    store.append('prompt', 'c');
    expect(lines(path).map((e) => e.text)).toEqual(['c']);
  });

  it.skipIf(process.platform === 'win32')('clear() as the very first write creates the parent directory 0700 and the file 0600, like append does', () => {
    const viaClear = join(tmp(), 'cfg', 'history.jsonl');
    const a = make(viaClear);
    a.clear();
    expect(statSync(dirname(viaClear)).mode & 0o777).toBe(HISTORY_DIR_MODE);
    expect(statSync(viaClear).mode & 0o777).toBe(0o600);
    expect(HISTORY_DIR_MODE).toBe(0o700);
    // and through the rewrite path as the first write (a file over the cap on disk, slack 0)
    const viaRewrite = join(tmp(), 'cfg2', 'history.jsonl');
    const b = make(viaRewrite, { maxEntries: 1, rewriteSlack: 0 });
    b.append('prompt', 'one'); // first write: append path
    expect(statSync(dirname(viaRewrite)).mode & 0o777).toBe(HISTORY_DIR_MODE);
    const viaAppend = join(tmp(), 'cfg3', 'history.jsonl');
    make(viaAppend).append('prompt', 'x');
    expect(statSync(dirname(viaAppend)).mode & 0o777).toBe(HISTORY_DIR_MODE);
  });
});
