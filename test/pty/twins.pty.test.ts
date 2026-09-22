/**
 * TUI-DESIGN §1 / §8.9 / §15.1 pty scenarios of the renderer twins: the `--plain` TTY readline composer runs a mocked
 * task; `--json` on a pipe is a valid NDJSON envelope; and the transcript identity of TUI-DESIGN-2 §9 — after a mocked
 * run, `<run>/transcript.log` and the plain renderer's item lines are identical line for line (predicate (c)), and the
 * TUI's `<Static>` item lines (extracted from the capture with ANSI stripped) are the declared `compact` subsequence
 * of `transcript.log` (predicate (b): the stage kinds and `run:ready` hidden, one `[step N]` summary line per step,
 * `run:start` / `run:end` / `confirm:resolved` shown). The TUI leg runs twice: at 640 columns, where no `<Static>` row
 * soft-wraps (the longest mocked item is ~430 characters; `TRANSCRIPT_TEXT_MAX` caps items at 600) and the item rows are
 * read off the capture with no help from the transcript; and at the brief's 24x80, where Ink soft-wraps the long items
 * and the rows are re-joined against the transcript (`reflowAgainst`: a continuation is the next prefix of the open
 * line, directly or after the trimmed break spaces) so the rule holds at a realistic width too. The TUI-only detail
 * rows under a proposal (§15.1) carry no item label and are excluded by construction in both legs; the `[you]` /
 * `[jevcode]` bubbles are renderer-local (§3.10) and never in transcript.log.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIRST_FRAME_STEP, HIDDEN_STAGE_RE, MOCK_RUN_MODE, afterFirstFrame, binPath, childEnv, cleanupScratch, countClears, drive, hasExpect, isItemRow, isLocalItem, itemRows, normaliseRunLine, reflowAgainst, registerScratch, staticRows, stripAnsi, subsequenceOf } from './helpers.js';

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
/** the scripted mock trajectory is a generator trajectory: `--mode jev-on` explicitly, whatever `DEFAULT_MODE` is (TUI-DESIGN-3 §1.10) */
const MOCK_5 = [...MOCK_RUN_MODE, '--mock', '--mock-steps', '5'] as const;

