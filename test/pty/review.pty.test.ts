/**
 * TUI-DESIGN §6 pty scenarios of the review prompt, driven by `JEVCODE_MOCK_REVIEW_AT=2` (the mock decider puts step 2
 * in the review band, cli/session.ts). The box is deferred to ~1 s after the last keystroke with the input drained
 * (§6.3), a typed-ahead `y` is composer text and never an approval, `y` approves once the box is armed, `n` declines,
 * `d <note>` declines with the note in transcript.log (§6.4); Enter on the armed card is inert (TUI-DESIGN-2 §9 "review
 * invariants": only `y` approves, no default). Timing comes from the driver's JSONL: a `send` records
 * its completion, an `expect` its match — including the `review pending` status text, which times the request's
 * arrival so the deferral is measured from the request, not from the key.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_OPEN, EXIT_IDLE, MOCK_RUN_MODE, PLACEHOLDER_FOLLOWUP, PROMPT, SGR_GAP, afterFirstFrame, cleanupScratch, contiguous, countClears, drive, hasExpect, lastTimingOf, markOf, stripAnsi, submitTask, syncFrames, syncFramesWith, timingOf } from './helpers.js';

afterEach(cleanupScratch);

const REVIEW = { args: ['chat', ...MOCK_RUN_MODE, '--mock', '--mock-steps', '5'] as const, env: { JEVCODE_MOCK_REVIEW_AT: '2', JEVCODE_AUTONOMY: 'review' } };
/** the keys row of the review card (TUI-DESIGN-2 §4.7: inside `╭─ review · step N …╮` in the boxed tier; the same row flat) */
const BOX = 'expect \\[y\\] approve \\[n\\] decline \\[d\\] decline\\+note';
/** the boxed review card's title edge (TUI-DESIGN-2 §8.2 `review-y.steps` (ext.): `expect ╭─ review` at 24×80) */
const CARD = 'expect ╭─ review · step 2 · risk';
/** the status left zone / toast while the request waits for the idle second (§6.3) */
const PENDING = 'expect review pending';

describe.skipIf(!hasExpect)('pty: review prompt (§6)', () => {
  it('a typed-ahead `y` is composer text; the request is pending for most of the idle second before the box; then `y` approves once', async () => {
    const r = await drive({
      name: 'review-deferral-typeahead',
      ...REVIEW,
      steps: [...CHAT_OPEN, ...submitTask('make the tests pass'), 'send y', `expect ${PROMPT} ${SGR_GAP}y`, PENDING, CARD, BOX, 'sleep 0.25', 'send y', 'expect review approved', 'expect finished [·-] complete', `expect ${PROMPT} ${SGR_GAP}y`, 'send \\x03', `expect ${PLACEHOLDER_FOLLOWUP}`, ...EXIT_IDLE],
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
    expect(plain.slice(0, boxAt)).not.toMatch(/review approved/);
    expect(plain.slice(0, boxAt)).toContain('review pending');
    const transcript = r.transcript();
    expect(transcript!.filter((l) => /review approved/.test(l))).toHaveLength(1);
    expect(transcript!.some((l) => /review declined/.test(l))).toBe(false);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
    console.log(`review deferral: request pending ${requestLag} ms after the typed-ahead key, box ${held} ms after the request (${deferral} ms after the key)`);
  });

  it('Enter on the armed review card is inert (TUI-DESIGN-2 §9 "review invariants": only `y` approves, no default): the card stays up, then `y` approves exactly once', async () => {
    const r = await drive({
      name: 'review-enter-inert',
      ...REVIEW,
      // the card is armed 150 ms after its committed frame (§6.3): Enter lands on the armed card, `y` a quarter second later
      steps: [...CHAT_OPEN, ...submitTask('make the tests pass'), CARD, BOX, 'sleep 0.3', 'send \\r', 'sleep 0.3', 'mark enter-sent', 'send y', 'expect review approved', 'expect finished [·-] complete', `expect ${PLACEHOLDER_FOLLOWUP}`, ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    // one approval, by `y`: had Enter approved, the run would have gone on and the later `y` would sit in the composer as text
    const transcript = r.transcript()!;
    expect(transcript.filter((l) => /review approved/.test(l))).toHaveLength(1);
    expect(transcript.some((l) => /review declined/.test(l))).toBe(false);
    expect(plain).not.toMatch(/[›>] y\b/);
    // the card frames form one contiguous run from the first card frame to the approval: Enter neither answered nor closed it
    const all = syncFrames(r.text);
    const card = syncFramesWith(all, /^╭─ review · step 2/);
    expect(card.length).toBeGreaterThan(0);
    expect(contiguous(card)).toBe(true);
    const approved = syncFramesWith(all, /review approved/);
    expect(approved.length).toBeGreaterThan(0);
    expect(approved[0]!).toBeGreaterThanOrEqual(card.at(-1)!);
    // the Enter itself: the approval frame arrived after `y` was sent, not after the Enter
    const enter = markOf(r.timing, 'enter-sent')!;
    const ok = timingOf(r.timing, 'expect', 'approved')!;
    const ySent = lastTimingOf(r.timing, 'send', 'y')!;
    expect(ySent.t).toBeGreaterThanOrEqual(enter.t);
    expect(ok.t).toBeGreaterThanOrEqual(ySent.t);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
    console.log(`review Enter inert: card up for frames ${card[0]}–${card.at(-1)}, approval frame ${approved[0]} ${ok.t - ySent.t} ms after y`);
  });

  it('`n` declines: `review declined` and the run continues to complete', async () => {
    const r = await drive({
      name: 'review-n',
      ...REVIEW,
      steps: [...CHAT_OPEN, ...submitTask('make the tests pass'), CARD, BOX, 'sleep 0.25', 'send n', 'expect review declined', 'expect finished [·-] complete', `expect ${PLACEHOLDER_FOLLOWUP}`, ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const transcript = r.transcript();
    expect(transcript!.some((l) => /^\[step 2\] review declined/.test(l))).toBe(true);
    expect(transcript!.some((l) => /review approved/.test(l))).toBe(false);
    expect(transcript!.at(-1)).toMatch(/^\[run\] finished [·-] complete /);
  });

  it('`d <note>` declines with the note; the note reaches transcript.log verbatim', async () => {
    const r = await drive({
      name: 'review-d-note',
      ...REVIEW,
      steps: [...CHAT_OPEN, ...submitTask('make the tests pass'), CARD, BOX, 'sleep 0.25', 'send d', 'expect note \\(', 'send skip the tests', 'expect skip the tests', 'send \\r', 'expect review declined (?:\\x1b\\[[0-9;]*m)*[·-] "skip the tests"', 'expect finished [·-] complete', `expect ${PLACEHOLDER_FOLLOWUP}`, ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const transcript = r.transcript();
    expect(transcript!.some((l) => /^\[step 2\] review declined [·-] "skip the tests"$/.test(l))).toBe(true);
    // the box's keys line and the composer's collapsed row were drawn while the review was pending
    const plain = stripAnsi(r.text);
    expect(plain).toContain('review pending');
    expect(plain).toMatch(/note \(≤ 600, Enter sends, Esc cancels\): /);
    // TUI-DESIGN-2 §4.7 / §9 "review invariants": the card changes drawing only — its edges are the round glyph set and exactly 80 cells wide
    const edges = plain.split(/\r?\n/).filter((l) => /^╭─ review · step 2/.test(l));
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) expect([...e].length).toBe(80);
  });
});
