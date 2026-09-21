/**
 * TUI-DESIGN §19.5 pty scenarios of the session TUI: first frame, submit and focus, steer, paste chip, secret gate,
 * NO_COLOR, tiny terminals, the resize storms and Ctrl-Z. Every run is `--mock` (no network) inside a real pty driven by
 * scripts/pty/drive.exp; sentinels are expected, never slept for, except where the design itself arms a key one frame
 * after a row is drawn (§6.3) or an external sampler needs the process alive for a moment — those waits are named inline.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CHAT_OPEN,
  CHAT_OPEN_NARROW,
  CURSOR_HIDE,
  CURSOR_SHAPE_RESET,
  EXIT_IDLE,
  RAW_MODE_STEP,
  SGR_GAP,
  afterFirstFrame,
  cleanupScratch,
  countClears,
  countForbidden,
  countSgr,
  drive,
  frames,
  hasExpect,
  jevcodeProcesses,
  markOf,
  segmentClears,
  stripAnsi,
  sttyAll,
  sttyFlag,
  submitTask,
  timingOf,
  ttyOf,
  units,
  waitForProcessState,
  waitForStty,
  type Drive,
  type FrameUnit,
} from './helpers.js';

afterEach(cleanupScratch);

/** a live run long enough for a typed interaction before it ends (~20 ms per mocked step, research 20) */
const LONG_RUN = ['--mock', '--mock-steps', '200', '--max-steps', '200', '--max-replans', '50'] as const;

/** 30 resizes 2 ms apart between the two storm geometries (the brief's storm; 15 shrinks, 15 grows) */
function stormSteps(): string[] {
  const storm: string[] = [];
  for (let i = 0; i < 30; i++) storm.push(i % 2 === 0 ? 'resize 12 60' : 'resize 40 100', 'sleep 0.002');
  return storm;
}

/** the composer echo of the draft plus the markers typed so far, one needle per slow-cycle segment (the first is the storm's end) */
function markerNeedles(draft: string, markers: readonly string[]): string[] {
  const needles: string[] = [];
  let acc = `${draft}Z`;
  needles.push(`> ${acc}`);
  for (const m of markers) {
    acc += m;
    needles.push(`> ${acc}`);
  }
  return needles;
}

