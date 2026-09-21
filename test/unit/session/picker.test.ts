import { describe, expect, it } from 'vitest';
import type { RunRow, SessionRow } from '../../../src/core/types.js';
import {
  ambiguousResumeMessage,
  approxCellWidth,
  filterSessions,
  isSubsequence,
  newestRun,
  noSessionMessage,
  pickerCellWidth,
  pickerHeader,
  pickerRows,
  pickerSessions,
  recentSessionHint,
  resolveResumeTarget,
  sortSessions,
  stopWord,
  timeAgo,
  truncateLeftToCells,
  truncateToCells,
} from '../../../src/session/picker-lines.js';
import { runId } from './helpers.js';

const NOW = Date.parse('2026-09-20T15:00:00.000Z');
const WS = '/Users/me/proj';

function runRow(n: number, patch: Partial<RunRow> = {}): RunRow {
  return { runId: runId(n), parentRunId: null, startedAt: `2026-09-20T14:0${n}:00.000Z`, endedAt: `2026-09-20T14:0${n}:30.000Z`, stopReason: 'complete', steps: 9, costUsd: { generator: 0.1, jev: 0.015 }, exitCode: 0, resumable: true, resumes: 0, live: false, ...patch };
}

function session(n: number, patch: Partial<SessionRow> = {}): SessionRow {
  return { sessionId: runId(n), workspace: WS, title: `title ${n}`, task60: `task ${n}`, runs: [runRow(n)], lastUsed: `2026-09-20T14:${String(n).padStart(2, '0')}:00.000Z`, createdAt: `2026-09-20T13:${String(n).padStart(2, '0')}:00.000Z`, totalUsd: 0.115, mode: 'jev-on', branch: 'main', ...patch };
}

describe('timeAgo / widths', () => {
  it('renders coarse relative times and `?` for junk; the future is `just now`', () => {
    const at = (ms: number): string => new Date(NOW - ms).toISOString();
    expect(timeAgo(at(0), NOW)).toBe('just now');
    expect(timeAgo(at(59_000), NOW)).toBe('just now');
    expect(timeAgo(at(3 * 60_000), NOW)).toBe('3m ago');
    expect(timeAgo(at(2 * 3_600_000), NOW)).toBe('2h ago');
    expect(timeAgo(at(5 * 86_400_000), NOW)).toBe('5d ago');
    expect(timeAgo(at(3 * 7 * 86_400_000), NOW)).toBe('3w ago');
    expect(timeAgo(at(4 * 30 * 86_400_000), NOW)).toBe('4mo ago');
    expect(timeAgo(at(400 * 86_400_000), NOW)).toBe('1y ago');
    expect(timeAgo(new Date(NOW + 60_000).toISOString(), NOW)).toBe('just now');
    expect(timeAgo('not a date', NOW)).toBe('?');
    expect(timeAgo(at(0), Number.NaN)).toBe('?');
  });

  it('approxCellWidth: ASCII 1, CJK 2, emoji 2, combining and ZWJ 0, controls 0; truncateToCells keeps widths', () => {
    expect(approxCellWidth('abc')).toBe(3);
    expect(approxCellWidth('日本')).toBe(4);
    expect(approxCellWidth('🙂')).toBe(2);
    expect(approxCellWidth('é')).toBe(1);
    expect(approxCellWidth('a‍b')).toBe(2);
    expect(approxCellWidth('\u001b[31m')).toBe(4);
    expect(approxCellWidth('')).toBe(0);
    expect(truncateToCells('hello world', 5)).toBe('hell…');
    expect(truncateToCells('hello', 5)).toBe('hello');
    expect(truncateToCells('日本語です', 5)).toBe('日本…');
    expect(truncateToCells('日本語です', 4)).toBe('日…');
    expect(truncateToCells('abc', 0)).toBe('');
    expect(truncateToCells('abcdef', 3, approxCellWidth, true)).toBe('ab~');
    for (const s of ['hello world', '日本語のテキスト', '🙂🙂🙂🙂', 'éééééé']) {
      for (const cells of [1, 2, 3, 4, 5, 6]) expect(approxCellWidth(truncateToCells(s, cells))).toBeLessThanOrEqual(cells);
    }
  });

  it('wide emoji blocks, ZWJ sequences, skin tones, flags and fullwidth punctuation measure 2 under both measurers; clips never split a cluster', () => {
    const family = '👨\u200d👩\u200d👧';
    for (const s of ['🚀', '🪐', '🛸', '🟢', '🀄', '🇯🇵', '👍🏽', family, '！', '？', '，', '⏰', '⭐']) {
      expect(approxCellWidth(s)).toBe(2);
      expect(pickerCellWidth(s)).toBe(2);
    }
    // text-presentation symbols without VS16 and arrows stay narrow under both
    for (const s of ['→', '♻', '·', '─', '│', '●', '…']) {
      expect(pickerCellWidth(s)).toBe(1);
      expect(approxCellWidth(s)).toBe(1);
    }
    expect(approxCellWidth('🇯🇵🇫🇷')).toBe(4);
    // the default measurer is O2's string-width twin; the fallback never under-measures it on these rows
    for (const s of [`fix ${family} onboarding 🚀`, 'ｆｕｌｌｗｉｄｔｈ！', '日本語 🙂 mixed', 'a\u0301b\u0301']) expect(approxCellWidth(s)).toBeGreaterThanOrEqual(pickerCellWidth(s));
    // a clip keeps whole clusters: the family is either present or gone, never a torn ZWJ tail
    expect(truncateToCells(`ab${family}cd`, 4)).toBe('ab…');
    expect(truncateToCells(`ab${family}cd`, 5)).toBe(`ab${family}…`);
    expect(truncateToCells('🇯🇵🇫🇷', 3)).toBe('🇯🇵…');
    expect(truncateLeftToCells('/Users/me/proj', 8)).toBe('…me/proj');
    expect(truncateLeftToCells('/Users/me/proj', 100)).toBe('/Users/me/proj');
    expect(truncateLeftToCells('日本語です', 5)).toBe('…です');
    expect(truncateLeftToCells('日本語です', 7)).toBe('…語です');
    expect(truncateLeftToCells('abc', 0)).toBe('');
    expect(truncateToCells('abc', Number.NaN)).toBe('');
  });
});

