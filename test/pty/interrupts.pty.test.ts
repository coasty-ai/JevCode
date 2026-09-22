/**
 * TUI-DESIGN §3.3 / §13.5 pty scenarios: the Ctrl-C matrix cells S0–S3 (session and one-shot), Esc pause (exit 4 in
 * run mode), Ctrl-D idle and live, `/exit` while live. Exit codes come from the driver (the child's code), bytes from
 * the capture, artefacts from the temp `JEVCODE_HOME`. The `y` of the exit confirm is armed one frame after the row
 * is drawn (§6.3), so those scenarios wait 250 ms between the row and the key — the one sleep the design requires.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_OPEN, CURSOR_SHAPE_RESET, EXIT_IDLE, MOCK_RUN_MODE, PLACEHOLDER_FOLLOWUP, PLACEHOLDER_STEER, PLACEHOLDER_TASK, PROMPT, RUN_OPEN, SGR_GAP, afterFirstFrame, cleanupScratch, countClears, drive, echoStep, hasExpect, lastTimingOf, stripAnsi, submitTask, timingOf } from './helpers.js';

afterEach(cleanupScratch);

/** a live run long enough for typed interactions (~20 ms per mocked step); the mock trajectory trips the loop detector
 * around step 70, so the replan cap is raised to keep the run live for the full 200 steps (~4 s) */
const LONG = [...MOCK_RUN_MODE, '--mock', '--mock-steps', '200', '--max-steps', '200', '--max-replans', '50'] as const;
const EPILOGUE_RE = /jevcode: stopped — (\S+)[^\n]*\(exit (\d+)\)/;

