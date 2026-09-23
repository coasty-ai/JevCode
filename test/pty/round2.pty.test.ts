/**
 * TUI-DESIGN-2 §8.2 pty scenarios of round 2, every run `--mock` (no network) inside a real pty driven by
 * scripts/pty/drive.exp: a greeting → a `[jevcode]` reply and no run, with the Enter → reply wall time recorded (§3.1
 * row 6, §3.12); a question about the tool → facts (§3.5); a task → a run whose transcript is the compact subsequence
 * (§4.5); the ambiguity card (§3.7: Enter inert — the card stays open until `n`, which replies; `y` runs; the flat-tier
 * row at 12×60); `/mode jev-on` without and with a generator key, `/llm on` and the no-argument `/mode` item, the badge
 * promotion at `run:start` (§1.3, §1.5, H-G1); the splash at 24×80 and 40×120, under reduced motion, settling by itself
 * and cancelled by `run:start` (§5); the Jev panel strip / open / full through `/panel` and the Alt keys (§4.6), its
 * `s0` intake rows (§3.11); the chrome tiers across a shrink and a grow (§4.1); the two zero-argument starts and the
 * keyless wizard (§1.1, §1.4); keys never in logs (§9: the masked fields of both wizard paths); `[you]` redaction at
 * emission (§3.10) in the TUI and `--plain`; `--ascii` twins (TD §14.1); `--plain`'s intake readline (§3.7); `/jev` and
 * `/cost` after a greeting (§2.6, §3.9); `/transcript full` and identity predicate (a) (§4.5, §9). Mocked runs say
 * `--mode jev-on` (`MOCK_RUN_MODE`); the conversational scenarios run under the default mode (`BADGE_DEFAULT`, `jev+llm` since
 * TUI-DESIGN-3 §1.10 — every default pin below reads it from the table). Round 3 (TUI-DESIGN-3): the splash scenarios pin the
 * persistent mark (a key completes the reveal, the caption `◆ <version>` is the settle sentinel, F-W1), the wizard scenarios the
 * one-key field (§1.4), the `/mode` scenarios start in `jev-only` explicitly; the round-3 scenarios proper are `round3.pty.test.ts`.
 *
 * Tests marked `it.fails` record defects of the tree against the design (docs/STATUS.md "Round 2", requests to S2 / S3
 * / S4): they pass while the defect stands and start failing the moment the owning slot lands the fix, which is the
 * signal to turn them into plain `it`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MODE_SET_ITEM } from '../../src/cli/session.js';
import {
  BADGE_DEFAULT,
  BADGE_DEFAULT_TEXT,
  BADGE_JEV_LLM,
  BADGE_JEV_ONLY,
  CHAT_OPEN,
  CHAT_OPEN_NARROW,
  EXIT_IDLE,
  FIRST_FRAME_STEP,
  HIDDEN_STAGE_RE,
  IDLE_STEP,
  MOCK_RUN_MODE,
  PLACEHOLDER_FOLLOWUP,
  PLACEHOLDER_TASK,
  RAW_MODE_STEP,
  RUN_OPEN,
  RUN_STARTED_STEP,
  SGR_GAP,
  afterFirstFrame,
  cleanupScratch,
  countClears,
  drive,
  echoStep,
  frameTier,
  frames,
  hasExpect,
  isBoxEdge,
  isItemRow,
  isLocalItem,
  labelStep,
  reflowAgainst,
  segmentClears,
  staticRows,
  stripAnsi,
  syncFrames,
  syncFramesWith,
  timingOf,
  topEdgeStep,
  units,
  wallBetween,
  type Drive,
} from './helpers.js';

afterEach(cleanupScratch);

/** a fake key never leaves the machine: `JEVCODE_ASSERT_NO_NETWORK=1` makes any http(s) fetch throw (bin/jevcode.js) */
const FAKE_KEY = `sk-fake-${'x'.repeat(40)}`;
/** a second fake key, typed into the wizard's masked field (never saved: Ctrl-C leaves the wizard) */
const TYPED_KEY = `sk-fake-${'z'.repeat(40)}`;
/** an Anthropic-shaped canary for the secret gate (`detectSecrets`: `sk-ant-api03-` + 95 chars) */
const CANARY = `sk-ant-api03-${'A'.repeat(95)}`;
const NO_NETWORK = { JEVCODE_ASSERT_NO_NETWORK: '1' } as const;
/** the round-2 gate on the intake wall time (TUI-DESIGN-2 §9: p95 < 1.5 s live; the mock answers at once) */
const INTAKE_WALL_MS = 1500;
/** an SGR gap inside a coloured badge (` · next run` may be its own span) */
const PROMPT_GAP = SGR_GAP;
/** TUI-DESIGN-3 §5.3 normaliser: a stripped capture with every run of whitespace collapsed, so an item that soft-wrapped over the 10-cell gutter compares with its one-line source text */
const flatten = (text: string): string => text.replace(/\s+/g, ' ');
/** TUI-DESIGN-2 §5.2: the splash ticks through Ink's `useAnimation` at 50 ms — ≤ 15 frames in its 700 ms */
const SPLASH_MAX_FRAMES = 15;
/** TUI-DESIGN-3 §3.5: the caption `◆ <version>` on the mark's last row is the settle sentinel (the brand row is the < 21-row / < 64-column twin) */
const CAPTION_STEP = 'expect ◆(?:\\x1b\\[[0-9;]*m)* (?:\\x1b\\[[0-9;]*m)*\\d+\\.\\d+\\.\\d+'; // SGRs sit between the diamond and the version
/** the frames of the dynamic region that carry the complete resting mark (5 `██` rows, TUI-DESIGN-3 F-W1) */
const hasMark = (dyn: readonly string[]): boolean => dyn.filter((l) => WORDMARK_RE.test(l)).length >= 5;
/** Alt chords as the pty bytes: ESC + letter (`keys/bindings.ts` `meta+j` …; the App re-buffers a bare ESC for 30 ms) */
// Tcl 8.5's `\xhh` (macOS expect) swallows every following hex digit and keeps the last two, so `\x1bd` is `\xbd` = `½`, not ESC+d;
// the octal form is exactly three digits (research 20 driver notes)
const ALT = (letter: string): string => `send \\033${letter}`;
const WORDMARK_RE = /██/;

/** every regular file under `dir`, recursively (the scenario's JEVCODE_HOME holds history.jsonl, sessions/, logs/, xdg/) */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (statSync(p).isFile()) out.push(p);
  }
  return out;
}

/** the files under the scenario's home (and workspace) whose bytes contain `needle` — the "keys never in logs" gate of §9 */
function filesContaining(r: Drive, needle: string): string[] {
  return [...filesUnder(r.home), ...filesUnder(r.workspace)].filter((p) => readFileSync(p, 'latin1').includes(needle));
}