describe('filter / sort', () => {
  it('isSubsequence is case-folded; filterSessions matches title, task and ids; blank filter keeps all', () => {
    expect(isSubsequence('tzf', 'TZ Fixes')).toBe(true);
    expect(isSubsequence('fzt', 'tz fixes')).toBe(false);
    expect(isSubsequence('', 'anything')).toBe(true);
    const a = session(1, { title: 'tz fixes', task60: 'fix parse_date' });
    const b = session(2, { title: 'docs', task60: 'update the docs' });
    expect(filterSessions([a, b], 'tzf')).toEqual([a]);
    expect(filterSessions([a, b], 'DOCS')).toEqual([b]);
    expect(filterSessions([a, b], runId(2).slice(0, 12))).toEqual([b]);
    expect(filterSessions([a, b], b.runs[0]!.runId)).toEqual([b]);
    expect(filterSessions([a, b], '   ')).toEqual([a, b]);
    expect(filterSessions([a, b], undefined)).toHaveLength(2);
    expect(filterSessions([a, b], 'zzz')).toEqual([]);
  });

  it('sortSessions: updated (lastUsed desc, default) or created; stable on ties', () => {
    const a = session(1, { lastUsed: '2026-09-20T14:01:00.000Z', createdAt: '2026-09-20T10:00:00.000Z' });
    const b = session(2, { lastUsed: '2026-09-20T14:05:00.000Z', createdAt: '2026-09-20T09:00:00.000Z' });
    const c = session(3, { lastUsed: '2026-09-20T14:05:00.000Z', createdAt: '2026-09-20T08:00:00.000Z' });
    expect(sortSessions([a, b, c]).map((s) => s.sessionId)).toEqual([b.sessionId, c.sessionId, a.sessionId]);
    expect(sortSessions([a, b, c], 'created').map((s) => s.sessionId)).toEqual([a.sessionId, b.sessionId, c.sessionId]);
    expect(sortSessions([])).toEqual([]);
  });

  it('pickerSessions scopes to the workspace unless widened', () => {
    const here = session(1);
    const there = session(2, { workspace: '/elsewhere' });
    expect(pickerSessions([here, there], { workspace: WS, widened: false })).toEqual([here]);
    expect(pickerSessions([here, there], { workspace: WS, widened: true })).toHaveLength(2);
  });
});

