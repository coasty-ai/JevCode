/**
 * TUI-DESIGN §6 pty scenarios of the review prompt, driven by `JEVCODE_MOCK_REVIEW_AT=2` (the mock decider puts step 2
 * in the review band, cli/session.ts). The box is deferred to ~1 s after the last keystroke with the input drained
 * (§6.3), a typed-ahead `y` is composer text and never an approval, `y` approves once the box is armed, `n` declines,
 * `d <note>` declines with the note in transcript.log (§6.4). Timing comes from the driver's JSONL: a `send` records
 * its completion, an `expect` its match — including the `review pending` status text, which times the request's
 * arrival so the deferral is measured from the request, not from the key.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_OPEN, EXIT_IDLE, SGR_GAP, afterFirstFrame, cleanupScratch, countClears, drive, hasExpect, lastTimingOf, stripAnsi, submitTask, timingOf } from './helpers.js';

afterEach(cleanupScratch);

const REVIEW = { args: ['chat', '--mock', '--mock-steps', '5'] as const, env: { JEVCODE_MOCK_REVIEW_AT: '2' } };
const BOX = 'expect \\[y\\] approve \\[n\\] decline \\[d\\] decline\\+note';
/** the status left zone / toast while the request waits for the idle second (§6.3) */
const PENDING = 'expect review pending';

describe.skipIf(!hasExpect)('pty: review prompt (§6)', () => {
  it('a typed-ahead `y` is composer text; the request is pending for most of the idle second before the box; then `y` approves once', async () => {
    const r = await drive({
      name: 'review-deferral-typeahead',
      ...REVIEW,
      steps: [...CHAT_OPEN, ...submitTask('make the tests pass'), 'send y', `expect > ${SGR_GAP}y`, PENDING, BOX, 'sleep 0.25', 'send y', 'expect confirm \\S+ approved', 'expect end complete', `expect > ${SGR_GAP}y`, 'send \\x03', 'expect Follow-up or /command', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const typed = lastTimingOf(r.timing, 'send', 'y');
    const pending = timingOf(r.timing, 'expect', 'review pending');
    const box = timingOf(r.timing, 'expect', 'approve');
    expect(typed).toBeDefined();
    expect(pending).toBeDefined();
    expect(box).toBeDefined();
    const typedY = r.timing.filter((t) => t.op === 'send' && t.arg === 'y');
    expect(typedY).toHaveLength(2);
    // the request arrived shortly after the typed-ahead key (step 2 of a ~20 ms/step mock) and was then held pending
    // for most of the second: the box is deferred by the idle rule, not merely late
    const requestLag = pending!.t - typedY[0]!.t;
    const held = box!.t - pending!.t;
    const deferral = box!.t - typedY[0]!.t;
    expect(requestLag).toBeGreaterThanOrEqual(0);
    expect(requestLag).toBeLessThan(500);
    expect(held).toBeGreaterThanOrEqual(800);
    expect(deferral).toBeGreaterThanOrEqual(900);
    expect(deferral).toBeLessThan(3000);
    const plain = stripAnsi(r.text);
    const boxAt = plain.indexOf('[y] approve');
    expect(boxAt).toBeGreaterThan(0);
    expect(plain.slice(0, boxAt)).not.toMatch(/confirm \S+ approved/);
    expect(plain.slice(0, boxAt)).toContain('review pending');
    const transcript = r.transcript();
    expect(transcript!.filter((l) => /confirm \S+ approved/.test(l))).toHaveLength(1);
    expect(transcript!.some((l) => /confirm \S+ declined/.test(l))).toBe(false);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
    console.log(`review deferral: request pending ${requestLag} ms after the typed-ahead key, box ${held} ms after the request (${deferral} ms after the key)`);
  });

  it('`n` declines: `confirm <id> declined` and the run continues to complete', async () => {
    const r = await drive({
      name: 'review-n',
      ...REVIEW,
      steps: [...CHAT_OPEN, ...submitTask('make the tests pass'), BOX, 'sleep 0.25', 'send n', 'expect confirm \\S+ declined', 'expect end complete', 'expect Follow-up or /command', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const transcript = r.transcript();
    expect(transcript!.some((l) => /^\[step 2\] confirm \S+ declined/.test(l))).toBe(true);
    expect(transcript!.some((l) => /confirm \S+ approved/.test(l))).toBe(false);
    expect(transcript!.at(-1)).toMatch(/^\[run\] end complete /);
  });

  it('`d <note>` declines with the note; the note reaches transcript.log verbatim', async () => {
    const r = await drive({
      name: 'review-d-note',
      ...REVIEW,
      steps: [...CHAT_OPEN, ...submitTask('make the tests pass'), BOX, 'sleep 0.25', 'send d', 'expect note \\(', 'send skip the tests', 'expect skip the tests', 'send \\r', 'expect declined \\(note: skip the tests\\)', 'expect end complete', 'expect Follow-up or /command', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const transcript = r.transcript();
    expect(transcript!.some((l) => /^\[step 2\] confirm \S+ declined \(note: skip the tests\)$/.test(l))).toBe(true);
    // the box's keys line and the composer's collapsed row were drawn while the review was pending
    const plain = stripAnsi(r.text);
    expect(plain).toContain('review pending');
    expect(plain).toMatch(/note \(≤ 600, Enter sends, Esc cancels\): /);
  });
});
