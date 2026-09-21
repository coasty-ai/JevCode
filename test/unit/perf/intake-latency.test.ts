/**
 * `src/perf/intake-latency.ts` pure parts (TUI-DESIGN-2 §3.12): the message plan cycles greetings and tool questions the
 * mock decider (§3.13) never reads as a task; `pairIntake` pairs every measured Enter with the first later frame carrying
 * its `[you]` bubble and the first later frame carrying a `[jevcode]` item, counting `thinking` frames in between and
 * never letting a frame answer two messages; `judgeIntake` gates the bubble p95 (< 16 ms), the reply p95 net of the
 * mock's delay (≤ 40 ms), the hygiene (no run, no clear, region in budget, exit 0) and completeness: every typed message
 * must have been located (a dropped `send` record is `dropped > 0`, never a shorter passing series).
 */
import { describe, expect, it } from 'vitest';
import { BSU, ESU, splitFrames, type Chunk, type TimingStep } from '../../../src/perf/pty.js';
import { INTAKE_BUBBLE_GATE_MS, INTAKE_MESSAGES, INTAKE_REPLY_GATE_MS, judgeIntake, messagePlan, pairIntake } from '../../../src/perf/intake-latency.js';

const RULE = '─'.repeat(20);
/** an Ink frame: optional new Static rows above the rule, then the console rows */
function frame(staticRows: readonly string[], statusWord: string): string {
  const dyn = [RULE, '╭─ jev-only ──── ws ─╮', '│ › Say hi          │', '├────────────────────┤', `│ ${statusWord.padEnd(17)} │`, '╰────────────────────╯'];
  return `${BSU}\x1b[?25l${[...staticRows, ...dyn].join('\r\n')}\r\n\x1b[4A\x1b[5G\x1b[?25h${ESU}`;
}

describe('messagePlan', () => {
  it('cycles the eight greetings and tool questions; none is a ≥ 3-word imperative without `?` (the mock reads those as coding_task)', () => {
    expect(INTAKE_MESSAGES).toHaveLength(8);
    expect(messagePlan(20)).toHaveLength(20);
    expect(messagePlan(20).slice(0, 8)).toEqual([...INTAKE_MESSAGES]);
    expect(messagePlan(20)[8]).toBe(INTAKE_MESSAGES[0]);
    const greeting = /^\s*(hi|hello|hey|yo|thanks?|thank you|bye|ok(ay)?|good (morning|evening|afternoon))\b[!. ]*$/i;
    for (const m of INTAKE_MESSAGES) expect(greeting.test(m) || (m.includes('?') && /\b(you|jevcode|jev|mode|cost|key|command|run)\b/i.test(m))).toBe(true);
  });
});

describe('pairIntake', () => {
  it('pairs each Enter with the bubble frame and the first reply frame after it, counts thinking frames, consumes frames in order', () => {
    const idle = frame([], 'idle');
    const bubble1 = frame(['', '[you] hi'], '⠹ thinking');
    const think = frame([], '⠹ thinking');
    const reply1 = frame(['', '[jevcode] Hi. I\'m ready when you are'], 'idle');
    const both2 = frame(['', '[you] thanks', '', '[jevcode] You\'re welcome. Anything else on ws?'], 'idle');
    const cap = idle + bubble1 + think + reply1 + both2;
    const { frames } = splitFrames(cap);
    expect(frames).toHaveLength(5);
    const off1 = idle.length; // Enter #1 written after the idle frame
    const off2 = idle.length + bubble1.length + think.length + reply1.length; // Enter #2 after reply 1
    const chunks: Chunk[] = frames.map((f, i) => ({ t: 1000 + i * 40, off: f.start, n: f.end - f.start }));
    const timing: TimingStep[] = [
      { t: 900, step: 1, op: 'send', arg: 'hi' },
      { t: 1010, step: 2, op: 'send', arg: '\r', off: off1 },
      { t: 1100, step: 3, op: 'send', arg: 'thanks' },
      { t: 1130, step: 4, op: 'send', arg: '\r', off: off2 },
    ];
    const pairs = pairIntake(timing, frames, chunks, [2, 4], ['hi', 'thanks']);
    expect(pairs).toHaveLength(2);
    // the bubble frame shows `⠹ thinking` too (§3.1 row 1), so two thinking frames precede the reply
    expect(pairs[0]).toMatchObject({ step: 2, text: 'hi', sentAt: 1010, bubbleAt: 1040, replyAt: 1120, bubbleMs: 30, replyMs: 110, thinkingFrames: 2 });
    // the second Enter's bubble and reply landed in one immediate Static render (the 0 ms mock): both figures coincide
    expect(pairs[1]).toMatchObject({ step: 4, text: 'thanks', bubbleAt: 1160, replyAt: 1160, bubbleMs: 30, replyMs: 30, thinkingFrames: 0 });
  });
  it('leaves null figures when a frame never arrives and skips a measured step without an offset (judgeIntake then reports the drop)', () => {
    const idle = frame([], 'idle');
    const { frames } = splitFrames(idle + frame(['', '[you] hi'], '⠹ thinking'));
    const chunks: Chunk[] = frames.map((f, i) => ({ t: 1000 + i * 40, off: f.start, n: f.end - f.start }));
    const timing: TimingStep[] = [
      { t: 1010, step: 2, op: 'send', arg: '\r', off: idle.length },
      { t: 2000, step: 4, op: 'send', arg: '\r' },
    ];
    const pairs = pairIntake(timing, frames, chunks, [2, 4], ['hi', 'ok']);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ bubbleMs: 30, replyAt: null, replyMs: null });
    const judged = judgeIntake('mock0', 0, pairs, { runsStarted: 0, clears: 0, regionMax: 6, rows: 24, exitCode: 0, timedOut: false }, 2);
    expect(judged).toMatchObject({ messages: 2, dropped: 1, bubbleOk: false, replyOk: false, pass: false });
  });
});