describe('pickerHeader / pickerRows (TUI-DESIGN §8.4, §24)', () => {
  it('header text is the §24 rule row, padded to columns, with the ASCII twin', () => {
    const h = pickerHeader({ workspace: WS, widened: false, columns: 100 });
    expect(h.startsWith(`─── sessions · ${WS} (Ctrl-A all) · by updated ─ ↑↓ Enter Space Ctrl-R x Esc `)).toBe(true);
    expect(approxCellWidth(h)).toBe(100);
    expect(pickerHeader({ workspace: WS, widened: true, sort: 'created', columns: 120 })).toContain('sessions · all (Ctrl-A all) · by created');
    const a = pickerHeader({ workspace: WS, widened: false, columns: 120, ascii: true });
    expect(a.startsWith(`--- sessions - ${WS} (Ctrl-A all) - by updated - ^v Enter Space Ctrl-R x Esc `)).toBe(true);
    expect(/^[\x20-\x7e]+$/.test(a)).toBe(true);
    expect(approxCellWidth(pickerHeader({ workspace: WS, widened: false, columns: 20 }))).toBe(20);
    expect(pickerHeader({ workspace: WS, widened: false, columns: 0 }).endsWith('────')).toBe(true);
    expect(pickerHeader({ workspace: WS, widened: false, columns: Number.NaN }).length).toBeGreaterThan(0);
  });

  it('a workspace path longer than the row is squeezed from the left so the key hints survive; only a hopeless width clips the row', () => {
    const longWs = `/Users/someone/very/deeply/nested/${'segment/'.repeat(12)}proj`;
    const hints = ' (Ctrl-A all) · by updated ─ ↑↓ Enter Space Ctrl-R x Esc ────';
    // the fixed text (empty workspace) plus the 4-cell tail is the narrowest row that can still show the hints
    const minCols = pickerCellWidth(pickerHeader({ workspace: '', widened: false, columns: 0 }));
    expect(minCols).toBe(76);
    for (const cols of [minCols + 1, 90, 100, 120]) {
      const h = pickerHeader({ workspace: longWs, widened: false, columns: cols });
      expect(pickerCellWidth(h)).toBe(cols);
      expect(h.startsWith('─── sessions · …')).toBe(true);
      expect(h).toContain(hints);
    }
    // one cell of room: the path is a lone `…`
    expect(pickerHeader({ workspace: longWs, widened: false, columns: minCols + 1 })).toBe(`─── sessions · …${hints}`);
    expect(pickerHeader({ workspace: longWs, widened: false, columns: 100 })).toContain('/segment/proj (Ctrl-A all)');
    // a path that fits is never squeezed
    expect(pickerHeader({ workspace: WS, widened: false, columns: 100 })).toContain(`sessions · ${WS} (Ctrl-A all)`);
    // the ASCII twin uses `~` for the squeeze
    const a = pickerHeader({ workspace: longWs, widened: false, columns: 90, ascii: true });
    expect(a.startsWith('--- sessions - ~')).toBe(true);
    expect(a).toContain('Esc ----');
    expect(/^[\x20-\x7e]+$/.test(a)).toBe(true);
    // below the fixed text the row is clipped from the right, exactly `columns` wide
    for (const cols of [minCols, 60, 30]) {
      const tiny = pickerHeader({ workspace: longWs, widened: false, columns: cols });
      expect(pickerCellWidth(tiny)).toBe(cols);
      expect(tiny.endsWith('…')).toBe(true);
    }
    // widened rows never need the squeeze
    expect(pickerHeader({ workspace: longWs, widened: true, columns: 90 })).toContain('sessions · all (Ctrl-A all)');
  });

  it('rows with a rocket, a ZWJ family and fullwidth punctuation never exceed columns under the default measurer', () => {
    const family = '👨\u200d👩\u200d👧';
    const ws = '/Users/me/🚀/proj';
    const rocket = session(1, { title: `ship it 🚀🚀🚀 ${family} ｆｕｌｌ！？，`, workspace: ws, lastUsed: new Date(NOW - 60_000 * 5).toISOString() });
    const cjk = session(2, { title: '日本語のタイトルです。とても長いタイトルなので切り詰められるはず', workspace: ws });
    for (const cols of [8, 12, 20, 33, 47, 60, 79, 120]) {
      const rows = pickerRows([rocket, cjk], { workspace: ws, widened: true, nowMs: NOW, columns: cols, live: () => true });
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(pickerCellWidth(r)).toBeLessThanOrEqual(cols);
        expect(r).not.toMatch(/\u200d$/);
      }
      expect(pickerCellWidth(pickerHeader({ workspace: ws, widened: false, columns: cols }))).toBe(cols);
    }
    const wide = pickerRows([rocket], { workspace: ws, widened: false, nowMs: NOW, columns: 200 })[0]!;
    expect(wide).toContain(`ship it 🚀🚀🚀 ${family} ｆｕｌｌ！？，`);
    // an injected measurer is honoured
    const counted = pickerRows([rocket], { workspace: ws, widened: false, nowMs: NOW, columns: 10, cellWidth: (s) => s.length })[0]!;
    expect(counted.length).toBeLessThanOrEqual(10);
  });

  it('rows: `time ago │ steps │ stop │ $cost │ title-or-task60 │ (workspace) │ ● live`, clipped to columns', () => {
    const done = session(1, { title: 'tz fixes', lastUsed: new Date(NOW - 3 * 60_000).toISOString() });
    const live = session(2, { title: '', task60: 'update the docs', runs: [runRow(2, { live: true, stopReason: null, steps: null, endedAt: null })], lastUsed: new Date(NOW - 2 * 3_600_000).toISOString() });
    const rows = pickerRows([done, live], { workspace: WS, widened: false, nowMs: NOW, columns: 120, live: () => true });
    expect(rows).toEqual([`3m ago   │   9 │ complete     │   $0.115 │ tz fixes`, `2h ago   │   … │ live         │   $0.115 │ update the docs │ ● live`]);
    // the lock check can veto the index's live flag
    const noLock = pickerRows([live], { workspace: WS, widened: false, nowMs: NOW, columns: 120, live: () => false });
    expect(noLock[0]).toBe(`2h ago   │   – │ —            │   $0.115 │ update the docs`);
    // widened adds the workspace column; ASCII twin swaps the glyphs
    const wide = pickerRows([done], { workspace: '/other', widened: true, nowMs: NOW, columns: 120, ascii: true });
    expect(wide[0]).toBe(`3m ago   |   9 | complete     |   $0.115 | tz fixes | ${WS}`);
    // clipped to columns, never wider
    for (const cols of [10, 20, 40, 59]) {
      const r = pickerRows([done, live], { workspace: WS, widened: true, nowMs: NOW, columns: cols });
      for (const line of r) expect(approxCellWidth(line)).toBeLessThanOrEqual(cols);
    }
    expect(pickerRows([done], { workspace: WS, widened: false, nowMs: NOW, columns: 0 })[0]).toContain('tz fixes');
    expect(pickerRows([], { workspace: WS, widened: false, nowMs: NOW, columns: 80 })).toEqual([]);
    // a session with neither title nor task shows its id; NaN cost is `$?`
    const bare = session(3, { title: '', task60: '', totalUsd: Number.NaN, runs: [] });
    expect(pickerRows([bare], { workspace: WS, widened: false, nowMs: NOW, columns: 120 })[0]).toContain(`$? │ ${bare.sessionId}`);
  });

  it('newestRun / stopWord', () => {
    const s = session(1, { runs: [runRow(1), runRow(2, { startedAt: '2026-09-20T14:09:00.000Z' })] });
    expect(newestRun(s)?.runId).toBe(runId(2));
    expect(newestRun(session(1, { runs: [] }))).toBeNull();
    expect(stopWord('spend_cap', false)).toBe('spend_cap');
    expect(stopWord(null, true)).toBe('live');
    expect(stopWord(null, false)).toBe('—');
  });
});