describe.skipIf(!hasExpect)('pty: --plain, --json and the three-way identity (§1, §8.9, §15.1)', () => {
  it('--plain on a TTY: the readline composer takes a task, steers nothing, shows the epilogue item and /exit leaves 0', async () => {
    const r = await drive({
      name: 'twins-plain-tty',
      args: ['chat', '--plain', ...MOCK_RUN_MODE, '--mock', '--mock-steps', '4'],
      steps: ['expect \\[sandbox\\]', 'send fix the failing test\\r', 'expect \\[you\\] fix the failing test', 'expect \\[run\\] started [·-]', 'expect finished [·-] complete', 'expect \\[ui\\] stopped — complete \\(exit 0\\)', 'expect \\n> ', 'send /exit\\r', 'eof'],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text).replace(/\r\n/g, '\n');
    expect(plain).toMatch(/^\[run\] jevcode session · \S+ \| step 0\/– starting$/m);
    // TUI-DESIGN-2 §3.10: the `[you]` bubble is the same line in the plain twin; the mock intake reads the line as `coding_task`
    expect(plain).toMatch(/^\[you\] fix the failing test$/m);
    expect(plain).toMatch(/\[run\] started [·-] jev\+llm [·-] fix the failing test/);
    expect(plain).toMatch(/\[run\] finished [·-] complete [·-] 4 steps/);
    // cooked mode: the typed line is echoed by the kernel after the `> ` prompt, then the items follow
    expect(plain).toContain('fix the failing test\n');
    expect(plain).not.toContain('\x1b[?25l');
    expect(r.text).not.toContain('\x1b[?2004h'); // no bracketed paste on the plain twin (§1)
    const transcript = r.transcript();
    expect(transcript?.at(-1)).toMatch(/^\[run\] finished [·-] complete /);
  });

  it('--json on a pipe: `stream:start` envelope first, every line parses, no `status`, run:end carries exitCode', () => {
    const r = pipeRun(['run', TASK, ...MOCK_RUN_MODE, '--mock', '--mock-steps', '3', '--json']);
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

  it('identity (TUI-DESIGN-2 §9): transcript.log = plain item lines; the TUI <Static> item lines are the compact subsequence (640 columns, no wrapping; 24x80, wraps re-joined)', async () => {
    // leg 1 — the TUI in a real pty, one-shot; 640 columns so no static row wraps and the items are read off the capture alone
    const tui = await drive({ name: 'twins-identity-tui', args: ['run', TASK, ...MOCK_5], rows: 24, cols: 640, steps: [FIRST_FRAME_STEP, 'expect finished [·-] complete', 'eof'] });
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
    // predicate (b): every TUI item row is a transcript.log line, in order — the declared `compact` subsequence (§4.5):
    // the stage kinds and `run:ready` are hidden, `[run] start`, one `[step N]` summary per step and `[run] end` are shown
    const sub = subsequenceOf(tuiItems, tuiTranscript!);
    expect(sub.missing).toBeNull();
    expect(tuiItems.length).toBeGreaterThan(3);
    expect(tuiItems.filter((r) => HIDDEN_STAGE_RE.test(r))).toEqual([]);
    expect(tuiItems.some((r) => /^\[run\] started [·-] /.test(r))).toBe(true);
    expect(tuiItems.some((r) => /^\[run\] finished [·-] complete /.test(r))).toBe(true);
    expect(tuiItems.filter((r) => /^\[step \d+\] /.test(r)).length).toBeGreaterThanOrEqual(5); // one summary line per mocked step
    expect(tuiTranscript!.some((r) => HIDDEN_STAGE_RE.test(r))).toBe(true); // transcript.log keeps every stage line
    // the round-1 detail rows under a proposal (§15.1) belonged to the hidden `proposal` items; a `compact` TUI shows none
    expect(rows.some((r) => /^VALUE_\d+ = \d+$/.test(r))).toBe(false);

    // leg 1b — the same TUI run at the brief's 24x80: Ink soft-wraps the long items; re-joined against the transcript
    // lines the TUI shows, the rows rebuild those lines exactly, every labelled row is accounted for, and the leftovers
    // are only local items and their continuations
    const narrow = await drive({ name: 'twins-identity-tui-80', args: ['run', TASK, ...MOCK_5], rows: 24, cols: 80, steps: [FIRST_FRAME_STEP, 'expect finished [·-] complete', 'eof'] });
    expect(narrow.timeouts).toBe(0);
    expect(narrow.code).toBe(0);
    expect(countClears(afterFirstFrame(narrow.text))).toBe(0);
    const narrowTranscript = narrow.transcript();
    expect(narrowTranscript).not.toBeNull();
    const narrowRows = staticRows(narrow.text);
    // every static row fits the terminal: a wider row means the body of a labelled item was wrapped at the full width instead of the width minus its hanging indent (TUI-DESIGN-2 §3.10 / §4.5)
    for (const row of narrowRows) expect([...row].length, `static row wider than 80 columns: ${JSON.stringify(row)}`).toBeLessThanOrEqual(80);
    // the compact subsequence of this run's transcript (the same kinds the 640-column leg showed, by shape)
    const shown = narrowTranscript!.filter((l) => !HIDDEN_STAGE_RE.test(l));
    // TUI-DESIGN-2 §3.10 / §9 (a): every continuation row hangs under the text column (`label.length + 1` cells) in compact and full alike
    const reflow = reflowAgainst(narrowRows, shown, { hangingIndent: true });
    expect(reflow.mismatches).toEqual([]);
    expect(reflow.lines).toEqual(shown);
    expect(reflow.wrappedRows).toBeGreaterThan(0);
    expect(narrowRows.length).toBeGreaterThan(rows.length); // the same items took more rows at 80 columns
    expect(reflow.leftovers.filter((r) => isItemRow(r) && !isLocalItem(r))).toEqual([]);
    expect(reflow.leftovers.some((r) => r.startsWith(`[run] jevcode task: ${TASK}`))).toBe(true);
    expect(reflow.leftovers.some((r) => r.startsWith('[sandbox] '))).toBe(true);

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
    console.log(`identity: ${a.length} transcript lines, ${tuiItems.length} shown by the compact TUI (${tuiTranscript!.length - tuiItems.length} stage lines hidden); 640 columns: ${rows.length} TUI static rows (${rows.length - tuiItems.length - tuiLocal.length} spacer/other rows); 80 columns: ${narrowRows.length} rows, ${reflow.wrappedRows} continuation rows re-joined, ${reflow.leftovers.length} leftover rows (header, sandbox, spacers); ${plainLines.length} plain lines`);
  });
});