describe.skipIf(!hasExpect)('pty round 2: conversation (§3)', () => {
  it('chat-hi: `hi` → [you] bubble, the code model\'s reply, no card, no run, the default badge; Enter → reply wall time recorded', async () => {
    const r = await drive({
      name: 'r2-chat-hi',
      args: ['chat', '--mock'],
      steps: [...CHAT_OPEN, 'send hi', echoStep('hi'), 'send \\r', 'mark hi-sent', labelStep('you', 'hi'), labelStep('jevcode', 'Hi'), 'mark hi-reply', topEdgeStep(BADGE_DEFAULT), `expect ${PLACEHOLDER_FOLLOWUP}`, ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    // §3.10: one item per line, the bubble labels verbatim; the `--mock` generator answers a chat request with one deterministic line
    expect(plain).toContain('[you] hi');
    expect(plain).toMatch(/\[jevcode\] Hi\. I'm JevCode \(mock reply\)\./);
    // never a card and never a blocked composer
    expect(plain).not.toContain('run this as a task?');
    expect(plain).not.toContain('(waiting for y/n)');
    // §3.1 row 6: no run — no `[run] start`, no run directory
    expect(plain).not.toMatch(/\[run\] started [·-] /);
    expect(r.runDirs()).toEqual([]);
    // §4.4: a chat reply is a turn, so the placeholder flips to `followup`
    expect(plain).toContain('Follow-up, question, or /command…');
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
    // §3.12 / §9: Enter → the reply frame, from the driver's clock (`send \r` completion → `expect [jevcode]` match)
    const wall = wallBetween(r.timing, '\\r', 'jevcode');
    expect(wall).not.toBeNull();
    expect(wall!).toBeLessThan(INTAKE_WALL_MS);
    // the status word between Enter and the reply is reported (design §3.1 row 1 `⠹ thinking`; docs/STATUS.md "Round 2" deviation 4)
    const between = syncFrames(r.text).filter((f) => f.lines.some((l) => l.includes('[you] hi')) || f.dynamic.some((l) => /^│ (?:starting|⠹ thinking|• thinking)/.test(l)));
    console.log(`chat-hi: Enter → [jevcode] reply ${wall} ms (mock decider; gate ${INTAKE_WALL_MS} ms); status words seen between Enter and the reply: ${[...new Set(between.flatMap((f) => f.dynamic.filter((l) => /^│ (?:starting|⠹ thinking|• thinking)/.test(l)).map((l) => l.slice(2, 14).trim())))].join(', ') || 'none'}`);
  });

  it('chat-facts (jev-only, where Jev answers alone): `what can you do?` → the what_it_is fact; `which mode is this?` → `Mode: jev-only`; no run', async () => {
    const r = await drive({
      name: 'r2-chat-facts',
      args: ['chat', '--mock', '--mode', 'jev-only'],
      steps: [...CHAT_OPEN, 'send what can you do?', echoStep('what can you do?'), 'send \\r', labelStep('jevcode', 'JevCode is a coding agent'), 'send which mode is this?', echoStep('which mode is this?'), 'send \\r', labelStep('jevcode', 'Mode: jev-only'), ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).toContain('[jevcode] JevCode is a coding agent where Jev, a decision model, makes every');
    /**
     * TUI-DESIGN-3 §1.9: the mode sentence names the default badge; the copy is generator-neutral ("the code
     * model", never Claude). Since the round-3 `DEFAULT_MODE` flip the badge is `llm+jev · verified` — two words
     * — and at 80 columns the item WRAPS between them (`[jevcode] Mode: llm+jev` / `· verified — …`), so neither
     * the step nor this regex could ever see the whole badge on one line. Both halves are asserted instead
     * (pre-existing red, fixed by the integrator 2026-09-22).
     */
    expect(plain).toMatch(/\[jevcode\] Mode: jev-only/);
    expect(plain).toContain('no generating LLM');
    expect(plain).toContain('tests verify');
    expect(plain).not.toContain('Claude writes');
    expect(plain).not.toMatch(/\[run\] started [·-] /);
    expect(r.runDirs()).toEqual([]);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
  });

  it('chat-task: a task → [run] start, one [step N] line per step, the stage lines absent (compact), a run dir with jevcode.log', async () => {
    const r = await drive({
      name: 'r2-chat-task',
      args: ['chat', ...MOCK_RUN_MODE, '--mock', '--mock-steps', '4'],
      steps: [...CHAT_OPEN, 'send fix the failing test', echoStep('fix the failing test'), 'send \\r', labelStep('you', 'fix the failing test'), RUN_STARTED_STEP, labelStep('step 1', ''), 'expect finished [·-] (complete|max_steps)', `expect ${PLACEHOLDER_FOLLOWUP}`, ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    const rows = plain.split(/\r?\n/);
    const steps = rows.filter((l) => /^ *\[step \d+\] /.test(l));
    expect(steps.length).toBeGreaterThanOrEqual(4);
    expect(rows.filter((l) => HIDDEN_STAGE_RE.test(l))).toEqual([]);
    const dirs = r.runDirs();
    expect(dirs).toHaveLength(1);
    expect(existsSync(`${dirs[0]}/jevcode.log`)).toBe(true);
    // the transcript keeps every stage line; the TUI showed a subsequence of it
    const t = r.transcript()!;
    expect(t.some((l) => HIDDEN_STAGE_RE.test(l))).toBe(true);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
  });

  it('chat-ambiguous: an unsure reading adds the `do it` offer to the reply — no card, no blocked composer, no run', async () => {
    const r = await drive({
      name: 'r2-chat-ambiguous',
      args: ['chat', '--mock'],
      env: { JEVCODE_MOCK_INTAKE: 'ambiguous' },
      steps: [...CHAT_OPEN, 'send the date parsing', echoStep('the date parsing'), 'send \\r', labelStep('jevcode', ''), 'expect make that a task', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).toContain("Say `do it` and I'll make that a task.");
    expect(plain).not.toContain('run this as a task?');
    expect(plain).not.toContain('(waiting for y/n)');
    expect(plain).not.toMatch(/^│ asking /m);
    expect(plain).not.toMatch(/\[run\] started [·-] /);
    expect(r.runDirs()).toEqual([]);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
  });

  it('chat-ambiguous at 12x60 (flat tier): the same offer, ≤ 10 dynamic rows, no card edge, 0 clears', async () => {
    const r = await drive({
      name: 'r2-chat-ambiguous-flat',
      args: ['chat', '--mock'],
      rows: 12,
      cols: 60,
      env: { JEVCODE_MOCK_INTAKE: 'ambiguous' },
      steps: [...CHAT_OPEN_NARROW, 'sleep 0.3', 'send the date parsing', echoStep('the date parsing'), 'send \\r', labelStep('jevcode', ''), 'expect make that a task', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).toContain('make that a task');
    expect(plain).not.toContain('run this as a task?');
    expect(plain).not.toContain('(waiting for y/n)');
    const all = syncFrames(r.text);
    for (const f of all) expect(f.dynamic.length).toBeLessThanOrEqual(10);
    for (const f of all) expect(f.dynamic.some(isBoxEdge)).toBe(false);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
  });

  it('chat-ambiguous: `do it` accepts the offer and runs the task', async () => {
    const r = await drive({
      name: 'r2-chat-ambiguous-y',
      args: ['chat', ...MOCK_RUN_MODE, '--mock', '--mock-steps', '3'],
      env: { JEVCODE_MOCK_INTAKE: 'ambiguous' },
      steps: [...CHAT_OPEN, 'send the date parsing', echoStep('the date parsing'), 'send \\r', 'expect make that a task', 'sleep 0.25', 'send do it', 'send \\r', RUN_STARTED_STEP, 'expect finished [·-] (complete|max_steps)', `expect ${PLACEHOLDER_FOLLOWUP}`, ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    // owner addendum: the TUI no longer prints the `[run] started` row; transcript.log still does
    expect(stripAnsi(r.text)).not.toMatch(/\[run\] started [·-] /);
    expect(r.transcript()!.filter((l) => /^\[run\] started [·-] jev\+llm [·-] the date parsing/.test(l))).toHaveLength(1);
    expect(r.runDirs()).toHaveLength(1);
  });

  it('--plain: the same conversation with no readline prompt anywhere — the reply, the offer, `do it` runs it', async () => {
    const r = await drive({
      name: 'r2-plain-chat',
      args: ['chat', '--plain', '--mock'],
      env: { JEVCODE_MOCK_INTAKE: 'ambiguous' },
      steps: ['expect \\[sandbox\\]', 'sleep 0.3', 'send the date parsing\\r', 'expect \\[you\\] the date parsing', 'expect \\[jevcode\\] ', 'expect make that a task', 'sleep 0.2', 'send /exit\\r', 'eof'],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text).replace(/\r\n/g, '\n');
    expect(plain).not.toContain('run this as a task?');
    expect(plain).toMatch(/^ *\[you\] the date parsing$/m);
    expect(plain).toMatch(/^ *\[jevcode\] /m);
    expect(plain).not.toMatch(/\[run\] started [·-] /);
    expect(r.runDirs()).toEqual([]);
  });

  it('[you] bubbles are redacted at emission (§3.10): a question carrying a secret passes the gate with `y` and shows the masked bubble in the TUI; the key bytes are in no frame and no file', async () => {
    const question = `what can you do with ${CANARY}?`;
    const r = await drive({
      name: 'r2-redact-tui',
      args: ['chat', '--mock'],
      steps: [...CHAT_OPEN, `send ${question}`, 'sleep 0.3', 'send \\r', 'expect Looks like this contains', 'sleep 0.4', 'send y', labelStep('you', 'what can you do with \\[REDACTED'), labelStep('jevcode', ''), ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    // TD §4.10 gate row in the console, then the bubble with the span masked (`redactSpans`) and a facts reply
    expect(plain).toMatch(/Looks like this contains a secret \(sk-ant-…\)\. Send anyway\? y\/N/);
    expect(plain).toMatch(/\[you\] what can you do with \[REDACTED:[^\]]+\]\?/);
    expect(plain).toMatch(/\[jevcode\] /);
    // keys never in logs (§9): not in the capture (the composer masks the span as it is typed), not in history.jsonl, the index, the logs
    expect(r.text).not.toContain('AAAAAAAAAAAA');
    expect(filesContaining(r, 'AAAAAAAAAAAA')).toEqual([]);
    const history = join(r.home, 'history.jsonl');
    expect(existsSync(history)).toBe(true);
    expect(readFileSync(history, 'utf8')).toContain('[REDACTED:');
    expect(r.runDirs()).toEqual([]);
  });

  it('[you] bubbles are redacted at emission (§3.10) in --plain too: the readline gate answered `y`, the masked bubble on its own line', async () => {
    const question = `what can you do with ${CANARY}?`;
    const r = await drive({
      name: 'r2-redact-plain',
      args: ['chat', '--plain', '--mock'],
      // the readline twin of the §4.10 gate row: `jevcode: looks like this contains a secret (sk-ant-…); type y to send, anything else to cancel: `
      steps: ['expect \\[sandbox\\]', 'sleep 0.3', `send ${question}\\r`, 'expect type y to send, anything else to cancel: ', 'send y\\r', 'expect \\[you\\] what can you do with \\[REDACTED', 'expect \\[jevcode\\] ', 'sleep 0.2', 'send /exit\\r', 'eof'],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text).replace(/\r\n/g, '\n');
    expect(plain).toContain('jevcode: looks like this contains a secret (sk-ant-…); type y to send, anything else to cancel: y');
    expect(plain).toMatch(/^ *\[you\] what can you do with \[REDACTED:[^\]]+\]\?$/m);
    // the cooked-mode echo of the typed line is the kernel's, not the renderer's; every renderer-written line is masked
    const rendererLines = plain.split('\n').filter((l) => /^\[(?:you|jevcode|ui|run)\] /.test(l));
    for (const l of rendererLines) expect(l).not.toContain('AAAAAAAAAAAA');
    expect(filesContaining(r, 'AAAAAAAAAAAA')).toEqual([]);
  });

  /**
   * TUI-DESIGN-4 §3.1 / §3.5 (D-W) turned `/jev` and `/cost` into **key–value blocks**: one `[ui] <head>` item
   * with a rendered body, the keys in a left column and the values in the second. The old free-text rows
   * (`intake: 1 message · …`, a bare `chat $…` line) are gone; the same rows are pinned in
   * `test/unit/tui/block/__snapshots__/snapshots.test.ts.snap` and `test/unit/cli/session-chat.test.ts:224`,
   * and this leg is the pty twin of them (integrator 2026-09-22, §3's pins are disjoint from §3.7's — see :173).
   */
  it('/jev and /cost after a greeting: the §3.1 kv blocks — `intake  1 message · p50 <ms> ms · $<usd> · last …` and `chat  $<usd> for 1 message …` (§2.6, §3.9, §12)', async () => {
    const r = await drive({
      name: 'r2-jev-cost',
      args: ['chat', '--mock'],
      steps: [...CHAT_OPEN, 'send hi', echoStep('hi'), 'send \\r', labelStep('jevcode', 'Hi'), 'send /jev', echoStep('/jev'), 'send \\r', 'expect intake {2,}1 message', 'send /cost', echoStep('/cost'), 'send \\r', 'expect chat {2,}\\$', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    // §3.1: the block's body hangs under the `[ui]` head; the value column starts at a fixed offset
    expect(plain).toMatch(/^ *intake {2,}1 message · p50 \d+ ms · \$\d+\.\d+ · last greeting or smalltalk$/m);
    expect(plain).toMatch(/^ *\(\d\.\d\d\)$/m); // the wrapped tail of the last-intake value, at the value column
    expect(plain).toMatch(/^ *decider {2,}/m);
    expect(plain).toMatch(/^ *latency {2,}p50 /m);
    expect(plain).toMatch(/^ *chat {2,}\$\d+\.\d+ · 1 message · p50 \d+ ms$/m);
    expect(r.runDirs()).toEqual([]);
  });
});

describe.skipIf(!hasExpect)('pty round 2: mode switching (§1)', () => {
  it('mode-switch without a generator key (started in jev-only, TUI-DESIGN-3 §1.10): the wizard provider step opens in place; Ctrl-C keeps jev-only and never exits', async () => {
    const r = await drive({
      name: 'r2-mode-switch',
      args: ['chat', '--mode', 'jev-only'],
      env: { ...NO_NETWORK, TYPESAFE_API_KEY: FAKE_KEY },
      steps: [...CHAT_OPEN, 'send /mode jev-on', echoStep('/mode jev-on'), 'send \\r', 'expect Pick the provider', 'sleep 0.3', 'send \\x03', 'expect mode stays jev-only', topEdgeStep(BADGE_JEV_ONLY), ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).toContain('jev+llm needs a generator. Pick the provider:');
    expect(plain).toContain('mode stays jev-only — no generator key was saved');
    expect(plain).not.toContain('No API key found');
    expect(plain).not.toContain(FAKE_KEY);
    expect(r.runDirs()).toEqual([]);
  });

  it('mode-switch with a generator key (started in jev-only): the mode item and the `jev+llm · next run` badge in the console top edge; a command is not a turn', async () => {
    const r = await drive({
      name: 'r2-mode-switch-keyed',
      args: ['chat', '--mode', 'jev-only'],
      env: { ...NO_NETWORK, OPENROUTER_API_KEY: FAKE_KEY },
      steps: [...CHAT_OPEN, 'send /mode jev-on', echoStep('/mode jev-on'), 'send \\r', `expect ${BADGE_JEV_LLM} from the next run`, topEdgeStep(`${BADGE_JEV_LLM}${PROMPT_GAP} · next run`), 'sleep 0.3', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    // TUI-DESIGN-3 §1.9 / §10: the item text is the one table's row (generator-neutral copy), rebuilt from the wrapped rows (§5.3 normaliser)
    expect(flatten(plain)).toContain(MODE_SET_ITEM['jev-on']);
    expect(plain).toMatch(/^╭─ jev\+llm · next run ─/m);
    // §4.4 / H-G1: a command is not a turn — the frame after `/mode jev-on` still shows the `task` placeholder, not `followup`
    const after = frames(r.text).filter((u) => u.lines.slice(u.ruleIndex).some((l) => l.startsWith('╭─ jev+llm · next run')));
    expect(after.length).toBeGreaterThan(0);
    const last = after.at(-1)!;
    const dyn = last.lines.slice(last.ruleIndex).join('\n');
    expect(dyn).toContain(PLACEHOLDER_TASK);
    expect(dyn).not.toContain(PLACEHOLDER_FOLLOWUP);
    expect(plain).not.toContain(FAKE_KEY);
  });

  it('mode-switch with ANTHROPIC_API_KEY (started in jev-only): `/llm on` is `/mode jev-on`, the no-argument `/mode` item names the next run, and `run:start` promotes `jev+llm · next run` → `jev+llm`', async () => {
    const r = await drive({
      name: 'r2-mode-switch-anthropic',
      args: ['chat', '--mock', '--mock-steps', '3', '--mode', 'jev-only'],
      env: { ...NO_NETWORK, ANTHROPIC_API_KEY: FAKE_KEY, TYPESAFE_API_KEY: FAKE_KEY },
      steps: [...CHAT_OPEN, 'send /llm on', echoStep('/llm on'), 'send \\r', `expect ${BADGE_JEV_LLM} from the next run`, topEdgeStep(`${BADGE_JEV_LLM}${PROMPT_GAP} · next run`), 'send /mode', echoStep('/mode'), 'send \\r', `expect next run: ${BADGE_JEV_LLM}`, 'send fix the failing test', echoStep('fix the failing test'), 'send \\r', RUN_STARTED_STEP, topEdgeStep(`${BADGE_JEV_LLM}${PROMPT_GAP} ─`), 'expect finished [·-] (complete|max_steps)', `expect ${PLACEHOLDER_FOLLOWUP}`, ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    // §1.3: the alias and the mode item (§12 "Mode items")
    expect(flatten(plain)).toContain(`[ui] ${MODE_SET_ITEM['jev-on']}`);
    // TUI-DESIGN-3 §4.4 F1: `mode <cur badge> — next run: <next badge>[ (default)]`; ` (default)` follows the word equal to the default's
    const modeItem = /^ *\[ui\] mode (jev-only|jev\+llm|llm-only) — next run: jev\+llm(?: \(default\))?$/m.exec(plain);
    expect(modeItem).not.toBeNull();
    // §1.5: pending badge before the run, promoted at `run:start` (the run's `mode=jev-on`), no ` · next run` afterwards
    expect(plain).toMatch(/^╭─ jev\+llm · next run ─/m);
    // owner addendum: the `[run] started` row is transcript.log-only now; the run's first FRAME is the one whose
    // status row carries a numeric `step <n>/<max>`
    expect(plain).not.toMatch(/\[run\] started [·-] /);
    expect(r.transcript()!.filter((l) => /^\[run\] started [·-] jev\+llm [·-] fix the failing test/.test(l))).toHaveLength(1);
    const all = syncFrames(r.text);
    const started = [all.findIndex((f) => f.dynamic.some((l) => /step \d+\/\d+/.test(l)))].filter((i) => i >= 0);
    expect(started.length).toBe(1);
    const afterStart = all.slice(started[0]!).filter((f) => f.dynamic.some((l) => l.startsWith('╭─ ')));
    expect(afterStart.length).toBeGreaterThan(0);
    // the CONSOLE's top edge is the LAST `╭─ ` row of a frame: an open palette (`╭─ commands ─`) draws its own box
    // above it, and `EXIT_IDLE`'s `/exit` opens exactly that (§4.2) — `find` picked the palette's and failed
    for (const f of afterStart) expect(f.dynamic.filter((l) => l.startsWith('╭─ ')).at(-1)).toMatch(/^╭─ jev\+llm ─/);
    expect(plain).not.toContain(FAKE_KEY);
    // design §12: `mode <badge> (next run: <badge>)` — the tree's first word idle is the pending mode (docs/STATUS.md "Round 2", deviation)
    console.log(`mode item idle after /llm on: "${modeItem![0]}"`);
  });
});

/**
 * Owner directive 3: the padded branding box makes an idle boxed frame `rule 1 + (5 + 2p) + console 5` rows —
 * 11 below 26 rows, 13 at 26–33, 15 from 34 up.
 */
const idleRows = (rows: number): number => 1 + (5 + 2 * (rows >= 34 ? 2 : rows >= 26 ? 1 : 0)) + 5;

describe.skipIf(!hasExpect)('pty round 2: splash (§5)', () => {
  for (const [rows, cols] of [
    [24, 80],
    [40, 120],
  ] as const) {
    it(`splash ${rows}x${cols}: frame 0 is the first frame (< 300 ms warm), a key at ~100 ms completes the reveal — the echo frame and every later idle frame carry the resting mark, no sweep head after the echo, ${idleRows(rows)} dynamic rows, zero clears (TUI-DESIGN-3 §3.3)`, async () => {
      const r = await drive({ name: `r2-splash-${rows}x${cols}`, args: ['chat', '--mock'], rows, cols, steps: [FIRST_FRAME_STEP, 'expect step 0/', RAW_MODE_STEP, 'sleep 0.1', 'send h', echoStep('h'), 'sleep 0.3', 'send \\x03', `expect ${PLACEHOLDER_TASK}`, IDLE_STEP, ...EXIT_IDLE] });
      expect(r.timeouts).toBe(0);
      expect(r.code).toBe(0);
      const first = timingOf(r.timing, 'expect', '25l');
      expect(first!.t).toBeLessThan(300);
      const fs = frames(r.text);
      const [frame] = fs;
      const body = frame!.lines.slice(frame!.ruleIndex);
      // §5.2 row 0 / H-A1: the `J` column and the sweep head, the console complete with the badge and `step 0/–`, 11 dynamic rows
      expect(body.filter((l) => WORDMARK_RE.test(l)).length).toBe(5);
      expect(body.some((l) => /▓▒░/.test(l))).toBe(true);
      expect(body.some((l) => l.startsWith(`╭─ ${BADGE_DEFAULT_TEXT} `))).toBe(true);
      expect(body.at(-2)).toMatch(/step 0\/–/);
      expect(frame!.rows).toBe(idleRows(rows));
      for (const l of body.filter(isBoxEdge)) expect([...l].length).toBe(cols);
      // TUI-DESIGN-3 §3.3: a key completes the reveal — the echo frame shows the character AND the complete resting mark; no frame from the echo on carries the sweep head
      const echo = fs.findIndex((u) => u.lines.some((l) => /[›>] h/.test(l)));
      expect(echo).toBeGreaterThan(0);
      for (const u of fs.slice(echo)) {
        expect(hasMark(u.lines.slice(u.ruleIndex))).toBe(true);
        expect(u.lines.some((l) => /▓▒░/.test(l))).toBe(false);
      }
      // the idle frame: plain rule + the padded box + 5-row console (F-W1); the caption `◆ <version>` closes the mark's last row at ≥ 73 columns
      expect(fs.at(-1)!.rows).toBe(idleRows(rows));
      expect(fs.at(-1)!.lines[fs.at(-1)!.ruleIndex]).toMatch(/^─{10}/);
      expect(fs.at(-1)!.lines.slice(fs.at(-1)!.ruleIndex).some((l) => /█ {2}◆ \d+\.\d+\.\d+$/.test(l))).toBe(true);
      if (cols >= 104) expect(fs.at(-1)!.lines.slice(fs.at(-1)!.ruleIndex).some((l) => l.includes('Decisions, not strings'))).toBe(true);
      expect(countClears(afterFirstFrame(r.text))).toBe(0);
      console.log(`splash ${rows}x${cols}: first frame ${first!.t} ms, ${fs.slice(0, echo).filter((u) => u.lines.some((l) => WORDMARK_RE.test(l))).length} wordmark frames before the key at frame ${echo}`);
    });
  }

  it('wordmark-reduced: --no-animation mounts on the static resting mark — frame 0 carries the complete mark and no sweep head, every frame keeps it, 11 rows (TUI-DESIGN-3 §3.2 twins)', async () => {
    const r = await drive({ name: 'r3-wordmark-reduced', args: ['chat', '--mock', '--no-animation'], steps: [FIRST_FRAME_STEP, 'expect step 0/', RAW_MODE_STEP, 'sleep 0.1', 'send h', echoStep('h'), 'send \\x03', `expect ${PLACEHOLDER_TASK}`, IDLE_STEP, ...EXIT_IDLE] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    expect(stripAnsi(r.text)).not.toMatch(/▓▒░/);
    const fs = frames(r.text);
    for (const u of fs) expect(hasMark(u.lines.slice(u.ruleIndex))).toBe(true);
    expect(fs[0]!.lines[fs[0]!.ruleIndex]).toMatch(/^─{10}/);
    expect(fs[0]!.rows).toBe(11);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
  });

  it('splash settles by itself: no key — ≤ 15 reveal frames before the caption frame `◆ <version>`, every frame after it carries the mark, 0 frames in the 5 s after the settle, zero clears (TUI-DESIGN-3 §3.4, §3.5)', async () => {
    const r = await drive({ name: 'r3-splash-settle', args: ['chat', '--mock'], steps: [FIRST_FRAME_STEP, 'expect step 0/', RAW_MODE_STEP, CAPTION_STEP, 'mark settled', IDLE_STEP, 'sleep 5', 'mark quiet', 'send h', echoStep('h'), 'send \\x03', `expect ${PLACEHOLDER_TASK}`, ...EXIT_IDLE] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const all = syncFrames(r.text).filter((f) => f.ruleIndex >= 0);
    const head = all.filter((f) => f.dynamic.some((l) => /▓▒░/.test(l))).map((f) => f.index);
    // the reveal: frame 0 carries the wordmark head; ≤ 15 frames at the 50 ms tick; the settle frame is the first with the caption and no head
    expect(head[0]).toBe(all[0]!.index);
    expect(head.length).toBeGreaterThanOrEqual(1);
    expect(head.length).toBeLessThanOrEqual(SPLASH_MAX_FRAMES);
    const caption = all.findIndex((f) => f.dynamic.some((l) => /◆ \d+\.\d+\.\d+$/.test(l)) && !f.dynamic.some((l) => /▓▒░/.test(l)));
    expect(caption).toBeGreaterThan(0);
    for (const f of all.slice(caption)) expect(hasMark(f.dynamic)).toBe(true);
    // the loop rests for 5.75 s after `splash:done`: the frames strictly between the caption frame and the marker key's echo are the host's settle (the session meter) at most
    const echo = all.findIndex((f, i) => i > caption && f.dynamic.some((l) => /[›>] h/.test(l)));
    expect(echo).toBeGreaterThan(caption);
    const between = all.slice(caption + 1, echo).filter((f) => !f.dynamic.some((l) => /sess \$/.test(l)) || f.index !== all[caption + 1]?.index);
    expect(between.length).toBeLessThanOrEqual(1);
    expect(all.at(-1)!.dynamic.length).toBe(11);
    const t0 = timingOf(r.timing, 'expect', 'step 0/')!.t;
    const settled = timingOf(r.timing, 'expect', '\\d+\\.\\d+')!.t - t0;
    expect(settled).toBeGreaterThanOrEqual(400);
    expect(settled).toBeLessThan(2500);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
    console.log(`splash settle: ${head.length} reveal frames, caption at frame ${caption}, ${settled} ms after the first frame, ${between.length} frame(s) in the 5 s after it`);
  });

  it('run:start no longer cancels the mark: a one-shot `run` starting before 700 ms keeps the PINNED mark for the whole run (owner directive 2)', async () => {
    const r = await drive({ name: 'r2-splash-run-cancel', args: ['run', 'fix the failing test', ...MOCK_RUN_MODE, '--mock', '--mock-steps', '3'], steps: [...RUN_OPEN, 'mark started', 'expect finished [·-] (complete|max_steps)', `expect ${PLACEHOLDER_FOLLOWUP}`, ...EXIT_IDLE] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const all = syncFrames(r.text);
    // owner addendum: the run's first frame is the one whose status row carries a numeric `step <n>/<max>`
    const started = [all.findIndex((f) => f.dynamic.some((l) => /step \d+\/\d+/.test(l)))].filter((i) => i >= 0);
    expect(started.length).toBe(1);
    // owner directive 2: `run:start` is no longer a cancel row — the mark is up in every frame from the start on
    const ended = all.findIndex((f) => f.lines.some((l) => /^ *\[run\] finished [·-] /.test(l)));
    expect(ended).toBeGreaterThan(started[0]!);
    const before = all.slice(0, started[0]!).filter((f) => f.dynamic.some((l) => WORDMARK_RE.test(l))).length;
    for (const f of all.slice(started[0]!, ended)) expect(f.dynamic.filter((l) => WORDMARK_RE.test(l)).length).toBe(5);
    expect(before).toBeLessThanOrEqual(SPLASH_MAX_FRAMES);
    expect(all.slice(ended).some((f) => f.dynamic.filter((l) => WORDMARK_RE.test(l)).length >= 5)).toBe(true);
    const t0 = timingOf(r.timing, 'expect', '25l')!.t;
    const startAt = timingOf(r.timing, 'expect', 'step ')!.t - t0;
    expect(startAt).toBeLessThan(700);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
    console.log(`splash cancelled by run:start ${startAt} ms after the first frame; ${before} wordmark frames before it`);
  });

  it('--ascii twins (TD §14.1): `#` letters and the `#+.` sweep head, `+-|` console edges, `* jevcode` brand row; no Unicode box or block cell anywhere', async () => {
    const r = await drive({
      name: 'r2-ascii',
      args: ['chat', '--mock', '--ascii'],
      env: { JEVCODE_MOCK_INTAKE: 'ambiguous' },
      steps: [FIRST_FRAME_STEP, 'expect step 0/', RAW_MODE_STEP, IDLE_STEP, 'sleep 0.8', 'send the date parsing', echoStep('the date parsing'), 'send \\r', labelStep('jevcode', ''), 'expect make that a task', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    const [first] = frames(r.text);
    const body = first!.lines.slice(first!.ruleIndex);
    expect(body.filter((l) => /##/.test(l)).length).toBe(5);
    expect(body.some((l) => /#\+\./.test(l))).toBe(true);
    // TD §14.1: the frame is the ASCII twin, so the badge is too — `llm+jev · verified` draws as `llm+jev - verified`
    // (pre-existing red since the round-3 `DEFAULT_MODE` flip gave the default badge a `·`; integrator 2026-09-22)
    expect(body.some((l) => l.startsWith(`+- ${BADGE_DEFAULT_TEXT.replaceAll('·', '-')} -`)), JSON.stringify(body.slice(0, 12))).toBe(true);
    expect(body.some((l) => /^\| > Say hi, ask a question, or describe a task\.\.\./.test(l))).toBe(true);
    expect(plain).toMatch(/\* \d+\.\d+\.\d+/); // the resting mark's ascii caption `* <version>` (TUI-DESIGN-3 §3.5) replaces the brand row at ≥ 21 rows
    // the conversation is the only thing above the console now: the reply and the `do it` offer, in the ascii twin
    expect(plain).toContain("Say `do it` and I'll make that a task.");
    expect(plain).not.toMatch(/[╭╮╰╯│├┤─█▓▒░◆›…]/);
    expect(r.runDirs()).toEqual([]);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
  });
});

describe.skipIf(!hasExpect)('pty round 2: panel, transcript views, chrome tiers (§4)', () => {
  it('panel: the strip after a run; /panel opens ≤ 6 rows with the `more rows` line; /panel off collapses it', async () => {
    const r = await drive({
      name: 'r2-panel',
      args: ['chat', ...MOCK_RUN_MODE, '--mock', '--mock-steps', '4'],
      // the strip precedes the console in every frame: expect it before the placeholder of the same frame (expect consumes its buffer up to each match)
      steps: [...CHAT_OPEN, 'send make the tests pass', echoStep('make the tests pass'), 'send \\r', RUN_STARTED_STEP, 'expect finished [·-] (complete|max_steps)', `expect ▸${PROMPT_GAP} jev s\\d+ · \\d+ decisions`, `expect ${PLACEHOLDER_FOLLOWUP}`, 'send /panel', echoStep('/panel'), 'send \\r', `expect ▾${PROMPT_GAP} decisions`, 'expect more rows', 'mark open', 'send Z', echoStep('Z'), 'send \\x03', 'send /panel off', echoStep('/panel off'), 'send \\r', `expect ▸${PROMPT_GAP} jev`, 'mark closed', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const fs = frames(r.text);
    const openIdx = fs.findIndex((u) => u.lines.some((l) => /^─── ▾ decisions/.test(l)));
    expect(openIdx).toBeGreaterThan(0);
    const open = fs[openIdx]!;
    const dyn = open.lines.slice(open.ruleIndex);
    // §4.6: rule (header) + ≤ 6 pane rows + the 5-row console → ≤ 12 dynamic rows; the 6th pane row is the `more rows` line
    expect(open.rows).toBeLessThanOrEqual(12);
    const consoleTop = dyn.findIndex((l) => l.startsWith('╭─ '));
    expect(consoleTop).toBeGreaterThan(0);
    expect(consoleTop - 1).toBeLessThanOrEqual(6);
    expect(dyn.some((l) => /… \d+ more rows · \/panel full expands/.test(l))).toBe(true);
    // the strip before and after: `▸ jev s<N> · <n> decisions …`
    // owner addendum: the quiet strip has room for the `◆ jevcode` prefix at 80 columns now that the legend is gone
    const strip = fs.at(-1)!.lines[fs.at(-1)!.ruleIndex]!;
    expect(strip).toMatch(/^─── (?:◆ jevcode ─ )?▸ jev s\d+ · \d+ decisions · risk /);
    expect(strip).not.toMatch(/\[d\] \[p\] \[t\] \[s\]/);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
  });

  /** the dynamic rows of the last frame whose header names `tab`, and its pane row count (rule → console top) */
  /**
   * TUI-DESIGN-4 §1.2 P-H1 (finding 5): the open / full panel's tab header now carries the `◆ jevcode` brand
   * whenever the strip has room, so a short tab title (`timeline s4`, `synth s4`) draws
   * `─── ◆ jevcode ─ ▾ timeline s4 ───…` where a long one (`decisions s4 · c~ derived |2p−1|`) still draws
   * `─── ▾ decisions …`. Every matcher here is brand-tolerant (integrator 2026-09-22).
   */
  const TAB_STRIP = (tab: string): RegExp => new RegExp(`^─── (?:◆ jevcode ─ )?▾ ${tab}`);

  function paneRows(r: Drive, tab: string): { rows: number; pane: number } {
    const all = syncFrames(r.text).filter((f) => TAB_STRIP(tab).test(f.dynamic[0] ?? ''));
    expect(all.length).toBeGreaterThan(0);
    const dyn = all.at(-1)!.dynamic;
    const consoleTop = dyn.findIndex((l) => l.startsWith('╭─ '));
    expect(consoleTop).toBeGreaterThan(0);
    return { rows: dyn.length, pane: consoleTop - 1 };
  }

  it('panel keys (§4.6): Alt-Shift-J opens the full 12-row form, Alt-J toggles, Alt-P / Alt-T / Alt-S pick a tab (open, 6 rows), `/panel d` + `/panel full` = 12 rows', async () => {
    const r = await drive({
      name: 'r2-panel-keys',
      args: ['chat', ...MOCK_RUN_MODE, '--mock', '--mock-steps', '4'],
      steps: [
        ...CHAT_OPEN,
        'send make the tests pass',
        echoStep('make the tests pass'),
        'send \\r',
        RUN_STARTED_STEP,
        'expect finished [·-] (complete|max_steps)',
        `expect ${PLACEHOLDER_FOLLOWUP}`,
        'sleep 0.3',
        ALT('J'),
        `expect ▾${PROMPT_GAP} decisions`,
        'sleep 0.3',
        'mark full',
        ALT('j'),
        `expect ▸${PROMPT_GAP} jev`,
        'sleep 0.3',
        ALT('p'),
        `expect ▾${PROMPT_GAP} plan`,
        'sleep 0.3',
        ALT('t'),
        `expect ▾${PROMPT_GAP} timeline`,
        'sleep 0.3',
        ALT('s'),
        `expect ▾${PROMPT_GAP} synth`,
        'sleep 0.3',
        ALT('j'),
        `expect ▸${PROMPT_GAP} jev`,
        'sleep 0.3',
        'send /panel d',
        echoStep('/panel d'),
        'send \\r',
        `expect ▾${PROMPT_GAP} decisions`,
        'sleep 0.3',
        'mark open-d',
        'send /panel full',
        echoStep('/panel full'),
        'send \\r',
        `expect ▾${PROMPT_GAP} decisions`,
        'sleep 0.4',
        'mark cmd-full',
        'send /panel off',
        echoStep('/panel off'),
        'send \\r',
        `expect ▸${PROMPT_GAP} jev`,
        ...EXIT_IDLE,
      ],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    // full = 12 pane rows: rule + 12 + the 5-row console = 18 dynamic rows (≤ rows − 2 = 22); open tabs: 6 pane rows or fewer (synth has fewer rows)
    const all = syncFrames(r.text);
    const decisions = all.filter((f) => TAB_STRIP('decisions').test(f.dynamic[0] ?? ''));
    expect(decisions.length).toBeGreaterThan(0);
    const paneOf = (dyn: readonly string[]): number => dyn.findIndex((l) => l.startsWith('╭─ ')) - 1;
    const fullFrames = decisions.filter((f) => paneOf(f.dynamic) === 12);
    expect(fullFrames.length).toBeGreaterThan(0);
    expect(fullFrames[0]!.dynamic.length).toBe(18);
    expect(paneRows(r, 'plan').pane).toBeLessThanOrEqual(6);
    expect(paneRows(r, 'timeline').pane).toBeLessThanOrEqual(6);
    expect(paneRows(r, 'synth').pane).toBeLessThanOrEqual(6);
    // the `/panel d` form is the 6-row one and `/panel full` the 12-row one (both frames name the decisions tab)
    expect(decisions.some((f) => paneOf(f.dynamic) <= 6)).toBe(true);
    for (const f of all) expect(f.dynamic.length).toBeLessThanOrEqual(22);
    expect(countClears(afterFirstFrame(r.text))).toBe(0);
    console.log(`panel keys: full ${fullFrames[0]!.dynamic.length} dynamic rows (12 pane), plan ${paneRows(r, 'plan').pane} · timeline ${paneRows(r, 'timeline').pane} · synth ${paneRows(r, 'synth').pane} pane rows`);
  });

  it('panel keys (§4.6): Alt-D opens the decisions tab from the collapsed strip (the earlier `½` was the driver\'s Tcl `\\x1bd` → `\\xbd`, not the tree)', async () => {
    const r = await drive({
      name: 'r2-panel-alt-d',
      args: ['chat', ...MOCK_RUN_MODE, '--mock', '--mock-steps', '4'],
      timeoutS: 5,
      steps: [...CHAT_OPEN, 'send make the tests pass', echoStep('make the tests pass'), 'send \\r', RUN_STARTED_STEP, 'expect finished [·-] (complete|max_steps)', `expect ${PLACEHOLDER_FOLLOWUP}`, 'sleep 0.3', ALT('d'), `expect ▾${PROMPT_GAP} decisions`, 'send \\x03', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(stripAnsi(r.text)).not.toMatch(/[›>] ½/);
  });

  it('the Jev panel after a greeting (§3.11): `/panel` shows the intake\'s `s0` Noul rows (`about_*`), none written to decisions.jsonl', async () => {
    const r = await drive({
      name: 'r2-panel-intake',
      args: ['chat', '--mock'],
      steps: [...CHAT_OPEN, 'send hi', echoStep('hi'), 'send \\r', labelStep('jevcode', 'Hi'), 'send /panel full', echoStep('/panel full'), 'send \\r', `expect ▾${PROMPT_GAP} decisions s0`, 'expect s0 ', 'sleep 0.3', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    const rows = plain.split(/\r?\n/).filter((l) => /^s0 /.test(l));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((l) => /^s0 \S+\s+about_\S+\s+noul\s+/.test(l))).toBe(true);
    // design §3.11 names the rows `s0 intake  intake  <kind> … chosen` (the Choice pinned first) beside the `about_*` Nouls; the tree's label and row set are reported (docs/STATUS.md "Round 2")
    const ids = [...new Set(rows.map((l) => l.split(/\s+/)[2] ?? ''))];
    console.log(`panel after hi: ${rows.length} s0 rows, stage word "${rows[0]!.split(/\s+/)[1]}", ids ${ids.join(' ')}; intake Choice row ${rows.some((l) => /^s0 \S+\s+intake\s/.test(l)) ? 'present' : 'absent'}`);
    expect(r.runDirs()).toEqual([]);
  });

  it('/why intake after a greeting prints the standard block (§3.11)', async () => {
    const r = await drive({
      name: 'r2-why-intake',
      args: ['chat', '--mock'],
      steps: [...CHAT_OPEN, 'send hi', echoStep('hi'), 'send \\r', labelStep('jevcode', 'Hi'), 'send /why intake', echoStep('/why intake'), 'send \\r', 'expect (?:intake|error)', 'sleep 0.3', 'send \\x03', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    expect(stripAnsi(r.text)).not.toContain('/why: no decision intake');
  });

  it('/transcript full (§4.5 / §9 (a)): the stage lines of new items appear in the TUI and every transcript.log line is rebuilt from the wrapped rows at 80 columns', async () => {
    const r = await drive({
      name: 'r2-transcript-full',
      args: ['chat', ...MOCK_RUN_MODE, '--mock', '--mock-steps', '3'],
      steps: [...CHAT_OPEN, 'send /transcript full', echoStep('/transcript full'), 'send \\r', 'sleep 0.3', 'send fix the failing test', echoStep('fix the failing test'), 'send \\r', RUN_STARTED_STEP, 'expect finished [·-] (complete|max_steps)', `expect ${PLACEHOLDER_FOLLOWUP}`, 'sleep 0.3', ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const rows = staticRows(r.text);
    // the stage kinds hidden by `compact` are drawn in `full`. TUI-DESIGN-4 §3.6 / §3.7 G1–G2 (D-V) rewrote the
    // three stage rows (`intent=edit p=0.82` → `intent · edit · 0.82 (confidence …)`) and **deleted `run:ready`
    // as an item**, so the row that used to prove `full` shows it is gone from every sink — this test's point is
    // that the compact-hidden STAGES are drawn, and those three still are, glyph-agnostically.
    expect(rows.some((l) => /^ *\[step 1\] intent [·-] /.test(l))).toBe(true);
    expect(rows.some((l) => /^ *\[step 1\] proposal [·-] /.test(l))).toBe(true);
    expect(rows.some((l) => /^ *\[step 1\] judge /.test(l))).toBe(true);
    expect(rows.some((l) => /^ *\[run\] ready /.test(l))).toBe(false);
    // identity (a): after stripAnsi, the rows equal formatTranscriptItem(item) word-wrapped — rebuilt against transcript.log with the
    // continuation indent dropped (the design's hanging indent of `label.length + 1` cells; a full-width wrap rebuilds the same way)
    // owner addendum: the two run-header items are transcript.log-only now, so they are not among the TUI's rows
    const transcript = r.transcript()!.filter((l) => !/^\[run\] started [·-] /.test(l) && !/^\[run\] git /.test(l));
    const reflow = reflowAgainst(rows, transcript, { hangingIndent: true });
    expect(reflow.mismatches).toEqual([]);
    expect(reflow.lines).toEqual(transcript);
    // every row above the rule is a transcript line, its continuation, or a renderer-local item (the header, [sandbox], [ui], the bubbles)
    for (const l of reflow.leftovers) expect(isLocalItem(l) || !isItemRow(l)).toBe(true);
    const continuation = rows.filter((l) => /^ {9,}\S/.test(l)).length;
    console.log(`/transcript full: ${transcript.length} transcript lines rebuilt from ${rows.length} rows (${reflow.wrappedRows} continuation rows, ${continuation} of them indented ≥ 9 cells)`);
  });

  /**
   * The flat tier is anchored on its SHAPE, not on the badge prefix: TUI-DESIGN-2 §1.5 drops that prefix FIRST
   * when the status row runs short, and round 3's default `llm-jev` carries an 18-cell badge
   * (`llm+jev · verified`) that a 60-column status row cannot hold. `frameTier` below is the real assertion.
   */
  it('chrome-tiers: boxed at 24x80, flat at 12x60 (the status row at column 0), boxed again; ≤ 1 clear in the shrink segment, 0 in the grow', async () => {
    const r = await drive({
      name: 'r2-chrome-tiers',
      args: ['chat', '--mock'],
      // an expect right after each resize (the driver's `sleep` drains and consumes the pty, so a frame that arrived during a sleep is gone for a later expect), then a settle
      steps: [...CHAT_OPEN, 'send A', echoStep('A'), 'resize 12 60', 'expect \\nidle {2,}step 0/', 'sleep 0.5', 'send B', echoStep('AB'), 'resize 24 80', topEdgeStep(BADGE_DEFAULT), 'sleep 0.5', 'send C', echoStep('ABC'), 'send \\x03', `expect ${PLACEHOLDER_TASK}`, ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const all = units(r.text);
    const segments = segmentClears(all, [' A', ' AB', ' ABC']);
    expect(segments.every((s) => s.unit !== undefined)).toBe(true);
    expect(segments[0]!.clears).toBe(0);
    expect(segments[1]!.clears).toBeLessThanOrEqual(1); // shrink 24×80 → 12×60
    expect(segments[2]!.clears).toBe(0); // grow
    expect(frameTier(segments[0]!.unit!)).toBe('boxed');
    expect(frameTier(segments[1]!.unit!)).toBe('flat');
    expect(frameTier(segments[2]!.unit!)).toBe('boxed');
    // §1.5 flat: the status row is the LAST row and starts at column 0; no box row anywhere in the flat frame.
    // The `<badge> · <leftWord>` prefix is the FIRST segment §1.5 drops when the row runs short, and round 3's
    // default `llm-jev` badge (`llm+jev · verified`, 18 cells) does not fit a 60-column status row — so the
    // assertion is on the left word, and on the prefix only while it fits.
    const flat = segments[1]!.unit!;
    expect(flat.lines.slice(flat.ruleIndex).some(isBoxEdge)).toBe(false);
    expect(flat.lines.at(-1)).toMatch(new RegExp(`^(?:${BADGE_DEFAULT} \u00b7 )?idle {2,}step 0/`));
    // TUI-DESIGN-3 §3.2: the flat tier draws no wordmark
    expect(flat.lines.some((l) => WORDMARK_RE.test(l))).toBe(false);
    expect(flat.rows).toBeLessThanOrEqual(10);
    console.log(`chrome tiers: clears per segment ${segments.map((s) => s.clears).join('/')}; rows boxed ${segments[0]!.unit!.rows} · flat ${flat.rows} · boxed ${segments[2]!.unit!.rows}`);
  });
});

describe.skipIf(!hasExpect)('pty round 2: zero-argument starts and the keyless wizard (§1.1, §1.4)', () => {
  for (const [name, args] of [
    ['bare `jevcode`', ['--mock']],
    ['`jevcode run` without a task', ['run', '--mock']],
  ] as const) {
    it(`zero-argument start (${name}): a default-mode session, the badge from the first frame, the round-2 placeholder, no wizard`, async () => {
      const r = await drive({ name: `r2-zero-arg-${args[0] === 'run' ? 'run' : 'chat'}`, args: [...args], steps: [FIRST_FRAME_STEP, topEdgeStep(BADGE_DEFAULT), `expect ${PLACEHOLDER_TASK}`, RAW_MODE_STEP, IDLE_STEP, ...EXIT_IDLE] });
      expect(r.timeouts).toBe(0);
      expect(r.code).toBe(0);
      const [frame] = frames(r.text);
      expect(frame!.lines.slice(frame!.ruleIndex).some((l) => l.startsWith(`╭─ ${BADGE_DEFAULT_TEXT} `))).toBe(true);
      const plain = stripAnsi(r.text);
      // the session opens with the wordmark and the composer only (2026-09-22 directive): no header, no [sandbox], no recent hint
      expect(plain).not.toMatch(/\[run\] jevcode session/);
      expect(plain).not.toContain('[sandbox]');
      expect(plain).not.toMatch(/\[ui\] recent:/);
      expect(plain).not.toContain('Where do you reach Jev');
      expect(plain).not.toContain('Pick the generator provider');
      expect(plain).not.toContain('OpenRouter API key —');
      expect(r.runDirs()).toEqual([]);
    });
  }

  /** the keyless startup wizard: `childEnv` gives an empty HOME / XDG dir (no credentials file), no .env in the workspace, every key variable removed */
  const WIZARD_OPEN = [FIRST_FRAME_STEP, 'expect OpenRouter API key'];

  it('zero-argument start with no key anywhere: the one-key wizard opens on the masked OpenRouter field under `setup · key` beneath the held mark (F-R8); Ctrl-C at startup exits 2 (TUI-DESIGN-3 §1.4, D-J)', async () => {
    const r = await drive({ name: 'r3-zero-arg-wizard', args: [], env: NO_NETWORK, steps: [...WIZARD_OPEN, 'sleep 0.4', 'send \\x03', 'eof'] });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(2);
    const plain = stripAnsi(r.text);
    expect(plain).toContain('OpenRouter API key — one key runs Jev and the code model');
    expect(plain).toMatch(/^╭─ setup · key ─/m);
    expect(plain).toContain('Paste, then Enter · Esc: other ways to start · Ctrl-C quits (shows setup)');
    expect(plain).not.toContain('Where do you reach Jev');
    expect(plain).not.toContain('Pick the generator provider');
    // F-R8: the wizard is hosted under the mark — 13 dynamic rows (status 1 + rule 1 + chrome 3 + wizard 3 + pane 5)
    const setup = syncFrames(r.text).filter((f) => f.dynamic.some((l) => l.startsWith('╭─ setup · key')));
    expect(setup.length).toBeGreaterThan(0);
    expect(hasMark(setup[0]!.dynamic)).toBe(true);
    expect(setup[0]!.dynamic.length).toBe(13);
    expect(r.runDirs()).toEqual([]);
  });

  it('Ctrl-C at the startup wizard prints the jev-on fix block (`export OPENROUTER_API_KEY=…   # one key: Jev + the code model`, `printenv OPENROUTER_API_KEY | jevcode login --key-stdin`; TUI-DESIGN-3 §1.6)', async () => {
    const r = await drive({ name: 'r3-zero-arg-wizard-fix', args: [], env: NO_NETWORK, steps: [...WIZARD_OPEN, 'sleep 0.4', 'send \\x03', 'eof'] });
    expect(r.code).toBe(2);
    const plain = stripAnsi(r.text);
    const joined = plain.split(/\r?\n/).map((l) => l.trim()).join(' ');
    expect(joined).toContain('export OPENROUTER_API_KEY=');
    expect(joined).toContain('jevcode login --key-stdin');
    expect(plain).toContain('export TYPESAFE_API_KEY=');
  });

  it('Ctrl-C at the startup wizard exits without falling through to an idle console (§1.4: "one opened by a missing key at startup exits 2")', async () => {
    const r = await drive({ name: 'r2-zero-arg-wizard-exit', args: [], env: NO_NETWORK, steps: [...WIZARD_OPEN, 'sleep 0.4', 'send \\x03', 'eof'] });
    expect(r.code).toBe(2);
    const all = syncFrames(r.text);
    const setup = syncFramesWith(all, /^╭─ setup/);
    expect(setup.length).toBeGreaterThan(0);
    const afterSetup = all.slice(setup.at(-1)! + 1);
    expect(afterSetup.some((f) => f.dynamic.some((l) => l.startsWith(`╭─ ${BADGE_DEFAULT_TEXT} `) || l.includes(PLACEHOLDER_TASK)))).toBe(false);
  });

  it('keys never in logs (§9): a key typed into the startup wizard\'s one-key masked field shows as `•` cells, then Ctrl-C — the bytes are in no frame, history.jsonl, sessions/index.jsonl or any file under JEVCODE_HOME / XDG', async () => {
    const r = await drive({
      name: 'r3-wizard-masked-key',
      args: [],
      env: NO_NETWORK,
      steps: [...WIZARD_OPEN, 'sleep 0.4', `send ${TYPED_KEY}`, 'expect •{20}', 'sleep 0.3', 'mark typed', 'send \\x03', 'eof'],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(2);
    const plain = stripAnsi(r.text);
    // TUI-DESIGN-3 §1.4.2: the `setup · key` console title, the masked row `› •••`, the one-key counter row with the length only
    expect(plain).toMatch(/^╭─ setup · key ─/m);
    expect(plain).toMatch(/^│ › •{48}/m);
    expect(plain).toContain(`${TYPED_KEY.length} chars · Enter saves · Ctrl-U clears · Esc clears (again: other ways)`);
    expect(r.text).not.toContain(TYPED_KEY);
    expect(r.text).not.toContain('zzzzzzzz');
    expect(filesContaining(r, 'zzzzzzzz')).toEqual([]);
    expect(existsSync(join(r.home, 'xdg', 'jevcode', 'config.json'))).toBe(false);
  });

  it('keys never in logs (§9): the `/mode jev-on` wizard\'s masked generator-key field (`setup · generator key`, a session started in jev-only), Ctrl-C keeps jev-only — the typed bytes and the session\'s fake Jev key are in no frame and no file', async () => {
    const r = await drive({
      name: 'r2-wizard-masked-mode',
      args: ['chat', '--mode', 'jev-only'],
      env: { ...NO_NETWORK, TYPESAFE_API_KEY: FAKE_KEY },
      steps: [...CHAT_OPEN, 'send /mode jev-on', echoStep('/mode jev-on'), 'send \\r', 'expect Pick the provider', 'sleep 0.3', 'send 1', 'expect Anthropic API key \\(ANTHROPIC_API_KEY\\)', 'sleep 0.3', `send ${TYPED_KEY}`, 'expect •{20}', 'sleep 0.3', 'mark typed', 'send \\x03', 'expect mode stays jev-only', topEdgeStep(BADGE_JEV_ONLY), ...EXIT_IDLE],
    });
    expect(r.timeouts).toBe(0);
    expect(r.code).toBe(0);
    const plain = stripAnsi(r.text);
    expect(plain).toMatch(/^╭─ setup · provider ─/m);
    expect(plain).toMatch(/^╭─ setup · generator key ─/m);
    expect(plain).toMatch(/^│ › •{48}/m);
    expect(plain).toContain('mode stays jev-only — no generator key was saved');
    for (const secret of [TYPED_KEY, FAKE_KEY, 'zzzzzzzz']) {
      expect(r.text).not.toContain(secret);
      expect(filesContaining(r, secret)).toEqual([]);
    }
    expect(existsSync(join(r.home, 'xdg', 'jevcode', 'config.json'))).toBe(false);
    expect(r.runDirs()).toEqual([]);
  });
});