describe.skipIf(!hasExpect)('pty: Ctrl-C / Esc / Ctrl-D matrix (§3.3)', () => {
  it('S0 idle·empty: Ctrl-C hints, a second press within 1.5 s exits 0 with `[ui] exited on Ctrl-C ×2`', async () => {
    const r = await drive({ name: 'int-s0', args: ['chat', '--mock'], steps: [...CHAT_OPEN, 'send \\x03', 'expect press Ctrl-C again to exit', 'send \\x03', 'eof'] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).toContain('[ui] exited on Ctrl-C ×2');
    expect(plain).not.toMatch(EPILOGUE_RE);
    expect(r.text).toContain(CURSOR_SHAPE_RESET);
    expect(r.runDirs()).toEqual([]);
  });

  it('S1 idle·text: Ctrl-C clears the draft to history and never exits', async () => {
    const r = await drive({ name: 'int-s1', args: ['chat', '--mock'], steps: [...CHAT_OPEN, 'send half a thought', echoStep('half a thought'), 'send \\x03', `expect ${PLACEHOLDER_TASK}`, ...EXIT_IDLE] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).not.toContain('press Ctrl-C again to exit');
    expect(plain).not.toContain('exited on Ctrl-C');
    const history = join(r.home, 'history.jsonl');
    expect(existsSync(history)).toBe(true);
    expect(readFileSync(history, 'utf8')).toContain('half a thought');
  });

  it('S2 live·empty, one-shot: Ctrl-C after step 1 aborts → exit 130 with the epilogue, state.json written, steps.jsonl has step 1 and no declined step', async () => {
    // steps.jsonl gets its first record when a step completes (engine.ts appendStep), so the abort is sent once step 1 has
    // committed: its `[step 1]` summary line (TUI-DESIGN-2 §4.5, the one item per step the compact transcript shows) is on
    // the screen, step 2 is the in-flight step the abort discards (rule 1)
    const r = await drive({ name: 'int-s2-oneshot', args: ['run', 'probe task', ...LONG], steps: [...RUN_OPEN, 'expect \\[step 1\\] ', 'send \\x03', 'expect finished [·-] human_abort', 'eof'] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(130);
    const plain = stripAnsi(r.text);
    const ep = EPILOGUE_RE.exec(plain);
    expect(ep?.[1]).toBe('human_abort');
    expect(ep?.[2]).toBe('130');
    // the epilogue is printed after the terminal was restored (§13.4 order)
    const restoredAt = r.text.indexOf(CURSOR_SHAPE_RESET);
    expect(restoredAt).toBeGreaterThan(0);
    expect(r.text.indexOf('jevcode: stopped')).toBeGreaterThan(restoredAt);
    const dirs = r.runDirs();
    expect(dirs).toHaveLength(1);
    expect(existsSync(join(dirs[0]!, 'state.json'))).toBe(true);
    const steps = join(dirs[0]!, 'steps.jsonl');
    expect(existsSync(steps)).toBe(true);
    const records = readFileSync(steps, 'utf8').split('\n').filter((l) => l !== '');
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records[0]).toMatch(/"step":1\b/);
    expect(records.join('\n')).not.toMatch(/"declined"/);
    expect(plain).toMatch(/\[run\] finished [·-] human_abort [·-] [1-9]\d* steps/);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
  });

  it('S2 live·empty, session: Ctrl-C aborts and stays — `run:end` item carries exit 130, the composer reopens', async () => {
    const r = await drive({ name: 'int-s2-session', args: ['chat', ...LONG], steps: [...CHAT_OPEN, ...submitTask('make the tests pass'), 'send \\x03', 'expect finished [·-] human_abort', `expect ${PLACEHOLDER_FOLLOWUP}`, ...EXIT_IDLE] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).toMatch(/\[run\] finished [·-] human_abort [·-] \d+ steps[\s\S]{0,200}?exit 130/); // wrap-tolerant: the item may soft-wrap at 80 columns
    expect(plain).toContain('Follow-up, question, or /command…');
    const t = r.transcript();
    expect(t?.at(-1)).toMatch(/^\[run\] finished [·-] human_abort .* exit 130$/);
  });

  it('S3 live·text: Ctrl-C clears the draft, the run continues to `complete`', async () => {
    const r = await drive({
      name: 'int-s3',
      args: ['chat', ...MOCK_RUN_MODE, '--mock', '--mock-steps', '40', '--max-steps', '40'],
      steps: [...CHAT_OPEN, ...submitTask('make the tests pass'), 'send typed while live', `expect ${PROMPT} ${SGR_GAP}typed while live`, 'send \\x03', `expect ${PLACEHOLDER_STEER}`, 'expect finished [·-] complete', `expect ${PLACEHOLDER_FOLLOWUP}`, ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).not.toContain('human_abort');
    expect(plain).toMatch(/\[run\] finished [·-] complete [·-] 40 steps/);
    const history = join(r.home, 'history.jsonl');
    expect(existsSync(history)).toBe(true);
    expect(readFileSync(history, 'utf8')).toContain('typed while live');
  });

  it('Esc while live in run mode: `human_pause` at the step boundary → exit 4 with state.json written', async () => {
    const r = await drive({ name: 'int-esc-pause', args: ['run', 'probe task', ...LONG], steps: [...RUN_OPEN, 'send \\x1b', 'expect Esc again aborts the run', 'expect finished [·-] human_pause', 'eof'] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(4);
    const plain = stripAnsi(r.text);
    // the `Esc again aborts the run` toast owns the status left zone for 2 s (§3.3), so `pausing after step N` is not asserted
    expect(plain).toMatch(/\[run\] finished [·-] human_pause [·-] \d+ steps/);
    const ep = EPILOGUE_RE.exec(plain);
    expect(ep?.[1]).toBe('human_pause');
    expect(ep?.[2]).toBe('4');
    const dirs = r.runDirs();
    expect(dirs).toHaveLength(1);
    expect(existsSync(join(dirs[0]!, 'state.json'))).toBe(true);
    expect(r.transcript()?.at(-1)).toMatch(/^\[run\] finished [·-] human_pause [·-] \d+ steps .* exit 4$/);
  });

  it('Ctrl-D ×2 idle exits 0 with `[ui] exited on Ctrl-D ×2`', async () => {
    const r = await drive({ name: 'int-ctrl-d-idle', args: ['chat', '--mock'], steps: [...CHAT_OPEN, 'send \\x04', 'expect press Ctrl-D again to exit', 'send \\x04', 'eof'] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    expect(stripAnsi(r.text)).toContain('[ui] exited on Ctrl-D ×2');
  });

  it('Ctrl-D ×2 while live opens the exit confirm; `n` stays, `y` aborts and exits 0 (the run:end item says 130)', async () => {
    const r = await drive({
      name: 'int-ctrl-d-live',
      args: ['chat', ...LONG],
      steps: [
        ...CHAT_OPEN,
        ...submitTask('make the tests pass'),
        'send \\x04',
        'expect run is live — Ctrl-D again to choose',
        'send \\x04',
        'expect a run is live: \\[y\\] abort and exit',
        'sleep 0.25', // §6.3 arming: y counts one frame after the row is drawn
        'send n',
        `expect ${PLACEHOLDER_STEER}`,
        'send \\x04',
        'expect run is live — Ctrl-D again to choose',
        'send \\x04',
        'expect a run is live: \\[y\\] abort and exit',
        'sleep 0.25',
        'send y',
        'expect finished [·-] human_abort',
        'eof',
      ],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).toMatch(/\[run\] finished [·-] human_abort [·-] \d+ steps[\s\S]{0,200}?exit 130/); // wrap-tolerant: the item may soft-wrap at 80 columns
    expect(plain).toContain('[ui] exited on Ctrl-D ×2');
    expect(r.text).toContain(CURSOR_SHAPE_RESET);
    // the process leaves right after run:end (a transient reopened-composer frame may precede the unmount)
    // the timing record carries the expect PATTERN verbatim, so it moved with the §3.7 G1 anchor
    const ended = timingOf(r.timing, 'expect', 'finished [·-] human_abort');
    const eof = lastTimingOf(r.timing, 'eof');
    const exitLag = eof!.t - ended!.t;
    expect(exitLag).toBeLessThan(3000);
    const dirs = r.runDirs();
    expect(dirs).toHaveLength(1);
    expect(existsSync(join(dirs[0]!, 'state.json'))).toBe(true);
    console.log(`Ctrl-D live: process exit ${exitLag} ms after the run:end item`);
  });

  it('/exit while live → the exit confirm first; `y` → abort → run:end → exit 0 with a final state.json', async () => {
    const r = await drive({
      name: 'int-exit-live',
      args: ['chat', ...LONG],
      steps: [...CHAT_OPEN, ...submitTask('make the tests pass'), 'send /exit', `expect ${PROMPT} ${SGR_GAP}/exit`, 'send \\r', 'expect a run is live: \\[y\\] abort and exit', 'sleep 0.25', 'send y', 'expect finished [·-] human_abort', 'eof'],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).toMatch(/\[run\] finished [·-] human_abort [·-] \d+ steps[\s\S]{0,200}?exit 130/); // wrap-tolerant: the item may soft-wrap at 80 columns
    const dirs = r.runDirs();
    expect(dirs).toHaveLength(1);
    expect(existsSync(join(dirs[0]!, 'state.json'))).toBe(true);
  });
});