describe('judgeIntake', () => {
  const pair = (bubbleMs: number, replyMs: number, thinking = 0): ReturnType<typeof pairIntake>[number] => ({ step: 1, text: 'hi', sentAt: 0, bubbleAt: bubbleMs, replyAt: replyMs, bubbleMs, replyMs, thinkingFrames: thinking });
  const clean = { runsStarted: 0, clears: 0, regionMax: 6, rows: 24, exitCode: 0, timedOut: false };
  it('passes a complete series inside both gates; gates the reply net of the mock delay; counts thinking messages', () => {
    const s = judgeIntake('mock150', 150, [pair(4, 158, 2), pair(6, 161, 1), pair(5, 160, 1)], clean);
    expect(s).toMatchObject({ messages: 3, thinkingSeen: 3, bubbleOk: true, replyOk: true, hygieneOk: true, pass: true });
    expect(s.reply.p95).toBe(161);
    expect(s.replyNet.p95).toBe(11);
    expect(INTAKE_BUBBLE_GATE_MS).toBe(16);
    expect(INTAKE_REPLY_GATE_MS).toBe(40);
  });
  it('fails on a slow bubble, a slow reply, a missing frame, a started run or a clear', () => {
    expect(judgeIntake('mock0', 0, [pair(4, 8), pair(17, 20)], clean)).toMatchObject({ bubbleOk: false, replyOk: true, pass: false });
    expect(judgeIntake('mock0', 0, [pair(4, 45)], clean)).toMatchObject({ bubbleOk: true, replyOk: false, pass: false });
    expect(judgeIntake('mock0', 0, [{ ...pair(4, 8), replyAt: null, replyMs: null }], clean)).toMatchObject({ replyOk: false, pass: false });
    expect(judgeIntake('mock0', 0, [pair(4, 8)], { ...clean, runsStarted: 1 })).toMatchObject({ hygieneOk: false, pass: false });
    expect(judgeIntake('mock0', 0, [pair(4, 8)], { ...clean, clears: 1 })).toMatchObject({ hygieneOk: false, pass: false });
    expect(judgeIntake('mock0', 0, [], clean)).toMatchObject({ bubbleOk: false, replyOk: false, pass: false });
  });
  it('fails when fewer pairs than messages were located: a dropped Enter never yields a complete (passing) series, and `messages` reports the plan, not the pairs', () => {
    const three = [pair(4, 8), pair(5, 9), pair(6, 10)];
    expect(judgeIntake('mock0', 0, three, clean, 3)).toMatchObject({ messages: 3, dropped: 0, pass: true });
    const short = judgeIntake('mock0', 0, three, clean, 20);
    expect(short).toMatchObject({ messages: 20, dropped: 17, bubbleOk: false, replyOk: false, hygieneOk: true, pass: false });
    expect(short.bubble.samples).toBe(3);
    // the default expectation is the pair count (the pure callers of the tests above)
    expect(judgeIntake('mock0', 0, three, clean).dropped).toBe(0);
  });
});
