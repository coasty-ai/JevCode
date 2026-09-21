/**
 * TUI-DESIGN §19.3 (`picker.test.tsx`, §8.4, §12.5): the picker reducer (move / page / widen / preview / rename /
 * delete arm), the rows in the pane slot (`▌` on the selection, the preview rows, the hint row, padding to `rows`),
 * the composer filter over title / task / id, the rule rows (§24), the Space preview reading `state.json` and a
 * `transcript.log` tail only, and `x` then `y` moving run dirs to the trash (never `rm -rf`, never a malformed id).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionRow } from '../../../src/core/types.js';
import { INITIAL_PICKER, PICKER_HINT, moveRunsToTrash, pickerLines, pickerReducer, pickerRule, readPickerPreview, selectedSession, visibleSessions, type PickerState } from '../../../src/tui/Picker.js';
import { stringWidth } from '../../../src/tui/composer/width.js';

const NOW = Date.parse('2026-09-20T12:00:00Z');
function session(id: string, title: string, task60: string, hoursAgo: number, workspace = '/Users/me/proj'): SessionRow {
  const t = new Date(NOW - hoursAgo * 3_600_000).toISOString();
  return { sessionId: id, workspace, title, task60, runs: [{ runId: id, parentRunId: null, startedAt: t, endedAt: t, stopReason: 'max_steps', steps: 7, costUsd: { generator: 0.28, jev: 0.03 }, exitCode: 4, resumable: true, resumes: 0, live: false }], lastUsed: t, createdAt: t, totalUsd: 0.31, mode: 'jev-on', branch: 'main' };
}
const sessions = [session('20260920-100000-aaaaaaaa', 'fix parse_date tz', 'fix parse_date tz handling', 2), session('20260919-100000-bbbbbbbb', '', 'add retry to the OpenRouter client', 26), session('20260917-100000-cccccccc', 'migrate tests', 'migrate tests to pytest', 72), session('20260918-100000-dddddddd', 'other ws', 'x', 5, '/Users/me/other')];
const open = (): PickerState => pickerReducer(INITIAL_PICKER, { type: 'open', kind: 'sessions', sessions, workspace: '/Users/me/proj' });
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('pickerReducer', () => {
  it('open / move / page clamp to the visible count; widen toggles and resets; preview / rename / deleteArm set their flags', () => {
    let s = open();
    expect(s.selected).toBe(0);
    s = pickerReducer(s, { type: 'move', by: 1, count: 3 });
    expect(s.selected).toBe(1);
    s = pickerReducer(s, { type: 'page', by: 1, size: 10, count: 3 });
    expect(s.selected).toBe(2);
    s = pickerReducer(s, { type: 'move', by: -5, count: 3 });
    expect(s.selected).toBe(0);
    s = pickerReducer(s, { type: 'preview', lines: ['preview: x'] });
    expect(s.preview).toEqual(['preview: x']);
    s = pickerReducer(s, { type: 'move', by: 1, count: 3 });
    expect(s.preview).toBeNull();
    s = pickerReducer(s, { type: 'deleteArm', on: true });
    expect(s.deleteArmed).toBe(true);
    s = pickerReducer(s, { type: 'widen' });
    expect(s).toMatchObject({ widened: true, selected: 0, deleteArmed: false });
    s = pickerReducer(s, { type: 'rename', on: true });
    expect(s.renaming).toBe(true);
  });

  it('the composer filter is a case-folded subsequence over title, task60 and ids; widened shows every workspace', () => {
    const s = open();
    expect(visibleSessions(s, '').map((x) => x.sessionId)).toEqual(['20260920-100000-aaaaaaaa', '20260919-100000-bbbbbbbb', '20260917-100000-cccccccc']);
    expect(visibleSessions(s, 'par').map((x) => x.title)).toEqual(['fix parse_date tz']);
    expect(visibleSessions(s, 'RETRY').map((x) => x.task60)).toEqual(['add retry to the OpenRouter client']);
    expect(visibleSessions(pickerReducer(s, { type: 'widen' }), '')).toHaveLength(4);
    expect(selectedSession(pickerReducer(s, { type: 'move', by: 2, count: 3 }), '')?.title).toBe('migrate tests');
  });
});

describe('pickerLines / pickerRule (§24, F-L)', () => {
  it('the header names the workspace and the keys; the rows carry ▌ on the selection, the preview rows and the hint, padded to rows', () => {
    const s = pickerReducer(open(), { type: 'preview', lines: ['preview: plan done 2/5 · remaining 3'] });
    const rule = pickerRule(s, 80);
    // O6 squeezes a long workspace path from the left so the key hints survive at 80 columns
    expect(rule).toMatch(/^─── sessions · (\/Users\/me\/proj|…\S*) \(Ctrl-A all\) · by updated ─ ↑↓ Enter Space Ctrl-R x Esc ─+$/);
    expect(pickerRule({ ...s, workspace: 'proj' }, 80)).toMatch(/^─── sessions · proj \(Ctrl-A all\) · by updated ─ ↑↓ Enter Space Ctrl-R x Esc ─+$/);
    expect(stringWidth(rule)).toBe(80);
    const { lines, selected } = pickerLines(s, { filter: '', rows: 12, columns: 80, nowMs: NOW });
    expect(lines).toHaveLength(12);
    expect(selected).toBe(0);
    expect(lines[0]).toMatch(/^▌ 2h ago/);
    expect(lines[0]).toContain('fix parse_date tz');
    expect(lines[1]).toMatch(/^ {2}1d ago/);
    expect(lines.some((l) => l === '  preview: plan done 2/5 · remaining 3')).toBe(true);
    expect(lines.some((l) => l === `  ${PICKER_HINT}`)).toBe(true);
    for (const l of lines) expect(stringWidth(l)).toBeLessThanOrEqual(80);
  });

  it('an empty filter result shows `no session in <path> yet`; the delete arm replaces the hint; rewind kind uses its rule', () => {
    const { lines } = pickerLines(open(), { filter: 'zzzz', rows: 3, columns: 80, nowMs: NOW });
    expect(lines[0]).toBe('  no session in /Users/me/proj yet');
    const armed = pickerLines(pickerReducer(open(), { type: 'deleteArm', on: true }), { filter: '', rows: 6, columns: 80, nowMs: NOW });
    expect(armed.lines.some((l) => l.includes('delete this session? y confirms'))).toBe(true);
    const rewind = pickerReducer(INITIAL_PICKER, { type: 'open', kind: 'rewind', rewindSteps: [{ step: 3, changedFiles: ['a.py'] }, { step: 5, changedFiles: [] }, { step: 7, changedFiles: ['b.py', 'c.py'] }], workspace: '/w' });
    expect(pickerRule(rewind, 80)).toMatch(/^─── rewind · steps with changes ─ ↑↓ Enter Esc ─+$/);
    const r = pickerLines(rewind, { filter: '', rows: 4, columns: 80, nowMs: NOW });
    expect(r.lines[0]).toMatch(/^▌ s3 {3}1 file {2}a\.py/);
    expect(r.lines[1]).toMatch(/^ {2}s7 {3}2 files/);
  });
});

describe('readPickerPreview / moveRunsToTrash (§8.4)', () => {
  it('Space reads state.json counts and the transcript tail; never steps.jsonl', () => {
    const root = mkdtempSync(join(tmpdir(), 'jevcode-picker-'));
    dirs.push(root);
    const run = join(root, 'runs', 'r1');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'state.json'), JSON.stringify({ version: 1, state: { step: 7, stopReason: 'max_steps', plan: { done: [1, 2], remaining: [1, 2, 3] }, spend: { totalUsd: 0.31 } } }));
    writeFileSync(join(run, 'transcript.log'), `${'x'.repeat(5000)}\n[step 7] judge succeeded=0.89\n[run] end max_steps steps=7\n`);
    writeFileSync(join(run, 'steps.jsonl'), 'never read');
    const lines = readPickerPreview(join(root, 'runs'), 'r1');
    expect(lines[0]).toBe('preview: plan done 2/5 · remaining 3 · spend $0.310 · stop max_steps @ step 7');
    expect(lines.slice(1)).toEqual(['[step 7] judge succeeded=0.89', '[run] end max_steps steps=7']);
    expect(readPickerPreview(join(root, 'runs'), 'missing')[0]).toMatch(/^preview: state\.json unreadable/);
  });

  it('x then y moves run dirs to the trash (rename, never rm -rf) and refuses malformed ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'jevcode-trash-'));
    dirs.push(root);
    const runs = join(root, 'runs');
    mkdirSync(join(runs, 'r1'), { recursive: true });
    writeFileSync(join(runs, 'r1', 'run.json'), '{}');
    const r = moveRunsToTrash(runs, join(root, 'trash'), ['r1', 'missing', '../evil']);
    expect(r.moved).toEqual(['r1']);
    expect(r.failed).toEqual([{ runId: 'missing', code: 'ENOENT' }, { runId: '../evil', code: 'EINVAL' }]);
    expect(existsSync(join(root, 'trash', 'r1', 'run.json'))).toBe(true);
    expect(existsSync(join(runs, 'r1'))).toBe(false);
  });
});
