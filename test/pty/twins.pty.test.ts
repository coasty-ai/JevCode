/**
 * TUI-DESIGN §1 / §8.9 / §15.1 pty scenarios of the renderer twins: the `--plain` TTY readline composer runs a mocked
 * task; `--json` on a pipe is a valid NDJSON envelope; and the three-way transcript identity — after a mocked run,
 * `<run>/transcript.log`, the plain renderer's item lines and the TUI's `<Static>` item lines (extracted from the
 * capture with ANSI stripped) are identical line for line. The TUI leg runs twice: at 640 columns, where no `<Static>`
 * row soft-wraps (the longest mocked item is ~430 characters; `TRANSCRIPT_TEXT_MAX` caps items at 600) and the item
 * rows are read off the capture with no help from the transcript; and at the brief's 24x80, where Ink soft-wraps 18 of
 * the 40 lines and the rows are re-joined against the transcript (`reflowAgainst`: a continuation is the next prefix
 * of the open line, directly or after the trimmed break spaces) so the identity holds at a realistic width too. The
 * TUI-only detail rows under a proposal (§15.1) carry no item label and are excluded by construction in both legs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIRST_FRAME_STEP, afterFirstFrame, binPath, childEnv, cleanupScratch, countClears, drive, hasExpect, isItemRow, isLocalItem, itemRows, normaliseRunLine, reflowAgainst, registerScratch, staticRows, stripAnsi } from './helpers.js';

afterEach(cleanupScratch);

/** a mocked one-shot run over a pipe (no pty): the plain or json renderer's stdout, its exit code and its run dir */
function pipeRun(args: readonly string[]): { code: number; stdout: string; stderr: string; home: string; transcript: string[] | null } {
  const home = mkdtempSync(join(tmpdir(), 'jevcode-pty-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'jevcode-pty-ws-'));
  registerScratch(home, workspace);
  const r = spawnSync(process.execPath, [binPath(), ...args, '--workspace', workspace], { cwd: workspace, env: childEnv(home, 24, 80), encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const runsDir = join(home, 'runs');
  const runs = existsSync(runsDir) ? readdirSync(runsDir) : [];
  let transcript: string[] | null = null;
  const log = runs.length === 1 ? join(runsDir, runs[0]!, 'transcript.log') : null;
  if (log !== null && existsSync(log)) {
    transcript = readFileSync(log, 'utf8').split('\n');
    if (transcript.at(-1) === '') transcript.pop();
  }
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', home, transcript };
}

const TASK = 'probe task';
const MOCK_5 = ['--mock', '--mock-steps', '5'] as const;

describe.skipIf(!hasExpect)('pty: --plain, --json and the three-way identity (§1, §8.9, §15.1)', () => {
  it('--plain on a TTY: the readline composer takes a task, steers nothing, shows the epilogue item and /exit leaves 0', async () => {
    const r = await drive({
      name: 'twins-plain-tty',
      args: ['chat', '--plain', '--mock', '--mock-steps', '4'],
      steps: ['expect \\[sandbox\\]', 'send fix the failing test\\r', 'expect \\[run\\] start', 'expect end complete', 'expect \\[ui\\] stopped — complete \\(exit 0\\)', 'expect \\n> ', 'send /exit\\r', 'eof'],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text).replace(/\r\n/g, '\n');
    expect(plain).toMatch(/^\[run\] jevcode session · \S+ \| step 0\/– starting$/m);
    expect(plain).toMatch(/\[run\] start \S+ mode=jev-on task: fix the failing test/);
    expect(plain).toMatch(/\[run\] end complete steps=4/);
    // cooked mode: the typed line is echoed by the kernel after the `> ` prompt, then the items follow
    expect(plain).toContain('fix the failing test\n');
    expect(plain).not.toContain('\x1b[?25l');
    expect(r.text).not.toContain('\x1b[?2004h'); // no bracketed paste on the plain twin (§1)
    const transcript = r.transcript();
    expect(transcript?.at(-1)).toMatch(/^\[run\] end complete /);
  });

  it('--json on a pipe: `stream:start` envelope first, every line parses, no `status`, run:end carries exitCode', () => {
    const r = pipeRun(['run', TASK, '--mock', '--mock-steps', '3', '--json']);
    expect(r.code).toBe(0);
    const lines = r.stdout.split('\n').filter((l) => l !== '');
    expect(lines.length).toBeGreaterThan(10);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const first = parsed[0]!;
    expect(first).toMatchObject({ v: 1, type: 'stream:start', schema: 'jevcode.events/1' });
    expect(typeof first['jevcode']).toBe('string');
    expect(typeof first['t']).toBe('string');
    for (const p of parsed.slice(1)) {
      expect(p['v']).toBe(1);
      expect(typeof p['t']).toBe('string');
      expect(typeof p['type']).toBe('string');
      expect(p['type']).not.toBe('status');
    }
    const end = parsed.find((p) => p['type'] === 'run:end');
    expect(end).toBeDefined();
    expect(end!['exitCode']).toBe(0);
    expect(end!['resumable']).toBe(false);
    expect((end!['result'] as Record<string, unknown>)['stopReason']).toBe('complete');
    expect(typeof (end!['paths'] as Record<string, unknown>)['runDir']).toBe('string');
    expect(parsed.some((p) => p['type'] === 'run:start')).toBe(true);
    // stdout is the stream only: no frame bytes, no epilogue
    expect(r.stdout).not.toContain('\x1b[');
    expect(r.stdout).not.toContain('jevcode: stopped');
  });

  it('three-way identity: transcript.log = plain item lines = TUI <Static> item lines (640 columns, no wrapping; 24x80, wraps re-joined)', async () => {
    // leg 1 — the TUI in a real pty, one-shot; 640 columns so no static row wraps and the items are read off the capture alone
    const tui = await drive({ name: 'twins-identity-tui', args: ['run', TASK, ...MOCK_5], rows: 24, cols: 640, steps: [FIRST_FRAME_STEP, 'expect end complete', 'eof'] });
    expect(tui.timeouts).toBe(0);
    expect(tui.code).toBe(0);
    expect(countClears(afterFirstFrame(tui.text))).toBe(0);
    const tuiTranscript = tui.transcript();
    expect(tuiTranscript).not.toBeNull();
    const rows = staticRows(tui.text);
    const tuiItems = itemRows(rows).filter((r) => !isLocalItem(r));
    const tuiLocal = itemRows(rows).filter(isLocalItem);
    expect(tuiLocal.some((r) => r.startsWith(`[run] jevcode task: ${TASK}`))).toBe(true);
    expect(tuiLocal.some((r) => r.startsWith('[sandbox] '))).toBe(true);
    expect(tuiItems).toEqual(tuiTranscript);
    // TUI-only detail rows exist under the proposals (§15.1) and are not items
    expect(rows.some((r) => /^VALUE_\d+ = \d+$/.test(r))).toBe(true);

    // leg 1b — the same TUI run at the brief's 24x80: Ink soft-wraps the long items; re-joined, the rows rebuild the
    // transcript exactly, every labelled row is accounted for, and the leftovers are only local items, their
    // continuations and the detail rows
    const narrow = await drive({ name: 'twins-identity-tui-80', args: ['run', TASK, ...MOCK_5], rows: 24, cols: 80, steps: [FIRST_FRAME_STEP, 'expect end complete', 'eof'] });
    expect(narrow.timeouts).toBe(0);
    expect(narrow.code).toBe(0);
    expect(countClears(afterFirstFrame(narrow.text))).toBe(0);
    const narrowTranscript = narrow.transcript();
    expect(narrowTranscript).not.toBeNull();
    const narrowRows = staticRows(narrow.text);
    for (const row of narrowRows) expect([...row].length).toBeLessThanOrEqual(80);
    const reflow = reflowAgainst(narrowRows, narrowTranscript!);
    expect(reflow.mismatches).toEqual([]);
    expect(reflow.lines).toEqual(narrowTranscript);
    expect(reflow.wrappedRows).toBeGreaterThan(0);
    expect(narrowRows.length).toBeGreaterThan(rows.length); // the same items took more rows at 80 columns
    expect(reflow.leftovers.filter((r) => isItemRow(r) && !isLocalItem(r))).toEqual([]);
    expect(reflow.leftovers.some((r) => r.startsWith(`[run] jevcode task: ${TASK}`))).toBe(true);
    expect(reflow.leftovers.some((r) => r.startsWith('[sandbox] '))).toBe(true);
    expect(reflow.leftovers.some((r) => /^VALUE_\d+ = \d+$/.test(r))).toBe(true);

    // leg 2 — the plain renderer on a pipe, the same task
    const plain = pipeRun(['run', TASK, ...MOCK_5, '--plain']);
    expect(plain.code).toBe(0);
    expect(plain.transcript).not.toBeNull();
    const plainLines = plain.stdout.split('\n');
    if (plainLines.at(-1) === '') plainLines.pop();
    const plainItems = itemRows(plainLines).filter((r) => !isLocalItem(r));
    expect(plainItems).toEqual(plain.transcript);
    // the generator's streamed text is printed raw by the plain twin and is never an item
    expect(plainLines).toContain('Create scratch_0.py');

    // leg 3 — the three runs differ only in run id and timings
    const a = tuiTranscript!.map(normaliseRunLine);
    const b = plain.transcript!.map(normaliseRunLine);
    const c = narrowTranscript!.map(normaliseRunLine);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a.length).toBeGreaterThan(30);
    console.log(`three-way identity: ${a.length} transcript lines; 640 columns: ${rows.length} TUI static rows (${rows.length - tuiItems.length - tuiLocal.length} detail rows); 80 columns: ${narrowRows.length} rows, ${reflow.wrappedRows} continuation rows re-joined, ${reflow.leftovers.length} leftover rows (header, sandbox, detail); ${plainLines.length} plain lines`);
  });
});