describe.skipIf(!hasExpect)('pty: chat session (§1, §3, §4, §14)', () => {
  it('first frame: argv-only, composer visible, `step 0/` sentinel, < 300 ms warm, zero clears', async () => {
    const r = await drive({ name: 'chat-first-frame', args: ['chat', '--mock'], steps: [...CHAT_OPEN, ...EXIT_IDLE] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const first = timingOf(r.timing, 'expect', '25l');
    expect(first).toBeDefined();
    expect(first!.t).toBeLessThan(300);
    const [frame] = frames(r.text);
    expect(frame).toBeDefined();
    const body = frame!.lines.slice(frame!.ruleIndex).join('\n');
    expect(body).toContain('Describe the task…');
    expect(body).toMatch(/step 0\/–/);
    expect(frame!.rows).toBe(3); // rule · composer · status before a run (§2.3)
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
    expect(countForbidden(r.text)).toBe(0);
    // the header is written before the first dynamic frame (research 20 §3)
    expect(stripAnsi(r.text.slice(0, r.text.indexOf(CURSOR_HIDE)))).toMatch(/\[run\] jevcode session · \S+ \| step 0\/– starting/);
    console.log(`first frame (pty, warm): ${first!.t} ms`);
  });

  it('typing + Enter starts a run and the composer keeps focus (steer placeholder, keys still echo)', async () => {
    const r = await drive({
      name: 'chat-submit-focus',
      args: ['chat', ...LONG_RUN],
      steps: [...CHAT_OPEN, ...submitTask('make the tests pass'), 'expect Type to steer the next step', 'send k', `expect > ${SGR_GAP}k`, 'send \\x03', 'expect Type to steer the next step', 'send \\x03', 'expect end human_abort', 'expect Follow-up or /command', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).toMatch(/\[run\] start \S+ mode=jev-on task: make the tests pass/);
    expect(plain).toMatch(/\[run\] ready \S+ step 0\/200/);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
  });

  it('steer while live → `steer queued (1) for step N: <text>` item in the scrollback and transcript.log', async () => {
    const r = await drive({
      name: 'chat-steer',
      args: ['chat', ...LONG_RUN],
      steps: [...CHAT_OPEN, ...submitTask('make the tests pass'), 'send keep the CHANGELOG format', `expect > ${SGR_GAP}keep the CHANGELOG format`, 'send \\r', 'expect steer queued \\(1\\) for step \\d+: keep the CHANGELOG format', 'send \\x03', 'expect end (human_abort|complete)', 'expect Follow-up or /command', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const transcript = r.transcript();
    expect(transcript).not.toBeNull();
    expect(transcript!.some((l) => /^\[step \d+\] steer queued \(1\) for step \d+: keep the CHANGELOG format$/.test(l))).toBe(true);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
  });

  it('20 KB bracketed paste → one chip, no line of the body reaches the pty', async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 400; i++) lines.push(`line ${String(i).padStart(4, '0')} lorem ipsum dolor sit amet consectetur ${i % 10}`);
    const body = lines.join('\\n'); // the driver's subst turns \n into LF
    expect(body.length).toBeGreaterThan(20_000);
    const r = await drive({
      name: 'chat-paste-chip',
      args: ['chat', '--mock'],
      steps: [...CHAT_OPEN, `send \\x1b[200~${body}\\x1b[201~`, 'expect \\[Pasted #1, 400 lines\\]', 'send \\x03', 'expect Describe the task', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).toContain('[Pasted #1, 400 lines]');
    expect(plain).not.toContain('[Pasted #2');
    // no fragment of the body: not one of the 400 numbered lines, not even a bare word of them
    expect(plain).not.toMatch(/line \d{4} lorem/);
    expect(plain).not.toContain('ipsum');
    expect(plain).not.toContain('consectetur');
    expect(plain).not.toMatch(/secret\?/);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
  });

  it('secret-looking paste → the gate row on Enter, Esc dismisses; Ctrl-C clears the draft to history with the hit span masked (§10.7)', async () => {
    const token = `ghp_${'Ab1'.repeat(12)}`; // 36 chars after the prefix: the github family
    const r = await drive({
      name: 'chat-secret-gate',
      args: ['chat', '--mock'],
      steps: [...CHAT_OPEN, `send \\x1b[200~use this token: ${token}\\nfor the deploy\\x1b[201~`, 'expect secret\\?', 'send \\r', 'expect Looks like this contains a secret \\(ghp_…\\)\\. Send anyway\\? y/N', 'send \\x1b', 'expect Tip: put it in \\.env', 'send \\x03', 'expect Describe the task', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).not.toContain(token);
    expect(plain).not.toMatch(/\[run\] start /);
    expect(r.runDirs()).toEqual([]);
    const history = join(r.home, 'history.jsonl');
    expect(existsSync(history)).toBe(true);
    const saved = readFileSync(history, 'utf8');
    expect(saved).toContain('[REDACTED:draft]');
    expect(saved).toContain('use this token: ');
    expect(saved).not.toContain(token);
    expect(saved).not.toContain('ghp_A');
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
  });

  it('NO_COLOR=1 → no SGR in any frame; the one SGR of the capture is the exit string’s attribute reset', async () => {
    const r = await drive({
      name: 'chat-no-color',
      args: ['chat', '--mock', '--mock-steps', '4'],
      env: { NO_COLOR: '1' },
      steps: [...CHAT_OPEN, ...submitTask('make the tests pass'), 'expect end complete', 'expect Follow-up or /command', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    expect(countSgr(r.text, { ignoreReset: true })).toBe(0);
    // §14.2: RESTORE ends in ESC[0m and is written once; nothing before its cursor-shape reset carries any SGR
    const restoreAt = r.text.indexOf(CURSOR_SHAPE_RESET);
    expect(restoreAt).toBeGreaterThan(0);
    expect(countSgr(r.text.slice(0, restoreAt))).toBe(0);
    expect(countSgr(r.text)).toBe(1);
    console.log(`NO_COLOR: ${countSgr(r.text)} SGR sequence in the capture (the exit string's attribute reset), 0 before the cursor-shape reset`);
  });

  for (const [rows, cols] of [
    [12, 60],
    [8, 40],
  ] as const) {
    it(`tiny terminal ${rows}x${cols}: the dynamic region never exceeds rows − 2 = ${rows - 2}, zero clears`, async () => {
      const r = await drive({
        name: `chat-tiny-${rows}x${cols}`,
        args: ['chat', '--mock', '--mock-steps', '6'],
        rows,
        cols,
        steps: [...CHAT_OPEN_NARROW, ...submitTask('fix it'), 'expect end complete', 'expect Follow-up or /command', ...EXIT_IDLE],
      });
      expect(r.timeouts).toBe(0);
      expect(r.code).toBe(0);
      const fs = frames(r.text);
      expect(fs.length).toBeGreaterThan(3);
      const byRule = Math.max(...fs.map((f) => f.rows ?? 0));
      // Ink's own accounting: the erase prefix of a unit removes the previous frame's rows + 1
      const byErase = Math.max(0, ...units(r.text).map((u) => u.erased - 1));
      expect(byRule).toBeLessThanOrEqual(rows - 2);
      expect(byErase).toBeLessThanOrEqual(rows - 2);
      expect(fs[0]!.lines.at(-1)).toMatch(/step 0\/–/);
      expect(countClears(afterFirstFrame(r.text))).toBe(0);
      console.log(`${rows}x${cols}: ${fs.length} frames, max dynamic rows ${byRule} (rule) / ${byErase} (erase count), budget ${rows - 2}`);
    });
  }

  // The rule row is the first dynamic row and is drawn dim at the terminal width (`ESC[2m ─×cols ESC[22m`), so a frame
  // laid out for a geometry is recognised by its rule width: expect consumes its buffer up to each match, so a settle
  // pattern can only match a frame rendered after the previous marker's echo — the geometry the previous segment ended
  // in never matches it. Ink's own `resized` pass re-renders the stale tree first (the old width's rule), which these
  // patterns skip; they match the App's re-render with the new columns.
  const RULE_60 = 'expect \\x1b\\[2m[^\\x1b]{60}\\x1b\\[22m\\r\\n';
  const RULE_100 = 'expect \\x1b\\[2m[^\\x1b]{100}\\x1b\\[22m\\r\\n';

  describe('resize storm idle (3-row frame, 40x100 ↔ 12x60): no crash, draft intact, clears per geometry segment', () => {
    // Segments are delimited by draft markers typed after each slow resize settles (never by clocks; the capture has no
    // timestamps, so the 2 ms storm itself is one segment). A 3-row idle frame fits both geometries, so no frame ever
    // overflows and Ink never reaches its clear-terminal fallback: the storm's bound is 0, not the ≤ 15 that "one per
    // shrink" would allow; the per-shrink design bound (≤ 1, research 20 §1) and the grow bound (0) are asserted on the
    // slow cycles, where each segment is one resize.
    const draft = 'a draft that survives a resize';
    const markers = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
    let r: Drive;
    let all: FrameUnit[] = [];
    let fs: FrameUnit[] = [];
    let segments: ReturnType<typeof segmentClears> = [];
    beforeAll(async () => {
      const cycles: string[] = [];
      let typed = `${draft}Z`;
      for (const [i, m] of markers.entries()) {
        typed += m;
        cycles.push(i % 2 === 0 ? 'resize 12 60' : 'resize 40 100', i % 2 === 0 ? RULE_60 : RULE_100, `send ${m}`, `expect > ${typed}`);
      }
      r = await drive({
        name: 'chat-resize-storm',
        args: ['chat', '--mock'],
        rows: 40,
        cols: 100,
        steps: [...CHAT_OPEN, `send ${draft}`, `expect > ${draft}`, 'mark storm-start', ...stormSteps(), 'mark storm-end', 'send Z', `expect > ${draft}Z`, ...cycles, 'send \\x03', 'expect Describe the task', ...EXIT_IDLE],
      });
      all = units(r.text);
      fs = frames(r.text);
      segments = segmentClears(all, markerNeedles(draft, markers));
      const start = markOf(r.timing, 'storm-start');
      const end = markOf(r.timing, 'storm-end');
      console.log(`idle resize storm: 30 resizes in ${(end?.t ?? 0) - (start?.t ?? 0)} ms, ${fs.length} frames, ${segments[0]?.clears ?? -1} ESC[2J in the storm; slow cycles shrink/grow clears ${segments.slice(1).map((s) => s.clears).join('/')}; widths seen ${[...new Set(fs.map((f) => f.ruleWidth))].join('/')}`);
    });

    it('no crash, draft intact, no forbidden sequences, one final layout at the last geometry', () => {
      expect(r.timeouts).toBe(0);
      expect(r.code).toBe(0);
      const plain = stripAnsi(r.text);
      expect(plain).not.toMatch(/stopped —|uncaught|Error:/);
      expect(plain).toContain(`> ${draft}Zabcdef`);
      expect(countForbidden(r.text)).toBe(0);
      expect(fs.at(-1)!.ruleWidth).toBe(100);
      for (const f of fs) {
        if (f.ruleWidth === 60) expect(f.rows).toBeLessThanOrEqual(10);
        if (f.ruleWidth === 100) expect(f.rows).toBeLessThanOrEqual(38);
      }
    });

    it('the 2 ms storm costs 0 clears (a 3-row frame never overflows either geometry)', () => {
      expect(segments[0]!.clears).toBe(0);
      expect(segments[0]!.unit).toBeDefined();
    });

    it('slow cycles: every shrink segment ≤ 1 clear, every grow segment 0, and each marker frame is laid out for its geometry', () => {
      expect(segments).toHaveLength(7);
      for (const [i, s] of segments.slice(1).entries()) {
        expect(s.unit).toBeDefined();
        expect(s.clears).toBeGreaterThanOrEqual(0);
        if (i % 2 === 0) {
          expect(s.clears).toBeLessThanOrEqual(1); // shrink 40x100 → 12x60
          expect(s.unit!.ruleWidth).toBe(60);
          expect(s.unit!.rows).toBeLessThanOrEqual(10);
        } else {
          expect(s.clears).toBe(0); // grow 12x60 → 40x100
          expect(s.unit!.ruleWidth).toBe(100);
          expect(s.unit!.rows).toBeLessThanOrEqual(38);
        }
      }
    });
  });

  describe('resize storm during a live run (pane open, 15-row frames at 40x100)', () => {
    // research 20 §1: only a frame taller than the new terminal makes Ink fall back to clearTerminal, so the storm has
    // to hit a tall live frame. Segments are delimited by draft markers typed after each settle, never by clocks; a
    // geometry counts as settled when the status line is laid out for it (60 columns drop the `sess` badge, so the row
    // ends right after the run meter; 100 columns carry `sess … ok`, the jev sparkline once it exists, then `? help`).
    // An `expect` drains the pty eagerly, which a driver `sleep` does not (25 ms ticks): under a 40x100 live frame the
    // child would block on its TTY writes. expect consumes its buffer up to each match, so a settle pattern can only
    // match a frame rendered after the previous marker's echo — the geometry the previous segment ended in never matches it.
    const draft = 'steer draft';
    const SETTLED_60 = `expect run \\$\\d+\\.\\d\\d/2\\.00 ok${SGR_GAP}\\r\\n`;
    const SETTLED_100 = `expect sess \\$\\d+\\.\\d\\d/10\\.00 ok[^\\r\\n]*\\? help${SGR_GAP}\\r\\n`;
    const markers = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
    let r: Drive;
    let fs: FrameUnit[] = [];
    let segments: ReturnType<typeof segmentClears> = [];
    /** clears of the three slow shrink segments (40x100 → 12x60) and the three slow grow segments */
    let shrinks: number[] = [];
    let grows: number[] = [];
    beforeAll(async () => {
      const cycles: string[] = [];
      let typed = `${draft}Z`;
      for (const [i, m] of markers.entries()) {
        typed += m;
        cycles.push(i % 2 === 0 ? 'resize 12 60' : 'resize 40 100', i % 2 === 0 ? SETTLED_60 : SETTLED_100, `send ${m}`, `expect > ${SGR_GAP}${typed}`);
      }
      r = await drive({
        name: 'chat-resize-storm-live',
        args: ['chat', '--mock', '--mock-steps', '400', '--max-steps', '400', '--max-replans', '100'],
        rows: 40,
        cols: 100,
        steps: [...CHAT_OPEN, ...submitTask('make the tests pass'), 'expect decisions s\\d+', `send ${draft}`, `expect > ${SGR_GAP}${draft}`, 'mark storm-start', ...stormSteps(), 'mark storm-end', 'send Z', `expect > ${SGR_GAP}${draft}Z`, SETTLED_100, ...cycles, 'send \\x03', 'expect Type to steer the next step', 'send \\x03', 'expect end human_abort', 'expect Follow-up or /command', ...EXIT_IDLE],
      });
      const all = units(r.text);
      fs = frames(r.text);
      segments = segmentClears(all, markerNeedles(draft, markers));
      shrinks = [segments[1]!.clears, segments[3]!.clears, segments[5]!.clears];
      grows = [segments[2]!.clears, segments[4]!.clears, segments[6]!.clears];
      const start = markOf(r.timing, 'storm-start');
      const end = markOf(r.timing, 'storm-end');
      const torn = fs.filter((f) => (f.ruleWidth === 60 && (f.rows ?? 0) > 10) || (f.ruleWidth === 100 && (f.rows ?? 0) > 38)).length;
      console.log(`live resize storm: 30 resizes in ${(end?.t ?? 0) - (start?.t ?? 0)} ms, ${fs.length} frames, ${segments[0]?.clears ?? -1} ESC[2J in the storm (15 shrinks); slow cycles shrink/grow clears ${segments.slice(1).map((s) => s.clears).join('/')}; settled frames at the markers: ${segments.slice(1).map((s) => `${s.unit?.ruleWidth}w×${s.unit?.rows}r`).join(' ')}; ${torn} transition frame(s) whose width and row count disagree (rows and columns update in separate renders)`);
    });

    it('no crash, draft intact, grows cost 0 clears, settled frames fit their budget, one final layout at 100', () => {
      expect(r.timeouts).toBe(0);
      expect(r.code).toBe(0);
      const plain = stripAnsi(r.text);
      expect(plain).not.toMatch(/jevcode: stopped|uncaught|Error:/);
      expect(plain).toContain(`> ${draft}Zabcdef`);
      expect(countForbidden(r.text)).toBe(0);
      expect(segments).toHaveLength(7);
      expect(segments[0]!.unit).toBeDefined();
      for (const s of segments) expect(s.clears).toBeGreaterThanOrEqual(0);
      expect(grows).toEqual([0, 0, 0]);
      // the frame that echoes each marker was drawn after the status line settled: 12x60 → ≤ 10 rows at 60 wide; 40x100 → ≤ 38 at 100
      for (const [i, s] of segments.slice(1).entries()) {
        expect(s.unit!.ruleWidth).toBe(i % 2 === 0 ? 60 : 100);
        expect(s.unit!.rows).toBeLessThanOrEqual(i % 2 === 0 ? 10 : 38);
      }
      expect(fs.at(-1)!.ruleWidth).toBe(100);
    });

    it('design bound (§19.5 storm row, research 20 §1): every slow shrink costs ≤ 1 clear, the 15-shrink storm ≤ 15', () => {
      // The frame drawn for 40x100 (15 rows) is taller than the 12-row terminal, so Ink's first render after a shrink
      // takes its clear-terminal fallback once (`wasOverflowing`: previousOutputHeight 15 > viewportRows 12). The App's
      // early `resize` listener (App.tsx `onEarlyResize`: the new geometry is stored on the bridge and a shrink is
      // re-rendered synchronously, before Ink's own `resized` pass) means that pass already sees the shrunken tree, so
      // the second clear an earlier bundle paid (`isOverflowing && hadPreviousFrame` on the stale tree, then
      // `wasOverflowing` again on the App's re-render — measured 2 per shrink on 2026-09-21 before the fix) no longer
      // happens: measured 1/0/1/0/1/0 after it. The 2 ms storm cannot be segmented (the capture has no timestamps), so
      // its bound is 15 shrinks × 1; the throttle merges most of them (5 measured).
      expect(shrinks).toHaveLength(3);
      for (const n of shrinks) expect(n).toBeLessThanOrEqual(1);
      expect(segments[0]!.clears).toBeLessThanOrEqual(15);
    });
  });

  it('Ctrl-Z stops the process (ps state T, tty cooked: icanon echo); SIGCONT resumes: raw again (-icanon -echo), repaint, keys work, no run dir', async () => {
    const r = await drive({
      name: 'chat-ctrl-z',
      args: ['chat', '--mock'],
      // `sleep 0.4` after the resumed echo: the external `stty -a` sampler (below) needs the process alive in raw mode
      // for a moment; the driver's remaining steps would otherwise end the process within its 25 ms poll
      steps: [...CHAT_OPEN, 'send \\x1a', 'sleep 1.2', 'signal CONT', RAW_MODE_STEP, 'send Q', 'expect > Q', 'sleep 0.4', 'send \\x03', 'expect Describe the task', ...EXIT_IDLE],
      during: async ({ workspace }) => {
        const stopped = await waitForProcessState(workspace, 'T', 8000);
        const pid = jevcodeProcesses(workspace)[0]?.pid ?? null;
        const tty = pid === null ? null : ttyOf(pid);
        const whileStopped = tty === null ? null : sttyAll(tty);
        const resumed = await waitForProcessState(workspace, (stat) => !stat.startsWith('T'), 8000);
        const afterResume = tty === null ? { ok: false, dump: null } : await waitForStty(tty, (dump) => sttyFlag(dump, 'icanon') === false, 5000);
        return { stopped, pid, tty, whileStopped, resumed, afterResume };
      },
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const d = r.during as { stopped: { seen: boolean; states: string[] }; pid: number | null; tty: string | null; whileStopped: string | null; resumed: { seen: boolean; states: string[] }; afterResume: { ok: boolean; dump: string | null } };
    expect(d.stopped.seen).toBe(true);
    expect(d.pid).not.toBeNull();
    expect(d.tty).toMatch(/^\/dev\/ttys\d+$/);
    // §19.5 Ctrl-Z row: `stty -a` cooked while stopped (the SIGTSTP path restored the terminal before the SIGSTOP)
    expect(d.whileStopped).not.toBeNull();
    expect(sttyFlag(d.whileStopped!, 'icanon')).toBe(true);
    expect(sttyFlag(d.whileStopped!, 'echo')).toBe(true);
    // raw again after the resume
    expect(d.resumed.seen).toBe(true);
    expect(d.afterResume.ok).toBe(true);
    expect(sttyFlag(d.afterResume.dump!, 'icanon')).toBe(false);
    expect(sttyFlag(d.afterResume.dump!, 'echo')).toBe(false);
    // the exit string ran for the stop and again at exit; a frame was drawn after the resume
    const firstRestore = r.text.indexOf(CURSOR_SHAPE_RESET);
    expect(firstRestore).toBeGreaterThan(0);
    expect(r.text.indexOf(CURSOR_SHAPE_RESET, firstRestore + 1)).toBeGreaterThan(firstRestore);
    expect(r.text.indexOf(CURSOR_HIDE, firstRestore)).toBeGreaterThan(firstRestore);
    expect(stripAnsi(r.text)).toContain('> Q');
    // no checkpoint is written by a suspend: an idle session still has no run dir after the stop/resume
    expect(r.runDirs()).toEqual([]);
    const lflags = (dump: string): string => dump.split('\n').find((l) => l.startsWith('lflags:')) ?? dump.trim().split('\n')[0] ?? '';
    console.log(`Ctrl-Z: ps states ${d.stopped.states.join(' → ')} → ${d.resumed.states.join(' → ')}; ${d.tty} while stopped: ${lflags(d.whileStopped!)}; after resume: ${lflags(d.afterResume.dump!)}`);
  });
});