describe('--resume <id|title> resolution (§8.4)', () => {
  const a = session(1, { title: 'tz fixes' });
  const b = session(2, { title: 'TZ fixes round two' });
  const c = session(3, { title: 'docs' });
  it('run id, then exact title, then a unique case-insensitive prefix, else ambiguous / none', () => {
    expect(resolveResumeTarget([a, b, c], runId(2))).toEqual({ kind: 'run', session: b, runId: runId(2) });
    expect(resolveResumeTarget([a, b, c], 'tz fixes')).toEqual({ kind: 'session', session: a });
    expect(resolveResumeTarget([a, b, c], 'DOC')).toEqual({ kind: 'session', session: c });
    expect(resolveResumeTarget([a, b, c], 'tz fixes r')).toEqual({ kind: 'session', session: b });
    expect(resolveResumeTarget([a, b, c], 'TZ')).toEqual({ kind: 'ambiguous', candidates: [a, b] });
    expect(resolveResumeTarget([a, b, c], 'nothing')).toEqual({ kind: 'none' });
    expect(resolveResumeTarget([a, b, c], '   ')).toEqual({ kind: 'none' });
    const dupe = session(4, { title: 'tz fixes' });
    expect(resolveResumeTarget([a, dupe], 'tz fixes')).toEqual({ kind: 'ambiguous', candidates: [a, dupe] });
  });
  it('messages', () => {
    expect(ambiguousResumeMessage('TZ', [a, b])).toBe(`--resume: "TZ" matches 2 sessions: ${a.sessionId} "tz fixes", ${b.sessionId} "TZ fixes round two"`);
    expect(recentSessionHint(a, Date.parse(a.lastUsed) + 3 * 60_000)).toBe('recent: "tz fixes" · 3m ago  (Enter continues, /resume browses)');
    expect(recentSessionHint(a, Date.parse(a.lastUsed) + 3 * 60_000, true)).toBe('recent: "tz fixes" - 3m ago  (Enter continues, /resume browses)');
    expect(noSessionMessage(WS)).toBe(`no session in ${WS} yet`);
  });
});
